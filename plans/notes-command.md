# Notes command — one `tumwater-notes` command for every backend, and funes kept out of team runs

Planned 2026-10-17 · requested by user · audited against main `7d8c5bfc7`

## Goal

Every role keeps notes: a short note its own earlier runs left for the next one
(`.tumwater/state/notes/<role>.md`, at most 4 KB, shown in each prompt). Today three different
carriers let a run write that note, one per backend. This plan replaces all three with one shell
command that every backend can run, and makes sure funes, which you use for your own sessions,
never runs in or indexes the team.

```bash
tumwater-notes write <<'TUMWATER_NOTES'
Rotation next: init. Ruled out: …
TUMWATER_NOTES
```

## Why

### Three carriers for one 4 KB file

| Backend | Carrier today | Where |
| --- | --- | --- |
| pi | the `role_notes` tool from a bundled pi extension | the bundled role-notes pi extension, loaded by src/pi/pi-args.ts |
| Claude Code | the `mcp__tumwater__role_notes` tool from tumwater's stdio MCP server | the role-notes MCP server, attached by src/agent/claude/claude-backend.ts (`--mcp-config`) |
| OpenCode | `tumwater_role_notes` from the same MCP server (OpenCode part 5b/7) | src/agent/opencode/opencode-config.ts (`mcp.servers.tumwater`) |

- All three share one validator and writer (src/agent/role-notes-write.ts).
- Each needs its own registration code, its own tool name in the prompt (`notesTool` in
  src/prompt/dialect.ts), and its own tests.
- MCP has its own failure mode: OpenCode lists no MCP tools in a run's first model request
  (plans/opencode-backend.md finding 21). End-of-run notes work there only because they come
  late.

### Every backend has a shell

- pi, Claude Code and OpenCode all give the model a shell, and every role already runs the
  project's check through it.
- A command on the run's PATH works the same way on all three. A future backend gets notes for
  free.
- It also cannot hit the MCP first-request gap.

### A command, not a skill

- **Skills load long instructions on demand.** The notes instruction is three lines that every
  run needs, and tumwater's own prompt already carries it on every backend
  (`roleNotesInstruction`, src/prompt/prompt.ts). That instruction *is* the skill.
- **Team runs switch skill loading off on purpose,** so your personal skills never reach the team:
  - Claude Code runs pass `--disable-slash-commands`. A live run's init event lists no skills.
  - OpenCode runs deny the `skill` permission and set `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`.
    Without that, OpenCode loaded eight of your synced claude.ai skills (plans/opencode-backend.md
    finding 14).
  - A notes skill would mean re-opening skill loading on every backend, the leak path this
    isolation closes.

### A narrow command, not the whole CLI

`tumwater` is not on a run's PATH today; the team runs it through `node scripts/tumwater.mjs`. Putting the whole CLI on PATH would hand every role
`tumwater config set`, `plan --cancel` and `start`. A separate `tumwater-notes` entry point can only
read and write the run's own note.

### funes and the team

funes (github.com/huggingface/funes) indexes agent transcripts so an agent can recall them. You use
it for your own sessions. Checked 2026-10-17 (funes 1.3.2):

- **Team runs don't load it.**
  - Claude Code runs list no MCP servers, no skills and only Claude's built-in plugins.
  - pi has no funes integration and no packages installed (`pi list`).
  - OpenCode runs disable every operator MCP server.
- **But it reaches the team from outside.** funes's Claude Code hook indexes every changed session
  under `~/.claude/projects`, and that includes the team's Claude Code runs.
  - 1,599 of the 2,698 sessions in your personal funes memory (59%) are team runs.
  - funes has no option to exclude a path.
- **And it could get in.**
  - **pi:** team runs load anything pi discovers: installed pi packages, `~/.pi/agent/extensions`,
    and pi's built-in `mcp` extension, which reads `~/.pi/agent/mcp.json`. tumwater does not pass
    `--no-extensions`. A `funes add pi`, or a funes entry in `mcp.json`, would put funes in every
    team pi run.
  - **OpenCode:** funes's community OpenCode integrations install as OpenCode plugins. The
    injected config cannot remove a plugin entry the operator's global config adds; doctor can
    only warn about it (OpenCode part 7/7).
- **Does the team need funes, given notes?** Nothing shows it does.
  - Notes carry the working state a role needs: stop states, rotation pointers, "ruled out"
    lists, resume points.
  - Four team-style recall queries mostly returned either your own development sessions or stale
    copies of the notes themselves, from prompts funes had indexed.
  - The team's history already has its own tools: events.jsonl, `tumwater history`,
    `tumwater logs`, `tumwater report`, and the run transcripts.

