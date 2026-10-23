# Backends

tumwater drives pi, and pi drives a model backend. Nothing in tumwater is tied to a
particular one: any OpenAI-compatible endpoint pi can reach will do. Claude
Code and OpenCode are selectable with `backend` beside `model` — `model` names the model, `backend`
names the program that runs it (see [Claude Code](#claude-code-backend-claude) and
[OpenCode](#opencode-backend-opencode) below).

## What a backend must provide

- **An OpenAI-compatible endpoint pi can reach** — a hosted provider's base URL, or a local
  server. Name it with `provider` and `model` in `tumwater.json` (and a per-role override under
  `roles.<id>` when a single role needs a different model).
- **A context window large enough for a run's prompt.** Every run starts a fresh pi session
  (~8k-token prefill), but a dense run grows to tens of thousands of tokens before it ends.
  Declare an honest `contextWindow` for the model in pi's `models.json` — it is what pi uses to
  decide when to compact, and the number that keeps a run off the backend's real ceiling.

## How the config points at it

`model` in `tumwater.json` names the model every role uses, as one `provider/id[:thinking]`
model id; `thinking` sets the level for any model id without a `:level` suffix. Leave `model`
out and pi's own default applies:

```json
"model": "huggingface/zai-org/GLM-5.3-Flash:together:low",
"fallback": "omlx/Qwen3.8-27B-MLX-oQ4e-mtp"
```

The role rows then name that default — read from pi's `settings.json` beside its models catalog —
marked `pi default`, so `tumwater status`, the TUI and the dashboard still show which model each
role runs. That marking only appears when `tumwater.json` resolves no model at all, so the two
never disagree about where a model name came from. When every role runs that same default, `tumwater status` and the TUI name it once under the table
instead of on each row; the dashboard keeps showing it per row.

`fallback` names the free model roles switch to when the primary cannot carry the work:
once `maxDailyCostUsd` is spent (the budget gate), and while a role's tier primary keeps
failing with provider-class errors (model failure fallback, described in
[how-it-works.md](how-it-works.md)). The budgeted model does the day's paid work; the free one
keeps the team alive afterwards and covers a primary that is down.

When different model jobs want different models, `model` and `fallback` each take a map listing the
tiers you have — a tier left out of `model` inherits `default`, and a tier left out of `fallback`
borrows another tier's own fallback (small → default → strong; default → strong → small; strong →
default and never small, because a weak reviewer or planner costs more than a paused one):

```json
"model":    { "default": "huggingface/zai-org/GLM-5.3-Flash:together:low",
              "strong":  "huggingface/<strong-model>:high" },
"fallback": { "default": "omlx/Qwen3.8-27B-MLX-oQ4e-mtp" }
```

A tier's `fallback` may also be an ordered list of model ids (`"fallback": ["omlx/a", "omlx/b"]`, or
a list as a map value). A tier runs its first usable step: the first one that is free and that the
failure breaker has not demoted, so a local server that is down falls through to the next. When no
step of a tier's own list is usable the tier borrows another tier's list as before, and otherwise
pauses. `"pause"` is a whole-tier value, never a list element.

A step may also be an object, `{ "model": "<model id>", "maxDailyCostUsd": 5 }`, which lets a paid
model sit in the chain with a daily cap of its own (a bare id is the same as `{ "model": … }`). A
priced step is usable only while the team is under `maxDailyCostUsd` **and** the step's real spend
for the local day, summed over every role, is under its own cap, so priced steps never run past a
cap: at the team cap only free steps remain. For an API-billed Claude step, a run's
`--max-budget-usd` is also lowered to what is left of the step's cap. For example, subscription
Claude first, then HF capped at $5 a day, then a local model:

```json
"fallback": {
  "default": [
    { "model": "huggingface/deepseek-ai/DeepSeek-V4-Flash-0731:deepinfra", "maxDailyCostUsd": 5 },
    "omlx/Qwen3.8-27B-MLX-oQ4e-mtp"
  ]
},
"maxDailyCostUsd": 15
```

The legacy `provider` key and `fallbackModel` object still parse for existing configs, but
tumwater writes the model id forms above.

Only a provider/model pair pi's `models.json` prices at zero is accepted as a fallback, so the
switch cannot spend past the cap: an unknown id, a priced model, or a missing definitions file is
refused and the team pauses instead. `teamModelsFree()` reads that same catalog to decide the
budget badge, which reads `· budget: $10.02/$10 today · fallback: <model> (cost n/a)` while the
fallback is carrying the team.

### Notes for local fallbacks

- Distinct local fallbacks on one server must all fit in memory at once, or the server swaps
  models per request. Usually declare only `fallback.default` and let the strong tier borrow it,
  or reuse the same local model at a higher thinking level.
- "Same model, more thinking" needs the level to reach the server: oMLX's Qwen ignores
  `reasoning_effort` and honors only `thinking_budget`, which pi sends only when the model's
  `models.json` entry sets `compat.thinkingTokenBudgetField: "thinking_budget"`; without it,
  `:high` on that model is a no-op.

## Image input (claims, probe, reroute)

A role reads an image (an `--attach` on a message in its inbox, or a file the run itself points pi
at) only when its model job can. Capability has one source of truth — `seamImageInput`
(`src/agent/image-input.ts`):

- **Claude model jobs** can always read images (every Claude model does), so a job on the claude backend
  answers `true` for any model, never probed.
- **pi model jobs** read the model's `input` list in pi's `models.json` — `"image"` present means
  capable, and *absent* means text-only. A pair missing from `models.json` is *unknown*, not
  assumed capable (the `models for each tier` doctor check flags a pair that is in neither
  `models.json` nor `pi --list-models`; the image-capability lookup reads `models.json` only).

A claimed pi model job is only as good as the **live probe** confirms: `tumwater doctor` shows each
claimed model a real generated PNG and checks the answer, caching the verdict in
`.tumwater/state/image-probes.json` for 7 days. A failed probe makes the job read `false`
everywhere — a claim the doctor contradicted must not let a blind read through. The TUI Health
tab and the dashboard never probe on a refresh (it must not spend a model call); `--reprobe`
forces terminal runs to probe again, and the dashboard Health card's Re-probe models button
and the TUI Health tab's Ctrl+P force every probe, as `--reprobe` does.

When a run does read an image on a text-only model job, it is stopped and the role **reroutes**
onto a peer tier that reads images (small → default → strong from the role's own tier; a strong
job never drops to small). The surfaces say so without running doctor: `tumwater role <id>` and
`status --json` show the role's `imageInput` and its reroute target, and the images team alert
is blue when every text-only role has a target ("reruns on …") or amber when some role has none
or a claimed model failed the probe.

The same capability gates **submission**: `tumwater prompt --attach` and the dashboard refuse an
image when the target role reads none and no tier can, naming the fix before anything is queued;
when the role reroutes, the prompt is accepted and the command says where it will run.

## Claude Code (`backend: "claude"`)

`backend` in `tumwater.json` is the default for every selector that names none: the backend
bare model ids and the no-model default run on. `claude` runs on the Claude Code CLI instead of pi:

```json
"backend": "claude",
"backends": { "claude": { "bin": "/usr/local/bin/claude", "args": ["--debug"] } }
```

`backends.claude.bin` overrides the binary (`TUMWATER_CLAUDE_BIN` overrides it for one run), and
`backends.claude.args` appends extra argv after tumwater's own flags; a flag tumwater sets
itself is a load error rather than a silent override. An optional `backends.claude.configDir`
points claude's own config — transcripts and login — at a directory of the team's own; it
becomes `CLAUDE_CONFIG_DIR` for every claude process tumwater spawns (runs, the `auth status`
seed, and doctor), and the resume check and the "claude transcripts" row follow it. A leading
`~` expands, and the value must be an absolute path after expansion; unset, behavior is exactly
today's (`$CLAUDE_CONFIG_DIR` else `~/.claude`). This keeps transcripts out of `~/.claude` so the
`funes` transcript-recall hook (if you use it for your own sessions) never indexes team runs —
`tumwater doctor`'s `funes` row warns when a Claude Code team runs without one while that hook
is installed.

A fresh config dir reports `loggedIn: false`, so it needs a one-time login in that dir:
`CLAUDE_CONFIG_DIR=<dir> claude auth login`, or alternatively `claude setup-token` exporting
`CLAUDE_CODE_OAUTH_TOKEN` (which tumwater already passes through). The configured dir wins over
an inherited `CLAUDE_CONFIG_DIR`, never the other way.
A tier entry, a role (`roles.<id>`), the review and a fallback step each take their own
`backend` beside `model`, and that backend runs the id as written, whatever the top-level
`backend` says: `{ "backend": "claude", "model": "claude-opus-5-5" }` runs on claude,
`huggingface/…` ids stay on pi. A model id never names a backend: `claude/<id>`, `opencode/<id>`
(under pi) and a bare `claude-…` id under pi fail the load, each message naming the edit — write
`backend: "claude"` beside `model: "claude-opus-5-5"`, or `anthropic/claude-…` to keep a claude
model on pi. codex likewise has no namespace spelling: write the bare model id
(`gpt-6.1-sol`), since a whole `codex/<id>` string parses to a `codex` provider that codex,
like pi, drops, leaving the model half. A fallback step with no `backend` inherits its tier primary's backend (the tier
entry's, else the top level's).
Each tier has a claude default — Opus 5.5 strong, Sonnet 5.5
default, Haiku 5.5 small — so `backend: "claude"` with no `model` still resolves a concrete model
per job; the director runs at the strong tier. The observability surfaces display the backend ahead of the model id (`claude/claude-sonnet-5-5`
in `tumwater status`, the dashboards, and the event feed), and a job with no model at all reads
`claude default`.

