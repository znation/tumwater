# Agent backends — run Claude Code (`claude`) where tumwater runs pi today

Planned 2026-10-09 · requested by user · audited against main `232b287e`

## Goal

Let an operator run tumwater's agent work on the Claude Code CLI (`claude`) instead of pi. They
can do this for the whole fleet or for some seams only, e.g. a Claude reviewer over pi authors, or
Claude authors with an oMLX fallback. Selecting it is one line of config:

```json
{ "agent": "claude" }
```

With no `model` set, that runs each seam on claude's model for the seam's tier:

- Sonnet 5.5 (`claude-sonnet-5-5`) for the default tier, which most seams use
- Opus 5.5 (`claude-opus-5-5`) for the strong tier: reviewer, plan role and conflict resolver
- Haiku 5.5 (`claude-haiku-5-5`) for the small tier: the readme role

A `model` (string or tier map) overrides that exactly as it does for pi today.

On a claude.ai subscription, claude work is exempt from the daily dollar cap and is throttled only
by the subscription's five-hour usage window, which the TUI and GUI show in place of the daily
spend. On API-key billing the existing spending rules apply unchanged.

Build it as a backend seam, not a `claude` special case. More agent CLIs will follow (codex,
opencode, gemini …), and each should need one adapter directory plus a registry entry. None of
them should need another sweep through the loop, review, landing and UI code.

## Why `TUMWATER_PI_BIN` / `agentBin` is not enough

plans/portability.md §5/7 made the binary configurable. It deliberately stopped short of an
agent-CLI abstraction. Every pi assumption below the spawn is still in place:

