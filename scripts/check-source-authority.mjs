#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const registryPath = resolve(
  process.env.DEVSPACE_PROJECT_REGISTRY
    ?? join(dirname(sourceRoot), "portfolio", "PROJECT_REGISTRY.json"),
);
const releasesRoot = resolve(
  process.env.DEVSPACE_RELEASES_ROOT
    ?? join(homedir(), ".devspace", "runtime", "releases"),
);

const options = parseArgs(process.argv.slice(2));
await main();

async function main() {
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const project = registry.projects?.find((entry) => entry.project_id === "devspace");
  if (!project?.canonical_path) {
    throw new Error(`DevSpace canonical project is missing from ${registryPath}.`);
  }

  const canonicalPath = await canonicalizeExisting(project.canonical_path);
  const requestedSource = await canonicalizeExisting(options.source ?? sourceRoot);
  const requestedTarget = resolve(options.target ?? releasesRoot);
  const supportComponents = (registry.support_components ?? [])
    .filter((entry) => entry.owner_project_id === "devspace")
    .map((entry) => ({ ...entry, path: resolve(entry.path) }));
  const canonicalOrigin = gitOrigin(canonicalPath);
  const requestedOrigin = gitOrigin(requestedSource);
  const repositoryIdentity = normalizeRepositoryIdentity(options.repository);
  const violations = [];

  if (["deploy", "write"].includes(options.operation) && requestedSource !== canonicalPath) {
    violations.push({
      code: "NON_CANONICAL_SOURCE",
      message: `Operation ${options.operation} must originate from ${canonicalPath}, not ${requestedSource}.`,
    });
  }
  if (
    ["deploy", "write"].includes(options.operation)
    && requestedOrigin
    && canonicalOrigin
    && requestedOrigin !== canonicalOrigin
  ) {
    violations.push({
      code: "REPOSITORY_IDENTITY_MISMATCH",
      message: `Source repository ${requestedOrigin} does not match canonical ${canonicalOrigin}.`,
    });
  }
  const targetSupport = supportComponents.find((entry) => isWithin(entry.path, requestedTarget));
  if (
    targetSupport
    && targetSupport.role === "historical-upstream-reference"
    && options.operation !== "audit"
  ) {
    violations.push({
      code: "REFERENCE_IS_NOT_A_WRITE_TARGET",
      message: `${targetSupport.path} is a historical upstream reference, not a writable source or deployment target.`,
    });
  }
  if (options.operation === "deploy" && !isWithin(releasesRoot, requestedTarget)) {
    violations.push({
      code: "UNREGISTERED_RUNTIME_TARGET",
      message: `Deployment target must be ${releasesRoot} or a versioned child of it.`,
    });
  }
  if (options.operation === "clone" && repositoryIdentity && repositoryIdentity === canonicalOrigin) {
    violations.push({
      code: "DUPLICATE_REPOSITORY_IDENTITY",
      message: `Repository ${repositoryIdentity} already has canonical source ${canonicalPath}; reuse it instead of cloning another writable copy.`,
    });
  }

  const rawInventory = [
    {
      path: canonicalPath,
      role: "canonical-writable-source",
      repositoryIdentity: canonicalOrigin,
    },
    ...supportComponents.map((entry) => ({
      path: entry.path,
      role: entry.role,
      repositoryIdentity: gitOrigin(entry.path),
    })),
    {
      path: releasesRoot,
      role: "generated-versioned-releases",
      repositoryIdentity: null,
    },
  ];
  const inventory = [...new Map(rawInventory.map((entry) => [entry.path, entry])).values()];
  const blocked = options.mode === "enforce" && violations.length > 0;
  const result = {
    schemaVersion: "1.0.0",
    status: blocked ? "BLOCKED" : violations.length > 0 ? "SHADOW_VIOLATIONS" : "PASS",
    mode: options.mode,
    operation: options.operation,
    registryPath,
    canonicalPath,
    source: requestedSource,
    target: requestedTarget,
    repositoryIdentity,
    invariant: "one repository identity has one canonical writable source",
    inventory,
    violations,
  };
  console.log(JSON.stringify(result, null, 2));
  if (blocked) process.exitCode = 2;
}

function parseArgs(args) {
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    return value;
  };
  const mode = valueAfter("--mode") ?? "shadow";
  const operation = valueAfter("--operation") ?? "audit";
  if (!new Set(["shadow", "enforce"]).has(mode)) {
    throw new Error(`Unsupported --mode ${mode}.`);
  }
  if (!new Set(["audit", "clone", "deploy", "write"]).has(operation)) {
    throw new Error(`Unsupported --operation ${operation}.`);
  }
  return {
    mode,
    operation,
    source: valueAfter("--source"),
    target: valueAfter("--target"),
    repository: valueAfter("--repository"),
  };
}

async function canonicalizeExisting(path) {
  const resolved = resolve(path);
  await access(resolved);
  return realpath(resolved);
}

function gitOrigin(path) {
  try {
    return normalizeRepositoryIdentity(execFileSync(
      "git",
      ["-C", path, "remote", "get-url", "origin"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim());
  } catch {
    return null;
  }
}

function normalizeRepositoryIdentity(value) {
  if (!value) return null;
  let normalized = String(value).trim();
  normalized = normalized.replace(/^git@([^:]+):/, "https://$1/");
  normalized = normalized.replace(/^ssh:\/\/git@/, "https://");
  normalized = normalized.replace(/^https?:\/\//, "");
  normalized = normalized.replace(/\/+$/, "").replace(/\.git$/i, "");
  return normalized.toLowerCase();
}

function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
