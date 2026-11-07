# DevSpace source-authority and runtime-release baseline

- Run ID: `40f476d8-e7f2-4bde-8492-2243789d1e6d`
- Captured: `2026-08-30T12:27:40Z` (`2026-08-30T22:27:40+1000`)
- Canonical source: `/Users/liheng/Codex project/New project/devspace`
- Canonical branch / HEAD: `main` / `f5286f90092eaa6942f7507a4e9647a6f6b16e87`
- Pre-change Git status entries / SHA-256: `129` / `0ee2daca16550a285c2d3c724baa78a190aeb18fef684cd30487e01a0b87f932`
- Package candidate inventory: `@waishnav/devspace@1.0.6`, `379` files, `12,085,185` unpacked bytes.
- Current executable link: `/Users/liheng/.hermes/node/bin/devspace -> ../lib/node_modules/@waishnav/devspace/dist/cli.js`
- Current service: LaunchAgent running, PID `75350`, last exit code `0`.
- Current local and public `/healthz`: HTTP 200 with `{"ok":true,"name":"devspace"}`.
- Canonical and historical-reference Git origins both normalize to `github.com/waishnav/devspace`.
- Registry canonical project: `/Users/liheng/Codex project/New project/devspace`.
- Registry historical reference: `/Users/liheng/Codex project/New project/mcp/.external/devspace`, role `historical-upstream-reference`.
- Existing installed runtime: `/Users/liheng/.hermes/node/lib/node_modules/@waishnav/devspace`.

## Confirmed design defect

The repaired deployment still uses a hand-maintained list of seven `dist` files. It catches the currently known missing module but can repeat the same failure when a future build adds another runtime file outside that list. The replacement must derive its payload from the complete npm package inventory, stage it separately, verify it before activation, switch one executable pointer atomically, and retain the untouched installed runtime as rollback.

## Safety boundary

No DNS, Cloudflare Tunnel, OAuth credential, Git commit, push, merge, package publication or external production deployment is authorized. Existing dirty state and all three historical/current copies are preserved.
