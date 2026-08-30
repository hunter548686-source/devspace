#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const releasesRoot = resolve(
  process.env.DEVSPACE_RELEASES_ROOT
    ?? join(homedir(), ".devspace", "runtime", "releases"),
);
const dependencyStoresRoot = resolve(
  process.env.DEVSPACE_DEPENDENCY_STORES_ROOT
    ?? join(dirname(releasesRoot), "dependencies"),
);
const pointerPath = join(releasesRoot, "current.json");
const serviceLabel = process.env.DEVSPACE_SERVICE_LABEL ?? "com.liheng.devspace";
const localHealthUrl = process.env.DEVSPACE_LOCAL_HEALTH_URL
  ?? "http://127.0.0.1:7676/healthz";
const publicHealthUrl = process.env.DEVSPACE_PUBLIC_HEALTH_URL
  ?? "https://devspace.chinacareglobal.com/healthz";
const runtimeTestMode = process.env.DEVSPACE_RUNTIME_TEST_MODE === "1";
const testServiceStatePath = process.env.DEVSPACE_TEST_SERVICE_STATE_PATH
  ? resolve(process.env.DEVSPACE_TEST_SERVICE_STATE_PATH)
  : null;
let jsonRenameFailureInjected = false;

await main();

async function main() {
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  if (!pointer.activationManifest || !pointer.binPath) {
    throw new Error("Runtime release pointer does not describe a rollback-capable activation.");
  }
  const binPath = resolve(pointer.binPath);
  const activeRuntime = await inspectBinRuntime(binPath);
  const activation = await assertCurrentPointer(pointer, activeRuntime, binPath);
  const previousRuntime = await inspectManagedRuntimeTarget(
    activation.previousRuntime?.binTargetRealpath,
    binPath,
  );
  assertRuntimeMatches(previousRuntime, activation.previousRuntime, "previous runtime");
  await assertServicePreflight(activeRuntime, binPath);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const historyRoot = join(
    releasesRoot,
    "history",
    `${stamp}-rollback-${randomBytes(4).toString("hex")}`,
  );
  const rollbackPath = join(historyRoot, "ROLLBACK.json");
  const rollback = {
    schemaVersion: "3.0.0",
    status: "ROLLING_BACK",
    createdAt: new Date().toISOString(),
    binPath,
    serviceLabel,
    sourceActivationManifest: pointer.activationManifest,
    sourceActivationManifestSha256: pointer.activationManifestSha256,
    fromRuntime: activeRuntime,
    toRuntime: previousRuntime,
  };
  await writeJson(rollbackPath, rollback);

  try {
    await atomicSymlink(previousRuntime.binTargetRealpath, binPath);
    if (runtimeTestMode && process.env.DEVSPACE_TEST_CRASH_AFTER_ROLLBACK_SWITCH === "1") {
      process.exit(87);
    }
    let restoredRuntime = await inspectBinRuntime(binPath);
    assertRuntimeMatches(restoredRuntime, previousRuntime, "rollback executable");
    const service = await restartAndVerify({ expectedRuntime: previousRuntime, binPath });
    restoredRuntime = await inspectBinRuntime(binPath);
    rollback.status = "ROLLED_BACK_ACCEPTANCE_PASS";
    rollback.rolledBackAt = new Date().toISOString();
    rollback.service = service;
    rollback.restoredRuntime = restoredRuntime;
    await writeJson(rollbackPath, rollback);
    const rollbackSha256 = await fileSha256(rollbackPath);
    await writeJson(pointerPath, currentPointerForRuntime(restoredRuntime, binPath, {
      transitionStatus: rollback.status,
      transitionManifest: rollbackPath,
      transitionManifestSha256: rollbackSha256,
      updatedAt: rollback.rolledBackAt,
    }));
    console.log(JSON.stringify({
      status: rollback.status,
      binPath,
      restoredBinLinkTarget: restoredRuntime.binLinkTarget,
      releasePath: restoredRuntime.releasePath,
      releaseManifest: restoredRuntime.releaseManifest,
      rollbackManifest: rollbackPath,
      sourceActivationManifest: pointer.activationManifest,
      service,
    }, null, 2));
  } catch (error) {
    const rollbackError = error instanceof Error ? error.message : String(error);
    let compensationError = null;
    let compensationService = null;
    let restoredRuntime = null;
    try {
      await atomicSymlink(activeRuntime.binTargetRealpath, binPath);
      restoredRuntime = await inspectBinRuntime(binPath);
      assertRuntimeMatches(restoredRuntime, activeRuntime, "compensated active executable");
      compensationService = await restartAndVerify({ expectedRuntime: activeRuntime, binPath });
      restoredRuntime = await inspectBinRuntime(binPath);
    } catch (compensationFailure) {
      compensationError = compensationFailure instanceof Error
        ? compensationFailure.message
        : String(compensationFailure);
    }
    rollback.status = compensationError
      ? "ROLLBACK_FAILED_COMPENSATION_FAILED"
      : "ROLLBACK_FAILED_ACTIVE_RELEASE_RESTORED";
    rollback.rollbackFailedAt = new Date().toISOString();
    rollback.rollbackError = rollbackError;
    rollback.compensationError = compensationError;
    rollback.compensationService = compensationService;
    rollback.restoredRuntime = restoredRuntime;
    rollback.observedRuntime = await safeInspectBinRuntime(binPath);
    await writeJson(rollbackPath, rollback);
    const rollbackSha256 = await fileSha256(rollbackPath);
    if (compensationError) {
      await writeJson(pointerPath, uncertainPointer(binPath, {
        transitionStatus: rollback.status,
        transitionManifest: rollbackPath,
        transitionManifestSha256: rollbackSha256,
        observedRuntime: rollback.observedRuntime,
        updatedAt: rollback.rollbackFailedAt,
      }));
    } else {
      await writeJson(pointerPath, currentPointerForRuntime(restoredRuntime, binPath, {
        transitionStatus: rollback.status,
        transitionManifest: rollbackPath,
        transitionManifestSha256: rollbackSha256,
        activationManifest: pointer.activationManifest,
        activationManifestSha256: pointer.activationManifestSha256,
        updatedAt: rollback.rollbackFailedAt,
      }));
    }
    throw new Error(
      `${rollback.status}: ${rollbackError}${compensationError ? `; compensation: ${compensationError}` : ""}`,
    );
  }
}

