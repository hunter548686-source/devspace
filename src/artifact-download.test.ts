import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import * as z from "zod/v4";
import {
  artifactToolLogFields,
  downloadIncomingArtifact,
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { ArtifactError } from "./artifact-error.js";
import { loadConfig } from "./config.js";
import {
  IncomingArtifactAdapterRegistry,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import { WorkspaceRegistry } from "./workspaces.js";

const root = await mkdtemp(join(tmpdir(), "devspace-artifact-download-test-"));

try {
  testOneToolContract();
  testPlatformSupportContract();
  await testWorkspaceMutationGate(join(root, "workspace-mutation-gate"));
  if (isArtifactDownloadSupportedPlatform()) {
    await testSafeDownloadAndConflict(join(root, "downloads"));
    await testDestinationValidation(join(root, "destinations"));
    await testSizeLimitAndCleanup(join(root, "size-limit"));
    await testCrashLeftoverCleanup(join(root, "stale-partials"));
    await testSymlinkRejection(join(root, "symlinks"));
    await testPublicationFailurePreservesReplacement(join(root, "publication-race"));
    await testPublishedPermissions(join(root, "permissions"));
  } else {
    await testUnsupportedPlatform(join(root, "unsupported-platform"));
  }
  testLogRedaction();
} finally {
  await rm(root, { recursive: true, force: true });
}

function testOneToolContract(): void {
  const registered = new Map<string, { descriptor: Record<string, unknown>; callback: (input: never) => unknown }>();
  const server = {
    registerTool(
      name: string,
      descriptor: Record<string, unknown>,
      callback: (input: never) => unknown,
    ) {
      registered.set(name, { descriptor, callback });
      return {};
    },
  };

  registerArtifactTools(server as never, {
    config: {
      artifactMaxFileBytes: 1024,
      logging: { toolCalls: false },
    } as never,
    workspaces: {} as never,
  });

  assert.deepEqual([...registered.keys()], ["download_artifact"]);
  const descriptor = registered.get("download_artifact")?.descriptor;
  assert.ok(descriptor);
  assert.deepEqual(descriptor._meta, { "openai/fileParams": ["file"] });
  assert.deepEqual(Object.keys(descriptor.inputSchema as object).sort(), ["file", "path", "workspaceId"]);
  assert.deepEqual(Object.keys(descriptor.outputSchema as object), ["path"]);
  assert.equal((descriptor.annotations as { destructiveHint?: boolean }).destructiveHint, false);

  const fileSchema = (descriptor.inputSchema as z.ZodRawShape).file as z.ZodType;
  const valid = {
    download_url: "https://files.oaiusercontent.com/file_123/download?sig=secret",
    file_id: "file_123",
    mime_type: "image/png",
    file_name: "generated.png",
  };
  assert.deepEqual(fileSchema.parse(valid), valid);
  assert.throws(() => fileSchema.parse({ file_id: "file_123" }));

  const sensitiveExtraValue = "Bearer should-not-leak";
  const rejected = fileSchema.safeParse({
    ...valid,
    authorization: sensitiveExtraValue,
  });
  assert.equal(rejected.success, false);
  assert.equal(JSON.stringify(rejected).includes(sensitiveExtraValue), false);
}

function testPlatformSupportContract(): void {
  assert.equal(isArtifactDownloadSupportedPlatform("linux"), true);
  assert.equal(isArtifactDownloadSupportedPlatform("darwin"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("freebsd"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("openbsd"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("netbsd"), false);
  assert.equal(isArtifactDownloadSupportedPlatform("win32"), false);
}

async function testWorkspaceMutationGate(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  const agentDir = join(testRoot, "agent");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "test instructions\n");
  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(testRoot, ".config"),
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_WORKTREE_ROOT: join(testRoot, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const workspaces = new WorkspaceRegistry(config);
  let opened = await workspaces.openWorkspace(workspaceRoot);
  let downloadCalls = 0;
  let callback: ((input: Record<string, unknown>) => Promise<unknown>) | undefined;
  const server = {
    registerTool(
      _name: string,
      _descriptor: Record<string, unknown>,
      registeredCallback: (input: Record<string, unknown>) => Promise<unknown>,
    ) {
      callback = registeredCallback;
      return {};
    },
  };

  registerArtifactTools(server as never, {
    config,
    workspaces,
    downloadArtifact: async ({ workspaceRoot: selectedRoot, path }) => {
      downloadCalls += 1;
      await writeFile(join(selectedRoot, path), "artifact bytes\n");
      return {
        path,
        size: 15,
        sha256: `sha256:${"0".repeat(64)}`,
      };
    },
  });
  assert.ok(callback);
  const invoke = callback;

  await writeFile(join(workspaceRoot, "external-change.txt"), "outside\n");
  await assert.rejects(
    () => invoke({
      file: { native: true },
      workspaceId: opened.workspace.id,
      path: "stale-download.bin",
    }),
    /WORKSPACE_CHANGED_EXTERNALLY/,
  );
  assert.equal(downloadCalls, 0);
  await assert.rejects(readFile(join(workspaceRoot, "stale-download.bin")), /ENOENT/);

  opened = await workspaces.openWorkspace(workspaceRoot);
  await invoke({
    file: { native: true },
    workspaceId: opened.workspace.id,
    path: "downloaded.bin",
  });
  assert.equal(await readFile(join(workspaceRoot, "downloaded.bin"), "utf8"), "artifact bytes\n");
  await workspaces.runMutation(opened.workspace, "after-artifact", async () => {
    await writeFile(join(workspaceRoot, "after-artifact.txt"), "safe\n");
  });
}

async function testUnsupportedPlatform(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "blocked.txt",
    }),
    "artifact_platform_unsupported",
  );
}

async function testSafeDownloadAndConflict(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const bytes = Buffer.from("native artifact bytes\u0000\xff", "latin1");
  const registry = registryFor({
    name: "../../generated.png",
    size: bytes.length,
    stream: Readable.from([bytes]),
  });

  const first = await downloadIncomingArtifact({
    registry,
    workspaceId: "ws_test",
    workspaceRoot,
    maxFileBytes: 1024,
    file: { native: true },
    path: "public/images/generated.png",
  });
  assert.equal(first.path, "public/images/generated.png");
  assert.deepEqual(await readFile(join(workspaceRoot, first.path)), bytes);

  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({
        name: "replacement.png",
        stream: Readable.from(["replacement"]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "public/images/generated.png",
    }),
    "artifact_destination_exists",
  );
  assert.deepEqual(await readFile(join(workspaceRoot, first.path)), bytes);
  assert.deepEqual(await readdir(workspaceRoot), ["public"]);
}

async function testDestinationValidation(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  for (const path of ["../outside.txt", "nested/../outside.txt", "/absolute.txt", "folder/"]) {
    await expectArtifactError(
      downloadIncomingArtifact({
        registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
        workspaceId: "ws_test",
        workspaceRoot,
        maxFileBytes: 1024,
        file: { native: true },
        path,
      }),
      "artifact_destination_invalid",
    );
  }
}

async function testSizeLimitAndCleanup(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({
        name: "too-large.bin",
        size: 5,
        stream: Readable.from([Buffer.from("12345")]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 4,
      file: { native: true },
      path: "too-large.bin",
    }),
    "artifact_file_too_large",
  );

  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({
        name: "stream-too-large.bin",
        stream: Readable.from([Buffer.from("123"), Buffer.from("45")]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 4,
      file: { native: true },
      path: "stream-too-large.bin",
    }),
    "artifact_file_too_large",
  );

  assert.deepEqual(await readdir(workspaceRoot), []);
}

async function testCrashLeftoverCleanup(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await downloadIncomingArtifact({
    registry: registryFor({ name: "first.txt", stream: Readable.from(["first"]) }),
    workspaceId: "ws_test",
    workspaceRoot,
    maxFileBytes: 1024,
    file: { native: true },
    path: "downloads/first.txt",
  });

  const destinationDirectory = join(workspaceRoot, "downloads");
  const stalePartial = join(destinationDirectory, ".devspace-download-stale.partial");
  const recentPartial = join(destinationDirectory, ".devspace-download-recent.partial");
  const unrelated = join(destinationDirectory, "keep-me.partial");
  await writeFile(stalePartial, "stale");
  await writeFile(recentPartial, "recent");
  await writeFile(unrelated, "unrelated");
  const old = new Date(Date.now() - (48 * 60 * 60 * 1_000));
  await utimes(stalePartial, old, old);

  await downloadIncomingArtifact({
    registry: registryFor({ name: "second.txt", stream: Readable.from(["second"]) }),
    workspaceId: "ws_test",
    workspaceRoot,
    maxFileBytes: 1024,
    file: { native: true },
    path: "downloads/second.txt",
  });

  const entries = await readdir(destinationDirectory);
  assert.equal(entries.includes(".devspace-download-stale.partial"), false);
  assert.equal(entries.includes(".devspace-download-recent.partial"), true);
  assert.equal(entries.includes("keep-me.partial"), true);
  assert.equal(entries.includes("first.txt"), true);
  assert.equal(entries.includes("second.txt"), true);
}

async function testSymlinkRejection(testRoot: string): Promise<void> {
  if (process.platform === "win32") return;

  const outside = join(testRoot, "outside");
  await mkdir(outside, { recursive: true, mode: 0o700 });

  const linkedWorkspaceRoot = join(testRoot, "linked-workspace");
  await symlink(outside, linkedWorkspaceRoot, "dir");
  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
      workspaceId: "ws_test",
      workspaceRoot: linkedWorkspaceRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "blocked.txt",
    }),
    "artifact_workspace_unsafe",
  );

  const linkedDestinationRoot = join(testRoot, "linked-destination-workspace");
  await mkdir(linkedDestinationRoot, { recursive: true });
  await symlink(outside, join(linkedDestinationRoot, "assets"), "dir");
  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({ name: "blocked.txt", stream: Readable.from(["blocked"]) }),
      workspaceId: "ws_test",
      workspaceRoot: linkedDestinationRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "assets/blocked.txt",
    }),
    "artifact_destination_parent_unsafe",
  );
}

