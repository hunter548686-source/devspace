#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TASK_ID = "DEVSPACE-SOURCE-AUTHORITY-RUNTIME-RELEASE-20260830";
const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const releasesRoot = resolve(
  process.env.DEVSPACE_RELEASES_ROOT
    ?? join(homedir(), ".devspace", "runtime", "releases"),
);
const dependencyStoresRoot = resolve(
  process.env.DEVSPACE_DEPENDENCY_STORES_ROOT
    ?? join(dirname(releasesRoot), "dependencies"),
);
const binPath = resolve(
  process.env.DEVSPACE_BIN_PATH
    ?? join(homedir(), ".devspace", "bin", "devspace"),
);
const pointerPath = join(releasesRoot, "current.json");
const serviceLabel = process.env.DEVSPACE_SERVICE_LABEL ?? "com.liheng.devspace";
const localHealthUrl = process.env.DEVSPACE_LOCAL_HEALTH_URL
  ?? "http://127.0.0.1:7676/healthz";
const publicHealthUrl = process.env.DEVSPACE_PUBLIC_HEALTH_URL
  ?? "https://devspace.chinacareglobal.com/healthz";
const activate = process.argv.includes("--deploy") || process.argv.includes("--activate");
const stageOnly = process.argv.includes("--stage");
const runtimeTestMode = process.env.DEVSPACE_RUNTIME_TEST_MODE === "1";
const testServiceStatePath = process.env.DEVSPACE_TEST_SERVICE_STATE_PATH
  ? resolve(process.env.DEVSPACE_TEST_SERVICE_STATE_PATH)
  : null;
let jsonRenameFailureInjected = false;

await main();

async function main() {
  await enforceSourceAuthority();
  const inventory = await buildPackageInventory();
  const sourcePackage = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  const dependencyPlan = await buildDependencyPlan(sourcePackage);
  assertRequiredPayload(inventory.files);

  if (!activate && !stageOnly) {
    console.log(JSON.stringify({
      schemaVersion: "2.0.0",
      status: "READY_TO_STAGE",
      taskId: TASK_ID,
      sourceRoot,
      releasesRoot,
      dependencyStoresRoot,
      binPath,
      package: `${sourcePackage.name}@${sourcePackage.version}`,
      payloadAuthority: "npm pack --dry-run --json",
      fileCount: inventory.files.length,
      unpackedSize: inventory.unpackedSize,
      bundleSha256: inventory.bundleSha256,
      dependencyStoreId: dependencyPlan.id,
      dependencyLockSha256: dependencyPlan.lockSha256,
      releaseId: null,
      releaseIdentityStatus: "DEPENDENCY_STORE_VERIFICATION_REQUIRED",
      activation: "atomic executable symlink replacement",
      rollback: "restore prior managed executable symlink; dependency stores remain immutable",
    }, null, 2));
    return;
  }

  const dependencyStore = await ensureDependencyStore(sourcePackage, dependencyPlan);
  const staged = await stageRelease(sourcePackage, inventory, dependencyStore);
  if (stageOnly && !activate) {
    console.log(JSON.stringify({
      status: "STAGED_SHADOW_PASS",
      ...stagedSummary(staged),
      activationRequired: true,
    }, null, 2));
    return;
  }

  const activated = await activateRelease(staged);
  console.log(JSON.stringify(activated, null, 2));
}

async function enforceSourceAuthority() {
  const guardPath = join(sourceRoot, "scripts", "check-source-authority.mjs");
  execFileSync(process.execPath, [
    guardPath,
    "--mode", "enforce",
    "--operation", "deploy",
    "--source", sourceRoot,
    "--target", releasesRoot,
  ], { cwd: sourceRoot, stdio: ["ignore", "ignore", "pipe"] });
}

async function buildPackageInventory() {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pack = JSON.parse(raw)?.[0];
  if (!pack || !Array.isArray(pack.files) || pack.files.length === 0) {
    throw new Error("npm pack did not return a package file inventory.");
  }
  const entries = [];
  for (const item of pack.files) {
    const path = normalizePayloadPath(item.path);
    const sourcePath = join(sourceRoot, path);
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) throw new Error(`Package payload is not a regular file: ${path}.`);
    const content = await readFile(sourcePath);
    entries.push({
      path,
      size: content.length,
      mode: fileStat.mode & 0o777,
      sha256: sha256(content),
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const bundleSha256 = sha256(entries.map((entry) => (
    `${entry.path}\0${entry.size}\0${entry.sha256}\n`
  )).join(""));
  return {
    files: entries,
    unpackedSize: entries.reduce((total, entry) => total + entry.size, 0),
    bundleSha256,
    npmIntegrity: pack.integrity ?? null,
  };
}

function normalizePayloadPath(value) {
  const path = String(value).replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path === ".." || path.startsWith("../") || path.includes("/../")) {
    throw new Error(`Unsafe package payload path: ${JSON.stringify(value)}.`);
  }
  return path;
}

function assertRequiredPayload(files) {
  const paths = new Set(files.map((entry) => entry.path));
  for (const path of [
    "package.json",
    "dist/cli.js",
    "dist/server.js",
    "dist/external-repository.js",
    "dist/project-workspace-resolver.js",
  ]) {
    if (!paths.has(path)) throw new Error(`Complete package payload is missing ${path}.`);
  }
  if (files.length < 20) {
    throw new Error(`Complete package payload unexpectedly contains only ${files.length} files.`);
  }
}

async function buildDependencyPlan(pkg) {
  const lockPath = join(sourceRoot, "package-lock.json");
  const lockContent = await readFile(lockPath, "utf8");
  const lock = JSON.parse(lockContent);
  const lockedRoot = lock.packages?.[""];
  if (!lockedRoot || lockedRoot.name !== pkg.name || lockedRoot.version !== pkg.version) {
    throw new Error("Canonical package-lock.json root does not match package.json.");
  }
  for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
    const declared = sortedRecord(pkg[field] ?? {});
    const locked = sortedRecord(lockedRoot[field] ?? {});
    if (JSON.stringify(declared) !== JSON.stringify(locked)) {
      throw new Error(`Canonical package-lock.json ${field} does not exactly match package.json.`);
    }
  }
  const lockSha256 = sha256(lockContent);
  const platform = process.platform;
  const arch = process.arch;
  const nodeAbi = process.versions.modules ?? "unknown";
  const address = sha256(`${lockSha256}\0${platform}\0${arch}\0${nodeAbi}\n`);
  const id = `npm-${address.slice(0, 24)}`;
  return {
    id,
    lockPath,
    lockContent,
    lockSha256,
    platform,
    arch,
    nodeAbi,
    storePath: join(dependencyStoresRoot, id),
  };
}

