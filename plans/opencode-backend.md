# OpenCode backend — run model jobs on the OpenCode CLI (`opencode`) for its free DeepSeek model

Planned 2026-10-17 · requested by user · audited against main `740e2c56a` · research from source,
docs and issues on 2026-10-17 (see "Sources"); nothing here has been run live yet (hand step H1)

## Goal

Let the team run model jobs on the OpenCode CLI, so it can use OpenCode's free
`deepseek-v4.1-flash-free` model. That is DeepSeek V4.1 Flash, which the team pays Hugging Face
for today. A model id that starts with `opencode/` sends the job to OpenCode:

```json
{
  "model": "opencode/deepseek-v4.1-flash-free",
  "fallback": [
    { "model": "huggingface/deepseek-ai/DeepSeek-V4.1-Flash:deepinfra", "maxDailyCostUsd": 10 },
    "qwenrunner/qwen3.8-27b"
  ],
  "maxConcurrentPerProvider": { "opencode": 3 }
}
```

- The team spent $4.13 on Hugging Face DeepSeek on 2026-10-17 by mid-afternoon (228 runs,
  `tumwater report --days 3`). With the free model as the primary, that money is spent only when
  the free tier refuses or rate-limits a run and the job moves to its fallback.
- OpenCode is the third backend, after pi and claude. plans/agent-backends.md built the backend
  seam with this in mind ("More agent CLIs will follow (codex, opencode, gemini …)"). This plan
  adds the adapter. It also replaces the claude-only branches that the seam did not cover.

## The free model and its catch

- **The free model is on OpenCode's pay-as-you-go gateway, not on OpenCode Go.**
  - Its id is `opencode/deepseek-v4.1-flash-free`. The gateway is called Console now; it was
    called Zen before.
  - It has a 200K context, 32K max output and costs $0. It is free "for a limited time", and its
    provider keeps no data and does not train on it.
  - It needs no login: with no key, OpenCode sends a public key and lists only the $0 models.
- **OpenCode Go ($10/month; Go Plus $40) is a different thing.**
  - Its `opencode-go/deepseek-v4.1-flash` (1M context) is paid inside Go: $0.15/$0.60 per M
    tokens off-peak, $0.30/$1.20 at peak. It also counts against Go's 5-hour, weekly and monthly
    allowances.
  - Go works with any agent. pi 1.2.0 already has an `opencode-go` provider, so
    `opencode-go/deepseek-v4.1-flash` with `OPENCODE_API_KEY` works today with no tumwater change.
    Go is not part of this plan.
