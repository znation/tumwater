# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed.

## Open

### Budget badge shows `$0.00/$50` on free/local LLM fleets instead of n/a (reported by user 2026-09-08)

**Symptom:** When the fleet runs a model that costs nothing — a local server (e.g. LM Studio via `openai-responses`) or any model with no price set in pi's models.json — both dashboards still show the daily budget badge as `· budget: $0.00/$50 today`, implying spend is being tracked against a cap that can never be reached. The user wants it to read n/a instead of `$0.00/$50`.

**Repro:**
1. Point tumwater.json at a free model (e.g. `provider: lm-studio`, `model: qwen3.8-27b` — no `cost` field in `~/.pi/agent/models.json`).
2. Run the fleet until at least one tick completes; open the TUI or GUI.
3. The header shows `· budget: $0.00/$50 today` (default cap) even though spend can never accumulate.

**Expected:** when every model the fleet could use is free, the badge reads n/a instead of a dollar figure.

**Suspected cause:** cost comes from pi's per-message usage (`msg.usage?.cost?.total`, src/pi.ts:159), which is 0 for unpriced models; nothing downstream knows the model is free. `snapshot()` (src/status.ts, ~line 110) emits `{ spentUsd, capUsd }` whenever `maxDailyCostUsd > 0`, and both renderers format it as `$X/$Y`:
- TUI + `tumwater status`: header line in src/ui/status-render.ts (`renderStatus`, ~line 220)
- GUI: src/ui/gui-page.ts (~lines 109–111), formatted client-side from the /api/status payload

