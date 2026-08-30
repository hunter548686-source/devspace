import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isPathInsideRoot, resolveAllowedPath } from "./roots.js";

const MAX_CAPTURED_OUTPUT = 64 * 1024;
const MIN_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 900;
const DEFAULT_TIMEOUT_SECONDS = 300;

export interface SetupExternalRepositoryInput {
  repositoryUrl: string;
  destination: string;
  ref?: string;
  expectedCommit?: string;
  installDependencies?: boolean;
  allowInstallScripts?: boolean;
  timeoutSeconds?: number;
}

export interface SetupExternalRepositoryContext {
  cwd: string;
  root: string;
  projectRegistryPath: string;
  commandRunner?: ExternalRepositoryCommandRunner;
}

export interface SetupExternalRepositoryResult {
  repositoryUrl: string;
  destination: string;
  commit: string;
  dependenciesInstalled: boolean;
  installCommand?: string;
  installScriptsAllowed: boolean;
}

export interface PackageInstallPlan {
  command: string;
  args: string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

export type ExternalRepositoryCommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<CommandResult>;

interface ClaimedDestination {
  path: string;
  dev: number;
  ino: number;
}

interface ProjectRegistryDocument {
  projects?: Array<{
    canonical_path?: unknown;
    git_repository?: unknown;
  }>;
}

function appendCaptured(current: string, chunk: Buffer | string): string {
  const combined = current + chunk.toString();
  return combined.length <= MAX_CAPTURED_OUTPUT
    ? combined
    : combined.slice(combined.length - MAX_CAPTURED_OUTPUT);
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCaptured(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCaptured(stderr, chunk);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKillTimer.unref();
    }, options.timeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      rejectPromise(error);
    });

    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);

      if (code === 0 && !timedOut) {
        resolvePromise({ stdout, stderr });
        return;
      }

      const detail = stderr.trim() || stdout.trim() || "No command output.";
      const reason = timedOut
        ? `timed out after ${Math.round(options.timeoutMs / 1_000)} seconds`
        : `exited with code ${String(code)}${signal ? ` (${signal})` : ""}`;
      rejectPromise(new Error(`${command} ${reason}: ${detail}`));
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function normalizedTimeoutSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(value)) {
    throw new Error("timeoutSeconds must be a finite number.");
  }
  return Math.min(
    MAX_TIMEOUT_SECONDS,
    Math.max(MIN_TIMEOUT_SECONDS, Math.round(value)),
  );
}

export function normalizeGitHubRepositoryUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("repositoryUrl must be a valid HTTPS GitHub repository URL.");
  }

  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Only HTTPS github.com repository URLs are allowed.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Repository URLs must not contain credentials, query parameters, or fragments.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new Error("repositoryUrl must identify exactly one GitHub owner/repository pair.");
  }

  const owner = segments[0];
  const repository = segments[1].replace(/\.git$/i, "");
  const safeSegment = /^[A-Za-z0-9_.-]+$/;
  if (!safeSegment.test(owner) || !safeSegment.test(repository)) {
    throw new Error("repositoryUrl contains an unsupported owner or repository name.");
  }

  return `https://github.com/${owner}/${repository}.git`;
}

function normalizeRepositoryIdentity(input: string): string | undefined {
  const value = input.trim();
  const scpMatch = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(value);
  if (scpMatch) {
    return `github.com/${scpMatch[1]}/${scpMatch[2]}`.toLowerCase();
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.hostname.toLowerCase() !== "github.com") return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return undefined;
  return `github.com/${segments[0]}/${segments[1].replace(/\.git$/i, "")}`.toLowerCase();
}

async function requireProjectRegistryPath(
  context: SetupExternalRepositoryContext,
): Promise<string> {
  if (!context.projectRegistryPath?.trim()) {
    throw new Error(
      "SOURCE_AUTHORITY_REGISTRY_REQUIRED: setup_external_repository requires an explicit project registry authority.",
    );
  }
  const path = resolve(context.projectRegistryPath);
  if (!(await pathExists(path))) {
    throw new Error(`SOURCE_AUTHORITY_REGISTRY_MISSING: configured project registry does not exist: ${path}`);
  }
  return path;
}

