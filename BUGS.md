# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed.

## Open

### A rejected `mainGreen` latches a false "main is red" when the redeploy's own git call fails (found by bugfix loop 2026-09-15, while fixing the toolchain-red entry)

**Symptom:** The 2026-09-15 toolchain failure reached the redeploy latch by two routes. The suite-failure route (a check that ran and exited nonzero on toolchain noise) is fixed: it now reads as a `toolchain` skip. The other route survives: when the `mainGreen` promise itself REJECTS — `ensureDetachedWorktree`'s git call failing inside the mirror worktree, e.g. git breaking between the orchestrator's own `rev-parse` of main and the mirror checkout — `track()` records the rejection with `error` set and `result` unset, and `Redeployer.poll` treats `result !== true` identically to a verified red: `block(mainHead, "main <sha> is red", …)`, no retry until main moves (src/redeploy.ts's `poll`). A toolchain broken hard enough to defeat the mirror checkout still latches a false red, and the fleet self-heals only when main moves — the same disease the sibling entry fixed, one code path down.

**Repro:** `fakeDeps({ mainGreen: () => Promise.reject(new Error(…)) })` drives exactly this shape in test/redeploy.test.ts ("a thrown green check blocks like a red one"): the poll ends in a block with `restartBlocked = "main bbbbbbbb is red"`, and no later poll re-checks the head.

**Note:** the current behavior is deliberate and pinned — the Redeployer's doc says "Nothing here is fail-open: a red main, a failed compile, or a swap error blocks the restart", and that test pins a thrown check blocking. A fix is a design change, not a classification change: distinguish "the check returned red" (a verdict — block, as today) from "the check could not run" (a rejection — e.g. drop the pending head, log one warning per episode, retry on the next poll, mirroring the baseline cache's "a red is provisional" stance). Sibling: the fixed "broken toolchain … main is red" entry below (the suite-failure half of the same incident).

## Fixed

### No operator lever wakes a backed-off fleet: `reset-counters` preserves the schedule and a restart reloads it (found by human log analysis 2026-09-15, fixed 2026-09-15)

**Symptom:** After the 2026-09-15 outage every loop sat with `backoffSeconds` 7680 and `nextRunAt` up to two hours out. With the root cause fixed — license accepted, git working — there was no way to tell the fleet to try again. `tumwater reset-counters` is the obvious candidate and does nothing for this: `zeroCounters` deliberately preserves `nextRunAt` and `backoffSeconds`. Restarting the orchestrator does not help either, since loop state is reloaded from disk and `isEligible` still honours `nextRunAt` (its "startup" reason applies only at `ticks === 0`). The only two levers are moving main — `isEligible`'s "main moved" wake — and queuing a director prompt, which carries no backoff. Neither is discoverable as "wake the fleet", and the first is unavailable precisely when it is most needed: on a self-hosting fleet, the loops are normally the only thing that commits.

**Repro:**
1. Put a loop into deep backoff (a long `no_change` or `error` run, or stop the fleet and set `nextRunAt` far ahead in `.tumwater/state/<role>.json`).
2. `tumwater reset-counters --role <id>`, then read the state file: `nextRunAt` and `backoffSeconds` unchanged, the loop keeps sleeping.
3. Restart the fleet: the loop still sleeps until its original `nextRunAt`.

**Expected:** an operator who has fixed whatever the loops were failing on should be able to say so — `tumwater wake [--role <id>]`, or a flag on an existing command — clearing `backoffSeconds` and setting `nextRunAt` to now for the named roles.

**Suspected cause:** not an oversight in either place, but a gap between them: src/state.ts:43–53 documents `zeroCounters` as an observation-window reset that preserves scheduling fields on purpose, and src/cli.ts:243–249 writes only the counters-reset request. `pause`/`resume` gate whether new ticks start but never touch backoff. No command targets the schedule.

**Fix:** a new `tumwater wake [--role <id>]` command rides the same on-disk marker convention as `reset-counters` and `abort`: the CLI clears each target's (or every role's) schedule in the state file — `clearBackoff` zeroes `backoffSeconds` and pulls `nextRunAt` to now, counters, wake tracking, and the daily budget window untouched, so `zeroCounters`' documented observation-window semantics stay intact — and drops a `wake.json` marker that a running fleet's poll consumes within one cycle: `consumeWakeRequest` calls the new `LoopRunner.wake()` on each affected runner, which mutates the in-memory state in place and persists it (eligibility is read from the in-memory copy, so the file alone would not wake anything, and the in-flight-tick in-place rule from `resetCounters` applies). A corrupt marker wakes every runner (an idempotent superset), and each woken role logs the existing `wake` event with reason `operator`, so the fleet's early ticks read in the feed as deliberate. A stopped fleet benefits too: the state-file rewrite makes the loops immediately due on the next `tumwater run`. The command is documented in the README usage block next to `reset-counters`.

**Files:** src/state.ts (`clearBackoff`); src/paths.ts (`wakeRequestPath`); src/loop.ts (`LoopRunner.wake`); src/orchestrator.ts (`consumeWakeRequest` in the poll); src/cli.ts (`wake` command + help line); README.md (usage); test/state.test.ts (`clearBackoff` mutation); test/cli.test.ts (fleet-wide and `--role` wake; unknown/missing role fails without side effects); test/cli-args.test.ts (flag rejection); test/orchestrator-2.test.ts (a backed-off loop ticks within one poll of the marker; a corrupt marker wakes every runner).

### Repeated tick failures raise no alarm: 44 errors across all 13 loops looked exactly like a quiet fleet (found by human log analysis 2026-09-15, fixed 2026-09-15)

**Symptom:** During the 2026-09-15 git outage the fleet logged 44 `tick_end result:error` events between 06:00 and 09:36, every one carrying the identical error string, across all 13 loops — and not one `warning` event, no state flag, no dashboard signal. The TUI and GUI showed loops sleeping, which is indistinguishable from a healthy fleet with nothing to do. The outage went unnoticed for 3 h 38 m and surfaced only because a human asked why nothing was running. The harness warns on far smaller anomalies — high-friction ticks, stalled tool calls, cut-off streaks, red main, deferred auto-restarts — but not on its entire fleet failing identically.

**Repro:** break git as in the entry above, run the fleet for an hour, then `grep '"type":"warning"' .tumwater/log/events.jsonl` over the window: empty. `tumwater status` reports the loops as sleeping with no indication that every one of them last failed.

**Expected:** a run of consecutive error ticks — especially the same message across several roles — should raise one harness-level warning, using the once-per-episode pattern the codebase already has (redeploy's `blockedHead` / `cooldownWarnedHead`, main-red's `lastMainRedSha`), and should read in status/TUI/GUI as a distinct health state rather than as ordinary idleness.

**Suspected cause:** src/loop.ts:423–437 — `applyTickOutcome` followed by a `tick_end` event carrying `error: s.lastError` is the only record a failure leaves; nothing aggregates across ticks or across roles. `LoopState` has no consecutive-error counter: the `consecutiveErrors` field still sitting in on-disk state files is vestigial — no code under src/ reads or writes it — so neither the loop nor the orchestrator can see a streak even in principle.

**Fix:** the vestigial `consecutiveErrors` field is revived as the loop's consecutive-`error`-tick streak: `applyTickOutcome` increments it on every `error` outcome and resets it to zero on any other result (src/state.ts, mirroring `cutOffStreak`). `LoopRunner.tick()` emits exactly one `warning` event when the streak crosses the new `ERROR_STREAK_WARN = 3` threshold — `${n} consecutive tick failures: <lastError>` — and because `applyTickOutcome` is the streak's only writer and increments by one, the crossing (streak equal to the threshold) happens exactly once per episode; a fourth failure deepens the episode without re-warniing, and a healthy tick re-arms it for the next episode. The per-role filing (rather than one fleet-wide aggregate) means a fleet-wide outage now raises one warning per role inside minutes — each naming the error text — instead of silence. `loopPhase` (src/ui/status-render.ts) returns a new `failing` label for an idle loop whose `lastResult` is `error` and whose streak is at or past the threshold, checked ahead of the sleep/queue states, so `tumwater status`, the TUI, and the GUI (which also colourizes via the existing `.error` class) read a stuck fleet as failing instead of sleeping; the label is self-clearing — the first non-error tick resets the streak and rewrites `lastResult`. The streak persists in the loop's state file, so a restarted observer keeps reading `failing`.

