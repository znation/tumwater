# OpenCode backend — run model jobs on the OpenCode CLI (`opencode`) for its free DeepSeek model

Planned 2026-10-17 · requested by user · audited against main `740e2c56a` · researched from
source, docs and issues on 2026-10-17 (see "Sources") · verified live the same day on OpenCode
2.0.32 (hand step H1: "Findings, verified live"; raw captures in test/fixtures/opencode-captures/)

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
  - It needs no login. With no credential, `opencode models` lists only the gateway's $0 models
    (and `big-pickle`), and runs on them work (verified).
- **OpenCode Go ($10/month; Go Plus $40) is a different thing.**
  - Its `opencode-go/deepseek-v4.1-flash` (1M context) is paid inside Go: $0.15/$0.60 per M
    tokens off-peak, $0.30/$1.20 at peak. It also counts against Go's 5-hour, weekly and monthly
    allowances.
  - Go works with any agent. pi 1.2.0 already has an `opencode-go` provider, so
    `opencode-go/deepseek-v4.1-flash` with `OPENCODE_API_KEY` works today with no tumwater change.
    Go is not part of this plan.
- **Only OpenCode's own client may use the free tier.**
  - The gateway refuses other clients with a 403 `FreeTierError` ("OpenCode's free tier can only
    be used from within OpenCode"). OpenCode reports it as an error of type `provider.auth`.
  - It also refuses the real client when the request looks wrong. Verified live:
    - **denying the `read` tool outright** (denying `shell`, `glob`, `grep`, `edit`, `subagent`,
      `webfetch`, `websearch`, `question`, `skill`, `execute`, or only `*.env` reads, is fine);
    - **a session id that is not in OpenCode's own format**, 3 times out of 3.
- **The free tier is flaky.** On 2026-10-17 official 2.0.32 clients got the 403 as well, some
  depending on their network (issues 56426, 56397, 56398). It did not happen during the probe.
  Still, a free-tier refusal moves the job to its fallback (§6); it is never a config error that
  stops a role.

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
| V2 | Homebrew core `opencode` (2.0.32 on 2026-10-17); npm `@opencode/cli`; `anomalyco/tap/opencode-v2` | Maintained, released about daily. New tool names, permission format, config shape and server API |

**Target V2 only, at 2.0.32 or later,** the version H1 verified.

- It is the line that is maintained.
- `--session <id>` takes an id the caller chooses (in OpenCode's format, finding 3). That gives
  the same fresh/resume model as claude's `--session-id` / `--resume`, so the session ledger
  works unchanged.
- `--standalone` gives each run its own server process, with no shared background service.
- `opencode --version` prints `opencode v2.0.32`. Doctor fails a 1.x binary and names
  `brew install opencode`.

## Findings, verified live

These were checked on OpenCode 2.0.32 (Homebrew) on 2026-10-17, with no login, against
`opencode/deepseek-v4.1-flash-free`, in a throwaway git repo. Each raw stream is in
test/fixtures/opencode-captures/ (README.md there maps each file to its finding).

1. **Flags.** `opencode run [--standalone] [--format json] [--auto] [-m provider/model#variant]
   [-s <id>] [-c] [--fork] [--agent] [--title] [--thinking] [-f <file>] [--server <url>]
   [message...]`. V1's `--dir`, `--attach` and `--port` are gone. `--print-logs --log-level debug`
   writes server logs to stderr.
2. **Prompt on stdin works.** The runner writes the prompt and closes stdin; no message argument
   is needed.
3. **Session ids.**
   - `--session <id>` resumes that session, or **silently creates it** when the database has no
     session with that id. Resuming through the same database kept the context; the same id
     against another database started an empty session with no error.
   - A value that does not start with `ses` fails at once: an error event of type `unknown`,
     "Expected a string starting with "ses"", exit 1.
   - A `ses_…` value in any other shape is accepted locally but **refused by the free-tier gate**
     (403, 3 of 3).
   - An id minted exactly like OpenCode's own works: `ses_` + 12 hex digits + 14 base-62
     characters. The hex is the low 48 bits of the bitwise NOT of (Unix milliseconds × 4096 +
     a per-millisecond counter), as `descending()` in packages/schema/src/identifier.ts computes
     it.
4. **Session storage.**
   - The default store is `~/.local/share/opencode/opencode.db` (SQLite, WAL). `OPENCODE_DB` is
     honored.
   - **Every new database stores the 6.5 MB models.dev catalog** in its `kv` table (key
     `models-dev:catalog`). One database per session would cost about 6.7 MB a run, roughly 6 GB
     a day at the team's run rate. So the plan uses one database per team (§4).
   - Six concurrent runs on one database worked, with no locking errors.
   - `opencode session export <id> --standalone` takes 0.18 s. It returns `info` (`cost`,
     `tokens`, `model {id, providerID, variant}`, `outcome`, `title`, `location.directory`) and
     every message with its `finish`, `cost` and `tokens`.
5. **The JSON stream is lossy at both ends.**
   - Each line is `{type, timestamp, sessionID, part}`. The types are `step_start`, `text`,
     `tool_use`, `step_finish` and `error`.
   - `text` comes once per finished text part, and `tool_use` once per finished call; there is
     nothing while a tool runs.
   - **The last step's `step_finish` was missing in 41 of 49 successful runs,** and the first
     `step_start` in 5 of 49. No pattern explained which ones; resumed and fresh runs both lost
     it. So the stream alone usually undercounts usage and cost, by the whole final step.
   - The export (finding 4) has the complete numbers. It is the run's authoritative usage and
     cost source (§6).
6. **A hidden title call.** Without `--title`, OpenCode makes an extra model call to name the
   session. Its tokens appear in the export's session totals but in no message. `--title <name>`
   skips it: the session totals then equal the sum of the messages (verified).
7. **Tool calls.**
   - `part.id` is the call id, `part.partID` is the part id, and `part.tool` is the name.
   - `state` is `{status, input, output, title, metadata, time}`; an error has `error` instead of
     `output`.
   - Inputs: `read {path, offset?, limit?}` (**`path`, not `filePath`**),
     `edit {path, oldString, newString}`, `write`, `glob`, `grep`, and
     `shell {command, workdir?, timeout?, background?}`.
   - `state.metadata.metadata` carries `truncated` and, for shell, `exit`.
   - The calls of one step can run in parallel. They arrive in completion order, not call order.
8. **Errors** are `{type: "error", sessionID (may be ""), error: {type, message, status?,
   response?}}`, and the exit code is 1:

   | Case | `error.type` | Message |
   | --- | --- | --- |
   | free tier refused | `provider.auth`, `status: 403` | "OpenCode's free tier can only be used from within OpenCode…"; `response.body` names `FreeTierError` |
   | unknown model | `provider.no-route` | "Model unavailable: opencode/no-such-model" |
   | unknown variant | `provider.no-route` | "Variant unavailable for opencode/deepseek-v4.1-flash-free: medium" |
   | malformed session id | `unknown` | "Expected a string starting with "ses"" |
9. **Variants.**
   - The catalog lists the free model's variants as `reasoning_options: [{type: "effort",
     values: ["low", "high", "max"]}]`.
   - `#high` and `#low` work, and the export records `variant: "high"`. With no variant it reads
     `default`. `#medium` fails with `provider.no-route` (finding 8).
