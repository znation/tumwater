# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### `npm run build` fails at main's tip with a duplicate `isJsonObject` import, and `status`, `gui`, `issues`, `doctor` and a started team all die with `Identifier 'isJsonObject' has already been declared` (found by the qa role 2026-11-23)

**Symptom.** A fresh `npm run build` of main tip `1706a712b` fails, and the commands that read the
GitHub-issues ledger — `status`, `gui`, `issues`, `doctor` and a started team — each exit 1 with one
line of output. The README quick start is dead: no team starts, no dashboard is served, no status reads.

```
$ npm run build
> tumwater@0.10.1 build
> rm -rf dist && node scripts/tsc.mjs && node scripts/stamp-build.mjs

src/github/github-issues-state.ts(10,10): error TS2300: Duplicate identifier 'isJsonObject'.
src/github/github-issues-state.ts(12,10): error TS2300: Duplicate identifier 'isJsonObject'.
```

`tsc` exits 2 so `stamp-build.mjs` never runs, but the native compiler still emitted `dist/`, and the
emitted module carries the import twice — so a `dist/` produced by the failed build loads with a
SyntaxError:

```
$ node dist/src/cli.js status
tumwater: Identifier 'isJsonObject' has already been declared
$ echo $?
1
```

**Reproduce** (offline, no model, no network): from a clean worktree at `1706a712b`, `npm run build`
(the `node_modules` borrow makes `npm run build` work in a team worktree); then in a scratch dir made
with `mktemp -d`, `git init -b main`, one empty commit, and `node <wt>/dist/src/cli.js init "hi"`.
`status`, `gui`, `issues` and `doctor` each print that one line and exit 1; `gui` prints it instead of
the documented `tumwater gui at http://127.0.0.1:7180 — Ctrl+C to stop` banner and binds nothing
(`lsof -nP -iTCP:<port> -sTCP:LISTEN` returns no row). `start --once` prints its banner and role list,
then the same line, exit 1 — the crash lands on the lazy import when the round first reads the ledger.

Scoped by running each command against that `dist/` and against a scratch copy of it with the duplicate
import line deleted: exit 1 with that message on `status`, `gui`, `issues`, `doctor` and `start
--once`; exit 0 unchanged on `help`, `init`, `logs`, `report`, `guide`, `history`, `role feature`,
`prompt --list`, `plan --list`, `bug --list`, `questions`, `config get`, `brief --json`, `completion
bash` and `version`. With that one line removed from the copy, every crashing command exits 0 and the
dashboard serves on an ephemeral loopback port.

**Cause.** `1706a712b` ("Fix e3572db9 — … the guard sits at the one shared read") replaced the inline
object check in `isGithubIssueRow` with the shared `isJsonObject` predicate and added its import at
`src/github/github-issues-state.ts:12`, but the file already imported it at line 10 — lines 9–13 are
`ensureParentDir`, `isJsonObject`, `readJsonFile`/`writeJsonAtomic`, `isJsonObject`, `cachedByStat`. A
top-level duplicate binding is `TS2300`, which the native compiler reports and refuses to stamp a build
over, while eslint's import-hygiene rules in `eslint.config.js` (`consistent-type-imports`,
`no-import-type-side-effects`, `consistent-type-exports`) name no duplicate-import rule, so the lint half
of the gate stayed quiet and only the `tsc` half saw it.

**Expected.** `npm run build` exits 0 at main's tip, and the README's start/watch path works: `start`
boots a team, `gui` prints its banner and serves the dashboard, `status`, `issues` and `doctor` report.
**Fix direction (one line, no behavior change):** delete the duplicate `import { isJsonObject } from
"../files/json-object.js";` at `src/github/github-issues-state.ts:12`, keeping line 10; the predicate's
uses at lines 188 and 327 need nothing else. Confirm with `node scripts/tsc.mjs` (red before, green
after) and the issues-ledger/GUI tests.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-22 run (real): fresh `npm run build` of worktree tip 30cb5dd1 + `init "Build a tiny markdown-to-html converter CLI in Python."` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` + `config set maxConcurrent 1` + `config unset bootstrap` + `start --once --role feature --json` (with `TUMWATER_SUPERVISOR_PID`/`TUMWATER_SUPERVISED`/`TUMWATER_RUN` stripped from the environment) — one real run on OpenCode's free DeepSeek tier: `{"runs":1,"outcomes":{"no_change":1},"skipped":[],"failures":[]}`, exit 0, 29s, 871 output tok (prompt 46.5k tok, 67% cached), $0.00; `status` printed the 20-row role table with the documented `Declaring a build check` info alert and `budget: n/a` for an all-free team, `doctor --problems` printed `ready to run` with `70 ok checks hidden`, and `history`, `history feature --last` and `report` matched docs/cli.md; no tumwater or opencode process outlived the round and the scratch dir was deleted.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