**Files:** src/types.ts (`LoopState.consecutiveErrors`); src/state.ts (`ERROR_STREAK_WARN`, streak increment/reset in `applyTickOutcome`); src/loop.ts (once-per-episode warning in `tick()`); src/ui/status-render.ts (`failing` phase in `loopPhase` + doc); test/state.test.ts (streak increments on error, resets on any other result, re-arms per episode); test/loop.test.ts (regression: three consecutive error ticks raise exactly one warning, a fourth does not re-warn, and the persisted state carries the streak); test/status-render.test.ts (regression: `failing` at/above the threshold, ordinary labels below it, in-flight ticks untouched, state cell in the table).

### A broken toolchain is reported as "main is red", and the verdict then latches until main moves (found by human log analysis 2026-09-15, fixed 2026-09-15)

**Symptom:** At 05:44:40 on 2026-09-15 — 20 minutes after the Xcode update broke git, 16 minutes before the first tick failure was logged — redeploy's green check ran main's `npm run test`, the suite failed because much of the harness's own test suite shells out to git, and the harness logged `main 1384eeb0 is red — holding the restart until main is green`. Main was not red: the same suite on the same commit passed 972/972 in an isolated clone once git worked. The false verdict pinned the fleet to build ecb58b7f, 14 commits stale, and `Redeployer.block` latches `blockedHead` with no retry until main moves — so the fleet could not re-check its own verdict. Together with the backoff entry above (every loop asleep, so nothing could move main) the fleet had no path back on its own; recovery came only when a human commit landed on main at 09:43.

**Repro:** break git as in the first entry, then let a redeploy poll run a green check at a stale head. The suite fails on git-dependent cases, the head is recorded red, `restartBlocked` appears in orchestrator.json, and no later poll re-checks it.

**Expected:** build-check already separates an environmental skip from a real failure — `skipReason: "timeout" | "no-npm"` makes both the review gate's pre-check and the main-red gate warn-and-proceed instead of blocking. A failure caused by a broken toolchain rather than a broken tree belongs in that same category. Failing that, a red verdict should not latch indefinitely when the evidence behind it is a toolchain error.

**Suspected cause:**
- src/build-check.ts:198,208 — `skipReason` is set only for a kill/signal (timeout) and a missing npm; every other non-zero exit is classified as a genuine `failed`, whatever the output says.
- src/redeploy.ts:280–282 — a non-green result calls `block(mainHead, …)`, and src/redeploy.ts:249 refuses to retry while `blockedHead === mainHead`, so the verdict survives until main moves.
- The harness's suite depends on git across a large fraction of its cases, so a broken git reliably produces a red verdict for reasons that have nothing to do with the tree under test.

**Fix direction:** classify toolchain-level failures as environmental skips — a cheap preflight probe before the check (`git --version` / `git rev-parse`, unambiguous and fast) and/or matching the captured output for known toolchain errors (git exit 69, "You have not agreed to the Xcode license agreements", "xcrun: error"). Return them as a new `skipReason` so they warn-and-proceed like `no-npm` and never latch `blockedHead`. Tests: build-check unit tests for the new classification (a stub check exiting with a toolchain error reads as skipped, an ordinary test failure still reads as failed); a redeploy test that a toolchain skip leaves no latched block.
**Fix:** toolchain-level failures now read as an environmental skip — a new `skipReason: "toolchain"` — with two detectors in `runBuildCheck` (src/build-check.ts): a preflight `probeToolchain()` runs `git --version` (10 s cap) before the check and reads "broken" when git ran and exited nonzero (the check is skipped without running; "missing" — a spawn errno — still proceeds, since a check whose script never touches git runs fine without one); and a nonzero run whose captured output matches the known signatures (`/you have not agreed to the \S+ license/i`, `/xcrun: error/i`) is a skip rather than a `failed`. Every skip consumer warns-and-proceeds exactly as before (`runScopedBuildCheck`'s gate pre-check and landing re-check, `mainRedGate`'s authoring gate — each with new wording), the main baseline stays `null` — never cached red — and `mainIsGreen` reads the skip as green, so the `Redeployer` proceeds to the compile instead of latching a false "main is red". An ordinary nonzero exit with no toolchain signature is still a deterministic `failed`.

**Files:** src/build-check.ts (`probeToolchain`, `TOOLCHAIN_ERROR_PATTERNS`/`toolchainErrorInOutput`, `runBuildCheck` classification, `"toolchain"` in both `skipReason` unions, skip-warning wording); src/main-red.ts (toolchain skip-warning wording); src/merge.ts (doc comment); test/build-check.test.ts (regressions: a broken probe skips before the check runs, toolchain output in a failed run reads skipped not failed, a git-less PATH still runs a git-free check, `checkMainBaseline` reads a toolchain-failing suite as a skip — never red — and re-checks the same SHA once the toolchain is fixed); test/redeploy.test.ts (regression: the production `mainIsGreen` wiring on a toolchain-failing suite leaves no latched block and the restart proceeds). A related residual — a REJECTED `mainGreen` promise (git failing inside the mirror worktree itself) still latches red — is tracked as its own open entry above; its current blocking behavior is deliberately pinned by test/redeploy.test.ts's "a thrown green check blocks like a red one".

### A tick that fails in 200 ms climbs the idle-backoff ladder: one broken `git` put the whole fleet to sleep for hours (found by human log analysis 2026-09-15, fixed 2026-09-15)

**Symptom:** An Xcode.app update at 05:24 on 2026-09-15 invalidated the accepted Xcode/SDK license, so `/usr/bin/git` (the xcrun shim) exited 69 with "You have not agreed to the Xcode license agreements" on every call. From 06:00:43 every fresh tick died in ~200 ms at `git worktree add` inside `ensureWorktree`. Because `applyTickOutcome` routes `error` into the same exponential `idleBackoff` ladder as `no_change`, each loop doubled from 120 s to 7680 s in six free failures over ~2 h; by 09:38 all 13 loops were parked with next ticks 16–121 minutes out and nothing running at all. 44 error ticks in the episode, no work done by any of them. The ladder's cap is `idleBackoff.maxSeconds` (36000 s = 10 h), so a persistent environmental fault can park a fleet for ten hours on failures that each cost a fifth of a second.

**Repro:**
1. Shadow git with a failing stub on the fleet's PATH: `printf '#!/bin/sh\nexit 69\n' > /tmp/fakebin/git && chmod +x /tmp/fakebin/git`, `PATH=/tmp/fakebin:$PATH tumwater run`.
2. Watch `.tumwater/log/events.jsonl`: every loop logs `tick_start` / `tick_end result:error` ~200 ms apart.
3. Read `.tumwater/state/<role>.json` after each failure: `backoffSeconds` doubles 120 → 240 → 480 → … → 7680 → 15360 → 36000 while no tick ever reached pi.

**Cause:** `applyTickOutcome`'s final `else` (src/state.ts) caught `error` alongside `no_change`, `merge_conflict`, `main_red` and the rest, and advanced the single `idleBackoff` ladder from tumwater.json (`initialSeconds` 120, `factor` 2, `maxSeconds` 36000). No branch distinguished "this tick ran the model and found nothing" from "this tick could not start", so free failures climbed the ladder whose 10-hour cap exists to price hour-long model runs.

**Fix:** failed ticks (`error` outcomes) now climb a distinct short ladder — `ERROR_BACKOFF` in src/state.ts: 30 s initial, ×2 factor, 600 s cap — while `no_change` and the other unproductive outcomes keep the idle ladder byte-identical. `nextBackoffSeconds` now takes a `BackoffConfig` ladder instead of the whole config; the ladders share one `backoffSeconds` field and each step advances from the current value, so an error streak capped at 600 s never sleeps less than the loop already was, and the idle ladder resumes from that value when the failures stop. Productive ticks (`changed`/`rejected`) still zero the backoff. The ladder is a built-in constant, not a knob: the minute-order cap is the point.

**Files:** src/state.ts (`ERROR_BACKOFF`, ladder-parameterized `nextBackoffSeconds`, `error` branch in `applyTickOutcome`); src/loop.ts (tick doc comment); test/state.test.ts (regression: ten consecutive `error` outcomes cap at 600 s, `no_change` laddering and its 3600 s ceiling unchanged, idle→error and error→idle cross-ladder steps, `changed`/`rejected` zeroing); test/orchestrator.test.ts + test/state.test.ts (helper call sites pass the ladder).

### Display clippers violate their length invariant at degenerate budgets: truncate(s, 0) and clipToWidth(line, -1) return almost the whole input (found by bugfix loop 2026-09-14, fixed 2026-09-14)

