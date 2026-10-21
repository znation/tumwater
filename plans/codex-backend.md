# Codex backend — run model jobs on the Codex CLI (`codex`) on a ChatGPT subscription

Planned 2026-10-20 · requested by user · audited against main `13d9cdc47` · probed live the same
day on Codex CLI 0.163.0 (npm `@openai/codex`, ChatGPT Plus login), and hand step H1 (the
production flags, with Codex's sandbox off) done the same evening: "Findings, verified live".
Scrubbed captures are in test/fixtures/codex-captures/ (README.md there maps each file to its
finding).

## Goal

Let the team run model jobs on OpenAI's Codex CLI, paid by the operator's ChatGPT subscription
(Plus today). A selector with `backend: "codex"` beside its `model` sends the job to Codex. With
no `model`, each tier runs Codex's model for that tier (§2).

The Plus allowance is small next to the team's daily volume (§8, Rollout). So the first use is a
second subscription in a tier's chain. When Claude's window is used up, the job moves to Codex,
and when Codex's window is used up, it moves on to the local model:

```json
{
  "backend": "claude",
  "fallback": {
    "default": [
      { "backend": "codex", "model": "gpt-6.1-sol" },
      { "backend": "pi", "model": "qwenrunner/qwen3.8-27b" }
    ]
  },
  "backends": {
    "codex": { "configDir": "~/.codex-tumwater", "windowReserve": { "seven_day": 0.7 } }
  },
  "maxConcurrentPerProvider": { "codex": 2 }
}
```

A whole team on Codex is one line, `"backend": "codex"`.

- Codex is the fourth backend, after pi, claude and opencode. plans/agent-backends.md named it
  among the CLIs the seam was built for.
- Like a claude.ai subscription, a ChatGPT plan is billed in usage windows, not per token. All of
  tumwater's window machinery (billing, the five-hour and weekly windows, holds, the reserve, the
  badge) is written for claude alone today. §1 makes it per backend before Codex uses it.

## Two ways to reach the subscription (read this first)

pi 1.2.0 can already use a ChatGPT plan: since pi 0.99.0 (2026-09-29), `/login openai` offers
"Sign in with ChatGPT", and the older `openai-codex` provider reaches the same backend
(`https://chatgpt.com/backend-api`). So a much smaller plan exists. It is decision 1.

| | **Codex CLI backend (this plan)** | **pi with Sign in with ChatGPT** |
| --- | --- | --- |
| Size | 9 parts, 3 of them groundwork that every subscription backend reuses | about 3 parts |
| Client | OpenAI's own CLI, so plan usage is plainly allowed | a third-party harness. OpenAI's "Sign in with ChatGPT" program (2026-09-29) lets participating tools spend plan allowance, and pi's support shipped the same day, but I could not confirm that pi is a partner |
| Usage windows | read after every run from Codex's session file: 5 h and weekly `used_percent`, reset times (finding 5). The team moves down the chain before a run fails | not exposed. pi only reports "You have hit your ChatGPT usage limit (plus plan). Try again in ~N min." after a request fails |
| Spend | $0 and known to be subscription | pi prices these models at API list rates in its catalog (`gpt-5.6-luna` $0.20/$1.20 per M, for example). tumwater would have to learn that a ChatGPT-login `openai` job is subscription-billed |
| Prompt and tools | Codex's own harness, which the models are tuned for. About 8k tokens of base prompt per request even after isolation (finding 7) | pi's trimmed prompt, tools and extensions (strip-thinking, bounded output, context-shake) apply unchanged |
| New failure modes | orphaned commands, cumulative usage, trust-file writes, long commands that need polling and can be abandoned (findings 4, 10, 12, 19) | few: pi's stream is already canonical |

**Recommendation: the Codex CLI backend.** The window readings are what make a small allowance
usable: the team leaves Codex before it runs out, instead of after a run fails. The first-party
client also removes the terms question. The pi route is the smaller fallback plan if you would
rather not carry a fourth adapter.

## Findings, verified live