**Detection approach (recommended):** resolve each enabled role's effective provider/model — `configForRole` in src/config.ts, plus `reviewConfig` when review is enabled — and look them up in pi's model definitions at `~/.pi/agent/models.json` (`providers.<p>.models[]`; free = no `cost` field or all-zero cost). If every resolvable model the fleet could use is free → budget n/a. Safe fallback: a provider/model not found there (e.g. pi's built-in paid providers) counts as NOT free, keeping `$X/$Y`. Expose the result on StatusSnapshot (e.g. `budget.free`) so TUI, GUI, and `status --json` all render from one source of truth — note the GUI formats client-side, so the payload must carry it. An alternative heuristic (observed usage: tokens > 0 with cumulative cost === 0) lags until the first tick and needs a persistent flag to survive midnight rollover / reset-counters; prefer the config-based check.

**Scope notes:**
- The budget *gate* is unaffected: $0 spend never reaches the cap (already acknowledged in src/config.ts, ~line 38). No change to `budgetReached` or pause behavior.
- Only the header badge changes; per-loop `cost`/`today` columns stay as-is ($0.00 remains accurate there).
- Cross-reference: the planned "Make the daily cost budget editable from the TUI/GUI" (PLANS.md) rewrites this same badge code — keep the enabled-case text byte-identical so that plan's acceptance criteria still hold, or coordinate ordering with it.

### README promises `tumwater init` seeds a git repo, but it refuses to run outside an existing one (found by qa loop 2026-09-08)

**Symptom:** A first-time user following the "How it works" section — "`tumwater init \"<prompt>\"` seeds a git repo with README.md … and commits them" — runs `tumwater init` in a fresh, empty project directory (the primary use case: the project does not exist yet, so no git repo exists to `cd` into) and gets an error instead of a seeded repo. The Usage block's comment `# any git repo` hints at the requirement, but it contradicts "seeds a git repo" — for a brand-new project there is no existing repo.

**Repro:**
```
mkdir /tmp/x && cd /tmp/x          # empty dir, not a git repository
tumwater init "Build a tiny markdown-to-html converter CLI in Python."
# → tumwater: /private/tmp/x is not a git repository (run `git init` first)
git init
tumwater init "Build a tiny markdown-to-html converter CLI in Python."
# → created README.md, PLANS.md, BUGS.md, QUESTIONS.md, PRINCIPLES.md, tumwater.json, .gitignore (committed)
```

**Expected:** per "How it works", `tumwater init` seeds a git repo — running it in an empty directory should work.

**Actual:** src/init.ts:87 throws unless the cwd is already a git repository; the user must run `git init` themselves first. The error message does guide them, so it is recoverable, but the docs promise behavior the product does not deliver.

**Suspected cause:** init was written to assume an existing repo while the README wording ("seeds a git repo … and commits them") overstates what it does. Either `init` should run `git init` itself when the cwd is not a repo (matching the docs), or "How it works" should say it seeds files into an *existing* repo and that `git init` comes first.

## Fixed

### Auto-restart deadlocked on a self-referential test: `npm test` fails in every worktree without a local install (found by readme loop 2026-09-08, diagnosed by human 2026-09-08, fixed 2026-09-08)

**Symptom:** The live fleet (pid 151, build `668c39e9`) sat 10 commits behind main for over two hours. It had noticed — `build_stale` and `restart_pending` at 10:05 for head `3c8c29b` — and then refused every head that followed: seven `main <sha> is red — holding the restart until main is green` warnings, one per head through `95d0c10`. Meanwhile new ticks kept starting, because a blocked restart correctly stops holding the fleet. Main was not red: `npm test` was 786/786 green in any checkout that had run `npm install`, and 785/786 in one that had not. The failing test was "compileStaged compiles the mirror worktree with the project's tsc and stamps the result" (test/redeploy.test.ts), which expected `{ ok: true }` and got `typescript is not installed under node_modules — cannot rebuild`.

**Repro:**
```
git worktree add /tmp/bare main   # fresh checkout; do NOT run npm install
cd /tmp/bare && npm test          # → 1 fail: redeploy.test.ts compileStaged (785/786)
npm ci && npm test                # → 786/786 green
```

**Cause:** two independent faults that compounded into a deadlock.

1. `compileStaged` looked for the compiler at `<root>/node_modules/typescript/bin/tsc` — a *local* install — while everything else in the harness (npm's run-script PATH walk, `detectBuildCheck`) climbs ancestors. Its test therefore had to symlink `<checkout>/node_modules/typescript` into a temp project, which dangles in every tumwater worktree (node_modules is gitignored, so it exists only where someone ran npm install). The redeploy gate runs `npm test` in the detached `_main` mirror, which never has one: main read red at every head, forever. The fleet could not restart itself onto the very commit that would fix this.
2. The baseline verdict cache (build-check.ts) was keyed by SHA alone, though the verdict depended on which worktree ran the check. At 11:07 the coverage loop — also install-less — cached a red for `6c91c25`, and 58 ms later the redeploy gate consumed that cached red without running anything. One worktree's broken environment became the fleet's verdict.

**Fix:** `resolveFromNodeModules` (build-check.ts) walks up from the project root the way npm and `detectBuildCheck` do, and `compileStaged` finds tsc through it; the test resolves this repo's typescript through node's own resolution instead of a hard-coded path, and a new test pins the ancestor-install case. A green verdict is now authoritative fleet-wide while a red is provisional: `checkMainBaseline`'s `reverifyRed` re-runs a cached red in the caller's own worktree, and a pass promotes the SHA for everyone (unblocking the role loops too). The redeploy gate is the one caller that pays for it — believing a wrong red there strands the whole fleet — and its suite run now appears in the feed as a `build_check` event. `BuildStatus` gained `restartPending`/`restartBlocked`, so orchestrator.json, `status --json`, both dashboards (`restart BLOCKED: <reason>`) and `doctor` distinguish a restart that is seconds away from one that will never happen. Files: src/build-check.ts, src/redeploy.ts, src/build-info.ts, src/ui/status-render.ts, src/ui/gui-page.ts, src/doctor.ts.

### Harness never picks up its own new build: the fleet ran a 2026-08-27 build for ten days while 350 commits landed (found by human log analysis 2026-09-07, fixed 2026-09-07)

**Symptom:** `tumwater run` loads dist/ once and never reloads it. From 2026-08-27 17:28 to 2026-09-07 00:04 the live orchestrator (pid 69563, started from `ba793ac`) kept running while main gained 350 commits — the review gate on the normal path, its build pre-check, the red-main gate, the daily budget, commit bodies, the qa and steward roles, pause/resume, doctor, status --json — none of which executed until a manual restart. Nothing in the fleet could see it: the roles list in the Aug 27 orchestrator_start event, the absence of every newer tick result and event type, state files without the budget fields, zero commit bodies after Aug 27, and qa/steward at tick 1 on Sep 7 were the only traces. Two entries below reasoned about why the pre-check "must have been skipped"; it was not running.

**Repro:** land a src/ change on main while `tumwater run` is up; observe that dist/ and the process are unchanged and that no dashboard, event, or `doctor` line says so.

**Cause:** no build provenance (dist/ carried no record of the commit it came from) and no redeploy path — a self-hosting harness with no way to notice or act on its own new code.

**Fix:** `npm run build` stamps `dist/build-info.json`; the orchestrator publishes the stamp and its staleness (vs main's src/, package.json, tsconfig.json) in orchestrator.json, its start event, a `build_stale` event, both dashboards' headers, `status --json`, and a `doctor` check. With `autoRestart` (default true) a self-hosted fleet verifies main is green, compiles it into `.tumwater/build/<sha>`, drains in-flight ticks (30 min cap, then aborted resumably), swaps dist/, and exits 75 for the new `tumwater run` supervisor to respawn it. Commit `debe885`. Files: src/build-info.ts, src/redeploy.ts, src/supervisor.ts, scripts/stamp-build.mjs, src/orchestrator.ts, src/cli.ts, src/doctor.ts, src/status*.ts, src/gui*.ts.

### pi crashing on malformed JSON abandoned the session: five ticks lost, one of them 2 h 39 m of director work (found by human log analysis 2026-09-07, fixed 2026-09-07)

**Symptom:** tick_end errors "Unterminated string in JSON at position N (line 1 column N+1)" (organize #88 on 2026-09-02, perf #88 on 09-05, director #70 on 09-06) and "Expected ',' or '}' after property value in JSON" (08-25, 08-28), each ending a tick as a plain error with backoff; director tick 70 had spent 2 h 39 m on the newest steering prompt, which then re-ran from scratch.

**Cause:** the messages are pi's own stderr — pi dying on a torn model-server chunk — not harness parsing (every harness JSON.parse is guarded). The session file survives such a crash intact, but the harness treated it like any failure and started the next tick fresh.

**Fix:** runPi flags a nonzero exit whose stderr ends in a JSON.parse failure as `transientPiCrash` (never for exits the harness itself caused); the loop gives it the same single `--continue` retry the predict-stream timeout gets, with one warning naming the crash. Commit `94f15ef`. Files: src/pi.ts, src/loop.ts, src/types.ts.

### Cut-off resumes were bridged as "the harness was restarted" and the cut-off streak froze at the resume limit (found by human log analysis 2026-09-07, fixed 2026-09-07)

**Symptom:** 308 of 733 autonomous-era ticks ended cut off at the context ceiling (179 model-hours landing nothing). A resumed cut-off session was told a restart had interrupted it and to verify a half-finished tool call; a fresh tick after the loop gave up resuming carried no memory that the last attempts were too big for the window; and `cutOffStreak` stopped counting at 3, so dashboards and prompts could not say how long a loop had been starving (improve: 36 consecutive cut-offs, Sep 1–6).

**Fix:** every run carries a context-budget rule; the resume bridge names the real cause and asks for the smallest finish without re-reading; a fresh tick after cut-offs carries a note counting them and offering nothing-to-do; the `resume` event carries its cause; the streak counts every consecutive cut-off. Commit `fa3c59c`. Files: src/prompt.ts, src/loop.ts, src/state.ts, src/event-format.ts.

### Changed ticks whose reply lacked SUMMARY landed as "<role> tick N" — 73 commits, 32 of them feature (found by human log analysis 2026-09-07, fixed 2026-09-07)

**Symptom:** a run that changed files but ended without the closing block (often a final message cut off at the ceiling) committed with the bare placeholder subject, so the largest diffs in the repo had no description in `git log`.

**Fix:** one bounded follow-up turn in the tick's own session (`--continue`, 15 min / 5 min quiet caps) asks for exactly the SUMMARY/WHY/RISK/VERIFIED block; failing that the subject is derived from the changed paths ("Update src/loop.ts, test/loop.test.ts and 2 more"). Commit `61cf063`. Files: src/loop.ts, src/prompt.ts, src/commit-message.ts.

### GUI dashboard executes HTML in backlog entry bodies — unescaped innerHTML injection (found by bugfix loop 2026-09-06, fixed 2026-09-06)

**Symptom:** The dashboard's backlog detail panel (`tumwater gui` → click any planned feature / open bug / open question) spliced the entry's body straight into `innerHTML` without escaping, while every other dynamic value on the page — including the same entry's title two lines above — went through the page's `esc()`. A plan/bug/question entry containing HTML (a repro with `<img src=x onerror=…>`, a stray `<script>` tag) was parsed and executed in the operator's browser instead of rendering as text. With `--all-interfaces` the dashboard is reachable from the whole network without authentication, so this was a live XSS surface, not just a local oddity.

**Repro:** Write an entry under BUGS.md's ## Open whose body contains `<img src=x onerror=alert(1)>`, run `tumwater gui`, and click the entry: pre-fix the tag executes instead of rendering as text. Deterministic unit repro — test/gui.test.ts "the dashboard page escapes backlog entry bodies before innerHTML" (added with this fix) pins both halves: the served page routes d.body through esc, and /api/backlog still serves the raw body (escaping is the page's job).

**Cause:** src/gui-page.ts's refreshTranscript() built the detail panel as `panel.innerHTML = "<span class='muted'>" + esc(d.title) + " …</span>\n" + (d.body || "(no details for this entry)")` — d.title escaped, d.body not. The body is model-written markdown from PLANS/BUGS/QUESTIONS.md (loops edit those files constantly), i.e. untrusted content by the same standard as transcript lines and event text, both of which are escaped (`lines.map(esc)`, `d.events.map(esc)`). Found by latent-bug sweep; no open bug had been recorded.

**Fix:** One line in src/gui-page.ts: `(esc(d.body) || "(no details for this entry)")` — esc("") is "", so empty bodies still fall back to the placeholder. Server unchanged: /api/backlog keeps serving raw markdown (the TUI renders it as plain terminal text, and other clients may want it unescaped). The regression test fails against pre-fix code on its page-structure assertion. Verified: build clean, full suite green. Files: src/gui-page.ts, test/gui.test.ts.

### Build broken on main: feature tick 105 dropped `openBugs` from test/backlog.test.ts's imports, and two of its new assertions could never pass (found by coverage loop 2026-09-06, fixed 2026-09-06)

**Symptom:** Since feature tick 105 (`2c85ea4`), `npm run build` fails with TS2304 "Cannot find name 'openBugs'" in test/backlog.test.ts (lines 99, 103). Because the build pre-check runs before any test, it masked two further defects that surfaced only once compilation recovered: gui.test.ts's "the dashboard page renders backlog entries as links into /api/backlog" and tui.test.ts's "project status browses entries in full with up/down and resets on Ctrl+T".

**Repro:** `npm test` on any commit from `2c85ea4` onward: tsc fails before a single test runs. After restoring the import, `node --test dist/test/gui.test.js dist/test/tui.test.js` shows exactly those two failures — gui with "did not match /backlogKey = backlogKey === key ? null : key/", tui with "did not match /plan: Add a --json flag/" while the frame shows the bug entry open.

**Cause:** Feature tick 105 landed the "read backlog entries in full" feature (src/backlog.ts, gui-page.ts, gui.ts, tui.ts) and its tests in one commit but rewrote test/backlog.test.ts's import list without `openBugs`, which two pre-existing tests still call. The red build meant none of the new tests ever ran: (a) gui.test.ts asserts `/backlogKey = backlogKey === key ? null : key/` — the unescaped `?` is a quantifier on the preceding space, so the pattern can never match the page's literal ternary; (b) tui.test.ts presses up from index 1 back to index 0, then expects down to "wrap from the last entry back to the first" — but from index 0, down correctly advances to index 1 (the bug), so the assertion fails and no true wrap is ever exercised.

**Fix:** Test-only: restored `openBugs` to test/backlog.test.ts's imports; escaped the question mark in gui.test.ts's regex (`\?`); reworked tui.test.ts's sequence to cross into the bugs section (the last entry) before pressing down, so the final assertion exercises a true wrap (plan → bug → plan). Verified: build clean, full suite 700/700. Files: test/backlog.test.ts, test/gui.test.ts, test/tui.test.ts.

### Non-ASCII text in pi output garbled when a multi-byte character straddles a stdout chunk boundary (found by bugfix loop 2026-09-03, fixed 2026-09-03)

**Symptom:** In long runs, non-ASCII characters in model text — accented letters, CJK, emoji — occasionally appear as U+FFFD replacement characters in commit subjects, SUMMARY lines, transcript rendering (`tumwater logs --transcript`), and the raw pi log. It happens at random on some runs only, so it reads like a model glitch rather than a harness defect.

**Repro:** test/pi.test.ts "a multi-byte character straddling a stdout chunk boundary survives intact" (added with this fix): a fake pi writes one JSONL line in two paced writes with é's UTF-8 bytes (0xC3 0xA9) split between them — pre-fix it fails with `'h\uFFFD\uFFFDllo' !== 'héllo'`. In production, any run where a multi-byte character happens to straddle a pipe read boundary; chunk sizes are arbitrary, so over hours of streaming this is guaranteed to occur.

**Cause:** `runPi` in src/pi.ts decoded each stdout chunk independently with `chunk.toString("utf8")`. Node's Buffer.toString replaces an incomplete trailing sequence at the end of a buffer with U+FFFD instead of holding it back — so any multi-byte character whose bytes straddle two 'data' events is corrupted, and BOTH halves become replacement characters (the lead byte 0xC3 ending chunk N and the continuation byte 0xA9 starting chunk N+1 are each invalid on their own). The decoded text flows into PiStreamParser → finalText / commit subject / SUMMARY, and via the onLine callback into the raw log that transcript rendering and live progress read from.

**Fix:** src/pi.ts — decode stdout incrementally with a `StringDecoder` (node:string_decoder, one per run): `decoder.write(chunk)` holds back incomplete trailing bytes until the next chunk completes them, and a `decoder.end()` flush feeds any held fragment to the parser at stream end before the result is built. stderr is left as-is (it only feeds failure messages). The regression test paces two writes so the boundary falls inside é; it asserts finalText === "héllo", turns === 1, and no U+FFFD in the raw log. Verified: build clean, full suite 576/576; the new test fails against pre-fix code. Files: src/pi.ts, test/pi.test.ts.

### Tests red on main: feature tick 83's `today` column broke two layout assertions (found by readme loop 2026-09-03, fixed 2026-09-03)

**Symptom:** Since feature tick 83 (`c17893d`), `npm test` fails exactly two of 553 tests — "the dashboard page has a last tick column between cost and last result" in test/gui.test.ts and "last tick shrinks last: narrow width takes from last result, then state, then last tick" in test/status-render.test.ts. Every loop inherits it because worktrees reset to main at tick start, so each tick's green-suite check sees failures unrelated to its own change.

**Repro:** `npm run build && node --test dist/test/gui.test.js dist/test/status-render.test.js` on any commit from `c17893d` onward: gui.test.ts fails with ERR_ASSERTION — the expected regex `<th>cost</th><th>last tick</th><th>last result</th>` no longer matches because the served page now carries `<th>today</th>` between cost and last tick; status-render.test.ts fails its fixture-sanity assertion (`5 !== 17`) — `col(natural, 7)` reads the new five-char `$0.00` today cell instead of the seventeen-char last-tick cell, because the test addresses columns positionally (last tick was index 7 before the shift).

**Suspected cause:** Feature tick 83 landed only the src half of the per-loop today-spend plan — status-render.ts's `today` column between `cost` and `last tick`, gui.ts's `todayUsd` payload field, gui-page.ts's header cell — without the test updates its acceptance criteria specify. The plan itself anticipated "FLEXIBLE_COLUMNS indices shift (last result 8→9, last tick 7→8)" and lists test/status-render.test.ts and test/gui.test.ts among its files touched; the gate's deterministic build pre-check runs only tsc, so unit-test failures stay invisible to it. The fix is mechanical: update gui.test.ts's header regex to include `<th>today</th>` and renumber status-render.test.ts's positional indices (last tick 7→8, last result 8→9) — or fold both into the plan's own test items when they land.

**Fix:** Test-only, folded into the plan's own remainder as its "Suspected cause" anticipated (PLANS.md "Per-loop today spend", re-audited 2026-09-03): item (a) repaired both broken layout assertions — gui.test.ts's header regex now pins `<th>cost</th><th>today</th><th>last tick</th><th>last result</th>` and status-render.test.ts's "last tick shrinks last" renumbered its positional indices for the index-7 `today` column (last tick 7→8, last result 8→9) — and items (b)/(c) landed the plan's TUI/one-shot and GUI acceptance tests in the same change. Verified on main `56088cf`'s tree: build clean, full suite 560/560 — main is green again. Files: test/gui.test.ts, test/status-render.test.ts.

### readTranscriptTail returns duplicated entries when a pi log starts with a blank line (found by coverage loop 2026-09-03, fixed 2026-09-03)

**Symptom:** When a role's raw pi log begins with a blank line (the file's first byte is `\n`), `tumwater logs --role <id>` shows the tail duplicated — up to `limit` copies of the same turns instead of the true window. readTranscriptTail's backward scan re-emits every line in its window until its entry-candidate count reaches limit, then stops at a run boundary and returns those duplicates as if they were distinct entries.

**Repro:** Make a role's pi log start with `\n` (any append that lands a bare newline before the first event, or a manual edit), then run `tumwater logs --role <id>`: each rendered turn appears up to N times. Deterministic unit repro — test/transcript.test.ts "readTranscriptTail skips blank lines exactly like a full re-read" (added with this fix) fails on pre-fix code: for a three-run log, limit 50 returns 50 identical entries.

**Cause:** The backward scan walks complete lines newest-to-oldest, finding each line's start via `c.lastIndexOf(10, lineEnd - 1) + 1`. When the scanned region c starts with `\n` (a zero-length line at its head), walking past the first real line sets lineEnd = 0; the next iteration calls lastIndexOf(10, -1), and a negative fromIndex makes V8 search the whole buffer — returning c's LAST newline. The walk then "finds" an empty range after it, takes the blank-line skip branch, resets lineEnd to the newest line, and re-pushes every line in the window; it only stops once the re-counted candidates reach limit at an agent_start boundary.

**Fix:** src/transcript.ts — when c's first byte is a newline (a zero-length oldest line), advance emitStart past it before walking so the walk terminates at the region start instead of wrapping. One-line guard plus comment; behavior for logs without leading newlines is unchanged. Verified: build clean, full suite 554/554; transcript.js line coverage 98.99% → 100%. Files: src/transcript.ts, test/transcript.test.ts.

### Main's suite red: stale duplicate of the already-fixed fmtUsdCap test break — re-recorded from a pre-fix snapshot (re-recorded by readme loop 2026-09-02, closed 2026-09-02)

**Symptom:** BUGS.md's Open section carried an entry claiming that since clean tick 91 (`66e94a4`), `npm test` fails one of 531 tests — the fmtUsdCap assertion in test/gui.test.ts. The break was real when recorded, but it had already been fixed on main before this entry landed: the coverage loop's repair commit `91a0843` (2026-09-02 01:06) corrected the assertion and exercised its rule, and recorded the bug in the Fixed section below.

**Repro:** None — at HEAD (`d5c9531`) the full suite is green: 534/534. The corrected assertion (the `\/,` pattern plus a `new Function` evaluation of fmtUsdCap) has been in test/gui.test.ts since `91a0843`; at `fbefd9e` — the entry's cited "current main" and the fix commit's direct parent — it still carried the never-matching `\/"` pattern.

**Cause:** The same race as the two stale-duplicate entries further down: readme tick 95 (`4198b4d`) started from a worktree reset to pre-fix main (its entry cites `fbefd9e`, 531 tests), recorded the red suite as an open bug, and merged its markdown-only diff at 01:48 — ~42 minutes after the fix had landed — adding the stale Open entry on top of the Fixed section's record of the same break.

**Resolution:** Verified by the bugfix loop on 2026-09-02 at HEAD `d5c9531`: `npm test` green (534/534) and the corrected assertion plus rule-exercise check present in test/gui.test.ts since `91a0843`. No code change needed; closed as a stale duplicate of "Tests red on main: clean tick 91's fmtUsdCap assertion carries a stray quote" (Fixed below).

### Tests red on main: clean tick 91's fmtUsdCap assertion carries a stray quote and can never match GUI_PAGE (found by coverage loop 2026-09-02, fixed 2026-09-02)

**Symptom:** Since `66e94a4` (clean tick 91), `npm test` fails with exactly one unit test — "the dashboard page derives its header badge from the payload's budget" in test/gui.test.ts (528/529). Every loop inherits it because worktrees reset to main at tick start, so each tick's green-suite check saw a failure unrelated to its own change.

**Repro:** `npm run build && node --test dist/test/gui.test.js` on any commit from `66e94a4` onward: the test fails with ERR_ASSERTION; the expected regex ends `...replace\(\/\\\.00\$\/", ""\);/` while GUI_PAGE's actual line is `.replace(/\.00$/, "")`.

**Cause:** The assertion's text-match regex expects a double quote between the embedded page-regex's closing slash and the comma — `/\.00$/", "");` — but the served code is `n.toFixed(2).replace(/\.00$/, "")`: no such quote exists. A never-passing match pins nothing (zero coverage value) while red-ing the suite for every loop; the gate's build pre-check runs only tsc, so unit-test failures stay invisible to it.

**Fix:** test/gui.test.ts only — dropped the stray `"` so the structural match pins the real line, and extended the same test to exercise the rule instead of merely its presence: it now extracts fmtUsdCap's parameter and body out of GUI_PAGE and evaluates them with `new Function` (the pattern the file's inline-script parse test already uses), asserting 50 → "50" (whole dollars stay bare) and 12.34 → "12.34" (fractional caps keep their cents). No src change: the page code was correct all along — in browser JS `(50).toFixed(2).replace(/\.00$/, "")` is "50", exactly the TUI usdCap rule the comment claims. Verified: build clean, full suite 529/529 on main `55af189`. Files: test/gui.test.ts.

### Main's build broken: organize tick 78 deleted git.ts's rebase/fast-forward/conflict helpers without landing their move into merge.ts (found by readme loop 2026-08-31, fixed 2026-08-31)

**Symptom:** Since organize tick 78 (`369a085`), `npm run build` fails with twelve type errors: src/merge.ts and test/git.test.ts each import six exports that no longer exist in src/git.js — `conflictedFiles`, `continueRebase`, `ffMergeToMain`, `hasConflictMarkers`, `rebaseOntoMain`, `rebaseOntoMainLeaveConflicts` (TS2305 "Module has no exported member"). Every loop inherits this because worktrees reset to main at tick start, so each tick's build check sees twelve failures unrelated to its own change.

**Repro:** `npm run build` on any commit from `369a085` onward (e.g. current main): tsc reports the six TS2305 errors in src/merge.ts and the same six in test/git.test.ts; `npm test` cannot reach its suite because the build step fails first.

**Cause:** The tick's diff touches only src/git.ts (−96/+7): it deleted those helpers — plus the private `attemptRebase` they shared — and exported `runGit`/`unquotePorcelainPath`, whose updated doc comment ("Shared by changedFiles here and conflictedFiles in merge.ts") shows the intent was to move the landing-flow helpers into src/merge.ts. The commit never added them there (or that half of the change was lost), leaving merge.ts's imports dangling. Open question: this landed despite the gate's deterministic build pre-check, which runs exactly `npm run build` in the worktree and rejects deterministically on a nonzero exit — its only proceed-anyway paths are environmental skips (timeout or no npm on PATH), so one of those must have fired for this tick; confirming which is part of fixing it.

**Fix:** Bugfix tick 74 (`2cff978`) landed the intended half of organize tick 78's change: the six helpers plus their shared private `attemptRebase` now live in src/merge.ts under a "Git helpers for the landing flow" section — they are used only by that module (the rebase/ff-merge surface of landing, not general git plumbing) and import the shared primitives (`git`, `runGit`, `gitTry`, `COMMIT_IDENT`, `headOf`, `unquotePorcelainPath`) from git.ts. test/git.test.ts keeps its units but imports them from merge.js now; test/merge.test.ts gains a runtime regression test pinning all six exports at their new home and exercising a real rebase + fast-forward through them. Verified: build clean, full suite 488/488 on main `05f7a13`. Files: src/merge.ts, test/git.test.ts, test/merge.test.ts.

### Interrupted tick on a slow-clock role does not resume promptly: the min gap holds it for a full interval (found by bugfix loop 2026-08-30, fixed 2026-08-30)

**Symptom:** A tick interrupted by harness shutdown or crash — which leaves half-finished work in its pi session and uncommitted edits in the worktree, and is explicitly scheduled to "resume promptly on restart" (`tick()` sets `nextRunAt = Date.now()`, `resumePending = true`; test/loop.test.ts asserts "resumes promptly on restart") — actually did not resume for a full `minTickIntervalSeconds` after the interruption. For slow-clock roles that is hours: steward (~6 h) and qa (~2 h). Stopping tumwater mid-steward-run and restarting left the interrupted work sitting unattended for up to ~4–6 more hours before its session was ever continued.

**Repro:** unit-level (now test/orchestrator.test.ts "an interrupted tick resumes promptly on restart despite the min gap"): a runner with `ticks > 0`, `lastTickEndedAt` one second ago, `nextRunAt` in the past, and `resumePending = true` — pre-fix `isEligible` returned `{run: false}` because the min-gap check ran before any other eligibility path; post-fix it returns `{run: true, reason: "resume"}`.

**Cause:** When the per-role slow clock landed (steward plan), `isEligible` in src/orchestrator.ts applied `minTickIntervalSeconds` as a blanket gate on every non-director eligibility check — but the design scoped it to "both scheduled ticks and 'main moved' early wakes" (PLANS.md, steward entry). The resume-after-interruption path predates it: an aborted tick's `nextRunAt = now` was meant to make the loop eligible immediately on restart, and crash recovery sets `resumePending` in the constructor for exactly that reason. The blanket min-gap check silently overrode both — `sinceLast < minGap` is true for hours after any interruption of a slow-clock role, so the `nextRunAt = now` the tick wrote was never consulted.

**Fix:** `isEligible` now checks `resumePending` before the min gap: an interrupted tick is eligible as soon as its own `nextRunAt` allows (immediately for aborts and crash recovery, which schedule at "now" or earlier), bypassing the interval that throttles scheduled ticks. Cut-off resumes are unaffected — they set `nextRunAt = now + interval`, so the same check still makes them wait one full interval from their compacted context as designed (pinned by a second regression test). The resume surfaces in `tumwater logs` as a `wake` event with reason "resume", like other early wakes. Verified: build clean, full suite 425/425; the new regression test fails against the pre-fix code. Files: src/orchestrator.ts, test/orchestrator.test.ts.

### Orphaned merge lock (no pid file) can never be broken — every merge times out forever (found by bugfix loop 2026-08-29, fixed 2026-08-29)

**Symptom:** If the process holding `.tumwater/merge.lock` dies between `mkdir` and writing its `pid` file — or the pid write itself fails (disk error) — the lock dir is left with no readable pid. Every subsequent merge attempt (`withLock`, used only by `tryMerge`) then polls forever: each retry's staleness check throws on the missing pid file before it can evaluate age, so the lock is never broken and every tick that produces changes fails with "timed out after 120s waiting for lock" until a human deletes the dir by hand. The project wedges permanently while its dashboards show repeated merge errors.

**Repro:** `mkdir .tumwater/merge.lock` (no pid file), then any tick that lands changes — pre-fix it fails with the 120s lock timeout and never recovers; unit-level: `withLock(dir, fn)` against a pid-less dir rejected with the timeout even after hours.

**Cause:** `tryBreakStale` in src/lock.ts did `statSync`, then `readFileSync(pid)`, then computed both `dead` and `old` inside one try block. A missing/unreadable pid file threw before `old` was ever computed, so the 10-minute age-based break — which exists precisely to cover holder states the liveness check cannot (a SIGKILLed process whose pid got reused) — was disabled for exactly the state it should have covered. The catch's comment ("the next acquire attempt sorts it out") assumed retries would eventually succeed; they cannot, because nothing about the dir changes over time.

**Fix:** `tryBreakStale` now stats first and breaks on age alone before touching the pid file (covering a reused live pid as before); a readable dead pid still breaks immediately; and a missing/unreadable/garbage pid is treated as an orphan — broken once past a 5s creation grace (`NO_PID_GRACE_MS`). The grace keeps us from stealing a lock whose live creator is still between `mkdir` and the pid write (two synchronous calls microseconds apart), so two processes can never hold it at once. Recovery from this crash now takes ~5s instead of forever. Regression tests in test/lock.test.ts: an orphaned dir aged past the grace is stolen, and a fresh pid-less dir is NOT broken within the grace (times out, lock left untouched). Verified: build clean, full suite green. Files: src/lock.ts, test/lock.test.ts.

### Tests red on main: feature tick 57's new contract tests break on prompt line-wrapping (found by improve loop 2026-08-29, fixed 2026-08-29)

**Symptom:** Since feature tick 57 (`c477ce9`), `npm run build` passed but `npm test` failed with four unit tests — the refusal plan's prompt-contract tests (plans/refusal-and-thrash.md item (c)) and thrash-validation test (item (e)): `COMMON_RULES carries the Refused-note skip rule for every role`, `the feature find text refuses rather than forces and skips refused plans`, `the bugfix find text refuses harmful fixes and skips refused bugs`, and `defaultConfig carries the thrash thresholds and validation guards them`. Every loop inherits this because worktrees reset to main at tick start, so each tick's "run it and fix what you broke" check saw four failures unrelated to its own change. Seventh instance of broken work landing on main — and the first red *tests* rather than red build: the gate's deterministic pre-check runs only the typecheck/build script (`tsc`), which passed, so failing unit tests are invisible to it exactly as type errors were before the pre-check landed.

**Repro:** `npm test` at main `c477ce9` (four of 413 fail).

**Cause:** The prompt prose is hard-wrapped and earlier formatting ticks reflowed it, but tick 57's regexes assumed single-line phrases: three contract assertions matched across a wrap ("Skip BUGS.md entries\ncarrying…", "objection recorded\nrather than forcing it", "Refused note — do not\npick them"), and the config test anchored `^invalid tumwater\.json:.*<key>…` without dotAll, so `.*` could not cross the newline between the error header and its bulleted problems. The asserted content was present in every prompt; only the line layout differed.

**Fix:** Made the assertions match content, not layout — test/prompt.test.ts now collapses whitespace runs (`oneLine`) before matching in all four refusal-contract tests (the director one included: it passed only because its phrase happened to sit on one line), and test/config.test.ts's regex takes the `s` flag so `.*` crosses the header newline (its unescaped `\(` capture group is escaped properly too). No src/ change: the prompts already carry every contracted string. Verified against main `c477ce9`: build clean, full suite 413/413. Files: test/prompt.test.ts, test/config.test.ts.

### `reset-counters` consumed mid-tick wedges the loop: running flag stuck true until restart (found by bugfix loop 2026-08-28, fixed 2026-08-28)

**Symptom:** Running `tumwater reset-counters` against a live fleet — its documented use case ("a running fleet picks it up within ~2s") — permanently wedged every loop that was mid-tick when the orchestrator consumed the marker: the loop's state file kept `running: true` forever, so `isEligible` refused it and it never ticked again until the harness restarted. The dashboards showed a frozen `working …` cell for the stuck role while its siblings kept ticking.

**Repro:** e2e (now test/orchestrator.test.ts "a reset consumed while a tick is in flight does not wedge the loop"): one enabled role with a fake pi that sleeps 4s per tick; wait until the state file shows `running: true`, then zero the state file and drop the reset marker (what the CLI does); after the marker is consumed, the in-flight tick's end-of-save never clears `running` on disk — pre-fix the test timed out waiting for it.

**Cause:** `LoopRunner.resetCounters()` replaced the state object: `this.state = zeroCounters(this.state)` (zeroCounters returns a fresh `{...s}` copy). A tick in flight holds its own reference to the OLD object (`const s = this.state` at the top of `tick()`) and ends with `this.save()`, which persists `this.state` — i.e. the NEW zeroed copy, not the tick's bookkeeping. The copy still carried `running: true` (zeroCounters preserves it, and the in-flight tick had set it at start), so nothing ever cleared it within the process; on disk the loop also lost its end-of-tick scheduling (`nextRunAt`, `backoffSeconds`, `lastTickEndedAt`) and last-result fields — the copy held pre-tick values (a stale past `nextRunAt` would have made it immediately re-eligible, skipping min-interval/backoff). The existing e2e only consumed markers between ticks (it waits for `!running` first), so the race was untested; with 2s polls and minute-plus ticks, marker consumption lands mid-tick for most loops in a running fleet.

**Fix:** `resetCounters()` now zeroes IN PLACE — `Object.assign(this.state, zeroCounters(this.state))` — keeping the object identity an in-flight tick holds, so its start/end saves stay authoritative over the same (already-zeroed) object: counters are zero on disk immediately after consumption and never resurrect from a stale copy, while the tick's running flag, scheduling, and last-result bookkeeping land at tick end as usual. `zeroCounters` itself stays pure (its state.test.ts coverage is untouched). Regression test above drives the real orchestrator through the race: marker consumed mid-tick → in-flight tick finishes cleanly (`running` clears), counters stay zeroed, a post-reset tick runs to completion, and one `counters_reset` event lands under the role. Verified at HEAD ec17c86: build clean, full suite 369/369. Files: src/loop.ts, test/orchestrator.test.ts.

### Build broken on main: feature tick 52's questions-outbox changes leave three test files stale (found by readme loop 2026-08-28, fixed 2026-08-28)

**Symptom:** `npm run build` — and therefore `npm test` — fails on main with five TypeScript errors, all in test files that feature tick 52 (`2547b4d`) did not update for its own API changes:

```
test/status-render.test.ts(22,3): error TS2741: Property 'questions' is missing ... but required in type 'StatusSnapshot'.
test/tui.test.ts(72,20): error TS2554: Expected 3 arguments, but got 2.
test/tui.test.ts(81,20): error TS2554: Expected 3 arguments, but got 2.
test/tui.test.ts(87,20): error TS2554: Expected 3 arguments, but got 2.
test/tui.test.ts(96,20): error TS2554: Expected 3 arguments, but got 2.
```

Every loop inherits this because worktrees reset to main at tick start, so the whole fleet is blocked until it lands. Sixth instance of broken work landing on main — and again with the review gate active, through the same hole as tick 49's: the reviewer may not run state-changing commands, `npm run build` is exactly that, and type errors are invisible to a model that cannot compile (the deterministic build pre-check is the pending refinement of the review-gate plan).

**Repro:** `npm run build` at HEAD `ceb4a8a` (any main since `2547b4d`).

**Cause:** Feature tick 52 made `StatusSnapshot.questions` a required field (src/status.ts) and gave `backlogLines` a third `questions` argument (src/tui.ts), but left the test call sites stale: `snapshotWith` in test/status-render.test.ts builds a `StatusSnapshot` without `questions`, and the four `backlogLines(...)` calls in test/tui.test.ts pass two arguments. Note the fix is not just adding arguments — `backlogLines` now always emits an `open questions (N):` subheader plus its entries or `(none)`, so those tests' expected line arrays must grow accordingly, and the all-empty case's single line changed to "(no planned features, open bugs, or open questions)".

A third stale file is invisible to tsc: `initProject` now seeds QUESTIONS.md (src/init.ts), but test/init.test.ts's expected committed-file list omits it, so once the build errors are fixed and `npm test` actually runs, "initProject creates and commits the harness files" fails its deep-equal on the file list (found by coverage loop 2026-08-28 while verifying new tests against the broken main).

**Fix:** exactly as prescribed — added `questions: 0` to `snapshotWith`'s object (test/status-render.test.ts); passed a third argument at each of the four `backlogLines(...)` call sites and extended every expected line array with the new `open questions (N):` subheader plus its entries or `(none)`, including the all-empty case's single line, now "(no planned features, open bugs, or open questions)"; added a non-empty-questions assertion so the new section's entry rendering is covered, not just its empty form; and added `QUESTIONS.md` to test/init.test.ts's expected committed-file list (the deep-equal itself fails if init ever stops seeding it). Verified at HEAD c02189c: build clean, full suite 355/355. Files: test/status-render.test.ts, test/tui.test.ts, test/init.test.ts.

### Build broken on main: feature tick 49's steward default fails noUncheckedIndexedAccess (found by readme loop 2026-08-28, fixed 2026-08-28)

**Symptom:** `npm run build` — and therefore `npm test` — failed on main with a single TypeScript error:

```
src/config.ts(10,3): error TS18048: 'roles.steward' is possibly 'undefined'.
```

Every loop inherited this because worktrees reset to main at tick start, so the whole fleet was blocked until it landed. Fifth instance of broken work landing on main — and the first to land with the review gate active (the gate was wired into the tick path by feature tick 47 itself).

**Repro:** `npm run build` at HEAD 6e3f487.

**Cause:** Feature tick 49 (6e3f487) added `roles.steward.minTickIntervalSeconds = 21600;` to defaultConfig, where `roles` is a `Record<string, RoleConfig>` — under tsconfig's `noUncheckedIndexedAccess: true`, that index access has type `RoleConfig | undefined`. The review gate could not catch it structurally: buildReviewPrompt forbids the reviewer from running any state-changing command ("no writes anywhere"), and `npm run build` is exactly that (`rm -rf dist && tsc`) — so a fresh-session reviewer can read surrounding code but cannot compile, and type errors are invisible to it. The authoring tick likewise did not end with a green build.

**Fix:** defaultConfig now assigns the full entry instead of mutating the index access: `roles.steward = { enabled: true, minTickIntervalSeconds: 21600 };` — behavior-identical (steward was already `{enabled: true}` from the loop above), compiles under noUncheckedIndexedAccess. Regression test in test/config.test.ts: the steward's slow clock resolves to 21600 through `configForRole` (the read site) and every other role inherits the global interval — the pre-fix code had no assertion on this default at all, which is how it landed untested. Verified: build clean, full suite 335/335. Files: src/config.ts, test/config.test.ts.

### Build broken on main: src/loop.ts calls git() without importing it — stale duplicate of the readme-loop entry (reported by organize loop 2026-08-28, closed 2026-08-28)

**Symptom:** `npm run build` fails with two type errors (`src/loop.ts(402,15)` / `(403,15): error TS2304: Cannot find name 'git'`) — identical to the entry below it in this section.

**Resolution:** Stale duplicate. The organize loop reported the same break against HEAD 74224e9 (feature tick 47) after perf tick 36 (93b8535, 2026-08-28) had already re-added `git` to src/loop.ts's import block on main — the same race as the first report: the break was real at 74224e9 but fixed three commits before this entry landed. Verified by the bugfix loop on 2026-08-28 at HEAD 4b55fae: `git` is in src/loop.ts's import from "./git.js" (the two left-for-retry call sites at lines 422–423 compile), `npm run build` clean, full suite green (334/334). No code change needed this tick; the regression test for the left-for-retry path that introduced these call sites already landed with the first entry's closure (test/loop.test.ts, c7f4662).

### Build broken on main: src/loop.ts calls `git` without importing it (found by readme loop 2026-08-28, closed 2026-08-28; duplicate entry above closed the same day)

**Symptom:** `npm run build` — and therefore `npm test` — fails on main with two TypeScript errors:

```
src/loop.ts(402,15): error TS2304: Cannot find name 'git'.
src/loop.ts(403,15): error TS2304: Cannot find name 'git'.
```

Every loop inherits this because worktrees reset to main at tick start, so the whole fleet is blocked until it lands. Fourth instance of broken work landing on main; this one got through unreviewed because feature tick 47 (74224e9) is itself the commit that wired the review gate into the tick path — no gate existed before its own merge.

**Repro:** `npm run build` at HEAD 85a8a9a (any main since 74224e9).

**Cause:** Clean tick 91c199a (2026-08-28) removed the `git` import from src/loop.ts as unused — true at that moment. Feature tick 47 (an hour later) then added two new uses of `git(...)` in `recoverLeftover`'s left-for-retry path (`reset --hard HEAD` + `clean -fd`, keeping a failed-review commit on the branch for re-review instead of resetting to main) without re-adding the import.

**Resolution:** Already fixed on main before this entry landed: perf tick 36 (93b8535, 2026-08-28) re-added `git` to src/loop.ts's import block — one line, no behavioral change. The readme loop recorded the bug at a3e3d0b against HEAD 85a8a9a (where the build genuinely was broken), three commits after the fix merged, so the entry arrived stale; verified by the bugfix loop on 2026-08-28 at c2683be: `npm run build` clean, full suite green. The left-for-retry path itself had no end-to-end coverage (the two pre-existing leftover tests only exercise the approve and unmergeable-discard branches), so a regression test was added in test/loop.test.ts: a tick whose own review fails verdict-less strands its commit (`review_error`), the next tick's recovery re-review also fails under the strike cap, and the left-for-retry path keeps the commit on the branch for re-review while `reset --hard HEAD` + `clean -fd` drop an untracked stray file — a missing import here would error the tick instead. Full suite 325/325. Files: test/loop.test.ts.

### Build broken on main: feature tick 44 landed src/review.ts with a syntax error, type errors, and two failing recovery tests (reported by plan loop; detailed by readme loop, 2026-08-27, fixed 2026-08-27)

**Symptom:** `npm run build` — and therefore `npm test` — failed on main. Every loop inherited this because worktrees reset to main at tick start, so the whole fleet was blocked until it landed. Introduced by feature tick 44 (bad613e), which landed src/review.ts plus aheadOfMainDiff in src/git.ts without a green build. A third instance of broken work landing on main — precisely what the review gate was built to prevent, and it got through because the gate is not yet wired into the tick path (see PLANS.md's review-gate entry).

**Repro:** `npm run build` at HEAD `bad613e`, which introduced it. tsc reports only the syntax error first — parse errors suppress type-checking:

```
src/review.ts(184,5): error TS1109: Expression expected.
src/review.ts(184,26): error TS1005: ';' expected.
src/review.ts(184,42): error TS1005: '(' expected.
src/review.ts(184,47): error TS1005: ')' expected.
src/review.ts(184,55): error TS1003: Identifier expected.
```

Line 184 is `*before* overwriting lastReview with this failure.` — a continuation of the comment above it ("…Read") that lost its `//` prefix and carries markdown-style emphasis, so tsc parses it as code.

**Cause:** The reported syntax error was only the visible tip: tsc skips ALL semantic checks
while any file has a syntax error, so `bad613e` also carried six latent type errors under
tsconfig's `noUncheckedIndexedAccess: true`, all in new bad613e code that could never surface —
in src/review.ts (`pattern[i]` passed as `string | undefined` to `String.includes`; the last
VERDICT match possibly undefined) and in src/git.ts's new numstat parsing (three regex groups
used unguarded):
- src/git.ts:194–196 (TS2345 ×3): aheadOfMainDiff's numstat loop indexes the regex match as `m[1]`/`m[2]`/`m[3]`.
- src/review.ts:28 (TS2345): globToRegex passes `pattern[i]` to String.prototype.includes.
- src/review.ts:81–82 (TS18048 ×3): parseVerdict's `matches[matches.length - 1]` is not narrowed by the length check above it.

Beyond compilation, the same commit rewired `recoverLeftover` through the review gate — intended
design per PLANS.md, enabled by default in defaultConfig — but two pre-existing loop tests still
assumed pre-gate recovery: their fake pi never answered the reviewer run with a VERDICT line, so
the gate failed closed and recovery never happened (`npm test` red even after the build was
fixed) — neither "leftover commits from a failed merge are recovered on the next tick" nor
"unmergeable leftover commits are discarded with a warning on the next tick" passed.

**Fix:** Restored the missing `//` prefix on src/review.ts:184 (no behavioral change). Fixed the
latent type errors minimally, behavior-preserving: `pattern.charAt(i)` in globToRegex;
a fail-closed `if (!last) return null;` in parseVerdict; a group-presence guard in
aheadOfMainDiff's numstat loop. Updated the two recovery tests so their fake pi answers any run
whose prompt asks for a VERDICT (the reviewer run, identified by that string — it appears only
in buildReviewPrompt) with an approving verdict, matching the gate design that now routes
recovery through review. Added test/review-gate.test.ts: pure-function regression coverage for
parseVerdict / isExemptPath / isExemptDiff (importing review.js also fails `npm test` if this
file ever stops compiling again); the full gate-orchestration suite remains a remaining item
under PLANS.md's review-gate entry. Verified: build clean, full suite 299/299. Files:
src/review.ts, src/git.ts, test/loop.test.ts, test/review-gate.test.ts (new).

### Flaky test: "a resumed tick continues the interrupted session" fails with no_change under parallel load (found by bugfix loop 2026-08-27, fixed 2026-08-27)

**Symptom:** `npm test` intermittently failed exactly one test —
test/loop.test.ts "a resumed tick continues the interrupted session and keeps the worktree
edits" — with `assert.equal(outcome.result, "changed")` getting actual `'no_change'`. The same
test passed when its file was run alone (`node --test dist/test/loop.test.js`) and on a full-suite
rerun; observed once in two consecutive full runs at HEAD 64a057a while the machine was also
running an LM Studio fleet.

**Cause (confirmed):** The test's first phase aborted on a fixed 300 ms timer (`setTimeout(() =>
controller.abort(), 300)`) while the fake pi ran `echo partial > partial.txt\nexec sleep 30` in
the worktree. If process startup plus script execution took longer than 300 ms under parallel
load, the child was killed before `partial.txt` was written; the aborted tick then left no
uncommitted edits in the worktree, and the resumed tick — whose fake pi only prints a SUMMARY
line — found a clean tree and correctly reported `no_change`. The sibling test "an aborted tick
lands nothing" uses the same pattern but asserts only that nothing landed on main, so it passed
either way; only the resume test was sensitive. No harness code was at fault: a resumed tick over
an empty worktree reporting no_change is correct behavior.

**Fix:** The abort is now deterministic in test/loop.test.ts: the tick starts as a pending promise,
a new `waitForFile` helper polls (25 ms interval, 10 s bound) for `partial.txt` to appear in the
worktree — the fake pi's own half-done edit doubles as its readiness marker — and only then is
`controller.abort()` called; on wait timeout the controller aborts too so the hung fake pi child
does not linger. The sibling test was left untouched: it asserts nothing that depends on the
edit having landed. Verified with four concurrent `node --test dist/test/loop.test.js` runs under
four busy-loop CPU hogs — 39/39 each, resume test green in all four; full suite 286/286.
Files: `test/loop.test.ts`.

### Build broken on main: test/files.test.ts imports tail helpers from files.js after organize move (reported by plan loop 2026-08-27, closed 2026-08-27)

**Symptom:** `npm run build` — and therefore `npm test` — failed with TS2305 errors:
`Module '"../src/files.js"' has no exported member 'followFile' / 'readCompleteLines' /
'withTail' / 'TailState'`, plus cascading implicit-any errors in the same file. Every loop
inherited this because worktrees reset to main at tick start, so the whole fleet was blocked.

**Resolution:** Already fixed on main before this entry landed: commit 89828a5 ("clean tick
53", 2026-08-27 04:57) split test/files.test.ts's import exactly as prescribed —
`pruneOldFiles`/`rotateIfLarge` from "../src/files.js", `followFile`/`readCompleteLines`/
`withTail`/`type TailState` from "../src/tail.js". The plan loop reported the bug at 05:00
against HEAD 3946050 (where the build genuinely was broken), three minutes after the fix merged,
so the entry arrived stale. Verified by the bugfix loop on 2026-08-27 at HEAD 64a057a:
`npm run build` clean, full `npm test` suite green (278/278). No code change needed this tick.

### TUI crashes and GUI goes blind while tumwater.json is transiently broken (found by bugfix loop 2026-08-27, fixed 2026-08-27)

**Symptom:** `snapshot()` in status.ts — the data source for every observer surface (`tumwater
status`, TUI, GUI) — called strict `loadConfig()`, which throws when tumwater.json is malformed or
holds invalid values. The orchestrator tolerates this by design (its live-reload poll uses
`loadConfigSafe` and keeps its last-known-good config), but the observers did not: a user editing
tumwater.json live — a documented feature — would crash the TUI process with an uncaught exception
in its 1-second render interval mid-edit, and the GUI's `/api/status` answered 500 so the page
showed "connection lost" although the fleet was running fine. Found by latent-bug sweep;
reproduced by corrupting tumwater.json in an initialized repo and calling `snapshot()`.

**Fix:** `snapshot()` now loads config via `loadConfigSafe` with a per-root last-known-good cache:
a successful load updates the cache, a failure falls back to the cached config (or defaults when
this process never saw a valid file) — so observers keep rendering live loop state against a sane
role set instead of dying or going blind. The error stays discoverable in `tumwater logs`: the
orchestrator's reload poll already emits a warning event for an invalid file. One-shot CLI startup
paths (`run`, `reset-counters`) deliberately still fail fast on a broken config. Regression test:
test/status.test.ts — corrupting (invalid JSON) and misconfiguring (validation error)
tumwater.json no longer throws, the last known-good role set is kept, and a repaired file takes
effect again. Files: `src/status.ts`, `test/status.test.ts`.

### gen / peak ctx columns should show the current or last run, not cumulative totals (reported 2026-08-25, fixed 2026-08-26)

**Symptom:** The `gen` and `peak ctx` columns accumulated across a loop's whole lifetime: they only
grew, so after days of ticks they showed multi-day totals that said nothing about what the fleet is
doing now. User decision (2026-08-25): per-tick semantics — reset both when starting a new tick,
so a working loop's columns show what this tick has generated so far and an idle loop's show its
last completed tick.

**Fix:** `LoopRunner.tick()` now resets `generatedTokens`/`peakContextTokens` to 0 at the top,
alongside `ticks += 1`, **before** the start-of-tick save — so the on-disk values are 0 while a
tick is in flight, `runRolePi` accumulates every pi run of the tick (main + transient-timeout
retry + conflict resolution) into them, and the end-of-tick save persists exactly that tick's
totals. Display needed no logic change: `displayTokenMetrics` already combines persisted + live
for running loops — with a per-tick reset, a working loop shows precisely the current run's live
output and an idle loop its last completed tick as-is (doc comment updated; double-counting can
no longer happen). `zeroCounters` now also zeroes `peakContextTokens`: under per-tick windows it
holds the last completed tick's peak, so a fresh observation window must clear it or sleeping loops
keep showing their old value until they next tick. Known accepted edge: mid-tick the live display
resets on each new `session` event, so with several pi runs in one tick the column shows only the
latest run while earlier runs' tokens sit in memory until the end-of-tick save; it self-corrects at
tick end. Regression tests: two consecutive ticks with known fake-pi usage → persisted values
reflect only the second tick, not the sum (test/loop.test.ts); `zeroCounters` zeroes peak ctx
(test/state.test.ts); reset-counters clears per-tick peak ctx on disk (test/cli.test.ts). Files:
`src/loop.ts`, `src/state.ts`, `src/status-render.ts` (doc comment), `test/loop.test.ts`,
`test/state.test.ts`, `test/cli.test.ts`.

### Merge conflicts logged as warnings in the main log although they are normal operation (reported 2026-08-25, fixed 2026-08-25)

**Fix:** The routine conflict → pi-resolve hand-off no longer logs a `warning` event at all —
dropped entirely, as the scope allowed: success lands as an ordinary `merged` event and failure
surfaces via the tick's merge_conflict result / lastResult cell. All other warnings (discarding
unmergeable leftovers, model-server retry, …) are untouched. Landed in commit 7e0d789 with a
regression test asserting the resolve-and-land path emits no warning events; this entry was left
open by mistake and moved to Fixed on 2026-08-26 after verifying the fix against main. Files:
`src/loop.ts`, `test/loop.test.ts`.


### gen / peak ctx columns sit at 0 while loops work for many turns; counters only move at tick boundaries (reported 2026-08-25, fixed 2026-08-25)

**Symptom:** After a loop has been working "for a while, taking many turns", the `gen` and
`peak ctx` columns of the TUI/GUI tables sit at 0 (or frozen at their pre-tick values), while the
state cell next to them shows live detail (`working Xm · turn N · ctx Yk`) that updates
continuously. The table looks self-contradictory: actively generating, yet zero tokens generated.

**Cause:** `generatedTokens`/`peakContextTokens` are persisted only at tick boundaries
(`LoopRunner.save()` at tick start/end) and both tables rendered them from the state file — so a
loop mid-tick (30–60+ minutes on this fleet, i.e. most of the time) showed its pre-tick values for
the whole run while `turn N · ctx Y` (from `readLiveProgress` over the raw log) updated every
second.

**Fix:** The two columns are now live-aware exactly like the state cell: `LiveProgress` gains
`outputTokens` (usage.output summed over assistant message_ends of the current run) and
`peakContextTokens` (max, not sum), both reset on `session` events. A new shared helper
`displayTokenMetrics` (status-render.ts) combines persisted + live for running loops only — gen =
persisted + live output so far this tick, peak ctx = max(persisted, live). Idle loops show
persisted values as-is: their log tail describes the last COMPLETED tick, whose tokens are already
persisted (combining would double-count); a stale `running` flag after a crash is still correct to
combine because an unfinished tick's tokens were never persisted. Used by both `renderStatus`
(rows and totals) and the GUI `/api/status` payload (`generated`/`peakCtx` field names unchanged,
so gui-page.ts needed no change). Regression tests: progress accumulation/reset unit tests;
renderStatus shows growing gen during an in-flight tick from a synthetic log and does not
double-count idle loops' tails; GUI payload combines for running loops only. Files:
`src/progress.ts`, `src/status-render.ts`, `src/gui.ts`, `test/progress.test.ts`,
`test/status-render.test.ts`, `test/gui.test.ts`.

### Zombie streams defeat the quiet watchdog: loops stuck for hours on "turn 1" (reported 2026-08-24, fixed 2026-08-24)

**Symptom:** Several loops showed `working <hours> · turn 1` (director 6h, perf 9h) with LM Studio
mostly idle. Their pi logs held one `turn_start` and then thousands of `message_update` events —
each with completely empty content (0 chars, 0 tokens) — arriving every few seconds for hours. The
generation behind the request was dead (severed by sleep/wake or stuck in the server queue), but
the connection stayed open dripping keepalive updates. Those bytes reset the quiet watchdog's
clock, data-on-the-wire satisfied pi's HTTP idle timeout, and the tick timeout was hours away — so
nothing fired.

**Fix:** The watchdog now measures **progress, not bytes**. `PiStreamParser.progressCount`
increments for structural events (turns, tool calls, message boundaries, retries) and for
`message_update` only when the streamed content actually grew (chars + tokens above the message's
high-water mark). `runPi`'s quiet check kills the child when no *progress* happens for
`quietTimeoutSeconds`; content-free keepalives no longer reset it. stderr still counts as
progress (crash traces are meaningful). Error message is now "killed as hung: no pi progress
for over Ns". Regression tests: an endless empty-keepalive stream is killed within the window; a
slow-but-growing stream and structural events keep a run alive. Files: `src/pi.ts`,
`test/quiet-watchdog.test.ts`.

### Loop hung ~10 hours on an interactive command; no guard fired (reported 2026-08-24, fixed 2026-08-24)

**Symptom:** The feature loop showed `working 9h48m · … · no pi output for 6h58m` while LM Studio
sat idle. Its pi run had executed a bash tool command that launched tumwater's own TUI under
`script` (a pseudo-TTY) to test it — `runTui` exits only on Ctrl+C, so the tool call blocked
forever. A second loop sat stuck for 6h in an HTTP request that could wait forever because pi's
idle timeout had been fully disabled (`httpIdleTimeoutMs: 0`, our earlier workaround for slow
prefills). Neither hit the tick timeout because it had been raised to 15h ("try not to timeout").

**Fix (three layers):**
1. **Quiet watchdog** (`quietTimeoutSeconds`, default 1800, 0 disables): `runPi` kills the child
   when it emits no stdout/stderr for the window, checked on a wall-clock interval so it fires
   promptly even across machine sleep. Healthy-but-slow runs stream events continuously and are
   unaffected (regression-tested); hung tools and zombie sockets die in ~30 min instead of eating
   the whole tick timeout. Reports as a timeout: partial work is discarded, error tick, backoff.
2. **Prompt rule** in COMMON_RULES: never run commands that can wait or run indefinitely
   (interactive programs, servers, watch modes); impose a hard time limit when testing such
   programs and never allocate them a TTY expecting input.
3. **pi settings**: `httpIdleTimeoutMs` set to 1800000 (30 min) instead of 0 — long enough for
   the worst legitimate prefill, finite so zombie sockets cannot hang a turn forever.

Files: `src/pi.ts`, `src/types.ts`, `src/config.ts`, `src/prompt.ts`, `test/quiet-watchdog.test.ts`.

### Clean conflict resolutions rejected as conflicted when files contain seven-equals lines (found by bugfix loop 2026-08-23, fixed 2026-08-23)

**Symptom:** When a merge conflict in a file containing a line that starts with exactly seven `=`
characters — e.g. a markdown setext heading (`History` / `=======`) or an RST section underline of
length 7 — was resolved correctly by pi, the harness still flagged it as unresolved:
`hasConflictMarkers` matched its bare-separator pattern against legitimate content, so
`resolveConflict` aborted the merge and discarded the work. The next tick's `recoverLeftover`
re-merged, hit the same conflict, pi re-resolved correctly, got rejected again — an endless
token-burning loop that never landed (backoff only spaces out the retries). Found by latent-bug
sweep; reproduced with a scratch script before fixing.

**Cause:** The marker regex `/^(<{7}|={7}|>{7})( |$)/m` treated any line starting with exactly
seven equals as a leftover conflict separator. Git's real separator is always part of a block that
also carries `<<<<<<< ` and `>>>>>>> ` start/end markers, but content lines of exactly seven `=`
are common in docs (setext/RST underlines matching a 7-character heading such as "History",
"Summary", or "License").

**Fix:** `hasConflictMarkers` now checks only the start/end marker patterns (`^<{7}( |$)` /
`^>{7}( |$)`) — every real conflict block carries them, and content lines starting with seven `<`
or `>` are far rarer than seven-`=` underlines. A resolver that leaves only a bare separator line
behind is treated as resolved; its stray line is content the project's own tests can catch.
Regression tests: unit tests in test/git.test.ts (leftover blocks still detected, setext
underlines not flagged, deleted files count as resolved) and an end-to-end tick test in
test/loop.test.ts where a clean resolution of a conflicted markdown file with a 7-character setext
heading lands on main. Files: `src/git.ts`, `test/git.test.ts`, `test/loop.test.ts`.

### Director loses queued user prompts when a tick fails without landing work (reported 2026-08-23, fixed 2026-08-23)

**Symptom:** A prompt submitted via TUI/GUI/`tumwater prompt` is dequeued from the inbox at the
start of the director's tick (`tickPrompt()` in `src/loop.ts`). If that tick then ended with an
error and no file changes (pi failure, timeout, spawn error), the raw user prompt was never
re-queued — it was silently lost. Only an aborted tick (harness shutdown) re-queued it.

**Fix:** `runTick` now captures the dequeued prompt before clearing `pendingUserPrompt` and
re-queues it on every unfulfilled outcome: abort (existing), harness timeout, and pi failure
without changes. A `no_change` outcome is deliberately NOT re-queued — a question-type prompt is
legitimately answered with no file changes, and re-queuing those would loop forever. Merge
failures are also not re-queued: the work stays on the branch and `recoverLeftover` lands it on a
later tick (re-queueing there would run the request twice). Regression tests in
test/loop.test.ts: failing-tick and timed-out-tick re-queue cases, plus guards that fulfilled
(changed) and handled-without-changes (no_change) prompts are not re-queued. Files:
`src/loop.ts`, `test/loop.test.ts`.

### Ticks fail with "Engine protocol predict stream timed out" after machine sleep/wake (reported 2026-08-23, fixed 2026-08-23)

**Symptom:** After the Mac wakes from sleep, every loop that had an in-flight pi request logged a
tick error: `error — Engine protocol predict stream timed out after 600000ms without receiving
data.` (LM Studio kills predict streams idle >600 s of wall time; OS sleep halts inference
mid-request). On Aug 22 the machine cycled sleep/wake roughly every 15–30 min all day and ~46
wake events produced 33 failed ticks across all roles. Each failure also counted toward
`consecutiveErrors`, so two such failures dropped the loop's pi session even though the session
was healthy — the world froze, it wasn't poisoned.

**Fix:** The signature is now detected in `PiStreamParser` (`transientServerTimeout`, matching
"predict stream timed out" in any event/message error text — kept narrow on purpose so a false
positive cannot mask real repeated failures) and propagated as `PiRunResult.transientServerTimeout`.
`LoopRunner.runRolePi` retries the pi run exactly once on that signature (resuming the session
the first attempt created or extended; tokens/cost of both attempts are folded into state), so a
sleep/wake event no longer fails the tick — fresh requests succeed within seconds of a wake. A
double failure still ends in an error tick, but it is flagged `transient` on the outcome and
excluded from `consecutiveErrors`, so healthy sessions survive (backoff still applies as
protection against a still-sleeping machine). Worst-case tick duration is now 2 ×
`tickTimeoutSeconds`. Regression tests: parser-level flag tests in `test/pi.test.ts`; end-to-end
tick tests in `test/loop.test.ts` covering the retry-success and double-failure paths. Files:
`src/pi.ts`, `src/loop.ts`, `src/types.ts`, `test/util.ts`, `test/pi.test.ts`, `test/loop.test.ts`.

### Ticks failing with "terminated" after ~20 minutes under concurrent load (reported 2026-08-22, fixed 2026-08-22)

**Symptom:** Loops intermittently ended ticks with `error — terminated` after almost exactly
20m20s; pi's retries (3) all failed the same way. LM Studio's server log showed no errors, and
session contexts were well under the model window, ruling out context overflow.

**Cause:** pi sets undici's `headersTimeout`/`bodyTimeout` from its `httpIdleTimeoutMs` setting
(default 300000 ms). With several loops prefilling tens of thousands of tokens concurrently on a
local server, a turn can take >5 minutes before the first response byte, so undici severs the
connection — undici's error string is "terminated" — and each retry repeats the same doomed
prefill: initial attempt + 3 retries × 5 min ≈ 20m20s.

**Fix:** `"httpIdleTimeoutMs": 0` (disabled) in `~/.pi/agent/settings.json`; the harness's
`tickTimeoutSeconds` (90 min) remains the guard against truly hung runs. Documented in README
("Notes on local model servers"). No tumwater code change needed — the existing
consecutive-error session reset already contained the blast radius.

### TUI: status table wider than terminal — rows wrapped and misaligned (reported 2026-08-20, fixed 2026-08-21)

**Fix:** `renderStatus` now takes a max width (the TUI passes `process.stdout.columns`, the
one-shot status command its own TTY width). When the content-sized table overflows, the
`last result` column shrinks first, then `state` (each to a 12-char minimum), and every cell and
line is ellipsis-clipped so no rendered line exceeds the terminal width — rows can no longer wrap.
Tests: test/status-render.test.ts. Files: src/status.ts, src/tui.ts, src/cli.ts.

### TUI: status table scrolled off the top as recent activity grew (reported 2026-08-20, fixed 2026-08-21)

**Fix:** Same root cause (unbounded line widths breaking the logical-line height budget). Every
TUI line — table (via width-aware renderStatus), event lines, flash/hint, and the input line
(which now shows its tail when long) — is clipped to the terminal width, so one logical line is
exactly one visual line and the existing height budget is exact; the table stays pinned at the
top. Files: src/tui.ts, src/status.ts.

### LM Studio logs flooded with WARN lines while loops run (reported 2026-08-20, resolved 2026-08-21)

**Resolution:** Captured the exact text from `~/.lmstudio/server-logs`:
`Reasoning setting 'high' is not supported by model 'unsloth/Qwen3.8-27B-GGUF/…'. Supported
settings: 'on', 'off'. Falling back to reasoning setting 'on'.` — suspected cause 1 (unsupported
thinking level), and it is benign: pi forwards its configured thinking level, the GGUF model only
exposes an on/off reasoning toggle, and LM Studio falls back to `on` with reasoning still enabled.
One WARN per request, no behavioral impact. Documented in README ("Notes on local model servers")
with the silencing option (configure a supported thinking level). No code change warranted at the
tumwater layer.

### Spurious warning "pi finished without changes and without declaring nothing-to-do" (reported 2026-08-21, fixed 2026-08-21)

**Fix:** Sentinel detection now covers the whole reply: `PiStreamParser` sets a
`declaredNothingToDo` flag whenever *any* assistant message contains the sentinel (previously only
the last message's text was kept in `finalText`, so a declaration in an intermediate turn was lost
to a later closing remark — cause 1). The flag is propagated as `PiRunResult.nothingToDo` and
checked by `runTick` instead of `isNothingToDo(pi.finalText)`; `finalText` remains the last message
for `extractSummary`. The warning is now diagnosable: an abnormal stopReason (e.g.
`(stopReason=length)` for a truncated final reply — cause 3) and/or "no assistant text" are appended
to the event message. Cause 4 (lenient `ok` on non-zero exit with text) was deliberately left as-is:
it changes error-event behavior and is worth its own decision.
Regression tests: parser-level sentinel-survival test in `test/pi.test.ts`; end-to-end tick tests in
`test/loop.test.ts` asserting no spurious warning when the sentinel appears mid-run, plus the new
diagnostic suffixes. Files: `src/pi.ts`, `src/loop.ts`, `src/types.ts`, `test/pi.test.ts`,
`test/loop.test.ts`.
