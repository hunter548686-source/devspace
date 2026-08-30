import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  assertNoEscapingSymlinks,
  normalizeGitHubRepositoryUrl,
  npmInstallPlan,
  setupExternalRepository,
  validateExpectedCommit,
  validateGitRef,
} from "./external-repository.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  assert.equal(
    normalizeGitHubRepositoryUrl("https://github.com/mshumer/Claude-of-Duty"),
    "https://github.com/mshumer/Claude-of-Duty.git",
  );
  assert.equal(
    normalizeGitHubRepositoryUrl("https://github.com/mshumer/Claude-of-Duty.git"),
    "https://github.com/mshumer/Claude-of-Duty.git",
  );
  assert.throws(
    () => normalizeGitHubRepositoryUrl("http://github.com/mshumer/Claude-of-Duty"),
    /Only HTTPS github\.com repository URLs are allowed/,
  );
  assert.throws(
    () => normalizeGitHubRepositoryUrl("https://user:token@github.com/mshumer/Claude-of-Duty"),
    /must not contain credentials/,
  );
  assert.throws(
    () => normalizeGitHubRepositoryUrl("https://github.com/mshumer/Claude-of-Duty/tree/main"),
    /exactly one GitHub owner\/repository pair/,
  );

  assert.equal(validateGitRef("main"), "main");
  assert.equal(validateGitRef("release/v1.0.0"), "release/v1.0.0");
  assert.throws(() => validateGitRef("--upload-pack=evil"), /unsupported/);
  assert.throws(() => validateGitRef("refs/../evil"), /unsupported/);

  const commit = "d9b237b75c9304ab8d9ef4cfa0c3568c7c11a853";
  assert.equal(validateExpectedCommit(commit.toUpperCase()), commit);
  assert.throws(() => validateExpectedCommit("d9b237b"), /full 40-character/);

  assert.deepEqual(npmInstallPlan(true, false, false), {
    command: "npm",
    args: ["ci", "--no-audit", "--no-fund", "--ignore-scripts"],
  });
  assert.deepEqual(npmInstallPlan(false, true, true), {
    command: "npm",
    args: ["ci", "--no-audit", "--no-fund"],
  });
  assert.throws(
    () => npmInstallPlan(false, false, false),
    /requires package-lock\.json or npm-shrinkwrap\.json/,
  );

  const fixtureRoot = await mkdtemp(join(tmpdir(), "devspace-external-repository-"));
  const repositoryRoot = join(fixtureRoot, "repository");
  const outsideFile = join(fixtureRoot, "outside.txt");

  try {
    await mkdir(join(repositoryRoot, "inside"), { recursive: true });
    await writeFile(join(repositoryRoot, "inside", "target.txt"), "safe\n", "utf8");
    await writeFile(outsideFile, "outside\n", "utf8");
    await symlink("inside/target.txt", join(repositoryRoot, "internal-link"));
    await assertNoEscapingSymlinks(repositoryRoot);

    await symlink(outsideFile, join(repositoryRoot, "escaping-link"));
    await assert.rejects(
      () => assertNoEscapingSymlinks(repositoryRoot),
      /resolves outside the cloned repository/,
    );

    const workspaceRoot = join(fixtureRoot, "workspace");
    const canonicalRoot = join(fixtureRoot, "canonical-devspace");
    const registryPath = join(fixtureRoot, "PROJECT_REGISTRY.json");
    const duplicateDestination = join(workspaceRoot, "duplicate-devspace");
    await Promise.all([
      mkdir(workspaceRoot),
      mkdir(canonicalRoot),
    ]);
    await execFileAsync("git", ["init", canonicalRoot]);
    await execFileAsync("git", [
      "-C",
      canonicalRoot,
      "remote",
      "add",
      "origin",
      "git@github.com:Waishnav/devspace.git",
    ]);
    await writeFile(registryPath, JSON.stringify({
      projects: [{
        project_id: "devspace",
        canonical_path: canonicalRoot,
        git_repository: true,
      }],
    }));

    await assert.rejects(
      () => setupExternalRepository(
        {
          repositoryUrl: "https://github.com/waishnav/devspace",
          destination: "duplicate-devspace",
        },
        {
          cwd: workspaceRoot,
          root: workspaceRoot,
          projectRegistryPath: registryPath,
        },
      ),
      /DUPLICATE_REPOSITORY_IDENTITY.*already has canonical source/,
    );
    await assert.rejects(() => access(duplicateDestination), { code: "ENOENT" });

    const missingRegistryDestination = join(workspaceRoot, "missing-registry");
    await assert.rejects(
      () => setupExternalRepository(
        {
          repositoryUrl: "https://github.com/example/other",
          destination: "missing-registry",
        },
        {
          cwd: workspaceRoot,
          root: workspaceRoot,
          projectRegistryPath: join(fixtureRoot, "missing-registry.json"),
        },
      ),
      /SOURCE_AUTHORITY_REGISTRY_MISSING/,
    );
    await assert.rejects(() => access(missingRegistryDestination), { code: "ENOENT" });

    const occupiedDestination = join(workspaceRoot, "occupied");
    const occupiedSentinel = join(occupiedDestination, "keep.txt");
    await mkdir(occupiedDestination);
    await writeFile(occupiedSentinel, "owner data\n");
    await assert.rejects(
      () => setupExternalRepository(
        {
          repositoryUrl: "https://github.com/example/other",
          destination: "occupied",
        },
        {
          cwd: workspaceRoot,
          root: workspaceRoot,
          projectRegistryPath: registryPath,
          commandRunner: async () => {
            throw new Error("command runner must not run for an occupied destination");
          },
        },
      ),
      /Destination already exists/,
    );
    assert.equal(await readFile(occupiedSentinel, "utf8"), "owner data\n");

    const failedCloneDestination = join(workspaceRoot, "failed-clone");
    await assert.rejects(
      () => setupExternalRepository(
        {
          repositoryUrl: "https://github.com/example/other",
          destination: "failed-clone",
        },
        {
          cwd: workspaceRoot,
          root: workspaceRoot,
          projectRegistryPath: registryPath,
          commandRunner: async () => {
            throw new Error("injected clone failure");
          },
        },
      ),
      /injected clone failure.*removed only the destination directory claimed by this invocation/,
    );
    await assert.rejects(() => access(failedCloneDestination), { code: "ENOENT" });

    const replacedDestination = join(workspaceRoot, "replaced-during-clone");
    const replacementSentinel = join(replacedDestination, "concurrent-owner.txt");
    await assert.rejects(
      () => setupExternalRepository(
        {
          repositoryUrl: "https://github.com/example/other",
          destination: "replaced-during-clone",
        },
        {
          cwd: workspaceRoot,
          root: workspaceRoot,
          projectRegistryPath: registryPath,
          commandRunner: async () => {
            await rm(replacedDestination, { recursive: true, force: true });
            await mkdir(replacedDestination);
            await writeFile(replacementSentinel, "concurrent owner data\n");
            throw new Error("injected replacement race");
          },
        },
      ),
      /injected replacement race.*Cleanup refused.*restored without deletion/,
    );
    assert.equal(await readFile(replacementSentinel, "utf8"), "concurrent owner data\n");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