| Concern | pi today | claude |
| --- | --- | --- |
| Non-interactive mode | `--print --mode json` | `-p --output-format stream-json --verbose` |
| Prompt delivery | last argv | stdin (argv works, but stdin avoids ARG_MAX, `ps` exposure and a prompt starting with `-`) |
| Model / thinking | `--provider P --model M --thinking L` | `--model M --effort L` (low, medium, high, xhigh, max). No provider flag |
| Sessions | `--session-dir D`, `-n name`, `--continue` = newest file in D | stored under `~/.claude/projects/<slug(cwd)>/<uuid>.jsonl`. `--session-id <uuid>` for a fresh run, `--resume <uuid>` to continue. **Resume is cwd-scoped**: from another directory it fails "No conversation found with session ID" (verified) |
| Event stream | `message_end`, `tool_execution_start/update/end`, `auto_retry_start`, `compaction_start`, `agent_start`, `session` | `system/init`, `assistant` (**one event per content block, with the same `message.id` and usage repeated on each**), `user` (`tool_result` blocks), `system/api_retry`, `system/compact_boundary`, `system/task_*`, `rate_limit_event`, and a final `result` |
| Cost | `usage.cost.total` per message, priced from `~/.pi/agent/models.json` | per-message token usage only. Cost appears once, as `result.total_cost_usd`, with a per-model `modelUsage` breakdown that includes `contextWindow` |
| Errors | text in `errorMessage`, matched by regex | `result.is_error` + `api_error_status` (HTTP status) + `terminal_reason`. **An API error arrives as `subtype: "success"` with `is_error: true`.** An unknown model gives `api_error_status: 404`, `terminal_reason: "api_error"`. Not being logged in gives `is_error: true` with `api_error_status: null` and the text "Not logged in · Please run /login" |
| Live tool progress | `tool_execution_update` with output text | **nothing** between `tool_use` and its `tool_result`. `tool_progress` is emitted only under `CLAUDE_CODE_CONTAINER_ID`, and is throttled |
| Extensions | bounded-output, context-shake, context-budget, role-notes (`-e`) | none load. Claude Code has its own output truncation, large-output spill-to-file and auto-compaction. `role_notes` needs another carrier |
| Tool names | `bash`, `read`, `edit`, `write` | `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, and `file_path` rather than `path` |
| Auth check | `pi auth check --provider P --json` | `claude auth status` (JSON, `loggedIn`) |

## Findings from live experiments (claude 2.1.216 and 2.1.295, 2026-10-09)

1. **Isolation is mandatory: about 30× cost.** A trivial "ls, read a file, say DONE" run with
   the operator's own `~/.claude` loaded cost **$0.79**. The cause was a user plugin, 16 skills
   and auto-memory: the second turn wrote about 107K tokens to the cache. The same run with the
   isolation flags below cost **$0.025**. A fleet run must never load the operator's personal
   plugins, hooks, MCP servers, skills or memory.
   - `--setting-sources project` still loads the target repo's `CLAUDE.md` (verified). That is
     the project-neutral behavior we want, and it matches pi, which loads both `AGENTS.md` and
     `CLAUDE.md` unless `--no-context-files` is set.
   - claude does not read `AGENTS.md`. When a worktree has an `AGENTS.md` and no `CLAUDE.md`,
     the adapter passes it with `--append-system-prompt-file`, so a repo that only has
     `AGENTS.md` gives claude the same context it gives pi.
   - `--setting-sources ""` drops `CLAUDE.md` too.
2. **Inherited Claude Code environment breaks auth.** Spawned from inside a Claude Code session
   (the desktop app's Code tab, or a nested harness), the child inherited `CLAUDECODE`,
   `CLAUDE_CODE_*` and `ANTHROPIC_BASE_URL` from the host and reported "Not logged in". The
   adapter must scrub the host session's variables before spawning.
3. **SIGTERM to the process group is clean.**
   - It exits 143 in about 0.6 s.
   - It writes a final `result` event (`error_during_execution`,
     `terminal_reason: "aborted_tools"`, cost so far).
   - No orphaned tool processes remain.
   - The session stays resumable and keeps the work done before the kill. The existing
     `detached` + `terminateChild` + `TUMWATER_RUN` sweep apply unchanged.
4. **Claude Code moves long commands to the background on its own.**
   - It refused a foreground `sleep 60`, re-ran it as a background task (`system/task_started`
     … `task_notification`), and when `-p` ended it stopped the task.
   - A fleet run whose test suite gets backgrounded and then abandoned would report work it
     never verified. Set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, and raise
     `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` so a slow suite (a Rust repo's, say) runs
     in the foreground. Claude's default Bash timeout is 2 min, with a 10 min maximum.
5. **Usage must be de-duplicated by `message.id`.** A message with text and a `tool_use` arrives
   as two `assistant` events, each carrying the full usage. Summing per event double-counts.
6. **Sonnet 5.5 reports `contextWindow: 1000000`.** pi's 70%/85% context-shake has no
   counterpart, and none is needed: Claude Code compacts on its own and reports a
   `compact_boundary` when it does.
7. **Background model calls.** With the operator's config loaded, a Haiku side-call showed up in
   `modelUsage`; it did not in isolated runs. `total_cost_usd` already includes such calls, so
   cost comes from `result`, never from re-pricing tokens.
8. **This machine authenticates with a claude.ai Team subscription** (`claude auth status`):
   - `total_cost_usd` is the API-equivalent price, not money spent.
   - `rate_limit_event` reports the subscription window (`rateLimitType: "five_hour"`,
     `status`, `resetsAt`).
   - The run's `system/init` says what paid for it: `apiKeySource: "none"` for claude.ai OAuth,
     `"ANTHROPIC_API_KEY"` / `"apiKeyHelper"` for a key.
9. **The installed CLI gates which models work and how they are priced.**
   - On 2.1.216, `claude-opus-5-5` failed with a 400: "does not support this model; version
     2.1.280 or newer is required". It arrives as `subtype: "success"`, `is_error: true`, so the
     configError mapping catches it.
   - On 2.1.216, `claude-haiku-5-5` ran, but a one-word reply cost $0.125 and reported a 200K
     window.
   - After `claude update` to 2.1.295:
     - the same three calls cost $0.015 (Opus), $0.0074 (Sonnet) and $0.0005 (Haiku);
     - all three report a 1M window;
     - the old CLI had priced Haiku 5.5 about 250× too high, because `total_cost_usd` comes
       from the CLI's own price table.
   - The claude adapter's `minVersion` is 2.1.280 for all three default models. Doctor fails
     below it. That matters because fleet runs set `DISABLE_AUTOUPDATER` and never update
     themselves.

## Design

### 1. The seam: `AgentBackend`

A new `src/agent/` module owns what is backend-neutral and moves there from src/pi/pi.ts:

- the spawn
- the raw-log marker
- the watchdogs
- the abort, group-kill and marker sweep
- the stderr capture

Each backend supplies an adapter:

```ts
interface AgentBackend {
  id: "pi" | "claude";                 // the registry key; also the selector namespace (§3)
  label: string;                       // "pi", "Claude Code" — for doctor/status/error text
  defaultBin: string;                  // "pi" | "claude"
  binEnv: string;                      // "TUMWATER_PI_BIN" | "TUMWATER_CLAUDE_BIN"
  defaultModels?: Partial<Record<ModelTier, string>>; // claude: haiku/sonnet/opus 5.5 by tier; pi: none
  minVersion?(model: string): string | undefined;     // claude: CLI version a model needs (doctor)
  invocation(run: AgentRunSpec): { args: string[]; stdin?: string; env: NodeJS.ProcessEnv };
  translator(): StreamTranslator;      // native stdout lines → canonical event lines (§2)
  sessions: SessionStore;              // fresh/resume handles (§4)
  classifyExit(code, stderr, translated): Partial<PiRunResult>;
  pricing: { pairFree(sel): boolean; cacheReadUnpriced(sel): boolean };
  doctorChecks(config): DoctorCheck[]; // binary, auth, model resolvability
  dialect: PromptDialect;              // the few backend-specific prompt phrases (§6)
}
```

`runPi` becomes `runAgent`, which dispatches on the resolved config's `agent`. `PiRunOptions` /
`PiRunResult` keep their names in this series; a rename is churn with no behavior, and is left
to organize.

The pi adapter wraps today's code byte-for-byte:

- `piArgs` with its `-e` extensions
- the identity translator
- `hasResumableSession`
- `pi-models.ts` pricing
- `pi auth check`

### 2. Canonical event stream: translate, don't teach every reader

About fifteen readers fold the raw log `.tumwater/log/<role>.pi.jsonl` by pi's event shapes:

- `PiStreamParser`
- progress-data
- transcript and transcript-tail
- tick-progress-model
- `tumwater logs`
- the GUI transcript endpoint
- suite-rerun
- firstEditTurn

Rather than teaching each a second dialect, **pi's current event vocabulary becomes tumwater's
canonical stream**. Each adapter's translator turns its native lines into canonical lines, and
those canonical lines are what runPi feeds `PiStreamParser` and writes to the raw log. Every
reader stays untouched. The native stream goes to `.tumwater/log/<role>.<agent>.native.jsonl`
(rotated and pruned like the raw log) for debugging only.

The claude translator:

| claude event | canonical |
| --- | --- |
| `system/init` | `session` (`cwd`, `id` = session_id) then `agent_start` — progress-data anchors on `session` |
| `assistant` events sharing a `message.id` | **one** `message_end` once the id changes (or on `user`/`result`): content blocks merged in order (`text`, `thinking`, `tool_use`→`toolCall` with `name` lower-cased and mapped: Bash→bash, Read→read, Edit/MultiEdit→edit, Write→write, Glob/Grep kept lower-cased; `arguments` = `input` plus a `path` alias of `file_path`). Usage taken once: `input`=input_tokens, `cacheRead`=cache_read_input_tokens, `cacheWrite`=cache_creation_input_tokens, `output`, `totalTokens`=their sum. `cost.total` = 0 (see `run_cost`) |
| each `tool_use` block | `tool_execution_start` (`toolCallId`, `toolName`, `args`) emitted when its message closes |
| `user` `tool_result` block | `tool_execution_end` (`toolCallId`, `isError`) |
| `system/api_retry` | `auto_retry_start` (`attempt`, `maxAttempts`, `errorMessage` built from `error_status`/`error`) — the transcript already renders it |
| `system/compact_boundary` | `compaction_start` (→ `compacted`) |
| `rate_limit_event` with `status: "rejected"` | an error-bearing event the parser maps to `transientRateLimit`, with `retryAfterSeconds` from `resetsAt` |
| `result` | new canonical `run_cost {total}` (PiStreamParser: the run's authoritative cost replaces the per-message sum), then a synthetic final `message_end` only if the run ended with an error: `stopReason: "error"` and an `errorMessage` that carries an explicit classification (below) |

**Error classification is explicit, not regex-on-text.** The translator sets the canonical
event's error fields from `api_error_status` / `terminal_reason`, and adds a new optional
`tumwaterKind` field. PiStreamParser trusts that field before it falls back to its regexes:

| claude signal | PiRunResult |
| --- | --- |
| 429, or `rate_limit_event` rejected | `transientRateLimit`, `retryAfterSeconds` |
| 500/502/503/504/529 (overloaded) after claude's own retries | `transientBackend`, kind `server` |
| connection / timeout text in `error` | `transientBackend`, kind `connection` / `timeout` |
| 400/401/403/404, "Not logged in", "There's an issue with the selected model" | `configError` |
| "prompt is too long" | `contextExceeded` |
| `error_max_budget_usd` | new `budgetCapped` (see §7) |
| last message `stop_reason: "max_tokens"` with no text | `finalMessageContentless` (the cut-off resume path) |
| "No conversation found with session ID" | new `resumeMissing` → the caller retries fresh (§4) |

### 3. Config: `agent`, `agents`, and backend-namespaced selectors

The name is `agent`, not `backend`, because "backend" already means *the model server* in
tumwater (docs/backends.md, `transientBackend`, `BackendFailureKind`, the provider-keyed fleet
hold).

```jsonc
{
  "agent": "claude",                       // default "pi"; the backend for bare selectors and the no-model default
  "model": { "default": "claude-sonnet-5-5",
             "strong":  "claude/claude-opus-5-5:high" },
  "fallback": "omlx/Qwen3.8-27B-MLX-oQ4e-mtp",  // a non-claude provider ⇒ runs on pi
  "agents": {
    "claude": { "bin": "claude", "args": [] },  // args: user passthrough, last (like piArgs)
    "pi":     { "bin": "pi",     "args": [] }   // legacy agentBin / piArgs read as these
  }
}
```

Routing a selector to a backend:

1. If the provider segment is a registered agent id, that agent runs it, so `claude/<id>[:level]`
   always runs on claude. The ids are reserved; doctor warns if `~/.pi/agent/models.json` has a
   provider of the same name.
2. Any other `provider/id` runs on **pi**, the one backend with providers. That is what keeps
   `fallback: "omlx/…"` working under `agent: "claude"`.
3. A bare id (no `/`) runs on the top-level `agent`. With `agent: "pi"` that is today's bare
   pi pattern.
4. With **no `model` key at all**, each seam uses `agent`'s default model for its tier. For
   claude those are `small` → `claude-haiku-5-5`, `default` → `claude-sonnet-5-5` and `strong` →
   `claude-opus-5-5`; pi has none, and pi's own default applies as today.
   - Once the operator sets `model` (a string or a map), today's tier rules apply unchanged: a
     tier left out inherits the map's `default`, so `"model": "claude-sonnet-5-5"` still means
     one model everywhere.
   - The defaults are full ids, not the `sonnet`/`opus`/`haiku` aliases: an alias floats with
     claude releases, while event labels and cost history should name what actually ran.
   - The defaults live in the claude adapter (`AgentBackend.defaultModels`, a tier map), not in
     `defaultConfig()`. That keeps `model` absent from configs that never set it.

A thinking suffix maps to `--effort` (`low…max` 1:1). `off` and `minimal` map to `low`; claude
has no lower setting, and doctor notes the clamp. `ResolvedModelConfig` gains `agent`, so every
existing seam resolution carries the backend with no new plumbing:

- `configForRole`, `reviewRunConfig`, `resolverConfig`
- the fallback views

Back-compat:

- `agentBin` and `piArgs` are read as `agents.pi.bin` and `agents.pi.args`. Setting both forms
  is a validation error.
- `TUMWATER_PI_BIN` keeps its meaning. `TUMWATER_CLAUDE_BIN` is new.
- Writers emit only the new form.

Reserved flags: claude's `HARNESS_*_FLAGS` set covers `-p/--print`, `--output-format`,
`--verbose`, `--model`, `--effort`, `--session-id`, `--resume/-r`, `--continue/-c`,
`--permission-mode`, `--tools`, `--setting-sources`, `--strict-mcp-config`, `--mcp-config`,
`--disable-slash-commands` and `--max-budget-usd`. Repeating any of them in `agents.claude.args` is a validation
error.

### 4. Sessions

pi resumes "the newest session in the role's session dir". claude resumes by id, from the cwd
the session was started in. Each `SessionStore` writes a small ledger,
`<sessionDir>/sessions.jsonl`, with one line per run: `{agent, id, kind, name, cwd, model, at}`.

- **Fresh run (claude):** mint a UUID, pass `--session-id`, and append the ledger line before
  spawning.
- **Continue (claude):** take the newest ledger line with this run's `kind`, so a landing
  conflict resolver's fresh session in the author's dir can no longer shadow the author's, a
  latent pi hazard today. If its agent is claude, its `cwd` equals this run's cwd and the
  transcript file exists, pass `--resume <id>`. Otherwise the session is **not resumable**.
- `hasResumableSession(dir)` becomes `sessions.resumable(dir, {kind, cwd, agent})`. pi's
  implementation stays "any `*.jsonl` in the dir" but also requires the newest ledger line to be
  pi's.
- **Cross-backend continuation** (budget handback, model fallback, operator `agent` change
  between a shutdown and its resume):
  - Today `tick-resume.ts` falls back to a *fresh* tick, which resets the worktree and throws
    away the interrupted run's uncommitted edits.
  - Instead, add a `handoff` resume cause: a fresh session on the new backend, the worktree left
    as is, and a bridge prompt. The bridge is the tick prompt plus: "an earlier run on another
    model was interrupted; its uncommitted edits are in your worktree — review `git diff` and
    finish or discard them."
  - The same path covers a resume from a different pool slot. Lease pinning makes that rare, but
    a restart can still cause it.
- **Retention:** `.tumwater/sessions` pruning is unchanged. Claude's transcripts live in
  `~/.claude/projects/<slug>/` and age out under Claude Code's own `cleanupPeriodDays`. Doctor
  reports their total size, since each pool slot gets its own slug directory.

### 5. The claude invocation

```
claude -p --output-format stream-json --verbose
  --model <id> [--effort <level>]
  --session-id <uuid> | --resume <uuid>
  --permission-mode bypassPermissions          # parity with pi, which has no permission system
  --tools Bash,Read,Edit,Write,Glob,Grep       # no Task (sub-agents), Web*, Cron, Monitor, Workflow…
  --setting-sources project                    # repo CLAUDE.md + .claude/settings.json; never ~/.claude
  --strict-mcp-config [--mcp-config <tumwater MCP json>]   # §6: role_notes
  --disable-slash-commands                     # no skills
  --exclude-dynamic-system-prompt-sections     # cwd/git status move out of the system prompt → one cache prefix across pool slots
  [--append-system-prompt-file AGENTS.md]      # only when the worktree has AGENTS.md and no CLAUDE.md (finding 1)
  [--max-budget-usd <remaining>]               # API billing only, not the director (§7)
  <agents.claude.args…>
  < prompt on stdin