- **Only OpenCode's own client may use the free tier.**
  - Since about 2026-09-17 the server refuses other clients with a 403 `FreeTierError` ("OpenCode's
    free tier can only be used from within OpenCode").
  - The reported trigger is the request body: a run that denies or disables `read`, `bash`, `glob`
    or `grep` gets the 403. Unofficial builds and spoofed headers are reportedly refused too.
- **The free tier is flaky.** On 2026-10-17 official 2.0.32 clients got the 403 as well, some
  depending on their network (issues 56426, 56397, 56398). So a free-tier refusal moves the job to
  its fallback (§6). It is never a config error that stops a role.

### Why pi cannot use it

- pi 1.2.0 ships `opencode` and `opencode-go` providers for the same gateway
  (`https://opencode.ai/zen/v1`, `…/zen/go/v1`).
- pi labels its requests `x-opencode-client: pi` (its provider-attribution.js). Its catalog does
  not have the free model, and it prices `opencode-go/deepseek-v4.1-flash` at $0.15/$0.60.
- A pi request for the free model comes from a non-OpenCode client, so the gate refuses it.
- Making pi pass as OpenCode (spoofing the client header or the body) is out of scope. It is
  exactly what the gate exists to stop.

## Which OpenCode

There are two lines:

| Line | Package | Status |
| --- | --- | --- |
| V1 | npm `opencode-ai` 1.19.3 | Critical fixes only. A known hang at "project copy refresh" in git repos will not be fixed in V1 (issue 55037) |
| V2 | npm `@opencode/cli` 2.0.32; Homebrew core `opencode` 2.0.25; `anomalyco/tap/opencode-v2` 2.0.32 | Maintained, released about daily. New tool names, permission format and server API |

**Target V2 only.**

- It is the line that is maintained.
- `--session <id>` takes an id the caller chooses. That gives the same fresh/resume model as
  claude's `--session-id` / `--resume`, so the session ledger works unchanged.
- `--standalone` gives each run its own process, with no shared service.
- Doctor fails a V1 binary and names the V2 install command. The minimum version is whichever V2
  release H1 passes on.

## Findings from the source

These come from V2 2.0.32 unless marked V1. H1 re-checks each one live.

1. **`opencode run` flags** (packages/cli/src/commands/commands.ts):
   - `--format json` writes one JSON object per line.
   - `--model provider/model#variant`: the variant (the thinking level) is part of the model
     string.
   - `--session <id>` resumes that session, or **creates it with that id when it does not
     exist**. So a missing session silently becomes a fresh one, and the resume check must
     confirm the session exists first (§4).
   - `--standalone` runs a private server inside the process. Without it, `run` attaches to a
     shared background service, and killing the client may leave the session running there.
   - `--auto` approves every permission ask.
   - `--thinking` adds `reasoning` events to the stream.
2. **Prompt delivery.**
   - Arguments are joined with spaces, and an argument that contains a space is wrapped in
     literal quotes.
   - When stdin is not a terminal, OpenCode reads it to EOF and appends it, even when a message
     argument is given. So an inherited pipe that stays open hangs the run forever (issues 52938,
     42064).
   - The adapter therefore passes the prompt on stdin and the runner closes it, as it does for
     claude.
3. **Event stream** (packages/cli/src/run/noninteractive.ts). Each line is
   `{type, timestamp, sessionID, part}` or an error.
   - `step_start`: one model call begins.
   - `text`: sent once the text part is finished. There are no deltas.
   - `reasoning`: only with `--thinking`.
   - `tool_use`: sent **only once the tool has completed or errored**; nothing is sent while it
     runs.
     - `part.id` is the call id.
     - `state` is `{status: "completed", input, output, title, metadata, time}` or
       `{status: "error", input, error, time}`.
   - `step_finish`: `reason`, `cost` (USD for this step only, priced from models.dev) and
     `tokens {input, output, reasoning, cache {read, write}}`. V2 has no `total`.
   - An error is `{type, message}`. One raised before a session exists has `sessionID: ""`.
   - There is no final result event; the stream ends when the session goes idle.
   - Events from sub-agent (child) sessions are dropped, and their cost with them.
4. **Exit and signals.**
   - Exit 1 on a session error, a prompt error, a missing message or a missing session; 130 on
     SIGINT; otherwise 0.
   - V2 handles SIGINT only, so SIGTERM kills it at once.
   - Its shell tool runs commands in detached process groups, which a SIGTERM leaves running.
     tumwater's `TUMWATER_RUN` marker sweep (src/process/run-marker.ts) reaps them, provided the
     marker reaches them (H1).
5. **Built-in tools (V2):**
   - `shell {command, timeout? (0 = none), background?}`
   - `read {filePath, offset?, limit?}`
   - `edit`, `write`, `patch`, `glob`, `grep`
   - `subagent`, `webfetch`, `todowrite`, `skill`, `question`

   A background shell command has no timeout. A model that runs the check in the background and
   then stops would report work it never verified; that is claude finding 4
   (plans/agent-backends.md).
6. **Config and isolation.**
   - Config is loaded in this order, each source merged over the one before:
     1. remote `.well-known`
     2. global `~/.config/opencode/{config.json,opencode.json,opencode.jsonc}`
     3. `OPENCODE_CONFIG`
     4. project `opencode.json(c)` files, walking up from cwd
     5. `.opencode/` dirs: in the project, `~/.opencode`, and `OPENCODE_CONFIG_DIR`
     6. `OPENCODE_CONFIG_CONTENT`
     7. managed config (`/Library/Application Support/opencode`, MDM), last and always
   - `OPENCODE_CONFIG_DIR` adds a directory. It does not replace the global one.
   - V2 reads `AGENTS.md` only, not `CLAUDE.md`. It still loads skills from `.claude/skills` and
     `~/.claude/skills`.
   - Switches:
     - `OPENCODE_PURE=1` loads no external plugins.
     - `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_DISABLE_CLAUDE_CODE`,
       `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_DISABLE_AUTOUPDATE`,
       `OPENCODE_DISABLE_LSP_DOWNLOAD` and `OPENCODE_DISABLE_AUTOCOMPACT` turn off what they name.
     - `OPENCODE_DB` sets the session database path.
     - Most of these are confirmed in the V1 source only.
   - Sharing is discontinued. The only telemetry found is the opt-in `OTEL_*` exporter.
7. **Sessions.**
   - They live in SQLite at `~/.local/share/opencode/opencode.db`, which `OPENCODE_DB` overrides
     (V1 source).
   - `opencode session list --format json` lists them.
   - An explicit `--session <id>` resumes in the directory the session was started in.
8. **MCP.**
   - The config shape is
     `"mcp": {"<name>": {"type": "local", "command": [...], "environment": {...}}}`.
   - Tools are named `<server>_<tool>`, so ours is `tumwater_role_notes`.
   - **There is an open V2 bug:** under `run --standalone`, MCP tools can be missing from the
     session and the run can hang (issues 56240, 51812).
9. **Compaction** is automatic and on by default. V2's defaults: `keep.tokens` 15K and `buffer`
   10% of the limit. With a 200K window this is what keeps a long run going. As with claude,
   tumwater's pi context-shake has no counterpart.
10. **Cost.**
    - Each `step_finish` carries its own cost, from models.dev prices.
    - Free models report $0.
    - Go models report list prices, not what the subscription actually charges.

## Design

### 1. Groundwork: the claude-only branches become backend traits

The seam (src/agent/agent-backend.ts) covers the spawn, the stream and the exit. About a dozen
places outside it still test `agent === "claude"`. Most of them stand for a capability that
OpenCode either shares or lacks. Left as they are, an OpenCode job would be treated as pi in some
places and as nothing in others:

| Place | Today | Becomes |
| --- | --- | --- |
| src/config/config-schema.ts `AGENT_IDS` | `["pi", "claude"]` | gains `opencode` (part 2) |
| src/config/config-validation.ts, reserved passthrough flags | `id === "claude" ? … : id === "pi" ? …` | a table of reserved flags per backend |
| src/prompt/dialect.ts `dialectFor` | claude or pi | a table of dialects keyed by backend id |
| src/pi/pi-watchdogs.ts and src/ui/progress-data.ts, the stalled-tool rule | `agent === "claude"` → every call is judged by the buffered threshold | `streamsToolOutput(agent)`, true for pi only |
| src/pi/pi-models.ts `seamFree` / `piPairFree` | claude → the subscription rule; any other non-pi backend → never free | a free-ness rule per backend (§7) |
| src/doctor/doctor-model-checks.ts: `needsDefinitions`, the image rows, the fallback-chain probe's `isClaude` | "not claude" stands in for "needs pi's models.json" | "is pi" |
| src/agent/image-input.ts and the doctor labels | `agent === "claude" ? model : provider/model` | the backend's own label (`opencode/<model>`) |

- The traits that the config and UI layers read live in a pure module,
  src/agent/backend-traits.ts, keyed by backend id. Those layers then never import the runtime
  registry. That is the same reason `AGENT_DEFAULT_MODELS` lives in model-selector.ts today.
- The claude-only machinery stays claude-only. None of the subscription window, the billing, the
  account file or `--max-budget-usd` applies to OpenCode.
- Part 1 is this refactor with no behavior change: every existing test passes as is.

### 2. Config and routing

- `opencode` joins `AGENT_IDS`.
  - `backend: "opencode"` makes bare model ids, and the default for a job with no model, run on
    OpenCode.
  - `backends.opencode.bin` / `.args` and `TUMWATER_OPENCODE_BIN` work like claude's.
- **Model ids.** Everything after `opencode/` is passed to `--model`.
  - With no further `/`, it is a model on OpenCode's own gateway, whose OpenCode provider id is
    also `opencode`. So `opencode/deepseek-v4.1-flash-free` becomes
    `--model opencode/deepseek-v4.1-flash-free`: the tumwater id reads exactly like OpenCode's.
  - With one, it is any provider OpenCode knows: `opencode/anthropic/claude-sonnet-5-5` becomes
    `--model anthropic/claude-sonnet-5-5`.
  - A thinking suffix such as `:low` becomes `#<variant>` (§3).
  - parseModelSelector already splits at the first `/` and strips only a `:level` it knows, so
    parsing does not change.
- **This hides pi's built-in `opencode` provider** (the paid gateway through pi). From now on
  `opencode/…` always means the OpenCode CLI. pi's `opencode-go` provider is untouched. Doctor
  already warns about a models.json provider named like a backend id; it also notes this built-in
  when the installed pi has it.
- **No tier defaults.** `AGENT_DEFAULT_MODELS.opencode` is empty, like pi's.
  - With no `model`, OpenCode's own default runs, and doctor shows it as "(opencode default)".
  - The free model is a time-limited promotion, so its id belongs in tumwater.json, not in code.
- **Reserved flags**, refused in `backends.opencode.args`: `run`, `--format`, `--model`/`-m`,
  `--session`/`-s`, `--continue`/`-c`, `--fork`, `--standalone`, `--server`, `--attach`, `--auto`
  and its aliases, `--agent`, `--thinking` and `--dir`.
- **Concurrency and holds need nothing new.**
  - `seamHoldKey` (src/config/config-views.ts) already keys a non-pi backend by its id.
  - So `maxConcurrentPerProvider: { "opencode": 3 }` caps OpenCode runs, and a provider-wide
    rate-limit hold on `opencode` stops only OpenCode jobs.

### 3. The invocation

```
opencode run --standalone --format json --auto
  --model <provider>/<model>[#<variant>]
  --session <id>                     # a fresh id, or the ledger id being resumed (§4)
  <backends.opencode.args…>
  < prompt on stdin, closed
```

**Variant.**

- tumwater's thinking level becomes the model's variant when OpenCode's catalog
  (`opencode models --verbose`) lists a variant of that name for the model. pi's catalog gives
  DeepSeek V4.1 Flash low, high and max.
- A level the model does not list is dropped, and doctor notes it.
- H1 confirms the free model's variant names.

**Config, through `OPENCODE_CONFIG_CONTENT`.** It applies after the operator's global and project
files; only managed config wins over it.

- `autoupdate: false`.
- `snapshot: false`. Otherwise OpenCode keeps its own git snapshot of the worktree at every step,
  which costs disk and time in every workspace. The V1 project-copy hang came from this area.
- `lsp: false` and `formatter: false`. No language server starts per worktree, and no formatter
  rewrites files after an edit, which pi and claude never do.
- `mcp.tumwater`: the role-notes server, only when the run carries notes (§5).
- `instructions: ["CLAUDE.md"]`, only when the worktree has a `CLAUDE.md` and no `AGENTS.md`. V2
  reads `AGENTS.md` only; this mirrors claude's `--append-system-prompt-file AGENTS.md`.
- `enabled: false` for every MCP server the operator's global opencode config names. Config
  merges, so this is the only way to remove one.
- **No tool is disabled.**
  - Denying `read`, `bash`, `glob` or `grep` trips the free-tier gate.
  - H1 asks whether `subagent`, `webfetch` and `question` can be denied without a 403.
  - Until it answers, the default is to leave them allowed and steer with the prompt (§5).

**Environment.** It is layered on `agentBaseEnv` (the run marker and the macOS preload), as
claude's is.

- **Removed:** every inherited `OPENCODE_*` except `OPENCODE_API_KEY`. A run spawned from inside
  an OpenCode session must not attach to that session's server, config or database. This is the
  OpenCode version of claude finding 2.
- **Set:**
  - `OPENCODE_PURE=1`
  - `OPENCODE_DISABLE_CLAUDE_CODE=1`
  - `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`
  - `OPENCODE_DISABLE_AUTOUPDATE=1`
  - `OPENCODE_DISABLE_LSP_DOWNLOAD=1`
  - `OPENCODE_DB=<session database>` (§4)
  - the shell tool's default timeout, at `quietTimeoutSeconds` × 1000 − 60 s, so that OpenCode's
    own timeout fires before tumwater's quiet kill. H1 finds the variable's V2 name.
- **Not set: `XDG_CONFIG_HOME` and its siblings.**
  - Pointing them at an empty dir would isolate OpenCode completely.
  - But the shell tool's children inherit them: `git` would stop reading `~/.config/git/config`,
    and commits could lose their author identity.
  - Doctor reports what still leaks in instead (§7): an operator's global opencode instructions,
    agents, or `~/.config/opencode/AGENTS.md`. This machine has no opencode config today.

### 4. Sessions

- **One database per session: `OPENCODE_DB=<sessionDir>/opencode/<id>.db`.**
  - Each run touches only its own file, so concurrent runs never contend on one SQLite file.
  - A resume opens the same file.
  - The existing `.tumwater/sessions` age pruning removes it with the dir's other files, so
    nothing piles up in the operator's `~/.local/share/opencode`.
  - If V2 ignores `OPENCODE_DB` (H1), fall back to the shared default database with ledger ids
    only.
- **Fresh run:** mint an id in the form `--session` accepts for a new session (H1), and append the
  ledger record `{agent: "opencode", id, kind, cwd, …}` before spawning, as claude does.
- **Continue:** use the newest ledger record of this run's kind, if it is OpenCode's, has this
  cwd, and its database file exists.
  - `--session` silently creates a missing session, so this existence check is mandatory.
    Without it, a SUMMARY follow-up would run against an empty session.
  - Anything else is not resumable, and the existing `handoff` path takes over: a fresh session,
    the worktree kept, and a bridge prompt.
- **Across backends:** a fallback from OpenCode to pi, or back, is already a `handoff`
  (src/tick/tick-resume.ts). Unchanged.

### 5. The prompt dialect and role notes

- The canonical stream maps tool names (§6), so the prompts' shell-command wording stays.
- **Notes.** The role-notes MCP server (src/agent/mcp/role-notes-server.ts) is attached as
  `mcp.tumwater`, and the tool is `tumwater_role_notes`.
  - The open V2 MCP bug (finding 8) may make this hang.
  - The quiet watchdog bounds such a hang, but a role that hangs on every run is useless. So H1
    tests a local stdio server under `run --standalone`.
  - If the bug bites, part 5 ships OpenCode without notes: no MCP server, and no notes
    instruction in the dialect. Notes return when the minimum version includes the upstream fix.
- **Oversized output.** What V2's shell and read tools do with a very large output (truncate it,
  or save it to a file) decides the oversized-output bullet (H1).
