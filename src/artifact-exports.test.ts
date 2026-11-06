import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { ArtifactExports, registerExportRoute } from "./artifact-exports.js";

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "devspace-artifact-http-"));
  let server: Server | undefined;

  try {
    // Exercise the default hidden parent directory through the real HTTP route.
    const stateDir = join(temporaryRoot, ".local", "share", "devspace");
    const workspaceRoot = join(temporaryRoot, "workspace");
    await mkdir(workspaceRoot);
    const sourcePath = join(workspaceRoot, "deliverable.bin");
    const expected = Buffer.from([0, 1, 2, 10, 13, 127, 128, 254, 255]);
    await writeFile(sourcePath, expected);

    const exports = new ArtifactExports(join(stateDir, "exports"));
    const valid = await exports.create(
      "artifact-http-test",
      workspaceRoot,
      sourcePath,
      "application/octet-stream",
      3600,
    );
    // The internal store accepts zero TTL; this creates an already-expired
    // fixture without changing the clock, waiting, or modifying stored records.
    const expired = await exports.create(
      "artifact-http-test",
      workspaceRoot,
      sourcePath,
      "application/octet-stream",
      0,
    );

    const app = express();
    registerExportRoute(app, stateDir);
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", resolve);
      server.once("error", reject);
    });

    const address = server!.address();
    assert.ok(address && typeof address !== "string", "HTTP listener must have a port");
    const download = async (token: string): Promise<Response> => {
      const url = new URL("/artifacts/download", `http://127.0.0.1:${address.port}`);
      url.searchParams.set("token", token);
      return fetch(url, { signal: AbortSignal.timeout(5000) });
    };

    const response = await download(valid.token);
    assert.equal(response.status, 200, "valid export under hidden stateDir must download");
    const actual = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(actual, expected, "HTTP download must preserve every byte");
    assert.equal(createHash("sha256").update(actual).digest("hex"), valid.sha256);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("content-length"), String(expected.length));
    assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");

    const invalidToken =
      valid.token.slice(0, -1) + (valid.token.endsWith("0") ? "1" : "0");
    const rejected: Array<[string, string]> = [
      ["invalid token", invalidToken],
      ["expired token", expired.token],
      ["path-like token", "../workspace/deliverable.bin"],
    ];
    for (const [label, token] of rejected) {
      const denied = await download(token);
      assert.equal(denied.status, 404, `${label} must remain unavailable`);
      assert.deepEqual(await denied.json(), { error: "export_not_found_or_expired" });
    }

    console.log("artifact export HTTP regression passed: bytes, headers, and rejected tokens");
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected test failure";
  console.error(message.replace(/[a-f0-9]{64}/g, "[redacted]"));
  process.exitCode = 1;
});