async function canonicalRepositoryIdentity(
  canonicalPath: string,
): Promise<string | undefined> {
  try {
    const result = await runCommand(
      "git",
      ["-C", canonicalPath, "remote", "get-url", "origin"],
      {
        cwd: canonicalPath,
        timeoutMs: 10_000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    return normalizeRepositoryIdentity(result.stdout);
  } catch {
    return undefined;
  }
}

async function assertRepositoryIsNotCanonical(
  repositoryUrl: string,
  context: SetupExternalRepositoryContext,
): Promise<void> {
  const registryPath = await requireProjectRegistryPath(context);

  let registry: ProjectRegistryDocument;
  try {
    registry = JSON.parse(await readFile(registryPath, "utf8")) as ProjectRegistryDocument;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Project registry could not be read: ${message}`);
  }

  if (!Array.isArray(registry.projects)) {
    throw new Error(`Project registry is missing a projects array: ${registryPath}`);
  }

  const requestedIdentity = normalizeRepositoryIdentity(repositoryUrl);
  if (!requestedIdentity) {
    throw new Error("Repository identity could not be normalized.");
  }

  for (const project of registry.projects) {
    if (project.git_repository === false || typeof project.canonical_path !== "string") continue;
    const canonicalPath = resolve(project.canonical_path);
    const registeredIdentity = typeof project.git_repository === "string"
      ? normalizeRepositoryIdentity(project.git_repository)
      : await canonicalRepositoryIdentity(canonicalPath);
    if (project.git_repository === true && !registeredIdentity) {
      throw new Error(
        `SOURCE_AUTHORITY_IDENTITY_UNAVAILABLE: registered Git project ${canonicalPath} has no readable canonical repository identity.`,
      );
    }
    if (registeredIdentity !== requestedIdentity) continue;
    throw new Error(
      `DUPLICATE_REPOSITORY_IDENTITY: ${requestedIdentity} already has canonical source ${canonicalPath}; reuse it instead of creating another writable copy.`,
    );
  }
}

export function validateGitRef(ref: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes("..") || ref.endsWith("/")) {
    throw new Error("ref contains unsupported characters or structure.");
  }
  return ref;
}

export function validateExpectedCommit(commit: string): string {
  if (!/^[0-9a-fA-F]{40}$/.test(commit)) {
    throw new Error("expectedCommit must be a full 40-character Git commit SHA.");
  }
  return commit.toLowerCase();
}

export function npmInstallPlan(
  packageLockPresent: boolean,
  npmShrinkwrapPresent: boolean,
  allowInstallScripts: boolean,
): PackageInstallPlan {
  if (!packageLockPresent && !npmShrinkwrapPresent) {
    throw new Error(
      "Dependency installation requires package-lock.json or npm-shrinkwrap.json for a reproducible npm ci run.",
    );
  }

  const args = ["ci", "--no-audit", "--no-fund"];
  if (!allowInstallScripts) args.push("--ignore-scripts");
  return { command: "npm", args };
}

async function detectNpmInstallPlan(
  projectPath: string,
  allowInstallScripts: boolean,
): Promise<PackageInstallPlan> {
  const packageJsonPath = join(projectPath, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    throw new Error("Dependency installation was requested, but package.json is missing.");
  }

  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    packageManager?: unknown;
  };
  if (
    typeof packageJson.packageManager === "string" &&
    !packageJson.packageManager.startsWith("npm@")
  ) {
    throw new Error(
      `Only npm projects are supported by this controlled installer; found packageManager=${packageJson.packageManager}.`,
    );
  }

  return npmInstallPlan(
    await pathExists(join(projectPath, "package-lock.json")),
    await pathExists(join(projectPath, "npm-shrinkwrap.json")),
    allowInstallScripts,
  );
}

export async function assertNoEscapingSymlinks(repositoryRoot: string): Promise<void> {
  const realRepositoryRoot = await realpath(repositoryRoot);
  const stack = [repositoryRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      const entryStats = await lstat(entryPath);

      if (entryStats.isSymbolicLink()) {
        let resolvedTarget: string;
        try {
          resolvedTarget = await realpath(entryPath);
        } catch {
          throw new Error(`Repository contains a broken symbolic link: ${entryPath}`);
        }
        if (!isPathInsideRoot(resolvedTarget, realRepositoryRoot)) {
          throw new Error(
            `Repository symbolic link resolves outside the cloned repository: ${entryPath}`,
          );
        }
        continue;
      }

      if (entryStats.isDirectory()) stack.push(entryPath);
    }
  }
}

async function resolveSafeDestination(
  destinationInput: string,
  context: SetupExternalRepositoryContext,
): Promise<string> {
  const destination = resolveAllowedPath(destinationInput, context.cwd, [context.root]);
  const realRoot = await realpath(context.root);
  const parent = dirname(destination);
  const realParent = await realpath(parent);

  if (resolve(destination) === resolve(context.root)) {
    throw new Error("The workspace root cannot be used as an external repository destination.");
  }
  if (!isPathInsideRoot(realParent, realRoot)) {
    throw new Error("The destination parent resolves outside the workspace root.");
  }
  return destination;
}

async function claimDestination(destination: string): Promise<ClaimedDestination> {
  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Destination already exists: ${destination}`);
    }
    throw error;
  }

  const entry = await lstat(destination);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Claimed repository destination is not a real directory: ${destination}`);
  }
  return { path: destination, dev: entry.dev, ino: entry.ino };
}

async function cleanupClaimedDestination(claim: ClaimedDestination): Promise<string> {
  const quarantine = join(
    dirname(claim.path),
    `.${basename(claim.path)}.devspace-cleanup-${randomUUID()}`,
  );
  try {
    await rename(claim.path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "Claimed destination was already absent.";
    }
    throw error;
  }

  const moved = await lstat(quarantine);
  if (!moved.isDirectory() || moved.dev !== claim.dev || moved.ino !== claim.ino) {
    try {
      await rename(quarantine, claim.path);
      throw new Error(
        "Cleanup refused because the destination was replaced by another filesystem entry; that entry was restored without deletion.",
      );
    } catch (restoreError) {
      if ((restoreError as Error).message.startsWith("Cleanup refused")) throw restoreError;
      throw new Error(
        `Cleanup refused because the destination identity changed; the replacement remains preserved at ${quarantine}.`,
        { cause: restoreError },
      );
    }
  }

  await rm(quarantine, { recursive: true, force: true });
  return "Rollback removed only the destination directory claimed by this invocation.";
}

export async function setupExternalRepository(
  input: SetupExternalRepositoryInput,
  context: SetupExternalRepositoryContext,
): Promise<SetupExternalRepositoryResult> {
  const repositoryUrl = normalizeGitHubRepositoryUrl(input.repositoryUrl);
  await assertRepositoryIsNotCanonical(repositoryUrl, context);
  const destination = await resolveSafeDestination(input.destination, context);
  const expectedCommit = input.expectedCommit
    ? validateExpectedCommit(input.expectedCommit)
    : undefined;
  const ref = input.ref ? validateGitRef(input.ref) : undefined;
  const installDependencies = input.installDependencies ?? false;
  const allowInstallScripts = input.allowInstallScripts ?? false;
  const timeoutMs = normalizedTimeoutSeconds(input.timeoutSeconds) * 1_000;
  const executeCommand = context.commandRunner ?? runCommand;
  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GCM_INTERACTIVE: "Never",
  };
  const gitSafetyArgs = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
  ];

  let claimedDestination: ClaimedDestination | undefined;
  try {
    claimedDestination = await claimDestination(destination);
    await executeCommand(
      "git",
      [
        ...gitSafetyArgs,
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "--origin",
        "upstream",
        "--",
        repositoryUrl,
        destination,
      ],
      { cwd: context.root, timeoutMs, env: gitEnv },
    );
    const checkoutTarget = expectedCommit ?? ref ?? "HEAD";
    await executeCommand(
      "git",
      [
        ...gitSafetyArgs,
        "-C",
        destination,
        "checkout",
        "--detach",
        checkoutTarget,
      ],
      { cwd: context.root, timeoutMs, env: gitEnv },
    );

    const commit = (
      await executeCommand("git", [...gitSafetyArgs, "-C", destination, "rev-parse", "HEAD"], {
        cwd: context.root,
        timeoutMs,
        env: gitEnv,
      })
    ).stdout.trim().toLowerCase();

    if (expectedCommit && commit !== expectedCommit) {
      throw new Error(
        `Checked out commit ${commit}, but expected ${expectedCommit}.`,
      );
    }

    const realDestination = await realpath(destination);
    const realWorkspaceRoot = await realpath(context.root);
    if (!isPathInsideRoot(realDestination, realWorkspaceRoot)) {
      throw new Error("Cloned repository resolves outside the workspace root.");
    }
    await assertNoEscapingSymlinks(destination);

    let installCommand: string | undefined;
    if (installDependencies) {
      const plan = await detectNpmInstallPlan(destination, allowInstallScripts);
      await executeCommand(plan.command, plan.args, {
        cwd: destination,
        timeoutMs,
        env: {
          ...process.env,
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
      });
      installCommand = [plan.command, ...plan.args].join(" ");
    }

    return {
      repositoryUrl,
      destination,
      commit,
      dependenciesInstalled: installDependencies,
      installCommand,
      installScriptsAllowed: allowInstallScripts,
    };
  } catch (error) {
    let rollbackMessage = "Destination was not claimed by this invocation; no cleanup was attempted.";
    if (claimedDestination) {
      try {
        rollbackMessage = await cleanupClaimedDestination(claimedDestination);
      } catch (rollbackError) {
        rollbackMessage = `Rollback failed: ${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }`;
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} ${rollbackMessage}`);
  }
}