**Symptom:** `truncate("abc", 0)` returned `"ab…"` — 3 characters for a 0-character budget — and `clipToWidth(line, -1)` returned everything except the last character. Both break their documented "the result never exceeds max/width" invariant, which the TUI/GUI rely on for one-logical-line-per-visual-line rendering (an over-budget string wraps and breaks the layout).

**Repro:** against the pre-fix source, `truncate("abc", 0)` → `"ab…"` (len 3 > 0); `truncate("a", 0)` → `"…"` (len 1 > 0); `clipToWidth("abcdef", -1)` → `"abcde"` (len 5). The invariant tests swept `max` from 1 (truncate) and `width` from 0 (clipToWidth), so the degenerate side of the boundary was never exercised.

**Cause:** both clippers compute the cut as `max - 1` / `width - 1` and take `s.slice(0, cut)`; for a non-positive cut, `slice(0, -n)` drops n trailing characters instead of keeping none, so a degenerate budget silently becomes "almost the whole string". Latent, not user-facing: every current caller passes a positive constant (the transcript/progress/commit budgets) or a non-negative computed column width, so no surface could hit it — the guard makes the invariant hold for ANY budget, the way the sibling width-0 path already did.

**Fix:** `truncate` returns "" for `max <= 0` (a non-positive budget fits nothing — not even the ellipsis); `clipToWidth` returns "" for `width < 0` (width 0 already produced ""). Regression tests pin the degenerate inputs, and truncate's invariant sweep now starts at max 0.

**Files:** src/text.ts (truncate guard + doc); src/ui/status-render.ts (clipToWidth guard + doc); test/text.test.ts (degenerate-budget regression + sweep from 0); test/status-render.test.ts (negative-width regression).

### Gate verdicts were persisted only at tick boundaries: a sudden death mid-run resurrected a stale reject note into every later tick (found by bugfix loop 2026-09-14, fixed 2026-09-14)

**Symptom:** A bugfix tick on 2026-09-14 started with a "Your previous change was rejected in review" note about commit d3429a2 — a source-only attempt the gate had correctly rejected (its old test still asserted "n/a today"). The replacement fix (ab176a5, source + tests) was then approved and merged WITHIN the same tick 57 minutes after the prompt was built (the reviewer run was long). Had the process died between the gate's verdict and the tick's end save, the stale reject would have stayed the persisted state: every subsequent tick of that role would carry the note pointing at rejected work already superseded by approved work on main — misdirecting any fresh authoring run, which has no memory of what happened mid-tick (the note is the only cross-tick record).

**Repro:** `events.jsonl` of 2026-09-14 shows bugfix tick 18:35:24 with `review_verdict` approve @ 19:32:15 and `merged` @ 19:33:00, while `.tumwater/state/bugfix.json` still held the 14:41:57 reject until that tick's end save. Generalized: seed a reject verdict in the role's state file, land an approved commit through the lander, `kill -9` the process before the tick's end save — the state file on disk still holds the reject.