- **Extra rules in the OpenCode dialect only:**
  - "Run every shell command in the foreground: never set `background`" (finding 5).
  - "Do not start sub-agents", unless H1 shows `subagent` can be denied without a 403. Sub-agent
    events and costs never reach the stream (finding 3).

### 6. The stream translator

| OpenCode event | Canonical event |
| --- | --- |
| first event with a non-empty `sessionID` | `session` (`id`, `cwd`), then `agent_start` |
| `step_start` | opens a message buffer |
| `text` | a `text` block |
| `reasoning` | a `thinking` block (not requested: `--thinking` is not passed) |
| `tool_use` | a `toolCall` block, with its result queued (see below) |
| `step_finish` | **one** `message_end` with the buffered blocks and usage (see below), then a `tool_execution_start` and `tool_execution_end` for each queued call |
| error | a final `message_end` with `stopReason: "error"`, `errorMessage` and `tumwaterKind` (below) |
| stream ends with a step still open | `finalize()` flushes it as a `message_end` without usage |

- **The `toolCall` block.**
  - `id` is `part.id`.
  - The name is mapped: `shell`→`bash`, `patch`→`edit`, others kept in lower case.
  - `arguments` is `state.input`, plus a `path` alias for `filePath`.
  - The queued `tool_execution_end` has `isError` = `status === "error"`.
