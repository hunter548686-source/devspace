#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const installedRoot = resolve(
  process.env.DEVSPACE_LEGACY_INSTALLED_ROOT
    ?? join(homedir(), ".hermes", "node", "lib", "node_modules", "@waishnav", "devspace"),
);
const sourceDependencyPath = resolve(
  process.env.DEVSPACE_LEGACY_DEPENDENCY_PATH
    ?? join(installedRoot, "node_modules"),
);
const releasesRoot = resolve(
  process.env.DEVSPACE_RELEASES_ROOT
    ?? join(homedir(), ".devspace", "runtime", "releases"),
);
const dependencyStoresRoot = resolve(
  process.env.DEVSPACE_DEPENDENCY_STORES_ROOT
    ?? join(dirname(releasesRoot), "dependencies"),
);
const runtimeAuthorityRoot = resolve(
  process.env.DEVSPACE_RUNTIME_AUTHORITY_ROOT
    ?? join(homedir(), ".devspace", "runtime"),
);
const globalBinPath = resolve(
  process.env.DEVSPACE_LEGACY_BIN_PATH
    ?? join(homedir(), ".hermes", "node", "bin", "devspace"),
);

await main();

async function main() {
  assertWithin(runtimeAuthorityRoot, releasesRoot);
  assertWithin(runtimeAuthorityRoot, dependencyStoresRoot);
  const sourceReleasePath = await resolveSourceRelease();
  const originalManifestPath = join(sourceReleasePath, "RELEASE.json");
  const originalManifestContent = await readFile(originalManifestPath);
  const originalManifest = JSON.parse(originalManifestContent.toString("utf8"));
  const sourceDependencySummary = await treeSummary(sourceDependencyPath);
  const sourceDependencyContentSummary = await treeSummary(sourceDependencyPath, { includeModes: false });
  const dependencyStore = await publishDependencyStore(
    sourceDependencySummary,
    sourceDependencyContentSummary,
  );
  const rollbackRelease = await publishRollbackRelease({
    sourceReleasePath,
    originalManifest,
    originalManifestSha256: sha256(originalManifestContent),
    dependencyStore,
  });
  console.log(JSON.stringify({
    status: "LEGACY_ROLLBACK_SELF_CONTAINED_PASS",
    sourceReleasePath,
    sourceDependencyPath,
    sourceDependencyTreeSha256: sourceDependencySummary.sha256,
    dependencyStore,
    rollbackRelease,
  }, null, 2));
}

async function resolveSourceRelease() {
  const explicit = process.env.DEVSPACE_LEGACY_RELEASE_PATH;
  let releasePath;
  if (explicit) {
    releasePath = await realpath(resolve(explicit));
  } else {
    const binStat = await lstat(globalBinPath);
    if (!binStat.isSymbolicLink()) {
      throw new Error(`Legacy executable is not a symlink: ${globalBinPath}`);
    }
    const target = resolve(dirname(globalBinPath), await readlink(globalBinPath));
    releasePath = await realpath(resolve(target, "..", ".."));
  }
  const releasesRealpath = await realpath(releasesRoot);
  assertWithin(releasesRealpath, releasePath);
  if (dirname(releasePath) !== releasesRealpath) {
    throw new Error(`Legacy release is not a direct child of ${releasesRealpath}: ${releasePath}`);
  }
  return releasePath;
}

