import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsPromises, { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { addAbortSignal, PassThrough } from "node:stream";
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

test("a descendant Darwin scandir deadlock leaves a readable workspace and clears a reused mutation baseline", { skip: platform() !== "darwin" }, async (t) => {
  const context = await fixture(t);
  await mkdir(join(context.root, "Unavailable.app"));
  const bundlePath = await realpath(join(context.root, "Unavailable.app"));
  const store = new SqliteWorkspaceStore(join(context.root, ".devspace", "state"));
  const registry = new WorkspaceRegistry(context.config, store);
  const options = { conversationScopeId: "dataless-reopen" };

  try {
    const first = await registry.openWorkspace(context.root, options);
    assert.ok(first.workspace.mutationFingerprint);
    let unavailable = true;
    const deadlock = Object.assign(new Error("Unknown system error -11"), {
      code: "Unknown system error -11",
      errno: -11,
      syscall: "scandir",
      path: bundlePath,
    });
    mockDirectoryRead(t, (path) => unavailable && path === bundlePath ? deadlock : undefined);

    const reopened = await registry.openWorkspace(context.root, options);
    assert.equal(reopened.workspace.id, first.workspace.id);
    assert.equal(reopened.workspace.mutationFingerprint, undefined);
    assert.match(reopened.workspace.mutationFingerprintProblem ?? "", /Unavailable\.app/);
    const readablePath = registry.resolveReadPath(reopened.workspace, "nested/file.txt");
    assert.equal(await readFile(readablePath.absolutePath, "utf8"), "hello\n");
    let actionRan = false;
    await assert.rejects(
      () => registry.runMutation(reopened.workspace, "test mutation", async () => { actionRan = true; }),
      /WORKSPACE_BASELINE_UNAVAILABLE/,
    );
    assert.equal(actionRan, false);

    unavailable = false;
    const recovered = await registry.openWorkspace(context.root, options);
    assert.equal(recovered.workspace.id, first.workspace.id);
    assert.ok(recovered.workspace.mutationFingerprint);
    assert.equal(recovered.workspace.mutationFingerprintProblem, undefined);
    await registry.runMutation(recovered.workspace, "test mutation", async () => { actionRan = true; });
    assert.equal(actionRan, true);
  } finally {
    store.close();
  }
});

test("a dataless descendant also tolerates deferred directory-iterator errors during context discovery", { skip: platform() !== "darwin" }, async (t) => {
  const context = await fixture(t);
  await mkdir(join(context.root, "Unavailable.app"));
  const bundlePath = await realpath(join(context.root, "Unavailable.app"));
  const deadlock = Object.assign(new Error("Unknown system error -11"), {
    code: "Unknown system error -11", errno: -11, syscall: "readdir",
  });
  mockDirectoryRead(t, (path) => path === bundlePath ? deadlock : undefined);
  const originalOpendir = fsPromises.opendir;
  t.mock.method(fsPromises, "opendir", async (...args: unknown[]) => {
    const handle = await Reflect.apply(originalOpendir, fsPromises, args);
    if (await realpath(String(args[0])) !== bundlePath) return handle;
    return {
      async *[Symbol.asyncIterator]() {
        try { throw deadlock; }
        finally { await handle.close(); }
      },
    };
  });
  syncBuiltinESMExports();

  const opened = await context.registry.openWorkspace(context.root);
  assert.equal(opened.workspace.mutationFingerprint, undefined);
  assert.match(opened.workspace.mutationFingerprintProblem ?? "", /Unavailable\.app/);
  assert.deepEqual(opened.availableAgentsFiles.map((file) => file.path), [
    join(context.root, "nested", "AGENTS.md"),
  ]);
});

test("an unreadable root and unrelated descendant errors still fail workspace opening", async (t) => {
  const context = await fixture(t);
  const rootError = Object.assign(new Error("root is unreadable"), {
    code: "EDEADLK", errno: -11, syscall: "opendir", path: context.root,
  });
  const originalOpendir = fsPromises.opendir;
  t.mock.method(fsPromises, "opendir", async (...args: unknown[]) => {
    if (String(args[0]) === context.root) throw rootError;
    return Reflect.apply(originalOpendir, fsPromises, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(() => context.registry.openWorkspace(context.root), (error) => error === rootError);

  t.mock.restoreAll();
  syncBuiltinESMExports();
  const childError = Object.assign(new Error("child access denied"), {
    code: "EACCES", errno: -13, syscall: "scandir", path: await realpath(join(context.root, "nested")),
  });
  mockDirectoryRead(t, (path) => path === childError.path ? childError : undefined);
  await assert.rejects(() => context.registry.openWorkspace(context.root), (error) => error === childError);
});

test("a slow initial scan stops traversal without publishing a partial baseline", async (t) => {
  const context = await fixture(t);
  const slowDirectory = join(context.root, "000-slow");
  const laterDirectory = join(context.root, "zzz-not-visited");
  await mkdir(slowDirectory);
  await mkdir(laterDirectory);
  const physicalSlowDirectory = await realpath(slowDirectory);
  const physicalLaterDirectory = await realpath(laterDirectory);
  const originalReaddir = fsPromises.readdir;
  let laterVisited = false;
  t.mock.method(fsPromises, "readdir", async (...args: unknown[]) => {
    if (String(args[0]) === physicalSlowDirectory) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_200));
    }
    if (String(args[0]) === physicalLaterDirectory) laterVisited = true;
    return Reflect.apply(originalReaddir, fsPromises, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const started = performance.now();
  const opened = await context.registry.openWorkspace(context.root);
  assert.ok(performance.now() - started < 5_000);
  assert.equal(opened.workspace.mutationFingerprint, undefined);
  assert.match(opened.workspace.mutationFingerprintProblem ?? "", /time budget/);
  assert.equal(laterVisited, false);
  await assert.rejects(
    () => context.registry.runMutation(opened.workspace, "test mutation", async () => {}),
    /WORKSPACE_BASELINE_UNAVAILABLE/,
  );
});

test("the initial scan deadline aborts active file streams", async (t) => {
  const context = await fixture(t);
  const slowFile = join(context.root, "000-slow.txt");
  await writeFile(slowFile, "slow content\n");
  const physicalSlowFile = await realpath(slowFile);
  const originalCreateReadStream = fs.createReadStream;
  let pendingStream: PassThrough | undefined;
  t.mock.method(fs, "createReadStream", (...args: unknown[]) => {
    if (String(args[0]) !== physicalSlowFile) return Reflect.apply(originalCreateReadStream, fs, args);
    const options = args[1] as { signal?: AbortSignal } | undefined;
    pendingStream = new PassThrough();
    if (options?.signal) addAbortSignal(options.signal, pendingStream);
    // Keep a broken implementation's red test finite.
    const fallback = setTimeout(() => pendingStream?.end("slow content\n"), 3_000);
    t.after(() => clearTimeout(fallback));
    return pendingStream;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const opened = await context.registry.openWorkspace(context.root);
  assert.equal(opened.workspace.mutationFingerprint, undefined);
  assert.match(opened.workspace.mutationFingerprintProblem ?? "", /time budget/);
  assert.equal(pendingStream?.destroyed, true);
});

test("local application bundle contents remain covered by the mutation guard", async (t) => {
  const context = await fixture(t);
  const bundleContents = join(context.root, "Local.app", "Contents", "Resources");
  await mkdir(bundleContents, { recursive: true });
  const resource = join(bundleContents, "data.txt");
  await writeFile(resource, "before\n");
  const opened = await context.registry.openWorkspace(context.root);
  await writeFile(resource, "after!\n");
  let actionRan = false;
  await assert.rejects(
    () => context.registry.runMutation(opened.workspace, "test mutation", async () => { actionRan = true; }),
    /WORKSPACE_CHANGED_EXTERNALLY/,
  );
  assert.equal(actionRan, false);
});

function mockDirectoryRead(
  t: TestContext,
  errorForPath: (path: string) => Error | undefined,
): void {
  const originalReaddir = fsPromises.readdir;
  t.mock.method(fsPromises, "readdir", async (...args: unknown[]) => {
    const error = errorForPath(String(args[0]));
    if (error) throw error;
    return Reflect.apply(originalReaddir, fsPromises, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

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
  await mkdir(join(root, "env_uv"));
  await writeFile(join(root, "env_uv", "AGENTS.md"), "generated environment instructions\n");
  await mkdir(join(root, "_devspace_mounts"));
  await writeFile(join(root, "_devspace_mounts", "AGENTS.md"), "mounted workspace instructions\n");

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