function sortedRecord(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

async function ensureDependencyStore(pkg, plan) {
  await mkdir(dependencyStoresRoot, { recursive: true });
  if (await exists(plan.storePath)) return verifyDependencyStore(pkg, plan);

  const stagingPath = `${plan.storePath}.staging-${process.pid}-${Date.now()}`;
  let published = false;
  await mkdir(stagingPath, { recursive: false });
  try {
    const installPackage = structuredClone(pkg);
    delete installPackage.scripts;
    await writeJson(join(stagingPath, "package.json"), installPackage);
    await writeFile(join(stagingPath, "package-lock.json"), plan.lockContent, { mode: 0o600 });
    execFileSync("npm", [
      "ci",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ], {
      cwd: stagingPath,
      env: { ...process.env, npm_config_update_notifier: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    });
    const summary = dependencyTreeSummary(stagingPath);
    verifyDependencyEntrypoints(stagingPath, pkg);
    const npmVersion = execFileSync("npm", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    await writeJson(join(stagingPath, "DEPENDENCIES.json"), {
      schemaVersion: "1.0.0",
      status: "IMMUTABLE_DEPENDENCY_STORE_PASS",
      createdAt: new Date().toISOString(),
      id: plan.id,
      storePath: plan.storePath,
      nodeModulesPath: join(plan.storePath, "node_modules"),
      sourcePackage: `${pkg.name}@${pkg.version}`,
      packageLockSha256: plan.lockSha256,
      dependencyTreeSha256: summary.sha256,
      dependencyPackageCount: summary.packageCount,
      platform: plan.platform,
      arch: plan.arch,
      nodeAbi: plan.nodeAbi,
      nodeVersion: process.version,
      npmVersion,
    });
    await makeReadOnly(stagingPath);
    try {
      await rename(stagingPath, plan.storePath);
      published = true;
    } catch (error) {
      if (!(await exists(plan.storePath))) throw error;
      await makeWritable(stagingPath).catch(() => {});
      await rm(stagingPath, { recursive: true, force: true });
      return verifyDependencyStore(pkg, plan);
    }
    return verifyDependencyStore(pkg, plan);
  } catch (error) {
    const failedPath = published ? plan.storePath : stagingPath;
    await makeWritable(failedPath).catch(() => {});
    await rm(failedPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function verifyDependencyStore(pkg, plan) {
  const manifestPath = join(plan.storePath, "DEPENDENCIES.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const [field, expected] of Object.entries({
    status: "IMMUTABLE_DEPENDENCY_STORE_PASS",
    id: plan.id,
    sourcePackage: `${pkg.name}@${pkg.version}`,
    packageLockSha256: plan.lockSha256,
    platform: plan.platform,
    arch: plan.arch,
    nodeAbi: plan.nodeAbi,
  })) {
    if (manifest[field] !== expected) {
      throw new Error(`Dependency store ${plan.storePath} has invalid ${field}.`);
    }
  }
  const storedLock = await readFile(join(plan.storePath, "package-lock.json"), "utf8");
  if (sha256(storedLock) !== plan.lockSha256) {
    throw new Error(`Dependency store ${plan.storePath} package-lock hash changed.`);
  }
  const nodeModulesPath = join(plan.storePath, "node_modules");
  const nodeModulesStat = await lstat(nodeModulesPath);
  if (!nodeModulesStat.isDirectory() || nodeModulesStat.isSymbolicLink()) {
    throw new Error(`Dependency store ${plan.storePath} must own a real node_modules directory.`);
  }
  const realStorePath = await realpath(plan.storePath);
  const realNodeModulesPath = await realpath(nodeModulesPath);
  if (!isWithin(realStorePath, realNodeModulesPath)) {
    throw new Error(`Dependency store node_modules escapes ${realStorePath}.`);
  }
  const summary = dependencyTreeSummary(plan.storePath);
  if (
    manifest.dependencyTreeSha256 !== summary.sha256
    || manifest.dependencyPackageCount !== summary.packageCount
  ) {
    throw new Error(`Dependency store ${plan.storePath} dependency summary changed.`);
  }
  verifyDependencyEntrypoints(plan.storePath, pkg);
  if (((await stat(plan.storePath)).mode & 0o222) !== 0 || (nodeModulesStat.mode & 0o222) !== 0) {
    throw new Error(`Dependency store ${plan.storePath} is writable.`);
  }
  return {
    id: plan.id,
    storePath: realStorePath,
    manifestPath: await realpath(manifestPath),
    nodeModulesPath: realNodeModulesPath,
    lockSha256: plan.lockSha256,
    treeSha256: summary.sha256,
    packageCount: summary.packageCount,
    platform: plan.platform,
    arch: plan.arch,
    nodeAbi: plan.nodeAbi,
  };
}

function dependencyTreeSummary(root) {
  const raw = execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  });
  const normalized = normalizeDependencyNode(JSON.parse(raw));
  return {
    sha256: sha256(JSON.stringify(normalized)),
    packageCount: countDependencyNodes(normalized) - 1,
  };
}

function normalizeDependencyNode(node, fallbackName = null) {
  const dependencies = {};
  for (const [name, child] of Object.entries(node.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    dependencies[name] = normalizeDependencyNode(child, name);
  }
  return {
    name: node.name ?? fallbackName,
    version: node.version ?? null,
    dependencies,
  };
}

function countDependencyNodes(node) {
  return 1 + Object.values(node.dependencies).reduce(
    (total, child) => total + countDependencyNodes(child),
    0,
  );
}

function verifyDependencyEntrypoints(storePath, pkg) {
  const directDependencies = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ];
  const probe = String.raw`
    const { createRequire } = require("node:module");
    const fs = require("node:fs");
    const path = require("node:path");
    const store = process.argv[1];
    const names = JSON.parse(process.argv[2]);
    const nodeModules = fs.realpathSync(path.join(store, "node_modules"));
    for (const name of names) {
      const packageJson = fs.realpathSync(path.join(nodeModules, ...name.split("/"), "package.json"));
      if (packageJson !== nodeModules && !packageJson.startsWith(nodeModules + path.sep)) {
        throw new Error("Dependency escapes store: " + name);
      }
    }
    const requireFromStore = createRequire(path.join(store, "package.json"));
    const Database = requireFromStore("better-sqlite3");
    const db = new Database(":memory:");
    db.exec("select 1");
    db.close();
    const pty = requireFromStore("node-pty");
    if (typeof pty.spawn !== "function") throw new Error("node-pty spawn is unavailable");
  `;
  execFileSync(process.execPath, ["--eval", probe, storePath, JSON.stringify(directDependencies)], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  });
}

function releaseId(pkg, bundleSha256, dependency) {
  const name = String(pkg.name).replace(/^@/, "").replaceAll("/", "-");
  if (!dependency.treeSha256) {
    throw new Error("Cannot finalize a release identity without a verified dependency digest.");
  }
  const combinedSha256 = sha256(
    `${bundleSha256}\0${dependency.id}\0${dependency.lockSha256}\0${dependency.treeSha256}\n`,
  );
  return `${name}-${pkg.version}-${combinedSha256.slice(0, 16)}`;
}

async function stageRelease(pkg, inventory, dependency) {
  await mkdir(releasesRoot, { recursive: true });
  const id = releaseId(pkg, inventory.bundleSha256, dependency);
  const releasePath = join(releasesRoot, id);
  const manifestPath = join(releasePath, "RELEASE.json");
  if (await exists(releasePath)) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      manifest.bundleSha256 !== inventory.bundleSha256
      || manifest.status !== "STAGED_SHADOW_PASS"
      || manifest.releaseId !== id
      || manifest.dependencyLockSha256 !== dependency.lockSha256
      || manifest.dependencyTreeSha256 !== dependency.treeSha256
      || manifest.dependencyStore?.id !== dependency.id
      || manifest.dependencyStore?.nodeModulesRealpath !== dependency.nodeModulesPath
    ) {
      throw new Error(`Existing release ${releasePath} does not match the canonical bundle.`);
    }
    await verifyReleaseFiles(releasePath, inventory.files);
    await verifyReleaseDependency(releasePath, dependency);
    return { releasePath, manifestPath, manifest, reused: true };
  }

  const stagingPath = `${releasePath}.staging-${process.pid}-${Date.now()}`;
  let published = false;
  await mkdir(stagingPath, { recursive: false });
  try {
    for (const entry of inventory.files) {
      const sourcePath = join(sourceRoot, entry.path);
      const targetPath = join(stagingPath, entry.path);
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      await chmod(targetPath, entry.path === "dist/cli.js" ? 0o755 : entry.mode);
      if (sha256(await readFile(targetPath)) !== entry.sha256) {
        throw new Error(`Staged readback hash mismatch: ${entry.path}.`);
      }
    }
    await symlink(dependency.nodeModulesPath, join(stagingPath, "node_modules"), "dir");
    execFileSync(process.execPath, ["--check", join(stagingPath, "dist", "cli.js")], { stdio: "pipe" });
    execFileSync(process.execPath, ["--check", join(stagingPath, "dist", "server.js")], { stdio: "pipe" });
    execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `const m=await import(${JSON.stringify(pathToFileURL(join(stagingPath, "dist", "server.js")).href)}); if(typeof m.createServer!=="function") process.exit(8);`,
    ], { stdio: "pipe" });
    const shadow = await verifyShadowRuntime(stagingPath);
    const manifest = {
      schemaVersion: "2.0.0",
      taskId: TASK_ID,
      status: "STAGED_SHADOW_PASS",
      releaseId: id,
      createdAt: new Date().toISOString(),
      sourceRoot: await realpath(sourceRoot),
      runtimeDependencies: dependency.nodeModulesPath,
      package: `${pkg.name}@${pkg.version}`,
      payloadAuthority: "npm pack --dry-run --json",
      fileCount: inventory.files.length,
      unpackedSize: inventory.unpackedSize,
      bundleSha256: inventory.bundleSha256,
      npmIntegrity: inventory.npmIntegrity,
      dependencyLockSha256: dependency.lockSha256,
      dependencyTreeSha256: dependency.treeSha256,
      dependencyPackageCount: dependency.packageCount,
      dependencyStore: {
        id: dependency.id,
        storeRealpath: dependency.storePath,
        manifestRealpath: dependency.manifestPath,
        nodeModulesRealpath: dependency.nodeModulesPath,
        platform: dependency.platform,
        arch: dependency.arch,
        nodeAbi: dependency.nodeAbi,
      },
      files: inventory.files,
      shadow,
    };
    await writeJson(join(stagingPath, "RELEASE.json"), manifest);
    await makeReadOnly(stagingPath);
    try {
      await rename(stagingPath, releasePath);
      published = true;
    } catch (error) {
      if (!(await exists(releasePath))) throw error;
      await makeWritable(stagingPath).catch(() => {});
      await rm(stagingPath, { recursive: true, force: true });
      return stageRelease(pkg, inventory, dependency);
    }
    await verifyReleaseDependency(releasePath, dependency);
    return { releasePath, manifestPath, manifest, reused: false };
  } catch (error) {
    const failedPath = published ? releasePath : stagingPath;
    await makeWritable(failedPath).catch(() => {});
    await rm(failedPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function verifyReleaseFiles(releasePath, files) {
  for (const entry of files) {
    const path = join(releasePath, entry.path);
    if (sha256(await readFile(path)) !== entry.sha256) {
      throw new Error(`Read-only release changed after staging: ${entry.path}.`);
    }
  }
}

async function verifyReleaseDependency(releasePath, dependency) {
  const releaseNodeModules = join(releasePath, "node_modules");
  const linkStat = await lstat(releaseNodeModules);
  if (!linkStat.isSymbolicLink()) {
    throw new Error(`Release ${releasePath} node_modules is not a managed dependency-store link.`);
  }
  const resolved = await realpath(releaseNodeModules);
  if (resolved !== dependency.nodeModulesPath || !isWithin(dependency.storePath, resolved)) {
    throw new Error(`Release ${releasePath} resolves dependencies outside its immutable store.`);
  }
}

async function verifyShadowRuntime(releasePath) {
  const configRoot = await mkdtemp(join(tmpdir(), "devspace-release-shadow-"));
  const port = await availablePort();
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  await writeJson(join(configRoot, "config.json"), {
    host: "127.0.0.1",
    port,
    allowedRoots: [dirname(sourceRoot)],
    portfolioRoot: dirname(sourceRoot),
    publicBaseUrl,
    allowedHosts: ["127.0.0.1", "localhost"],
    stateDir: join(configRoot, "state"),
    worktreeRoot: join(configRoot, "worktrees"),
    unifiedProjectWorkspace: true,
    externalRepositoryEnabled: false,
  });
  await writeJson(join(configRoot, "auth.json"), {
    ownerToken: randomBytes(32).toString("base64url"),
  });
  const child = spawn(process.execPath, [join(releasePath, "dist", "cli.js"), "serve"], {
    cwd: releasePath,
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configRoot,
      DEVSPACE_STATE_DIR: join(configRoot, "state"),
      DEVSPACE_WORKTREE_ROOT: join(configRoot, "worktrees"),
      DEVSPACE_TOOL_MODE: "minimal",
      DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = tail(output + chunk, 6000); });
  child.stderr.on("data", (chunk) => { output = tail(output + chunk, 6000); });
  try {
    const contract = await waitForHealth(`${publicBaseUrl}/healthz`, 60, 250, child);
    return {
      status: "PASS",
      mode: "isolated temporary config and state",
      endpoint: `${publicBaseUrl}/healthz`,
      contract,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Candidate shadow start failed: ${detail}\n${output}`);
  } finally {
    await stopChild(child);
    await rm(configRoot, { recursive: true, force: true });
  }
}

async function activateRelease(staged) {
  const target = join(staged.releasePath, "dist", "cli.js");
  const candidateRuntime = await inspectManagedRuntimeTarget(target);
  const previousRuntime = await inspectBinRuntime();
  await assertServicePreflight(previousRuntime);
  if (sameRuntime(previousRuntime, candidateRuntime) && previousRuntime.binLinkTarget === target) {
    const service = await verifyAlreadyActive(candidateRuntime, previousRuntime);
    return {
      status: "ALREADY_ACTIVE",
      ...stagedSummary(staged),
      binPath,
      target,
      service,
    };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const historyRoot = join(releasesRoot, "history", stamp);
  const activationPath = join(historyRoot, "ACTIVATION.json");
  const activation = {
    schemaVersion: "3.0.0",
    taskId: TASK_ID,
    status: "ACTIVATING",
    createdAt: new Date().toISOString(),
    releasePath: staged.releasePath,
    releaseManifest: staged.manifestPath,
    releaseId: staged.manifest.releaseId,
    bundleSha256: staged.manifest.bundleSha256,
    binPath,
    previousBinLinkTarget: previousRuntime.binLinkTarget,
    activeBinLinkTarget: candidateRuntime.binTargetRealpath,
    previousRuntime,
    candidateRuntime,
    serviceLabel,
  };
  await writeJson(activationPath, activation);
  try {
    await atomicSymlink(candidateRuntime.binTargetRealpath, binPath);
    if (runtimeTestMode && process.env.DEVSPACE_TEST_CRASH_AFTER_SWITCH === "1") {
      process.exit(86);
    }
    if (process.env.DEVSPACE_TEST_FAIL_AFTER_SWITCH === "1") {
      throw new Error("Injected post-switch failure for rollback verification.");
    }
    const switchedRuntime = await inspectBinRuntime();
    assertRuntimeMatches(switchedRuntime, candidateRuntime, "activated executable");
    const service = await restartAndVerifyService({ expectedRuntime: candidateRuntime });
    activation.status = "ACTIVE_ACCEPTANCE_PASS";
    activation.activatedAt = new Date().toISOString();
    activation.service = service;
    activation.activeRuntime = switchedRuntime;
    activation.rollbackCommand = `node ${join(sourceRoot, "scripts", "rollback-unified-project-workspace-v1.mjs")}`;
    await writeJson(activationPath, activation);
    const activationSha256 = await fileSha256(activationPath);
    await writeJson(pointerPath, currentPointerForRuntime(switchedRuntime, {
      transitionStatus: activation.status,
      transitionManifest: activationPath,
      transitionManifestSha256: activationSha256,
      activationManifest: activationPath,
      activationManifestSha256: activationSha256,
      updatedAt: activation.activatedAt,
    }));
    return {
      status: activation.status,
      ...stagedSummary(staged),
      binPath,
      activeBinLinkTarget: switchedRuntime.binLinkTarget,
      activationManifest: activationPath,
      pointerPath,
      service,
      rollbackCommand: activation.rollbackCommand,
    };
  } catch (error) {
    const originalError = error instanceof Error ? error.message : String(error);
    let compensationError = null;
    let compensationService = null;
    let restoredRuntime = null;
    try {
      await atomicSymlink(previousRuntime.binTargetRealpath, binPath);
      restoredRuntime = await inspectBinRuntime();
      assertRuntimeMatches(restoredRuntime, previousRuntime, "auto-restored executable");
      compensationService = await restartAndVerifyService({
        expectedRuntime: previousRuntime,
        publicChecks: 0,
      });
      restoredRuntime = await inspectBinRuntime();
    } catch (compensationFailure) {
      compensationError = compensationFailure instanceof Error
        ? compensationFailure.message
        : String(compensationFailure);
    }
    activation.status = compensationError
      ? "ACTIVATION_FAILED_ROLLBACK_FAILED"
      : "ACTIVATION_FAILED_AUTO_ROLLED_BACK";
    activation.failedAt = new Date().toISOString();
    activation.error = originalError;
    activation.compensationError = compensationError;
    activation.compensationService = compensationService;
    activation.restoredRuntime = restoredRuntime;
    activation.observedRuntime = await safeInspectBinRuntime();
    await writeJson(activationPath, activation);
    const activationSha256 = await fileSha256(activationPath);
    if (compensationError) {
      await writeJson(pointerPath, uncertainPointer({
        transitionStatus: activation.status,
        transitionManifest: activationPath,
        transitionManifestSha256: activationSha256,
        observedRuntime: activation.observedRuntime,
        updatedAt: activation.failedAt,
      }));
    } else {
      await writeJson(pointerPath, currentPointerForRuntime(restoredRuntime, {
        transitionStatus: activation.status,
        transitionManifest: activationPath,
        transitionManifestSha256: activationSha256,
        updatedAt: activation.failedAt,
      }));
    }
    throw new Error(`${activation.status}: ${originalError}${compensationError ? `; compensation: ${compensationError}` : ""}`);
  }
}

async function restartAndVerifyService({ expectedRuntime, publicChecks = 3 } = {}) {
  if (!expectedRuntime) throw new Error("Expected runtime binding is required for service restart.");
  await assertBinRuntime(expectedRuntime);
  const before = await readServiceSnapshot({ requirePid: false });
  assertServiceProgram(before);
  await triggerServiceRestart();
  const after = await waitForChangedServicePid(before.pid);
  assertServiceProgram(after);
  await assertBinRuntime(expectedRuntime);
  const local = await waitForHealth(localHealthUrl, 80, 250);
  const publicResults = [];
  for (let index = 0; index < publicChecks; index += 1) {
    publicResults.push(await waitForHealth(publicHealthUrl, 20, 500));
  }
  return { status: "PASS", before, after, local, public: publicResults };
}

async function inspectBinRuntime() {
  let linkStat;
  try {
    linkStat = await lstat(binPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing runtime transition: managed executable ${binPath} is unavailable: ${detail}`);
  }
  if (!linkStat.isSymbolicLink()) {
    throw new Error(`Refusing runtime transition: ${binPath} is not a symlink.`);
  }
  const binLinkTarget = await readlink(binPath);
  return inspectManagedRuntimeTarget(binLinkTarget);
}

async function inspectManagedRuntimeTarget(binLinkTarget) {
  const targetPath = resolve(dirname(binPath), binLinkTarget);
  const binTargetRealpath = await realpath(targetPath);
  const releasesRealpath = await realpath(releasesRoot);
  const targetRelative = relative(releasesRealpath, binTargetRealpath);
  const targetParts = targetRelative.split(sep);
  if (
    targetParts.length !== 3
    || targetParts[0] === "history"
    || targetParts[1] !== "dist"
    || targetParts[2] !== "cli.js"
    || !isWithin(releasesRealpath, binTargetRealpath)
  ) {
    throw new Error(`Managed executable target escapes a direct release: ${binTargetRealpath}.`);
  }

  const releasePath = join(releasesRealpath, targetParts[0]);
  const cliStat = await lstat(binTargetRealpath);
  if (!cliStat.isFile() || (cliStat.mode & 0o111) === 0) {
    throw new Error(`Managed executable is not an executable regular file: ${binTargetRealpath}.`);
  }

  const releaseManifest = await realpath(join(releasePath, "RELEASE.json"));
  if (!isWithin(releasePath, releaseManifest)) {
    throw new Error(`Release manifest escapes ${releasePath}.`);
  }
  const releaseManifestContent = await readFile(releaseManifest, "utf8");
  const manifest = JSON.parse(releaseManifestContent);
  if (
    manifest.schemaVersion !== "2.0.0"
    || manifest.status !== "STAGED_SHADOW_PASS"
    || typeof manifest.releaseId !== "string"
    || manifest.releaseId !== basename(releasePath)
    || typeof manifest.bundleSha256 !== "string"
  ) {
    throw new Error(`Release manifest is not an accepted managed runtime: ${releaseManifest}.`);
  }
  await verifyManagedReleasePayload(releasePath, releaseManifest, manifest);

  const dependenciesRealpath = await realpath(dependencyStoresRoot);
  const dependencyStoreRealpath = await realpath(String(manifest.dependencyStore?.storeRealpath ?? ""));
  if (
    dirname(dependencyStoreRealpath) !== dependenciesRealpath
    || !isWithin(dependenciesRealpath, dependencyStoreRealpath)
  ) {
    throw new Error(`Release dependency store escapes ${dependenciesRealpath}.`);
  }
  const dependencyManifest = await realpath(join(dependencyStoreRealpath, "DEPENDENCIES.json"));
  const declaredDependencyManifest = await realpath(
    String(manifest.dependencyStore?.manifestRealpath ?? ""),
  );
  if (declaredDependencyManifest !== dependencyManifest) {
    throw new Error(`Release dependency manifest binding changed for ${releasePath}.`);
  }
  const dependency = JSON.parse(await readFile(dependencyManifest, "utf8"));
  const dependencyPackageJsonContent = await readFile(join(dependencyStoreRealpath, "package.json"), "utf8");
  const dependencyPackage = JSON.parse(dependencyPackageJsonContent);
  const dependencyLockContent = await readFile(join(dependencyStoreRealpath, "package-lock.json"), "utf8");
  const dependencyLock = JSON.parse(dependencyLockContent);
  verifyStoredDependencyLock(dependencyLock, dependencyPackage);
  const verifiedDependencySummary = dependencyTreeSummary(dependencyStoreRealpath);
  verifyDependencyEntrypoints(dependencyStoreRealpath, dependencyPackage);
  const dependencyNodeModules = await realpath(join(dependencyStoreRealpath, "node_modules"));
  const releaseNodeModulesPath = join(releasePath, "node_modules");
  if (!(await lstat(releaseNodeModulesPath)).isSymbolicLink()) {
    throw new Error(`Release ${releasePath} does not use a managed node_modules link.`);
  }
  const releaseNodeModulesRealpath = await realpath(releaseNodeModulesPath);
  if (
    releaseNodeModulesRealpath !== dependencyNodeModules
    || !isWithin(dependencyStoreRealpath, dependencyNodeModules)
    || manifest.dependencyStore?.nodeModulesRealpath !== dependencyNodeModules
    || manifest.runtimeDependencies !== dependencyNodeModules
    || dependency.schemaVersion !== "1.0.0"
    || dependency.status !== "IMMUTABLE_DEPENDENCY_STORE_PASS"
    || dependency.id !== manifest.dependencyStore?.id
    || dependency.storePath !== dependencyStoreRealpath
    || dependency.nodeModulesPath !== dependencyNodeModules
    || dependencyPackage.scripts !== undefined
    || sha256(dependencyLockContent) !== dependency.packageLockSha256
    || dependency.packageLockSha256 !== manifest.dependencyLockSha256
    || dependency.dependencyTreeSha256 !== manifest.dependencyTreeSha256
    || dependency.dependencyTreeSha256 !== verifiedDependencySummary.sha256
    || dependency.dependencyPackageCount !== verifiedDependencySummary.packageCount
    || dependency.dependencyPackageCount !== manifest.dependencyPackageCount
    || dependency.platform !== process.platform
    || dependency.arch !== process.arch
    || dependency.nodeAbi !== (process.versions.modules ?? "unknown")
    || (dependency.packageJsonSha256 !== undefined
      && dependency.packageJsonSha256 !== sha256(dependencyPackageJsonContent))
    || (dependency.origin === "legacy-installed-tree-snapshot"
      && dependency.lockProvenance !== "npm-shrinkwrap-from-copied-installed-tree")
    || ((await stat(dependencyStoreRealpath)).mode & 0o222) !== 0
    || ((await stat(dependencyNodeModules)).mode & 0o222) !== 0
  ) {
    throw new Error(`Release dependency binding is inconsistent for ${releasePath}.`);
  }

  return {
    legacy: false,
    binLinkTarget,
    binTargetRealpath,
    releasePath,
    releaseManifest,
    releaseManifestSha256: sha256(releaseManifestContent),
    releaseId: manifest.releaseId,
    bundleSha256: manifest.bundleSha256,
    dependencyStoreId: manifest.dependencyStore.id,
    dependencyStoreRealpath,
    dependencyManifest,
    dependencyLockSha256: manifest.dependencyLockSha256,
    dependencyTreeSha256: manifest.dependencyTreeSha256,
    dependencyPackageCount: manifest.dependencyPackageCount,
    dependencyNodeModulesRealpath: dependencyNodeModules,
  };
}

function verifyStoredDependencyLock(lock, pkg) {
  const root = lock.packages?.[""];
  if (
    lock.lockfileVersion !== 3
    || root?.name !== pkg.name
    || root?.version !== pkg.version
    || pkg.scripts !== undefined
  ) {
    throw new Error("Managed dependency package-lock root does not match its scripts-free package.json.");
  }
  for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
    if (JSON.stringify(sortedRecord(root[field] ?? {})) !== JSON.stringify(sortedRecord(pkg[field] ?? {}))) {
      throw new Error(`Managed dependency package-lock ${field} does not match package.json.`);
    }
  }
}

async function verifyManagedReleasePayload(releasePath, releaseManifest, manifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`Managed release payload manifest is empty: ${releaseManifest}.`);
  }
  if (
    manifest.fileCount !== manifest.files.length
    || ((await stat(releasePath)).mode & 0o222) !== 0
    || ((await stat(releaseManifest)).mode & 0o222) !== 0
  ) {
    throw new Error(`Managed release payload metadata or read-only state changed: ${releasePath}.`);
  }
  const entries = [];
  const seen = new Set();
  const directories = new Set([releasePath]);
  for (const declared of manifest.files) {
    const path = normalizePayloadPath(declared?.path);
    if (path !== declared.path || seen.has(path)) {
      throw new Error(`Managed release payload contains an invalid or duplicate path: ${String(declared?.path)}.`);
    }
    seen.add(path);
    const filePath = join(releasePath, path);
    const fileStat = await lstat(filePath);
    const fileRealpath = await realpath(filePath);
    if (!fileStat.isFile() || !isWithin(releasePath, fileRealpath) || (fileStat.mode & 0o222) !== 0) {
      throw new Error(`Managed release payload path is not a read-only contained file: ${path}.`);
    }
    let directory = dirname(filePath);
    while (isWithin(releasePath, directory)) {
      directories.add(directory);
      if (directory === releasePath) break;
      directory = dirname(directory);
    }
    const content = await readFile(filePath);
    const digest = sha256(content);
    if (declared.size !== content.length || declared.sha256 !== digest) {
      throw new Error(`Managed release payload hash changed: ${path}.`);
    }
    entries.push({ path, size: content.length, sha256: digest });
  }
  for (const directory of directories) {
    if (((await stat(directory)).mode & 0o222) !== 0) {
      throw new Error(`Managed release payload directory is writable: ${directory}.`);
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const bundleSha256 = sha256(entries.map((entry) => (
    `${entry.path}\0${entry.size}\0${entry.sha256}\n`
  )).join(""));
  if (bundleSha256 !== manifest.bundleSha256) {
    throw new Error(`Managed release bundle digest changed: ${releasePath}.`);
  }
}

function sameRuntime(actual, expected) {
  return [
    "legacy",
    "binTargetRealpath",
    "releasePath",
    "releaseManifest",
    "releaseManifestSha256",
    "releaseId",
    "bundleSha256",
    "dependencyStoreId",
    "dependencyStoreRealpath",
    "dependencyManifest",
    "dependencyLockSha256",
    "dependencyTreeSha256",
    "dependencyPackageCount",
    "dependencyNodeModulesRealpath",
  ].every((field) => actual?.[field] === expected?.[field]);
}

function assertRuntimeMatches(actual, expected, label) {
  if (!sameRuntime(actual, expected)) {
    throw new Error(`${label} does not match its release/dependency manifest binding.`);
  }
}

async function assertBinRuntime(expected) {
  const actual = await inspectBinRuntime();
  assertRuntimeMatches(actual, expected, "managed executable");
  return actual;
}

function currentPointerForRuntime(runtime, {
  transitionStatus,
  transitionManifest,
  transitionManifestSha256,
  activationManifest = null,
  activationManifestSha256 = null,
  updatedAt,
}) {
  return {
    schemaVersion: "3.0.0",
    status: "ACTIVE_ACCEPTANCE_PASS",
    releasePath: runtime.releasePath,
    releaseManifest: runtime.releaseManifest,
    releaseManifestSha256: runtime.releaseManifestSha256,
    releaseId: runtime.releaseId,
    bundleSha256: runtime.bundleSha256,
    dependencyStoreId: runtime.dependencyStoreId,
    dependencyStoreRealpath: runtime.dependencyStoreRealpath,
    dependencyManifest: runtime.dependencyManifest,
    dependencyLockSha256: runtime.dependencyLockSha256,
    dependencyTreeSha256: runtime.dependencyTreeSha256,
    dependencyPackageCount: runtime.dependencyPackageCount,
    dependencyNodeModulesRealpath: runtime.dependencyNodeModulesRealpath,
    binPath,
    binLinkTarget: runtime.binLinkTarget,
    binTargetRealpath: runtime.binTargetRealpath,
    transitionStatus,
    transitionManifest,
    transitionManifestSha256,
    ...(activationManifest ? { activationManifest, activationManifestSha256 } : {}),
    updatedAt,
  };
}

function uncertainPointer({
  transitionStatus,
  transitionManifest,
  transitionManifestSha256,
  observedRuntime,
  updatedAt,
}) {
  return {
    schemaVersion: "3.0.0",
    status: "RUNTIME_STATE_UNCERTAIN",
    binPath,
    observedRuntime,
    transitionStatus,
    transitionManifest,
    transitionManifestSha256,
    updatedAt,
  };
}

async function verifyAlreadyActive(candidateRuntime, observedRuntime) {
  assertRuntimeMatches(observedRuntime, candidateRuntime, "already-active executable");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  await assertCurrentPointer(pointer, observedRuntime);
  const snapshot = await readServiceSnapshot();
  assertServiceProgram(snapshot);
  await assertBinRuntime(candidateRuntime);
  const local = await waitForHealth(localHealthUrl, 80, 250);
  const publicResults = [];
  for (let index = 0; index < 3; index += 1) {
    publicResults.push(await waitForHealth(publicHealthUrl, 20, 500));
  }
  return { status: "PASS", snapshot, local, public: publicResults };
}

async function assertCurrentPointer(pointer, runtime) {
  const expected = {
    schemaVersion: "3.0.0",
    status: "ACTIVE_ACCEPTANCE_PASS",
    releasePath: runtime.releasePath,
    releaseManifest: runtime.releaseManifest,
    releaseManifestSha256: runtime.releaseManifestSha256,
    releaseId: runtime.releaseId,
    bundleSha256: runtime.bundleSha256,
    dependencyStoreId: runtime.dependencyStoreId,
    dependencyStoreRealpath: runtime.dependencyStoreRealpath,
    dependencyManifest: runtime.dependencyManifest,
    dependencyLockSha256: runtime.dependencyLockSha256,
    dependencyTreeSha256: runtime.dependencyTreeSha256,
    dependencyPackageCount: runtime.dependencyPackageCount,
    dependencyNodeModulesRealpath: runtime.dependencyNodeModulesRealpath,
    binPath,
    binLinkTarget: runtime.binLinkTarget,
    binTargetRealpath: runtime.binTargetRealpath,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (pointer[field] !== value) {
      throw new Error(`ALREADY_ACTIVE_STATE_MISMATCH: current.json ${field} is inconsistent.`);
    }
  }
  if (!pointer.transitionManifest || !pointer.transitionManifestSha256) {
    throw new Error("ALREADY_ACTIVE_STATE_MISMATCH: transition manifest binding is missing.");
  }
  const transitionPath = await validateHistoryManifestPath(pointer.transitionManifest);
  if (await fileSha256(transitionPath) !== pointer.transitionManifestSha256) {
    throw new Error("ALREADY_ACTIVE_STATE_MISMATCH: transition manifest hash changed.");
  }
  const transition = JSON.parse(await readFile(transitionPath, "utf8"));
  if (transition.status !== pointer.transitionStatus) {
    throw new Error("ALREADY_ACTIVE_STATE_MISMATCH: transition status changed.");
  }
  const transitionRuntime = transition.activeRuntime ?? transition.restoredRuntime;
  assertRuntimeMatches(transitionRuntime, runtime, "current transition runtime");
  if (pointer.activationManifest) {
    const activationPath = await validateHistoryManifestPath(pointer.activationManifest, "ACTIVATION.json");
    if (await fileSha256(activationPath) !== pointer.activationManifestSha256) {
      throw new Error("ALREADY_ACTIVE_STATE_MISMATCH: activation manifest hash changed.");
    }
    const activation = JSON.parse(await readFile(activationPath, "utf8"));
    if (activation.status !== "ACTIVE_ACCEPTANCE_PASS" || activation.binPath !== binPath) {
      throw new Error("ALREADY_ACTIVE_STATE_MISMATCH: activation manifest is not active.");
    }
    assertRuntimeMatches(activation.activeRuntime, runtime, "current activation runtime");
  }
}

async function validateHistoryManifestPath(value, requiredBasename = null) {
  const historyRoot = join(releasesRoot, "history");
  const historyRealpath = await realpath(historyRoot);
  const manifestRealpath = await realpath(resolve(String(value)));
  const rel = relative(historyRealpath, manifestRealpath);
  const parts = rel.split(sep);
  if (
    !isWithin(historyRealpath, manifestRealpath)
    || parts.length !== 2
    || (requiredBasename && basename(manifestRealpath) !== requiredBasename)
  ) {
    throw new Error(`Transition manifest escapes release history: ${String(value)}.`);
  }
  return manifestRealpath;
}

async function assertServicePreflight(expectedRuntime) {
  validateServiceTestContract();
  await assertBinRuntime(expectedRuntime);
  const snapshot = await readServiceSnapshot();
  assertServiceProgram(snapshot);
  return snapshot;
}

function validateServiceTestContract() {
  if (testServiceStatePath) {
    if (
      !runtimeTestMode
      || process.env.DEVSPACE_SKIP_LAUNCHCTL !== "1"
      || !isWithin(dirname(releasesRoot), testServiceStatePath)
    ) {
      throw new Error("Injected service state is restricted to the isolated runtime test environment.");
    }
    return;
  }
  if (
    process.env.DEVSPACE_SKIP_LAUNCHCTL === "1"
    || process.env.DEVSPACE_SKIP_SERVICE_SWITCH === "1"
  ) {
    throw new Error("Production service verification cannot be skipped.");
  }
}

async function readServiceSnapshot({ requirePid = true } = {}) {
  validateServiceTestContract();
  let snapshot;
  if (testServiceStatePath) {
    const state = JSON.parse(await readFile(testServiceStatePath, "utf8"));
    snapshot = { program: state.program, pid: normalizePid(state.pid) };
  } else {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid === null) throw new Error("Cannot resolve the current user ID for launchctl.");
    const output = execFileSync("launchctl", ["print", `gui/${uid}/${serviceLabel}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const program = output.match(/^\s*program = (.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
    const pid = normalizePid(output.match(/^\s*pid = (\d+)$/m)?.[1]);
    snapshot = { program, pid };
  }
  if (typeof snapshot.program !== "string" || !snapshot.program) {
    throw new Error(`Cannot resolve launchd program for ${serviceLabel}.`);
  }
  if (requirePid && snapshot.pid === null) {
    throw new Error(`Launchd service ${serviceLabel} has no running PID.`);
  }
  return snapshot;
}

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function assertServiceProgram(snapshot) {
  if (!isAbsolute(snapshot.program) || resolve(snapshot.program) !== binPath) {
    throw new Error(
      `Launchd service ${serviceLabel} is bound to ${String(snapshot.program)}, expected ${binPath}.`,
    );
  }
}

async function triggerServiceRestart() {
  if (testServiceStatePath) {
    const state = JSON.parse(await readFile(testServiceStatePath, "utf8"));
    const remainingFailures = Number(state.failRestarts ?? 0);
    if (remainingFailures > 0) {
      state.failRestarts = remainingFailures - 1;
      await writeJson(testServiceStatePath, state);
      throw new Error("Injected launchd restart failure.");
    }
    state.pid = (normalizePid(state.pid) ?? 1000) + 1;
    state.restartCount = Number(state.restartCount ?? 0) + 1;
    await writeJson(testServiceStatePath, state);
    return;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) throw new Error("Cannot resolve the current user ID for launchctl.");
  execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${serviceLabel}`], { stdio: "pipe" });
}

async function waitForChangedServicePid(previousPid) {
  let last = null;
  for (let attempt = 1; attempt <= 80; attempt += 1) {
    try {
      last = await readServiceSnapshot({ requirePid: false });
      if (last.pid !== null && (previousPid === null || last.pid !== previousPid)) {
        return { ...last, attempt };
      }
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
    }
    await delay(250);
  }
  throw new Error(
    `Launchd service ${serviceLabel} did not acquire a changed PID: ${JSON.stringify(last)}.`,
  );
}

async function safeInspectBinRuntime() {
  try {
    return await inspectBinRuntime();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function fileSha256(path) {
  return sha256(await readFile(path));
}

async function waitForHealth(url, attempts, delayMs, child) {
  let lastError = "not attempted";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (child && child.exitCode !== null) throw new Error(`candidate exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
      const body = await response.json();
      if (response.status === 200 && body?.ok === true && body?.name === "devspace") {
        return { attempt, httpStatus: response.status, body };
      }
      lastError = `HTTP ${response.status} ${JSON.stringify(body)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(delayMs);
  }
  throw new Error(`Health acceptance failed for ${url}: ${lastError}`);
}

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!port) throw new Error("Unable to allocate a shadow-test port.");
  return port;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    delay(5000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function atomicSymlink(target, linkPath) {
  const temporaryPath = join(dirname(linkPath), `.${basename(linkPath)}.release-${process.pid}-${Date.now()}`);
  await symlink(target, temporaryPath);
  try {
    await rename(temporaryPath, linkPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function makeReadOnly(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await makeReadOnly(path);
      await chmod(path, 0o555);
    } else {
      await chmod(path, path.endsWith(`${sep}dist${sep}cli.js`) ? 0o555 : 0o444);
    }
  }
  await chmod(root, 0o555);
}

async function makeWritable(root) {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) return;
  if (!rootStat.isDirectory()) {
    await chmod(root, root.endsWith(`${sep}dist${sep}cli.js`) ? 0o700 : 0o600);
    return;
  }
  await chmod(root, 0o755);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    await makeWritable(join(root, entry.name));
  }
}

async function writeJson(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`,
  );
  let handle = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (
      runtimeTestMode
      && !jsonRenameFailureInjected
      && process.env.DEVSPACE_TEST_FAIL_JSON_RENAME_ONCE === basename(path)
    ) {
      jsonRenameFailureInjected = true;
      throw new Error(`Injected atomic JSON rename failure for ${basename(path)}.`);
    }
    await rename(temporaryPath, path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function stagedSummary(staged) {
  return {
    releasePath: staged.releasePath,
    releaseManifest: staged.manifestPath,
    releaseId: staged.manifest.releaseId,
    bundleSha256: staged.manifest.bundleSha256,
    fileCount: staged.manifest.fileCount,
    dependencyLockSha256: staged.manifest.dependencyLockSha256,
    dependencyTreeSha256: staged.manifest.dependencyTreeSha256,
    dependencyStore: staged.manifest.dependencyStore,
    reused: staged.reused,
    shadow: staged.manifest.shadow,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tail(value, length) {
  return value.length > length ? value.slice(-length) : value;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