- **The `message_end` usage.**
  - `input`, `output`, `cacheRead` = cache.read, `cacheWrite` = cache.write, and `totalTokens` =
    their sum.
  - `cost.total` = `part.cost`.
- **Order.** Emitting the calls after their message keeps pi's order: the assistant message, then
  its tool executions. Every reader of the raw log assumes that order.
- **Cost.** The per-step cost is real money and adds up like pi's per-message cost, so no
  `run_cost` event is needed. A free model's steps cost $0.
- **No open calls.** OpenCode reports a call only once it has ended, so the stalled-tool warning
  can never fire for it. The guards are the quiet watchdog and the shell timeout (§3). That is why
  the stalled-tool trait in §1 is "streams tool output", which is false for OpenCode.
- **Unknown events.** Each unmapped native type produces one `agent_unknown_event` warning, as for
  claude.

**Error classification:**

| OpenCode signal | Result |
| --- | --- |
| 403 `FreeTierError` | `transientBackend` (kind `server`), plus one `opencode_free_tier_refused` warning per run. A provider failure, not a config error: the free tier refuses intermittently today, and three refusals in a row move the tier to its fallback through the existing model-failure episode |
| 429 / rate limit | `transientRateLimit`, with `retryAfterSeconds` when given |
| 5xx, connection, timeout | `transientBackend` of that kind |
| unknown model or provider, 401 | `configError` |
| context overflow that compaction could not fix | `contextExceeded` |
| exit 1 with no error event | the stderr classification in `classifyExit` |

