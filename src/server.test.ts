import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");

  const tools = await context.client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "resolve_project_workspace"), false);
  assert.equal(tools.tools.some((tool) => tool.name === "open_project"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "setup_external_repository"), false);
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const inputProperties = (openTool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.deepEqual((inputProperties?.mode as { enum?: unknown } | undefined)?.enum, ["checkout"]);
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const repeatedText = responseText(repeated);
  assert.match(repeatedText, /Workspace already open as/);
  assert.match(repeatedText, /same physical directory previously opened/);
  assert.match(repeatedText, /Reuse this workspaceId for subsequent tool calls/);
  assert.match(repeatedText, /previously provided for this workspace/);
  assert.match(repeatedText, /not repeated here/);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
});

test("open_project resolves a registered project to the same physical workspace", async (t) => {
  const context = await fixture(t);
  const opened = await callOpenProject(context.client, "fixture-project", "new", "chat-project");

  assert.equal(opened.isError, undefined);
  assert.equal(structuredContent(opened).status, "resolved");
  assert.equal(structuredContent(opened).projectId, "fixture-project");
  assert.equal(structuredContent(opened).canonicalPath, context.project);
  assert.equal(structuredContent(opened).selectedPath, context.project);
  assert.equal(structuredContent(opened).root, context.project);
  assert.equal(structuredContent(opened).resolutionReason, "NEW_TASK_CANONICAL_DEFAULT");
  assert.match(responseText(opened), /Project ID: fixture-project/);

  const repeated = await callOpenProject(context.client, "Fixture", "new", "chat-project");
  assert.equal(structuredContent(repeated).workspaceId, structuredContent(opened).workspaceId);
});

test("degraded opens expose the baseline diagnostic on both entry points and preserve read access", async (t) => {
  const context = await fixture(t, { git: true, widgets: "changes" });
  const originalOpen = WorkspaceRegistry.prototype.openWorkspace;
  t.mock.method(WorkspaceRegistry.prototype, "openWorkspace", async function (
    this: WorkspaceRegistry,
    ...args: Parameters<WorkspaceRegistry["openWorkspace"]>
  ) {
    const opened = await Reflect.apply(originalOpen, this, args);
    opened.workspace.mutationFingerprint = undefined;
    opened.workspace.mutationFingerprintProblem = "Test scan exceeded its time budget.";
    return opened;
  });

  for (const entry of ["workspace", "project"] as const) {
    const open = () => entry === "workspace"
      ? callOpen(context.client, context.project, "degraded-workspace")
      : callOpenProject(context.client, "fixture-project", "new", "degraded-project");
    const first = await open();
    const repeated = await open();
    for (const result of [first, repeated]) {
      assert.equal(result.isError, undefined);
      assert.match(responseText(result), /WORKSPACE_BASELINE_UNAVAILABLE/);
      assert.match(String(structuredContent(result).instruction), /WORKSPACE_BASELINE_UNAVAILABLE/);
      assert.match(String(responseCard(result).instruction), /WORKSPACE_BASELINE_UNAVAILABLE/);
    }
    const workspaceId = structuredContent(first).workspaceId;
    const readable = await context.client.callTool({
      name: "read",
      arguments: { workspaceId, path: "AGENTS.md" },
    });
    assert.equal(readable.isError, undefined);
    assert.match(responseText(readable), /project instructions/);
    const blocked = await context.client.callTool({
      name: "bash",
      arguments: { workspaceId, command: "echo mutation-must-not-run" },
    });
    assert.equal(blocked.isError, true);
    assert.match(responseText(blocked), /WORKSPACE_BASELINE_UNAVAILABLE/);
  }

  const refs = await execFileAsync("git", [
    "for-each-ref", "--format=%(refname)", "refs/devspace/review",
  ], { cwd: context.project });
  assert.equal(refs.stdout, "", "degraded opening must not start a full review snapshot");
});

test("open_project fails closed for an unknown registered project", async (t) => {
  const context = await fixture(t);
  const result = await callOpenProject(context.client, "missing-project", "new", "chat-project");

  assert.equal(result.isError, true);
  assert.equal(structuredContent(result).status, "not_found");
  assert.equal(structuredContent(result).workspaceId, undefined);
  assert.match(responseText(result), /No workspace was opened/);
});

test("the unified project entry can be disabled without removing open_workspace", async (t) => {
  const context = await fixture(t, { unifiedProjectWorkspace: false });
  const tools = await context.client.listTools();

  assert.equal(tools.tools.some((tool) => tool.name === "open_project"), false);
  assert.equal(tools.tools.some((tool) => tool.name === "open_workspace"), true);
});

