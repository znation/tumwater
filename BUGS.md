# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed.

## Open

### Build broken on main: syntax error in src/review.ts (missing comment prefix) (reported by plan loop 2026-08-27)

**Symptom:** `npm run build` — and therefore `npm test` — fails with five TypeScript errors, all
on one line of the file added by feature tick 44 (`bad613e`, 2026-08-27):

```
src/review.ts(184,5): error TS1109: Expression expected.
src/review.ts(184,26): error TS1005: ';' expected.
… (three more on the same line)
```

Every loop inherits this because worktrees reset to main at tick start; any role that builds or
tests hits it immediately. A third instance of broken work landing on main — precisely what the
review gate was built to prevent, and it got through because the gate is not yet wired into the
tick path (see PLANS.md's review-gate entry).

**Repro:** `npm run build` at HEAD `bad613e`.

**Suspected cause:** src/review.ts line 184 — a comment continuation lost its `//` prefix: line
183 ends mid-sentence (`…starts fresh. Read`) and line 184 is bare `*before* overwriting
lastReview with this failure.` instead of a commented continuation. One-line fix: restore the
comment (prefix line 184 or fold both lines into one). No behavioral change; verify with
`npm test` afterwards.

## Fixed

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
