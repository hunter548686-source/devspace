import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import type {
  WorkspaceConversationBinding,
  WorkspaceMode,
  WorkspaceSession,
  WorkspaceStore,
} from "./workspace-store.js";
import { lstat, opendir, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import {
  AccessDeniedError,
  assertAllowedPath,
  isPathInsideRoot,
  resolveAllowedPath,
} from "./roots.js";
import {
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  type LoadedSkills,
  type SkillReadResolution,
} from "./skills.js";

const execFileAsync = promisify(execFile);

export interface LoadedAgentsFile {
  path: string;
  content: string;
}

export interface AvailableAgentsFile {
  path: string;
}

export interface WorkspaceWorktree {
  path: string;
  baseRef: string;
  baseSha: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface Workspace {
  id: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
  activatedSkillDirs: Set<string>;
  mutationFingerprint?: string;
}

export interface WorkspaceContext {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
  workspaceReused: boolean;
  includeBootstrapContext: boolean;
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
}

export interface OpenWorkspaceOptions {
  conversationScopeId?: string;
}

export interface WorkspaceMutationSession {
  complete(): Promise<void>;
  fail(): Promise<void>;
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly pendingCheckoutOpens = new Map<string, Promise<WorkspaceContext>>();
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly exclusiveMutationReservations = new Map<
    string,
    { token: symbol; operation: string }
  >();

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {}

  async openWorkspace(
    input: string | OpenWorkspaceInput,
    openOptions: OpenWorkspaceOptions = {},
  ): Promise<WorkspaceContext> {
    const workspaceInput = typeof input === "string" ? { path: input } : input;
    if (workspaceInput.mode === "worktree") {
      throw new Error(
        "Managed worktree mode is disabled. Open the exact existing project directory in checkout mode so DevSpace and the coding environment use the same physical workspace.",
      );
    }
    const conversationScopeId = openOptions.conversationScopeId;
    if (!conversationScopeId || !this.store) {
      return this.openNewWorkspace(workspaceInput);
    }

    const projectKey = await this.conversationProjectKey(workspaceInput);
    const targetKey = this.conversationCheckoutTargetKey(projectKey);
    const operationKey = JSON.stringify([conversationScopeId, targetKey]);
    const pending = this.pendingCheckoutOpens.get(operationKey);
    if (pending) {
      const context = await pending;
      return {
        ...context,
        workspaceReused: true,
        includeBootstrapContext: false,
      };
    }

    const open = this.openConversationCheckout(
      workspaceInput,
      conversationScopeId,
      targetKey,
    );
    this.pendingCheckoutOpens.set(operationKey, open);

    try {
      return await open;
    } finally {
      if (this.pendingCheckoutOpens.get(operationKey) === open) {
        this.pendingCheckoutOpens.delete(operationKey);
      }
    }
  }

  private async openNewWorkspace(options: OpenWorkspaceInput): Promise<WorkspaceContext> {
    if (options.mode === "worktree") {
      throw new Error(
        "Managed worktree mode is disabled. Open the exact existing project directory in checkout mode.",
      );
    }

    return this.openCheckoutWorkspace(options.path);
  }

  private async openConversationCheckout(
    input: OpenWorkspaceInput,
    conversationScopeId: string,
    targetKey: string,
  ): Promise<WorkspaceContext> {
    const binding = this.store?.getConversationBinding(conversationScopeId, targetKey);
    if (binding) {
      const reusableWorkspace = await this.findReusableCheckoutWorkspace(binding);

      if (reusableWorkspace) {
        const context = await this.reusedWorkspaceContext(reusableWorkspace);
        this.store?.touchConversationBinding(conversationScopeId, targetKey);
        return {
          ...context,
          includeBootstrapContext: false,
        };
      }
    }

    // Preserve a stale binding until the replacement checkout has been opened
    // successfully. A typo, deletion, or transient filesystem failure must not
    // discard the last known workspace identity.
    const context = await this.openCheckoutWorkspace(input.path);
    if (binding) {
      this.workspaces.delete(binding.workspaceSessionId);
    }
    this.store?.setConversationBinding({
      conversationScopeId,
      targetKey,
      workspaceSessionId: context.workspace.id,
    });
    return {
      ...context,
      includeBootstrapContext: true,
    };
  }

  private async findReusableCheckoutWorkspace(
    binding: WorkspaceConversationBinding,
  ): Promise<Workspace | undefined> {
    const session = this.store?.getSession(binding.workspaceSessionId);
    if (!session || session.status !== "active" || session.mode !== "checkout") {
      return undefined;
    }

    let root: string;
    try {
      root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
      const rootStats = await stat(root);
      if (!rootStats.isDirectory()) return undefined;
    } catch (error) {
      if (
        error instanceof AccessDeniedError ||
        (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      ) {
        return undefined;
      }

      throw error;
    }

    const workspace = this.getWorkspace(binding.workspaceSessionId);
    if (workspace.mode !== "checkout" || workspace.root !== root) return undefined;
    return workspace;
  }

  private async conversationProjectKey(input: OpenWorkspaceInput): Promise<string> {
    const path = assertAllowedPath(input.path, this.config.allowedRoots, this.config.blockedRoots);
    return canonicalPath(path);
  }

  private conversationCheckoutTargetKey(projectKey: string): string {
    return JSON.stringify(["checkout", projectKey, null]);
  }

  private async reusedWorkspaceContext(workspace: Workspace): Promise<WorkspaceContext> {
    workspace.mutationFingerprint = await workspaceMutationFingerprint(workspace.root);
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      workspaceReused: true,
      includeBootstrapContext: true,
    };
  }

  listStoredSessions(limit = 200): WorkspaceSession[] {
    return this.store?.listSessions(limit) ?? [];
  }

  async runMutation<T>(
    workspace: Workspace,
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const session = await this.acquireMutationSession(workspace, operation, false);
    let result: T;
    try {
      result = await action();
    } catch (error) {
      await session.fail();
      throw error;
    }
    await session.complete();
    return result;
  }

  async beginLongRunningMutation(
    workspace: Workspace,
    operation: string,
  ): Promise<WorkspaceMutationSession> {
    return this.acquireMutationSession(workspace, operation, true);
  }

  private async acquireMutationSession(
    workspace: Workspace,
    operation: string,
    exclusive: boolean,
  ): Promise<WorkspaceMutationSession> {
    const queueKey = await canonicalPath(workspace.root);
    const activeExclusive = this.exclusiveMutationReservations.get(queueKey);
    if (activeExclusive) {
      throw new Error(
        `WORKSPACE_MUTATION_IN_PROGRESS: ${operation} cannot run while ${activeExclusive.operation} owns the physical workspace. Poll or finish the running process before retrying.`,
      );
    }

    const reservationToken = exclusive ? Symbol(operation) : undefined;
    if (reservationToken) {
      this.exclusiveMutationReservations.set(queueKey, {
        token: reservationToken,
        operation,
      });
    }
    const previous = this.mutationQueues.get(queueKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.mutationQueues.set(queueKey, queued);

    let released = false;
    const releaseSession = (): void => {
      if (released) return;
      released = true;
      release();
      if (this.mutationQueues.get(queueKey) === queued) {
        this.mutationQueues.delete(queueKey);
      }
      const currentReservation = this.exclusiveMutationReservations.get(queueKey);
      if (reservationToken && currentReservation?.token === reservationToken) {
        this.exclusiveMutationReservations.delete(queueKey);
      }
    };

    await previous.catch(() => undefined);
    let currentFingerprint: string;
    try {
      if (!workspace.mutationFingerprint) {
        throw new Error(
          `WORKSPACE_REFRESH_REQUIRED: ${operation} cannot run because the workspace baseline is unavailable. Reopen the exact same workspace, reread the affected files, and retry.`,
        );
      }

      currentFingerprint = await workspaceMutationFingerprint(workspace.root);
      if (currentFingerprint !== workspace.mutationFingerprint) {
        throw new Error(
          `WORKSPACE_CHANGED_EXTERNALLY: ${operation} was blocked because this physical workspace changed after it was opened. Reopen the exact same workspace, inspect the new state, and retry instead of overwriting another session's work.`,
        );
      }
    } catch (error) {
      releaseSession();
      throw error;
    }

    let finalization: Promise<void> | undefined;
    const settle = (completed: boolean): Promise<void> => {
      finalization ??= (async () => {
        try {
          const finalFingerprint = await workspaceMutationFingerprint(workspace.root);
          workspace.mutationFingerprint = completed || finalFingerprint === currentFingerprint
            ? finalFingerprint
            : undefined;
        } catch (error) {
          workspace.mutationFingerprint = undefined;
          if (completed) throw error;
        } finally {
          releaseSession();
        }
      })();
      return finalization;
    };

    return {
      complete: () => settle(true),
      fail: () => settle(false),
    };
  }

  getWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      this.store?.touchSession(workspaceId);
      return workspace;
    }

    const session = this.store?.getSession(workspaceId);
    if (!session) {
      throw new Error(
        `Unknown or expired workspaceId: ${workspaceId}. Call open_workspace once with the exact existing checkout directory, then reuse the returned workspaceId.`,
      );
    }
    if (session.mode === "worktree") {
      throw new Error(
        "This workspaceId belongs to a retired managed worktree. Open the exact existing project directory with open_workspace instead.",
      );
    }

    const root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
    const restoredWorkspace: Workspace = {
      id: session.id,
      root,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      worktree: undefined,
      ...this.loadSkillsForWorkspace(root),
      activatedSkillDirs: new Set(),
      mutationFingerprint: undefined,
    };
    this.store?.touchSession(workspaceId);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);

    return restoredWorkspace;
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }

    return absolutePath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    try {
      return {
        absolutePath: this.resolvePath(workspace, inputPath),
        readRoots: [workspace.root],
      };
    } catch (workspaceError) {
      const skillRead = resolveSkillReadPath(
        workspace.skills,
        workspace.activatedSkillDirs,
        inputPath,
      );
      if (!skillRead) throw workspaceError;

      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
    }
  }

  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath): void {
    if (readPath.skillRead?.isSkillFile) {
      markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
    }
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
    return assertAllowedPath(directory, [workspace.root]);
  }

  private async openCheckoutWorkspace(path: string): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots, this.config.blockedRoots);
    let rootStats;
    try {
      rootStats = await stat(root);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        throw new Error(
          `Workspace directory does not exist: ${path}. Open the exact existing checkout directory; DevSpace will not create a directory or managed worktree.`,
          { cause: error },
        );
      }
      throw error;
    }

    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${path}`);
    }

    return this.createWorkspaceContext({ root, mode: "checkout" });
  }

  private async createWorkspaceContext(input: {
    root: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
  }): Promise<WorkspaceContext> {
    const workspace: Workspace = {
      id: `ws_${randomBytes(5).toString("hex")}`,
      root: input.root,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...this.loadSkillsForWorkspace(input.root),
      activatedSkillDirs: new Set(),
      mutationFingerprint: await workspaceMutationFingerprint(input.root),
    };

    this.store?.createSession({
      id: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      baseRef: workspace.worktree?.baseRef,
      baseSha: workspace.worktree?.baseSha,
      managed: workspace.worktree?.managed,
    });
    this.workspaces.set(workspace.id, workspace);
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      workspaceReused: false,
      includeBootstrapContext: true,
    };
  }

  private loadSkillsForWorkspace(root: string): Pick<Workspace, "skills" | "skillDiagnostics"> {
    const result = loadWorkspaceSkills(this.config, root);
    return {
      skills: result.skills,
      skillDiagnostics: result.diagnostics,
    };
  }

  private assertWorkspaceRootAllowed(root: string, mode: WorkspaceMode, sourceRoot: string | undefined): string {
    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
      }
      assertAllowedPath(sourceRoot, this.config.allowedRoots, this.config.blockedRoots);
      return assertAllowedPath(root, [this.config.worktreeRoot]);
    }

    return assertAllowedPath(root, this.config.allowedRoots, this.config.blockedRoots);
  }

  private async loadInitialAgentsFiles(root: string): Promise<LoadedAgentsFile[]> {
    const agentDir = resolve(this.config.agentDir);
    const resolvedRoot = (await tryRealpath(root)) ?? root;
    const resolvedAgentDir = (await tryRealpath(agentDir)) ?? agentDir;
    const loadedFiles: LoadedAgentsFile[] = [];

    for (const file of loadProjectContextFiles({ cwd: root, agentDir })) {
      const path = resolve(file.path);
      if (!isInitialAgentsFilePath(path, root, agentDir)) continue;
      const content = await readResolvedContextFile(
        path,
        file.content,
        resolvedRoot,
        resolvedAgentDir,
      );
      if (content === undefined) continue;

      loadedFiles.push({
        path,
        content,
      });
    }

    return loadedFiles;
  }

  private async findAvailableAgentsFiles(
    root: string,
    loadedFiles: LoadedAgentsFile[],
  ): Promise<AvailableAgentsFile[]> {
    const loadedPaths = new Set(loadedFiles.map((file) => resolve(file.path)));
    const loadedRealPaths = new Set<string>();
    for (const file of loadedFiles) {
      const realPath = await tryRealpath(file.path);
      if (realPath) loadedRealPaths.add(realPath);
    }
    const discovered: AvailableAgentsFile[] = [];

    await walkWorkspace(root, async (path, entry) => {
      if (!entry.isFile()) return;
      if (!CONTEXT_FILE_NAMES.has(entry.name)) return;
      if (loadedPaths.has(path)) return;
      const realPath = await tryRealpath(path);
      if (realPath && loadedRealPaths.has(realPath)) return;

      discovered.push({ path });
    });

    return discovered.sort((a, b) => a.path.localeCompare(b.path));
  }
}

async function workspaceMutationFingerprint(root: string): Promise<string> {
  const physicalRoot = (await tryRealpath(root)) ?? resolve(root);
  const gitRootOutput = await gitOutput(root, ["rev-parse", "--show-toplevel"]);

  if (gitRootOutput !== undefined) {
    const gitRoot = gitRootOutput.trim();
    const head = ((await gitOutput(root, ["rev-parse", "--verify", "HEAD^{commit}"])) ?? "UNBORN").trim();
    const branch = ((await gitOutput(root, ["symbolic-ref", "--quiet", "HEAD"])) ?? "DETACHED").trim();
    const status = (await gitOutput(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ".",
    ])) ?? "GIT_STATUS_UNAVAILABLE";
    const stagedState = head === "UNBORN"
      ? (await gitOutput(root, ["ls-files", "--stage", "-z", "--", "."])) ?? "GIT_INDEX_UNAVAILABLE"
      : (await gitOutput(root, ["diff", "--cached", "--raw", "-z", "HEAD", "--", "."]))
        ?? "GIT_INDEX_UNAVAILABLE";
    const changedPaths = await gitChangedPaths(root, head);
    const changedPathState = await Promise.all(
      changedPaths.map((path) => workspacePathState(root, path)),
    );

    return createHash("sha256")
      .update([
        "git",
        physicalRoot,
        gitRoot,
        head,
        branch,
        status,
        stagedState,
        ...changedPathState,
      ].join("\0"))
      .digest("hex");
  }

  return filesystemTreeFingerprint(physicalRoot);
}

async function filesystemTreeFingerprint(root: string): Promise<string> {
  const fingerprint = createHash("sha256");
  fingerprint.update(`filesystem\0${root}\0`);

  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_FINGERPRINT_DIRS.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const relativePath = relativeDirectory
        ? join(relativeDirectory, entry.name)
        : entry.name;
      const before = await lstat(path, { bigint: true });
      const type = before.isFile()
        ? "file"
        : before.isDirectory()
          ? "directory"
          : before.isSymbolicLink()
            ? "symlink"
            : "other";
      fingerprint.update([
        relativePath,
        type,
        String(before.mode),
        String(before.size),
      ].join("\0"));
      fingerprint.update("\0");

      if (before.isSymbolicLink()) {
        fingerprint.update(await readlink(path));
        fingerprint.update("\0");
        continue;
      }
      if (before.isDirectory()) {
        await walk(path, relativePath);
        continue;
      }
      if (!before.isFile()) continue;

      const content = createHash("sha256");
      for await (const chunk of createReadStream(path)) content.update(chunk as Buffer);
      const after = await lstat(path, { bigint: true });
      if (
        !after.isFile()
        || after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs
        || after.ctimeNs !== before.ctimeNs
      ) {
        throw new Error(`WORKSPACE_FINGERPRINT_UNSTABLE: ${relativePath} changed while it was being inspected.`);
      }
      fingerprint.update(content.digest());
      fingerprint.update("\0");
    }
  };

  await walk(root, "");
  return fingerprint.digest("hex");
}

async function gitChangedPaths(root: string, head: string): Promise<string[]> {
  const trackedOutput = head === "UNBORN"
    ? await gitOutput(root, ["ls-files", "-m", "-d", "-z", "--", "."])
    : await gitOutput(root, ["diff", "--name-only", "--relative", "-z", "HEAD", "--", "."]);
  const untrackedOutput = await gitOutput(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ".",
  ]);

  return Array.from(new Set([
    ...nulSeparatedPaths(trackedOutput),
    ...nulSeparatedPaths(untrackedOutput),
  ])).sort((left, right) => left.localeCompare(right));
}

function nulSeparatedPaths(output: string | undefined): string[] {
  return output?.split("\0").filter(Boolean) ?? [];
}

async function workspacePathState(root: string, path: string): Promise<string> {
  const absolutePath = resolve(root, path);
  if (!isPathInsideRoot(absolutePath, root)) return `${path}\0OUTSIDE_ROOT`;

  try {
    const pathStats = await lstat(absolutePath, { bigint: true });
    const type = pathStats.isFile()
      ? "file"
      : pathStats.isDirectory()
        ? "directory"
        : pathStats.isSymbolicLink()
          ? "symlink"
          : "other";
    let contentIdentity = "";
    if (pathStats.isSymbolicLink()) {
      contentIdentity = await readlink(absolutePath);
    } else if (pathStats.isFile() && pathStats.size <= BigInt(1024 * 1024)) {
      contentIdentity = createHash("sha256")
        .update(await readFile(absolutePath))
        .digest("hex");
    }

    return [
      path,
      type,
      String(pathStats.mode),
      String(pathStats.size),
      String(pathStats.mtimeNs),
      String(pathStats.ctimeNs),
      contentIdentity,
    ].join("\0");
  } catch (error) {
    if (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return `${path}\0MISSING`;
    }
    throw error;
  }
}

async function gitOutput(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

async function canonicalPath(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let candidate = path;

  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments.slice().reverse());
    } catch (error) {
      if (!isErrnoException(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        throw error;
      }

      const parent = dirname(candidate);
      if (parent === candidate) return path;
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const SKIPPED_CONTEXT_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".devspace",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);
const SKIPPED_FINGERPRINT_DIRS = new Set([
  ...SKIPPED_CONTEXT_DIRS,
  ".playwright-cli",
  "coverage",
]);

export function formatAgentsPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return path.split(sep).join("/");

  const relationship = relative(workspaceRoot, path);
  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    relationship === ".." ||
    relationship.includes(`..${sep}`)
  ) {
    return path.split(sep).join("/");
  }

  return relationship.split(sep).join("/");
}

function isInitialAgentsFilePath(path: string, root: string, agentDir: string): boolean {
  if (isPathInsideRoot(path, agentDir)) return true;
  return isPathInsideRoot(path, root) && dirname(path) === root;
}

async function readResolvedContextFile(
  path: string,
  fallbackContent: string,
  root: string,
  agentDir: string,
): Promise<string | undefined> {
  try {
    const resolvedPath = await realpath(path);
    if (!isInitialAgentsFilePath(resolvedPath, root, agentDir)) return undefined;
    return await readFile(resolvedPath, "utf8");
  } catch {
    return fallbackContent;
  }
}

async function tryRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function walkWorkspace(
  directory: string,
  visit: (path: string, entry: { name: string; isFile(): boolean; isDirectory(): boolean }) => Promise<void> | void,
): Promise<void> {
  let entries;
  try {
    entries = await opendir(directory);
  } catch {
    return;
  }

  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_CONTEXT_DIRS.has(entry.name)) {
        await walkWorkspace(path, visit);
      }
      continue;
    }

    await visit(path, entry);
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