```

Environment, layered on today's (`TUMWATER_RUN`, `NODE_OPTIONS` preload, notebook):

- **Removed** (finding 2):
  - `CLAUDECODE`
  - every `CLAUDE_CODE_*` and `CLAUDE_AGENT_SDK_*`, except the operator-intent allowlist:
    `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_OAUTH_TOKEN`,
    `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
  - `CLAUDE_PID`, `CLAUDE_EFFORT`
  - `ANTHROPIC_BASE_URL`, only when `CLAUDECODE` was set (a host session's proxy, not the
    operator's)
- **Set:**
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
  - `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`
  - `BASH_DEFAULT_TIMEOUT_MS=600000`
  - `BASH_MAX_TIMEOUT_MS` = `quietTimeoutSeconds` × 1000 − 60 s, so claude's own Bash timeout
    fires before tumwater's quiet kill and the model sees a tool error rather than a dead run
  - `DISABLE_AUTOUPDATER=1`, so a mid-fleet self-update never swaps the binary under a run
  - `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`, decided 2026-10-09: fleet runs send
    no telemetry

### 6. What the pi extensions did, per backend

| Extension | claude |
| --- | --- |
| bounded-output (head+tail at 12k/16k + full-output file) | Claude Code truncates Bash output and spills large results to a file it names. Not needed; the prompt bullet that promises tumwater's marker becomes dialect text |
| context-shake (pi `context_edit` at 70/85%) | Not needed: claude auto-compacts (→ `compacted`), window 1M |
| context-budget (50/70/85% notes) | Dropped for claude in this series. Possible later via a `--settings` PostToolUse hook |
| role-notes (`role_notes` tool) | **A tiny stdio MCP server shipped in dist** (`src/agent/mcp/role-notes-server.ts`) passed via `--mcp-config` only when `TUMWATER_NOTES_PATH` is set; same 4 KB cap and atomic write, sharing `role-notes.ts`'s write function. Tool name `mcp__tumwater__role_notes`. MCP rather than "edit this file": the notebook lives under `.tumwater/`, which the prompts forbid touching, and every future agent CLI speaks MCP |

`PromptDialect` carries the only backend-specific prompt text:

- the notes tool's name (`ROLE_NOTES_INSTRUCTION`, src/prompt/prompt.ts:220)
- the read tool's range parameters (`CONTEXT_BUDGET_RULE`, prompt.ts:47; claude's Read also
  takes `offset`/`limit`)
