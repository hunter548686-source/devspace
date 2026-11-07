#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TASK_ID = "DEVSPACE-UNIFIED-PROJECT-WORKSPACE-V1-01";
const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeRoot = resolve(
  process.env.DEVSPACE_RUNTIME_ROOT
    ?? "/Users/liheng/.hermes/node/lib/node_modules/@waishnav/devspace",
);
const backupParent = join(runtimeRoot, ".local-runtime-backups");
const pointerPath = join(backupParent, "unified-project-workspace-v1-current.json");
const deploy = process.argv.includes("--deploy");
const files = [
  "dist/config.js",
  "dist/workspaces.js",
  "dist/user-config.js",
  "dist/project-workspace-resolver.js",
  "dist/msi-h3-status.js",
  "dist/external-repository.js",
  "dist/server.js",
];

const requiredMarkers = new Map([
  ["dist/server.js", [
    'openProject: "open_project"',
    '"msi_h3_status"',
    '"msi_h3_start"',
    '"msi_h3_stop"',
    "externalRepositoryEnabled",
  ]],
  ["dist/config.js", ["unifiedProjectWorkspace", "externalRepositoryEnabled", "portfolioRoot"]],
  ["dist/workspaces.js", ["WORKSPACE_CHANGED_EXTERNALLY", "runMutation"]],
  ["dist/project-workspace-resolver.js", [
    "Project query could not be resolved uniquely",
    "NEW_TASK_CANONICAL_DEFAULT",
  ]],
  ["dist/msi-h3-status.js", ["MSI identity verification failed", "collectMsiH3Status"]],
  ["dist/external-repository.js", [
    "normalizeGitHubRepositoryUrl",
    "assertNoEscapingSymlinks",
    "setupExternalRepository",
  ]],
]);

const staticModuleParser = String.raw`
import { SourceTextModule } from "node:vm";

let source = "";
for await (const chunk of process.stdin) {
  source += chunk;
}

const module = new SourceTextModule(source);
const requests = Array.isArray(module.moduleRequests)
  ? module.moduleRequests.map((request) => (
      typeof request === "string" ? request : request.specifier
    ))
  : module.dependencySpecifiers;
process.stdout.write(JSON.stringify(requests));
`;

await main();