Checked on Codex CLI 0.163.0 (npm, through Homebrew's node) on 2026-10-20. The account was
logged in with ChatGPT, `plan_type: "plus"`. The probes ran in throwaway git repos and used
`gpt-6-luna` at low effort.

- The first probes used `--sandbox workspace-write`, because the auto-mode classifier refused
  `--dangerously-bypass-approvals-and-sandbox` from inside Claude Code.
- Hand step H1 ran with your OK the same evening. It used the production flags of §3, with the
  sandbox off, and covers findings 18–24 and the H1 notes in findings 3, 7 and 11.

1. **The binary.**
   - `/opt/homebrew/bin/codex` is a node wrapper. It spawns the native binary
     (`…/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`) in the wrapper's own
     process group.
   - `codex --version` prints `codex-cli 0.163.0`. `codex login status` prints "Logged in using
     ChatGPT".
   - `codex doctor --json` gives a redacted machine-readable health report.
2. **Headless mode.** `codex exec --json [-m M] [-c key=value] [--sandbox …] -` reads the prompt
   from stdin. It exits 0 on success and 1 when the turn fails.
3. **The `--json` stream.** One object per line:
   - `thread.started {thread_id}`, then `turn.started`;
   - `item.started` / `item.completed {item: {id, type, …}}`;
   - finally `turn.completed {usage}` or `turn.failed {error: {message}}`, plus top-level
     `error {message}` lines.

   Item types seen:
   - `agent_message {text}`;
   - `command_execution {command, aggregated_output, exit_code, status}`. The command comes
     wrapped, as `/bin/zsh -lc '<cmd>'`. A command gets `item.started` when it begins and
     `item.completed` when it ends, with nothing in between: a 40 s `sleep` streamed no output.
   - `error {message}`, a non-fatal notice (findings 6 and 11).
   - `file_change {changes: [{path, kind}], status}` (H1). An `apply_patch` edit gets
     `item.started` and `item.completed`, with an absolute `path` and `kind: "update"`.

   `reasoning`, `mcp_tool_call`, `web_search` and `todo_list` items did not occur. Reasoning
   summaries default to off, no MCP server was configured, and web search is disabled.
4. **Usage comes once, at the end, and counts the whole thread.**
   - `turn.completed.usage` is `{input_tokens, cached_input_tokens, cache_write_input_tokens,
     output_tokens, reasoning_output_tokens}` for the **thread so far**, not for this run. A first
     run reported 44,464 input tokens. Two resumes then reported 63,835 and 84,080, though each
     made a single request of about 20k.
   - No cost appears anywhere.
5. **The session file has what the stream lacks.** It is
   `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`. Per model request it
   holds:
   - `token_usage_record {usage, turn_token_usage, thread_token_usage}`. The per-turn figure
     corrects finding 4.
   - `event_msg` `token_count`, with `info.last_token_usage`,
     `info.model_context_window` (258,400 for a 272k model) and `rate_limits`:

     ```json
     { "limit_id": "codex", "plan_type": "plus", "rate_limit_reached_type": null,
       "primary":   { "used_percent": 0.0, "window_minutes": 300,   "resets_at": 1792555493 },
       "secondary": { "used_percent": 0.0, "window_minutes": 10080, "resets_at": 1793142293 },
       "credits":   { "has_credits": false, "unlimited": false, "balance": "0" } }
     ```

   It also holds `session_meta`, which carries the ChatGPT account and user ids. tumwater must
   never copy that into its own state or logs. There are also `turn_context` (model, effort,
   sandbox and approval policy) and every developer message.
6. **Codex mints the session id.**
   - No flag chooses one. `thread.started.thread_id` is a UUIDv7.
   - `codex exec resume <id> -` continues the thread with its context: the model recalled the
     earlier edit. It works **from any cwd**, and the session's cwd moves to the new one.
   - Resume takes no `--sandbox`; `-c sandbox_mode=…` sets it instead.
   - **Without `-m`, a resume switches to Codex's default model.** It warns with an `error` item:
     "This session was recorded with model `gpt-6-luna` but is resuming with `gpt-6.1-sol`…".
7. **The base prompt is about 15k tokens per request.**
   - The first request of a trivial run had 14,684 input tokens. It holds base instructions of
     18k characters, the tools in code mode, a skills list, a list of 17 recommended plugins, a
     multi-agent role, the sandbox's permissions text, the AGENTS.md and the environment context.
   - These flags cut it to 10,126 (−31%): `--ignore-user-config`, `--ignore-rules`, `--disable`
     for `plugins`, `apps`, `goals`, `image_generation`, `browser_use`, `computer_use`,
     `tool_suggest` and `skill_search`, plus `-c web_search="disabled"`.
   - **The multi-agent instructions survived `--disable multi_agent`.** They offer `spawn_agent`
     and "4 available concurrency slots".
   - **`-c agents.enabled=false` removes them** (H1). The prompt text went from 14,826 to 11,501
     characters. Asked to list its tools, the model named `apply_patch`, `clock__curr_time`,
     `exec_command`, `list_mcp_resource_templates`, `list_mcp_resources`, `read_mcp_resource`,
     `view_image` and `write_stdin`, with no `spawn_agent`.
   - **With every flag of §3, the first request was 8,059 input tokens** (−45%; H1). The list of
     Codex's four system skills (imagegen, openai-docs, skill-creator, skill-installer) is the
     only optional block left; no verified key removes it.
   - Caching works: 91% of a run's input was cached.
8. **Context files.**
   - `AGENTS.md` loads: the model knew a codeword from it without reading the file.
   - `CLAUDE.md` loads only with `-c 'project_doc_fallback_filenames=["CLAUDE.md"]'`, which then
     worked the same way.
9. **Sandboxes.**
   - exec runs with approval policy `never`.
   - `--sandbox workspace-write` makes the cwd, `/tmp` and `$TMPDIR` writable. It makes `.git`
     read-only and turns the network off. Children see `CODEX_SANDBOX=seatbelt` and
     `CODEX_SANDBOX_NETWORK_DISABLED=1`.
   - In a tumwater worktree, `.git` is a file that points into the primary checkout. Under this
     sandbox, git writes, the role's notes file (under `.tumwater/`) and any network use in the
     check would fail. `--dangerously-bypass-approvals-and-sandbox` lifts both the sandbox and the
     approvals (decision 2).
10. **Codex writes the operator's config.**
    - Every run in a new directory appends `[projects."<cwd>"] trust_level = "trusted"` to
      `$CODEX_HOME/config.toml`, **even with `--ignore-user-config`** (seen twice).
    - Worktree paths are stable per role, so a team adds about one entry per runner, once.
    - The probes left two such entries in `~/.codex/config.toml`.
11. **Errors.**

    | Case | Stream | Exit |
    | --- | --- | --- |
    | unknown model | an `error` item ("Model metadata for `no-such-model` not found…"), then `error` and `turn.failed`. The message is a JSON string: status 400, `invalid_request_error`, "The 'no-such-model' model is not supported when using Codex with a ChatGPT account." | 1 |
    | not logged in (an empty `CODEX_HOME`) | ten `error` lines "Reconnecting... n/5 (unexpected status 401 Unauthorized …)" over about 15 s, first over WebSocket and then HTTPS; then `turn.failed` with the 401 | 1 |
    | an effort the model does not list (`ultra` on `gpt-6-luna`) | accepted without complaint | 0 |

    - Top-level `error` lines are not always fatal: Codex's own retries are `error` lines too.
      Only `turn.failed` ends the turn.
    - A used-up window was not reproduced. The strings come from the 0.163.0 binary instead (H1):
      - the message is "You've hit your usage limit." It can add "Upgrade to Plus …", "Visit
        https://chatgpt.com/settings/usage to purchase more credits" or "send a request to your
        admin", followed by "Try again at <time>";
      - the error codes are `usage_limit_reached`, `usage_not_included`, `quota_exceeded`,
        `rate_limit_exceeded`, `context_window_exceeded` and `server_overloaded`;
      - pi's client for the same backend reads `plan_type` and `resets_at` beside those codes.
    - A resume of an id with no rollout fails before any model call: "thread/resume failed: no
      rollout found for thread id <id> (code -32600)" (H1).
12. **Processes and signals.**
    - The native binary starts `codex-code-mode-host`, and runs every shell command, **each in a
      process group of its own**.
    - **SIGTERM to the run's group:** the wrapper **exits 0** in 0.02 s and the code-mode host
      exits. **The running command is orphaned** (reparented to launchd) and keeps running. No
      closing event is written.
    - SIGKILL leaves the same orphan.
    - The orphan's environment still carries `TUMWATER_RUN` (checked on a `node` child). So
      run-agent's marker sweep is what ends it.
    - `codex exec` runs in-process. A shared `codex app-server` daemon was running
      (`daemon_auto_start` is on), but the run's commands were children of the exec process, not
      of the daemon.
13. **What shell children inherit.**
    - The whole environment, `*_KEY` and `*_TOKEN` names included: no default excludes applied.
    - Codex adds `CODEX_CI=1`, `CODEX_SANDBOX…`, `CODEX_MANAGED_BY_NPM` and
      `CODEX_MANAGED_PACKAGE_ROOT`.
    - They also kept the probe host's `CLAUDECODE=1`.
14. **The model catalog.**
    - It lives in `$CODEX_HOME/models_cache.json`, which the CLI refreshes; `codex debug models`
      prints it.
    - Per model: `context_window`, `effective_context_window_percent` (95),
      `supported_reasoning_levels`, `default_reasoning_level`, `input_modalities`,
      `truncation_policy` (`tokens`, 10,000) and `visibility`. There are no prices.
    - On this account on 2026-10-20:

      | Model | Window | Description |
      | --- | --- | --- |
      | `gpt-6.1-sol` | 500k | "Latest workhorse"; Codex's default |
      | `gpt-6-astra` | 272k | "Frontier intelligence" |
      | `gpt-6-luna` | 272k | "Fast and affordable … easier tasks" |
      | `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | 272k | older generations |

      `gpt-reserve` and `codex-auto-review` are hidden.
    - Efforts: low, medium, high, xhigh and max. Sol, Astra and Terra add `ultra`, "Maximum
      reasoning with automatic task delegation", which means sub-agents.
15. **Tools run in code mode** (`tool_mode: code_mode_only`).
    - The model writes JavaScript for a single `exec` tool, which calls
      `tools.exec_command({cmd, workdir})`.
    - The `--json` stream still reports each command as its own `command_execution` item with its
      text. So suite-rerun detection can read it, unlike OpenCode's Code Mode.
    - Edits went through the shell (`printf >>`) unless the prompt asked for `apply_patch`. That
      goes through `exec` as well and shows as a `file_change` item (finding 3).
16. **Speed.** Trivial runs took 7–15 s end to end.
17. **Window granularity.** After eight probe runs (about 200k input tokens on `gpt-6-luna`), both
    windows still read `used_percent: 0.0`. Some sources estimate Plus at roughly 15–80 messages
    per five hours on a workhorse model. H3 measures what the team actually gets.
18. **Oversized output (H1).** `seq 1 200000` was run:
    - **The stream carried all of it.** `aggregated_output` was 1,048,606 characters in one
      `item.completed` line.
    - **The model saw about 5,000 characters.** It got a head and a tail around
      `…261152 tokens truncated…`, after a line "Warning: truncated output (original token count:
      322224) … 240319 bytes omitted …".
    - So Codex's own cut is already tighter than pi's 16,000-character bash cap, and
      `tool_output_token_limit` (a valid key) is not needed. tumwater's log is the problem: the
      translator must cap what it writes.
19. **Long commands need polling, and can be abandoned (H1).**
    - `exec_command` returns after at most 30 s: a requested `yield_time_ms` of 900,000 came back
      at 30.0 s. The call returns a `session_id` while the command keeps running, and the model
      polls with `write_stdin` (`yield_time_ms` 30,000).
    - **Every poll is a model request** that the rollout records and the stream does not. For the
      whole run, the stream shows one `command_execution` item, open from start to end.
    - **Told not to poll, the model ended its turn while the command still ran.** Codex killed the
      command at exit, and the stream **never completed that item**: `item.started`, then
      `turn.completed`. A run can therefore finish without ever seeing its check's result.
    - **A ten-minute `sleep 600` completed** after 606 s with exit code 0. Codex has no command
      timeout. Waiting for it took 22 model requests (21 `exec` / `write_stdin` calls, about one
      every 30 s) and 197,625 input tokens, 88% of them cached. The stream showed nothing between
      the command's `item.started` and its `item.completed` ten minutes later.
20. **Config keys, checked without a model call (H1).**
    - `codex exec --strict-config -c <key>=<value> resume <nil uuid> -` stops either at
      "unknown configuration field" or at "no rollout found".
    - Valid keys: `agents.enabled`, `check_for_update_on_startup`, `analytics.enabled`,
      `feedback.enabled`, `history.persistence`, `model_reasoning_summary`, `hide_agent_reasoning`,
      `tool_output_token_limit`, `project_doc_max_bytes`, `model_auto_compact_token_limit`,
      `shell_environment_policy.inherit`, `otel.*` and `notify`.
    - Not keys: `disable_response_storage`, `memories.enabled`, `skills.enabled`,
      `exec_timeout_ms`, `background_terminal_timeout`, `unified_exec.*` and `code_mode.*`.
21. **Deleting a session (H1).**
    - `codex delete --force <uuid>` works headless: 0.18 s, "Deleted session <id>.", and the
      rollout is gone.
    - Without `--force` it refuses, exit 1: "cannot confirm session deletion without an
      interactive terminal; rerun with --force and a session UUID".
22. **launchservicesd (H1).** Its port count went from 518 to 523 over three runs, within the
    ±10 noise of the measurement. No leak is measurable.
23. **A killed run reports no window reading (H1).** The rollouts of both SIGTERM probes have a
    `token_usage_record` but no `token_count`, so no `rate_limits`.
24. **Codex can switch models by itself (H1).** The binary carries "Automatically switched to
    <model> due to usage limits" and "Automatically switched back … because ordinary usage is
    available again". No probe triggered it.

## Design

### 1. Groundwork: the subscription account is per backend (parts 1–3)

Everything that reads a subscription window reads one claude account today. A survey on
2026-10-20 found about 130 references in about 30 files. They fall into three groups:

- **Already backend-neutral:**
  - the canonical `billing` and `rate_limit` events and their parsing (src/pi/pi-stream.ts
    `RateWindow`, `applyRateLimit`);
  - `PiRunResult.billing` / `rateWindows` / `usedOverage`, `runCostIsReal` and the notional-cost
    plumbing;
  - the team hold's `subscription-window` kind (src/team/team-hold.ts) and `seamHoldKey`, which
    already keys a non-pi backend by its id;
  - resume-after-window (src/run/run-verdict.ts) and the no-retry rule (src/runner/runner-pi.ts).
- **Generic logic that names claude:**
  - the account file and its helpers (src/agent/claude/claude-account.ts `readClaudeAccount`,
    `writeClaudeAccount`, `observeClaudeAccount`, `claudeWindowUsedUp`, `windowReserved`,
    `claudeWindowEntries`, `claudeWindowLabel`);
  - the budget gate's `pairIsClaude` / `seamIsClaude` and its single `windowOut`
    (src/gates/budget-gates.ts);
  - the hold observation's provider `"claude"` (src/team/team-polls.ts
    `windowObservation`);
  - the `claude_window_*` events, the `claudeWindowReserve` key, and the "Claude 5h" labels in
    the badge, the GUI, the role view and the report;
  - doctor's "claude window" row.
- **Claude-only, and staying so:**
  - overage (`isUsingOverage`, `claudeOverageRefused`, the `extraUsage` chain-position rule);
  - `claude auth status` and the `ANTHROPIC_API_KEY` seed;
  - `--max-budget-usd` and `CLAUDE_GATED_MODELS`.

The groundwork makes the middle group per backend with **no behavior change for claude**:

1. **The account store** (part 1).
   - The generic half of claude-account.ts moves to src/agent/subscription-account.ts.
     - `SubscriptionAccount {billing, plan?, observedAt, windows}`; `ClaudeAccount` becomes an
       alias.
     - `readAccount(root, backend)`, `writeAccount`, `observeAccount(root, backend, run)`,
       `windowUsedUp`, `windowEntries`, `windowLabel`.
     - The file is `.tumwater/state/<backend>-account.json`, so claude's file keeps its name.
   - `PiRunResult` gains `agent` (the backend id). Then the two callers that fold a run into the
     account (src/run/run-finalize.ts, src/merge/merge-slot.ts) write the account of the backend
     that ran. **Today they would write a Codex reading into claude's file.**
   - The claude seed (`auth status`, the API-key check) stays in claude-account.ts.
2. **Gates, holds, reserve and events** (part 2).
   - The budget gate asks `seamIsSubscription(seam, accounts)` and keeps one used-up window per
     backend. The director's window move and the window handback follow the same shape.
   - The hold observation keys each backend's hold by its own id.
   - A reserve is `backends.<id>.windowReserve`. `claudeWindowReserve` keeps working as the older
     spelling of `backends.claude.windowReserve`.
   - The events become `subscription_window_{warning,reserved,limited,reset}`, each with a
     `backend` field. The event reader's `normalizeLegacyEvent` maps the old `claude_window_*`
     names, with `backend: "claude"`. The notify defaults follow.
3. **Display** (part 3).
   - The badge and the GUI tile label a window with the backend's own label: "Claude 5h · 64%",
     "Codex 7d · 31%".
   - `status --json` gains a `subscriptionWindows` list, one entry per backend in use; `claudeWindow`
     stays for one release.
   - The same change reaches the role view's billing line, the report's notional line
     ("<label> subscription, API-equivalent") and doctor's window row (one per backend).

### 2. Config and routing (part 4)

- `codex` joins `BACKEND_IDS`.
  - `backend: "codex"` runs bare model ids, and the no-model default, on Codex.
  - The model id goes to `-m` as written.
  - There is no `codex/<id>` spelling. Since Backend/model split part 5/5 (merged 2026-10-20),
    a backend-id namespace in a model id is a load error anyway.
- **Tier defaults** (decision 4), from the catalog's own descriptions:
  - strong: `gpt-6-astra`;
  - default: `gpt-6.1-sol`, Codex's own default;
  - small: `gpt-6-luna`.

  The director runs the strong tier, as on claude.
- **Thinking → `model_reasoning_effort`.**
  - `off` and `minimal` become `low`. `low` through `max` pass when the model's catalog entry
    lists them, and any other level is dropped, with a doctor note.
  - `ultra` is never sent: it delegates to sub-agents.
  - Codex accepts an unlisted level without complaint (finding 11). Dropping it keeps the effort
    that runs the one tumwater shows.
- **`backends.codex`:**
  - `bin` and `args` work as for claude. `TUMWATER_CODEX_BIN` comes with the adapter (part 7).
  - `configDir` becomes `CODEX_HOME`, the key claude already uses for `CLAUDE_CONFIG_DIR` (§4).
  - `windowReserve` is part 2's per-backend reserve.
- **Reserved passthrough flags** (`HARNESS_CODEX_FLAGS`):
  - output and model: `--json`, `-m` / `--model`, `-o` / `--output-last-message`,
    `--output-schema`, `--color`;
  - sandbox and approvals: `-s` / `--sandbox`, `--dangerously-bypass-approvals-and-sandbox`,
    `--approve-for-me`, `--dangerously-bypass-hook-trust`;
  - isolation: `--ignore-user-config`, `--ignore-rules`, `--ephemeral`;
  - where and what it runs: `-C` / `--cd`, `--worktree`, `--add-dir`, `--skip-git-repo-check`,
    `-p` / `--profile`, `--oss`, `--local-provider`.

  Operators keep `-c`, `--enable` and `--disable` for their own settings. A `-c` whose key
  tumwater sets (§3: `model`, `model_reasoning_effort`, `sandbox_mode`,
  `project_doc_fallback_filenames`, `web_search`, `agents.enabled`,
  `check_for_update_on_startup`, `analytics.enabled`, `feedback.enabled`, `history.persistence`)
  is refused.
- **Traits** (src/agent/backend-traits.ts):
  - It does not stream tool output, so every open call is judged by the buffered threshold.
  - It does not use pi's models.
  - Its label is the bare model, or "codex default".
- **Concurrency and holds need nothing new.** `maxConcurrentPerProvider: { "codex": 2 }` caps Codex
  runs, and a window hold on `codex` stops only Codex jobs.

### 3. The invocation (part 5)

```
codex exec --json
  --dangerously-bypass-approvals-and-sandbox      # decision 2
  --ignore-user-config --ignore-rules             # finding 7
  --disable plugins --disable apps --disable goals --disable image_generation
  --disable browser_use --disable computer_use --disable tool_suggest --disable skill_search
  -c agents.enabled=false                         # no sub-agents (finding 7)
  -c web_search="disabled"
  -c check_for_update_on_startup=false -c analytics.enabled=false -c feedback.enabled=false
  -c history.persistence="none"                   # no team prompts in the home's history
  -c 'project_doc_fallback_filenames=["CLAUDE.md"]'   # finding 8
  -m <model> [-c model_reasoning_effort=<level>]
  <backends.codex.args…>
  -                                               # prompt on stdin, closed

codex exec resume <ledger id> --json <the same flags, with -m again> -   # finding 6
```

- **Always pass `-m`, on a resume too.** Without it a resume silently changes the model.
- **The target repo's own `.codex/config.toml` is honored,** as claude honors the repo's
  `.claude/settings.json` (plans/agent-backends.md decision 3). Its hooks still need Codex's own
  trust: tumwater never passes `--dangerously-bypass-hook-trust`.
- **Environment.** It is layered on `backendBaseEnv` (the run marker, the macOS preload, the notes
  path and the notes shim on PATH), as the other adapters' envs are.
  - **Removed:**
    - every inherited `CODEX_*`, including a host Codex session's `CODEX_THREAD_ID` and
      `CODEX_SANDBOX*`;
    - `OPENAI_API_KEY` and `CODEX_API_KEY`. pi's OpenAI key must never switch Codex to per-token
      billing behind tumwater's back (decision 5);
    - the host Claude Code session's `CLAUDECODE` / `CLAUDE_CODE_*` (finding 13).
  - **Set:** `CODEX_HOME` when `backends.codex.configDir` is set.
- **The wrapper is node,** so the macOS `NODE_OPTIONS` preload reaches it, as it reaches pi. The
  native binary ignores it. H1 measured no launchservicesd leak either way (finding 22).
- Every key above was checked with `--strict-config` (finding 20). The production set took the
  first request from 14,684 input tokens to 8,059 (finding 7).

### 4. `CODEX_HOME` and sessions (parts 4 and 7)

**A home of the team's own** (`backends.codex.configDir`, decision 3).

- Codex keeps its login, sessions, catalog, state databases and trust entries under `CODEX_HOME`.
- A team home keeps the following out of the operator's `~/.codex`:
  - the trust entries (finding 10);
  - team sessions in the operator's `codex resume` picker;
  - any skills or global `AGENTS.md` the operator adds.
- It needs one login: `CODEX_HOME=~/.codex-tumwater codex login --device-auth`.
- **Never copy `auth.json`.** ChatGPT refresh tokens rotate, so two homes sharing one token family
  log each other out. pi's changelog records the same failure (`refresh_token_invalidated`). A
  second login is a separate grant.
- Unset, runs use the operator's `CODEX_HOME`, and doctor warns about what that shares.
- One home can serve every team root on the machine: sessions are found by id, not by directory.

**Sessions.**

- **A fresh run** has no id until the stream's `thread.started`. Today run-agent records the
  ledger line before the spawn, with the id the backend minted ahead of time. That does not fit
  Codex.
- **The seam gains `StreamTranslator.sessionId?()`.** As soon as it first returns an id, run-agent
  appends a second ledger record (same kind, cwd, model and name) carrying it. The pre-spawn record
  for a Codex run carries the session name and is never resumable.
- **A continue** takes the newest ledger record of this run's kind that is Codex's, has a UUID id
  and this cwd, and whose rollout file exists under the run's `CODEX_HOME`.
  - It then runs `codex exec resume <id>`.
  - A missing rollout means "not resumable", and the existing `handoff` path takes over: a fresh
    session, the worktree kept, and a bridge prompt.
  - Resume works from any cwd (finding 6), but tumwater keeps its same-cwd rule. That keeps one
    rule for every backend.
- **Retention.** The existing session pruning (`sessionRetentionDays`) also deletes the ledger's
  expired Codex sessions with `codex delete --force <id>`. That runs headless in 0.18 s, but
  without `--force` it refuses (finding 21). When it fails, pruning removes the rollout file.
  Doctor reports the home's `sessions/` size.
- **Across backends:** a fallback from Codex to anything else, or back, is a `handoff`. Unchanged.

### 5. The stream translator and the rollout read that completes it (parts 6 and 7)

| Codex event | Canonical event |
| --- | --- |
| `thread.started` | `session {id, cwd}`, then `agent_start`; `sessionId()` now returns the id |
| `item.completed` `agent_message` | `message_end` with one text block |
| `item.started` `command_execution` | `message_end` with one `toolCall` block (`bash`, `{command}` with the `/bin/zsh -lc` wrapper removed), then `tool_execution_start` |
| `item.completed` `command_execution` | `tool_execution_end {result, isError: exit_code !== 0}`. `result` is `aggregated_output` capped at pi's bash cap: head and tail around a marker naming the cut. The stream can carry a megabyte (finding 18) |
| `item.started` `file_change` | `message_end` with one `edit` toolCall per changed path (`{path, kind}`), then `tool_execution_start` |
| `item.completed` `file_change` | `tool_execution_end`, with `isError` when `status` is not `completed` |
| `item.*` `mcp_tool_call` / `reasoning` | `<server>__<tool>` / a thinking block. Neither was seen live (finding 3), so an unexpected shape is only a warning |
| `item.completed` `error` | one run warning per distinct message, never a failure (finding 11) |
| `item.*` `todo_list`, `web_search` | dropped silently |
| top-level `error` "Reconnecting... n/m (…)" | `auto_retry_start {attempt n, maxAttempts m, errorMessage}` |
| other top-level `error` | held as the failure text for a following `turn.failed` |
| `turn.completed` | marks the run complete; its usage is kept as a fallback only. A `command_execution` still open here was abandoned (finding 19): the translator closes it with `tool_execution_end {isError: true}`, a result of "abandoned: the run ended while this command was still running", and one `codex_command_abandoned` warning |
| `turn.failed` | a final `message_end` with `stopReason: "error"`, `errorMessage` (the inner JSON's message) and `tumwaterKind` (below) |
| stream end with neither `turn.completed` nor `turn.failed` | `finalize()` emits a final error message: "codex exited without finishing its turn". That covers the wrapper's exit 0 after a SIGTERM that was not the harness's (finding 12) |

- **Open calls exist.** `item.started` opens the call, so the stalled-tool warning and progress
  see a running test. It is judged by the buffered threshold.
- **The final text** is the last `agent_message`.
- **The command text** keeps the model's own command (the `-lc` argument), so suite-rerun
  detection matches it.

**The rollout read** happens in `afterRun`, after the process exits. It locates
`$CODEX_HOME/sessions/**/rollout-*-<id>.jsonl` and reads only the records of this run's turn.
That is everything after this run's `task_started`, which a resume appends to the same file. It
emits:

- `run_usage {input, output, cacheRead, cacheWrite}` from the turn's last
  `token_usage_record.turn_token_usage`. This replaces the thread-cumulative stream figure
  (finding 4). `input` is `input_tokens − cached_input_tokens`: OpenAI counts cached tokens
  inside `input_tokens`, while tumwater, like pi, counts them apart. `cacheRead` is
  `cached_input_tokens` and `cacheWrite` is `cache_write_input_tokens`.
- `billing: "subscription"` when the reading carries a `plan_type`.
- One `rate_limit` per window from the newest `rate_limits`:
  - `type` comes from `window_minutes`: 300 is `five_hour`, 10080 is `seven_day`, and any other
    value is `<n>_minute`. Then `windowReserve: { "seven_day": … }` reads the same on claude and
    Codex.
  - `utilization` is `used_percent / 100`, and `resetsAt` is `resets_at`.
  - `status` is `rejected` when `rate_limit_reached_type` names the window or it is at 100%,
    `allowed_warning` from 90%, else `allowed`.

If the rollout cannot be read, a fresh run keeps the stream's usage. A resumed run records no
usage. Either way the run logs `codex_usage_partial` once.

When the turn's `turn_context.model` differs from the `-m` tumwater passed, the run logs
`codex_model_switched {requested, ran}` once, and the result records the model that ran. Codex
can switch models on a usage limit by itself (finding 24). A run the harness killed gets no
window reading, because its rollout has none (finding 23); the next completed run supplies one.

**Error classification**, from the `turn.failed` message, whose inner JSON carries `status` and
`error.type` / `code`:

| Codex signal | Result |
| --- | --- |
| `usage_limit_reached`, `rate_limit_exceeded`, or a 429 | `transientRateLimit`, plus a `rejected` reading for the window it names, with `retryAfterSeconds` from `resets_at` |
| `usage_not_included` (the plan has no Codex) | `configError` |
| 400 `invalid_request_error` for the model ("not supported when using Codex with a ChatGPT account") | `configError` |
| 401, or a refresh-token error (`refresh_token_reused` / `invalidated`) | `configError`. Doctor names the login command |
| context window exceeded after Codex's own compaction | `contextExceeded` |
| 5xx, a stream disconnect, or exhausted reconnects | `transientBackend` of that kind |
| exit nonzero with no `turn.failed` | the stderr classification in `classifyExit` |

A run the harness killed keeps its own cause; the wrapper's exit 0 is ignored then (finding 12).

### 6. The prompt dialect (part 7)

- `readRange`: "`sed -n 'A,Bp'` (or `head` / `tail`)". Codex has no read tool.
- `oversizedOutput`: "Oversized command output comes back as its head and tail around a
  `…N tokens truncated…` marker — narrow the command (grep, `sed -n`, `head`/`tail`) instead of
  re-running it whole." (finding 18)
- `backendRules`:
  - "A command that runs longer than 30 seconds returns a session id while it keeps running. Keep
    calling `write_stdin` with that session id until it reports an exit code, and never end your
    turn while a command is still running: Codex kills it when you finish, and its result is lost."
    (finding 19)
  - Sub-agents need no rule: `agents.enabled=false` removes them (finding 7).

Notes need nothing new: `tumwater-notes` is on PATH, and the shell's children inherit
`TUMWATER_NOTES_PATH` (finding 13).

### 7. Spend, free-ness, window, images (part 8)

**Billing.**

- A ChatGPT login is subscription billing: `costUsd` is 0, and there is no API-equivalent figure,
  because Codex reports no price (plans/agent-backends.md decision 2, "no price table").
- The report shows Codex runs' tokens.
- **API-key billing is refused** (decision 5). Doctor and the startup gate fail a Codex job when
  `codex login status` reports an API key, and name the fix. Codex reports no cost, so per-token
  billing would spend money the cap cannot see.

**Free-ness.** `seamFree`'s `codex` arm reads the Codex account: free while it bills a
subscription. The consequences are the same as for subscription claude:

- a Codex model is a valid budget `fallback` step for a priced primary;
- at the cap, a Codex job keeps running;
- with every job on subscriptions, the badge shows the windows, not the spend.

**Windows** drive everything through part 2's per-backend machinery:

- A used-up window, or one past its reserve, moves Codex jobs down their chain on the next poll. The
  hold is only for jobs with nowhere to go.
- A rejected run keeps its worktree and resumes as a `handoff`.
- Because the read happens after every run, the team learns a reading one run late, as with
  claude.

**Credits.**

- A Plus account can buy credits that run past the windows. This account has none
  (`has_credits: false`).
- tumwater never spends them on purpose: the window counts as used up at 100% regardless.
- Doctor warns when `has_credits` is true, because the run that crosses the limit may draw on them
  and tumwater cannot see the amount.

**Context window.** `seamContextWindow`'s `codex` arm reads `context_window ×
effective_context_window_percent / 100` from the home's `models_cache.json`: 258,400 for the 272k
models and 475,000 for `gpt-6.1-sol`. Every window-keyed rule then applies.

**Image input** comes from the catalog's `input_modalities` (text and image for every listed
model), through the `imageInput` hook.

### 8. Every model job, checked

Only what differs from plans/agent-backends.md §10:

| Model job | What changes |
| --- | --- |
| Author runs (all roles), director, qa | nothing: they go through runAgent |
| SUMMARY / stage-fix follow-ups | `exec resume <ledger id>` with `-m`, after the rollout existence check (§4) |
| Reviewer | suite-rerun detection reads `bash` calls; the translator maps each `command_execution` to one (finding 15) |
| Budget handback, model fallback | `handoff`, unchanged |
| Fallback chain | a Codex step is free while its window serves. It has no extra-usage position rule: credits are never spent on purpose |
| Watchdogs | open calls from `item.started`. A long command emits nothing on the stream until it ends, though the model polls it every 30 s (finding 19). So the quiet watchdog needs every check to end within `quietTimeoutSeconds` (30 min by default), as on claude. Codex has no command timeout of its own |
| Kills | the marker sweep ends the orphaned commands (finding 12). The smoke check asserts it |

## Rollout

- **Start as a chain step,** as under "Goal". Codex covers default-tier jobs when Claude's
  window is used up, before local Qwen. `maxConcurrentPerProvider.codex` starts at 2.
- **Then widen by measurement (H3).** After a day, read how far a day of runs moves each window,
  then decide whether Codex should carry a tier or a role (a second reviewer, say) as its
  primary.
- **Reserve for yourself.** The team and your own Codex sessions share one allowance. The example
  reserves the weekly window at 70%.
- **Long checks cost polls.** Each 30-second poll of a running command is a model request of
  about 9k input tokens, mostly cached (finding 19). Waiting for a ten-minute check took 22
  requests and about 198k input tokens. H3 counts what that costs in window share.

## Hand steps

- **H1: live probe with the production flags. Done 2026-10-20** with your OK, Codex's sandbox off.
  - Findings 18–24 and the H1 notes in findings 3, 7 and 11 are its results. The scrubbed captures
    are in test/fixtures/codex-captures/.
  - Not covered:
    - `reasoning` and `mcp_tool_call` item shapes (none occurred);
    - a used-up window (its strings come from the binary);
    - a second `CODEX_HOME` login across a token refresh, which needs your interactive login and
      moves to H2.
- **H2: the team's Codex home.**
  - Run `CODEX_HOME=~/.codex-tumwater codex login --device-auth`.
  - A day later, check that both `~/.codex` and the team home still report "Logged in using
    ChatGPT". That shows two logins survive each other's token refreshes.
  - After part 9, run `npm run smoke:codex`. Then edit tumwater.json (the untracked live file in
    the primary checkout) as under "Goal".
- **H3: measure the allowance, after a day.** Read each window's `used_percent` per run and per
  model from the account file and the runs' rollouts, and the share of runs that ended on a window.
  Set the reserve and decide wider use from those numbers.

## Parts (PLANS.md "Codex backend, part i/9")

1. The subscription account is per backend: the store, `PiRunResult.agent`, and the two writers.
   No behavior change.
2. Gates, holds, the reserve and the window events are per backend. Split into four parts, each
   independently mergeable and behavior-neutral for claude (PLANS.md): 2a threads the
   `accounts: (backend) => SubscriptionAccount | null` lookup through the free-ness predicates and
   their callers; 2b renames the window events to `subscription_window_*` with a `backend` field
   and adds `backends.<id>.windowReserve` with `windowReserveFor`; 2c makes the budget gate's
   window move, chain reasons and director move read each backend's own account; 2d makes the hold
   observation and the reserve and warning polls name each backend; 2e makes the poll loop read
   each backend in use. 2a and 2b require part 1; 2c requires 2a and 2b; 2d requires 2b; 2e
   requires 2c and 2d.
3. The window display is per backend: badge, GUI, status JSON, role view, report, doctor.
   Requires part 2e.
4. The `codex` backend id, `backends.codex` (`configDir` → `CODEX_HOME`, `windowReserve`), tier
   defaults, the effort mapping, reserved flags and traits. Requires part 2e.
5. The invocation and environment: pure argv and env builders. Requires part 4.
6. The stream translator and the rollout reader, with fixtures from the H1 captures. Independent
   of parts 1–5.
7. The adapter: sessions from the stream (the `sessionId()` seam hook), the rollout read in
   `afterRun`, resume, registration, the PATH fake and the dialect. Requires parts 5 and 6.
8. Billing, free-ness and windows: the Codex account fed from runs, `seamFree`, the API-key
   refusal, the context window and image input. Requires parts 3 and 7.
9. Doctor, session retention, docs and the opt-in `smoke:codex` live check. Requires part 8.

Parts 1, 2a, 2b and 6 can start at once and run side by side.

## Decisions (confirmed 2026-10-20 by user)

1. **The Codex CLI backend, not pi's Sign in with ChatGPT** (see "Two ways to reach the
   subscription"). The pi route is about 3 parts with no window readings.
2. **No Codex sandbox:** `--dangerously-bypass-approvals-and-sandbox`, the same trust pi and
   claude (`bypassPermissions`) get. Under `workspace-write`, git is read-only, the notes file is
   unwritable and the check has no network (finding 9). The isolation stays the worktree and the
   process marker.
3. **A Codex home of the team's own** (`backends.codex.configDir` → `CODEX_HOME`), set in the
   rollout. Optional, like claude's `configDir`; doctor warns when it is unset.
4. **Tier defaults on Codex:** `gpt-6-astra` strong, `gpt-6.1-sol` default, `gpt-6-luna` small.
   The alternative is OpenCode's rule: no defaults, and Codex's own default for every tier.
5. **Subscription billing only.** API-key login is refused, and `OPENAI_API_KEY` / `CODEX_API_KEY`
   are scrubbed from runs.
6. **Generic window events** (`subscription_window_*` with `backend`). Old names are normalized on
   read, and notify defaults follow.
7. **Window type names are shared:** Codex's 300- and 10080-minute windows read as `five_hour` and
   `seven_day`, so a reserve reads the same on both subscriptions.

## Risks

- **The Plus allowance is small and opaque.** Codex reports percentages, not tokens, and the
  weighting differs per model. A whole team on Plus would run out early in the week. H3 measures
  it, and the chain and the reserve contain it.
- **The session file is internal.** The rollout format has no published schema. The read takes
  only the four record types it needs, warns `codex_usage_partial` when they are missing, and the
  smoke check re-verifies after each upgrade.
- **CLI drift.** Codex ships often: 0.163.0 lists about 140 feature flags, many "under
  development".
  - The translator warns on unknown event and item types.
  - Doctor enforces a minimum version (0.163.0).
  - Runs pass `check_for_update_on_startup=false`, and `--strict-config` is the cheap way to
    re-check every key after an upgrade (finding 20).
- **The base prompt.** About 8k tokens per request even isolated, against about 6k for a pi run's
  first prompt (memory: small-window analysis). Caching makes it cheap in money but not in window
  share. The smoke check fails when isolation regresses (first request over 10k input tokens).
- **Abandoned commands.** A model can end its turn while its check still runs, and Codex then
  kills the check (finding 19). The dialect rule asks it not to. The translator turns the open
  call into a failed one with a `codex_command_abandoned` warning, so the reviewer and the event
  feed see that the check never finished.
- **Silent model switches.** Codex can move to another model on a usage limit (finding 24). The
  rollout's `turn_context` shows it, and `codex_model_switched` reports it.
- **Orphaned commands** survive any signal (finding 12). The marker sweep is the guard, and a
  command orphaned mid-check can still write into the worktree until the sweep reaches it.
- **Terms.** `codex exec` is the CLI's documented non-interactive mode, and the plan is the
  operator's own. Whether a whole automated team fits the plan's intended use is for you to judge.
  This plan does not settle it.

## Sources (2026-10-20)

- Live probes: Codex CLI 0.163.0 (`codex exec --json`, `exec resume`, `exec --strict-config`,
  `delete --force`, `debug models`, `debug prompt-input`, `doctor --json`, `features list`), and
  their rollout files; scrubbed copies in test/fixtures/codex-captures/.
- The 0.163.0 native binary's strings, for the usage-limit messages, the error codes and the
  automatic model switch (findings 11 and 24).
- pi 1.2.0: CHANGELOG.md (0.99.0 "Sign in with ChatGPT", 0.99.1 GPT-6.1 Sol), docs/models.md,
  and its openai-codex-responses client's usage-limit handling.
- OpenAI's "Sign in with ChatGPT" plan-usage program: https://thenewstack.io/sign-in-with-chatgpt/
- Plus window estimates (secondary, wide): https://dev.to/owen_fox/codex-weekly-limit-drained-7-fixes-why-it-burns-and-a-drop-in-api-2026-3j6i,
  https://inventivehq.com/blog/codex-cli-usage-rate-limits