**Billing and spend.** Each claude run reports the CLI's own price for it. A run billed to an
API key — or one that saw `isUsingOverage` at any point — feeds the daily cap like any priced
pi model; at a team of today's size it can amount to tens of dollars a day, so pair it with a
free `fallback`. A run paid by a claude.ai subscription is exempt from the cap: its
API-equivalent cost is tracked as estimated spend, printed on its own line in `tumwater report`,
and never counted in the spend totals. A rejected subscription usage window moves subscription
Claude model jobs to their tier's `fallback` until it resets (the first `allowed_warning` is logged too; both events page a configured `notify` command); with no usable fallback they wait for the reset instead, so the team does not
burn a failed run per role per poll. A used-up window moves a subscription Claude director to its tier's fallback too (with no fallback it waits for the reset), while the cap still never moves the director. Pi model jobs and API-key Claude model jobs keep running, and a run
cut off by the window keeps its worktree and continues on the fallback as a handoff. When the window resets, in-flight fallback runs are handed back to Claude (`budget_handback` with reason `window`). A
subscription Claude job with no overage is free to the budget gate too: at the cap it stays
put while priced jobs move to their fallback, and a subscription claude pair is accepted as a
budget `fallback` for a priced pi primary; an account spending into overage counts like API
spend. The subscription window is shown in place of the daily spend on a subscription-only team, one row per subscription backend in use (`tumwater doctor` prints a `claude window` row for a claude subscription and a `codex window` row for a codex one; a team with no such account prints neither), and a run
cut off by a rejected window resumes once it resets (parts 6d–6e). See
[plans/agent-backends.md](../plans/agent-backends.md) (its Billing and usage-window sections)
for the design.

