# Workspace open recovery — 2026-10-17

## Result

Repair is active on the user's MacBook Pro. Runtime: `waishnav-devspace-1.0.6-d777f20b1bc306c9`.
Service PID changed from 1826 to 11931. Local health returned HTTP 200; all three public health checks returned HTTP 200. The temporary activation job was removed and the real service remains running.

## Verified causes

- The archived `Codex Computer Use.app` beneath `/Users/liheng/Documents/Codex/2026-09-30/task/upgrade-26.928.20755/candidate-home/computer-use` is marked `compressed,dataless`. Native directory enumeration immediately returned Darwin errno 11 (EDEADLK; Node reports unknown system error -11).
- The initial mutation-baseline scan allowed a descendant directory error to abort opening an otherwise readable ancestor.
- Instruction discovery had a second failure path: `opendir` could succeed but its asynchronous iterator then raised the same directory error.
- `Downloads` contained 915,901 files across 5,447 directories under the same exclusions. A single-level list was fast. Reading file contents recursively before returning the workspace caused the open timeout.

## Changes

- Initial open/reopen now attempts a complete baseline with a 2,000 ms scan budget.
- A descendant Darwin EDEADLK or the scan deadline returns an explicitly degraded read workspace. The mutation baseline is undefined; no partial digest can authorize a write or shell command.
- Deadline cancellation reaches active file streams and Git commands; traversal checks cancellation between filesystem operations. Initial Git file inspection uses bounded batches.
- Root failures and unrelated filesystem errors remain visible.
- Reopening updates baseline and diagnostic together, clearing a stale baseline or an obsolete diagnostic as appropriate.
- Instruction discovery tolerates the deferred EDEADLK iterator failure in descendants.
- Both open entry points expose the diagnostic in model text, structured instruction, and card metadata. Degraded opens do not start a review snapshot.
- Existing user changes to fingerprint metadata, size limits, and context-directory exclusions were retained.

Changed code: `src/workspaces.ts`, `src/server.ts`; regression tests in their matching test files. Pre-edit source snapshots are retained beside this report.

## Verification

- Reproduced the native fault before changing production.
- New regression tests failed before their corresponding fixes.
- `npm run typecheck`: PASS.
- `npm test`: PASS, including workspace, conversation concurrency, and MCP server tests.
- Source-authority check and enforced release guard: PASS.
- Full npm package payload: 387 files; staged runtime isolated health: PASS.
- Candidate tests on the actual failing paths: PASS.
- Live connector opens, including round trip:
  - `/Users/liheng/Documents/Codex/2026-09-30/task/upgrade-26.928.20755/candidate-home/computer-use`: 638 ms.
  - `/Users/liheng/Documents/Codex`: 775 ms.
  - `/Users/liheng/Downloads`: 2682 ms.
- Live top-level listing succeeded for Documents/Codex (7 entries) and Downloads (303 entries); a normal project file read succeeded.
- Live native `networkQuality -c -M 40` completed successfully and thus also verified remote command execution.

## Network measurement

Started at 2026-10-17 05:42:55 UTC.
Download: 472.14 Mbps.
Upload: 44.08 Mbps.
Base RTT: 20.51 ms.
Responsiveness: 923.25 RPM.
Native output identifies interface `lo0` and proxied flows. These measurements reflect the currently configured proxy path, not an isolated direct Wi-Fi/broadband test. Full output is in `networkQuality.json`.

## Scope and recovery

The archived dataless app was not hydrated or deleted. Broad ancestor workspaces with incomplete baselines are readable; normal edits and commands work in an exact smaller existing project with a complete baseline.

The previous runtime `waishnav-devspace-1.0.6-c08c8bbc5baf9718` remains available. The existing managed rollback script and activation manifest preserve its binding. No allowlist, authentication, or security guard changes were made.

Activation evidence: `waishnav-devspace-1.0.6-d777f20b1bc306c9` is referenced by the runtime current pointer and has `ACTIVE_ACCEPTANCE_PASS`. Temporary launchd job removal was verified.
