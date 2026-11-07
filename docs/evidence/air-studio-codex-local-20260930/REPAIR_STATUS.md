# Air Codex Local -> Mac Studio, 2026-09-30

## Outcome and acceptance boundary
CONFIGURATION_APPLIED_AND_READBACK_VERIFIED; FINAL_RELAUNCH_ACCEPTANCE_BLOCKED.
Do not mark this task fully complete until fresh default-config execution and the Air GUI relaunch pass.

The approved target is Codex Local on MacBook Air, not official Codex and not the Pro's local client.
Control connection: DevSpace Cloudflare runs on MacBook Pro; existing authenticated SSH alias `air` resolves to 100.94.107.86.
Studio is 100.77.217.28. No Studio services, network settings, production applications, or official Codex files were modified.

## Confirmed defects
1. Air config selected gemma4:12b via Air's own http://127.0.0.1:11434/v1/; it was not using Studio.
2. Air startup script resets any model absent from its local catalog to gemma4:12b. This reset was reproduced in an isolated in-memory test.
3. The installed local catalog lacked qwen3.8:27b-mlx metadata. A command-line Studio test therefore emitted a fallback metadata warning.

Do not claim the complete cause of the screenshot's 96-minute run was established: the above configuration defects were confirmed, not a full trace-level hang diagnosis.

## Connection and tool tests already passed
- Air -> Studio port 11434: /api/tags lists qwen3.8:27b-mlx; /api/version is 0.31.2.
- Air -> Studio /v1/responses returned STUDIO_OK with the requested model.
- Air's installed Codex Local CLI 0.142.3, ephemeral/read-only, with temporary model/provider-address overrides: exit 0 in 51.48 seconds. Actual command_execution events:
  - hostname -> lihengdeMacBook-Air.local, exit 0.
  - pwd -> /private/tmp, exit 0.
  - Chinese final output contained STUDIO_CODEX_TOOL_OK.
- This proves the Air CLI -> Studio inference -> Air tools loop; it is NOT the final saved-config or GUI acceptance.
- Studio /api/ps reported loaded context_length 32768. The catalog/config therefore uses 32768, with auto-compaction threshold 24576.
- Air -> Studio 8091 and 11435 timed out. The working solution uses the already accessible 11434 endpoint, without Pro proxying or firewall changes.

## Applied changes, all on Air under ~/.codex-local
Native Codex app-server FS/config RPC was used over the existing SSH connection; no credentials were inspected.

1. Backups verified:
   - config.toml.bak-studio-20260930T1606
   - sync-ollama-catalog-context.py.bak-studio-20260930T1606
2. Added studio-models.json with a single qwen3.8:27b-mlx model, displayed as Qwen3.8 27B · Mac Studio. Original ollama-launch-models.json preserved.
3. Added a guard to sync-ollama-catalog-context.py: if selected model_provider is not ollama-local, skip local catalog/context/model resetting.
4. Applied config:
   - model: qwen3.8:27b-mlx
   - model_provider: studio-ollama
   - model_catalog_json: /Users/liheng/.codex-local/studio-models.json
   - model_context_window: 32768
   - model_auto_compact_token_limit: 24576
   - provider base_url: http://100.77.217.28:11434/v1/
   - wire_api: responses
   - requires_openai_auth: false
   - request_max_retries: 1, stream_max_retries: 0, stream_idle_timeout_ms: 60000
   - Added Chinese instructions distinguishing Air execution, Studio inference, Mac Studio vs LM Studio, and official Codex vs Codex Local.
   - Existing local provider, oss_provider, permissions, features, plugins and project registrations preserved.
5. Native config/batchWrite returned status ok, and same-session config/read verified the new settings.
6. The patched startup script was actually executed with Air's /usr/bin/python3 (3.9) and correctly reported remote/custom provider selected; local sync skipped.

## Versions and hashes
Original config layer version:
sha256:b575a765002fa186bafcb79884f18573f90409d1039e251e12bb7b45caa8461d
Applied config layer version:
sha256:505b5856494a4c8db9bbf169e6fe453f856fa97eb37d13d4d17888b26ae9452d
Original startup script SHA256:
296713a58683f8c6a1cc851005a59f242a6909894786e5f2f6ff82a1965c0754
Patched startup script SHA256:
222f1fca7df6dd78e84ead39d22e80ede6f9f6c7eff8185ff271daeb309df022
Official Codex pre-change hashes (not edited by this task):
- Pro ~/.codex/config.toml: a552b82c5e64c1daa34a9cd9fd573fdf852ff5888ed86e52bbf856f4fa550a3f
- Air ~/.codex/config.toml: b034585d727414ea0c3f66889e143850b1e3f1790bcb60c8b02c226ba6b04b44

## Final verification interruption
A fresh app-server model/list attempt closed before initialize. Its helper initially hid stderr, so that event alone does NOT establish a configuration error. A subsequent direct diagnostic returned SSH exit 255: connect to 100.94.107.86 port 22: Operation timed out. Tailscale status then reported Air Online=false; a Tailscale ping answered but SSH still timed out. No conclusion about whether Air slept, changed networks, or encountered another connectivity problem is established.

The RPC helper now preserves bounded startup stderr to distinguish SSH failures from app-server validation failures. A further invocation was blocked by the tool's safety gate before execution, so no new acceptance result exists.

No GUI quit/relaunch was attempted. Last seen Air GUI PID12719 and app-server PID13209 were still the original processes. No original conversation was deleted or modified by the repair, and tests were ephemeral.

## Exact resumption steps
1. Reuse the Pro workspace and verify existing SSH alias air is reachable; do not change network permissions or read credentials.
2. Run appserver_rpc.py --method model/list --params '{"limit":10}' and inspect fresh-start stderr if it fails.
3. Resolve any real startup/config compatibility error before restarting the GUI. Avoid inferring an error solely from SSH failures. The prior override-only CLI test is a known-good baseline.
4. Run Air installed CLI exec --ephemeral --json --sandbox read-only --skip-git-repo-check -C /private/tmp using saved CODEX_HOME/CODEX_SQLITE_HOME, WITHOUT model/provider overrides. Verify real hostname/pwd tool events, Chinese identity, correct model and absence of metadata errors.
5. Re-run the startup sync guard and confirm settings remain unchanged.
6. Gracefully quit only bundle com.openai.codex.local.runtime, then open /Applications/Codex Local.app so the actual wrapper/environment runs. Never use broad pkill or restart official Codex/Studio services.
7. Check new GUI/app-server PIDs, model selection, saved default provider, and an actual UI-originated invocation when feasible. Preserve existing conversations; report any GUI-only evidence gap honestly.
8. Recheck official config hashes and update this status with actual evidence.

## Rollback
Restore only the two verified Air backup files to their original ~/.codex-local paths through native FS APIs, after inspecting concurrent changes. Keep the new Studio catalog inert for evidence rather than deleting unrelated data. Restore/relaunch only Codex Local, never official Codex. If fresh app-server startup has a genuine config error, bootstrap it using per-invocation known-good provider/catalog overrides, then perform the scoped native config repair or restoration. Never apply configure_studio.py --apply blindly again: its baseline/version guards intentionally reject the now-changed state.

## Task-owned helper files
- appserver_rpc.py: scoped native app-server diagnostic/FS/config client.
- configure_studio.py: reviewed one-time repair and in-memory startup regression checks. Default is check-only; --apply was explicitly executed once and succeeded.
These files are evidence/repair helpers on Pro, not changes to DevSpace application source or runtime. No commit, push, merge, deployment, account connection, paid request, or model download occurred.