- the oversized-output bullet (prompt.ts:57-59)

Everything else in the prompts already speaks in shell commands and "tool calls".

### 7. Billing: subscription or API, and what each means for the budget

Decided 2026-10-09: when a claude.ai subscription pays for a run, that run is exempt from the
daily dollar cap, and the subscription's usage window is its only throttle. When an API key pays,
the existing spending rules apply unchanged.

**Detection, per run.** The run's own `system/init` says what paid for it:

- `apiKeySource: "none"` with the first-party provider is claude.ai OAuth, i.e. the
  subscription. No `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY` may be set in the run env.
- `"ANTHROPIC_API_KEY"`, `"apiKeyHelper"`, or a third-party provider is API billing.

The translator puts this on the result as `billing: "subscription" | "api"`.

- Before any run, the startup gate and doctor seed the same answer from `claude auth status`
  (`authMethod: "claude.ai"`, `subscriptionType`) plus the presence of `ANTHROPIC_API_KEY`,
  which claude prefers when set. They store it in `.tumwater/state/claude-account.json`.
- Each run's observed value then overwrites it. A mid-day `claude auth login` or an exported
  key is picked up on the next run, with no config key to keep in sync.

**Overage is real money.** A Team or Enterprise plan with extra usage enabled keeps running past
the window and bills the overflow: `rate_limit_event.isUsingOverage: true`. A run that saw
`isUsingOverage` at any point counts its whole cost as API spend. This is conservative: the share
inside the window gets counted too.

