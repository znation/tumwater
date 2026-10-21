# Codex CLI 0.163.0 captures

Raw `codex exec --json` output, captured 2026-10-20 with Codex CLI 0.163.0 (npm `@openai/codex`
through Homebrew's node), logged in with ChatGPT on a Plus plan, against `gpt-6-luna` at low
effort, in throwaway git repos. This is hand step H1 of plans/codex-backend.md, plus the earlier
same-day probes run under `--sandbox workspace-write`; the numbered findings there cite these files.

Paths are rewritten to `/work/repo`, `/work/repo2` and `/Users/operator`. Rollout files keep only
the records tumwater's reader needs: `task_started`, `token_usage_record`, `token_count` and
`task_complete` (without its `last_agent_message`), and `turn_context` cut to its model, effort,
approval and sandbox fields. `session_meta` (it names the ChatGPT account and user), the prompts,
the developer messages and the tool calls' text are dropped. Nothing else is edited, so ids,
timestamps and token counts are what Codex wrote.

"Production flags" means the §3 invocation of plans/codex-backend.md:
`--dangerously-bypass-approvals-and-sandbox --ignore-user-config --ignore-rules`, the `--disable`
list, `-c agents.enabled=false`, `-c web_search="disabled"`, `-c check_for_update_on_startup=false`,
`-c analytics.enabled=false`, `-c feedback.enabled=false` and
`-c 'project_doc_fallback_filenames=["CLAUDE.md"]'`.

| File | What it shows (finding) |
| --- | --- |
| edit-run.jsonl | production flags: the model lists its tools (no `spawn_agent`), edits through `apply_patch` (a `file_change` item with an absolute path, `kind: "update"`), then runs one command (3, 7, 15) |
| resume.jsonl | `exec resume <id>` of that thread with the production flags and `-m` again: no model-switch warning; `turn.completed.usage` is the thread total, 41,454 after the first run's 32,957 (4, 6) |
| edit-run-and-resume-rollout.jsonl | the rollout of both runs: per-request `token_usage_record` (the first request is 8,059 input tokens), `token_count` with the 300- and 10080-minute `rate_limits`, and one `task_started` / `task_complete` per run (5, 7) |
| resume-without-model.jsonl | a resume without `-m`: an `error` item warns that the session switched from `gpt-6-luna` to `gpt-6.1-sol` (6) |
| unknown-model.jsonl | `-m no-such-model`: a metadata warning item, then `error` and `turn.failed` with status 400 `invalid_request_error` (11) |
| not-logged-in.jsonl | an empty `CODEX_HOME`: ten "Reconnecting... n/5" `error` lines (WebSocket, then HTTPS), then `turn.failed` with the 401 (11) |
| unlisted-effort.jsonl | `model_reasoning_effort=ultra` on a model that does not list it: accepted, exit 0 (11) |
| oversized-output.jsonl | `seq 1 200000`: the stream's `aggregated_output` held all 1,048,606 characters (cut to 4,000 here, marked `[fixture: … chars cut]`). The model itself saw about 5,000 characters: head and tail around `…261152 tokens truncated…`, after a "Warning: truncated output (original token count: 322224) … 240319 bytes omitted" line (18) |
| sigterm-mid-command.jsonl | production flags, SIGTERM to the run's process group during a `node -e` command: the stream stops after `item.started`; the wrapper exited 0 and the command was orphaned, still carrying `TUMWATER_RUN` (12) |
| long-command.jsonl | production flags, `sleep 600`: one `command_execution` item open for the whole ten minutes while the model polled `write_stdin` every 30 s (19) |
| long-command-rollout.jsonl | the same run's rollout: one `token_usage_record` per poll, so the poll count is the window cost (19) |
| abandoned-command.jsonl | the model told not to poll: `exec_command` returned after 30 s (its `yield_time_ms` of 900000 was capped), the model ended its turn, Codex killed the command, and the item never completed (19) |
| models-catalog-entries.json | `$CODEX_HOME/models_cache.json` cut to the fields tumwater reads (window, effective-window percent, efforts, modalities, truncation policy, visibility) for the nine models this account lists (14) |
