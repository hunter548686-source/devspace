# Mini / Air runtime alignment — blocked before remote mutation

Recorded: 2026-11-06 UTC. Goal: `20261106T085041Z-align-mini-and-air-devspace-to-verified-8592901--9db6a9fd`.

## Per-host outcome

| Host | Outcome | Observed result | Runtime mutation / rollback |
| --- | --- | --- | --- |
| `mac-mini` | BLOCKED | Existing-alias SSH connection denied locally, exit 255 | No remote command executed; no backup, candidate, install, or restart created; rollback not required |
| `macbook-air` | BLOCKED / NOT ATTEMPTED | Not contacted after Mini was blocked, preserving required host order | No backup, candidate, install, or restart created; rollback not required |

Neither host is accepted. Host identity, original/new executable, npm prefix, package version, Node ABI, launch PID, config/state paths, active durable tasks, and public URL remain unverified. Labels `com.liheng.devspace-mini` / `com.liheng.devspace-air`, port 7676, and the global install path are requested targets, not live observations.

## Actual denials

The initial read-only Mini probe used existing SSH trust:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 mac-mini 'hostname; uname -s -m; id -u; /opt/homebrew/bin/node -p "JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,abi:process.versions.modules})"; /opt/homebrew/bin/npm prefix -g; readlink /opt/homebrew/bin/devspace'
```

Exact result, exit 255:

```text
ssh: connect to host 100.109.26.90 port 22: Operation not permitted
```

`preflight_codex_goal` was called for `.chatgpt-codex-bridge/goals/20261106T085041Z-align-mini-and-air-devspace-to-verified-8592901--9db6a9fd.md`, target `/Users/liheng/Codex project/New project/devspace`, sandbox `workspace-write`, timeout 3600000. It returned `isError: true`:

```text
MCP tool call requires approval, but approval policy is never
```

The bridge did not return a reviewed execution plan. No `run_codex_goal` execution was requested after this refusal. No alternate connector, tunnel, loader, sandbox mode, or delegated execution was used to bypass either denial.

## Canonical source and local checks

Canonical path: `/Users/liheng/Codex project/New project/devspace`.

- `SAFETY.md` was read first; old governance scripts were not applied.
- The current project registry maps this path to project `devspace`.
- `git rev-parse HEAD` before checks and after build: `859290170b1a84ebfafaf368119407393416bc3b`.
- `git diff --quiet` and `git diff --cached --quiet` passed. No tracked source/configuration changes were made.
- Manifest identity: `@waishnav/devspace@1.0.6`; `bin.devspace = dist/cli.js`, `main = dist/server.js`.
- Local Node: `v22.22.3`, `darwin`, `arm64`, ABI `127`. These are Pro build-environment values, not either destination host's values.
- `dist` is not tracked. Manifest has no `prepare` / `prepack`; a Git-only install would not provide this generated runtime.

| Command / check | Result | Limit |
| --- | --- | --- |
| `./node_modules/.bin/tsx src/inspection-tasks.test.ts` | BLOCKED, exit 1 | tsx IPC listener failed before tests ran |
| `./node_modules/.bin/tsx src/oauth-store.test.ts` | BLOCKED, exit 1 | tsx IPC listener failed before tests ran |
| `npm run typecheck` | PASS, exit 0 | Existing local dependencies |
| `npm run build` | PASS, exit 0 | Existing local dependencies; generated local dist only |
| Built CLI/server/worker entrypoints and tool registration inspection | PASS, static inspection | Does not establish installed or served tools |
| Full `npm test` | NOT RUN | Same tsx runner already denied; no repeat or loader workaround |
| `npm pack` / archive SHA256 | NOT RUN / unavailable | Required functional gates and remote preflight blocked; no deployable archive asserted |

Exact focused-test failures:

```text
Error: listen EPERM: operation not permitted /var/folders/d9/65mzvt1d0c789zjw5h7t53700000gn/T/tsx-501/43561.pipe
Error: listen EPERM: operation not permitted /var/folders/d9/65mzvt1d0c789zjw5h7t53700000gn/T/tsx-501/43562.pipe
```

The build used the manifest's ordinary clean + Vite + TypeScript workflow. Vite reported a future native-config-loader warning for `__dirname` and a chunk-size warning; the build exited successfully. No source changes were made to suppress warnings.

Static inspection of generated `dist/durable-tasks.js` found registrations for `start_task`, `list_tasks`, `task_status`, `task_log`, `task_input`, and `cancel_task`; `dist/server.js` imports and calls `registerDurableTaskTools`. Generated `dist/workspaces.js` contains `scopedMutationSession` and `WORKSPACE_FILE_SCOPED_CHECKS`. These are local build observations only.

The existing source scoped-check regression was read at `src/workspaces.test.ts:339`; it changes `unrelated.txt` at the workspace root while the target is `nested/file.txt`. It was not executed and is not claimed as the required installed-code same-directory regression.

## Local non-secret hashes

| File | SHA256 |
| --- | --- |
| `package.json` | `602fdee2917ebe95f76526c744a6d610151558cf8554a5d80aac428cc51a791b` |
| `package-lock.json` | `ae98e057bcc5236a4f5c817148c1e976fbd320192485a2c92cd1158a98376611` |
| `dist/cli.js` | `8ff985b0725e006ecf0626783ef4cf8f9b1adea8d114ceb088cd7465fa1e2481` |
| `dist/server.js` | `bb227bed2ccfd059cac21f435e4fbf30e4f110016cb5fccb9467fcb9310c39c4` |
| `dist/durable-tasks.js` | `9a2031e87ae3e513dbe35f990db6df9ae2e2f98577b316dfc2317d743c480428` |
| `dist/task-worker.js` | `c6632ed99f0b08b51c1fd30aa8b6f7444f1663c5917314bc8669d72c80ca2001` |
| `dist/workspaces.js` | `4307f836c912171ba40a8d87c9da484e97b2a0fde63502062aff0bcee2d79342` |

## Preservation and remaining acceptance

No remote config, OAuth/client database, state directory, global package, executable, launch plist, or task was accessed or changed. Therefore preservation is based on absence of mutation; before/after remote identity or hash comparisons were not possible. No backup/rollback paths or exact restore commands exist for this run because the first connection failed before any remote mutation.

Before local build, the configured Pro LaunchAgent executable was inspected without printing environment values: `/Users/liheng/.devspace/bin/devspace` resolves to `/Users/liheng/.devspace/runtime/releases/waishnav-devspace-1.0.6-a45e787c6ced58d6/dist/cli.js`, outside the rebuilt checkout. This was a configuration/symlink check, not a live-process acceptance claim. No service-control command was issued for Pro, Mini, Air, Studio, or MSI.

Only the authorized generated checkout `dist` was rebuilt and this new evidence directory was authored. Existing untracked `docs/decisions.md` and evidence directories were preserved. A concurrent `docs/evidence/unattended-20261106/` appeared between status checks and was not read, modified, or adopted as evidence.

Still required on each destination: verified host/install identity; protected local rollback package, symlink/wrapper, launch plist, config and state copies; current-ABI candidate installation; package archive verification; local `/healthz` 200 and unauthenticated `/mcp` 401; unchanged existing public URL check; actual installed/served tool verification; same-directory scoped regression; harmless durable worker completion through the real service restart; config/OAuth identity comparisons; acceptance or immediate rollback. Neither live authenticated MCP integration nor an isolated DurableTasks restart test ran on either host.

ChatGPT action snapshot refresh was not performed; no browser context was used.

## Independent continuation

Continue under the existing authorization in an execution environment that permits existing-host SSH and the required local tsx IPC. No additional owner authorization is inferred to be necessary for the already-authorized reversible work. Recheck canonical SHA and tracked cleanliness because source and hosts may change between runs.

The immediate local gate commands are:

```sh
git rev-parse HEAD
git diff --quiet
git diff --cached --quiet
./node_modules/.bin/tsx src/inspection-tasks.test.ts
./node_modules/.bin/tsx src/oauth-store.test.ts
npm run typecheck
npm test
npm run build
```

Only after the required gates and preflight are available, use ordinary `npm pack`, record the archive SHA256 and inspect entries, then perform the originally authorized sequential Mini → Air backup/candidate/install/restart/acceptance workflow. Existing untracked documentation must remain preserved and should not be assumed to be part of the exact committed source payload when reviewing the archive contents.