**Cause:** loop state is written to disk only at tick start, tick end, and reset-counters (`LoopRunner.save`). The review gate records its verdict in memory (`state.lastReview`, `state.lastApprovedHead`) DURING the tick — which then continues through the landing and a full authoring run that can take hours. `landChange` (src/lander.ts, the shared gate+landing path used by both the tick's own landing and leftover recovery) mutated the live state object but nothing persisted it until the tick's end save, so any ungraceful death in that window lost the verdict and the next process re-saved the stale snapshot at its own tick end.

**Fix:** `landChange` now calls `saveLoopState` immediately after `reviewAheadOfMain` returns — one atomic write per landing, covering both gate callers since they funnel through the shared lander. The verdict (approve/reject/failed) is durable before the tick's tail runs; the tick's end save remains the final authority for counters and scheduling.

**Files:** src/lander.ts (immediate `saveLoopState` after the gate + comment); test/lander.test.ts (regression: seed a stale reject on disk, land an approved commit, read the state file back — the approve and `lastApprovedHead` must be durable, not just in memory).

### Budget badge reads "n/a today", and its GUI link opens a cap editor pre-filled with 50 on all-free fleets (reported by user 2026-09-14, fixed by bugfix loop 2026-09-14)

**Symptom:** On a fleet whose models are all free (the n/a budget state introduced by the 2026-09-08/09 badge fix), both dashboards show `· budget: n/a today` — the "today" is nonsensical: with no priced model there is no daily spend to speak of. In the GUI the badge is additionally still a clickable link; clicking it opens the daily-cap editor pre-filled with `50` (the default cap), inviting the operator to edit a value that can never bind. The TUI has the same affordance via Ctrl+B, which opens the cap editor unconditionally.

**Repro:** point tumwater.json at all-free models (a local-server model with no `cost` in pi's models.json), run the fleet, and look at the header badge (`· budget: n/a today`); in the GUI click the badge (the editor opens pre-filled with 50), in the TUI press Ctrl+B (the editor opens pre-filled with the cap).

**Cause:** three independent homes of the same free state: status-render.ts's `budgetBadge` appended "today" to the free branch (the single home of the TUI/status header string, shipped preformatted to the GUI as `budgetBadge`); gui-page.ts's `renderBudgetBadge` always rendered the badge as `<a id='budgetbadge'>`, and the page's delegated click handler opens `openBudgetEditor()` for any such click, pre-filling `lastStatus.budget.capUsd`; tui.ts's Ctrl+B handler toggled `budgetMode` unconditionally, pre-filling the last snapshot's cap.

**Fix:** `budgetBadge` returns ` · budget: n/a` for the free state (checked first, in every cap state; dollar and no-cap branches byte-identical as before). `renderBudgetBadge` renders plain text — no link, no pointer, so the delegated click handler cannot match it — when `d.budget.free`, and keeps the link and editor for every other state. The TUI's Ctrl+B, on a free fleet, flashes `budget n/a — all models free` for 3 s and leaves the prompt line untouched (toggle/Esc logic unchanged). Doc comments in status-render.ts and status.ts updated.

**Files:** src/ui/status-render.ts (`budgetBadge` free branch + doc comment); src/ui/status.ts (doc comment); src/ui/gui-page.ts (`renderBudgetBadge` free branch); src/ui/tui.ts (`currentBudgetFree` + Ctrl+B notice); test/status-render.test.ts (free-state strings), test/gui.test.ts (free branch renders no link — the marker-delimited budget-edit block is eval'd against a DOM stub; priced and disabled states still render the link), test/tui.test.ts (free-fleet Ctrl+B flashes the notice with the prompt untouched — temp $HOME holding an unpriced models.json).

### Stall warning for a tool call pi started without a toolName names nothing (or with a leading space) (found by bugfix loop 2026-09-13, fixed 2026-09-13)

**Symptom:** When pi's `tool_execution_start` event omits `toolName`, runPi's stall warning — the feature that exists to name a hung command in the event feed — degraded: with no recognizable arg key it emitted `tool call stalled:  — no output for 5m` (empty name, double space), and with one (e.g. `args.command`) it emitted `tool call stalled:  sleep 999 — …` with a leading space after the colon. The code comment in src/pi.ts claims "the warning names the command even when pi omits a toolName"; only half of that held.

**Repro:** feed PiStreamParser a start line without `toolName`: `{ type: "tool_execution_start", toolCallId: "c1", args: { command: "sleep 999" } }` → the open-call label is `" sleep 999"` (leading space); with `args: {}` it is `""`. The stall warning renders that label verbatim. Pinned by test/pi.test.ts ("a start without toolName still names the command…", "a stalled call without toolName warns with the bare command named") and test/text.test.ts (describeToolCall).

**Cause:** src/text.ts, `describeToolCall` — it unconditionally joined name and detail as `${toolName} ${detail}`, so an empty name left a leading space (or nothing at all when no arg key matched). src/pi.ts passed `event.toolName ?? ""` straight through with no fallback, unlike src/ui/progress.ts which guards (`label ?? "tool"`) — the two surfaces of the same state machine disagreed on the nameless case.

**Fix:** `describeToolCall` now returns the bare detail when the name is empty (no leading space) and still `""` when neither name nor recognizable arg exists; src/pi.ts falls back to `"tool"` in that last case, mirroring progress.ts's stall flag so both surfaces always name something.

**Files:** src/text.ts (`describeToolCall`); src/pi.ts (open-call label fallback); test/text.test.ts (describeToolCall), test/pi.test.ts.

### A stalled tool call is invisible until the quiet watchdog kills it — stall warning names the command in the event feed and state cell (reported by user 2026-09-12, fixed by bugfix loop 2026-09-13)

Fixed (fix direction 2 of the original report): a tool call open with no content-bearing
`tool_execution_update` for `toolCallStallSeconds` (new config field, default 300 s; 0 disables)
is surfaced while it is happening, on both surfaces:
- **Harness warning event:** `PiStreamParser` tracks open tool calls by pi's `toolCallId`
  (pi runs a message's tool calls concurrently by default), moving each call's activity clock
  only on content-bearing updates — bash emits one empty-content update right after start, and a
  content-free keepalive must not mask a hang the way it cannot reset the quiet watchdog. The
  check interval in `runPi` warns once per stalled call (`tool call stalled: <label> — no output
  for N m/s`), wired to a `warning` event in src/loop.ts (author runs and SUMMARY follow-ups)
  and src/review.ts (reviewer runs). The warning is independent of the kill: it fires even while
  sibling calls keep streaming, and still when the quiet watchdog itself is disabled.
- **Dashboard flag:** `LiveProgress` tracks open calls from the raw log tail; `readLiveProgress`
  recomputes a `stalledTool` label on every read (silence is wall-clock time, not any single
  line) against the same configured threshold (`toolCallStallMs`, resolved through
  loadConfigCached), and the in-flight detail cell renders `tool call stalled: <label>` — taking
  lastTool's slot when it is that tool instead of repeating the label. Both TUI and GUI get it
  through the shared status payload / phase string.

`describeToolCall` moved from src/ui/tool-call.ts to src/text.ts so the harness layer can name
the hung command without importing presentation; `toolUpdateHasContent` (src/pi-event-line.ts)
is the one content check both layers share. Direction 4 of the original report (lowering the
default quietTimeoutSeconds now that a warning lands first) was not taken: the kill default is
unchanged at 1800 s.

Regression tests: test/pi.test.ts (open-call tracking, warn-once with the command named, no
warning when the call ends in time, 0 disables), test/progress.test.ts (tail-side tracking,
stalledToolLabel, threshold resolution), test/status-render.test.ts (cell names a stalled call,
never flags a fresh one), test/loop-2.test.ts (end-to-end: the warning lands in events.jsonl
while the run is still alive).

### A single tool call with no timeout blocks a whole tick — trigger removed and quiet-kills now preserve work (reported by user 2026-09-12, fixed by bugfix loop 2026-09-13)

A hung bash tool call (`find /` issued from a node_modules-less worktree) blocked the whole
tick for ~20 min with nothing on any dashboard to distinguish it from a slow turn, and when the
quiet watchdog finally fired the kill landed as an unfulfilled timeout whose next-tick reset
discarded the run's ~1h50m of work. Fixed (fix directions 1 + 3 of the original report):
- **Trigger removed:** `COMMON_RULES` (src/prompt.ts) now carries a Scope rule — never run an
  unbounded scan or write above the worktree (`find /`, `grep -r /`, recursive searches rooted
  outside the repo), and to inspect a dependency's types read the borrowed install at the repo
  root (`../../node_modules`) directly instead of widening the search outward.
- **Kills are non-destructive:** `PiRunResult.quietKilled` (src/pi.ts, src/types.ts) is distinct
  from `timedOut`; a quiet-killed author run lands as tick result `quiet_killed`, which resumes
  promptly like an interruption — the pi session and the worktree's uncommitted edits are kept
  (`resumePending` + new `LoopState.resumeCause = "hung-tool"`), and the resume bridge names the
  real cause ("no progress long enough to trip its hang watchdog … do not re-run it unchanged")
  instead of claiming a restart. Director ticks keep their existing recovery (prompt re-queued,
  fresh run); killed runs never take the transient-retry path.

Regression tests: test/prompt.test.ts (scope rule in every tick prompt; hung-tool bridge),
test/pi.test.ts (a stalled run reports `quietKilled`, not `timedOut`), test/loop.test.ts (a
quiet-killed tick keeps its edits, resumes with `--continue`, and the kept work lands on main),
test/loop-2.test.ts (both watchdog tests updated to the non-destructive contract).

Remaining: the stall is still invisible until the kill — see the open sibling entry above.

### Maintenance roles tick on their normal clock while planned features or open bugs wait — deferral is reactive, not backlog-aware (reported by user 2026-09-12, fixed by bugfix loop 2026-09-12)

**Symptom:** With entries under PLANS.md `## Planned` and/or BUGS.md `## Open`, all nine maintenance roles keep starting due ticks on their scheduled clocks. The existing need-based deferral fires only when the last tick was `no_change` AND no feature/bugfix/director/human commit landed since — so a maintenance loop whose last tick landed something, or whose wake coincides with any landing, runs anyway and consumes slots the work roles could use (feeding the slot-wait inversion in the sibling entry above).

**Repro:**
1. Leave at least one `###` entry under PLANS.md `## Planned` (or BUGS.md `## Open`).
2. Let a maintenance role's last tick land a change (`lastResult` ≠ `no_change`), or let any commit land on main so `workLandedSinceLast` is true.
3. On its next due poll the role starts a new tick although feature/bugfix work is still queued — `deferTick` returns false because one of its four conjuncts fails, and it never consults backlog state.

**Expected:** while PLANS.md `## Planned` or BUGS.md `## Open` on main is non-empty, due maintenance ticks (scheduled or main-moved) from idle loops defer exactly like today's deferral — `nextRunAt` untouched, re-checked every poll, one `tick_deferred` event per episode — until the backlog drains. The pending-business exception stands: a loop whose last tick ended in error, review rejection, merge failure, or main-red recording still runs (its own unfinished business must not stall), as do never-ticked loops; work roles are not deferrable at all.

**Suspected cause:**
- src/orchestrator.ts:143 — `deferTick(s, role, workLandedSinceLast)` has exactly four conjuncts; none consult PLANS.md or BUGS.md.
- src/orchestrator.ts ~line 468 — the poll computes only `landed` (`workLandedSince`) and passes it in; backlog state is never read on this path, even though src/backlog.ts already exports cheap section-heading parsers for exactly these two sections.

**Fix direction:** compute `workBacklogOpen = plannedPlans(root).length > 0 || openBugs(root).length > 0` once per poll (src/backlog.ts:100/105 — the same parsers `/api/backlog` uses) and pass it to `deferTick` as a fifth argument; defer when `DEFERRABLE_ROLES.has(role) && s.lastMainHead !== "" && s.lastResult === "no_change" && (workBacklogOpen || !workLandedSinceLast)`. When `workBacklogOpen` is true the git-range consult can be skipped entirely (deferral holds regardless of `landed`). Update `deferTick`'s doc comment and the README "How it works" deferral paragraph (one sentence: while planned features or open bugs remain, idle maintenance ticks stay deferred). Tests in test/orchestrator.test.ts: deferTick unit cases — backlog non-empty defers an idle loop even when work landed; backlog empty preserves today's behavior exactly; `lastResult` ≠ `no_change` never defers regardless of backlog. Accepted edge: a permanently blocked backlog (e.g. entries carrying Refused notes) keeps maintenance deferred — intended per the user request; clearing or revising the entry lifts it on the next poll. Cross-reference: sibling entry under ## Fixed (tier-ordered slot wait, fixed by bugfix loop 2026-09-12) — together they implement this user request; that one fixes the inversion, this one stops new maintenance ticks starting while backlog is non-empty.

### Slot wait queue is FIFO across polls: a due feature/bugfix tick queues behind maintenance ticks that requested slots earlier (reported by user 2026-09-12, fixed by bugfix loop 2026-09-12)

**Symptom:** With many planned features waiting in PLANS.md, the dashboards show an `improve` loop `working` while the feature loop sits `queued`. The README promises "Slot allocation orders the work roles (feature, bugfix, plan) ahead of every maintenance role", but that ordering only holds within one poll's kickoff batch — a maintenance tick that requested a slot in an earlier poll always takes a freed permit before a work-role tick that became due later.

**Repro:**
1. `maxConcurrent` 2 (or any value admitting ≥ 2 ticks). Get a maintenance tick in flight, and let another maintenance role become due so its task calls `semaphore.acquire()` and parks in the wait queue.
2. While that waiter is parked, make feature due (scheduled or main-moved wake); its task also calls `acquire()` behind it.
3. When a slot frees, `release()` hands the permit to the FIFO head — the maintenance tick — so feature stays `queued` (status-render.ts's final fallback: due, not running, no gate) behind lower-priority work.

**Expected:** a work-tier (feature/bugfix/plan) request jumps ahead of pending maintenance-tier requests for a freed slot, matching `fairOrder`'s documented tier order across polls as well as within one. In-flight ticks are untouched — they run to completion; only the ordering of WAITING requests changes. The director never waits on the semaphore (`usesSlot` false), so it is unaffected.

**Suspected cause:**
- src/semaphore.ts — `Semaphore.waiters` is a plain FIFO array (`push` in `acquire`, `shift` in `release`/`setCapacity`); no tier or priority notion at all.
- src/orchestrator.ts ~line 491 — every role task calls the same unprioritized `semaphore.acquire()`; `fairOrder` (~line 480) orders only tasks started within one poll, so an earlier-poll maintenance waiter always precedes a later-poll work-role waiter.

**Fix direction:** give `Semaphore` tier-aware acquisition — e.g. `acquire(tier: number)` where the call site passes `roleTier(runner.role)` (src/roles.ts already maps feature/bugfix/plan → 0, everything else → 1) — and on each arrival insert the new waiter ahead of all pending waiters with a strictly greater tier value (stable FIFO within a tier). `release`/`setCapacity` keep granting to `waiters.shift()`, so only the insertion order changes; the shrink/inUse bookkeeping stays as is. Applies unconditionally — it makes cross-poll slot allocation match the already-documented within-poll ordering, no backlog condition needed here. Tests: test/semaphore.test.ts (maintenance waiter parked, then a tier-0 `acquire` jumps ahead; two same-tier waiters stay FIFO; shrink semantics unchanged) and one cross-poll contention case in test/orchestrator.test.ts if it hosts slot tests. Update the README "How it works" scheduling paragraph to say the tier order holds across polls (one sentence). Cross-reference: sibling entry under ## Open (backlog-aware deferral) — together they implement this user request; this one fixed the inversion, that one stops new maintenance ticks starting while backlog is non-empty.

**Fix:** `Semaphore.acquire` now takes the waiter's scheduling tier: on arrival a waiter inserts ahead of every parked waiter with a strictly greater tier (stable FIFO within a tier), so a work-role tick that becomes due in a later poll jumps ahead of maintenance ticks parked from an earlier poll; `release`/`setCapacity` still grant to `waiters.shift()`, and the shrink/inUse bookkeeping is unchanged. The orchestrator's role task passes `roleTier(runner.role)` (feature/bugfix/plan → 0, everything else → 1); in-flight ticks are untouched — only WAITING order changes.

**Files:** src/semaphore.ts; src/orchestrator.ts (acquire call site); test/semaphore.test.ts (tier-jump, FIFO-within-tier, and no-starvation cases; existing capacity/shrink tests now pass tiers); test/orchestrator.test.ts (cross-poll contention: bugfix due while clean is in flight jumps ahead of parked dry); README.md (scheduling paragraph).

### TUI's Ctrl+B budget editor accepted hex and exponent notation as a dollar cap (found by bugfix loop 2026-09-12, fixed 2026-09-12)

**Symptom:** In the TUI's Ctrl+B daily-cost-budget editor, typing `0x10` set the fleet-wide spend cap to $16 and `1e2` set it to $100 — both accepted with a success flash. The GUI surface cannot produce these (its number input + JSON body yield plain numbers only), so the two surfaces disagreed on what "a valid daily budget cap" means even though both claim to implement the shared rule in config.ts (`checkDailyBudgetUsd`: finite ≥ 0).

**Repro:** `parseBudgetInput("0x10")` returned `{ ok: true, value: 16 }` — `Number()` reads hex strings as numbers; likewise `"1e2"` → 100. Only non-finite spellings (`Infinity`, `1e999`) were rejected.

**Cause:** src/ui/tui.ts, `parseBudgetInput` — the TUI is the only surface that converts free text to a number, and it used bare `Number(t)`, which also admits hex, finite exponent notation, and signed spellings as dollar amounts. No guard restricted input to plain decimals.

**Fix:** `parseBudgetInput` now requires a plain decimal spelling (`/^\d*\.?\d+$/` — "25", "12.34", ".5") before converting; the existing isFinite check stays as a backstop for absurd digit counts that overflow to Infinity. The TUI thus admits exactly what the GUI's number input and the server check admit. Regression cases added to test/tui.test.ts ("0x10", "1e2", "+5", 410 nines; ".5" pinned as still admitted).

**Files:** src/ui/tui.ts (`parseBudgetInput`); test/tui.test.ts.

### TUI/GUI "reviewing" state shows only elapsed time — no turn/ctx/tool detail like the "working" state does (reported by user 2026-09-11, fixed by bugfix loop 2026-09-12)

**Symptom:** While a loop's committed tick is under the adversarial review gate, both dashboards' state cell shows only `reviewing <elapsed>` (e.g. `reviewing 2m`) — no turn count, context size, or current tool/command. The same loop's in-flight author phase shows all of that (`working 3m · turn 12 · ctx 21.9k · bash npm test`), so an operator cannot tell whether the reviewer run is progressing or stalled until it finishes (the ≥5-min no-output stall flag that workingDetail adds is also absent from reviewing).

**Repro:**
1. Let any loop land a changed tick whose diff passes the deterministic build pre-check, so it enters the model review gate (`review_start` event; state cell flips to `reviewing …`).
2. Watch the TUI or GUI loop table while the reviewer run is in flight: the cell shows only label + elapsed, where the author phase of the same tick showed turn/ctx/tool detail.

**Cause:** src/ui/status-render.ts, `loopPhase` — the `s.phase === "review"` branch returns bare `inFlightLabel(s, "reviewing")`. The comment there records the original rationale: during review the raw log tail describes the reviewer run rather than the author's, so it showed the gate instead of pi detail. That discards exactly the live info an operator wants — the reviewer run's own progress.

**Fix direction:** render the same live detail for reviewing that `workingDetail` renders for working, labeled "reviewing": `<elapsed> · turn N+1 · ctx Xk · <last tool>` plus the existing ≥5-min no-output stall flag. The data is already available: the reviewer run writes to the same per-role raw log (src/review.ts passes `rawLogFile: piLogPath(root, role)` with label "review"), starts a fresh `session` event that resets readLiveProgress's counters (src/ui/progress.ts), and status-payload.ts already threads this frame's precomputed `live` tail into `loopPhase`. Implementation: extract workingDetail's parts assembly into a shared helper taking the label ("working"/"reviewing") and call it from both branches; keep the bare-label fallback when no progress is available. No new plumbing — `loopPhase` already receives `root` + `live`, and both surfaces render the payload string as-is (TUI via renderStatus, GUI via /api/status's `l.phase`), so one change covers TUI and GUI. Update the now-stale comment in the review branch. Note: during the deterministic build pre-check the phase is not yet "review" (src/review.ts sets it only after the pre-check), so that window keeps showing working detail with the author's final numbers — existing behavior, unchanged.

**Files:** src/ui/status-render.ts; tests in test/status-render.test.ts (loopPhase/workingDetail unit host) and test/status.test.ts / test/gui.test.ts if they assert on reviewing cells.

**Fix:** extracted workingDetail's parts assembly into a shared `inFlightDetail(s, label, p)` helper; the review branch of `loopPhase` now renders the reviewer run's live tail (the same per-role raw log, fresh `session` event) as `<elapsed> · turn N+1 · ctx Xk · <last tool>` plus the ≥5-min no-output stall flag, labeled "reviewing". Bare-label fallback kept when there is no root or no progress.

### readTranscriptTail scanned a stale stat size when rotation recreated the path with a smaller file between its stat and open: one line dropped from the window, `end` past EOF (found by bugfix loop 2026-09-11, fixed 2026-09-11)

**Symptom:** `readTranscriptTail` stats the path, then opens it. The sibling of the ENOENT race in the entry below — same stat→open window, but rotation renames the old log away AND a fresh file with content lands at the path before the open (rename plus an append). The scan still walks `st.size` bytes through an fd that now points at the smaller inode: reads past its EOF come back short, and the chunk-boundary check probes a byte offset computed from the stale size. The oldest complete line of the new file is held for an older chunk that never comes (the next read returns 0) and silently dropped — e.g. a run's `tumwater_run` marker, so `tumwater logs --role` renders its separator unlabeled — and the window's `end` offset lands past the real EOF; in follow mode (`logs -f`) a `followFile` started there resets to 0 and re-delivers every line the initial window already printed.

**Repro:** write three labeled runs to a pi log; wrap `fs.openSync` so the first open renames the file away and recreates it with two (smaller) labeled runs before opening; call `readTranscriptTail(file, 50)`. Before the fix: the first run's marker line is missing from `entries` (separator renders "run" instead of its label) and `end` equals the old size — past the new file's EOF. After the fix: `entries` equal `formatTranscript(new lines).slice(-limit)` and `end` ≤ real size.

**Cause:** the scan boundary came from `statOrNull(path)`, but every read goes through the opened fd, which after a rename+recreate points at a different inode. `forEachTailChunk` already re-bases on `fstatSync(fd)` for exactly this reason — `readTranscriptTail` was the one tail reader that didn't.

**Fix:** fstat the opened fd and scan its size (returning null when it is empty, same as the missing-file policy). One line plus a comment; no caller changes.

**Files:** src/ui/transcript-tail.ts; regression test in test/transcript-tail.test.ts (new `recreateSmallerOnOpen` helper in test/util.ts, sibling of `vanishOnOpen`).

### Tail readers threw ENOENT when log rotation renamed the file between their stat and open: a poll landing in that window crashed the TUI or `logs -f` process (found by bugfix loop 2026-09-11, fixed 2026-09-11)

**Symptom:** every tail reader stats its log before opening it (`statOrNull`, then `openSync`/`readFileSync`). Log rotation — events.jsonl at 16 MB in `logEvent`, pi logs at `logMaxBytes` — renames the path away, so a stat→open window straddling a rename throws ENOENT out of three primitives: `forEachTailChunk` (src/files.ts, both its read paths), `readCompleteLines` (src/ui/tail.ts), and `readTranscriptTail`'s own open (src/ui/transcript-tail.ts). The TUI's per-second render loop calls `readEvents`/transcript readers with no try/catch, so one rotation landing in the window killed the whole `tumwater tui` process; `followFile` (`logs -f`) and the GUI's 1-second /api/status poll were exposed the same way (the GUI degrades to a 500 instead of crashing). Long-running fleets rotate repeatedly, so each rotation is one dangerous instant for every observer polling at that moment.

**Repro:** write a log past the small-file threshold, wrap `fs.openSync`/`fs.readFileSync` to unlink the file on first access (exactly what the rename does to the path), then call the reader: all three primitives threw ENOENT where they should have returned no data. The same probes against the fixed build return nothing/empty/null without throwing.

**Cause:** the codebase's "a vanished file reads as no data" policy (statOrNull, terminateTornTail, followFile's guarded stat) was not honored in the three tail primitives' open step — they assumed the path their caller just stats would still exist.

**Fix:** each primitive now guards its open/read and degrades to its documented no-data result when the file is gone: `forEachTailChunk` delivers nothing, `readCompleteLines` returns `{lines: [], end: offset}` (the next poll re-stats and reseeds), `readTranscriptTail` returns null. One-line-class try/catch per site; no caller changes needed.

**Files:** src/files.ts, src/ui/tail.ts, src/ui/transcript-tail.ts; regression tests in test/files.test.ts, test/tail.test.ts, test/transcript-tail.test.ts (shared `vanishOnOpen`/`vanishOnReadFile` helpers in test/util.ts).

### Auto-restart completes on every stale episode under churn: rate-limit completed auto-restarts to at most one per 12 hours (reported by user 2026-09-11, fixed 2026-09-11)

**Symptom:** On a self-hosting fleet whose main churns (bugfix/feature work landing many commits an hour), every move of main past the running build's stamp drives a full auto-redeploy episode: green check → compile → hold, during which no new ticks start on any loop and in-flight role ticks are drained up to `RESTART_DRAIN_MAX_MS` (30 min) → swap → exit → respawn. Under sustained churn these episodes run back to back — the fleet halts for a drain window over and over (dashboards show `STALE: main +N`, then restart pending), interrupting work far more often than is desirable. The 30-minute cap bounds one episode's drain; nothing bounded how often episodes completed a restart.

**Repro:**
1. Dogfood with `autoRestart` true (or unit-test `Redeployer.poll` directly): let a first stale episode reach its swap — green main, compile ok, no in-flight ticks → poll returns "restart".
2. Move main again so the new build is stale; minutes later the second episode reaches the same point.
3. Before the fix both episodes returned "restart": `poll()` had no notion of when the last restart landed, so under churn the fleet redeploys — and halts for a drain — on every burst.

**Cause:** `Redeployer.poll` kept no record of when the last restart completed: every stale head drove a full hold+drain+swap cycle. `RESTART_DRAIN_MAX_MS` bounded one episode's drain; nothing bounded frequency across episodes. And the timestamp could not live in orchestrator.json — that file is per-process-lifetime (written at start, removed on exit), and auto-restart IS the process exit.

**Fix:** completed auto-restarts are now rate-limited to one per `RESTART_COOLDOWN_MS` (12 h, src/redeploy.ts). The last completion's timestamp persists in its own small JSON file under `.tumwater/state/` (`autoRestartStampPath`, src/paths.ts), read at construction through the new injectable `AutoRestartRecord` seam and written inside poll immediately before it returns "restart" — the process exits right after, so no later cleanup could write it. Inside the cooldown a stale head takes the blocked-restart path minus the latch: no pendingHead, no green check, no drain, no hold (poll returns "none", one warning event per episode), and status publishes `cooldown until <iso>` through the existing `restartBlocked` channel — re-evaluated on every poll rather than latched like `blockedHead`, so once the deadline passes the same head proceeds even if main never moves again. Only completed auto-restarts set the timestamp; a manual restart (Ctrl+C / `tumwater run`) neither counts toward nor resets it, because it goes through no Redeployer at all. Doctor's blocked sentence now reads "until main moves or the block clears" so its boilerplate does not contradict a deadline, and the README documents the rate limit in one sentence. Tests: three new regressions in test/redeploy.test.ts — deferral within the window (no hold, status carries the exact deadline, one warning per episode), proceeding past the deadline without another main move, and the timestamp surviving a process restart via its state file (including overwrite by the latest completion); the existing drain/director-exemption tests pass unchanged.

**Files:** src/redeploy.ts, src/paths.ts, src/orchestrator.ts (status clock), src/doctor.ts (wording), README.md; tests in test/redeploy.test.ts.

### readEvents' torn trailing line occupied one of the limit slots: while events.jsonl ended unterminated, feeds showed at most limit−1 events (found by bugfix loop 2026-09-11, fixed 2026-09-11)

**Symptom:** `readEvents` (src/events.ts) stops its backwards scan at `newlines >= limit + 1`, on the documented assumption that "the partial leading line, if any, is unparseable and skipped" — but a torn trailing line at EOF (no final \n) also becomes a split("\n") element, occupies one slot in `slice(-limit)`, and fails to parse. While events.jsonl ended with an unterminated line, every display surface (GUI feed limit 40, TUI, `tumwater logs`) showed at most limit−1 events even though the log held more complete lines.

**Repro:** write ≥ limit+2 complete event lines plus a final fragment without \n; readEvents returned limit−1 parseable events instead of limit.

**Cause:** slice(-limit) was applied before the torn tail was excluded. Unlike `readCompleteLines`/`followFile`, which hold back an unterminated trailing line until its newline lands, readEvents parsed (and silently dropped) it while still counting its slot.

**Fix:** when the concatenated tail text does not end with "\n", drop the last split element before slicing — holding the fragment back until its newline lands, the same policy as `readCompleteLines`. No-op for terminated or empty logs. Regression test in test/events.test.ts pins that a torn trailing line after limit+2 complete events still yields exactly `limit` events (the correct ones), not limit−1.

**Files:** src/events.ts; test in test/events.test.ts.

### logEvent glued a new event onto an unterminated trailing line: after a crash mid-append, one complete event was lost from every consumer (found by bugfix loop 2026-09-11, fixed 2026-09-11)

**Symptom:** `logEvent` (src/events.ts) appended with raw `fs.appendFileSync`. When the previous append was interrupted mid-write — kill -9 or power loss during the syscall, both documented recovery scenarios in the README — events.jsonl ended without a newline. The next append landed directly after the fragment: `{…torn{"ts":…,"type":"tick_end",…}\n` became one glued line that fails JSON.parse forever, so BOTH events were lost from every consumer until rotation (16 MB): `readEvents` (GUI/TUI feeds, `tumwater logs`) skipped it and `collectReport`'s totals undercounted by one tick/commit per crash. The harness's own policy for torn lines elsewhere is to hold them back until the newline lands (`readCompleteLines`: "a trailing partial line (torn write in flight) is NOT consumed") — but nothing on the writer side ever supplied that newline.

**Repro:** append an event, then `fs.appendFileSync(eventsLogPath(dir), '{"loop":"x","type":"tick_end","tick":1,"resu')` (no trailing \n), then logEvent again: before the fix the file held one glued line and readEvents returned only the first event.

**Cause:** append-only writers assume the previous write completed; torn tails were handled reader-side only — and even there incompletely (see the sibling open bug about readEvents' slot).

**Fix:** logEvent now calls a private `terminateTornTail(file)` after rotation: stat-or-missing, fstat the opened inode, read the last byte, and append one "\n" when it is not already — so the fragment becomes its own (unparseable but harmless) line and the new event starts on a fresh line. No-op for missing/empty/terminated files; never throws. Regression test in test/events.test.ts pins that after an unterminated tail, the next logEvent terminates it in place and readEvents returns both surviving events.

**Files:** src/events.ts; test in test/events.test.ts.

### /api/report coerced hex/scientific/signed `days` spellings instead of degrading to the default window (found by bugfix loop 2026-09-11, fixed 2026-09-11)

**Symptom:** the GUI report endpoint parsed its query param with raw `Number.parseInt(q.get("days") ?? "", 10)` instead of the shared plain-decimal parsers. Its own doc comment promises "missing or non-numeric → 14, out-of-range clamped" — but `?days=1e3` served a **1-day** window (parseInt stops at the exponent), `?days=0x10` a 1-day one (stops at `x`, coerces to 0 → clamps up), and `?days=-5` a 1-day one (signed coercion). Whitespace-padded (`%207`) and trailing-garbage (`14abc`) spellings were accepted too. The endpoint was added in `465f1f6`, *after* improve #132 (`de9c7ae`) had made the shared parsers "the one definition of what counts as a valid count or position across every input surface (CLI flags and the GUI's query params)" — its sibling endpoints in the same file all use them; only this one bypassed the rule. The existing test table even pinned the coercion (`["days=-5", 1]`).

**Repro:** `node -e 'console.log(Number.parseInt("1e3",10), Number.parseInt("0x10",10), Number.parseInt("-5",10))'` → `1 0 -5`; then `curl "http://127.0.0.1:<port>/api/report?days=1e3"` returned `"days":1` where the documented rule says 14.

**Cause:** a new endpoint re-implemented integer parsing inline with `Number.parseInt` instead of importing from src/cli-args.ts, silently reviving exactly the coercions de9c7ae removed project-wide.

**Fix:** handleReport in src/ui/gui.ts now uses `parseNonNegativeInt(q.get("days") ?? "")` (already imported for /api/backlog's index) and maps null → 14 before clamping to 1..90 — so only plain decimal digit strings are counts, `0` still clamps to 1 as before, and every other spelling degrades to the default window. The test table in test/gui.test.ts now pins `-5`, `1e3`, `0x10`, and `%207` → 14 alongside the existing clamp cases.

**Files:** src/ui/gui.ts; test in test/gui.test.ts.

### forEachTailChunk ignored onChunk's early stop, so every poll of a grown log re-read it whole (found by bugfix loop 2026-09-11, fixed 2026-09-11)

**Symptom:** dry #141 (`25852c6`) factored the bounded backwards tail-scan out of `readEvents` (src/events.ts) and `readWindowEvents` (src/report.ts) into `files.forEachTailChunk`, converting each loop's inline break condition into a `return true` from the callback — but the new helper discarded the return value. Its own doc comment promises "onChunk, which returns true to stop early once enough bytes are in hand", and per-poll I/O is supposed to be bounded by the caller's need, not the log's size (the event log rotates at 16 MB and observers poll `readEvents` every second). With the contract unenforced, any events.jsonl past the 8 KB threshold was read whole — up to 16 MB per observer poll — exactly the cost the refactor existed to remove.

**Repro:** write a file > 8 KB (e.g. 100 KB) and call `forEachTailChunk(file, () => true)`; before the fix all ~13 chunks were delivered instead of one. The pre-refactor loops both had explicit breaks (`if (newlines >= limit + 1 || end <= 0) break;` / `… dayKey(ev.ts) < fromKey) break;`) that the extraction dropped.

**Cause:** the extracted loop body kept reading and advancing `end` unconditionally after delivering a chunk, never inspecting `onChunk`'s boolean. Results were still correct (the stop condition only bounded I/O), so no output-level test caught it — only the documented contract was broken.

**Fix:** one line in src/files.ts — `if (onChunk(buf.subarray(0, got))) break;` before advancing `end`, restoring both callers' pre-refactor semantics exactly. Regression test in test/files.test.ts pins the contract: a 24 KB file delivers exactly one chunk when the callback returns true immediately (the newest 8 KB), all three chunks newest-first with exact contents when it never does, plus the small-file single-chunk and missing-file paths.

**Files:** src/files.ts; test in test/files.test.ts.

### The review gate checks the pre-rebase tree, so the bytes that land on main were never run through a check (found by human analysis 2026-09-08, fixed 2026-09-10)

**Symptom:** dry tick 130's gate build check passed at 19:31:45 on head `8ce7ecaf` (tree `18f9917`), whose base was `9a1847e`. The change landed 9 m 16 s later as `e014175` (tree `f89fecb`), rebased over the **14** commits that reached main while it was under review. The tree the gate verified is not the tree that became main. Concretely: `7730bb1` — one of those 14 — is the commit that added test/pi.test.ts's label-marker test, so `git show 8ce7ecaf:test/pi.test.ts | grep -c 'writes exactly one marker line'` returns `0`. The suite the gate ran did not contain the test that then failed against main (see the entry above).

**Repro:** deterministic — start a tick, let another role land on main while it is under review, then compare `git rev-parse <reviewed head>^{tree}` with the tree of the resulting main commit. The window is wide in practice: review runs 7–13 minutes on local hardware, and main moved four times in the hour before this incident.

**Cause:** ordering. src/review.ts ran the deterministic pre-check (`scope: "gate"`) against the branch head as it stood outside the merge lock; only afterwards did `mergeToMain` take the lock and rebase before fast-forwarding, with nothing re-verifying the rebased result — a textual rebase succeeding says nothing about semantic compatibility. Second-order defect from the same assumption: review.ts seeded `noteGreenBaseline(head)` with the *pre-rebase* head on the premise that "main now points at this very SHA"; whenever a rebase happened that SHA was never main, so the seeding silently missed and the next fresh tick paid a full redundant suite run — exactly the run that flaked in the entry above.

**Fix:** the landing path now owns verification of what actually becomes main. `mergeToMain` captures the branch tip before any rebase; inside the lock, after `rebaseOntoMain` and before `ffMainTo`, `verifyLanding` (src/merge.ts) re-runs the project's declared check on the rebased tree whenever it differs from the pre-merge head — a failure returns `merge_blocked` without landing, and the commit stays on the branch for the next tick's recovery, whose gate pre-check rejects it deterministically with the build tail injected into the author's prompt (no model run consumed). Skips: no-op rebase (the tree is byte-identical to what was already checked), doc-only deltas ahead of main (the gate's own exemption test), and projects with no declared check. An environmental skip (timeout/no-npm) warns and proceeds, the gate's existing policy — a hung script cannot wedge landings behind the lock. The pre-rebase seeding moved: `reviewAheadOfMain` now hands its green verdict to the caller as `GateResult.verifiedHead` (threaded through loop.ts's tick path and leftover recovery), and `verifyLanding` seeds `noteGreenBaseline` with the POST-rebase head — after a green in-lock run, or on a no-op rebase when `verifiedHead` names that tree. The pre-merge head is captured once per landing (not per attempt) so a pi-resolved conflict tree is re-verified too: its second rebase is a no-op, but its bytes are new. Each in-lock run lands as a `build_check` event with `scope: "landing"`. Note the accepted tension from the fix direction: an in-lock suite serializes landings only when main moved under a code landing (the common case stays free via the no-op skip), and Merge queue 5/5's coalesced stack check will subsume this run later. Tests: five new regressions in test/merge.test.ts (green/red re-verify, no-op skip + baseline seeding, exempt-delta skip, conflict-resolution re-verify); review.test.ts's old gate-seeding test rewritten as a `verifiedHead` handoff test; the stale seeding contract corrected in src/build-check.ts, src/redeploy.ts, and README.md.

**Files:** src/merge.ts, src/review.ts, src/loop.ts, src/leftover.ts, src/build-check.ts (docs), src/redeploy.ts (doc); tests in test/merge.test.ts, test/review.test.ts.

### README promises `tumwater init` seeds a git repo, but it refuses to run outside an existing one (found by qa loop 2026-09-08, fixed 2026-09-10)

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

**Actual:** src/init.ts:87 threw unless the cwd was already a git repository; the user had to run `git init` themselves first. The error message did guide them, so it was recoverable, but the docs promised behavior the product did not deliver.

**Cause:** init was written to assume an existing repo while the README wording ("seeds a git repo … and commits them") overstates what it does.

**Fix:** took the first option — `initProject` now runs `git init -b main` when the cwd is not yet a repository (src/init.ts), so the "seeds a git repo" promise holds for brand-new projects; `-b main` matches every doc reference and what `tumwater run` reports. The pure validations (prompt, README markers) moved ahead of that side effect, so an invalid prompt leaves no half-seeded repo behind. The CLI prints `initialized a new git repository on branch main`, and the Usage comment now reads "existing or new project dir". Tests: test/init.test.ts (seeding + validate-before-side-effect) and test/cli.test.ts (end-to-end in an empty directory).

- Budget badge shows `$0.00/$50` on free/local LLM fleets instead of n/a (reported by user 2026-09-08, fixed 2026-09-09; commit e0b817a)
- Auto-restart aborts an in-flight director tick after the 30-minute drain: the director should be exempt and waited for (reported by user 2026-09-08, fixed 2026-09-09; commit 00c7cc0)
- Review gate rejects a change for contradicting an already-recorded bug/plan instead of letting the newer user instruction win (reported by user 2026-09-08, fixed 2026-09-09; commit 47a9590)
- `runPi` resolves before its raw log flushes: a load-sensitive race that flakes the suite and can truncate a transcript (found by human analysis 2026-09-08, fixed 2026-09-09; commit 77f4837)
- Auto-restart's drain clock restarted on every main move: a 30-minute cap held the fleet for 38 (found by human 2026-09-08, fixed 2026-09-08; commit 7b83df3)
- Auto-restart deadlocked on a self-referential test: `npm test` fails in every worktree without a local install (found by readme loop 2026-09-08, diagnosed by human 2026-09-08, fixed 2026-09-08; commit 9656e1a)
- Harness never picks up its own new build: the fleet ran a 2026-08-27 build for ten days while 350 commits landed (found by human log analysis 2026-09-07, fixed 2026-09-07; commit 9499cf5)
- pi crashing on malformed JSON abandoned the session: five ticks lost, one of them 2 h 39 m of director work (found by human log analysis 2026-09-07, fixed 2026-09-07; commit a274605)
- Cut-off resumes were bridged as "the harness was restarted" and the cut-off streak froze at the resume limit (found by human log analysis 2026-09-07, fixed 2026-09-07; commit 418f620)
- Changed ticks whose reply lacked SUMMARY landed as "<role> tick N" — 73 commits, 32 of them feature (found by human log analysis 2026-09-07, fixed 2026-09-07; commit c30e885)
- GUI dashboard executes HTML in backlog entry bodies — unescaped innerHTML injection (found by bugfix loop 2026-09-06, fixed 2026-09-06; commit 6fe4dfe)
- Build broken on main: feature tick 105 dropped `openBugs` from test/backlog.test.ts's imports, and two of its new assertions could never pass (found by coverage loop 2026-09-06, fixed 2026-09-06; commit f6ad136)
- Non-ASCII text in pi output garbled when a multi-byte character straddles a stdout chunk boundary (found by bugfix loop 2026-09-03, fixed 2026-09-03; commit 07b7a7e)
- Tests red on main: feature tick 83's `today` column broke two layout assertions (found by readme loop 2026-09-03, fixed 2026-09-03; commit 02a8661)
- readTranscriptTail returns duplicated entries when a pi log starts with a blank line (found by coverage loop 2026-09-03, fixed 2026-09-03; commit 86e6559)
- Main's suite red: stale duplicate of the already-fixed fmtUsdCap test break — re-recorded from a pre-fix snapshot (re-recorded by readme loop 2026-09-02, closed 2026-09-02; commit 91a0843)
- Tests red on main: clean tick 91's fmtUsdCap assertion carries a stray quote and can never match GUI_PAGE (found by coverage loop 2026-09-02, fixed 2026-09-02; commit 91a0843)
- Main's build broken: organize tick 78 deleted git.ts's rebase/fast-forward/conflict helpers without landing their move into merge.ts (found by readme loop 2026-08-31, fixed 2026-08-31; commit 2cff978)
- Interrupted tick on a slow-clock role does not resume promptly: the min gap holds it for a full interval (found by bugfix loop 2026-08-30, fixed 2026-08-30; commit f773a49)
- Orphaned merge lock (no pid file) can never be broken — every merge times out forever (found by bugfix loop 2026-08-29, fixed 2026-08-29; commit 6c44004)
- Tests red on main: feature tick 57's new contract tests break on prompt line-wrapping (found by improve loop 2026-08-29, fixed 2026-08-29; commit 06de235)
- `reset-counters` consumed mid-tick wedges the loop: running flag stuck true until restart (found by bugfix loop 2026-08-28, fixed 2026-08-28; commit 97b9900)
- Build broken on main: feature tick 52's questions-outbox changes leave three test files stale (found by readme loop 2026-08-28, fixed 2026-08-28; commit 2d3376f)
- Build broken on main: feature tick 49's steward default fails noUncheckedIndexedAccess (found by readme loop 2026-08-28, fixed 2026-08-28; commit 43fc759)
- Build broken on main: src/loop.ts calls git() without importing it — stale duplicate of the readme-loop entry (reported by organize loop 2026-08-28, closed 2026-08-28; commit 93b8535)
- Build broken on main: src/loop.ts calls `git` without importing it (found by readme loop 2026-08-28, closed 2026-08-28; duplicate entry above closed the same day; commit 93b8535)
- Build broken on main: feature tick 44 landed src/review.ts with a syntax error, type errors, and two failing recovery tests (reported by plan loop; detailed by readme loop, 2026-08-27, fixed 2026-08-27; commit be7211a)
- Flaky test: "a resumed tick continues the interrupted session" fails with no_change under parallel load (found by bugfix loop 2026-08-27, fixed 2026-08-27; commit 3f90083)
- Build broken on main: test/files.test.ts imports tail helpers from files.js after organize move (reported by plan loop 2026-08-27, closed 2026-08-27; commit 89828a5)
- TUI crashes and GUI goes blind while tumwater.json is transiently broken (found by bugfix loop 2026-08-27, fixed 2026-08-27; commit 2a1607b)
- gen / peak ctx columns should show the current or last run, not cumulative totals (reported 2026-08-25, fixed 2026-08-26; commit e959944)
- Merge conflicts logged as warnings in the main log although they are normal operation (reported 2026-08-25, fixed 2026-08-25; commit 7e0d789)
- gen / peak ctx columns sit at 0 while loops work for many turns; counters only move at tick boundaries (reported 2026-08-25, fixed 2026-08-25; commit ff3b6f0)
- Zombie streams defeat the quiet watchdog: loops stuck for hours on "turn 1" (reported 2026-08-24, fixed 2026-08-24; commit d207095)
- Loop hung ~10 hours on an interactive command; no guard fired (reported 2026-08-24, fixed 2026-08-24; commit ab328e8)
- Clean conflict resolutions rejected as conflicted when files contain seven-equals lines (found by bugfix loop 2026-08-23, fixed 2026-08-23; commit b3b803b)
- Director loses queued user prompts when a tick fails without landing work (reported 2026-08-23, fixed 2026-08-23; commit 9b9803f)
- Ticks fail with "Engine protocol predict stream timed out" after machine sleep/wake (reported 2026-08-23, fixed 2026-08-23; commit 5e68229)
- Ticks failing with "terminated" after ~20 minutes under concurrent load (reported 2026-08-22, fixed 2026-08-22; commit 4d6bc50)
- TUI: status table wider than terminal — rows wrapped and misaligned (reported 2026-08-20, fixed 2026-08-21; commit 9ddd731)
- TUI: status table scrolled off the top as recent activity grew (reported 2026-08-20, fixed 2026-08-21; commit 9ddd731)
- LM Studio logs flooded with WARN lines while loops run (reported 2026-08-20, resolved 2026-08-21; commit 413050c)
- Spurious warning "pi finished without changes and without declaring nothing-to-do" (reported 2026-08-21, fixed 2026-08-21; commit 936b1c9)