test("the controlled external repository tool remains opt-in", async (t) => {
  const context = await fixture(t, { externalRepositoryEnabled: true });
  const tools = await context.client.listTools();

  assert.equal(tools.tools.some((tool) => tool.name === "setup_external_repository"), true);
});

test("the controlled external repository tool fails closed without portfolio authority", async (t) => {
  const context = await fixture(t, {
    externalRepositoryEnabled: true,
    portfolioRoot: false,
  });
  const opened = await callOpen(context.client, context.project, "chat-external");
  const result = await context.client.callTool({
    name: "setup_external_repository",
    arguments: {
      workspaceId: structuredContent(opened).workspaceId,
      repositoryUrl: "https://github.com/example/other",
      destination: "external-repository",
    },
  });

  assert.equal(result.isError, true);
  assert.match(responseText(result), /SOURCE_AUTHORITY_REGISTRY_REQUIRED/);
});

test("codex exec_command rejects a workspace changed after open", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const opened = await callOpen(context.client, context.project, "chat-stale-exec");
  const workspaceId = structuredContent(opened).workspaceId as string;
  await writeFile(join(context.project, "external-change.txt"), "outside\n");

  const result = await callExecCommand(
    context.client,
    workspaceId,
    nodeCommand("console.log('must not run')"),
  );

  assert.equal(result.isError, true);
  assert.match(responseText(result), /WORKSPACE_CHANGED_EXTERNALLY/);
});

test("a running codex process excludes concurrent workspace mutations", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const opened = await callOpen(context.client, context.project, "chat-running-exec");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const started = await callExecCommand(
    context.client,
    workspaceId,
    nodeCommand("setTimeout(() => process.exit(0), 400)"),
    1,
  );
  const sessionId = structuredContent(started).sessionId as number;
  assert.equal(structuredContent(started).running, true);
  assert.equal(typeof sessionId, "number");

  const concurrent = await callApplyPatch(
    context.client,
    workspaceId,
    `*** Begin Patch
*** Add File: during-process.txt
+unsafe
*** End Patch`,
  );

  assert.equal(concurrent.isError, true);
  assert.match(responseText(concurrent), /WORKSPACE_MUTATION_IN_PROGRESS/);
  await callWriteStdin(context.client, workspaceId, sessionId, 2_000);
});

test("a completed codex process refreshes the workspace mutation baseline", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const opened = await callOpen(context.client, context.project, "chat-completed-exec");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const started = await callExecCommand(
    context.client,
    workspaceId,
    nodeCommand("setTimeout(() => require('node:fs').writeFileSync('process-output.txt', 'done\\n'), 50)"),
    1,
  );
  const sessionId = structuredContent(started).sessionId as number;
  assert.equal(structuredContent(started).running, true);
  const completed = await callWriteStdin(context.client, workspaceId, sessionId, 2_000);
  assert.equal(structuredContent(completed).running, false);

  const after = await callApplyPatch(
    context.client,
    workspaceId,
    `*** Begin Patch
*** Add File: after-process.txt
+safe
*** End Patch`,
  );
  assert.equal(after.isError, undefined);
  assert.equal(await readFile(join(context.project, "after-process.txt"), "utf8"), "safe\n");
});

test("a codex process releases its workspace lease on exit without polling", async (t) => {
  const context = await fixture(t, { toolMode: "codex" });
  const opened = await callOpen(context.client, context.project, "chat-unpolled-exec");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const started = await callExecCommand(
    context.client,
    workspaceId,
    nodeCommand("setTimeout(() => process.exit(0), 50)"),
    1,
  );
  assert.equal(structuredContent(started).running, true);

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  const after = await callApplyPatch(
    context.client,
    workspaceId,
    `*** Begin Patch
*** Add File: after-unpolled-process.txt
+safe
*** End Patch`,
  );

  assert.equal(after.isError, undefined);
  assert.equal(
    await readFile(join(context.project, "after-unpolled-process.txt"), "utf8"),
    "safe\n",
  );
});

test("concurrent checkout opens return one full context and one reuse instruction", async (t) => {
  const context = await fixture(t);
  const [first, second] = await Promise.all([
    callOpen(context.client, context.project, "chat-1"),
    callOpen(context.client, context.project, "chat-1"),
  ]);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.equal(
    [first, second].filter((result) => Array.isArray(structuredContent(result).agentsFiles)).length,
    1,
  );
  assert.equal(
    [first, second].filter((result) => responseText(result).includes("Workspace already open as")).length,
    1,
  );
});

