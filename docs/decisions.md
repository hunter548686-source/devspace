# DevSpace — Decision Chain

Current as of: `2026-09-01T01:51:16+10:00`

This file records durable project decisions. Runtime health, completion and release status must be resolved from current source, tests and versioned runtime evidence rather than inferred from historical notes.

## D-001 — Register DevSpace as one canonical developer-platform project

- Status: `CURRENT / IMPLEMENTED`
- Decision: Project ID is `devspace`; the sole canonical writable source is `/Users/liheng/Codex project/New project/devspace`.
- Verified fact: the Portfolio Registry records this exact project ID and path, and the directory exists.
- Boundary: generated runtime releases under `/Users/liheng/.devspace/runtime/releases` are support components, not additional projects or writable source authorities.
- Rollback: Registry and source-authority records may be reverted without deleting source or runtime releases.

## D-002 — Enforce one writable source and versioned generated runtimes

- Status: `CURRENT / LOCALLY VERIFIED`
- Decision: one repository identity has one canonical writable source. Runtime deployment must be built from the canonical source into complete versioned release directories, validated in isolation, switched atomically and rolled back on failed acceptance.
- Verified evidence: `npm run source-authority:check` returned `PASS` on 2026-09-01; canonical source and runtime-release roles contained zero violations.
- Verified evidence: `npm run typecheck` passed on 2026-09-01.
- Not claimed: production release, public deployment, DNS change or external publication.

## D-003 — Keep GPT/ChatGPT, Codex and local workspace identity explicit

- Status: `CURRENT / PARTIAL`
- Decision: a project conversation, Codex saved project and DevSpace workspace must resolve to the same canonical project ID/path when they refer to the same project. Conversation history itself is not copied as project source.
- Current limitation: portfolio validation still reports incomplete Codex canonical-path coverage and legacy/extra saved paths. DevSpace source correctness does not by itself prove all Codex project records are reconciled.
- Next action: apply a separately reviewed reversible Codex mapping batch; do not delete unrelated saved projects or user workspaces silently.

## D-004 — External and irreversible actions remain separately gated

- Status: `CURRENT`
- Decision: Commit, Push, Merge, Tag, public Release, production Deploy, DNS/certificate changes, protected credential access and destructive workspace cleanup require explicit current authorization.
- Allowed by default: local reversible inspection, code repair, tests, builds, versioned runtime candidates, evidence and rollback preparation.