async function assertCurrentPointer(pointer, runtime, binPath) {
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
      throw new Error(`Refusing rollback: current.json ${field} is inconsistent.`);
    }
  }
  if (!pointer.activationManifestSha256) {
    throw new Error("Refusing rollback: activation manifest hash binding is missing.");
  }
  const activationPath = await validateHistoryManifestPath(
    pointer.activationManifest,
    "ACTIVATION.json",
  );
  if (await fileSha256(activationPath) !== pointer.activationManifestSha256) {
    throw new Error("Refusing rollback: activation manifest hash changed.");
  }
  const activation = JSON.parse(await readFile(activationPath, "utf8"));
  if (activation.status !== "ACTIVE_ACCEPTANCE_PASS" || activation.binPath !== binPath) {
    throw new Error(`Refusing rollback from activation status ${String(activation.status)}.`);
  }
  assertRuntimeMatches(activation.activeRuntime, runtime, "active activation runtime");
  assertRuntimeMatches(activation.candidateRuntime, runtime, "candidate activation runtime");

  if (!pointer.transitionManifest || !pointer.transitionManifestSha256) {
    throw new Error("Refusing rollback: current transition manifest binding is missing.");
  }
  const transitionPath = await validateHistoryManifestPath(pointer.transitionManifest);
  if (await fileSha256(transitionPath) !== pointer.transitionManifestSha256) {
    throw new Error("Refusing rollback: transition manifest hash changed.");
  }
  const transition = JSON.parse(await readFile(transitionPath, "utf8"));
  if (transition.status !== pointer.transitionStatus) {
    throw new Error("Refusing rollback: transition status changed.");
  }
  const transitionRuntime = transition.activeRuntime ?? transition.restoredRuntime;
  assertRuntimeMatches(transitionRuntime, runtime, "current transition runtime");
  return activation;
}

