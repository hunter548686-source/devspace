import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";

const directory = process.argv[2];
if (!directory) throw new Error("Missing task directory.");
const specification = JSON.parse(await readFile(join(directory, "spec.json"), "utf8"));
const log = createWriteStream(join(directory, "output.log"), { flags: "ax", mode: 0o600 });
await once(log, "open");
const state: Record<string, unknown> = {
  taskId: specification.taskId, workspaceId: specification.workspaceId, root: specification.root,
  status: "starting", startedAt: new Date().toISOString(), workerPid: process.pid,
  token: specification.token, controlPort: null, exitCode: null, signal: null,
};
let stateQueue = Promise.resolve();
function persist(): Promise<void> {
  const value = JSON.stringify(state);
  stateQueue = stateQueue.then(async () => {
    await writeFile(join(directory, "state.tmp"), value, { mode: 0o600 });
    await rename(join(directory, "state.tmp"), join(directory, "state.json"));
  });
  return stateQueue;
}
const child = spawn(specification.command, {
  cwd: specification.cwd, shell: resolveShellCommand(specification.command).executable,
  detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, DEVSPACE_WORKSPACE_ID: specification.workspaceId, DEVSPACE_WORKSPACE_ROOT: specification.root, NO_COLOR: "1", PAGER: "cat" },
});
state.childPid = child.pid;
const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
  child.once("error", error => { state.error = error.message; });
  child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
});
let logFailure: Error | undefined;
log.on("error", error => { logFailure = error; state.error = error.message; child.kill("SIGTERM"); });
child.stdin.on("error", error => { state.inputError = error.message; });
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
let finished = false;
let forceKill: NodeJS.Timeout | undefined;
let budgetTimer: NodeJS.Timeout | undefined;
function cancel(signal: NodeJS.Signals = "SIGTERM") {
  if (finished) return;
  terminateProcessTree(child, signal, process.platform !== "win32");
  forceKill ??= setTimeout(() => terminateProcessTree(child, "SIGKILL", process.platform !== "win32"), 2000);
  forceKill.unref();
}
const control = createServer(socket => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.setTimeout(5000, () => socket.destroy());
  socket.on("error", () => {});
  socket.on("data", chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 128 * 1024) { socket.destroy(); return; }
    if (!buffer.includes("\n")) return;
    try {
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      const given = Buffer.from(String(request.token ?? ""));
      const expected = Buffer.from(specification.token);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) { socket.destroy(); return; }
      if (request.action === "input" && !finished) child.stdin.write(String(request.chars ?? ""));
      else if (request.action === "cancel") cancel();
      else if (request.action !== "status" && request.action !== "input") throw new Error("Unknown action.");
      socket.end(JSON.stringify({ status: state.status, exitCode: state.exitCode, signal: state.signal }) + "\n");
    } catch { socket.destroy(); }
  });
});
await new Promise<void>((resolve, reject) => {
  control.once("error", reject);
  control.listen(0, "127.0.0.1", resolve);
});
const address = control.address();
state.controlPort = typeof address === "object" && address ? address.port : undefined;
state.status = "running";
await persist();

if (specification.timeoutSeconds !== undefined) {
  budgetTimer = setTimeout(() => { state.timedOut = true; cancel(); }, specification.timeoutSeconds * 1000);
}
void exited.then(async ({ exitCode, signal }) => {
  finished = true;
  if (forceKill) clearTimeout(forceKill);
  if (budgetTimer) clearTimeout(budgetTimer);
  state.status = state.timedOut ? "timed_out" : signal ? "cancelled" : exitCode === 0 ? "completed" : "failed";
  state.exitCode = exitCode;
  state.signal = signal;
  state.finishedAt = new Date().toISOString();
  if (!logFailure) {
    const flushed = once(log, "finish");
    log.end();
    await flushed.catch(error => { logFailure = error; state.error = String(error); });
  }
  if (logFailure) state.status = "failed";
  await persist();
  try {
    const lease = JSON.parse(await readFile(specification.leasePath, "utf8"));
    if (lease.taskId === specification.taskId) await unlink(specification.leasePath);
  } catch {}
  control.close();
}).catch(error => { process.stderr.write(String(error)); process.exitCode = 1; control.close(); });
process.on("SIGTERM", () => cancel());
process.on("SIGINT", () => cancel("SIGINT"));