**Extra usage by position in the chain.** On a subscription account, the first Claude model in
a tier's chain runs on the subscription only: the tier's primary counts, including the
default from `agent: "claude"`. It is unavailable once a window is rejected or a current
reading shows `isUsingOverage`, and the tier moves down its chain on the next poll. A Claude
model listed after it in the same chain may spend extra usage, within its own `maxDailyCostUsd`
and the team cap, and only while no window is rejected and the account's `overageStatus` is not
`rejected`. A step borrowed from another tier keeps the position it has in the chain that
declares it. For example, with a Sonnet primary,
`"fallback": [{ "backend": "claude", "model": "claude-sonnet-5-5", "maxDailyCostUsd": 10 }, { "backend": "pi", "model": "qwenrunner/qwen3.8-27b" }]`
means Sonnet on the subscription, then up to $10 of Sonnet extra usage, then local. The run that
crosses into overage finishes there, because tumwater cannot stop the CLI mid-run, and its whole
cost counts toward the step. **Behavior change:** an account that allows extra usage, with no
later Claude model in its chain, now moves down its chain at the end of the window instead of
spending extra usage up to the team cap. On API billing every Claude step is priced and position
does not matter. The team hold still reads only a rejected window; overage never holds.

**Reserve.** The team and you share one claude.ai account, so a team that uses up the weekly
window leaves your own sessions on extra usage or locked out. `"backends.claude.windowReserve": { "seven_day": 0.8 }`
(window type → fraction, above 0 and at most 1; absent by default — the older top-level
`"claudeWindowReserve"` is its other spelling, and either may be set, but not both) counts a
window as used up for the team once its utilization reaches that fraction, until the window
resets: subscription Claude jobs move down their chain, or wait when there is nowhere to go,
and `subscription_window_reserved` is logged once per window. The director is exempt, since it
runs your own prompts. A later
Claude model in a chain (the extra-usage step) waits too past the reserve, until a reading shows
`isUsingOverage`. The team learns its utilization one run late: readings come only from runs.