### 7. Spend, free-ness, image input and doctor

**Spend.**

- Every OpenCode run's summed step cost counts as real spend toward the daily cap.
- A free model reports $0, so it never moves the cap. If the promotion ends and the model starts
  reporting a price, that spend counts at once, with no code change.
- Go models run through OpenCode report list prices, which overstate what a Go subscription
  really charges. That errs on the safe side.

**Free-ness** (`seamFree`).

- An OpenCode job is free when OpenCode's catalog prices its model at zero, and no run on that
  model has reported a nonzero cost.
- The catalog comes from `opencode models --verbose`.
  - It is a bounded probe, run at startup and by doctor.
  - It is cached in `.tumwater/state/opencode-models.json` with the CLI version and fetch time,
    and refreshed daily.
- A run that reports a cost on a model the cache calls free marks that model priced in the cache,
  and logs `opencode_free_model_billed` once.
- Consequences, the same as for a free local model:
  - With every job on the free model, the badge reads "budget n/a".
  - A free OpenCode model is a valid budget `fallback` step for a priced primary.
  - At the cap, a free OpenCode job keeps running instead of moving to its fallback.

**Image input** comes from the catalog's input modalities, through the backend's `imageInput`
hook.

**Doctor**, for each backend in use:

- The binary is on PATH and is V2 (`opencode --version` ≥ the minimum). A V1 binary fails with
  the V2 install command.
