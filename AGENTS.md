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

规则:只看 `/Users/liheng/Codex project/New project/SAFETY.md`(安全底线和 kk 的规矩)。受管块、续跑循环、PBOS、版本指针和哈希核对已于 2026-10-27 取消。
