import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { isPathInsideRoot } from "./roots.js";

type Query = { operation: "grep" | "glob" | "ls"; path?: string; pattern?: string; include?: string; includeIgnored?: boolean; literal?: boolean; ignoreCase?: boolean };
type Scan = { workspaceId: string; root: string; query: Query; createdAt: string; status: "running" | "complete" | "failed" | "interrupted"; count: number; error?: string };
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const activeScans = new Set<string>();

async function physicalPath(root: string, path: string): Promise<string> {
  const [physicalRoot, target] = await Promise.all([realpath(root), realpath(path)]);
  if (!isPathInsideRoot(target, physicalRoot)) throw new Error("Path resolves outside the workspace.");
  return target;
}

export class InspectionPages {
  constructor(private readonly directory: string) {}

  private async save(id: string, scan: Scan): Promise<void> {
    const temporary = join(this.directory, id + ".tmp");
    await writeFile(temporary, JSON.stringify(scan), { mode: 0o600 });
    await rename(temporary, join(this.directory, id + ".json"));
  }

  async start(workspaceId: string, root: string, query: Query, absolutePath: string): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await physicalPath(root, absolutePath);
    const id = randomUUID();
    const scan: Scan = { workspaceId, root, query, createdAt: new Date().toISOString(), status: "running", count: 0 };
    await this.save(id, scan);
    activeScans.add(id);
    const run = async () => {
      const output = await open(join(this.directory, id + ".jsonl"), "wx", 0o600);
      const emit = async (row: unknown) => {
        await output.writeFile(JSON.stringify(row) + "\n");
        scan.count += 1;
      };
      try {
        if (query.operation === "ls") {
          const entries = await readdir(absolutePath, { withFileTypes: true });
          entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
          for (const entry of entries) await emit({ name: entry.name, kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file" });
        } else {
          const manager = await import(new URL("./utils/tools-manager.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
          const rg: string | undefined = manager.getToolPath("rg") ?? await manager.ensureTool("rg");
          if (!rg) throw new Error("ripgrep is unavailable; install the configured runtime dependency.");
          const args = query.operation === "grep" ? ["--json", "--hidden", "--color=never"] : ["--files", "--hidden", "--null"];
          if (query.includeIgnored) args.push("--no-ignore");
          if (query.include) args.push("--glob", query.include);
          if (query.operation === "glob") {
            if (query.pattern) args.push("--glob", query.pattern);
          } else {
            if (query.literal) args.push("--fixed-strings");
            if (query.ignoreCase) args.push("--ignore-case");
            if (query.pattern === undefined) throw new Error("grep requires pattern.");
          }
          args.push("--");
          if (query.operation === "grep") args.push(query.pattern!);
          args.push(absolutePath);
          const child = spawn(rg, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
          child.stdout.setEncoding("utf8");
          let stderr = "";
          child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
          const ended = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
          // Attach rejection handling immediately, including while consuming stdout.
          void ended.catch(() => {});
          let pending = "";
          const delimiter = query.operation === "grep" ? "\n" : "\0";
          try {
            for await (const chunk of child.stdout) {
              pending += chunk.toString("utf8");
              let end: number;
              while ((end = pending.indexOf(delimiter)) !== -1) {
                const line = pending.slice(0, end); pending = pending.slice(end + 1);
                if (!line) continue;
                if (query.operation === "glob") await emit({ path: line });
                else {
                  const event = JSON.parse(line);
                  if (event.type === "match") await emit({
                    path: event.data.path.text ?? Buffer.from(event.data.path.bytes, "base64").toString("utf8"),
                    line: event.data.line_number,
                    text: event.data.lines.text ?? Buffer.from(event.data.lines.bytes, "base64").toString("utf8"),
                    matches: event.data.submatches,
                  });
                }
              }
            }
            const code = await ended;
            if (code !== 0 && code !== 1) throw new Error(stderr || "Search process failed: " + code);
          } catch (error) {
            child.kill("SIGTERM");
            throw error;
          }
        }
        await output.sync();
        scan.status = "complete";
      } catch (error) {
        scan.status = "failed";
        scan.error = error instanceof Error ? error.message : String(error);
      } finally {
        await output.close();
        await this.save(id, scan);
        activeScans.delete(id);
      }
    };
    void run().catch(() => activeScans.delete(id));
    return Buffer.from(JSON.stringify({ id, offset: 0 })).toString("base64url");
  }

  async page(workspaceId: string, root: string, cursor: string, limit = 100): Promise<unknown> {
    let parsed: { id: string; offset: number };
    try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()); }
    catch { throw new Error("Invalid inspection cursor."); }
    if (!/^[a-f0-9-]{36}$/.test(parsed.id) || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error("Invalid inspection cursor.");
    const scan: Scan = JSON.parse(await readFile(join(this.directory, parsed.id + ".json"), "utf8"));
    if (scan.workspaceId !== workspaceId || scan.root !== root) throw new Error("Inspection cursor belongs to another workspace.");
    if (scan.status === "running" && !activeScans.has(parsed.id)) {
      scan.status = "interrupted";
      scan.error = "Service restarted during the scan. Existing snapshot rows remain available; start a new scan for complete results.";
    }
    const rows: unknown[] = [];
    let offset = parsed.offset;
    let bytes = 0;
    let pending = Buffer.alloc(0);
    let atEnd = true;
    const path = join(this.directory, parsed.id + ".jsonl");
    try {
      for await (const raw of createReadStream(path, { start: parsed.offset, highWaterMark: 64 * 1024 })) {
        pending = Buffer.concat([pending, Buffer.from(raw)]);
        let newline: number;
        while ((newline = pending.indexOf(10)) !== -1) {
          const record = pending.subarray(0, newline);
          if (rows.length && (rows.length >= limit || bytes + record.length > 48 * 1024)) { atEnd = false; break; }
          const row = JSON.parse(record.toString("utf8"));
          // The source line remains available via read_page; only this display preview is shortened.
          if (typeof row.text === "string" && row.text.length > 8000) {
            row.text = row.text.slice(0, 8000);
            row.linePreviewTruncated = true;
            row.continueWith = "read_page on path; use byte pagination for exact contents";
            delete row.matches;
          }
          rows.push(row);
          offset += newline + 1;
          bytes += record.length;
          pending = pending.subarray(newline + 1);
        }
        if (!atEnd) break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || scan.status !== "running") throw error;
    }
    const done = atEnd && scan.status !== "running";
    return {
      rows, snapshotCreatedAt: scan.createdAt, scanStatus: scan.status,
      scanError: scan.error, total: scan.status === "complete" ? scan.count : undefined,
      complete: done && scan.status === "complete",
      hasMore: !done,
      nextCursor: done ? undefined : Buffer.from(JSON.stringify({ id: parsed.id, offset })).toString("base64url"),
      query: scan.query,
    };
  }
}

export async function readBytePage(path: string, offset: number, limit: number, expectedVersion?: string) {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("read_page requires a regular file.");
    const version = createHash("sha256").update([before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(":")).digest("hex");
    if (expectedVersion && expectedVersion !== version) throw new Error("FILE_CHANGED: restart pagination with the current file version.");
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, offset);
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("FILE_CHANGED: file changed during read.");
    const bytes = buffer.subarray(0, bytesRead);
    const nextOffset = offset + bytesRead;
    return { encoding: "base64", data: bytes.toString("base64"), textPreview: bytes.toString("utf8"), offset, nextOffset, totalBytes: Number(before.size), version, hasMore: BigInt(nextOffset) < before.size };
  } finally { await handle.close(); }
}

export function registerInspectionTools(server: McpServer, workspaces: WorkspaceRegistry, stateDir: string): void {
  const pages = new InspectionPages(join(stateDir, "inspection-pages"));
  server.registerTool("inspect_files", {
    description: "Complete paginated directory, filename, or content search. Results use a stable disk snapshot. Reuse nextCursor while hasMore; running means scanning is not finished. includeIgnored includes ignored files. Use read_page to retrieve long source lines.",
    inputSchema: {
      workspaceId: z.string(), operation: z.enum(["grep", "glob", "ls"]).default("ls"),
      path: z.string().optional(), pattern: z.string().optional(), include: z.string().optional(),
      includeIgnored: z.boolean().optional(), literal: z.boolean().optional(), ignoreCase: z.boolean().optional(),
      cursor: z.string().optional(), limit: z.number().int().positive().max(1000).default(100),
    }, annotations: { readOnlyHint: true },
  }, async ({ workspaceId, cursor, limit, ...query }) => {
    const workspace = workspaces.getWorkspace(workspaceId);
    const actualCursor = cursor ?? await pages.start(workspaceId, workspace.root, query, workspaces.resolvePath(workspace, query.path ?? "."));
    return reply(await pages.page(workspaceId, workspace.root, actualCursor, limit));
  });
  server.registerTool("read_page", {
    description: "Read exact bytes of any regular workspace file, including a huge single-line JSON or binary file. data is base64; textPreview is only a preview. Continue using nextOffset and version until hasMore=false. Reading establishes the file version required for a subsequent edit.",
    inputSchema: {
      workspaceId: z.string(), path: z.string(), offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().positive().max(24576).default(12288), version: z.string().optional(),
    }, annotations: { readOnlyHint: true },
  }, async ({ workspaceId, path, offset, limit, version }) => {
    const workspace = workspaces.getWorkspace(workspaceId);
    const readPath = workspaces.resolveReadPath(workspace, path);
    await physicalPath(workspace.root, readPath.absolutePath);
    const before = await workspaces.captureReadBaseline(workspace, readPath);
    const result = await readBytePage(readPath.absolutePath, offset, limit, version);
    await workspaces.markReadPathLoaded(workspace, readPath, before);
    return reply(result);
  });
}
