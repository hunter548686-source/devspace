import { spawn } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, realpath, readdir, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { isPathInsideRoot } from "./roots.js";

const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
let claimQueue = Promise.resolve();
const finishedStatuses = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);
function processAbsent(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) < 1) return false;
  try { process.kill(Number(pid), 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
type State = { taskId: string; workspaceId: string; root: string; status: string; token: string; controlPort: number; [key: string]: unknown };
export class DurableTasks {
  constructor(private readonly root: string) {}
  private directory(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid task ID.");
    return join(this.root, id);
  }
  async assertUnlocked(root: string): Promise<void> {
    const physical = await realpath(root);
    const leases = join(this.root, "leases");
    let names: string[];
    try { names = await readdir(leases); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      let lease: { root: string; taskId: string };
      try { lease = JSON.parse(await readFile(join(leases, name), "utf8")); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (isPathInsideRoot(physical, lease.root) || isPathInsideRoot(lease.root, physical)) {
        const saved = await readFile(join(this.directory(lease.taskId),"state.json"),"utf8").then(raw=>JSON.parse(raw)).catch(()=>undefined);
        if (saved && (finishedStatuses.has(saved.status) || (processAbsent(saved.workerPid) && processAbsent(saved.childPid)))) {
          await this.releaseLease(join(leases,name),lease.taskId);
          continue;
        }
        throw new Error("WORKSPACE_MUTATION_IN_PROGRESS: background task " + lease.taskId + " owns this workspace. Read tools and task status/log/cancel remain available.");
      }
    }
  }
  async start(input: { workspaceId: string; root: string; cwd: string; command: string; timeoutSeconds?: number }): Promise<unknown> {
    const taskId = randomUUID();
    const directory = this.directory(taskId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.assertUnlocked(input.root);
    const physicalRoot = await realpath(input.root);
    const leases = join(this.root, "leases");
    await mkdir(leases, { recursive: true, mode: 0o700 });
    const leasePath = join(leases, createHash("sha256").update(physicalRoot).digest("hex") + ".json");
    const previousClaim = claimQueue;
    let releaseClaim!: () => void;
    claimQueue = new Promise<void>(resolve => { releaseClaim = resolve; });
    await previousClaim;
    try {
      await this.assertUnlocked(input.root);
      await writeFile(leasePath, JSON.stringify({ taskId, root: physicalRoot }), { flag: "wx", mode: 0o600 });
    } finally { releaseClaim(); }
    const specification = { ...input, taskId, leasePath, createdAt: new Date().toISOString(), token: randomBytes(32).toString("hex") };
    try { await writeFile(join(directory, "spec.json"), JSON.stringify(specification), { flag: "wx", mode: 0o600 }); }
    catch (error) { await unlink(leasePath).catch(() => {}); throw error; }
    let worker = fileURLToPath(new URL("./task-worker.js", import.meta.url));
    if (!existsSync(worker)) worker = fileURLToPath(new URL("./task-worker.ts", import.meta.url));
    const child = spawn(process.execPath, [...process.execArgv, worker, directory], {
      detached: true, stdio: "ignore", cwd: input.cwd, env: process.env,
    });
    const spawned = new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    try { await spawned; } catch (error) { await unlink(leasePath).catch(() => {}); throw error; }
    child.unref();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { await readFile(join(directory, "state.json")); return await this.status(input.workspaceId, input.root, taskId); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { taskId, status: "starting", instruction: "Poll task_status. Do not submit the command again." };
  }
  private async releaseLease(path: string, id: string): Promise<void> {
    try { const current = JSON.parse(await readFile(path,"utf8")); if(current.taskId === id) await unlink(path); }
    catch(error) { if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async list(workspaceId: string, root: string): Promise<unknown[]> {
    let names: string[];
    try { names = await readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const results: unknown[] = [];
    for (const name of names) {
      if (!/^[a-f0-9-]{36}$/.test(name)) continue;
      const spec = JSON.parse(await readFile(join(this.root,name,"spec.json"),"utf8").catch(()=>"null"));
      if (spec?.workspaceId === workspaceId && spec?.root === root) results.push(await this.status(workspaceId,root,name));
    }
    return results;
  }
  private async state(workspaceId: string, root: string, id: string): Promise<State> {
    const directory = this.directory(id);
    const specification = JSON.parse(await readFile(join(directory, "spec.json"), "utf8"));
    if (specification.workspaceId !== workspaceId || specification.root !== root) throw new Error("Task belongs to another workspace.");
    try { return JSON.parse(await readFile(join(directory, "state.json"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { taskId: id, workspaceId, root, status: Date.now() - Date.parse(specification.createdAt) > 10000 ? "unknown" : "starting", token: specification.token, controlPort: 0 };
    }
  }
  private async control(state: State, action: string, chars?: string): Promise<Record<string, unknown>> {
    if (!state.controlPort) throw new Error("Task worker has not published its control endpoint.");
    return new Promise((resolve, reject) => {
      const socket = connect(state.controlPort, "127.0.0.1");
      let response = "";
      socket.setEncoding("utf8");
      socket.setTimeout(3000, () => socket.destroy(new Error("Task worker did not respond.")));
      socket.once("error", reject);
      socket.once("connect", () => socket.write(JSON.stringify({ token: state.token, action, chars }) + "\n"));
      socket.on("data", chunk => { response += chunk; if (response.length > 8192) socket.destroy(new Error("Invalid control response.")); });
      socket.once("end", () => { try { resolve(JSON.parse(response)); } catch { reject(new Error("Invalid task control response.")); } });
    });
  }
  async status(workspaceId: string, root: string, id: string): Promise<unknown> {
    const state = await this.state(workspaceId, root, id);
    const { token: _token, controlPort: _port, ...publicState } = state;
    if (state.status === "running") {
      try { Object.assign(publicState, await this.control(state, "status")); }
      catch {
        if (processAbsent(state.workerPid) && processAbsent(state.childPid)) {
          publicState.status = "interrupted"; publicState.detail = "Worker and child have exited; retained logs are available. No command was repeated.";
        } else { publicState.status = "unknown"; publicState.detail = "Worker could not be contacted. Task was not restarted; retained logs remain available."; }
      }
    }
    return publicState;
  }
  async act(workspaceId: string, root: string, id: string, action: "input" | "cancel", chars?: string): Promise<unknown> {
    if (chars && Buffer.byteLength(JSON.stringify(chars)) > 120 * 1024) throw new Error("Input exceeds 120 KiB encoded; send smaller chunks.");
    const state = await this.state(workspaceId, root, id);
    if (state.status !== "running") return this.status(workspaceId, root, id);
    await this.control(state, action, chars);
    return this.status(workspaceId, root, id);
  }
  async logs(workspaceId: string, root: string, id: string, offset = 0, limit = 12288): Promise<unknown> {
    await this.state(workspaceId, root, id);
    const path = join(this.directory(id), "output.log");
    const handle = await import("node:fs/promises").then(fs => fs.open(path, "r"));
    try {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, offset);
      const size = (await handle.stat()).size;
      return { taskId: id, offset, nextOffset: offset + bytesRead, totalBytes: size, hasMore: offset + bytesRead < size, data: buffer.subarray(0, bytesRead).toString("base64"), encoding: "base64", textPreview: buffer.subarray(0, bytesRead).toString("utf8"), task: await this.status(workspaceId, root, id) };
    } finally { await handle.close(); }
  }
}

export function registerDurableTaskTools(server: McpServer, workspaces: WorkspaceRegistry, stateDir: string): void {
  const tasks = new DurableTasks(join(stateDir, "tasks"));
  workspaces.setExternalMutationGuard(workspace => tasks.assertUnlocked(workspace.root));
  const identity = { workspaceId: z.string(), taskId: z.string() };
  server.registerTool("start_task", {
    description: "Start an authorized long-running build, test, package script or other command. The worker survives client disconnects and DevSpace restart, persists complete logs, and returns taskId. There is no universal five-minute timeout. Use file tools for source modifications. Never resubmit because the client disconnected.",
    inputSchema: { workspaceId: z.string(), command: z.string().min(1), workingDirectory: z.string().optional(), timeoutSeconds: z.number().positive().max(2147483).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ workspaceId, command, workingDirectory, timeoutSeconds }) => {
    const workspace = workspaces.getWorkspace(workspaceId);
    const cwd = await realpath(workspaces.resolveWorkingDirectory(workspace, workingDirectory));
    return reply(await workspaces.runMutation(workspace, "start_task", () => tasks.start({ workspaceId, root: workspace.root, cwd, command, timeoutSeconds }), []));
  });
  server.registerTool("list_tasks", {
    description: "Recover task identifiers after a disconnect before start_task returned. Lists persisted tasks owned by this workspace without executing commands again.",
    inputSchema: { workspaceId: z.string() }, annotations: { readOnlyHint: true },
  }, async ({workspaceId}) => reply(await tasks.list(workspaceId,workspaces.getWorkspace(workspaceId).root)));
  server.registerTool("task_status", {
    description: "Recover the actual status of a previously started task without executing it again.",
    inputSchema: identity, annotations: { readOnlyHint: true },
  }, async ({ workspaceId, taskId }) => reply(await tasks.status(workspaceId, workspaces.getWorkspace(workspaceId).root, taskId)));
  server.registerTool("task_log", {
    description: "Read complete persisted task output by byte offset. Continue nextOffset while hasMore; if task is running, poll again for new output. data is base64 for exact reconstruction.",
    inputSchema: { ...identity, offset: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(24576).default(12288) },
    annotations: { readOnlyHint: true },
  }, async ({ workspaceId, taskId, offset, limit }) => reply(await tasks.logs(workspaceId, workspaces.getWorkspace(workspaceId).root, taskId, offset, limit)));
  server.registerTool("task_input", {
    description: "Send input to the authorized task's stdin. For terminal-specific interaction use exec_command with tty.",
    inputSchema: { ...identity, chars: z.string().max(65536) }, annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ workspaceId, taskId, chars }) => reply(await tasks.act(workspaceId, workspaces.getWorkspace(workspaceId).root, taskId, "input", chars)));
  server.registerTool("cancel_task", {
    description: "Cancel only the identified task and its child process tree. Completed tasks and retained logs are preserved.",
    inputSchema: identity, annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ workspaceId, taskId }) => reply(await tasks.act(workspaceId, workspaces.getWorkspace(workspaceId).root, taskId, "cancel")));
}
