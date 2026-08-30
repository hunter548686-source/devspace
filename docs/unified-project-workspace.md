# Unified Project Workspace

Unified Project Workspace keeps ChatGPT Project, Work, Codex, and DevSpace on one registered physical project directory.

## Identity

The permanent identity is the existing `project_id` in:

- `<portfolio-root>/portfolio/PROJECT_REGISTRY.json`

`workspaceId`, conversation IDs, branch names, and ChatGPT titles are not permanent project identities.

## Normal use

A ChatGPT Project should carry one stable instruction such as:

```text
LOCAL_PROJECT_ID=taskcut
For local project work, call open_project with this exact ID before reading or changing files.
```

DevSpace then resolves the registered canonical directory or an explicitly identified existing task worktree. It never creates a hidden worktree and never chooses among ambiguous worktrees.

Codex opens the same physical directory directly. ChatGPT and Work reach it through DevSpace. Chat histories remain separate; verified decisions, task state, code, Git state, and evidence remain in the project workspace.

## Safety behavior

- Project identity matching is exact. Unknown or ambiguous names fail closed.
- Existing `open_workspace(path)` remains available as a compatibility and recovery entry.
- A stale ChatGPT/Work session cannot overwrite changes made by another session or directly by Codex; it must reopen and reread the workspace first.
- `setup_external_repository` remains disabled unless explicitly enabled.

## Source and runtime authority

- The `devspace` entry in `portfolio/PROJECT_REGISTRY.json` is the only writable
  source authority.
- Historical repository copies and global npm installations are retired rather
  than treated as alternate source trees.
- Activated releases live under `~/.devspace/runtime/releases`. Each release is
  generated from the complete `npm pack --dry-run --json` inventory, contains a
  SHA-256 manifest, is shadow-started with isolated temporary configuration and
  state, and is made read-only before activation.
- `npm run source-authority:check` reports the current roles. Deployment enforces
  the same invariant and refuses a non-canonical source or an unregistered
  runtime target.

## Rollback

### Immediate feature disable

```bash
npm run unified-workspace:disable
npm run unified-workspace:restart
```

This keeps the generated release files but removes `open_project` after restart. Legacy `open_workspace` continues to work.

### Runtime release rollback

```bash
npm run unified-workspace:rollback
```

Activation changes only the stable `~/.devspace/bin/devspace` executable symlink.
Rollback atomically restores the prior self-contained release target,
restarts the one DevSpace LaunchAgent, verifies local health, and refuses to
continue if another task changed the link after activation.

### Re-enable

```bash
npm run unified-workspace:enable
npm run unified-workspace:restart
```

## Upgrade rule

Every future DevSpace upgrade must pass:

```text
build and full tests
→ source-authority enforcement
→ complete package inventory and bundle hash
→ isolated shadow start
→ read-only versioned candidate
→ atomic executable switch
→ local, public, OAuth and real MCP verification
→ automatic prior-link rollback on failure
```

A successful server restart does not prove that an already-open ChatGPT conversation received a new MCP schema. New tools may require a refreshed connector or a new conversation; `open_workspace` remains backward compatible during that transition.
