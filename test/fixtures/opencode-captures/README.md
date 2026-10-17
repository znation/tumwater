# OpenCode 2.0.32 captures

Raw `opencode run --standalone --format json --auto` output, captured 2026-10-17 with OpenCode
2.0.32 (Homebrew) and no login, against `opencode/deepseek-v4.1-flash-free`, in a throwaway git
repo. This is hand step H1 of plans/opencode-backend.md, plus a same-day follow-up probe of OpenCode's MCP timing (the three `mcp-first-request-no-tool`, `mcp-tool-from-second-request` and `mcp-notes-end-of-run` files); the numbered findings there cite these
files. Paths are rewritten to `/work/repo` and `/Users/operator`, and the repo's root-commit hash
to `<project-root-commit>`. Nothing else is edited, so ids, timestamps, token counts and the
lossy event boundaries are exactly what OpenCode sent.

| File | What it shows (finding) |
| --- | --- |
| edit-run.jsonl | read → edit → shell → text under the full planned config (`snapshots: false`, the deny list, `#low`, minted `--session`, `--title`); the final step's `step_start`/`step_finish` are missing (5, 7) |
| edit-run-export.json | `opencode session export` of that run: session totals, per-message `finish`/`cost`/`tokens`, `outcome`, `variant: "low"` (4, 5) |
| parallel-tools.jsonl | two tool calls in one step, arriving in completion order; no final `step_finish` (5, 7) |
| resume.jsonl | a resumed session answering from earlier context; this one did get its final `step_finish` (3, 5) |
| free-tier-refused.jsonl | the 403 `provider.auth` / `FreeTierError` caused by a `ses_` id not in OpenCode's format (3, 8) |
| free-tier-refused-read-denied.jsonl | the same 403 caused by denying the `read` tool (8, 11) |
| malformed-session-id.jsonl | a session id not starting with `ses`: `unknown` "Expected a string starting with "ses"", before any session exists (`sessionID: ""`) (3, 8) |
| unknown-model.jsonl | `provider.no-route` "Model unavailable" (8) |
| unavailable-variant.jsonl | `provider.no-route` "Variant unavailable … medium" (8, 9) |
| oversized-output.jsonl | `seq 1 200000`: only the last 2000 lines come back, with the full-output file named and `metadata.truncated: true` (17) |
| background-shell.jsonl | a `background: true` shell call returning at once; the command was killed when the run ended (18) |
| mcp-tool-late.jsonl | the role-notes MCP tool appearing mid-run and working as `tumwater_role_notes` (21) |
| mcp-tool-missing.jsonl | the same config with the MCP tool never appearing (21) |
| mcp-first-request-no-tool.jsonl | follow-up probe: a stdio MCP server that connected about 0.4 s after launch, yet the model's first request listed no MCP tool (21) |
| mcp-tool-from-second-request.jsonl | the same server after one `sleep 3` step: the second request lists `probe_probe_echo` (21) |
| mcp-notes-end-of-run.jsonl | tumwater's role-notes server: read, shell, then `tumwater_role_notes` saving the note at the run's end, the pattern that worked 6 of 6 (21) |
| models-catalog-entries.json | OpenCode's cached models.dev catalog (`kv` key `models-dev:catalog`), trimmed to the free model, `big-pickle` and Go's `deepseek-v4.1-flash` (9, 10) |
