import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveProjectWorkspace } from "./project-workspace-resolver.js";
import type { WorkspaceSession } from "./workspace-store.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-project-resolver-"));
const portfolioRoot = join(root, "New project");
const worktreeRoot = join(root, ".devspace", "worktrees");
const canonical = join(portfolioRoot, "AI Business OS 工作台");
const recovery = join(worktreeRoot, "AI-Business-OS-recovery");
const hardening = join(worktreeRoot, "AI-Business-OS-hardening");

try {
  await mkdir(join(portfolioRoot, "portfolio"), { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await mkdir(canonical, { recursive: true });
  await writeFile(join(canonical, "README.md"), "fixture\n", "utf8");
  await git(canonical, ["init"]);
  await git(canonical, ["config", "user.email", "devspace@example.com"]);
  await git(canonical, ["config", "user.name", "DevSpace Test"]);
  await git(canonical, ["add", "README.md"]);
  await git(canonical, ["commit", "-m", "fixture"]);

  await git(canonical, ["worktree", "add", "-b", "codex/aibos-recovery", recovery, "HEAD"]);
  await git(canonical, ["worktree", "add", "-b", "codex/aibos-hardening", hardening, "HEAD"]);
  await mkdir(join(canonical, ".agent"), { recursive: true });
  await mkdir(join(recovery, ".agent"), { recursive: true });
  await mkdir(join(hardening, ".agent"), { recursive: true });
  await writeFile(
    join(canonical, ".agent", "TASK_STATE.json"),
    JSON.stringify({ task_id: "AIBOS-CANONICAL-01", objective: "unified canonical workspace" }),
    "utf8",
  );
  await writeFile(
    join(recovery, ".agent", "TASK_STATE.json"),
    JSON.stringify({ task_id: "AIBOS-RECOVERY-01", status: "ACTIVE" }),
    "utf8",
  );
  await writeFile(
    join(hardening, ".agent", "TASK_STATE.json"),
    JSON.stringify({ task_id: "AIBOS-HARDENING-01", status: "ACTIVE" }),
    "utf8",
  );

  await writeFile(
    join(portfolioRoot, "portfolio", "PROJECT_REGISTRY.json"),
    JSON.stringify({
      projects: [
        {
          project_id: "aibos",
          name: "AI Business OS",
          display_name: "AI Business OS 工作台",
          canonical_path: canonical,
          status: "ACTIVE",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(portfolioRoot, "portfolio", "PROJECT_ALIASES.json"),
    JSON.stringify({
      directoryAliases: [
        {
          source_path: join(portfolioRoot, "AIBOS"),
          target_project_id: "aibos",
        },
        {
          source_path: join(portfolioRoot, "觉伴"),
          target_project_id: "aibos",
        },
      ],
    }),
    "utf8",
  );

  const allowedRoots = [portfolioRoot, worktreeRoot];

  const broadAllowedRootTask = await resolveProjectWorkspace(
    { project: "aibos", intent: "new" },
    { allowedRoots: [root], portfolioRoots: [portfolioRoot] },
  );
  assert.equal(broadAllowedRootTask.status, "resolved");
  assert.equal(broadAllowedRootTask.selectedPath, canonical);

  const newTask = await resolveProjectWorkspace(
    { project: "AIBOS", intent: "new" },
    { allowedRoots },
  );
  assert.equal(newTask.status, "resolved");
  assert.equal(newTask.selectedPath, canonical);
  assert.equal(newTask.reason, "NEW_TASK_CANONICAL_DEFAULT");

  const aliasTask = await resolveProjectWorkspace(
    { project: "觉伴", intent: "new" },
    { allowedRoots },
  );
  assert.equal(aliasTask.status, "resolved");
  assert.equal(aliasTask.projectId, "aibos");

  const recoverySession = session("ws-recovery", recovery, "2026-08-15T00:00:00.000Z");
  const resumeSingleSession = await resolveProjectWorkspace(
    { project: "aibos", intent: "resume" },
    { allowedRoots, sessions: [recoverySession] },
  );
  assert.equal(resumeSingleSession.status, "ambiguous");
  assert.equal(resumeSingleSession.selectedPath, undefined);
  assert.match(resumeSingleSession.reason, /only non-canonical worktree sessions/i);

  const hardeningSession = session("ws-hardening", hardening, "2026-08-15T01:00:00.000Z");
  const ambiguousResume = await resolveProjectWorkspace(
    { project: "aibos", intent: "resume" },
    { allowedRoots, sessions: [recoverySession, hardeningSession] },
  );
  assert.equal(ambiguousResume.status, "ambiguous");
  assert.equal(ambiguousResume.selectedPath, undefined);
  assert.match(ambiguousResume.reason, /only non-canonical worktree sessions/i);

  const hintedResume = await resolveProjectWorkspace(
    { project: "AI Business OS", intent: "resume", taskHint: "recovery" },
    { allowedRoots, sessions: [recoverySession, hardeningSession] },
  );
  assert.equal(hintedResume.status, "not_found");
  assert.equal(hintedResume.selectedPath, undefined);
  assert.match(hintedResume.reason, /non-canonical worktrees are never eligible/i);

  const canonicalSession = session("ws-canonical", canonical, "2026-08-15T02:00:00.000Z");
  const canonicalResume = await resolveProjectWorkspace(
    { project: "aibos", intent: "resume" },
    { allowedRoots, sessions: [recoverySession, hardeningSession, canonicalSession] },
  );
  assert.equal(canonicalResume.status, "resolved");
  assert.equal(canonicalResume.selectedPath, canonical);
  assert.equal(canonicalResume.reason, "CANONICAL_DEVSPACE_SESSION");

  const canonicalHint = await resolveProjectWorkspace(
    { project: "aibos", intent: "resume", taskHint: "unified canonical workspace" },
    { allowedRoots, sessions: [recoverySession, hardeningSession] },
  );
  assert.equal(canonicalHint.status, "resolved");
  assert.equal(canonicalHint.selectedPath, canonical);
  assert.equal(canonicalHint.reason, "CANONICAL_TASK_HINT_UNIQUE_MATCH");

  const unknownHint = await resolveProjectWorkspace(
    { project: "aibos", intent: "resume", taskHint: "does-not-exist" },
    { allowedRoots, sessions: [recoverySession] },
  );
  assert.equal(unknownHint.status, "not_found");
  assert.equal(unknownHint.selectedPath, undefined);

  const noSessions = await resolveProjectWorkspace(
    { project: "aibos", intent: "resume" },
    { allowedRoots },
  );
  assert.equal(noSessions.status, "ambiguous");
  assert.equal(noSessions.selectedPath, undefined);
} finally {
  await rm(root, { recursive: true, force: true });
}

function session(id: string, workspaceRoot: string, lastUsedAt: string): WorkspaceSession {
  return {
    id,
    root: workspaceRoot,
    status: "active",
    mode: "checkout",
    managed: false,
    createdAt: lastUsedAt,
    lastUsedAt,
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