An exported `ANTHROPIC_API_KEY` (for pi's `anthropic` provider) makes every Claude model job
prefer the key over a claude.ai login and bill the API, silently ending the subscription
free ride. `tumwater doctor` warns when the key is set, a model job routes to claude, and `claude
auth status` reports a claude.ai login. A claude reviewer's or resolver's window readings
reach the account file when its run folds, not only at the author's next run end, and the
display surfaces (the budget badge, the team alert, `tumwater role`) name a claude
fallback or reviewer by its backend (`claude/claude-sonnet-5-5`).

**Per-run cap.** An API-billed claude authoring run carries `--max-budget-usd` set to what
remains of the daily budget — the lower of the team cap (`maxDailyCostUsd` − team spend) and
the role's own cap (`maxDailyCostUsdPerRole` − that role group's spend) when set — so one
runaway run cannot overshoot it. Subscription-billed runs and the director get no per-run cap.
A run the CLI stops at that cap keeps its session and worktree edits; the next run resumes
them as a `handoff` with a "budget-capped" cause rather than failing.

**Stalled tool calls.** claude sends no content updates while a tool runs, so every open
claude tool call is judged stalled by the buffered-command wall-clock threshold — at least 10
minutes, twice `toolCallStallSeconds` — instead of the silence window pi uses; a long claude
verify run therefore raises no false alarm.

See [plans/agent-backends.md](../plans/agent-backends.md) for the series' full design.

## OpenCode (`backend: "opencode"`)

A selector with `backend: "opencode"` runs the job on the OpenCode CLI for its free DeepSeek
model, instead of pi:

```json
{
  "model": { "backend": "opencode", "model": "deepseek-v4.1-flash-free" },
  "fallback": [
    { "model": "huggingface/deepseek-ai/DeepSeek-V4.1-Flash:deepinfra", "maxDailyCostUsd": 10 },
    "qwenrunner/qwen3.8-27b"
  ],
  "maxConcurrentPerProvider": { "opencode": 3 }
}
```

`backends.opencode.bin` overrides the binary (`TUMWATER_OPENCODE_BIN` overrides it for one run);
`backends.opencode.args` appends extra argv. The team targets OpenCode V2 at **2.0.32 or later**
(the H1-verified version); `tumwater doctor` fails an older (or a 1.x) binary and names
`brew install opencode`. A bare id such as `deepseek-v4.1-flash-free` runs on OpenCode's own gateway, and a
provider-qualified id reaches any provider OpenCode knows:
`{ "backend": "opencode", "model": "anthropic/claude-sonnet-5-5" }`. pi's own built-in `opencode`
gateway provider is not reachable from tumwater.

**The free model and its catch.** `deepseek-v4.1-flash-free` sits on OpenCode's pay-as-you-go
console gateway, not on OpenCode Go, costs \$0 "for a limited time", needs no login, and keeps no
data. It is only served to OpenCode's own client — other clients get a 403 `FreeTierError` — and
the client refuses a request that looks wrong (a malformed session id, or the `read` tool denied
outright). It is also flaky: official clients have hit the 403 intermittently. tumwater treats a
free-tier refusal as a provider failure that moves the job to its tier's `fallback` — never a
config error that stops a role — and a free OpenCode model is free to the budget gate (a valid
`fallback` step for a priced primary; at the cap it keeps running). The catalog prices the model
as free until an observed bill marks it priced.

**OpenCode Go** (`opencode-go/…`) is a separate, paid thing (\$10/month); pi already reaches it
as `opencode-go/models` with `OPENCODE_API_KEY`, so Go needs no tumwater change.

