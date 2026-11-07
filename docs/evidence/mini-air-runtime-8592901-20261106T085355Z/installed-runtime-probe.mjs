import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const [mode, rawPackageRoot, checkpoint] = process.argv.slice(2);
const packageRoot = resolve(rawPackageRoot);
const fromDist = (name) => import(pathToFileURL(join(packageRoot, "dist", name + ".js")).href);
const { DurableTasks } = await fromDist("durable-tasks");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (r) => (r.content || []).filter((x) => x.type === "text").map((x) => x.text).join("\n");

if (mode === "check") {
  const directory = await mkdtemp(join(tmpdir(), "devspace-runtime-probe-"));
  const project = join(directory, "project");
  const agent = join(directory, "agent");
  await mkdir(project); await mkdir(agent);
  await writeFile(join(project, "target.txt"), "before\n");
  await writeFile(join(project, "unrelated.txt"), "before-unrelated\n");
  const [{ loadConfig }, { WorkspaceRegistry }, { SqliteWorkspaceStore },
    { createMcpServer }, { createReviewCheckpointManager }, { ProcessSessionManager }] =
    await Promise.all(["config", "workspaces", "workspace-store", "server", "review-checkpoints", "process-sessions"].map(fromDist));
  const require = createRequire(join(packageRoot, "package.json"));
  const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const { InMemoryTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/inMemory.js")).href);
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(directory, "config"),
    DEVSPACE_STATE_DIR: join(directory, "state"),
    DEVSPACE_ALLOWED_ROOTS: directory,
    DEVSPACE_AGENT_DIR: agent,
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_UNIFIED_PROJECT_WORKSPACE: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "isolated-acceptance-owner-value",
    PORT: "1",
  });
  const store = new SqliteWorkspaceStore(config.stateDir);
  const registry = new WorkspaceRegistry(config, store);
  const server = createMcpServer(config, registry, createReviewCheckpointManager(), new ProcessSessionManager(), []);
  const client = new Client({ name: "isolated-runtime-acceptance", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const tools = (await client.listTools()).tools.map((x) => x.name).sort();
    for (const name of ["start_task", "list_tasks", "task_status", "task_log", "task_input", "cancel_task", "copy_file", "move_file", "make_directory"]) {
      assert.ok(tools.includes(name), "missing tool: " + name);
    }
    const opened = await client.callTool({ name: "open_workspace", arguments: { path: project } });
    assert.ok(!opened.isError, textOf(opened));
    const workspaceId = opened.structuredContent.workspaceId;
    await client.callTool({ name: "read", arguments: { workspaceId, path: "target.txt" } });
    await writeFile(join(project, "unrelated.txt"), "external-same-directory\n");
    const edited = await client.callTool({ name: "edit", arguments: {
      workspaceId, path: "target.txt", edits: [{ oldText: "before\n", newText: "after\n" }]
    } });
    assert.ok(!edited.isError, textOf(edited));
    assert.equal(await readFile(join(project, "target.txt"), "utf8"), "after\n");
    assert.equal(await readFile(join(project, "unrelated.txt"), "utf8"), "external-same-directory\n");
    await writeFile(join(project, "target.txt"), "external-target\n");
    const stale = await client.callTool({ name: "edit", arguments: {
      workspaceId, path: "target.txt", edits: [{ oldText: "after\n", newText: "must-not-write\n" }]
    } });
    assert.equal(stale.isError, true);
    assert.equal(await readFile(join(project, "target.txt"), "utf8"), "external-target\n");
    const tasks = new DurableTasks(join(directory, "direct-tasks"));
    const task = await tasks.start({ workspaceId: "probe", root: project, cwd: project, command: "printf 'candidate-durable-ok\\n'" });
    let state;
    for (let i = 0; i < 50; i++) {
      state = await tasks.status("probe", project, task.taskId);
      if (state.status === "completed") break;
      await pause(100);
    }
    assert.equal(state.status, "completed");
    assert.equal(state.exitCode, 0);
    assert.equal((await tasks.logs("probe", project, task.taskId)).textPreview, "candidate-durable-ok\n");
    await tasks.assertUnlocked(project);
    console.log(JSON.stringify({ status: "PASS", packageRoot, node: process.version, abi: process.versions.modules,
      sameDirectoryUnrelatedChange: "PASS", staleTargetProtected: "PASS", sqliteNativeLoaded: true,
      detachedWorker: "PASS", toolNames: tools,
      scope: "isolated in-memory MCP against installed code; no production OAuth used" }));
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
} else if (mode === "start") {
  const directory = await mkdtemp(join(tmpdir(), "devspace-runtime-probe-"));
  const root = join(directory, "project"); await mkdir(root);
  const tasks = new DurableTasks(join(directory, "tasks"));
  const task = await tasks.start({ workspaceId: "restart-probe", root, cwd: root,
    command: "printf 'durable-start\\n'; sleep 30; printf 'durable-complete\\n'" });
  assert.equal(task.status, "running");
  const checkpointPath = join(directory, "checkpoint.json");
  await writeFile(checkpointPath, JSON.stringify({ directory, root, taskId: task.taskId, started: Date.now(), packageRoot }), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ status: task.status, taskId: task.taskId, checkpoint: checkpointPath,
    workerPid: task.workerPid, childPid: task.childPid, packageRoot }));
} else if (mode === "finish") {
  const saved = JSON.parse(await readFile(checkpoint, "utf8"));
  assert.equal(saved.packageRoot, packageRoot);
  assert.ok(basename(saved.directory).startsWith("devspace-runtime-probe-"));
  assert.equal(resolve(checkpoint), join(saved.directory, "checkpoint.json"));
  const tasks = new DurableTasks(join(saved.directory, "tasks"));
  let state;
  for (let i = 0; i < 90; i++) {
    state = await tasks.status("restart-probe", saved.root, saved.taskId);
    if (!["running", "starting"].includes(state.status)) break;
    await pause(500);
  }
  assert.equal(state.status, "completed");
  assert.equal(state.exitCode, 0);
  const logs = await tasks.logs("restart-probe", saved.root, saved.taskId);
  assert.equal(logs.textPreview, "durable-start\ndurable-complete\n");
  await tasks.assertUnlocked(saved.root);
  console.log(JSON.stringify({ status: "PASS", taskId: saved.taskId, workerPid: state.workerPid,
    childPid: state.childPid, exitCode: state.exitCode, elapsedSeconds: (Date.now() - saved.started) / 1000,
    log: logs.textPreview, packageRoot,
    scope: "isolated DurableTasks manager across real DevSpace service restart; not live OAuth MCP integration" }));
  await rm(saved.directory, { recursive: true, force: true });
} else {
  throw new Error("Usage: node installed-runtime-probe.mjs check|start|finish PACKAGE_ROOT [CHECKPOINT]");
}