async function testPublicationFailurePreservesReplacement(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const destinationPath = join(workspaceRoot, "generated.txt");

  await expectArtifactError(
    downloadIncomingArtifact({
      registry: registryFor({
        name: "generated.txt",
        stream: Readable.from(["downloaded"]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "generated.txt",
      publishLink: async (partialPath, candidatePath) => {
        await link(partialPath, candidatePath);
        await unlink(candidatePath);
        await writeFile(candidatePath, "replacement");
      },
    }),
    "artifact_destination_publish_failed",
  );

  assert.equal(await readFile(destinationPath, "utf8"), "replacement");
  assert.deepEqual(await readdir(workspaceRoot), ["generated.txt"]);
}

async function testPublishedPermissions(testRoot: string): Promise<void> {
  const workspaceRoot = join(testRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const previousUmask = process.umask(0o077);
  try {
    await downloadIncomingArtifact({
      registry: registryFor({
        name: "private.txt",
        stream: Readable.from(["private"]),
      }),
      workspaceId: "ws_test",
      workspaceRoot,
      maxFileBytes: 1024,
      file: { native: true },
      path: "private.txt",
    });
  } finally {
    process.umask(previousUmask);
  }

  assert.equal((await stat(join(workspaceRoot, "private.txt"))).mode & 0o777, 0o600);
}

function testLogRedaction(): void {
  const fields = artifactToolLogFields({
    file: {
      download_url: "https://files.oaiusercontent.com/file_123/download?sig=super-secret",
      file_id: "file_secret",
      file_name: "generated.png",
      authorization: "Bearer log-secret",
    },
    workspaceId: "ws_secret",
    path: "private/generated.png",
  });
  const serialized = JSON.stringify(fields);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("file_secret"), false);
  assert.equal(serialized.includes("log-secret"), false);
  assert.equal(serialized.includes("ws_secret"), true);
  assert.equal(serialized.includes("files.oaiusercontent.com"), true);
}

function registryFor(source: {
  name: string;
  mimeType?: string;
  size?: number;
  stream: Readable;
}): IncomingArtifactAdapterRegistry {
  const adapter: IncomingArtifactAdapter = {
    id: "test-native",
    canHandle: () => true,
    async open() {
      return source;
    },
  };
  return new IncomingArtifactAdapterRegistry([adapter]);
}

async function expectArtifactError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ArtifactError && error.code === code,
  );
}