async function publishDependencyStore(sourceSummary, sourceContentSummary) {
  await mkdir(dependencyStoresRoot, { recursive: true });
  const stagingPath = join(
    dependencyStoresRoot,
    `.legacy-managed.staging-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(stagingPath, { recursive: false, mode: 0o700 });
  try {
    // Use archive semantics so the pre-publication digest can prove an exact
    // copy, including Unix modes. Publication then removes write bits, so
    // subsequent verification separately binds paths, links and file bytes.
    execFileSync("/bin/cp", ["-a", sourceDependencyPath, join(stagingPath, "node_modules")], {
      stdio: "pipe",
    });
    const installedPackageContent = await readFile(join(installedRoot, "package.json"), "utf8");
    const installedPackage = JSON.parse(installedPackageContent);
    const storePackage = structuredClone(installedPackage);
    delete storePackage.scripts;
    await writeJson(join(stagingPath, "package.json"), storePackage);
    const copied = await treeSummary(join(stagingPath, "node_modules"));
    if (copied.sha256 !== sourceSummary.sha256) {
      throw new Error("Legacy dependency copy digest mismatch.");
    }
    const copiedContent = await treeSummary(join(stagingPath, "node_modules"), { includeModes: false });
    if (copiedContent.sha256 !== sourceContentSummary.sha256) {
      throw new Error("Legacy dependency content digest mismatch.");
    }
    execFileSync("npm", ["shrinkwrap", "--ignore-scripts", "--offline"], {
      cwd: stagingPath,
      env: { ...process.env, npm_config_update_notifier: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    });
    const shrinkwrapPath = join(stagingPath, "npm-shrinkwrap.json");
    const lockPath = join(stagingPath, "package-lock.json");
    const lockContent = await readFile(shrinkwrapPath, "utf8");
    await rename(shrinkwrapPath, lockPath);
    const lock = JSON.parse(lockContent);
    verifyLockRoot(lock, storePackage);
    const installedPackagePathCount = await verifyLockCoversInstalledTree(stagingPath, lock);
    const dependencySummary = dependencyTreeSummary(stagingPath);
    verifyDependencyEntrypoints(stagingPath);
    const packageJsonContent = await readFile(join(stagingPath, "package.json"), "utf8");
    const packageLockSha256 = sha256(lockContent);
    const packageJsonSha256 = sha256(packageJsonContent);
    const address = sha256([
      packageLockSha256,
      dependencySummary.sha256,
      copiedContent.sha256,
      process.platform,
      process.arch,
      process.versions.modules ?? "unknown",
    ].join("\0"));
    const id = `legacy-npm-${address.slice(0, 24)}`;
    const storePath = join(dependencyStoresRoot, id);
    const nodeModulesPath = join(storePath, "node_modules");
    const manifestPath = join(storePath, "DEPENDENCIES.json");
    await writeJson(join(stagingPath, "DEPENDENCIES.json"), {
      schemaVersion: "1.0.0",
      status: "IMMUTABLE_DEPENDENCY_STORE_PASS",
      createdAt: new Date().toISOString(),
      id,
      storePath,
      nodeModulesPath,
      origin: "legacy-installed-tree-snapshot",
      lockProvenance: "npm-shrinkwrap-from-copied-installed-tree",
      sourcePackage: `${storePackage.name}@${storePackage.version}`,
      sourceInstalledRoot: installedRoot,
      sourceNodeModulesPath: sourceDependencyPath,
      sourcePackageJsonSha256: sha256(installedPackageContent),
      packageJsonSha256,
      packageLockSha256,
      dependencyTreeSha256: dependencySummary.sha256,
      dependencyPackageCount: dependencySummary.packageCount,
      installedPackagePathCount,
      sourceTreeSha256: copied.sha256,
      contentTreeSha256: copiedContent.sha256,
      fileCount: copied.fileCount,
      symlinkCount: copied.symlinkCount,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      nodeAbi: process.versions.modules ?? null,
      npmVersion: execFileSync("npm", ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    });
    execFileSync("/bin/chmod", ["-R", "a-w", stagingPath], { stdio: "pipe" });
    if (await exists(storePath)) {
      await execFile("/bin/chmod", ["-R", "u+w", stagingPath]).catch(() => {});
      await rm(stagingPath, { recursive: true, force: true });
      return verifyManagedDependencyStore(storePath, {
        id,
        packageJsonSha256,
        packageLockSha256,
        dependencyTreeSha256: dependencySummary.sha256,
        dependencyPackageCount: dependencySummary.packageCount,
        contentTreeSha256: copiedContent.sha256,
        reused: true,
      });
    }
    await rename(stagingPath, storePath);
    return verifyManagedDependencyStore(storePath, {
      id,
      packageJsonSha256,
      packageLockSha256,
      dependencyTreeSha256: dependencySummary.sha256,
      dependencyPackageCount: dependencySummary.packageCount,
      contentTreeSha256: copiedContent.sha256,
      reused: false,
    });
  } catch (error) {
    await execFile("/bin/chmod", ["-R", "u+w", stagingPath]).catch(() => {});
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function verifyManagedDependencyStore(storePath, expected) {
  const storeRealpath = await realpath(storePath);
  const nodeModulesPath = await realpath(join(storeRealpath, "node_modules"));
  const manifestPath = await realpath(join(storeRealpath, "DEPENDENCIES.json"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const packageJsonContent = await readFile(join(storeRealpath, "package.json"), "utf8");
  const packageJson = JSON.parse(packageJsonContent);
  const lockContent = await readFile(join(storeRealpath, "package-lock.json"), "utf8");
  const lock = JSON.parse(lockContent);
  verifyLockRoot(lock, packageJson);
  const installedPackagePathCount = await verifyLockCoversInstalledTree(storeRealpath, lock);
  const dependencySummary = dependencyTreeSummary(storeRealpath);
  const content = await treeSummary(nodeModulesPath, { includeModes: false });
  verifyDependencyEntrypoints(storeRealpath);
  const storeMode = (await stat(storeRealpath)).mode;
  const nodeModulesMode = (await stat(nodeModulesPath)).mode;
  if (
    packageJson.scripts !== undefined
    || manifest.schemaVersion !== "1.0.0"
    || manifest.status !== "IMMUTABLE_DEPENDENCY_STORE_PASS"
    || manifest.id !== expected.id
    || manifest.storePath !== storeRealpath
    || manifest.nodeModulesPath !== nodeModulesPath
    || manifest.origin !== "legacy-installed-tree-snapshot"
    || manifest.lockProvenance !== "npm-shrinkwrap-from-copied-installed-tree"
    || manifest.packageJsonSha256 !== sha256(packageJsonContent)
    || manifest.packageLockSha256 !== sha256(lockContent)
    || manifest.dependencyTreeSha256 !== dependencySummary.sha256
    || manifest.dependencyPackageCount !== dependencySummary.packageCount
    || manifest.installedPackagePathCount !== installedPackagePathCount
    || manifest.contentTreeSha256 !== content.sha256
    || expected.packageJsonSha256 !== manifest.packageJsonSha256
    || expected.packageLockSha256 !== manifest.packageLockSha256
    || expected.dependencyTreeSha256 !== manifest.dependencyTreeSha256
    || expected.dependencyPackageCount !== manifest.dependencyPackageCount
    || expected.contentTreeSha256 !== manifest.contentTreeSha256
    || (storeMode & 0o222) !== 0
    || (nodeModulesMode & 0o222) !== 0
  ) {
    throw new Error(`Managed legacy dependency store verification failed: ${storePath}`);
  }
  return {
    id: manifest.id,
    storePath: storeRealpath,
    nodeModulesPath,
    manifestPath,
    packageJsonSha256: manifest.packageJsonSha256,
    lockSha256: manifest.packageLockSha256,
    treeSha256: manifest.dependencyTreeSha256,
    packageCount: manifest.dependencyPackageCount,
    contentTreeSha256: manifest.contentTreeSha256,
    fileCount: manifest.fileCount,
    symlinkCount: manifest.symlinkCount,
    platform: manifest.platform,
    arch: manifest.arch,
    nodeAbi: manifest.nodeAbi,
    reused: expected.reused,
  };
}

function verifyLockRoot(lock, pkg) {
  const root = lock.packages?.[""];
  if (
    lock.lockfileVersion !== 3
    || root?.name !== pkg.name
    || root?.version !== pkg.version
    || pkg.scripts !== undefined
  ) {
    throw new Error("Generated legacy package-lock root is not bound to the scripts-free package.json.");
  }
  for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
    if (JSON.stringify(sortedRecord(root[field] ?? {})) !== JSON.stringify(sortedRecord(pkg[field] ?? {}))) {
      throw new Error(`Generated legacy package-lock ${field} does not match package.json.`);
    }
  }
}

async function verifyLockCoversInstalledTree(storePath, lock) {
  const installed = await collectInstalledPackageVersions(storePath);
  for (const [path, version] of installed) {
    const entry = lock.packages?.[path];
    if (!entry || entry.version !== version || entry.link === true) {
      throw new Error(`Generated legacy package-lock does not bind installed package ${path}@${version}.`);
    }
    const resolvedValue = String(entry.resolved ?? "");
    if (resolvedValue.startsWith("file:") || resolvedValue.startsWith("/") || resolvedValue.includes("../")) {
      throw new Error(`Generated legacy package-lock contains a non-portable resolution for ${path}.`);
    }
  }
  return installed.size;
}

async function collectInstalledPackageVersions(storePath) {
  const packages = new Map();
  async function visitNodeModules(nodeModulesPath, relativeNodeModules) {
    const iterator = await opendir(nodeModulesPath);
    for await (const entry of iterator) {
      if (entry.name === ".bin") continue;
      const entryPath = join(nodeModulesPath, entry.name);
      if (entry.name.startsWith("@")) {
        if (!entry.isDirectory()) throw new Error(`Unsupported package scope entry: ${entryPath}`);
        const scoped = await opendir(entryPath);
        for await (const child of scoped) {
          if (!child.isDirectory()) throw new Error(`Unsupported scoped package entry: ${join(entryPath, child.name)}`);
          await recordPackage(join(entryPath, child.name), `${relativeNodeModules}/${entry.name}/${child.name}`);
        }
      } else if (entry.isDirectory()) {
        await recordPackage(entryPath, `${relativeNodeModules}/${entry.name}`);
      } else if (entry.isSymbolicLink()) {
        throw new Error(`Installed dependency tree contains an unsupported package link: ${entryPath}`);
      }
    }
  }
  async function recordPackage(packagePath, relativePath) {
    const pkg = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8"));
    if (typeof pkg.version !== "string") throw new Error(`Installed package has no version: ${packagePath}`);
    packages.set(relativePath, pkg.version);
    const nested = join(packagePath, "node_modules");
    if (await exists(nested)) await visitNodeModules(nested, `${relativePath}/node_modules`);
  }
  await visitNodeModules(join(storePath, "node_modules"), "node_modules");
  return packages;
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

function sortedRecord(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function verifyDependencyEntrypoints(storePath) {
  const requireFromStore = createRequire(join(storePath, "package.json"));
  const Database = requireFromStore("better-sqlite3");
  const database = new Database(":memory:");
  database.exec("select 1");
  database.close();
  const pty = requireFromStore("node-pty");
  if (typeof pty.spawn !== "function") throw new Error("node-pty spawn is unavailable.");
}

async function publishRollbackRelease({
  sourceReleasePath,
  originalManifest,
  originalManifestSha256,
  dependencyStore,
}) {
  const id = `waishnav-devspace-1.0.6-legacy-managed-${String(originalManifest.bundleSha256).slice(0, 12)}-${dependencyStore.lockSha256.slice(0, 12)}-${dependencyStore.treeSha256.slice(0, 12)}`;
  const releasePath = join(releasesRoot, id);
  const manifestPath = join(releasePath, "RELEASE.json");
  if (await exists(releasePath)) {
    await verifyPayloadFiles(releasePath, originalManifest.files ?? []);
    if (await realpath(join(releasePath, "node_modules")) !== dependencyStore.nodeModulesPath) {
      throw new Error(`Existing rollback release dependency link mismatch: ${releasePath}`);
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      manifest.status !== "STAGED_SHADOW_PASS"
      || manifest.releaseId !== id
      || manifest.originalReleaseManifestSha256 !== originalManifestSha256
      || manifest.runtimeDependencies !== dependencyStore.nodeModulesPath
      || manifest.dependencyLockSha256 !== dependencyStore.lockSha256
      || manifest.dependencyTreeSha256 !== dependencyStore.treeSha256
      || manifest.dependencyPackageCount !== dependencyStore.packageCount
    ) {
      throw new Error(`Existing rollback release manifest mismatch: ${releasePath}`);
    }
    return { releasePath, manifestPath, releaseId: id, shadow: manifest.shadow, reused: true };
  }

  const stagingPath = `${releasePath}.staging-${process.pid}-${Date.now()}`;
  await cp(sourceReleasePath, stagingPath, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
  });
  try {
    await chmod(stagingPath, 0o755);
    await rm(join(stagingPath, "node_modules"), { force: true });
    await symlink(dependencyStore.nodeModulesPath, join(stagingPath, "node_modules"), "dir");
    await verifyPayloadFiles(stagingPath, originalManifest.files ?? []);
    const shadow = await verifyShadowRuntime(stagingPath);
    await chmod(join(stagingPath, "RELEASE.json"), 0o600);
    await writeJson(join(stagingPath, "RELEASE.json"), {
      ...originalManifest,
      schemaVersion: "2.0.0",
      status: "STAGED_SHADOW_PASS",
      releaseId: id,
      createdAt: new Date().toISOString(),
      sourceRoot: null,
      originalReleasePath: sourceReleasePath,
      originalReleaseManifestSha256: originalManifestSha256,
      runtimeDependencies: dependencyStore.nodeModulesPath,
      dependencyLockSha256: dependencyStore.lockSha256,
      dependencyTreeSha256: dependencyStore.treeSha256,
      dependencyPackageCount: dependencyStore.packageCount,
      dependencyStore: {
        id: dependencyStore.id,
        storeRealpath: dependencyStore.storePath,
        manifestRealpath: dependencyStore.manifestPath,
        nodeModulesRealpath: dependencyStore.nodeModulesPath,
        platform: dependencyStore.platform,
        arch: dependencyStore.arch,
        nodeAbi: dependencyStore.nodeAbi,
      },
      shadow,
    });
    execFileSync("/bin/chmod", ["-R", "a-w", stagingPath], { stdio: "pipe" });
    await rename(stagingPath, releasePath);
    return {
      releasePath: await realpath(releasePath),
      manifestPath: await realpath(manifestPath),
      releaseId: id,
      shadow,
      reused: false,
    };
  } catch (error) {
    await execFile("/bin/chmod", ["-R", "u+w", stagingPath]).catch(() => {});
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function verifyPayloadFiles(root, files) {
  for (const entry of files) {
    if (sha256(await readFile(join(root, entry.path))) !== entry.sha256) {
      throw new Error(`Legacy rollback payload mismatch: ${entry.path}`);
    }
  }
}

async function verifyShadowRuntime(releasePath) {
  const configRoot = await mkdtemp(join(tmpdir(), "devspace-legacy-rollback-shadow-"));
  const port = await availablePort();
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  await writeJson(join(configRoot, "config.json"), {
    host: "127.0.0.1",
    port,
    allowedRoots: [dirname(releasesRoot)],
    publicBaseUrl,
    allowedHosts: ["127.0.0.1", "localhost"],
    stateDir: join(configRoot, "state"),
    worktreeRoot: join(configRoot, "worktrees"),
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
    for (let attempt = 1; attempt <= 80; attempt += 1) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`${publicBaseUrl}/healthz`, { signal: AbortSignal.timeout(1000) });
        const body = await response.json();
        if (response.status === 200 && body?.ok === true && body?.name === "devspace") {
          return { status: "PASS", attempt, endpoint: `${publicBaseUrl}/healthz` };
        }
      } catch {}
      await delay(100);
    }
    throw new Error(`Legacy rollback shadow start failed. ${output}`);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      delay(5000),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(configRoot, { recursive: true, force: true });
  }
}

async function treeSummary(root, { includeModes = true } = {}) {
  const entries = [];
  async function walk(directory, prefix = "") {
    const iterator = await opendir(directory);
    for await (const item of iterator) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      const path = join(directory, item.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        entries.push(`L\0${rel}\0${await readlink(path)}\n`);
      } else if (info.isDirectory()) {
        entries.push(includeModes
          ? `D\0${rel}\0${info.mode & 0o777}\n`
          : `D\0${rel}\n`);
        await walk(path, rel);
      } else if (info.isFile()) {
        entries.push(includeModes
          ? `F\0${rel}\0${info.size}\0${info.mode & 0o777}\0${sha256(await readFile(path))}\n`
          : `F\0${rel}\0${info.size}\0${sha256(await readFile(path))}\n`);
      } else {
        throw new Error(`Unsupported dependency entry: ${path}`);
      }
    }
  }
  await walk(root);
  entries.sort();
  return {
    sha256: sha256(entries.join("")),
    entryCount: entries.length,
    fileCount: entries.filter((entry) => entry.startsWith("F\0")).length,
    symlinkCount: entries.filter((entry) => entry.startsWith("L\0")).length,
  };
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
  if (!port) throw new Error("Unable to allocate a shadow port.");
  return port;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tail(value, size) {
  return value.length <= size ? value : value.slice(-size);
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function assertWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error(`Path escapes expected runtime root: ${child}`);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function execFile(file, args) {
  const { execFile: exec } = await import("node:child_process");
  await new Promise((resolvePromise, reject) => {
    exec(file, args, { encoding: "utf8" }, (error) => error ? reject(error) : resolvePromise());
  });
}
