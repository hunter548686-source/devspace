# DevSpace directory access fix — 2026-10-29

- Source commit: 39f5d16 (base: f71dcaf828b77aea28debfcacba60edfb0238c9d).
- Active MacBook Cloudflare runtime: waishnav-devspace-1.0.6-52419ce53fb73a81.
- Activation: ACTIVE_ACCEPTANCE_PASS; local health and three public health checks returned 200.
- Removed the five obsolete model-directory entries from /Users/liheng/.devspace/config.json blockedRoots; retained allowedRoots and authentication.
- A scan deadline or deferred macOS descendant error now selects file-scoped checks instead of disabling edit/write/shell. Existing target files are checked against their last successful read; new files require no prior read. Patch add/update/delete/move destinations are covered. Shell/process serialization remains. Full-tree review snapshots remain unavailable when a complete scan cannot be obtained.
- Validation: npm run typecheck, npm test, npm run build, source-authority enforcement and staged runtime health passed.
- Regression coverage: slow scan cancellation, dataless descendant, actual MCP read/write/edit/shell, stale file rejection and reread recovery, unrelated file changes, symlink targets and escape, long-running exclusion, patch destination overwrite protection.
- Live post-restart: all five former blocked roots plus Downloads and New project passed write/edit/read/bash. The home root passed read/edit/bash against the same Downloads verification file. No model, account or customer content was changed.
- Verification markers: devspace-access-verification-20261029.txt in Downloads and each former blocked root; docs/evidence/directory-access-20261029/live-check.txt under this repo.
- Activation initially stopped because the previous release lacked one archived docs backup. Restored exactly 2472 bytes matching its original SHA-256 9024576774291ca4403d6537d5188a4697399ff5dee3d46a2861a73a9048ddf3 from the existing rule-removal backup. The original release manifest and verification gate were unchanged. This restored an inert historical release artifact, not active project instructions.
- Rollback runtime: npm run unified-workspace:rollback (previous release waishnav-devspace-1.0.6-d777f20b1bc306c9).
- Rollback config: /Users/liheng/.devspace/config.before-directory-fix-20261029.json; restore with the file editor and run npm run unified-workspace:restart.
- This deployment changes the MacBook Cloudflare service only. Mac Studio/MSI runtimes were not deployed.