async function inspectBinRuntime(binPath) {
  let linkStat;
  try {
    linkStat = await lstat(binPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing rollback: managed executable ${binPath} is unavailable: ${detail}`);
  }
  if (!linkStat.isSymbolicLink()) {
    throw new Error(`Refusing rollback: ${binPath} is not a symlink.`);
  }
  return inspectManagedRuntimeTarget(await readlink(binPath), binPath);
}

async function inspectManagedRuntimeTarget(binLinkTarget, binPath) {
  if (typeof binLinkTarget !== "string" || !binLinkTarget) {
    throw new Error("Managed executable target binding is missing.");
  }
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

function normalizePayloadPath(value) {
  const path = String(value).replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path === ".." || path.startsWith("../") || path.includes("/../")) {
    throw new Error(`Unsafe managed release payload path: ${JSON.stringify(value)}.`);
  }
  return path;
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
  return { name: node.name ?? fallbackName, version: node.version ?? null, dependencies };
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
  const requireFromStore = createRequire(join(storePath, "package.json"));
  const nodeModules = realpathSync(join(storePath, "node_modules"));
  for (const name of directDependencies) {
    const packageJson = realpathSync(join(nodeModules, ...name.split("/"), "package.json"));
    if (!isWithin(nodeModules, packageJson)) throw new Error(`Dependency escapes store: ${name}`);
  }
  const Database = requireFromStore("better-sqlite3");
  const database = new Database(":memory:");
  database.exec("select 1");
  database.close();
  const pty = requireFromStore("node-pty");
  if (typeof pty.spawn !== "function") throw new Error("node-pty spawn is unavailable.");
}

function sortedRecord(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function sameRuntime(actual, expected) {
  return [
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

function currentPointerForRuntime(runtime, binPath, {
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

function uncertainPointer(binPath, {
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

async function restartAndVerify({ expectedRuntime, binPath }) {
  await assertBinRuntime(expectedRuntime, binPath);
  const before = await readServiceSnapshot({ requirePid: false });
  assertServiceProgram(before, binPath);
  await triggerServiceRestart();
  const after = await waitForChangedServicePid(before.pid);
  assertServiceProgram(after, binPath);
  await assertBinRuntime(expectedRuntime, binPath);
  const local = await waitForHealth(localHealthUrl, 80, 250, "local");
  const publicResults = [];
  for (let index = 0; index < 3; index += 1) {
    publicResults.push(await waitForHealth(publicHealthUrl, 20, 500, "public"));
  }
  return { status: "PASS", before, after, local, public: publicResults };
}

async function assertBinRuntime(expected, binPath) {
  const actual = await inspectBinRuntime(binPath);
  assertRuntimeMatches(actual, expected, "managed executable");
  return actual;
}

async function assertServicePreflight(expectedRuntime, binPath) {
  validateServiceTestContract();
  await assertBinRuntime(expectedRuntime, binPath);
  const snapshot = await readServiceSnapshot();
  assertServiceProgram(snapshot, binPath);
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

function assertServiceProgram(snapshot, binPath) {
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

async function waitForHealth(url, attempts, intervalMs, label) {
  let lastError = "not attempted";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
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
    await delay(intervalMs);
  }
  throw new Error(`Rollback ${label} health acceptance failed: ${lastError}`);
}

async function atomicSymlink(target, linkPath) {
  const temporaryPath = join(
    dirname(linkPath),
    `.${basename(linkPath)}.rollback-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  await symlink(target, temporaryPath);
  try {
    await rename(temporaryPath, linkPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
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

async function safeInspectBinRuntime(binPath) {
  try {
    return await inspectBinRuntime(binPath);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
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

async function fileSha256(path) {
  return sha256(await readFile(path));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
