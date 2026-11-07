# DevSpace source-authority and complete runtime-release final acceptance

- Run ID: `40f476d8-e7f2-4bde-8492-2243789d1e6d`
- Final verification: `2026-08-30T12:44:00Z` (`2026-08-30T22:44:00+1000`)
- Final state: `ACTIVE_ACCEPTANCE_PASS`

## Outcome

- One writable source authority is resolved from the existing portfolio registry: `/Users/liheng/Codex project/New project/devspace`.
- The former MCP copy is retained as `historical-upstream-reference`.
- The global npm directory is retained as `generated-installed-runtime` and remains byte-for-byte unchanged for the checked CLI, server and external-repository files.
- Active runtime is the read-only versioned release `/Users/liheng/.devspace/runtime/releases/waishnav-devspace-1.0.6-04e3af1b7989858f`.
- `/Users/liheng/.hermes/node/bin/devspace` atomically points to that release's `dist/cli.js`.
- Final LaunchAgent PID `34717` is running with last exit code `0` and listens on `127.0.0.1:7676`.

## Complete payload and source guard

- Payload authority: `npm pack --dry-run --json`, not a hand-maintained file list.
- Final payload: `380` files, `12,099,749` bytes.
- Bundle SHA-256: `04e3af1b7989858f8c9cd558387c1e16c7b134bfadd9a437d35b8cdbf6726d60`.
- Release manifest SHA-256: `51ccb2e5f47b161356af72204e126ed771767908a84e6e2418c4b474e12ce897`.
- Final activation manifest: `/Users/liheng/.devspace/runtime/releases/history/2026-08-30T12-43-12-660Z/ACTIVATION.json`.
- Final activation manifest SHA-256: `c1c73290d8ec0cd059f232e9e8e1d07ed5abb722c472dae19783d3928382a671`.
- Current pointer SHA-256: `b09d765e25e0dc0fab0804cc1072949f9fb13ad48f9b219013416bd2b89fe98b`.
- Enforced negative probes passed:
  - deployment from `/Users/liheng/Codex project/New project/mcp/.external/devspace` was blocked with exit `2` / `NON_CANONICAL_SOURCE`;
  - cloning `github.com/waishnav/devspace` again was blocked with exit `2` / `DUPLICATE_REPOSITORY_IDENTITY`.

## Verification

- `node --check` passed for the source guard, deployer, rollback controller and fault-injection test.
- `npm run unified-workspace:test-runtime` passed all 13 named scenarios, including full package inventory, isolated shadow start, read-only candidate, atomic symlink activation, later-link-change refusal, explicit rollback and injected automatic rollback.
- `npm run typecheck` passed.
- Full `npm test` chain passed.
- `npm run build` passed; Vite emitted only existing large-chunk warnings.
- Final candidate shadow start passed on an isolated temporary config/state and dynamic local port.
- Real rollback rehearsal passed: final candidate rolled back to the previous accepted candidate, returned local HTTP 200, and then reactivated the final candidate through the same shadow and service gates.
- Five consecutive post-reactivation local/public health rounds passed.
- OAuth authorization metadata, PKCE `S256`, protected-resource metadata and unauthenticated MCP HTTP 401 boundary passed.
- Real Cloudflare MCP after final reactivation: `open_workspace` succeeded for `/Users/liheng/Codex project/New project/系统`; the same workspace `ws_abbec4034f` completed `ls "."` 10/10. Server log recorded one successful open and ten successful reads from `2026-08-30T12:43:29Z` through `12:43:35Z`.
- `git diff --check` passed.

## Failure and recovery evidence

- The first real activation attempt exposed a controller-only optional-child check bug. The executable link was independently verified restored to the old installed runtime; local and public health were HTTP 200. The defect and exact output are recorded in `FAILURE_LOG.md`.
- The health wait was repaired and the test environment was changed so activation/rollback tests execute real HTTP polling even when LaunchAgent restart is skipped.
- The original acceptance was rerun and passed before the successful activation.

## Rollback and retention

- Immediate rollback command: `npm run unified-workspace:rollback` from the canonical DevSpace source.
- Rollback changes only the executable symlink, restarts `com.liheng.devspace`, verifies local health, and refuses if another task changed the link.
- The previous accepted candidate, original installed runtime, failed-attempt manifest, pre-change source backups and registry backup are retained through `2026-09-06` for recovery and audit.
- No Git commit, push, merge, tag, package publication, DNS/Tunnel change, OAuth credential access or external production deployment occurred.

## Dirty-state boundary

- Canonical DevSpace started with `129` Git status entries and ended with `130`; the single-entry increase is the new source-authority script. Existing unrelated dirty work was not reset, stashed, restored, cleaned, moved or deleted.
- Final full status SHA-256: `e3a10c6841726cca4bf6b0e7e7c817657205048f07c7167e8609b1bbdef89f3a`.
