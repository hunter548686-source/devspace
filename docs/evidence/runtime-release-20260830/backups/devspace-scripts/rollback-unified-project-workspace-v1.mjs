#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const TASK_ID = "DEVSPACE-UNIFIED-PROJECT-WORKSPACE-V1-01";
const runtimeRoot = resolve(
  process.env.DEVSPACE_RUNTIME_ROOT
    ?? "/Users/liheng/.hermes/node/lib/node_modules/@waishnav/devspace",
);
const backupParent = join(runtimeRoot, ".local-runtime-backups");
const pointerPath = join(backupParent, "unified-project-workspace-v1-current.json");
const backupArgumentIndex = process.argv.indexOf("--backup");
const explicitBackup = backupArgumentIndex >= 0
  ? process.argv[backupArgumentIndex + 1]
  : undefined;

await main();

async function main() {
  await access(runtimeRoot);
  const pointer = explicitBackup
    ? { backupRoot: resolve(explicitBackup) }
    : JSON.parse(await readFile(pointerPath, "utf8"));
  if (!pointer.backupRoot) {
    throw new Error("Rollback pointer does not contain a backupRoot.");
  }

  const backupRoot = resolve(pointer.backupRoot);
  const manifestPath = join(backupRoot, "DEPLOYMENT.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.taskId !== TASK_ID || manifest.runtimeRoot !== runtimeRoot) {
    throw new Error("Rollback manifest identity does not match this runtime.");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("Rollback manifest has no files.");
  }

  for (const file of manifest.files) {
    const targetPath = join(runtimeRoot, file.path);
    if (!(await exists(targetPath))) {
      if (file.deployedSha256 !== null) {
        throw new Error(`Refusing rollback: current runtime file is missing: ${file.path}.`);
      }
      continue;
    }
    const currentSha256 = sha256(await readFile(targetPath));
    if (currentSha256 !== file.deployedSha256) {
      throw new Error(
        `Refusing rollback: ${file.path} changed after deployment. Current ${currentSha256}, expected ${file.deployedSha256}.`,
      );
    }
  }

  await restoreFiles(manifest, backupRoot);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

async function restoreFiles(manifest, backupRoot) {
  const restored = [];
  try {
    for (const file of manifest.files) {
      const targetPath = join(runtimeRoot, file.path);
      if (file.existedBefore) {
        if (!file.backupPath || !(await exists(file.backupPath))) {
          throw new Error(`Rollback backup is missing for ${file.path}.`);
        }
        const temporaryPath = `${targetPath}.unified-project-workspace-v1.restore.tmp.mjs`;
        await rm(temporaryPath, { force: true });
        await copyFile(file.backupPath, temporaryPath);
        execFileSync(process.execPath, ["--check", temporaryPath], { stdio: "pipe" });
        await rename(temporaryPath, targetPath);
        execFileSync(process.execPath, ["--check", targetPath], { stdio: "pipe" });
        const restoredHash = sha256(await readFile(targetPath));
        if (restoredHash !== file.beforeSha256) {
          throw new Error(`Rollback readback hash mismatch for ${file.path}.`);
        }
      } else {
        await rm(targetPath, { force: true });
      }
      restored.push(file.path);
    }

    const rolledBackAt = new Date().toISOString();
    await writeJson(join(backupRoot, "ROLLBACK.json"), {
      schemaVersion: "1.0.0",
      taskId: TASK_ID,
      status: "ROLLED_BACK_RESTART_REQUIRED",
      rolledBackAt,
      runtimeRoot,
      backupRoot,
      restored,
    });
    await writeJson(pointerPath, {
      schemaVersion: "1.0.0",
      status: "ROLLED_BACK_RESTART_REQUIRED",
      backupRoot,
      deploymentManifest: join(backupRoot, "DEPLOYMENT.json"),
      rollbackManifest: join(backupRoot, "ROLLBACK.json"),
      runtimeRoot,
      updatedAt: rolledBackAt,
    });

    console.log(JSON.stringify({
      status: "ROLLED_BACK_RESTART_REQUIRED",
      backupRoot,
      restored,
      restartRequired: true,
    }, null, 2));
  } catch (error) {
    await writeJson(join(backupRoot, "ROLLBACK_FAILED.json"), {
      schemaVersion: "1.0.0",
      taskId: TASK_ID,
      status: "ROLLBACK_FAILED",
      failedAt: new Date().toISOString(),
      runtimeRoot,
      backupRoot,
      restored,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
