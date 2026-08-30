# Troubleshooting Gotchas

This page collects the setup issues users are most likely to hit.

## `devspace` Command Not Found

Use `npx`:

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
```

If you installed globally, confirm npm's global bin directory is on `PATH`.

## Unsupported Node Version

DevSpace requires Node `>=22.19 <27`.

Check:

```bash
node --version
```

Install Node 22 LTS with your preferred version manager such as `nvm`, `fnm`, or
`mise`.

## `better-sqlite3` Could Not Load

This usually means native dependencies were installed under a different Node
runtime.

Try:

```bash
npm rebuild better-sqlite3
```

Then run:

```bash
npx @waishnav/devspace doctor
```

Release starts run a native dependency check before launching.

## Public URL Includes `/mcp`

Use the origin for setup:

```text
https://your-tunnel-host.example.com
```

Use the MCP endpoint in the client:

```text
https://your-tunnel-host.example.com/mcp
```

If you saved the wrong value:

```bash
npx @waishnav/devspace config set publicBaseUrl https://your-tunnel-host.example.com
```

## Tunnel URL Changed

Temporary tunnels often change URLs between runs.

For a one-off run:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" npx @waishnav/devspace serve
```

For a stable URL:

```bash
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Host Header Or 403 Problems

DevSpace derives allowed hosts from the configured public URL.

Run:

```bash
npx @waishnav/devspace doctor
```

Confirm the public URL hostname appears in allowed hosts. If you changed tunnel
URLs, update `publicBaseUrl`.

Use this only for intentional local debugging:

```bash
DEVSPACE_ALLOWED_HOSTS="*" npx @waishnav/devspace serve
```

## OAuth Redirect Host Rejected

By default, DevSpace allows redirects for:

```text
chatgpt.com
localhost
127.0.0.1
```

If another MCP client uses a different redirect host, configure:

```bash
DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS="chatgpt.com,example.com" npx @waishnav/devspace serve
```

## Owner Password Not Accepted

Make sure you are entering the Owner password from:

```text
~/.devspace/auth.json
```

To regenerate setup:

```bash
npx @waishnav/devspace init --force
```

## Unknown or Expired `workspaceId`

`workspaceId` values are session identifiers. If the client receives an unknown
or expired workspace error, call `open_workspace` once with the exact existing
checkout directory, then reuse the returned `workspaceId` for later tools.

Workspace session metadata is persisted. ChatGPT may provide optional
conversation metadata that lets DevSpace resume the same checkout workspace for
the same project in that conversation; repeated opens reuse the `workspaceId`
and do not repeat context already provided for that reused checkout. Hosts
without supported conversation metadata receive a normal new workspace. In all
cases, continue passing the `workspaceId` returned by `open_workspace` to later
tools. DevSpace does not create a missing directory or a managed worktree.

To review work, call `show_changes` once after the final related file change. It
shows the combined changes and advances the review point automatically.

## Data Retention

DevSpace does not currently prune workspace sessions, conversation bindings,
or review refs. A future product retention policy will define safe cleanup for
these records; no automatic deletion is performed today.

## Workspace Path Rejected

The path must be inside one of the allowed roots configured during setup.

Run:

```bash
npx @waishnav/devspace config get
```

Then either open a project under an allowed root or rerun setup:

```bash
npx @waishnav/devspace init --force
```

## ChatGPT Still Shows Retired Actions or an Old Schema

The live DevSpace server and ChatGPT's approved app actions are separate layers.
Restarting DevSpace updates the live MCP server, but it does not automatically
replace a frozen ChatGPT action snapshot. A stale snapshot can still advertise a
retired parameter such as `mode: worktree`, omit a newly added tool, or cause an
input-validation error before DevSpace's own handler runs.

For an app managed by a ChatGPT workspace admin or owner, open the app's Action
control and use **Refresh** to review the current tools and input definitions.
Review the diff and explicitly enable any newly discovered action that should be
available. Some published app types may need to be recreated and republished
instead of updated in place. Open a new chat for the final tool-list verification
so an already-open conversation is not treated as proof that the refresh failed.

OpenAI documents this behavior in [Developer mode and MCP apps in
ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).

Do not delete DevSpace OAuth records or tokens merely to refresh an action
snapshot. That changes authentication state and does not replace the admin-side
action review.

## Windows Shell Commands Fail

DevSpace shell execution requires Bash. Native PowerShell and `cmd.exe` command
execution are not supported yet.

Install Git for Windows and use Git Bash, or use WSL, MSYS2, or Cygwin Bash.

Run:

```bash
npx @waishnav/devspace doctor
```

Confirm Bash is detected.

## Skills Do Not Appear

Skills are enabled by default. Check:

```bash
DEVSPACE_SKILLS=1 npx @waishnav/devspace serve
```

DevSpace looks in standard Agent Skills locations:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also checks compatibility and custom paths:

- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

If a skill appears in `open_workspace`, the model must read that skill's
`SKILL.md` before reading other files inside the skill directory.

## Review Card Does Not Appear

Per-tool widget cards are enabled by default with:

```bash
DEVSPACE_WIDGETS=full
```

The aggregate `show_changes` tool is only exposed with
`DEVSPACE_WIDGETS=changes`. Plain MCP clients may ignore ChatGPT Apps widget
metadata and only show text results.
