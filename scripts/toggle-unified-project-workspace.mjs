#!/usr/bin/env node
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const action = process.argv[2] ?? "status";
if (!["status", "enable", "disable", "restore"].includes(action)) {
  throw new Error(
    "Usage: toggle-unified-project-workspace.mjs status|enable|disable|restore",
  );
}

const configPath = resolve(
  process.env.DEVSPACE_CONFIG_PATH ?? join(homedir(), ".devspace", "config.json"),
);
const baselineBackupPath = resolve(
  process.env.DEVSPACE_CONFIG_BASELINE_BACKUP
    ?? join(homedir(), ".devspace", "config.json.bak-20260830-unified-project-workspace"),
);
const configText = await readFile(configPath, "utf8");
const config = JSON.parse(configText);
const enabled = config.unifiedProjectWorkspace !== false;

if (action === "status") {
  console.log(JSON.stringify({
    status: "OK",
    configPath,
    unifiedProjectWorkspace: enabled,
    restartRequired: false,
  }, null, 2));
  process.exit(0);
}

if (action === "restore") {
  const baselineText = await readFile(baselineBackupPath, "utf8");
  const baseline = JSON.parse(baselineText);
  assertExternalRepositoryRestoreOwnership(config, baseline);
  if (
    stableJson(withoutUnifiedWorkspaceFields(config))
    !== stableJson(withoutUnifiedWorkspaceFields(baseline))
  ) {
    throw new Error(
      "CONFIG_CHANGED_OUTSIDE_UNIFIED_WORKSPACE: refusing to overwrite later unrelated configuration changes.",
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const currentBackupPath = `${configPath}.before-unified-project-workspace-restore-${stamp}.bak`;
  const temporaryPath = `${configPath}.unified-project-workspace.restore.tmp`;
  await copyFile(configPath, currentBackupPath);
  await writeFile(temporaryPath, baselineText, { mode: 0o600 });
  await rename(temporaryPath, configPath);
  console.log(JSON.stringify({
    status: "CONFIG_RESTORED_RESTART_REQUIRED",
    configPath,
    baselineBackupPath,
    currentBackupPath,
    restartRequired: true,
  }, null, 2));
  process.exit(0);
}

const nextEnabled = action === "enable";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `${configPath}.unified-project-workspace-${stamp}.bak`;
const temporaryPath = `${configPath}.unified-project-workspace.tmp`;
await copyFile(configPath, backupPath);
config.unifiedProjectWorkspace = nextEnabled;
await writeFile(temporaryPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
await rename(temporaryPath, configPath);

console.log(JSON.stringify({
  status: nextEnabled ? "ENABLED_RESTART_REQUIRED" : "DISABLED_RESTART_REQUIRED",
  configPath,
  backupPath,
  unifiedProjectWorkspace: nextEnabled,
  restartRequired: true,
}, null, 2));

function assertExternalRepositoryRestoreOwnership(current, baseline) {
  const currentHas = Object.hasOwn(current, "externalRepositoryEnabled");
  const baselineHas = Object.hasOwn(baseline, "externalRepositoryEnabled");
  const matchesBaseline = currentHas === baselineHas
    && (!currentHas || current.externalRepositoryEnabled === baseline.externalRepositoryEnabled);
  const matchesToggleOwnedValue = currentHas && current.externalRepositoryEnabled === false;
  if (!matchesBaseline && !matchesToggleOwnedValue) {
    throw new Error(
      "CONFIG_CHANGED_OUTSIDE_UNIFIED_WORKSPACE: externalRepositoryEnabled changed after the unified-workspace operation.",
    );
  }
}

function withoutUnifiedWorkspaceFields(value) {
  const copy = structuredClone(value);
  delete copy.portfolioRoot;
  delete copy.unifiedProjectWorkspace;
  delete copy.externalRepositoryEnabled;
  return copy;
}

function stableJson(value) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}