async function main() {
  await access(runtimeRoot);
  const sourcePackage = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  const runtimePackage = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
  if (sourcePackage.version !== runtimePackage.version) {
    throw new Error(
      `Refusing deployment: source version ${String(sourcePackage.version)} does not match installed version ${String(runtimePackage.version)}.`,
    );
  }

  await assertServerRelativeDependencyClosure();

  const checkedFiles = [];
  for (const relativePath of files) {
    const sourcePath = join(sourceRoot, relativePath);
    const targetPath = join(runtimeRoot, relativePath);
    await access(sourcePath);
    await access(dirname(targetPath));
    const content = await readFile(sourcePath, "utf8");
    for (const marker of requiredMarkers.get(relativePath) ?? []) {
      if (!content.includes(marker)) {
        throw new Error(
          `Refusing deployment: ${relativePath} is missing required marker ${JSON.stringify(marker)}.`,
        );
      }
    }
    execFileSync(process.execPath, ["--check", sourcePath], { stdio: "pipe" });
    checkedFiles.push({
      path: relativePath,
      sourceSha256: sha256(content),
      targetExists: await exists(targetPath),
      targetSha256: (await exists(targetPath)) ? sha256(await readFile(targetPath)) : null,
    });
  }

  if (!deploy) {
    console.log(JSON.stringify({
      status: "READY_TO_DEPLOY",
      taskId: TASK_ID,
      sourceRoot,
      runtimeRoot,
      version: sourcePackage.version,
      files: checkedFiles,
      rollback: {
        exactByteBackup: true,
        pointerPath,
        laterChangeProtection: true,
      },
    }, null, 2));
    return;
  }

  await deployRuntime(sourcePackage.version);
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

function parseStaticModuleSpecifiers(content, label) {
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-vm-modules",
        "--input-type=module",
        "--eval",
        staticModuleParser,
      ],
      { encoding: "utf8", input: content, stdio: ["pipe", "pipe", "pipe"] },
    );
    const requests = JSON.parse(output);
    if (!Array.isArray(requests) || requests.some((request) => typeof request !== "string")) {
      throw new Error("parser returned an invalid module request list");
    }
    return [...new Set(requests)];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Refusing deployment: could not parse static imports and re-exports in ${label}: ${detail}`,
    );
  }
}

function relativeDependencyPath(root, importerPath, specifier, label) {
  if (specifier.includes("?") || specifier.includes("#")) {
    throw new Error(
      `Refusing deployment: ${label} uses unsupported relative module specifier ${JSON.stringify(specifier)}.`,
    );
  }
  const dependencyPath = resolve(dirname(importerPath), specifier);
  const relativePath = relative(root, dependencyPath);
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error(
      `Refusing deployment: ${label} relative module specifier ${JSON.stringify(specifier)} escapes its root.`,
    );
  }
  return {
    absolutePath: dependencyPath,
    relativePath: relativePath.split(sep).join("/"),
  };
}

async function assertServerRelativeDependencyClosure() {
  const serverRelativePath = "dist/server.js";
  const sourceServerPath = join(sourceRoot, serverRelativePath);
  const runtimeServerPath = join(runtimeRoot, serverRelativePath);
  if (!(await exists(runtimeServerPath))) {
    throw new Error(
      `Refusing deployment: installed runtime is missing ${serverRelativePath}, so dependency closure cannot be verified.`,
    );
  }

  const sourceServer = await readFile(sourceServerPath, "utf8");
  const runtimeServer = await readFile(runtimeServerPath, "utf8");
  const sourceRequests = parseStaticModuleSpecifiers(sourceServer, `source ${serverRelativePath}`);
  const runtimeRequests = new Set(
    parseStaticModuleSpecifiers(runtimeServer, `installed runtime ${serverRelativePath}`),
  );
  const deployedFiles = new Set(files);

  for (const specifier of sourceRequests) {
    if (!(specifier.startsWith("./") || specifier.startsWith("../"))) {
      continue;
    }

    const sourceDependency = relativeDependencyPath(
      sourceRoot,
      sourceServerPath,
      specifier,
      `source ${serverRelativePath}`,
    );
    const runtimeDependency = relativeDependencyPath(
      runtimeRoot,
      runtimeServerPath,
      specifier,
      `installed runtime ${serverRelativePath}`,
    );
    if (sourceDependency.relativePath !== runtimeDependency.relativePath) {
      throw new Error(
        `Refusing deployment: ${specifier} resolves differently in source and installed runtime.`,
      );
    }
    if (deployedFiles.has(sourceDependency.relativePath)) {
      continue;
    }

    const addToFiles = `Add ${sourceDependency.relativePath} to files.`;
    if (!runtimeRequests.has(specifier)) {
      throw new Error(
        `Refusing deployment: source ${serverRelativePath} imports unlisted relative dependency ${JSON.stringify(specifier)}, but installed runtime ${serverRelativePath} does not import the same specifier. ${addToFiles}`,
      );
    }
    if (!(await exists(sourceDependency.absolutePath))) {
      throw new Error(
        `Refusing deployment: unlisted relative dependency ${sourceDependency.relativePath} is missing from source. ${addToFiles}`,
      );
    }
    if (!(await exists(runtimeDependency.absolutePath))) {
      throw new Error(
        `Refusing deployment: unlisted relative dependency ${sourceDependency.relativePath} is missing from installed runtime. ${addToFiles}`,
      );
    }

    const sourceSha256 = sha256(await readFile(sourceDependency.absolutePath));
    const runtimeSha256 = sha256(await readFile(runtimeDependency.absolutePath));
    if (sourceSha256 !== runtimeSha256) {
      throw new Error(
        `Refusing deployment: unlisted relative dependency ${sourceDependency.relativePath} differs between source (${sourceSha256}) and installed runtime (${runtimeSha256}). ${addToFiles}`,
      );
    }
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

async function deployRuntime(version) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(backupParent, `unified-project-workspace-v1-${stamp}`);
  await mkdir(backupRoot, { recursive: true });

  const manifest = {
    schemaVersion: "1.0.0",
    taskId: TASK_ID,
    status: "DEPLOYING",
    createdAt: new Date().toISOString(),
    sourceRoot,
    runtimeRoot,
    version,
    files: [],
  };

  for (const relativePath of files) {
    const sourcePath = join(sourceRoot, relativePath);
    const targetPath = join(runtimeRoot, relativePath);
    const backupPath = join(backupRoot, "before", relativePath);
    const existedBefore = await exists(targetPath);
    if (existedBefore) {
      await mkdir(dirname(backupPath), { recursive: true });
      await copyFile(targetPath, backupPath);
    }
    manifest.files.push({
      path: relativePath,
      existedBefore,
      beforeSha256: existedBefore ? sha256(await readFile(targetPath)) : null,
      deployedSha256: sha256(await readFile(sourcePath)),
      backupPath: existedBefore ? backupPath : null,
    });
  }
  await writeJson(join(backupRoot, "DEPLOYMENT.json"), manifest);

  const replaced = [];
  try {
    for (const file of manifest.files) {
      const sourcePath = join(sourceRoot, file.path);
      const targetPath = join(runtimeRoot, file.path);
      const temporaryPath = `${targetPath}.unified-project-workspace-v1.tmp.mjs`;
      await rm(temporaryPath, { force: true });
      await copyFile(sourcePath, temporaryPath);
      await chmod(temporaryPath, 0o644);
      execFileSync(process.execPath, ["--check", temporaryPath], { stdio: "pipe" });
      await rename(temporaryPath, targetPath);
      execFileSync(process.execPath, ["--check", targetPath], { stdio: "pipe" });
      if (sha256(await readFile(targetPath)) !== file.deployedSha256) {
        throw new Error(`Readback hash mismatch for ${file.path}.`);
      }
      replaced.push(file);
    }

    manifest.status = "DEPLOYED_RESTART_REQUIRED";
    manifest.deployedAt = new Date().toISOString();
    manifest.rollbackCommand =
      `node ${join(sourceRoot, "scripts", "rollback-unified-project-workspace-v1.mjs")}`;
    manifest.disableCommand =
      `node ${join(sourceRoot, "scripts", "toggle-unified-project-workspace.mjs")} disable`;
    manifest.restoreConfigCommand =
      `node ${join(sourceRoot, "scripts", "toggle-unified-project-workspace.mjs")} restore`;
    await writeJson(join(backupRoot, "DEPLOYMENT.json"), manifest);
    await writeJson(pointerPath, {
      schemaVersion: "1.0.0",
      status: manifest.status,
      backupRoot,
      deploymentManifest: join(backupRoot, "DEPLOYMENT.json"),
      runtimeRoot,
      updatedAt: manifest.deployedAt,
    });

    console.log(JSON.stringify({
      status: manifest.status,
      backupRoot,
      pointerPath,
      files: manifest.files,
      restartRequired: true,
      rollbackCommand: manifest.rollbackCommand,
      disableCommand: manifest.disableCommand,
      restoreConfigCommand: manifest.restoreConfigCommand,
    }, null, 2));
  } catch (error) {
    const rollbackErrors = [];
    for (const file of [...replaced].reverse()) {
      const targetPath = join(runtimeRoot, file.path);
      try {
        if (file.existedBefore && file.backupPath) {
          const temporaryPath = `${targetPath}.unified-project-workspace-v1.rollback.tmp.mjs`;
          await copyFile(file.backupPath, temporaryPath);
          await rename(temporaryPath, targetPath);
        } else {
          await rm(targetPath, { force: true });
        }
      } catch (rollbackError) {
        rollbackErrors.push({
          path: file.path,
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
    }
    manifest.status = rollbackErrors.length === 0
      ? "DEPLOYMENT_FAILED_ROLLED_BACK"
      : "DEPLOYMENT_FAILED_ROLLBACK_INCOMPLETE";
    manifest.failedAt = new Date().toISOString();
    manifest.error = error instanceof Error ? error.message : String(error);
    manifest.rollbackErrors = rollbackErrors;
    await writeJson(join(backupRoot, "DEPLOYMENT.json"), manifest);
    throw new Error(`${manifest.status}: ${manifest.error}`);
  }
}