10. **The catalog.**
    - V2's `opencode models` prints ids only; there is no `--verbose`.
    - The data is models.dev's `https://models.dev/api.json`, which OpenCode caches in the
      database's `kv` table. `body[provider].models[id]` has `cost {input, output, cache_read}`,
      `limit {context, output}`, `modalities.input` and `reasoning_options`.
    - For the free model, models.dev serves cost 0/0/0, context 200000, output 32000, input text
      and image, and efforts low/high/max, matching OpenCode's cache.
11. **Permissions** are an ordered `permissions` list of `{action, resource, effect}`, where the
    last match wins. A denied tool disappears from the model's tool list. Which denials the gate
    tolerates is listed under "The free model and its catch".
12. **Code Mode.**
    - V2 also offers an `execute` tool, which reaches the other tools through JavaScript. MCP
      tools go through it by default (`codemode: true`).
    - In one run the model spent four steps inside `execute` searching for `shell` before it
      called `shell` directly. Calls made inside `execute` never appear as their own events, so
      suite-rerun detection could not see a test run made through it.
    - Denying `execute` is gate-safe and removed the detour (3 of 3 runs went straight to
      `shell`).
13. **Config keys (V2).**
    - `snapshots: false` (plural). Snapshots are on by default and record a git snapshot hash at
      each step.
    - `update: "disable"` (V1's `autoupdate`).
    - Formatters are opt-in (`formatter` is off unless set), and V2 runs no language servers at
      all, so neither needs a key.
    - `instructions: ["CLAUDE.md"]` works.
    - MCP servers go under `mcp.servers.<name>` with `type`, `command`, `environment`,
      `codemode`, and `disabled: true` to turn one off. V1's `mcp.<name>` / `enabled` shape is
      ignored.
    - `tool_output` defaults to 2000 lines / 51 200 bytes.
14. **Context files.**
    - V2 does not load `CLAUDE.md`. Asked for a codeword stated in one, the model had to find the
      file with glob and read. With `instructions: ["CLAUDE.md"]` it knew the codeword at once.
    - By default V2 loads the operator's Claude skills from `~/.claude/skills`. On this Mac those
      are eight synced claude.ai skills (docs, docx, pdf, …).
      `OPENCODE_DISABLE_CLAUDE_CODE=1` with `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` leaves only
      OpenCode's two built-ins.
15. **Environment switches.**
    - The 2.0.32 binary reads `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`,
      `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_FILEWATCHER`, `OPENCODE_DISABLE_MODELS_FETCH`,
      `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DB`, `OPENCODE_MODELS_PATH` / `_URL`,
      `OPENCODE_CONFIG` / `_CONTENT` / `_DIR` and `OPENCODE_CLIENT`.
    - It does **not** read `OPENCODE_PURE`, `OPENCODE_DISABLE_EXTERNAL_SKILLS`,
      `OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`, or any shell-timeout
      variable. Those came from V1.
16. **The shell tool.**
    - Its default timeout is a fixed 2 minutes (`DEFAULT_TIMEOUT_MS`). No environment variable
      changes it; the model can pass `timeout` in ms, where 0 means none. On a timeout the output
      ends "Command exceeded timeout of N ms. Retry with a larger timeout…".
    - Its children get `AGENT=1`, `OPENCODE=1`, `OPENCODE_TERMINAL=1` and `OPENCODE_SESSION_ID`.
      They keep any inherited `AI_AGENT`: spawned from Claude Code, it read `claude-code_…`.
    - They inherit `TUMWATER_RUN` and `OPENCODE_CONFIG_CONTENT`.
17. **Oversized output.**
    - Shell output keeps its **last** 2000 lines, not head and tail. It ends with
      "[showing lines 198001-200000 of 200000; full output saved to <data>/shell/<project>/sh_….out]",
      and `metadata.truncated` is true.
    - Those files, and the snapshots, live under `~/.local/share/opencode/{shell,snapshot}/<root
      commit of the repo>/`. So every worktree of one repo shares them, and nothing in
      `.tumwater/` prunes them.
18. **Background shell.** `background: true` returns at once ("Command moved to the background
    (shell ID: …)"). When the run ends the command is killed: a `sleep 15; echo … > file` never
    wrote its file. Permissions cannot deny it, because the shell permission's resource is the
    command text.
19. **Processes and signals.**
    - `opencode run --standalone` spawns `opencode serve --stdio --port 0` in **its own process
      group**, and each shell command gets yet another group.
    - SIGTERM to the run's group: exit 130 in 0.4 s, and no process carrying the run marker was
      left.
    - SIGKILL to the run's group: the serve child exits when its stdio closes and takes its
      children with it; nothing marked was left after 5 s.
    - A killed session resumes: its export `outcome` is null instead of `succeeded`, and the model
      knew its command had been interrupted.
    - (`ps -E` does not show the environment of macOS platform binaries such as `sleep`, so the
      probe used a `node` child. That limit was already known in src/process/run-marker.ts.)
20. **No `--standalone`, a lingering service.** `opencode mcp list` and `opencode debug config`
    without `--standalone` start a background service on `127.0.0.1:<port>` that keeps running
    (`opencode service stop` ends it). `debug config` rejects `--standalone`. tumwater must pass
    `--standalone` to every subcommand that takes it.
21. **MCP tools are missing from a run's first model request only** (upstream issues 51812 and
    56240, both open; a maintainer called the behavior intentional).
    - **Cause, in the 2.0.32 source:**
      - MCP servers connect in the background ("so one slow server does not block Location
        startup", packages/core/src/mcp/index.ts).
      - `MCP.tools()` returns only the servers already connected. It does not wait for pending
        ones; `callTool` does.
      - The tool registry is filled once at startup. A server that connects later publishes
        `ToolsChanged`, and the registry reloads after a 100 ms debounce
        (packages/core/src/tool/mcp.ts).
      - The tool list is rebuilt for every model request.
      - So a run's first request almost always goes out without MCP tools, and every later
        request has them.
    - **Measured** with a stdio test server that answers at once:
      - OpenCode listed its tools about 0.4 s after launch.
      - The model's first request still lacked them, 3 of 3.
      - After a first step of `sleep 3`, the second request had them, 3 of 3.
    - **The role-notes pattern works.** With tumwater's real role-notes server, a run that reads
      and runs a command and then saves a note before ending wrote its note 6 of 6 times
      (`tumwater_role_notes`, "notes saved").
    - **The earlier 5-of-6 miss was the worst case:** those probes asked for the note in the run's
      first step.
    - **Upstream workarounds, not used here:** hold the first prompt with a plugin until the
      registry has the tools, or start `opencode serve` ahead of time and use `run --server`.
      Both cost more than they save for a tool that is called at the end of a run.
22. **Concurrency and memory.**
    - Six concurrent multi-step runs all exited 0, in 10–20 s each, with no 429s.
    - Peak resident memory was 3.5 GB across the 12 processes (a run plus its serve child, about
      300 MB each, 450 MB at most).
    - Each run starts about eleven `git` processes for project detection, which is not free on
      this spawn-bound Mac (memory: suite speed).
23. **Speed.** A trivial run takes 3–10 s from start to exit, and the six-step edit-and-verify
    capture (edit-run.jsonl) took 6.7 s.

## Design

### 1. Groundwork: the claude-only branches become backend traits (landed: part 1/7)

The seam (src/agent/agent-backend.ts) covers the spawn, the stream and the exit. About a dozen
places outside it tested `agent === "claude"`. Most of them stand for a capability that OpenCode
either shares or lacks:

| Place | Was | Became |
| --- | --- | --- |
| src/config/config-schema.ts `AGENT_IDS` | `["pi", "claude"]` | gained `opencode` (part 2) |
| src/config/config-validation.ts, reserved passthrough flags | `id === "claude" ? … : id === "pi" ? …` | a table of reserved flags per backend |
| src/prompt/dialect.ts `dialectFor` | claude or pi | a table of dialects keyed by backend id |
| src/pi/pi-watchdogs.ts and src/ui/progress-data.ts, the stalled-tool rule | `agent === "claude"` → every call is judged by the buffered threshold | `streamsToolOutput(agent)`, true for pi only |
| src/pi/pi-models.ts `seamFree` / `piPairFree` | claude → the subscription rule; any other non-pi backend → never free | a free-ness rule per backend (§7) |
| src/doctor/doctor-model-checks.ts: `needsDefinitions`, the image rows, the fallback-chain probe's `isClaude` | "not claude" stood in for "needs pi's models.json" | "is pi" |
| src/agent/image-input.ts and the doctor labels | `agent === "claude" ? model : provider/model` | the backend's own label (`opencode/<model>`) |

- The traits that the config and UI layers read live in a pure module,
  src/agent/backend-traits.ts, keyed by backend id. Those layers never import the runtime
  registry.
- The claude-only machinery stays claude-only. None of the subscription window, the billing, the
  account file or `--max-budget-usd` applies to OpenCode.

### 2. Config and routing (landed: part 2/7)

- `opencode` is in `AGENT_IDS`.
  - `backend: "opencode"` makes bare model ids, and the default for a job with no model, run on
    OpenCode.
  - `backends.opencode.bin` / `.args` work like claude's; `TUMWATER_OPENCODE_BIN` comes with the
    adapter (part 5).
- **Model ids.** Everything after `opencode/` is passed to `--model`.
  - With no further `/`, it is a model on OpenCode's own gateway, whose OpenCode provider id is
    also `opencode`. So `opencode/deepseek-v4.1-flash-free` becomes
    `--model opencode/deepseek-v4.1-flash-free`: the tumwater id reads exactly like OpenCode's.
  - With one, it is any provider OpenCode knows: `opencode/anthropic/claude-sonnet-5-5` becomes
    `--model anthropic/claude-sonnet-5-5`.
  - A thinking suffix such as `:low` becomes `#<variant>` (§3).
- **This hides pi's built-in `opencode` provider** (the paid gateway through pi). From now on
  `opencode/…` always means the OpenCode CLI. pi's `opencode-go` provider is untouched.
- **No tier defaults.** With no `model`, OpenCode's own default runs. The free model is a
  time-limited promotion, so its id belongs in tumwater.json, not in code.
- **Reserved flags**, refused in `backends.opencode.args`: `HARNESS_OPENCODE_FLAGS` in
  src/agent/opencode/opencode-args.ts. Part 3 adds `--title`, which tumwater now sets
  (finding 6). Part 2's set also reserves V1-only names (`--dir`, `--attach` and others), which
  is harmless.
- **Concurrency and holds need nothing new.** `seamHoldKey` keys a non-pi backend by its id, so
  `maxConcurrentPerProvider: { "opencode": 3 }` caps OpenCode runs, and a provider-wide
  rate-limit hold on `opencode` stops only OpenCode jobs.
- A model job routed to a backend this build has no adapter for is a startup problem (part 2).
  It stays the rule for any future backend.

### 3. The invocation

```
opencode run --standalone --format json --auto
  --model <provider>/<model>[#<variant>]
  --session <id>                     # minted in OpenCode's format, or the ledger id being resumed (§4)
  --title <session name>             # skips the hidden title call (finding 6)
  <backends.opencode.args…>
  < prompt on stdin, closed
```

**Variant.** tumwater's thinking level becomes `#<level>` only when the catalog lists that
effort for the model (finding 9). Any other level is dropped, and doctor notes it. An unlisted
variant is a hard `provider.no-route` failure, so guessing is never safe.

**Config, through `OPENCODE_CONFIG_CONTENT`.** It applies after the operator's global and project
files; only managed config wins over it.

```jsonc
{
  "snapshots": false,          // no git snapshot per step (finding 13)
  "update": "disable",
  "permissions": [             // gate-safe denials only (finding 11)
    { "action": "execute",   "resource": "*", "effect": "deny" },   // Code Mode (finding 12)
    { "action": "subagent",  "resource": "*", "effect": "deny" },   // child sessions drop out of the stream
    { "action": "webfetch",  "resource": "*", "effect": "deny" },
    { "action": "websearch", "resource": "*", "effect": "deny" },
    { "action": "question",  "resource": "*", "effect": "deny" },   // nobody answers in a headless run
    { "action": "skill",     "resource": "*", "effect": "deny" }
  ],
  "instructions": ["CLAUDE.md"],   // only when the worktree has CLAUDE.md and no AGENTS.md (finding 14)
  "mcp": { "servers": {
    "tumwater": {                  // only when the run carries notes (§5)
      "type": "local",
      "command": ["<node running tumwater>", "<dist>/src/agent/mcp/role-notes-server.js"],
      "codemode": false,           // a direct tool: Code Mode (`execute`) is denied
      "environment": { "TUMWATER_NOTES_PATH": "<the role's notes file>" }
    },
    "<each operator server>": { "disabled": true }
  } }
}
```

- **Never deny `read`.** Denying it trips the free-tier gate (finding 11). `shell`, `glob`,
  `grep`, `edit` and `write` stay allowed for parity with pi.
- **The `tumwater` server name is ours.** An operator server of the same name is replaced by
  this entry rather than disabled: a later config replaces a server object whole.
- **No permission rule is needed for the notes tool.** `--auto` approves the default `ask`.

**Environment.** It is layered on `agentBaseEnv` (the run marker and the macOS preload), as
claude's is.

- **Removed:**
  - `OPENCODE` and every `OPENCODE_*` except `OPENCODE_API_KEY`. That covers `OPENCODE_CLIENT`,
    which must never reach a run from the operator's shell, and an inherited
    `OPENCODE_SESSION_ID` from a host OpenCode session.
  - `AI_AGENT`, so the shell tool sets its own (finding 16).
- **Set:**
  - `OPENCODE_DISABLE_CLAUDE_CODE=1`
  - `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`
  - `OPENCODE_DISABLE_AUTOUPDATE=1`
  - `OPENCODE_DISABLE_FILEWATCHER=1`
  - `OPENCODE_DB=<team database>` (§4)
  - `OPENCODE_CONFIG_CONTENT`
- **No shell-timeout variable exists** (finding 16). The dialect tells the model to pass
  `timeout` for the check (§5). A timed-out command reaches the model as a tool result that says
  so, not as a dead run.
- **Not set: `XDG_CONFIG_HOME` and its siblings.**
  - Pointing them at an empty dir would isolate OpenCode completely.
  - But the shell tool's children inherit them: `git` would stop reading `~/.config/git/config`,
    and commits could lose their author identity.
  - Doctor reports what still leaks in instead (§7).

### 4. Sessions

- **One database per team root: `OPENCODE_DB=.tumwater/opencode/opencode.db`.**
  - Per-session databases would store the 6.5 MB catalog every run (finding 4).
  - One shared file keeps the operator's `~/.local/share/opencode/opencode.db` free of team
    sessions, and six concurrent runs on one file worked.
- **Fresh run:** mint the id with OpenCode's algorithm (finding 3), in
  src/agent/opencode/opencode-session-id.ts. Append the ledger record
  `{agent: "opencode", id, kind, cwd, …}` before spawning, as claude does.
  - A malformed id gets the free-tier 403, so test the minting against the captured real ids.
- **Continue:** use the newest ledger record of this run's kind, if it is OpenCode's and has this
  cwd, and `opencode session export <id> --standalone` (same `OPENCODE_DB`, bounded at 10 s)
  finds it.
  - `--session` silently creates a missing session, so this existence check is mandatory.
    Without it, a SUMMARY follow-up would run against an empty session.
  - Anything else is not resumable, and the existing `handoff` path takes over: a fresh session,
    the worktree kept, and a bridge prompt.
- **Retention.** The existing session pruning (`sessionRetentionDays`) also deletes the ledger's
  expired OpenCode sessions, with one `opencode session delete <id> --standalone` each.
  - OpenCode's shell spill files and snapshots under `~/.local/share/opencode/{shell,snapshot}/`
    are outside `.tumwater/` (finding 17).
  - With snapshots off, only spill files accumulate. Doctor reports their size, and the same
    pruning deletes spill files older than the retention window.
- **Across backends:** a fallback from OpenCode to pi, or back, is already a `handoff`
  (src/tick/tick-resume.ts). Unchanged.

### 5. The prompt dialect and role notes

- The canonical stream maps tool names (§6), so the prompts' shell-command wording stays.
- **Superseded 2026-10-17 by plans/notes-command.md:** every backend, OpenCode included, is moving
  to one `tumwater-notes` shell command ("Notes command, part i/4" in PLANS.md). Once its part 2
  lands, OpenCode runs carry no notes MCP server, and its part 3 deletes the MCP notes code below.
  The rest of this section records the MCP path as it landed in part 5b.
- **Notes ride the role-notes MCP server, as on claude** (the `mcp.servers.tumwater` entry in
  §3). The tool is `tumwater_role_notes`.
  - **The first-request gap is harmless here.** A run's first model request lacks MCP tools
    (finding 21), but the notes instruction asks for the note "before you end". By then the run
    has taken several steps and the tool is listed: 6 of 6 end-of-run notes were saved.
  - **What loses its note:** a run that ends after a single model request, such as a role that
    finds nothing to do and stops at once. It has little to note anyway. A call in that first
    request is refused (issue 56240 quotes "No tool named … is currently available"), and the
    run goes on without its note.
  - **No prompt text mentions the gap.** The models probed never stumbled on the tool missing
    from their first request.
  - **The smoke check tests the real pattern:** a multi-step run that saves a note at the end
    (part 7).
- **The `OPENCODE_DIALECT`:**
  - `notesTool`: `tumwater_role_notes`.
  - `readRange`: "the read tool's offset/limit (or `sed -n 'A,Bp'`)".
  - `oversizedOutput`: "Oversized shell output keeps only its last lines, followed by a note
    naming the file with the full output — read that file in ranges (the read tool's
    offset/limit) instead of re-running the command." (finding 17)
  - `backendRules`:
    - "Shell commands time out after 2 minutes unless you pass `timeout` in milliseconds; give
      the project's check a timeout that covers it (for example 900000)." (finding 16)
    - "Run every shell command in the foreground: never set `background`, because a background
      command is killed when your run ends." (finding 18)

  Sub-agents need no rule, since `subagent` is denied.

### 6. The stream translator, and the export that completes it

| OpenCode event | Canonical event |
| --- | --- |
| first event with a non-empty `sessionID` | `session` (`id`, `cwd`), then `agent_start` |
| `step_start` | opens a message buffer; a `text` or `tool_use` with no buffer open opens one too (finding 5) |
| `text` | a `text` block |
| `tool_use` | a `toolCall` block, with its result queued |
| `step_finish` | **one** `message_end` with the buffered blocks and the step's usage and cost, then a `tool_execution_start` and `tool_execution_end` for each queued call |
| error | a final `message_end` with `stopReason: "error"`, `errorMessage` and `tumwaterKind` (below) |
| stream end with a buffer still open | `finalize()` flushes it as a `message_end` without usage |

- **The `toolCall` block:**
  - `id` = `part.id`.
  - The name is mapped: `shell`→`bash`, `patch`→`edit`, others kept in lower case.
  - `arguments` = `state.input`. V2 already uses `path` (finding 7).
  - The queued `tool_execution_end` has `isError` = `status === "error"`.
- **Usage:** `input`, `output`, `cacheRead` = cache.read, `cacheWrite` = cache.write, and
  `totalTokens` = their sum. `cost.total` = `part.cost`.
- **Order.** Emitting the calls after their message keeps pi's order, which every reader of the
  raw log assumes.
- **No open calls.** OpenCode reports a call only once it has ended, so the stalled-tool warning
  never fires for it. The guards are the quiet watchdog and the shell timeout.

**The export completes the stream.** The final step's usage and cost never reach the stream
(finding 5), so after the process exits the adapter runs
`opencode session export <id> --standalone` (0.18 s, same env), through a new optional seam hook,
`AgentBackend.afterRun`. It emits two canonical lines that PiStreamParser treats as authoritative,
the way claude's `run_cost` already is:

- `run_cost {total}` from `info.cost`;
- a new `run_usage {input, output, cacheRead, cacheWrite}` from `info.tokens`. It replaces the
  per-message token sums, as `run_cost` replaces the cost sum.

The final message's text reached the stream in all 49 completed runs, and matched the export's in
the two checked, so `finalText` needs no export.
If the export fails, the run keeps its streamed numbers, and the translator reports
`opencode_usage_partial` once.

**Error classification**, from `error.type` first and the message second (finding 8):

| OpenCode signal | Result |
| --- | --- |
| `provider.auth` with status 403, or `FreeTierError` | `transientBackend` (kind `server`), plus one `opencode_free_tier_refused` warning per run. Three in a row move the tier to its fallback through the existing model-failure episode |
| 429 / rate limit | `transientRateLimit`, with `retryAfterSeconds` when given |
| 5xx, connection, timeout | `transientBackend` of that kind |
| `provider.no-route` (unknown model or variant), 401 | `configError` |
| `unknown` "Expected a string starting with "ses"" | `configError`; it would be a tumwater bug |
| context overflow that compaction could not fix | `contextExceeded` |
| exit 1 with no error event | the stderr classification in `classifyExit` |

### 7. Spend, free-ness, image input and doctor

**Spend.**

- Every OpenCode run's cost counts as real spend toward the daily cap. The cost is the export's
  `info.cost`, or the streamed step sum when the export fails.
- A free model reports $0, so it never moves the cap. If the promotion ends and the model starts
  reporting a price, that spend counts at once, with no code change.
- Go models report list prices, which overstate what a Go subscription really charges. That errs
  on the safe side.

**Free-ness** (`seamFree`).

- An OpenCode job is free when the catalog prices its model at zero, and no run on that model has
  reported a nonzero cost.
- **The catalog is models.dev's `api.json`**, the data OpenCode itself caches (finding 10).
  tumwater fetches it at most once a day, bounded at 30 s, into
  `.tumwater/state/opencode-models.json`, keeping only the providers its config routes to
  OpenCode. It records the fetch time and the CLI version.
  - It also passes that file as `OPENCODE_MODELS_PATH`, if H2 confirms OpenCode then skips its own
    fetch. tumwater and OpenCode would then price from the same file.
- A run that reports a cost on a model the cache calls free marks that model priced in the cache,
  and logs `opencode_free_model_billed` once.
- Consequences, the same as for a free local model:
  - With every job on the free model, the badge reads "budget n/a".
  - A free OpenCode model is a valid budget `fallback` step for a priced primary.
  - At the cap, a free OpenCode job keeps running instead of moving to its fallback.

**Image input** comes from the catalog's `modalities.input` (text and image for the free model),
through the backend's `imageInput` hook.

**Doctor**, for each backend in use:

- `opencode --version` is V2, at least 2.0.32. A 1.x version fails with
  `brew install opencode`.
- Each OpenCode model is in the catalog. Doctor shows "free" or its per-M prices, the context
  window, and any thinking level the model has no effort for.
- A model on a provider other than the gateway (`opencode/anthropic/…`) has a credential
  (`opencode auth list --format json`).
- The operator's global opencode config (`~/.config/opencode/{config.json,opencode.json,
  opencode.jsonc}`) or `~/.config/opencode/AGENTS.md`: any MCP server (disabled for team runs),
  plugin, agent or instructions entry produces a warning naming what still leaks in.
- A running background OpenCode service (`opencode service status`) is noted, since it is not the
  team's (finding 20).
- Sizes: `.tumwater/opencode/opencode.db`, and the shell spill dir for this repo's root commit.

**Startup gate.** It already checks the binary of every backend in use. It also seeds the
catalog cache.

### 8. Every model job, checked

Only what differs from plans/agent-backends.md §10:

| Model job | What changes |
| --- | --- |
| Author runs (all roles), director, qa | nothing: they go through runAgent. Notes ride the MCP server and are available from a run's second model request on (§5) |
| SUMMARY / stage-fix follow-ups | `--session <ledger id>`, after the existence check (§4) |
| Reviewer | suite-rerun detection reads `bash` calls, and the `shell`→`bash` mapping keeps it working. Code Mode, which would hide them, is denied |
| Budget handback, model fallback | `handoff`, unchanged |
| Fallback chain (plans/fallback-chain.md) | a free OpenCode step is "available when its breaker is serving", the free-pi row |

### 9. Small-window parity with pi (added 2026-10-17)

pi runs got small-window measures on 2026-10-17:

- strip-thinking (5c519508f): no earlier thinking is sent back at a window of at most 256k.
- Window-scaled tool-output caps and context-shake (b2720875c).
- A compact run prompt plus a trimmed pi system prompt at a window of at most 128k (b1eb00a91).

Most of these are pi extensions, and OpenCode has no equivalent hook that this plan uses. The free
model's window is 200K, so the compact prompt would not apply to it anyway. Four items carry
over:

1. **The compact rules carry OpenCode's backend rules. Done in part 5/7.**
   - `compactRules` in src/prompt/prompt.ts renders the dialect's `backendRules`, as the full
     rules do.
   - A test pins each OpenCode backend rule in the compact prompt, beside the full prompt's
     directive check in test/compact-prompt.test.ts (added by hand 2026-10-17).
   - A rule added to `commonRules` later goes in `compactRules` too.
2. **OpenCode's tool output is capped at pi's limits (part 6f).**
   - OpenCode's `tool_output` default is 2,000 lines / 51,200 bytes (finding 13), about three
     times pi's tuned 16,000-character bash cap. Every turn re-sends what a tool returned, and
     the 200K window compacts sooner than the 1M one it replaces.
   - The key is `tool_output: { max_lines, max_bytes }` ("Tool output truncation thresholds").
     This was checked in the 2.0.32 binary, where it bounds two things:
     - the shell tool's cut, which keeps the tail;
     - the `@opencode/ToolOutput` service, which cuts any other tool result that did not cut
       itself (read, grep, glob), keeps the head, and saves the full text to a file.
   - The injected config sets:
     - `max_bytes`: `outputLimits(window).bash` from src/pi-extension/bounded-output.ts, which is
       16,000 at 128k and above and scales down below that.
     - `max_lines`: `max_bytes / 40`, the ~40 characters a line that pi's "12k chars ≈ 300 lines"
       read cap implies.
   - The window comes from item 3. An unknown window keeps the 128k values.
   - OpenCode keeps the **last** lines of shell output, not head and tail (finding 17). The
     dialect already tells the model to read the spill file in ranges.
3. **The catalog's context window reaches the window lookup (part 6e).**
   - `seamContextWindow` in src/pi/pi-models.ts returns null for any non-pi seam today.
   - For an `opencode` seam it reads the model's `context` from the catalog cache (part 6a's
     `limit.context`, through `readOpencodeCache` and `opencodeModelKey`).
   - Then the compact prompt, and any later window-keyed rule, applies to an OpenCode model of
     128k or less with no further change.
   - The free model is 200K, so nothing changes for it today.
4. **Measure before building anything bigger (hand step H3).** After the team's first day on
   OpenCode, read from the session exports:
   - whether OpenCode sends DeepSeek's earlier thinking back. On pi via deepinfra it does: about
     a fifth of peak context. Fit prompt growth against tool output and reasoning-part sizes,
     the method behind 5c519508f.
   - how many runs compact, and at what context.
   - how large tool results are under the item-2 caps.

   Only if old thinking is a large share and compaction is common does an OpenCode equivalent of
   strip-thinking earn a plan. That would be a plugin, which this plan otherwise treats as a leak.
   OpenCode's `compaction: { auto, keep: { tokens }, buffer }` settings (in the 2.0.32 binary) are
   the cheaper lever to try first.

## Rollout

- **The config is the one under "Goal".**
  - One model for all three tiers. Today's strong tier is already V4.1 Flash, and the default
    tier moves up from V4-Flash-0731.
  - `maxConcurrentPerProvider.opencode` starts at 3. Six concurrent runs showed no 429s
    (finding 22), but that was one short burst. Raise the cap once a day of team runs shows 429s
    are rare.
- **Memory.** Each OpenCode run holds about 600 MB (a run process and its serve child). Three
  concurrent runs add about 2 GB.
- **Watch the smaller window.** It is 200K, against the Hugging Face model's 1M. A 2026-10-17
  measurement found 34% of runs past 64K, so a long tail of runs will compact. Watch the
  `compacted` counts and the context-exceeded failures on the first day. Parts 6e and 6f cap tool
  output at pi's limits first (§9), and hand step H3 measures what is left.
- **Spend on the fallback** is the measure of how often the free tier refused: `tumwater report`
  "Cost by provider".

## Hand steps

- **H1: live probe — done 2026-10-17** on OpenCode 2.0.32 (the findings above).
  - The captures are in test/fixtures/opencode-captures/.
  - Not covered: rate limits over a whole day of team load, a compaction on a real 200K session,
    and V1 (out of scope).
  - **A follow-up probe** the same day traced the MCP gap to its cause and measured the
    end-of-run notes pattern (finding 21). Its captures are mcp-first-request-no-tool.jsonl,
    mcp-tool-from-second-request.jsonl and mcp-notes-end-of-run.jsonl in
    test/fixtures/opencode-captures/.
- **H2: switch the team, after part 7.**
  - Run `npm run smoke:opencode`.
  - Check whether `OPENCODE_MODELS_PATH` makes OpenCode skip its own catalog fetch (§7).
  - Then edit tumwater.json (the untracked live file in the primary checkout) as shown under
    "Goal".
- **H3: measure the window, after a day on OpenCode** (§9 item 4).
  - From the session exports: the share of each run's context that is replayed thinking, how
    many runs compact and at what context, and tool result sizes.
  - Decide from those numbers whether an OpenCode strip-thinking plugin or `compaction` tuning
    is worth a plan.

## Parts (PLANS.md "OpenCode backend, part i/7")

1. Backend traits: the claude-only branches become per-backend traits. **Landed.**
2. The `opencode` backend id, model-id routing, and `backends.opencode` with its reserved flags.
   **Landed.**
3. The OpenCode invocation and environment: pure argv, config and env builders, and the
   session-id minter. **Landed** (with no notes server: it was planned before finding 21 was
   corrected).
4. The stream translator, the export reconciliation and the `run_usage` event, with fixtures from
   the H1 captures. **Landed.**
5. The adapter, sessions, the `afterRun` hook, registration, the PATH fake and the dialect.
   Requires parts 3 and 4. It was in progress when notes were turned back on, so its entry still
   says notes are off.
   - **Part 5b:** role notes on OpenCode — the `mcp.servers.tumwater` entry, the adapter passing
     it, and the dialect's notes tool. Requires part 5. **Landed;** to be replaced by the
     `tumwater-notes` command (plans/notes-command.md).
6. Free-ness, the catalog cache and spend. **Split 2026-10-17 into parts 6a–6d:**
   - **6a:** the models.dev catalog fetch, parse and cache. Requires part 5b.
   - **6b:** a free OpenCode model counts as free to the budget gate, the fallback view and the
     status badge. Requires part 6a.
   - **6c:** an observed price on a catalog-free model demotes it to priced and logs an event.
     Requires part 6a.
   - **6d:** thinking variants and image input from the catalog. Requires part 6a.
   - **6e** (added 2026-10-17, §9): the catalog's context window reaches `seamContextWindow`.
     Requires part 6a.
   - **6f** (added 2026-10-17, §9): the injected config caps `tool_output` at pi's
     window-scaled limits. Requires part 6e.
7. Doctor, docs and the `smoke:opencode` live check, including an end-of-run note. Requires
   parts 6b–6d.

## Decisions (proposed 2026-10-17; confirm or change)

1. **V2 only**, at 2.0.32 or later. V1 is maintenance-only and has the git-repo hang.
2. **The `opencode/` prefix belongs to the OpenCode CLI.** This hides pi's built-in `opencode`
   provider. pi's `opencode-go` stays reachable.
3. **No tier defaults.** The promotional model id lives in tumwater.json.
4. **A free-tier 403 is a provider failure** that moves the job to its fallback, never a config
   error.
5. **No XDG redirection,** so the shell's `git` keeps the operator's identity. Doctor reports what
   leaks in.
6. **Every cost OpenCode reports is real spend.** The export is the source. Free-ness comes from
   the catalog, overridden by any observed cost.
7. **No impersonation:** pi never sends OpenCode's client identity, and tumwater never sets
   `OPENCODE_CLIENT`.
8. **Role notes ride the MCP server on OpenCode,** as on claude (decided 2026-10-17, reversing the
   earlier "no notes" call). Notes are written at a run's end, after OpenCode's first-request MCP
   gap has passed (finding 21). **Superseded the same day:** all backends move to the
   `tumwater-notes` command (plans/notes-command.md decision 2), which needs no MCP at all.
9. **One OpenCode database per team root,** not per session (finding 4).

## Risks

- **The promotion ends.** It is "for a limited time", and DeepSeek's zero-retention agreement
  runs through 2026-10-31 and is renewed monthly.
  - If the id disappears, runs fail with `provider.no-route`, a config error that doctor names.
    The fix is one line in tumwater.json.
  - If the model gets a price instead, the observed-cost rule (§7) makes it priced at once.
- **The gate gets stricter.** OpenCode already checks the session-id shape and the tool set
  (findings 3 and 11), and may check more. The team then falls back to the paid step, and spends
  at most its cap.
  - The smoke check runs the exact production invocation, so it shows a new refusal before the
    team does.
- **Terms.**
  - The terms of service (2026-08-15) ban programmatic extraction of output, and using several
    accounts to get around limits. They have no clause that limits use to a harness.
  - `opencode run --format json` is a documented headless mode of the official CLI.
  - Whether a whole automated team fits "programmatic extraction" is for you to judge from the
    terms. This plan does not settle it.
- **CLI drift.**
  - V2 ships about daily, and its stream has no schema version.
  - 2.0.32 already differs from the V2 docs in places (findings 1, 7 and 15 corrected the
    research).
  - The translator warns on unknown types, doctor enforces a minimum version, runs disable
    auto-update, and the smoke check is the re-verification.
- **The MCP gap could widen.** Upstream may change how and when MCP tools register, in either
  direction. The smoke check's end-of-run note is the guard.
  - The same upstream issue (56240) reports `opencode run` hanging forever after a session error
    ("Failed to drain Session"), with or without MCP. The quiet watchdog bounds that hang.
- **A lossy stream.** The stream drops the final step's usage (finding 5). The export fixes the
  numbers after the run, but live progress (tokens so far) undercounts by the step in flight.
- **A smaller window.** 200K against 1M means more compaction, and its quality is OpenCode's.
  Parts 6e and 6f bring OpenCode's tool output down to pi's caps; hand step H3 decides whether
  more is needed (§9).
- **Disk outside `.tumwater/`.** Shell spill files accumulate under
  `~/.local/share/opencode/shell/` (finding 17) until pruning deletes them (§4).
- **Load.** About 600 MB and eleven `git` spawns per run (finding 22).

## Sources (2026-10-17)

- Live captures: test/fixtures/opencode-captures/ (OpenCode 2.0.32, Homebrew)
- Free model and Console: https://opencode.ai/v2/docs/console/models, https://models.dev/api.json
- Go: https://opencode.ai/docs/go/
- Gateway prices: https://opencode.ai/docs/zen/
- CLI, config and permissions: https://opencode.ai/v2/docs/ (config, permissions, tools,
  mcp-servers, migrate-v1), https://opencode.ai/docs/cli/
- V2 source: https://github.com/anomalyco/opencode/tree/v2.0.32 (packages/cli/src/commands/commands.ts,
  packages/cli/src/run/noninteractive.ts, packages/cli/src/session-target.ts,
  packages/core/src/tool/plugin/shell.ts, packages/schema/src/identifier.ts)
- V1 source: https://github.com/anomalyco/opencode/tree/v1.19.3 (packages/opencode/src/cli/cmd/run.ts,
  packages/opencode/src/config/config.ts, packages/core/src/database/database.ts)
- Free-tier gate: issues 49580, 49756, 51315; the 2026-10-17 403 wave: 56397, 56398, 56426
- Hangs and MCP: issues 42064, 47709, 51812, 52938, 55037, 56240
- pi 1.2.0's opencode providers: `@earendil-works/pi-coding-agent` dist/core/provider-attribution.js
  and its bundled model catalog