**What tumwater turns off, and why `read` must stay allowed.** The injected config disables every
operator MCP server (team runs ship no MCP server of tumwater's own) and denies `execute`,
`subagent`, `webfetch`, `websearch`, `question` and `skill`. It never denies `read` — denying it
trips the free-tier gate — and `shell`, `glob`, `grep` and `edit` stay allowed for the work.
tumwater never sets `OPENCODE_CLIENT` (no impersonation).

**Role notes ride the `tumwater-notes` command on PATH**, as on every backend, not the MCP server.
The injected config adds no MCP server for notes; a run writes its note by running
`tumwater-notes write` in its shell before it ends.

**XDG is left alone.** `XDG_CONFIG_HOME` and its siblings are not redirected: OpenCode's shell-tool
children inherit the environment, and pointing XDG at a private copy would strip the shell's own
identity (git's `.gitconfig`). The operator's global opencode config and `AGENTS.md` therefore
still load into team runs; `tumwater doctor` warns about any MCP server or plugin/agent/instructions
entry they carry (it scans `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` when
`XDG_CONFIG_HOME` is unset — the folder a run actually loads).

**Where sessions and spill files live.** All sessions share one database per team root at
`.tumwater/opencode/opencode.db` (the catalog would otherwise be re-fetched per session); a run's
spill files land under `~/.local/share/opencode/shell/<root commit>/`. Session retention
(`sessionRetentionDays`) deletes the team's expired OpenCode sessions (`opencode session delete`)
and its old spill files, same window as every other session file.

See [plans/opencode-backend.md](../plans/opencode-backend.md) for the series' full design.

## Codex (`backend: "codex"`)

A selector with `backend: "codex"` runs the job on OpenAI's Codex CLI, paid by the operator's
ChatGPT subscription (Plus today), instead of pi:

```json
{
  "backend": "codex",
  "backends": { "codex": { "configDir": "~/.codex-tumwater", "windowReserve": { "seven_day": 0.7 } } },
  "maxConcurrentPerProvider": { "codex": 2 }
}
```

With no `model`, each tier runs Codex's model for that tier: `gpt-6-astra` strong,
`gpt-6.1-sol` default, `gpt-6-luna` small. There is no `codex/<id>` spelling — write the bare
model id (`gpt-6.1-sol`): a whole `codex/<id>` parses to a `codex` provider that codex, like pi,
drops, leaving the model half. A suspended run resumes on the same session (`codex exec
resume <session id>`).

**The team home and its one login.** An optional `backends.codex.configDir` points Codex at a
home of the team's own; it becomes `CODEX_HOME` for every codex process tumwater spawns, keeping
the team's trust entries, sessions and any skills out of `~/.codex`. It needs one login in that
dir: `CODEX_HOME=~/.codex-tumwater codex login --device-auth`. Never copy an `auth.json` between
homes: ChatGPT refresh tokens rotate, so two homes sharing one token family log each other out —
login a second home separately. Unset, runs use the operator's `CODEX_HOME`. Doctor warns when
the team has no dir of its own.

**Subscription billing only.** A ChatGPT login is subscription billing: codex runs report no cost,
their tokens are shown in the report, and they feed the message-cap, not the USD cap. API-key
billing is refused: doctor and the startup gate fail a codex job when `codex login status`
reports an API key, and `OPENAI_API_KEY` / `CODEX_API_KEY` are scrubbed from runs — codex reports
no price, so per-token billing would spend money the cap cannot see.

**The windows and reserve.** Codex reads two usage windows from each run's session file — a
five-hour and a weekly — and a rejected (or reserved) window moves codex jobs down their tier's
fallback chain until it resets, exactly as on a claude subscription. `backends.codex.windowReserve`
is a per-window-type fraction (0–1] left for you, on the same `five_hour` / `seven_day` type
names claude uses, so one reserve reads the same on both subscriptions. With every codex job on a
subscription, the badge shows the windows, not the spend.

**What is disabled, and why.** Codex runs with no sandbox: `--dangerously-bypass-approvals-and-
sandbox`, the same trust pi and claude (`bypassPermissions`) get. Under Codex's `workspace-write`
sandbox, git is read-only, the role's notes file is unwritable and the check has no network, and
the isolation that matters stays the worktree and the process marker. Sub-agents are off
(`agents.enabled=false`), and every tool tumwater does not need — plugins, apps, goals, image
generation, browser and computer use, web search — is disabled to keep the base prompt small.

**Sessions.** Each codex run is one thread-id session. A continue takes the newest resumable
ledger record of this run's kind on this cwd and runs `codex exec resume <id>`; a missing rollout
in the session's home means "not resumable", and the existing handoff path takes over (a fresh
session, the worktree kept, a bridge prompt). Session retention (`sessionRetentionDays`) also
prunes the ledger's expired Codex sessions with `codex delete --force <id>`, and doctor reports
the home's `sessions/` size.

**The write guard.** Codex's `apply_patch` is wired through the same write guard pi, claude and
OpenCode runs carry: a PreToolUse hook passed with `-c` refuses an `apply_patch` that lands under
the team root but outside the run's worktree. The hook is trusted through the same session-flag
layer, keyed by a hash of its definition that Codex itself reports, cached in
`codex-hook-trust.json`. Shell writes are not `apply_patch` and stay unchecked, as on every
backend; only `apply_patch` is guarded. tumwater never passes `--dangerously-bypass-hook-trust`,
which would run the target repo's own `.codex` hooks unreviewed.

See [plans/codex-backend.md](../plans/codex-backend.md) for the series' full design.

## Worked example: one machine's measurements, 2026-09

The configuration and measurements below are one operator's rig, recorded as a concrete example
rather than a recommendation. Replace every value with your own backend's.

**A budgeted API primary with the local server as the cost n/a
fallback.** tumwater.json names `huggingface` / `deepseek-ai/DeepSeek-V4.1-Flash` (HF Inference
Providers' OpenAI-compatible router at `https://router.huggingface.co/v1`) with
`maxDailyCostUsd` 10, and `fallbackModel` `omlx` / `Qwen3.8-27B-MLX-oQ4e-mtp` — so the team
spends up to $10/day on the API model and then keeps working locally for free until local
midnight. pi 0.84.2 ships a built-in `huggingface` provider whose catalog predates V4.1-Flash, so
`~/.pi/agent/models.json` (tumwater reads pi's files from `$PI_CODING_AGENT_DIR` when it is set, as pi does) adds just that model (declared at $0.30/$1.20 per million tokens — the
highest rate among the providers the router auto-selects as of 2026-09-18, so the cap trips no
later than real spend) and inherits the provider's base URL and env-based key. **The key is the
one thing not in any config file: export `HF_TOKEN` in the environment that runs `tumwater start`**
(`pi auth check --provider huggingface --json` reports `ready` once it is set). The two models'
context windows differ by an order of magnitude (1,048,576 vs 126,928); runs start a fresh pi
session with a small prefill, so a switch mid-day is safe, but a role prompt written for the API
model's window would not be.

**Local backend: oMLX (MLX), since 2026-09-14.** `/Applications/oMLX.app` 0.7.0.dev2 serves
`fcmeyer/Qwen3.8-27B-MLX-oQ4e-mtp` (API id `Qwen3.8-27B-MLX-oQ4e-mtp`) at `127.0.0.1:8000` — an
imatrix-calibrated ~4.9 bpw quant that preserves the model's native MTP head, so oMLX runs
Lightning MTP speculative decoding (2.5–3.0 tokens per backbone cycle at 68–84% draft acceptance;
the `lmstudio-community` checkpoints carry no MTP tensors, making `mtp_enabled` a no-op there).
oMLX config lives outside this repo in `~/.omlx/`: `model_settings.json` sets
`max_context_window` **131072**, pinned + default;
`settings.json` sets `max_concurrent_requests` **3**, `memory_guard_tier` aggressive,
`hot_cache_max_size` 4GB and an API key. pi (`$PI_CODING_AGENT_DIR` when that env var is set, else `~/.pi/agent/`) and omp
(`~/.omp/agent/models.yml` — YAML, not models.json) both use provider `omlx`,
`api: openai-completions`, `contextWindow` **126928** (a 4144-token margin under the server's
limit for pi's output reserve), and must send the API key. `tumwater.json`
names `provider`/`model` explicitly so `teamModelsFree()` sees a free team, with
`maxConcurrent` **3** — the three role instances alone saturate all three slots (at 2, one slot
sat idle whenever the director was not running, which is most of the time), and the
director's bypass makes a fourth client only while it is active (~10–15% of runs); the
fourth request queues rather than joins the batch (`max_num_seqs` stays 3), so MTP draft
acceptance is untouched, and its measured 103–118 s TTFT sits well inside pi's 30-min idle
timeout and tumwater's stall watchdog. Measured server-reported:
**35.2 tok/s per stream at ~51k context** (team paused); a slot sweep at ~20k context put 3 slots
ahead of 4 on every axis — 73.3 aggregate / 24.4 per stream / 74.2% draft acceptance / 28.3 GiB
peak wired, versus 65.0 / 16.2 / 69.7% / 32.6 GiB — because MTP acceptance falls monotonically with
concurrency (unaligned batches drop back to standard decode). Rate is strongly context-dependent,
so quote a context size with any tok/s figure.

Do not reach for the slot count to fix memory pressure: it was tried twice (6→4, then 4→3) and
moved nothing either time. At 3 slots the live footprint was pool ~57 GB / KV 10.8 GB / hot cache 0
/ model 16 GB — the pinned MLX buffer pool is ~60% of it and does not scale with concurrency.

A third deliberate value: `max_context_window` is **131072, not the model's 262144 maximum**. At the
full window oMLX aborted prefills outright — `Request aborted: process memory limit exceeded (usage
111.0 GB, abort threshold (hard watermark) 92.1 GB, metal_cap ceiling 96.9 GB)` — killing 9 runs,
three at a time, because `_get_dynamic_ceiling` is recomputed every poll and collapses when the rest
of the Mac is busy, taking the abort threshold down with it. Halving the window halves the
worst-case prefill transient and KV. Live runs peak around 64-80k, so 131072 still leaves ~1.6x
headroom. The companion fix is `memory_guard_tier: aggressive` (active-reclaim ratio 0.5 -> 0.8),
which holds the ceiling at the Metal cap instead of letting it collapse, plus `hot_cache_max_size`
4GB. **Slot count is not a lever here** — it was tried twice (6->4, 4->3) and moved nothing; the
pinned MLX pool is ~60% of the footprint and does not scale with concurrency.

Two oMLX settings are deliberately left at non-obvious values:
- `chunked_prefill` stays **false** (its default). Turning it on collapsed throughput ~20× here
  (16.4 → 0.8 tok/s, TTFT 118 s): the team's large prefills interleave continuously and starve
  decode.
- `prefill_memory_guard` is **on** (re-enabled 2026-09-14 with the 16 GB oQ4e model). It had been
  turned off under the earlier 8-bit model, where oMLX's pinned buffer pool
  (`mx.set_cache_limit(total_mem)`, issue #300 — otherwise `allocator::free()` can release a Metal
  buffer the GPU still holds and panic on M4) made the enforcer read the pinned pool as pressure:
  562 trips in 46 min, each forcing a synchronized `clear_cache()` that stalled every stream — a
  visible sawtooth in tok/s — while wired memory oscillated ~40 ↔ 107 GiB. With the 16 GB model the
  peak wired across the whole slot sweep was 49.7 GiB against the 96.8 GiB soft watermark, and the
  guard has logged 0 pressure trips in 30 min — the OOM safety net is back with no stalls.

The bullets below were written for the previous **LM Studio / GGUF** backend and are kept as
hard-won background; the llama.cpp-specific parts (unified KV, slot allocation, q8_0 flags) no
longer describe what runs.


- **LM Studio WARN flood** (`Reasoning setting 'high' is not supported by model '…'. Supported
  settings: 'on', 'off'. Falling back to reasoning setting 'on'.`): benign. pi requests its
  configured thinking level per turn; GGUF models that only expose an on/off reasoning toggle make
  LM Studio warn and fall back to `on`. Reasoning stays enabled; no tumwater or pi change needed.
  To silence it, set a thinking level the model supports (or none) in `tumwater.json` / pi settings.
- **"terminated" run errors after ~20 minutes**: pi's HTTP client (undici) applies an idle
  timeout (`httpIdleTimeoutMs` in pi's settings.json, default 300000 = 5 min) to both response
  headers and gaps between body chunks. A local server prefilling a large context under
  concurrent load can take longer than that to stream its first byte, so the request is severed
  ("terminated"), pi's retries die the same way, and the run fails after ~4 × 5 min. Fix: set
  a large-but-finite `"httpIdleTimeoutMs"` (e.g. `1800000` = 30 min) in
  pi's `settings.json` — `$PI_CODING_AGENT_DIR/settings.json` when that env var is set, else
  `~/.pi/agent/settings.json` —. Do not use `0` (fully disabled): a zombie socket then waits
  forever. tumwater's `quietTimeoutSeconds` stall watchdog (default 30 min; kills a run when no
  *progress* — message, turn, and tool boundary events, plus content-bearing streaming deltas —
  happens, so content-free keepalives cannot reset it) and `runTimeoutSeconds` remain the
  layered hang guards.
- **Context accounting**: declare an honest `contextWindow` for the model in pi's `models.json` —
  it is what triggers pi's auto-compaction. With LM Studio's unified KV cache, concurrent requests
  share one context pool (declare pool ÷ slots); with unified KV off, each slot owns the full
  window. A session that overruns the server's real limit fails with "Context size has been
  exceeded"; since every run starts a fresh session, the next run is unaffected.
- **Truncated-at-the-ceiling turns look like normal stops**: as a session nears the declared
  `contextWindow`, pi clamps each request's `max_output_tokens` to the space remaining (down
  to a floor of 16). LM Studio's `/v1/responses` reports a generation stopped by that clamp
  as status `completed` rather than `incomplete`/`max_output_tokens`, so pi sees stopReason
  "stop" instead of "length" and its compact-and-retry overflow handling never fires — the
  turn ends mid-thought with no text and no tool call, the agent finishes, and the run
  lands as `no_change` with a "finished without changes and without declaring nothing-to-do"
  warning (now annotated with "likely cut off at the context ceiling"). Prevention: tumwater
  starts every run in a fresh session, so runs begin with only the prompt (~8k tokens) and
  need ~75k of within-run growth to reach the cliff — several hours of dense work. Note that
  pi never compacts MID-run (only at end of run), so a single extremely long run can still
  hit the cliff; the run then ends with the warning above, any files pi already edited are
  still committed, and — when no changes landed — the role does not back off: its next
  run resumes the session pi just compacted at end of run (short bridge prompt, same task),
  effectively mid-task compaction at run granularity. After 3 consecutive cut-offs on one
  task it gives up and falls back to a fresh run with the usual wait; a cut-off director
  prompt is re-queued and reruns fresh.
- **Match clients to slots, or prefix caches thrash**: each server slot keeps the KV prefix of
  the last request it served. Keep the number of concurrent tumwater clients — `maxConcurrent`
  plus one for the director's bypass — at or below the server's slot count. One client over, and
  slots keep evicting each other's session prefixes: with persistent multi-10k-token sessions,
  nearly every turn re-prefills from scratch (minutes each), requests queue behind those
  prefills, and starved runs die as "no pi progress" watchdog kills even though the server is
  healthy. Symptom to look for: small-context requests timing out while the server log shows
  continuous back-to-back prompt processing. With per-provider caps
  (`maxConcurrentPerProvider`, plans/provider-concurrency.md) the rule is: cap the local
  provider at its slots minus one for the director, then raise `maxConcurrent`
  freely — the provider cap, not the team total, is what bounds that server.
- **A unified KV pool cannot exceed the model's training context; dedicated slots can grow per
  stream**: with unified KV on, llama.cpp treats the shared pool as the slot context and caps it at
  `n_ctx_train` — asking Qwen3.8-27B for 524288 logs "the slot context exceeds the training context
  of the model — capping" and comes up as 262144 — so per-stream headroom under unified KV is
  pool ÷ slots and can never grow past that. For a larger window per stream, turn unified KV
  **off** and set the context length per slot. Measured 2026-09-07 with 3 × 174080-token slots
  (~64 GB wired, ~110 KB of KV per token on this model): three concurrent streams interleave at
  8.3–8.4 tok/s each, aggregate 24.8 tok/s — identical to unified-on, and equal to a single
  stream's 24.2, because the GPU is the bottleneck either way. The strictly serial serving seen
  earlier under unified-off was memory pressure at 4 × 262144 slots (~115 GB), not the mode
  itself. At f16 three full 262144-token slots would need ~101 GB (86 GB of KV plus the weights) —
  the wedge zone — so the KV cache is stored at q8_0 instead (LM Studio's saved load config:
  `llm.load.llama.kCacheQuantizationType` /
  `vCacheQuantizationType` = q8_0 with flash attention on),
  which brings 3 × 262144 slots to ~62 GB wired with three streams still at 7.8–8.3 tok/s each.
  Historical LM Studio configuration (superseded by oMLX, above): unified KV off,
  context-length 262144 (the model's maximum),
  parallel 3, q8_0 K/V cache, pi `contextWindow` 258000 (a margin under the slot for pi's output
  reserve), `maxConcurrent` 2 (+ the director's bypass = 3 clients ≤ 3 slots). Keep the model's
  saved default in LM Studio identical to the live load: a just-in-time load after an idle unload
  otherwise reverts to whatever the default says.
- **KV memory with dedicated slots**: unified-off KV buffers are allocated per slot — at ~110 KB
  per token (f16; q8_0 halves it), 4 × 262144-token slots cost ~100 GB of KV on top of
  the weights (~115 GB total),
  which runs a 128 GB machine at the edge: heavy swapping, and the engine can wedge permanently
  in `PROCESSINGPROMPT` (predictions hang, API reports "Engine protocol predict request failed:
  fetch failed", `lms ps` shows a phantom prefill). Unified-on at the same pool is ~25 GB.
  Recover a wedged engine with `lms unload <model>` + `lms load <model> --context-length N
  --parallel K`.
