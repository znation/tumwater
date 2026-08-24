# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed.

## Open

_None yet._

## Fixed

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

_None else yet._
