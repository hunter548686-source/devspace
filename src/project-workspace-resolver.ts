import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";
import type { WorkspaceSession } from "./workspace-store.js";

const execFileAsync = promisify(execFile);
const MAX_TASK_STATE_BYTES = 256 * 1024;

export type ProjectWorkspaceIntent = "resume" | "new" | "inspect";
export type ProjectWorkspaceResolutionStatus = "resolved" | "ambiguous" | "not_found";

interface ProjectRegistryEntry {
  project_id: string;
  name?: string;
  display_name?: string;
  canonical_path: string;
  status?: string;
}

interface ProjectRegistryDocument {
  projects?: ProjectRegistryEntry[];
}

interface ProjectAliasDocument {
  directoryAliases?: Array<{
    source_path?: string;
    target_project_id?: string | null;
  }>;
  activeCompatibilityLinks?: Array<{
    logical_path?: string;
    target_project_id?: string | null;
  }>;
}

interface GitWorktreeRecord {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
}

export interface ProjectWorkspaceCandidate {
  path: string;
  branch?: string;
  head?: string;
  detached?: boolean;
  canonical: boolean;
  lastUsedAt?: string;
  taskHintScore?: number;
}

export interface ResolveProjectWorkspaceInput {
  project: string;
  intent?: ProjectWorkspaceIntent;
  taskHint?: string;
}

export interface ResolveProjectWorkspaceContext {
  allowedRoots: string[];
  portfolioRoots?: string[];
  sessions?: WorkspaceSession[];
}

export interface ProjectWorkspaceResolution {
  status: ProjectWorkspaceResolutionStatus;
  projectId?: string;
  projectName?: string;
  canonicalPath?: string;
  selectedPath?: string;
  reason: string;
  intent: ProjectWorkspaceIntent;
  inheritedGitRoot?: string;
  candidates: ProjectWorkspaceCandidate[];
}