test("open_workspace rejects the retired worktree mode without replacing checkout reuse", async (t) => {
  const context = await fixture(t, { git: true });
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const worktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(worktree.isError, true);
  assert.match(responseText(worktree), /Managed worktree mode is disabled/);
  assert.match(responseText(worktree), /exact existing project directory/);
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
  assert.match(responseText(checkoutAgain), /same physical directory previously opened/);
});

test("checkout opens normally after a rejected worktree-first request", async (t) => {
  const context = await fixture(t, { git: true });
  const worktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(worktree.isError, true);
  assert.match(responseText(worktree), /Managed worktree mode is disabled/);
  assert.match(responseText(worktree), /exact existing project directory/);
  assert.equal(structuredContent(checkout).mode, "checkout");
  assert.ok(Array.isArray(structuredContent(checkout).agentsFiles));
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
  assert.match(responseText(checkoutAgain), /same physical directory previously opened/);
});

test("a host without conversation metadata receives normal explicit-workspace behavior", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const second = await callOpen(context.client, context.project);

  assert.notEqual(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.ok(Array.isArray(structuredContent(first).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).agentsFiles));
  assert.doesNotMatch(responseText(first), /conversation metadata/i);
  assert.doesNotMatch(responseText(second), /conversation metadata/i);
});

test("checkout reuse and context suppression survive a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const firstWorkspaceId = structuredContent(first).workspaceId;

  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredServer = createMcpServer(
    context.config,
    new WorkspaceRegistry(context.config, restoredStore),
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    [],
  );
  const [restoredClientTransport, restoredServerTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "devspace-restored-test-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    restoredStore.close();
  };
  t.after(closeRestored);

  try {
    await Promise.all([
      restoredClient.connect(restoredClientTransport),
      restoredServer.connect(restoredServerTransport),
    ]);

    const restored = await callOpen(restoredClient, context.project, "chat-1");
    assert.equal(structuredContent(restored).workspaceId, firstWorkspaceId);
    assert.equal(structuredContent(restored).agentsFiles, undefined);
    assert.match(responseText(restored), /same physical directory previously opened/);
  } finally {
    await closeRestored();
  }
});

interface ServerFixture {
  client: Client;
  project: string;
  config: ServerConfig;
  stateDir: string;
  close: () => Promise<void>;
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    widgets?: "full" | "changes";
    toolMode?: "full" | "codex";
    unifiedProjectWorkspace?: boolean;
    externalRepositoryEnabled?: boolean;
    portfolioRoot?: boolean;
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(project, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(root, "portfolio"), { recursive: true });
  await writeFile(
    join(root, "portfolio", "PROJECT_REGISTRY.json"),
    JSON.stringify({
      projects: [
        {
          project_id: "fixture-project",
          name: "Fixture Project",
          display_name: "Fixture",
          canonical_path: project,
          status: "ACTIVE",
        },
      ],
    }),
  );
  await writeFile(
    join(root, "portfolio", "PROJECT_ALIASES.json"),
    JSON.stringify({
      directoryAliases: [
        {
          source_path: join(root, "fixture-alias"),
          target_project_id: "fixture-project",
        },
      ],
    }),
  );
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: options.widgets ?? "full",
    DEVSPACE_TOOL_MODE: options.toolMode ?? "full",
    DEVSPACE_UNIFIED_PROJECT_WORKSPACE:
      options.unifiedProjectWorkspace === false ? "0" : "1",
    DEVSPACE_EXTERNAL_REPOSITORY:
      options.externalRepositoryEnabled === true ? "1" : "0",
    ...(options.portfolioRoot === false ? {} : { DEVSPACE_PORTFOLIO_ROOT: root }),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, config, stateDir, close };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
  mode?: "checkout" | "worktree",
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: {
      path,
      ...(mode ? { mode } : {}),
    },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

async function callOpenProject(
  client: Client,
  project: string,
  intent: "new" | "resume" | "inspect",
  conversationScopeId?: string,
  taskHint?: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_project",
    arguments: {
      project,
      intent,
      ...(taskHint ? { taskHint } : {}),
    },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

async function callExecCommand(
  client: Client,
  workspaceId: string,
  cmd: string,
  yieldTimeMs = 2_000,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return client.callTool({
    name: "exec_command",
    arguments: { workspaceId, cmd, yieldTimeMs },
  });
}

async function callWriteStdin(
  client: Client,
  workspaceId: string,
  sessionId: number,
  yieldTimeMs: number,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, sessionId, yieldTimeMs },
  });
}

async function callApplyPatch(
  client: Client,
  workspaceId: string,
  patch: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return client.callTool({
    name: "apply_patch",
    arguments: { workspaceId, patch },
  });
}

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
