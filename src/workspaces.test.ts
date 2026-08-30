import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig, type ServerConfig } from "./config.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("a checkout exposes initial and nested instruction context while filtering outside symlinks", async (t) => {
  const context = await fixture(t);
  const opened = await context.registry.openWorkspace(context.root);

  assert.match(opened.workspace.id, /^ws_[a-f0-9]{10}$/);
  assert.equal(opened.workspace.mode, "checkout");
  assert.deepEqual(
    opened.agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
  assert.deepEqual(
    opened.availableAgentsFiles.map((file) => file.path),
    [join(context.root, "nested", "AGENTS.md")],
  );
  if (platform() !== "win32") {
    const unsafeAgentDir = join(context.root, ".pi", "unsafe-agent");
    await mkdir(unsafeAgentDir, { recursive: true });
    await writeFile(join(context.outsideRoot, "secret.txt"), "outside secret\n");
    await symlink(join(context.outsideRoot, "secret.txt"), join(unsafeAgentDir, "AGENTS.md"));

    const unsafeConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(context.root, ".devspace-unsafe-home"),
      DEVSPACE_ALLOWED_ROOTS: context.root,
      DEVSPACE_WORKTREE_ROOT: join(context.root, ".devspace", "unsafe-worktrees"),
      DEVSPACE_AGENT_DIR: unsafeAgentDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const unsafeWorkspace = await new WorkspaceRegistry(unsafeConfig).openWorkspace(context.root);

    assert.deepEqual(
      unsafeWorkspace.agentsFiles.map((file) => file.content),
      ["root instructions\n"],
    );
  }
});

test("opening a missing checkout fails closed without creating a directory", async (t) => {
  const context = await fixture(t);
  const missingRoot = join(context.root, "missing", "workspace");

  await assert.rejects(
    () => context.registry.openWorkspace(missingRoot),
    /Workspace directory does not exist.*exact existing checkout directory/,
  );
  await assert.rejects(
    () => stat(missingRoot),
    (error: unknown) => isErrnoException(error) && error.code === "ENOENT",
  );
});

test("managed worktree opens are rejected for both plain folders and Git projects", async (t) => {
  const context = await fixture(t);

  await assert.rejects(
    () => context.registry.openWorkspace({ path: context.root, mode: "worktree" }),
    /Managed worktree mode is disabled/,
  );

  const gitRoot = await createGitProject(context.root);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  await assert.rejects(
    () => context.registry.openWorkspace({ path: gitRoot, mode: "worktree" }),
    /Managed worktree mode is disabled/,
  );

  const opened = await context.registry.openWorkspace(gitRoot);
  assert.equal(opened.workspace.mode, "checkout");
  assert.equal(opened.workspace.root, gitRoot);
  assert.equal(opened.workspace.worktree, undefined);
});

test("persisted checkout sessions restore while retired worktree sessions are rejected", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const stateDir = join(context.root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const firstRegistry = new WorkspaceRegistry(context.config, firstStore);

  const checkout = await firstRegistry.openWorkspace(context.root);
  const retiredWorktreeId = "ws_retired01";
  firstStore.createSession({
    id: retiredWorktreeId,
    root: gitRoot,
    mode: "worktree",
    sourceRoot: gitRoot,
    baseRef: "HEAD",
    baseSha: "deadbeef",
    managed: true,
  });
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  try {
    const restoredRegistry = new WorkspaceRegistry(context.config, secondStore);
    const restoredCheckout = restoredRegistry.getWorkspace(checkout.workspace.id);

    assert.equal(restoredCheckout.root, context.root);
    assert.equal(restoredCheckout.mode, "checkout");
    assert.throws(
      () => restoredRegistry.getWorkspace(retiredWorktreeId),
      /retired managed worktree/,
    );
  } finally {
    secondStore.close();
  }
});

test("workspace paths outside the allowed roots are rejected", async (t) => {
  const context = await fixture(t);

  await assert.rejects(
    () => context.registry.openWorkspace(context.outsideRoot),
    /outside allowed roots/,
  );
});

test("blocked roots override a broader allowed root", async (t) => {
  const context = await fixture(t);
  const blockedRoot = join(context.root, ".codex-local");
  const mainRoot = join(context.root, ".codex");
  await mkdir(blockedRoot);
  await mkdir(mainRoot);

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(context.root, ".blocked-config"),
    DEVSPACE_ALLOWED_ROOTS: context.root,
    DEVSPACE_BLOCKED_ROOTS: blockedRoot,
    DEVSPACE_WORKTREE_ROOT: join(context.root, ".devspace", "blocked-worktrees"),
    DEVSPACE_AGENT_DIR: context.agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);

  await assert.rejects(() => registry.openWorkspace(blockedRoot), /inside blocked root/);
  const openedMain = await registry.openWorkspace(mainRoot);
  assert.equal(openedMain.workspace.root, mainRoot);
});

test("a symlinked allowed root preserves checkout behavior and still rejects worktree mode", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t);
  const aliasRoot = join(context.root, "alias-root");
  await symlink(context.root, aliasRoot, "dir");
  await createGitProject(context.root);

  const aliasConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(context.root, ".alias-config"),
    DEVSPACE_ALLOWED_ROOTS: aliasRoot,
    DEVSPACE_WORKTREE_ROOT: join(aliasRoot, ".devspace", "alias-worktrees"),
    DEVSPACE_AGENT_DIR: context.agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const aliasRegistry = new WorkspaceRegistry(aliasConfig);

  await assert.rejects(
    () => aliasRegistry.openWorkspace({
      path: join(aliasRoot, "git-project"),
      mode: "worktree",
    }),
    /Managed worktree mode is disabled/,
  );
  const checkout = await aliasRegistry.openWorkspace(aliasRoot);

  assert.equal(checkout.workspace.mode, "checkout");
  assert.deepEqual(
    checkout.agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
});

interface WorkspaceFixture {
  root: string;
  outsideRoot: string;
  agentDir: string;
  config: ServerConfig;
  registry: WorkspaceRegistry;
}

async function fixture(t: TestContext): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-workspace-outside-test-"));
  const agentDir = join(root, ".pi", "agent");

  if (platform() === "win32") {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  } else {
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await writeFile(join(agentDir, "skills", "AGENTS.md"), "global instructions\n");
    await symlink("skills/AGENTS.md", join(agentDir, "AGENTS.md"));
  }

  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".devspace-home"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  return {
    root,
    outsideRoot,
    agentDir,
    config,
    registry: new WorkspaceRegistry(config),
  };
}

async function createGitProject(parent: string): Promise<string> {
  const gitRoot = join(parent, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  return gitRoot;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
