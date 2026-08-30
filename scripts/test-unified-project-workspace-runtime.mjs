#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import {
  access,
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "devspace-complete-release-test-")));
const runtimeRoot = join(fixtureRoot, "installed-runtime");
const releasesRoot = join(fixtureRoot, "releases");
const dependencyStoresRoot = join(fixtureRoot, "dependencies");
const binPath = join(fixtureRoot, "bin", "devspace");
const serviceStatePath = join(fixtureRoot, "service-state.json");
const originalCli = join(sourceRoot, "dist", "cli.js");
const deployScript = join(sourceRoot, "scripts", "deploy-unified-project-workspace-v1.mjs");
const rollbackScript = join(sourceRoot, "scripts", "rollback-unified-project-workspace-v1.mjs");
const guardScript = join(sourceRoot, "scripts", "check-source-authority.mjs");
const toggleScript = join(sourceRoot, "scripts", "toggle-unified-project-workspace.mjs");
const migrationScript = join(sourceRoot, "scripts", "migrate-legacy-runtime.mjs");
const healthServer = createHttpServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, name: "devspace" }));
});
await new Promise((resolvePromise, reject) => {
  healthServer.once("error", reject);
  healthServer.listen(0, "127.0.0.1", resolvePromise);
});
const healthAddress = healthServer.address();
const healthPort = typeof healthAddress === "object" && healthAddress ? healthAddress.port : null;
if (!healthPort) throw new Error("Unable to allocate the release-test health port.");
const fixtureHealthUrl = `http://127.0.0.1:${healthPort}/healthz`;