## Design

### 1. The `tumwater-notes` command

A second bin entry, `tumwater-notes` → `dist/src/notes-cli.js` (src/notes-cli.ts,
`// vocabulary: plain`). It acts only on the note named by `TUMWATER_NOTES_PATH`, which every run
that carries notes already has in its env (pi-backend.ts `withNotesPath`, claude-backend.ts,
opencode-backend.ts).

| Usage | Does |
| --- | --- |
| `tumwater-notes write` | replaces the note with stdin |
| `tumwater-notes write --file <path>` | replaces the note with that file |
| `tumwater-notes show` | prints the current note (empty output for none) |
| `tumwater-notes clear` | empties the note |

- **Validation:** the same 4 KB cap and atomic write as today, through `validateRoleNote` /
  `writeRoleNote`.
  - Success prints `notes saved (<n> bytes)` or `notes cleared`, and exits 0.
  - Failure prints the reason to stderr and exits 1.
- **`write` refuses empty input** ("nothing to write — use `tumwater-notes clear` to empty the
  note"). A heredoc that lost its body must not wipe the note.
- **No `TUMWATER_NOTES_PATH`:** "this run keeps no notes" (the director, a reviewer run), exit 1.
- **Exit 2 with usage** for anything else.
- **It never reads or writes any other path.** The path comes from the env tumwater set, not from
  an argument.
- The operator-facing commands are unchanged: `tumwater role <id> --notes-file` /
  `--clear-notes`, the dashboard's notes editor, and the TUI's notes view.

### 2. Reaching it from a run

- **The shim.** tumwater writes `<tumwater dir>/bin/tumwater-notes`, a two-line `sh` script:
  ```sh
  #!/bin/sh
  exec "<process.execPath>" "<dist>/src/notes-cli.js" "$@"
  ```
  - `<dist>` is resolved from the running module, as pi-args.ts resolves the bundled extensions,
    so a staged build (`.tumwater/build/<sha>`) points at its own copy.
  - It is rewritten atomically (and `chmod 755`) whenever its content differs, so a redeploy
    re-points it.
- **PATH.** `agentBaseEnv` (src/process/run-marker.ts), which every backend's env starts from,
  prepends `<tumwater dir>/bin` to `PATH`. Every run gets it; one without notes gets the clear
  refusal.
- **Some shells may rebuild PATH.** Claude Code's Bash tool sources a snapshot of the user's shell
  setup, and a login shell runs the profile. A profile that assigns `PATH` outright, rather than
  extending it, would drop the shim dir.
  - The smoke checks run the command on each backend (part 2).
  - If a backend loses it, its prompt can name the shim's absolute path instead. That is a
    one-line change in that backend's prompt text.

### 3. One prompt instruction

`roleNotesInstruction` stops taking a tool name from the dialect. Every backend gets:

> Before you end, if you learned something the next run of your role should know (where things
> live, what you ruled out and why, what you would look at next), save the full replacement note
> (at most 4 KB) by running:
>
> ```
> tumwater-notes write <<'TUMWATER_NOTES'
> <the note>
> TUMWATER_NOTES
> ```
>
> Do not copy backlog entries into it — PLANS.md and BUGS.md hold the work itself.

- The quoted, unusual delimiter keeps `$` and backticks literal, and survives a note that contains
  `EOF`.
- The note block a run sees (`roleNotesBlock`) is unchanged.
- The director still has no notes.

### 4. Retiring the old carriers

Once every backend's prompt uses the command (part 2), remove:

- the bundled role-notes pi extension, and its entry in `bundledExtensionPaths`;
- the role-notes MCP server, and claude-backend.ts's `roleNotesMcpConfig` /
  `--mcp-config` for notes. `--strict-mcp-config` stays, so no MCP server reaches a Claude Code
  run, and `--mcp-config` stays reserved in `HARNESS_CLAUDE_FLAGS`;
- opencode-config.ts's `notesServer` and its `mcp.servers.tumwater` entry. Disabling the
  operator's servers stays;
- `PromptDialect.notesTool`, and the tool-schema constants in role-notes-write.ts
  (`ROLE_NOTES_PARAMETERS`, `ROLE_NOTES_DESCRIPTION`). `saveRoleNote`'s "role_notes requires…"
  wording becomes command-neutral;
- their tests: the role-notes extension test (the pi extension half) and the role-notes MCP-server test.

Docs to update:

- docs/how-it-works.md says notes are written "with the bundled `role_notes` tool";
- docs/backends.md's OpenCode section says notes ride the MCP server;
- scripts/smoke-opencode.mjs's notes check comment (all from OpenCode part 7/7).

### 5. Keeping funes out of team runs

- **pi: no discovered extensions.**
  - pi-args.ts adds `--no-extensions`, then `-e builtin:llama.cpp -e builtin:codemode
    -e builtin:tool-search`. Those are pi 1.2.0's built-ins other than `mcp`, kept so behavior is
    otherwise unchanged. tumwater's own `-e` extensions still load.
  - Dropped:
    - installed pi packages;
    - auto-discovered `~/.pi/agent/extensions`, and a target repo's `.pi/extensions`;
    - pi's built-in MCP extension (`~/.pi/agent/mcp.json`).
  - This matches Claude Code (`--strict-mcp-config`) and OpenCode (operator servers disabled):
    no operator MCP server reaches a team run.
  - Doctor names what is being skipped (packages, extension files, `mcp.json` servers), so a
    package the operator meant for the team does not vanish silently.
- **Claude Code: an optional config dir of the team's own.**
  - The new config key `backends.claude.configDir` becomes `CLAUDE_CONFIG_DIR` for every claude
    process tumwater spawns: runs, the `auth status` seed, doctor.
  - `claudeConfigDir()` (claude-backend.ts) reads it first, so resume checks and doctor's
    transcript sizes follow it.
  - Team transcripts then land in `<configDir>/projects/`, outside `~/.claude/projects`, so your
    funes hook never indexes them.
  - **It needs a one-time login in that dir.** Verified 2026-10-17: a fresh config dir reports
    `loggedIn: false`. Either run `CLAUDE_CONFIG_DIR=<dir> claude auth login`, or use
    `claude setup-token` and export `CLAUDE_CODE_OAUTH_TOKEN`, which claude-env.ts already passes
    through. So the key is opt-in; unset, behavior is today's.
- **Doctor's `funes` row,** shown when `funes` is on PATH:
  - whether team pi runs skip discovered extensions (always, after this plan);
  - whether team Claude Code runs use their own config dir. When they don't, and funes's Claude
    Code integration is installed (`~/.funes/integrations/claude-plugin`), it warns: "team
    Claude Code transcripts are indexed into your personal funes memory — set
    backends.claude.configDir and log in there once";
  - whether the operator's global OpenCode config has `plugin` entries naming funes.
- **Already indexed:** the 1,599 team sessions already in your personal memory stay. funes's memory
  is append-only; its recency weighting (30-day half-life) fades them, or the memory can be
  rebuilt from transcripts. That is your call, outside this plan.

## Parts (PLANS.md "Notes command, part i/4")

1. The `tumwater-notes` command and the shim on every run's PATH. Additive: nothing uses it yet.
2. Every backend's prompt uses the command. Runs stop loading the pi extension and the MCP
   server, and the smoke checks write a note through it. Requires part 1.
3. Delete the retired carriers, the dialect's notes tool and their tests, and update the docs.
   Requires part 2 and OpenCode part 7/7, whose docs and smoke script mention the MCP notes.
4. Keep funes out of team runs: pi's extension guard, `backends.claude.configDir`, and doctor's
   `funes` row. Independent of parts 1–3.

## Decisions (2026-10-17)

1. **Keep notes;** don't adopt funes in the team. Notes carry per-role working state, and nothing
   showed funes adding to it.
2. **One shell command for every backend;** retire the pi extension and the MCP server.
3. **A narrow `tumwater-notes` entry,** not the whole `tumwater` CLI on PATH.
4. **No skill.** The prompt instruction is the skill, and skill loading stays off in team runs.
5. **pi runs skip discovered extensions and pi's MCP built-in,** keeping its other built-ins.
   (Proposed; confirm: a target repo's own `.pi/extensions` stop loading too, while Claude Code
   still honors a repo's `.claude/settings.json`.)
6. **`backends.claude.configDir` is opt-in,** because it needs its own login.

## Risks

- **Weak models and heredocs.** A model may mangle the heredoc: a missing delimiter, or the note
  passed as an argument.
  - The command refuses empty input and prints what went wrong, so the run can retry.
  - After part 2, check that every role that ran keeps refreshing its note (the notes files'
    times, or the "last saved" date in each prompt).
  - If notes stop, revert part 2. Part 3's deletions are also one revert away.
- **PATH reset by a shell profile** (§2). The smoke checks catch it per backend.
- **A model that writes the file directly** instead of running the command. It could already do
  that today. The prompts forbid editing `.tumwater/`, and the reviewer sees the diff only for the
  worktree, which this file is not in.
- **pi built-in drift.** pi's built-in list may change. The guard names the kept ones explicitly,
  so a new built-in stays off until it is added. Doctor's pi row prints the list.