- Each OpenCode model is in the catalog. Doctor shows its price ("free" or per-M prices) and
  context window.
- A model on a provider other than the gateway (`opencode/anthropic/…`) has a credential
  (`opencode auth list --format json`).
- The operator's global opencode config: any MCP server (disabled for team runs), plugin, agent,
  instructions entry or `~/.config/opencode/AGENTS.md` produces a warning naming what still
  leaks in.
- The total size of the session databases under `.tumwater/sessions`.

**Startup gate.** It already checks the binary of every backend in use. It also seeds the catalog
cache.

### 8. Every model job, checked

Only what differs from plans/agent-backends.md §10:

| Model job | What changes |
| --- | --- |
| Author runs (all roles), director, qa | nothing: they go through runAgent |
| SUMMARY / stage-fix follow-ups | `--session <ledger id>`, after the existence check (§4) |
| Reviewer | suite-rerun detection reads `bash` calls, and the `shell`→`bash` mapping keeps it working. A pi or claude reviewer over OpenCode authors is fine |
| Budget handback, model fallback | `handoff`, unchanged |
| Fallback chain (plans/fallback-chain.md) | a free OpenCode step is "available when its breaker is serving", the free-pi row |

## Rollout

- **The config is the one under "Goal".**
  - One model for all three tiers. Today's strong tier is already V4.1 Flash, and the default
    tier moves up from V4-Flash-0731.
  - `maxConcurrentPerProvider.opencode` starts at 3 because the free tier's rate limits are not
    published. Raise it once 429s are rare.
- **Watch the smaller window.** It is 200K, against the Hugging Face model's 1M. A 2026-10-17
  measurement found 34% of runs past 64K, so a long tail of runs will compact. Watch the
  `compacted` counts and the context-exceeded failures on the first day.
- **Spend on the fallback** is the measure of how often the free tier refused: `tumwater report`
  "Cost by provider".

## Hand steps

- **H1: live probe, before part 4 lands.** In a Claude Code session, install V2
  (`brew install opencode`, from Homebrew core). In a throwaway git repo, capture or check:
  - a three-step run's JSON stream (part 4's fixtures);
  - a SIGTERM during a shell command: the exit code, any orphans, and whether the run marker
    reached the shell's children;
  - `--session` with a minted id, then a resume;
  - whether `OPENCODE_DB` is honored;
  - the free model's variant names;
  - whether denying `subagent`, `webfetch` or `question` trips the 403;
  - the shell-timeout variable's name;
  - how oversized output comes back;
  - the role-notes MCP server under `--standalone` (issue 56240);
  - six concurrent runs, for rate limits and memory per process.

  Record the results under "Findings from the source", and correct the parts that depend on them.