try {
  await mkdir(join(runtimeRoot, "dist"), { recursive: true });
  await mkdir(dirname(binPath), { recursive: true });
  await copyFile(join(sourceRoot, "package.json"), join(runtimeRoot, "package.json"));
  await copyFile(originalCli, join(runtimeRoot, "dist", "cli.js"));
  await symlink(join(sourceRoot, "node_modules"), join(runtimeRoot, "node_modules"), "dir");
  await symlink(join(runtimeRoot, "dist", "cli.js"), binPath);
  const installedRuntimeRealpath = await realpath(runtimeRoot);

  const env = {
    ...process.env,
    DEVSPACE_RUNTIME_ROOT: runtimeRoot,
    DEVSPACE_RELEASES_ROOT: releasesRoot,
    DEVSPACE_DEPENDENCY_STORES_ROOT: dependencyStoresRoot,
    DEVSPACE_BIN_PATH: binPath,
    DEVSPACE_SKIP_LAUNCHCTL: "1",
    DEVSPACE_RUNTIME_TEST_MODE: "1",
    DEVSPACE_TEST_SERVICE_STATE_PATH: serviceStatePath,
    DEVSPACE_LOCAL_HEALTH_URL: fixtureHealthUrl,
    DEVSPACE_PUBLIC_HEALTH_URL: fixtureHealthUrl,
  };
  const runDeploy = (args = [], extraEnv = {}) => execFileAsync(
    process.execPath,
    [deployScript, ...args],
    { cwd: sourceRoot, env: { ...env, ...extraEnv }, maxBuffer: 20 * 1024 * 1024 },
  );

  const readiness = JSON.parse((await runDeploy()).stdout);
  assert.equal(readiness.status, "READY_TO_STAGE");
  assert.equal(readiness.payloadAuthority, "npm pack --dry-run --json");
  assert.ok(readiness.fileCount >= 20);
  assert.match(readiness.dependencyStoreId, /^npm-[a-f0-9]{24}$/);
  assert.match(readiness.dependencyLockSha256, /^[a-f0-9]{64}$/);
  assert.equal(readiness.releaseIdentityStatus, "DEPENDENCY_STORE_VERIFICATION_REQUIRED");

  const defaultBinEnv = { ...env, HOME: fixtureRoot };
  delete defaultBinEnv.DEVSPACE_BIN_PATH;
  const defaultBinReadiness = JSON.parse((await execFileAsync(
    process.execPath,
    [deployScript],
    { cwd: sourceRoot, env: defaultBinEnv, maxBuffer: 20 * 1024 * 1024 },
  )).stdout);
  assert.equal(
    defaultBinReadiness.binPath,
    join(fixtureRoot, ".devspace", "bin", "devspace"),
  );

  const staged = JSON.parse((await runDeploy(["--stage"])).stdout);
  assert.equal(staged.status, "STAGED_SHADOW_PASS");
  assert.equal(staged.shadow.status, "PASS");
  assert.equal(staged.fileCount, readiness.fileCount);
  const release = JSON.parse(await readFile(staged.releaseManifest, "utf8"));
  assert.equal(release.bundleSha256, readiness.bundleSha256);
  assert.equal(release.files.length, readiness.fileCount);
  assert.ok(release.files.some((entry) => entry.path === "dist/external-repository.js"));
  assert.ok(release.files.some((entry) => entry.path === "dist/ui/workspace-app.html"));
  assert.equal((await lstat(join(staged.releasePath, "node_modules"))).isSymbolicLink(), true);
  const releaseNodeModules = await realpath(join(staged.releasePath, "node_modules"));
  assert.equal(releaseNodeModules, release.dependencyStore.nodeModulesRealpath);
  assert.equal(release.dependencyLockSha256, staged.dependencyLockSha256);
  assert.equal(release.dependencyTreeSha256, staged.dependencyTreeSha256);
  const dependencyStoresRealpath = await realpath(dependencyStoresRoot);
  assert.ok(releaseNodeModules.startsWith(dependencyStoresRealpath + "/"));
  assert.ok(!releaseNodeModules.startsWith(installedRuntimeRealpath + "/"));
  const dependencyManifest = JSON.parse(await readFile(
    release.dependencyStore.manifestRealpath,
    "utf8",
  ));
  assert.equal(dependencyManifest.packageLockSha256, release.dependencyLockSha256);
  assert.equal(dependencyManifest.dependencyTreeSha256, release.dependencyTreeSha256);
  const requireFromRelease = createRequire(join(staged.releasePath, "package.json"));
  const resolvedPrompt = await realpath(requireFromRelease.resolve("@clack/prompts"));
  assert.ok(resolvedPrompt.startsWith(releaseNodeModules + "/"));
  assert.ok(!resolvedPrompt.startsWith(installedRuntimeRealpath + "/"));
  assert.equal((await lstat(join(staged.releasePath, "dist", "server.js"))).mode & 0o222, 0);

  const migrated = JSON.parse((await execFileAsync(
    process.execPath,
    [migrationScript],
    {
      cwd: sourceRoot,
      env: {
        ...env,
        DEVSPACE_RUNTIME_AUTHORITY_ROOT: fixtureRoot,
        DEVSPACE_LEGACY_INSTALLED_ROOT: runtimeRoot,
        DEVSPACE_LEGACY_DEPENDENCY_PATH: release.dependencyStore.nodeModulesRealpath,
        DEVSPACE_LEGACY_RELEASE_PATH: staged.releasePath,
      },
      maxBuffer: 20 * 1024 * 1024,
    },
  )).stdout);
  assert.equal(migrated.status, "LEGACY_ROLLBACK_SELF_CONTAINED_PASS");
  const priorReleasePath = migrated.rollbackRelease.releasePath;
  const priorManifestPath = migrated.rollbackRelease.manifestPath;
  const priorManifest = JSON.parse(await readFile(priorManifestPath, "utf8"));
  const legacyDependencyManifest = JSON.parse(await readFile(
    migrated.dependencyStore.manifestPath,
    "utf8",
  ));
  const legacyPackageText = await readFile(join(migrated.dependencyStore.storePath, "package.json"), "utf8");
  const legacyLockText = await readFile(join(migrated.dependencyStore.storePath, "package-lock.json"), "utf8");
  assert.equal(priorManifest.status, "STAGED_SHADOW_PASS");
  assert.equal(priorManifest.runtimeDependencies, migrated.dependencyStore.nodeModulesPath);
  assert.equal(priorManifest.dependencyLockSha256, migrated.dependencyStore.lockSha256);
  assert.equal(priorManifest.dependencyTreeSha256, migrated.dependencyStore.treeSha256);
  assert.equal(priorManifest.dependencyPackageCount, migrated.dependencyStore.packageCount);
  assert.equal(legacyDependencyManifest.status, "IMMUTABLE_DEPENDENCY_STORE_PASS");
  assert.equal(legacyDependencyManifest.schemaVersion, "1.0.0");
  assert.equal(legacyDependencyManifest.storePath, migrated.dependencyStore.storePath);
  assert.equal(legacyDependencyManifest.nodeModulesPath, migrated.dependencyStore.nodeModulesPath);
  assert.equal(legacyDependencyManifest.origin, "legacy-installed-tree-snapshot");
  assert.equal(legacyDependencyManifest.lockProvenance, "npm-shrinkwrap-from-copied-installed-tree");
  assert.equal(JSON.parse(legacyPackageText).scripts, undefined);
  assert.equal(sha256(legacyPackageText), legacyDependencyManifest.packageJsonSha256);
  assert.equal(sha256(legacyLockText), legacyDependencyManifest.packageLockSha256);
  assert.equal(legacyDependencyManifest.dependencyTreeSha256, migrated.dependencyStore.treeSha256);
  assert.equal(legacyDependencyManifest.dependencyPackageCount, migrated.dependencyStore.packageCount);
  assert.ok(legacyDependencyManifest.installedPackagePathCount > 0);
  assert.ok(migrated.dependencyStore.packageCount > 0);
  assert.equal((await lstat(migrated.dependencyStore.storePath)).mode & 0o222, 0);
  const requireFromPrior = createRequire(join(priorReleasePath, "package.json"));
  const priorPrompt = await realpath(requireFromPrior.resolve("@clack/prompts"));
  assert.ok(priorPrompt.startsWith(migrated.dependencyStore.nodeModulesPath + "/"));
  assert.ok(!priorPrompt.startsWith(installedRuntimeRealpath + "/"));
  await rm(binPath);
  await symlink(join(priorReleasePath, "dist", "cli.js"), binPath);
  await rm(runtimeRoot, { recursive: true, force: true });
  await assert.rejects(() => access(runtimeRoot));
  await assertColdStart(staged.releasePath, join(fixtureRoot, "candidate-cold-start"));
  await assertColdStart(priorReleasePath, join(fixtureRoot, "prior-cold-start"));
  await writeFile(serviceStatePath, JSON.stringify({
    program: binPath,
    pid: 41000,
    restartCount: 0,
    failRestarts: 0,
  }, null, 2) + "\n");

  const tamperedReleasePath = join(releasesRoot, "fixture-tampered-release");
  await cp(priorReleasePath, tamperedReleasePath, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  await execFileAsync("chmod", ["-R", "u+w", tamperedReleasePath]);
  const tamperedManifestPath = join(tamperedReleasePath, "RELEASE.json");
  const tamperedManifest = JSON.parse(await readFile(tamperedManifestPath, "utf8"));
  tamperedManifest.releaseId = "fixture-tampered-release";
  await writeFile(tamperedManifestPath, JSON.stringify(tamperedManifest, null, 2) + "\n");
  const tamperedServerPath = join(tamperedReleasePath, "dist", "server.js");
  await writeFile(tamperedServerPath, `${await readFile(tamperedServerPath, "utf8")}\n// fixture tamper\n`);
  await execFileAsync("chmod", ["-R", "a-w", tamperedReleasePath]);
  await rm(binPath);
  await symlink(join(tamperedReleasePath, "dist", "cli.js"), binPath);
  await assert.rejects(
    () => runDeploy(["--deploy"]),
    /Managed release payload hash changed/,
  );
  await rm(binPath);
  await symlink(join(priorReleasePath, "dist", "cli.js"), binPath);

  await updateServiceState({ program: join(fixtureRoot, "wrong-global-bin") });
  await assert.rejects(
    () => runDeploy(["--deploy"]),
    /Launchd service .* is bound to .*wrong-global-bin/,
  );
  assert.equal(await readlink(binPath), join(priorReleasePath, "dist", "cli.js"));
  assert.equal(await exists(join(releasesRoot, "current.json")), false);
  await updateServiceState({ program: binPath });

  const activated = JSON.parse((await runDeploy(["--deploy"])).stdout);
  assert.equal(activated.status, "ACTIVE_ACCEPTANCE_PASS");
  assert.equal(resolve(dirname(binPath), await readlink(binPath)), resolve(activated.activeBinLinkTarget));
  let pointer = JSON.parse(await readFile(join(releasesRoot, "current.json"), "utf8"));
  assert.equal(pointer.schemaVersion, "3.0.0");
  assert.equal(pointer.status, "ACTIVE_ACCEPTANCE_PASS");
  assert.equal(pointer.releasePath, staged.releasePath);
  assert.equal(pointer.releaseManifest, staged.releaseManifest);
  assert.equal(pointer.binPath, binPath);
  assert.equal(pointer.binLinkTarget, activated.activeBinLinkTarget);
  assert.equal(pointer.activationManifest, activated.activationManifest);
  assert.equal(pointer.transitionManifest, activated.activationManifest);
  assert.match(pointer.activationManifestSha256, /^[a-f0-9]{64}$/);
  const activation = JSON.parse(await readFile(activated.activationManifest, "utf8"));
  assert.equal(activation.status, "ACTIVE_ACCEPTANCE_PASS");
  assert.equal(activation.previousRuntime.releasePath, priorReleasePath);
  assert.equal(activation.candidateRuntime.releasePath, staged.releasePath);
  assert.notEqual(activation.previousRuntime.releaseId, activation.candidateRuntime.releaseId);
  assert.notEqual(activated.service.before.pid, activated.service.after.pid);

  const alreadyActive = JSON.parse((await runDeploy(["--deploy"])).stdout);
  assert.equal(alreadyActive.status, "ALREADY_ACTIVE");
  assert.equal(alreadyActive.service.status, "PASS");

  await rm(binPath);
  await symlink(join(priorReleasePath, "dist", "cli.js"), binPath);
  await assert.rejects(
    () => execFileAsync(process.execPath, [rollbackScript], { cwd: sourceRoot, env }),
    /current\.json .* is inconsistent/,
  );
  await rm(binPath);
  await symlink(activated.activeBinLinkTarget, binPath);

  await updateServiceState({ failRestarts: 1 });
  await assert.rejects(
    () => execFileAsync(process.execPath, [rollbackScript], { cwd: sourceRoot, env }),
    /ROLLBACK_FAILED_ACTIVE_RELEASE_RESTORED/,
  );
  pointer = JSON.parse(await readFile(join(releasesRoot, "current.json"), "utf8"));
  assert.equal(pointer.releasePath, staged.releasePath);
  assert.equal(pointer.binTargetRealpath, await realpath(join(staged.releasePath, "dist", "cli.js")));
  assert.equal(pointer.transitionStatus, "ROLLBACK_FAILED_ACTIVE_RELEASE_RESTORED");
  assert.match(pointer.transitionManifest, /ROLLBACK\.json$/);
  assert.equal(
    JSON.parse(await readFile(pointer.activationManifest, "utf8")).status,
    "ACTIVE_ACCEPTANCE_PASS",
  );

  await assert.rejects(
    () => execFileAsync(process.execPath, [rollbackScript], {
      cwd: sourceRoot,
      env: { ...env, DEVSPACE_TEST_FAIL_JSON_RENAME_ONCE: "current.json" },
    }),
    /ROLLBACK_FAILED_ACTIVE_RELEASE_RESTORED.*Injected atomic JSON rename failure/,
  );
  pointer = JSON.parse(await readFile(join(releasesRoot, "current.json"), "utf8"));
  assert.equal(pointer.releasePath, staged.releasePath);
  assert.equal(pointer.transitionStatus, "ROLLBACK_FAILED_ACTIVE_RELEASE_RESTORED");
  assert.equal(
    (await readdir(releasesRoot)).some((name) => name.startsWith(".current.json.tmp-")),
    false,
  );

  const rolledBack = JSON.parse((await execFileAsync(
    process.execPath,
    [rollbackScript],
    { cwd: sourceRoot, env },
  )).stdout);
  assert.equal(rolledBack.status, "ROLLED_BACK_ACCEPTANCE_PASS");
  assert.equal(
    resolve(dirname(binPath), await readlink(binPath)),
    resolve(priorReleasePath, "dist", "cli.js"),
  );
  pointer = JSON.parse(await readFile(join(releasesRoot, "current.json"), "utf8"));
  assert.equal(pointer.status, "ACTIVE_ACCEPTANCE_PASS");
  assert.equal(pointer.releasePath, priorReleasePath);
  assert.equal(pointer.releaseManifest, priorManifestPath);
  assert.equal(pointer.binTargetRealpath, await realpath(join(priorReleasePath, "dist", "cli.js")));
  assert.equal(pointer.transitionManifest, rolledBack.rollbackManifest);
  assert.equal("activationManifest" in pointer, false);
  const rollbackManifest = JSON.parse(await readFile(rolledBack.rollbackManifest, "utf8"));
  assert.equal(rollbackManifest.status, "ROLLED_BACK_ACCEPTANCE_PASS");
  assert.equal(rollbackManifest.fromRuntime.releasePath, staged.releasePath);
  assert.equal(rollbackManifest.restoredRuntime.releasePath, priorReleasePath);
  assert.equal(rollbackManifest.service.public.length, 3);
  assert.equal(
    JSON.parse(await readFile(activated.activationManifest, "utf8")).status,
    "ACTIVE_ACCEPTANCE_PASS",
  );

  await assert.rejects(
    () => runDeploy(["--deploy"], { DEVSPACE_TEST_FAIL_AFTER_SWITCH: "1" }),
    /ACTIVATION_FAILED_AUTO_ROLLED_BACK/,
  );
  assert.equal(
    resolve(dirname(binPath), await readlink(binPath)),
    resolve(priorReleasePath, "dist", "cli.js"),
  );
  pointer = JSON.parse(await readFile(join(releasesRoot, "current.json"), "utf8"));
  assert.equal(pointer.releasePath, priorReleasePath);
  assert.equal(pointer.transitionStatus, "ACTIVATION_FAILED_AUTO_ROLLED_BACK");

  await updateServiceState({ failRestarts: 1 });
  await assert.rejects(
    () => runDeploy(["--deploy"]),
    /ACTIVATION_FAILED_AUTO_ROLLED_BACK.*Injected launchd restart failure/,
  );
  pointer = JSON.parse(await readFile(join(releasesRoot, "current.json"), "utf8"));
  assert.equal(pointer.releasePath, priorReleasePath);
  assert.equal(await realpath(binPath), await realpath(join(priorReleasePath, "dist", "cli.js")));

  await assert.rejects(
    () => runDeploy(["--deploy"], { DEVSPACE_TEST_FAIL_JSON_RENAME_ONCE: "current.json" }),
    /ACTIVATION_FAILED_AUTO_ROLLED_BACK.*Injected atomic JSON rename failure/,
  );
  pointer = JSON.parse(await readFile(join(releasesRoot, "current.json"), "utf8"));
  assert.equal(pointer.releasePath, priorReleasePath);
  assert.equal(
    (await readdir(releasesRoot)).some((name) => name.startsWith(".current.json.tmp-")),
    false,
  );

  const reactivated = JSON.parse((await runDeploy(["--deploy"])).stdout);
  assert.equal(reactivated.status, "ACTIVE_ACCEPTANCE_PASS");
  const rollbackBeforeCrash = JSON.parse((await execFileAsync(
    process.execPath,
    [rollbackScript],
    { cwd: sourceRoot, env },
  )).stdout);
  assert.equal(rollbackBeforeCrash.status, "ROLLED_BACK_ACCEPTANCE_PASS");
  await assert.rejects(
    () => runDeploy(["--deploy"], { DEVSPACE_TEST_CRASH_AFTER_SWITCH: "1" }),
    (error) => error?.code === 86,
  );
  assert.equal(await realpath(binPath), await realpath(join(staged.releasePath, "dist", "cli.js")));
  await assert.rejects(
    () => runDeploy(["--deploy"]),
    /ALREADY_ACTIVE_STATE_MISMATCH/,
  );
  await rm(binPath);
  await symlink(join(priorReleasePath, "dist", "cli.js"), binPath);

  await rm(binPath);
  await symlink(join(sourceRoot, "dist", "cli.js"), binPath);
  await assert.rejects(
    () => runDeploy(["--deploy"]),
    /Managed executable target escapes a direct release/,
  );
  await rm(binPath);
  await symlink(join(priorReleasePath, "dist", "cli.js"), binPath);

  const guardAudit = JSON.parse((await execFileAsync(process.execPath, [
    guardScript,
    "--mode", "shadow",
    "--operation", "audit",
  ], { cwd: sourceRoot, env })).stdout);
  assert.equal(guardAudit.status, "PASS");
  assert.equal(guardAudit.invariant, "one repository identity has one canonical writable source");
  const nonCanonicalSource = join(fixtureRoot, "non-canonical-source");
  await mkdir(nonCanonicalSource);
  await assertRejectExit(
    () => execFileAsync(process.execPath, [
      guardScript,
      "--mode", "enforce",
      "--operation", "deploy",
      "--source", nonCanonicalSource,
      "--target", runtimeRoot,
    ], { cwd: sourceRoot, env }),
    "NON_CANONICAL_SOURCE",
  );
  await assertRejectExit(
    () => execFileAsync(process.execPath, [
      guardScript,
      "--mode", "enforce",
      "--operation", "clone",
      "--repository", "https://github.com/Waishnav/devspace.git",
      "--target", join(fixtureRoot, "duplicate"),
    ], { cwd: sourceRoot, env }),
    "DUPLICATE_REPOSITORY_IDENTITY",
  );

  const configPath = join(fixtureRoot, "config.json");
  const baselineConfigPath = join(fixtureRoot, "config.baseline.json");
  const baselineConfig = '{\n  "host": "127.0.0.1",\n  "port": 7676\n}\n';
  await writeFile(configPath, JSON.stringify({
    host: "127.0.0.1",
    port: 7676,
    portfolioRoot: "/portfolio",
    unifiedProjectWorkspace: true,
    externalRepositoryEnabled: false,
  }, null, 2) + "\n");
  await writeFile(baselineConfigPath, baselineConfig);
  const configEnv = {
    ...env,
    DEVSPACE_CONFIG_PATH: configPath,
    DEVSPACE_CONFIG_BASELINE_BACKUP: baselineConfigPath,
  };
  await writeFile(configPath, JSON.stringify({
    host: "127.0.0.1",
    port: 7676,
    portfolioRoot: "/portfolio",
    unifiedProjectWorkspace: true,
    externalRepositoryEnabled: true,
  }, null, 2) + "\n");
  await assert.rejects(
    () => execFileAsync(process.execPath, [toggleScript, "restore"], {
      cwd: sourceRoot,
      env: configEnv,
    }),
    /externalRepositoryEnabled changed after the unified-workspace operation/,
  );
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).externalRepositoryEnabled, true);
  await writeFile(configPath, JSON.stringify({
    host: "127.0.0.1",
    port: 7676,
    portfolioRoot: "/portfolio",
    unifiedProjectWorkspace: true,
    externalRepositoryEnabled: false,
  }, null, 2) + "\n");
  const restoredConfig = JSON.parse((await execFileAsync(
    process.execPath,
    [toggleScript, "restore"],
    { cwd: sourceRoot, env: configEnv },
  )).stdout);
  assert.equal(restoredConfig.status, "CONFIG_RESTORED_RESTART_REQUIRED");
  assert.equal(await readFile(configPath, "utf8"), baselineConfig);

  for (const externalRepositoryEnabled of [true, false]) {
    const externalBaseline = JSON.stringify({
      host: "127.0.0.1",
      port: 7676,
      externalRepositoryEnabled,
    }, null, 2) + "\n";
    await writeFile(baselineConfigPath, externalBaseline);
    await writeFile(configPath, JSON.stringify({
      host: "127.0.0.1",
      port: 7676,
      portfolioRoot: "/portfolio",
      unifiedProjectWorkspace: true,
      externalRepositoryEnabled: false,
    }, null, 2) + "\n");
    const externalRestore = JSON.parse((await execFileAsync(
      process.execPath,
      [toggleScript, "restore"],
      { cwd: sourceRoot, env: configEnv },
    )).stdout);
    assert.equal(externalRestore.status, "CONFIG_RESTORED_RESTART_REQUIRED");
    assert.equal(await readFile(configPath, "utf8"), externalBaseline);
  }

  await writeFile(baselineConfigPath, baselineConfig);

  await writeFile(configPath, JSON.stringify({
    host: "127.0.0.1",
    port: 8787,
    portfolioRoot: "/portfolio",
    unifiedProjectWorkspace: true,
    externalRepositoryEnabled: false,
  }, null, 2) + "\n");
  await assert.rejects(
    () => execFileAsync(process.execPath, [toggleScript, "restore"], {
      cwd: sourceRoot,
      env: configEnv,
    }),
    /CONFIG_CHANGED_OUTSIDE_UNIFIED_WORKSPACE/,
  );

  console.log(JSON.stringify({
    status: "PASS",
    tested: [
      "complete npm package inventory instead of a hand-maintained file list",
      "stable home-scoped executable path by default",
      "payload hash manifest and readback verification",
      "isolated shadow start and health contract",
      "lockfile-addressed immutable production dependency store",
      "dependency manifest lock, tree digest, and realpath binding",
      "module resolution remains inside hidden runtime dependencies",
      "cold start after installed runtime deletion",
      "read-only versioned candidate",
      "distinct self-contained prior and candidate releases",
      "legacy installed-tree migration produces an exact managed lock and tree binding",
      "launchd stable-program and changed-PID binding",
      "launchd program mismatch refusal before switching",
      "atomic executable symlink activation",
      "later executable-link change refusal",
      "explicit rollback after installed runtime deletion",
      "independent rollback journal with full prior pointer restoration",
      "rollback restart failure compensation restores active pointer",
      "atomic rollback pointer rename failure restores active pointer",
      "injected post-switch automatic rollback",
      "activation restart failure restores prior pointer",
      "atomic current pointer rename failure preserves parseable prior state",
      "crash-after-switch cannot be reported as already active",
      "release and dependency target containment",
      "release payload tamper and writable-tree refusal",
      "rollback local and public health acceptance",
      "canonical source audit",
      "non-canonical deployment refusal without a historical-reference fixture",
      "duplicate repository identity refusal",
      "safe configuration restore",
      "external repository safety drift refusal",
      "external repository baseline true and false restoration",
      "unrelated configuration change refusal",
    ],
  }, null, 2));
} finally {
  await new Promise((resolvePromise) => healthServer.close(resolvePromise));
  try {
    await execFileAsync("chmod", ["-R", "u+w", fixtureRoot]);
  } catch {}
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function assertColdStart(releasePath, root) {
  const portServer = createHttpServer();
  await new Promise((resolvePromise, reject) => {
    portServer.once("error", reject);
    portServer.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = portServer.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolvePromise) => portServer.close(resolvePromise));
  if (!port) throw new Error("Unable to allocate the cold-start test port.");

  const configRoot = join(root, "cold-start-config");
  const stateDir = join(configRoot, "state");
  const publicBaseUrl = `http://127.0.0.1:${port}`;
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, "config.json"), JSON.stringify({
    host: "127.0.0.1",
    port,
    allowedRoots: [dirname(sourceRoot)],
    portfolioRoot: dirname(sourceRoot),
    publicBaseUrl,
    allowedHosts: ["127.0.0.1", "localhost"],
    stateDir,
    worktreeRoot: join(configRoot, "worktrees"),
    unifiedProjectWorkspace: true,
    externalRepositoryEnabled: false,
  }, null, 2) + "\n");
  await writeFile(join(configRoot, "auth.json"), JSON.stringify({
    ownerToken: randomBytes(32).toString("base64url"),
  }, null, 2) + "\n");

  const child = spawn(process.execPath, [join(releasePath, "dist", "cli.js"), "serve"], {
    cwd: releasePath,
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configRoot,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_WORKTREE_ROOT: join(configRoot, "worktrees"),
      DEVSPACE_TOOL_MODE: "minimal",
      DEVSPACE_PUBLIC_BASE_URL: publicBaseUrl,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let accepted = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`${publicBaseUrl}/healthz`, {
          signal: AbortSignal.timeout(1000),
        });
        const body = await response.json();
        if (response.status === 200 && body?.ok === true && body?.name === "devspace") {
          accepted = true;
          break;
        }
      } catch {}
      await delay(100);
    }
    assert.equal(accepted, true, `Cold-start candidate exited with ${String(child.exitCode)}.`);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolvePromise) => child.once("exit", resolvePromise)),
        delay(5000),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function assertRejectExit(run, code) {
  try {
    await run();
    assert.fail(`Expected guard rejection ${code}.`);
  } catch (error) {
    if (error?.code === "ERR_ASSERTION") throw error;
    const output = String(error?.stdout ?? "");
    assert.match(output, new RegExp(code));
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

async function updateServiceState(changes) {
  const current = JSON.parse(await readFile(serviceStatePath, "utf8"));
  await writeFile(serviceStatePath, JSON.stringify({ ...current, ...changes }, null, 2) + "\n");
}
