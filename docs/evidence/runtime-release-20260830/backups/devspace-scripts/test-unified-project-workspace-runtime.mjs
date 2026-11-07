#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeRoot = await mkdtemp(join(tmpdir(), "devspace-unified-runtime-test-"));
const files = [
  "dist/config.js",
  "dist/workspaces.js",
  "dist/user-config.js",
  "dist/project-workspace-resolver.js",
  "dist/msi-h3-status.js",
  "dist/external-repository.js",
  "dist/server.js",
];
const before = new Map();

try {
  await cp(join(sourceRoot, "dist"), join(runtimeRoot, "dist"), { recursive: true });
  await copyFile(join(sourceRoot, "package.json"), join(runtimeRoot, "package.json"));
  for (const [index, relativePath] of files.entries()) {
    if (relativePath === "dist/external-repository.js") {
      before.set(relativePath, null);
      await rm(join(runtimeRoot, relativePath), { force: true });
      continue;
    }
    const content = Buffer.concat([
      await readFile(join(sourceRoot, relativePath)),
      Buffer.from(`\n// isolated runtime before ${index}: ${relativePath}\n`),
    ]);
    before.set(relativePath, content);
    await writeFile(join(runtimeRoot, relativePath), content);
  }

  const env = { ...process.env, DEVSPACE_RUNTIME_ROOT: runtimeRoot };
  const deployScript = join(sourceRoot, "scripts", "deploy-unified-project-workspace-v1.mjs");
  const rollbackScript = join(sourceRoot, "scripts", "rollback-unified-project-workspace-v1.mjs");
  const toggleScript = join(sourceRoot, "scripts", "toggle-unified-project-workspace.mjs");

  const checkDeployment = () => execFileAsync(process.execPath, [deployScript], {
    cwd: sourceRoot,
    env,
  });

  const runtimeApplyPatchPath = join(runtimeRoot, "dist", "apply-patch.js");
  await rm(runtimeApplyPatchPath);
  await assert.rejects(
    checkDeployment,
    /unlisted relative dependency dist\/apply-patch\.js is missing from installed runtime/,
  );
  await copyFile(join(sourceRoot, "dist", "apply-patch.js"), runtimeApplyPatchPath);

  const runtimeServerPath = join(runtimeRoot, "dist", "server.js");
  const runtimeServerBefore = before.get("dist/server.js");
  assert.ok(Buffer.isBuffer(runtimeServerBefore));
  const applyPatchImport = 'import { applyPatch } from "./apply-patch.js";\n';
  assert.ok(runtimeServerBefore.includes(applyPatchImport));
  await writeFile(
    runtimeServerPath,
    runtimeServerBefore.toString("utf8").replace(applyPatchImport, ""),
  );
  await assert.rejects(
    checkDeployment,
    /installed runtime dist\/server\.js does not import the same specifier/,
  );
  await writeFile(runtimeServerPath, runtimeServerBefore);

  const checked = JSON.parse((await checkDeployment()).stdout);
  assert.equal(checked.status, "READY_TO_DEPLOY");
  assert.deepEqual(checked.files.map((file) => file.path), files);

  const deployed = JSON.parse((await execFileAsync(process.execPath, [deployScript, "--deploy"], {
    cwd: sourceRoot,
    env,
  })).stdout);
  assert.equal(deployed.status, "DEPLOYED_RESTART_REQUIRED");
  assert.deepEqual(deployed.files.map((file) => file.path), files);
  const externalRepository = deployed.files.find(
    (file) => file.path === "dist/external-repository.js",
  );
  assert.equal(externalRepository?.existedBefore, false);
  assert.equal(externalRepository?.beforeSha256, null);

  for (const relativePath of files) {
    assert.deepEqual(
      await readFile(join(runtimeRoot, relativePath)),
      await readFile(join(sourceRoot, relativePath)),
    );
  }

  await writeFile(join(runtimeRoot, "dist", "server.js"), "export const laterChange = true;\n");
  await assert.rejects(
    () => execFileAsync(process.execPath, [rollbackScript], {
      cwd: sourceRoot,
      env,
    }),
    /changed after deployment/,
  );

  await copyFile(join(sourceRoot, "dist", "server.js"), join(runtimeRoot, "dist", "server.js"));
  const rolledBack = JSON.parse((await execFileAsync(process.execPath, [rollbackScript], {
    cwd: sourceRoot,
    env,
  })).stdout);
  assert.equal(rolledBack.status, "ROLLED_BACK_RESTART_REQUIRED");

  for (const relativePath of files) {
    const priorContent = before.get(relativePath);
    if (priorContent === null) {
      assert.equal(await exists(join(runtimeRoot, relativePath)), false);
    } else {
      assert.deepEqual(await readFile(join(runtimeRoot, relativePath)), priorContent);
    }
  }

  const configPath = join(runtimeRoot, "config.json");
  const baselineConfigPath = join(runtimeRoot, "config.baseline.json");
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
  const restoredConfig = JSON.parse((await execFileAsync(
    process.execPath,
    [toggleScript, "restore"],
    { cwd: sourceRoot, env: configEnv },
  )).stdout);
  assert.equal(restoredConfig.status, "CONFIG_RESTORED_RESTART_REQUIRED");
  assert.equal(await readFile(configPath, "utf8"), baselineConfig);

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
      "full-dist dependency closure fixture",
      "missing unlisted dependency refusal",
      "missing installed-runtime import refusal",
      "deployment readiness",
      "first-add deployment",
      "exact runtime backup",
      "atomic replacement",
      "later-change refusal",
      "byte-for-byte rollback",
      "first-add rollback deletion",
      "safe configuration restore",
      "unrelated configuration change refusal",
    ],
  }, null, 2));
} finally {
  await rm(runtimeRoot, { recursive: true, force: true });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