**Subscription runs:**

- **Cost.** `costUsd` is still recorded, as the API-equivalent price, but it is folded as
  `notionalCostUsd`. Neither `recordDailyCost` nor the per-role spend sees it. `tick_end` carries
  both fields, and `tumwater report` shows notional spend on its own line ("claude subscription,
  API-equivalent: $X"), never in the total.
- **Free-ness.** Under subscription billing, a claude selector counts as free in the backend's
  `pricing.pairFree` (its marginal cost is zero), and everything downstream follows:
  - `applyFallbackModel` does not move a subscription seam to a fallback at the cap.
  - A subscription claude model is a valid budget `fallback` for a paid pi primary.
  - With every seam on subscription claude, `fleetModelsFree` is true, and the window display
    below replaces the "budget n/a" badge.
- **Per-run cap.** No `--max-budget-usd`.

**API runs:**

- **Spend.** `run_cost` (from `result.total_cost_usd`) feeds `costUsd` and the daily budget
  exactly as pi's cost does. Token fields come from the de-duplicated messages.
- **Free-ness.** Never free: never a budget fallback, and the cap moves these seams to their
  fallback like any priced pi model.
- **Per-run cap.**
  - Pass `--max-budget-usd` = the remaining daily budget (`maxDailyCostUsd` − spent). For a seam
    under `maxDailyCostUsdPerRole`, use the lower of that and the role's remaining cap.
  - One runaway run can then never overshoot the cap. `error_max_budget_usd` maps to
    `budgetCapped`, which the tick treats like a budget handback: preserve the worktree, then
    resume as `handoff` on the fallback.
  - Not passed for the director, which is exempt from the cap today.
- **Expected spend.** At about $3/M input (the Sonnet 5.5 runs imply roughly $3 in, $15 out,
  0.1× cache reads, 2× 1-hour cache writes), a fleet of today's size could spend tens of dollars
  a day: today's GLM fleet spends about $4/day against a $15 cap. That makes the budget fallback
  to oMLX the normal afternoon state. README should say so.

**Both:** a run that emits no `result` (SIGKILL after the 10 s grace) records its token counts
with cost 0 (decided 2026-10-09: no price table) and logs a `cost_unknown` warning.

**Cost is only as good as the CLI's price table.** `total_cost_usd` is priced by the installed
claude, and a CLI older than the model misprices it (finding 9). Doctor enforces each configured
model's minimum CLI version (`minVersion`), which matters doubly because fleet runs set
`DISABLE_AUTOUPDATER`.

### 8. The subscription usage window

**State.**

- The translator collects every `rate_limit_event.rate_limit_info`: `rateLimitType`
  (`five_hour`, plus any longer windows the account reports), `status` (`allowed`,
  `allowed_warning`, `rejected`), `resetsAt`, the optional `utilization` (0–1), `overageStatus`
  and `isUsingOverage`.
- runAgent writes the newest reading per `rateLimitType` into
  `.tumwater/state/claude-account.json`, with `observedAt`. Only the orchestrator process
  writes it.
- Once `resetsAt` passes, a reading is stale, and it is shown as reset until the next run
  reports again.

**Throttle.**

- `rejected` with no overage places a provider-`claude` fleet hold until `resetsAt`, through
  src/fleet/fleet-hold.ts. Every seam that runs subscription claude waits. pi seams, and API-key
  claude seams, keep ticking. A rejected run is a transient: nothing is reset, and it resumes
  after the hold.
- Events (once per window, not per run):
  - `claude_window_warning`, on the first `allowed_warning`;
  - `claude_window_limited` {type, resetsAt}, when the hold is placed;
  - `claude_window_reset`, when the hold lifts.
- Holding is right where the per-poll retry is not: a window that resets in three hours would
  otherwise burn a failed run per loop per poll.

**Display, in place of the daily spend.**

| Fleet's paying seams | TUI/GUI budget badge and tile, `tumwater status` |
| --- | --- |
| all on subscription claude | **window only**: "Claude 5h · 64% · resets 14:30". The percentage is shown when `utilization` is reported; otherwise the status word (ok / near limit / limited). Amber at `allowed_warning`, red with "claude seams held until 14:30" at `rejected`, and an "overage" marker while `isUsingOverage` |
| some subscription claude, some priced (pi or API claude) | both: the daily spend line, covering priced seams only, and the window line |
| none on subscription | today's display, unchanged |

- When the account reports more than one window, the badge shows the one closest to its limit,
  and the tile lists all of them.
- The role view (`tumwater role <id>`) shows "billing: subscription (5h window)" or "billing:
  API" for a claude seam.

### 9. Watchdogs and progress

- **Quiet watchdog:** unchanged. Every canonical event is progress. A long Bash call yields no
  events until it returns, but `BASH_MAX_TIMEOUT_MS` (§5) keeps any single call under
  `quietTimeoutSeconds`.
- **Stalled-tool warning:** claude never sends content updates. Treat every claude tool call
  the way `commandBuffersOutput` commands are treated today, with a duration threshold of
  `bufferedCommandStallMs`, and set it per backend. Otherwise every test run longer than
  `toolCallStallSeconds` would cry wolf (BUGS.md 2026-09-28's lesson). Both surfaces (runPi's
  warning, progress-data's flag) read the backend from the `tumwater_run` marker, which gains an
  `agent` field.
- **Subscription window:** see §8. A rejected window is a fleet hold, not a run failure.

### 10. Every seam, checked

| Seam | Runs through | What changes |
| --- | --- | --- |
| Author tick (all 14 roles, user loops) | `LoopPi.runAuthoringPi` | the role's tier selector → backend; notebook via MCP on claude |
| Director | same, no notebook | budget-exempt as today: no `--max-budget-usd` on API billing |
| qa | same + `extractFlow(finalText)` | none (finalText from the merged last message). Its background servers (`gui &`) are still caught by the marker sweep; claude's own background tasks are disabled |
| SUMMARY / stage-fix follow-ups | `requestFollowUp`, `continueSession` | `--resume <ledger id>`, same cwd by construction |
| Transient retry | `runWithTransientRetry` | the same; claude's own `api_retry` happens first, so the harness retry sees fewer transients |
| Resume after shutdown, quiet-kill, timeout-while-progressing, cut-off, error-dirty | tick-resume.ts | ledger-based resumability; `handoff` when cross-backend or cross-slot |
| Budget handback / model fallback | loop.ts, model-fallback.ts | `handoff` instead of a lossy fresh tick when backends differ |
| Reviewer (+ VERDICT recovery, no-rerun nudge) | `runGatePi`, `review-followup.ts` | suite-rerun detection works via the `Bash`→`bash` mapping. Reviewer on claude, authors on pi is a supported mix |
| Conflict resolver, refusal-note resolver | `runLandingPi`, `runRolePi` | ledger `kind` keeps their sessions from shadowing the author's |
| Doctor | doctor-model-checks.ts, doctor-checks.ts | per used agent: binary resolvable; claude `auth status` loggedIn (with the scrubbed env) and its billing (subscription type, or API key); installed CLI ≥ every configured claude model's `minVersion`; claude selectors skip models.json lookup; a pi provider named `claude` warns |
| Startup gate | startup-gate.ts | checks the binary of every agent any resolved seam uses, not only pi's |
| Status, TUI, GUI, events | role-view, status-data, badges, event-format | "pi default" → "`<agent>` default"; `tick_start`/`review_start` `model` selectors carry the agent (`claude/claude-sonnet-5-5`); the window replaces or joins the daily spend (§8) |
| Reports | report-data, history-data | subscription runs' cost appears as notional, never in spend totals (§7) |

## Testing

- `test/fakes/fake-claude.ts`, the twin of fake-pi.ts:
  - a PATH shim named `claude` that replays canned stream-json
  - records argv **and stdin** per run
  - creates the transcript file under a temp `HOME` so resume checks pass
- `test/fixtures/claude-events.ts`: builders for the shapes above, trimmed from the 2026-10-09
  captures: the split-block assistant message, the 404 model, not-logged-in, SIGTERM, compact,
  api_retry and rate-limit-rejected results.
- Translator unit tests feed fixtures and assert the canonical lines and the folded
  PiRunResult. Most behavior tests stay on fake-pi, unchanged.
- `npm run smoke:claude` is an opt-in live check, **not in `npm test`** (it costs money and
  needs auth). It does:
  - one isolated three-turn run
  - a resume
  - a SIGTERM-and-resume
  - an assertion that cost is under $0.10, which catches an isolation regression (finding 1)
  - a check that the run's `billing` matches `claude auth status`, and that
    `claude-account.json` gained a window reading when the billing is subscription
  - one call each on the three default models, so a CLI too old for one fails here and not in
    the fleet
- `test-runner.ts` also strips `TUMWATER_CLAUDE_BIN`, `CLAUDECODE` and `CLAUDE_CODE_*` from the
  suite environment, so the suite behaves the same when launched from inside Claude Code.

## Risks

- **`NODE_OPTIONS` preload.** claude is a single-file native build. Before part 3 lands, verify
  that it ignores, or accepts, the `--import=data:` preload that tumwater puts in
  `NODE_OPTIONS` on macOS. If it chokes, the preload must still reach `npm` grandchildren:
  set it in the Bash tool's environment through `--settings '{"env":…}'` instead of on claude
  itself. Also measure claude's own launchservicesd port use with doctor's `mach ports`
  (memory: launchservicesd port leak).
- **Claude CLI drift.** The stream-json schema is versioned only by `claude_code_version` in
  `system/init`. The translator logs an `agent_unknown_event` warning once per type it does not
  map (it never fails a run on one), and doctor prints the installed version.
- **Bypass permissions.** These are unattended runs with full shell access, the same trust pi
  gets today. The worktree and process isolation are unchanged. Not running as root is assumed
  (claude refuses `bypassPermissions` as root).

## Decisions (operator, 2026-10-09)

1. **Subscription billing** is exempt from the daily cap and throttled only by the usage window.
   The TUI/GUI show the window in place of the daily spend. API-key billing keeps the regular
   spending rules (§7, §8).
2. **A result-less run costs 0.** No price table; the run logs `cost_unknown`.
3. **Target repo settings are honored:** `--setting-sources project`, so the repo's
   `CLAUDE.md` and its committed `.claude/settings.json` apply.
4. **Telemetry off** for fleet runs (`DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`).
5. **Tier defaults on claude:** Opus 5.5 for strong, Sonnet 5.5 for default, Haiku 5.5 for small
   (§3).