function normalizeLookup(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s._/\\-]+/g, "")
    .replace(/[()（）\[\]【】'"“”‘’]+/g, "");
}

function taskTokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function normalizeExistingAllowedPath(
  path: string,
  allowedRoots: string[],
): Promise<string | undefined> {
  try {
    return assertAllowedPath(path, allowedRoots);
  } catch {
    // Git may report the physical spelling of a path while the configured root
    // uses an OS compatibility symlink (for example /var -> /private/var on macOS).
    // Compare real paths only for already-existing paths, then map the result back
    // to the configured root spelling so persisted sessions and Git worktrees use
    // one stable path identity.
    try {
      const physicalPath = await realpath(path);
      for (const root of allowedRoots) {
        if (!(await exists(root))) continue;
        const logicalRoot = resolve(root);
        const physicalRoot = await realpath(root);
        if (!isPathInsideRoot(physicalPath, physicalRoot)) continue;
        const suffix = relative(physicalRoot, physicalPath);
        return resolve(logicalRoot, suffix);
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function findPortfolioDocuments(
  allowedRoots: string[],
  portfolioRoots: string[] = [],
): Promise<{
  registryPath: string;
  aliasPath?: string;
}> {
  const roots = Array.from(new Set([...portfolioRoots, ...allowedRoots]));
  for (const root of roots) {
    const registryPath = resolve(root, "portfolio", "PROJECT_REGISTRY.json");
    if (!(await exists(registryPath))) continue;
    const aliasPath = resolve(root, "portfolio", "PROJECT_ALIASES.json");
    return {
      registryPath,
      aliasPath: (await exists(aliasPath)) ? aliasPath : undefined,
    };
  }

  throw new Error(
    "No portfolio/PROJECT_REGISTRY.json was found under the configured portfolio or allowed roots.",
  );
}

function aliasNamesByProject(document: ProjectAliasDocument | undefined): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const add = (projectId: string | null | undefined, path: string | undefined): void => {
    if (!projectId || !path) return;
    const names = result.get(projectId) ?? new Set<string>();
    names.add(path);
    names.add(basename(path));
    result.set(projectId, names);
  };

  for (const item of document?.directoryAliases ?? []) {
    add(item.target_project_id, item.source_path);
  }
  for (const item of document?.activeCompatibilityLinks ?? []) {
    add(item.target_project_id, item.logical_path);
  }
  return result;
}

function resolveProjectEntry(
  query: string,
  projects: ProjectRegistryEntry[],
  aliases: Map<string, Set<string>>,
): ProjectRegistryEntry | undefined {
  const normalizedQuery = normalizeLookup(query);
  if (!normalizedQuery) return undefined;

  const exactMatches = projects.filter((project) => {
    const names = new Set<string>([
      project.project_id,
      project.name ?? "",
      project.display_name ?? "",
      basename(project.canonical_path),
      ...(aliases.get(project.project_id) ?? []),
    ]);
    return Array.from(names).some((name) => normalizeLookup(name) === normalizedQuery);
  });
  if (exactMatches.length === 1) return exactMatches[0];

  // Project routing is an identity boundary. Never guess from substring or
  // fuzzy matches: a wrong positive would open and potentially modify another
  // project's physical workspace. Ambiguous and unknown inputs fail closed.
  return undefined;
}

async function gitOutput(path: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", path, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function gitIdentity(path: string): Promise<{
  topLevel?: string;
  commonDir?: string;
}> {
  const topLevel = await gitOutput(path, ["rev-parse", "--show-toplevel"]);
  const commonDirRaw = await gitOutput(path, ["rev-parse", "--git-common-dir"]);
  if (!topLevel || !commonDirRaw) return {};

  const commonDir = isAbsolute(commonDirRaw)
    ? resolve(commonDirRaw)
    : resolve(path, commonDirRaw);
  return {
    topLevel: resolve(topLevel),
    commonDir: resolve(commonDir),
  };
}

function parseWorktreeList(output: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = [];
  let current: GitWorktreeRecord | undefined;

  const flush = (): void => {
    if (current) records.push(current);
    current = undefined;
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length),
        detached: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) current.branch = line.slice("branch refs/heads/".length);
    else if (line === "detached") current.detached = true;
  }
  flush();
  return records;
}

async function listProjectWorktrees(
  canonicalPath: string,
  allowedRoots: string[],
): Promise<{ records: GitWorktreeRecord[]; inheritedGitRoot?: string; commonDir?: string }> {
  const identity = await gitIdentity(canonicalPath);
  if (!identity.topLevel || !identity.commonDir) {
    return { records: [{ path: canonicalPath, detached: false }] };
  }

  const realCanonical = await realpath(canonicalPath);
  const realTopLevel = await realpath(identity.topLevel);
  if (realCanonical !== realTopLevel) {
    return {
      records: [{ path: canonicalPath, detached: false }],
      inheritedGitRoot: identity.topLevel,
      commonDir: identity.commonDir,
    };
  }

  const output = await gitOutput(canonicalPath, ["worktree", "list", "--porcelain"]);
  if (!output) {
    return {
      records: [{ path: canonicalPath, detached: false }],
      commonDir: identity.commonDir,
    };
  }

  const records: GitWorktreeRecord[] = [];
  for (const record of parseWorktreeList(output)) {
    const normalizedPath = await normalizeExistingAllowedPath(record.path, allowedRoots);
    if (normalizedPath) {
      records.push({ ...record, path: normalizedPath });
    }
  }

  return {
    records: records.length > 0 ? records : [{ path: canonicalPath, detached: false }],
    commonDir: identity.commonDir,
  };
}

async function taskStateSearchText(path: string): Promise<string> {
  const taskStatePath = resolve(path, ".agent", "TASK_STATE.json");
  if (!(await exists(taskStatePath))) return "";
  try {
    const content = await readFile(taskStatePath, "utf8");
    return content.length > MAX_TASK_STATE_BYTES ? content.slice(0, MAX_TASK_STATE_BYTES) : content;
  } catch {
    return "";
  }
}

function scoreTaskHint(hint: string, candidate: ProjectWorkspaceCandidate, taskState: string): number {
  const normalizedHint = normalizeLookup(hint);
  if (!normalizedHint) return 0;
  const branch = candidate.branch ?? "";
  const combined = `${candidate.path}\n${branch}\n${taskState}`;
  const normalizedCombined = normalizeLookup(combined);
  if (normalizedCombined.includes(normalizedHint)) return 100;

  const tokens = taskTokens(hint);
  if (tokens.length === 0) return 0;
  const loweredCombined = combined.normalize("NFKC").toLocaleLowerCase();
  const matched = tokens.filter((token) => loweredCombined.includes(token)).length;
  if (matched === tokens.length) return 50 + matched;
  if (matched >= 2 && matched / tokens.length >= 0.75) return 20 + matched;
  return 0;
}

async function sameExistingPath(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return resolve(left) === resolve(right);
  }
}

async function sessionBelongsToProject(
  session: WorkspaceSession,
  canonicalPath: string,
  projectCommonDir: string | undefined,
  inheritedGitRoot: string | undefined,
): Promise<boolean> {
  const root = resolve(session.root);
  if (await sameExistingPath(root, canonicalPath)) return true;

  if (inheritedGitRoot) {
    return isPathInsideRoot(root, canonicalPath);
  }

  if (projectCommonDir) {
    const identity = await gitIdentity(root);
    return Boolean(identity.commonDir && (await sameExistingPath(identity.commonDir, projectCommonDir)));
  }

  return isPathInsideRoot(root, canonicalPath);
}

function attachSessionRecency(
  candidates: ProjectWorkspaceCandidate[],
  sessions: WorkspaceSession[],
): ProjectWorkspaceCandidate[] {
  const latestByRoot = new Map<string, string>();
  for (const session of sessions) {
    const root = resolve(session.root);
    const prior = latestByRoot.get(root);
    if (!prior || session.lastUsedAt > prior) latestByRoot.set(root, session.lastUsedAt);
  }
  return candidates.map((candidate) => ({
    ...candidate,
    lastUsedAt: latestByRoot.get(resolve(candidate.path)),
  }));
}

export async function resolveProjectWorkspace(
  input: ResolveProjectWorkspaceInput,
  context: ResolveProjectWorkspaceContext,
): Promise<ProjectWorkspaceResolution> {
  const intent = input.intent ?? "resume";
  const { registryPath, aliasPath } = await findPortfolioDocuments(
    context.allowedRoots,
    context.portfolioRoots,
  );
  const registry = await readJson<ProjectRegistryDocument>(registryPath);
  const aliasDocument = aliasPath ? await readJson<ProjectAliasDocument>(aliasPath) : undefined;
  const projects = registry.projects ?? [];
  const aliases = aliasNamesByProject(aliasDocument);
  const project = resolveProjectEntry(input.project, projects, aliases);

  if (!project) {
    return {
      status: "not_found",
      reason: `Project query could not be resolved uniquely: ${input.project}`,
      intent,
      candidates: [],
    };
  }

  let canonicalPath: string;
  try {
    canonicalPath = assertAllowedPath(project.canonical_path, context.allowedRoots);
  } catch {
    return {
      status: "not_found",
      projectId: project.project_id,
      projectName: project.display_name ?? project.name ?? project.project_id,
      canonicalPath: project.canonical_path,
      reason: "The registered canonical path is outside the configured DevSpace allowed roots.",
      intent,
      candidates: [],
    };
  }
  if (!(await exists(canonicalPath))) {
    return {
      status: "not_found",
      projectId: project.project_id,
      projectName: project.display_name ?? project.name ?? project.project_id,
      canonicalPath,
      reason: "The registered canonical path does not currently exist.",
      intent,
      candidates: [],
    };
  }

  if (intent === "new") {
    return {
      status: "resolved",
      projectId: project.project_id,
      projectName: project.display_name ?? project.name ?? project.project_id,
      canonicalPath,
      selectedPath: canonicalPath,
      reason: "NEW_TASK_CANONICAL_DEFAULT",
      intent,
      candidates: [{ path: canonicalPath, canonical: true }],
    };
  }

  const worktreeInfo = await listProjectWorktrees(canonicalPath, context.allowedRoots);
  const baseCandidates: ProjectWorkspaceCandidate[] = await Promise.all(
    worktreeInfo.records.map(async (record) => ({
      path: resolve(record.path),
      branch: record.branch,
      head: record.head,
      detached: record.detached,
      canonical: await sameExistingPath(record.path, canonicalPath),
    })),
  );

  const projectSessions: WorkspaceSession[] = [];
  for (const session of context.sessions ?? []) {
    if (
      await sessionBelongsToProject(
        session,
        canonicalPath,
        worktreeInfo.commonDir,
        worktreeInfo.inheritedGitRoot,
      )
    ) {
      projectSessions.push(session);
    }
  }

  let candidates = attachSessionRecency(baseCandidates, projectSessions);

  if (input.taskHint?.trim()) {
    const scored = await Promise.all(
      candidates.map(async (candidate) => {
        if (!candidate.canonical) return { ...candidate, taskHintScore: 0 };
        return {
          ...candidate,
          taskHintScore: scoreTaskHint(
            input.taskHint ?? "",
            candidate,
            await taskStateSearchText(canonicalPath),
          ),
        };
      }),
    );
    const positive = scored.filter(
      (candidate) => candidate.canonical && (candidate.taskHintScore ?? 0) > 0,
    );
    const highest = Math.max(0, ...positive.map((candidate) => candidate.taskHintScore ?? 0));
    const winners = positive.filter((candidate) => candidate.taskHintScore === highest);
    candidates = scored.sort(
      (a, b) =>
        (b.taskHintScore ?? 0) - (a.taskHintScore ?? 0) ||
        (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""),
    );

    if (highest >= 50 && winners.length === 1) {
      return {
        status: "resolved",
        projectId: project.project_id,
        projectName: project.display_name ?? project.name ?? project.project_id,
        canonicalPath,
        selectedPath: canonicalPath,
        reason: "CANONICAL_TASK_HINT_UNIQUE_MATCH",
        intent,
        inheritedGitRoot: worktreeInfo.inheritedGitRoot,
        candidates,
      };
    }

    return {
      status: positive.length === 0 ? "not_found" : "ambiguous",
      projectId: project.project_id,
      projectName: project.display_name ?? project.name ?? project.project_id,
      canonicalPath,
      reason:
        positive.length === 0
          ? "The supplied task hint did not match the registered canonical exact directory. Non-canonical worktrees are never eligible for automatic selection."
          : "The canonical task hint was ambiguous. Refusing to guess.",
      intent,
      inheritedGitRoot: worktreeInfo.inheritedGitRoot,
      candidates,
    };
  }

  const canonicalSessions: WorkspaceSession[] = [];
  for (const session of projectSessions) {
    if (await sameExistingPath(session.root, canonicalPath)) canonicalSessions.push(session);
  }

  if (canonicalSessions.length > 0) {
    return {
      status: "resolved",
      projectId: project.project_id,
      projectName: project.display_name ?? project.name ?? project.project_id,
      canonicalPath,
      selectedPath: canonicalPath,
      reason: "CANONICAL_DEVSPACE_SESSION",
      intent,
      inheritedGitRoot: worktreeInfo.inheritedGitRoot,
      candidates,
    };
  }

  if (projectSessions.length > 0) {
    return {
      status: "ambiguous",
      projectId: project.project_id,
      projectName: project.display_name ?? project.name ?? project.project_id,
      canonicalPath,
      reason: "Only non-canonical worktree sessions were found. Automatic selection is refused; open the registered canonical exact directory explicitly.",
      intent,
      inheritedGitRoot: worktreeInfo.inheritedGitRoot,
      candidates,
    };
  }

  const canonicalCandidates = candidates.filter((candidate) => candidate.canonical);
  if (candidates.length === 1 && canonicalCandidates.length === 1) {
    return {
      status: "resolved",
      projectId: project.project_id,
      projectName: project.display_name ?? project.name ?? project.project_id,
      canonicalPath,
      selectedPath: canonicalPath,
      reason: "ONLY_CANONICAL_WORKSPACE_EXISTS",
      intent,
      inheritedGitRoot: worktreeInfo.inheritedGitRoot,
      candidates,
    };
  }

  return {
    status: "ambiguous",
    projectId: project.project_id,
    projectName: project.display_name ?? project.name ?? project.project_id,
    canonicalPath,
    reason: canonicalCandidates.length === 0
      ? "The registered canonical exact directory was not present in the workspace candidates. Refusing to select a worktree."
      : "Non-canonical worktrees exist and there is no canonical task binding. Refusing to select any worktree automatically.",
    intent,
    inheritedGitRoot: worktreeInfo.inheritedGitRoot,
    candidates,
  };
}