- **H2: switch the team, after part 7.** Run `npm run smoke:opencode`, then edit tumwater.json
  (the untracked live file in the primary checkout) as shown under "Goal".

## Parts (PLANS.md "OpenCode backend, part i/7")

1. Backend traits: the claude-only branches become per-backend traits, with no behavior change.
2. The `opencode` backend id, model-id routing, and `backends.opencode` with its reserved flags.
   Requires part 1.
3. The OpenCode invocation and environment: pure argv, config and env builders. Requires part 2.
4. The stream translator and its fixtures. Requires part 1; can run beside parts 2 and 3. Should
   land after H1.
5. The adapter, sessions, registration, the PATH fake and role notes. Requires parts 3 and 4.
6. Free-ness, the catalog cache and spend. Requires part 5.
7. Doctor, docs and the `smoke:opencode` live check. Requires part 6.

## Decisions (proposed 2026-10-17; confirm or change)

1. **V2 only.** V1 is maintenance-only and has the git-repo hang.
2. **The `opencode/` prefix belongs to the OpenCode CLI.** This hides pi's built-in `opencode`
   provider. pi's `opencode-go` stays reachable.
3. **No tier defaults.** The promotional model id lives in tumwater.json.
4. **A free-tier 403 is a provider failure** that moves the job to its fallback, never a config
   error.
5. **No XDG redirection,** so the shell's `git` keeps the operator's identity. Doctor reports what
   leaks in.
6. **Every cost OpenCode reports is real spend.** Free-ness comes from the catalog, overridden by
   any observed cost.
7. **No impersonation:** pi never sends OpenCode's client identity.

## Risks

- **The promotion ends.** It is "for a limited time", and DeepSeek's zero-retention agreement
  runs through 2026-10-31 and is renewed monthly.
  - If the id disappears, runs fail with an unknown-model config error, which doctor names. The
    fix is one line in tumwater.json.
  - If the model gets a price instead, the observed-cost rule (§7) makes it priced at once.
- **The gate gets stricter.** OpenCode may change what it checks. The team then falls back to the
  paid step, and spends at most its cap.
- **Terms.**
  - The terms of service (2026-08-15) ban programmatic extraction of output, and using several
    accounts to get around limits. They have no clause that limits use to a harness.
  - `opencode run --format json` is a documented headless mode of the official CLI.
  - Whether a whole automated team fits "programmatic extraction" is for you to judge from the
    terms. This plan does not settle it.
- **CLI drift.** V2 ships about daily, and its stream has no schema version. The translator warns
  on unknown types, doctor enforces a minimum version, and runs disable auto-update.
- **A smaller window.** 200K against 1M means more compaction, and its quality is OpenCode's.
- **Sub-agent cost is invisible,** because child events are dropped. On the free model that is
  $0; on a priced model it is an undercount, so the dialect discourages sub-agents.
- **Load.** Six concurrent V2 processes, each with a private server. H1 measures memory.

## Sources (2026-10-17)

- Free model and Console: https://opencode.ai/v2/docs/console/models, https://models.dev/api.json
- Go: https://opencode.ai/docs/go/
- Gateway prices: https://opencode.ai/docs/zen/
- CLI, config and permissions: https://opencode.ai/docs/cli/, https://opencode.ai/docs/config/,
  https://opencode.ai/docs/permissions/, https://opencode.ai/v2/docs/
- V2 source: https://github.com/anomalyco/opencode/tree/v2.0.32 (packages/cli/src/commands/commands.ts,
  packages/cli/src/run/noninteractive.ts, packages/cli/src/session-target.ts,
  packages/core/src/tool/plugin/shell.ts)
- V1 source: https://github.com/anomalyco/opencode/tree/v1.19.3 (packages/opencode/src/cli/cmd/run.ts,
  packages/opencode/src/config/config.ts, packages/core/src/database/database.ts)
- Free-tier gate: issues 49580, 49756, 51315; the 2026-10-17 403 wave: 56397, 56398, 56426
- Hangs and MCP: issues 42064, 47709, 51812, 52938, 55037, 56240
- pi 1.2.0's opencode providers: `@earendil-works/pi-coding-agent` dist/core/provider-attribution.js
  and its bundled model catalog
