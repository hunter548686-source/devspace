# DevSpace

This project exposes a local development workspace over MCP so ChatGPT, Claude,
or another MCP-capable host can operate directly on this machine's approved
development directories.

The goal is not to delegate work to a separate local coding agent. The MCP host
should call tools that read files, edit files, search code, and run shell
commands directly against approved local project roots.

Pi's SDK is currently used as the backend adapter for mature local coding
primitives such as read, edit, write, grep, find, ls, and bash. DevSpace wraps
those primitives behind a remote Streamable HTTP MCP interface, suitable for use
through a Cloudflare Tunnel.

The model-facing workflow is workspace based. MCP clients should call
`open_workspace` once per exact existing local project directory, then reuse the
returned `workspaceId` for subsequent tool calls in that same folder. DevSpace
must not create a second managed worktree or choose a historical worktree on the
client's behalf. Do not call `open_workspace` again for the same folder unless
the `workspaceId` is rejected as unknown or the client switches to a different
exact directory. `AGENTS.md` files are returned
automatically by `open_workspace` and by later tool calls when the requested path
enters a directory with instructions that have not been loaded for that
workspace.

Agent-driven production requirements:

- DevSpace exists so the MCP host Agent can inspect, plan, edit, verify, and close out project work directly rather than turning safe implementation into a sequence of commands for the user to run.
- The user supplies the goal, constraints, approvals, and owner-only decisions. The Agent should perform safe discovery, implementation, testing, retries, diff review, and reporting through explicit tools.
- Agent-driven does not mean unconstrained autonomy. Workspace allowlists, project instructions, permissions, evidence, rollback, tool safety, and explicit approval boundaries remain authoritative.
- Do not claim completion from a successful tool call alone; verify the requested project outcome.

Core constraints:

- Treat this as remote access to the local machine; security is part of the
  core design, not a later add-on.
- Start with a narrow filesystem allowlist.
- Prefer explicit, inspectable tool calls over autonomous local agent loops.
- Keep the first version small enough to validate with real ChatGPT/Claude MCP
  clients before adding UI or workflow features.
- DevSpace has one writable source authority: the `devspace` canonical path in
  `portfolio/PROJECT_REGISTRY.json`. Historical repository copies and global npm
  installations are not source authorities; runtime releases are generated under
  `~/.devspace/runtime/releases`. Before cloning the same repository or changing
  runtime code, use `npm run source-authority:check`; release activation itself
  must enforce the guard and may only use a complete npm package inventory.

<!-- BEGIN MANAGED PROJECT GOVERNANCE -->
Owner standing authorization: see the Owner 常设授权与边界 section in the global AGENTS.md; it overrides stricter generic clauses here.
Policy: project-governance@7.0.0
Constitution: PGS-000@1.1 (FROZEN)
Project ID: devspace
Canonical root: /Users/liheng/Codex project/New project/devspace
Default: minimal global rules + this project's own current rules/knowledge.
Owner exception: existing-project PBOS stage authorization gates retired 2026-10-26; use PBOS only for explicit 新项目立项. Product safety and release gates remain effective.
Current authority: resolve mutable current product/governance/source/release/stage state from this canonical project's machine-readable CURRENT pointer/status record when present; never use a version hardcoded in AGENTS.md as the current selector. Versioned references are historical/frozen evidence unless selected by the current pointer.
On demand: $project-governance and PGS-000@1.1 for scoped governance/release work. PBOS is used only when kk explicitly requests 新项目立项.
Delivery/structure contract changes in foundry/shared-platform/standalone-product work: apply FSDM-001@1.0 from Policy#foundry_to_standalone_method after checking governance/FOUNDRY_TO_STANDALONE_DELIVERY_METHOD_CURRENT.json; default to runtime independence, use role classification and seven operational records as optional references; require export, detachment, recovery and opt-in upgrade evidence for standalone acceptance. Bounded maintenance adds no seven-record requirement.
Task scope: 只有 Owner 常设授权第 5 条的四类先问。安全规则和硬限制不变;已有同范围授权不重复问。
Local Git: use Policy's pre-approved staged-diff review flow for an authorized implementation task: review the diff and selected staged diff, commit only this task's changes, and preserve unrelated staged work. Push within the authorized goal needs no separate approval; obey an explicit no-push instruction. No automatic amend/reset/stash/merge/tag or history rewriting.
External actions: production deploy/restart/configuration and release require current-task explicit authorization or applicable Owner standing authorization for the same scope and limits, with rollback and a passed release gate. Merge/tag/history rewriting still require explicit approval; DNS/domain/certificate changes, production/user-data mutation, new account connections, customer-route opening, external sending/private uploads and paid operations remain subject to the Owner standing authorization exclusions and project product-safety rules.
Authorization continuity: reuse valid same-task/scope approvals and already-authorized connections without asking again. Owner-authorized tasks may use necessary non-production account passwords, tokens and API keys from the local credential directory for login or service calls without another confirmation. Never expose credential values or send them to external services; never read production credentials.
Policy manifest SHA-256: decc55236d677a218232d6d9387beb1386b66e5b36420cec3779019c5b6d2fea
Generated block: do not edit manually.
<!-- END MANAGED PROJECT GOVERNANCE -->
