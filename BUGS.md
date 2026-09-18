# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed.

## Open

### The restart drain has never once completed: 38 of 39 redeploys held the fleet a full 30 minutes and then aborted 4–12 ticks anyway (found by log analysis 2026-09-18)

**Symptom:** `RESTART_DRAIN_MAX_MS` is 30 minutes on the stated premise that most ticks finish inside it (src/redeploy.ts:52-56: "Median ticks run ~35 min on local hardware; a half-hour drain lets most of them finish while bounding how long the fleet keeps executing stale code"). Of the 39 `restart` events in `events.jsonl` since 2026-09-08, **38 carry `drainedMs` at or past the cap** (1 801 272 – 2 267 835 ms) and each aborted 4–12 in-flight ticks. The single exception — 09-15 09:44:03, `drainedMs` 48 074, `abortedTicks` 0 — is the recovery restart after the Xcode-license outage, when every loop was already asleep. The drain has never once done what it exists to do on a working fleet.

Measured over 323 completed (non-aborted) ticks since 09-11: p50 **46 min**, p75 82 min, p90 144 min, mean 68 min, max 749 min. **60% of ticks run longer than the drain window.** The premise is off by a factor that grew with the model and the workload, not by a rounding error.

The cost is paid twice. Nothing new starts during a hold (src/orchestrator.ts's `holdForRestart` skips every runner and the land-queue drain), so the week's restarts held the fleet idle for roughly 19.5 h; and at the end of each hold 4–12 ticks are aborted anyway.

**Repro:** read the `restart` events: `grep '"type":"restart"' .tumwater/log/events.jsonl` — every `drainedMs` on a fleet with work in flight is the cap.

**Expected:** either the window should track observed tick duration (a p75 of completed ticks would drain ~82 min and actually let most ticks finish), or the fleet should accept that ticks outlive redeploys and stop paying for a wait that never pays off — abort promptly and lean on the resume machinery the doc already trusts ("Every tick a restart interrupts resumes on the new build … so a restart loses no work"). The current setting buys the worst of both: the full idle cost of waiting plus the full interruption cost of not waiting.

**Suspected cause:** a constant calibrated by hand against an earlier backend, never re-derived. Nothing in the harness measures tick duration and compares it to the drain window, so the premise in the doc comment has no way to be falsified by the running fleet — the `restart` event records `drainedMs` and `abortedTicks`, which is exactly the evidence needed, and no surface reads it.

## Fixed

### `maxConcurrent` stopped bounding model load when landings moved off the author semaphore: 4 concurrent pi streams for a quarter of the day (found by log analysis 2026-09-18, fixed 2026-09-18)

**Symptom:** `maxConcurrent` is the fleet's only lever over a single-GPU backend, and it no longer means what it says. The author semaphore is acquired in exactly one place (src/orchestrator.ts:662) and two pi-bearing paths bypass it: the land-queue drain starts its landing outside the semaphore entirely (src/orchestrator.ts:524-590 — deliberate, so authors keep ticking behind it), and the director skips the slot by `usesSlot`. The real ceiling is `maxConcurrent + 1 landing + 1 director`.

Occupancy reconstructed from `tick_start`/`tick_end` plus `landed`/`land_failed` durations, with `maxConcurrent: 3`: on 09-16 and 09-17 the fleet ran **4 concurrent pi-bearing runs 25–36% of the time** and 3 for most of the remainder; peak 4, with a director prompt able to make 5. For contrast, 09-11 → 09-13 (cap 2) never exceeded the cap at all, and 09-15 sat at 4 only 5% of the time. The land queue went live with the 09-15 22:14 restart (`bdec4f1`); the first full day on that build is 09-16, which is also the day `quiet_killed` went from never-observed to 23 occurrences.

**Repro:** run the fleet with a full land queue and count overlapping intervals in `events.jsonl`; or watch `.tumwater/worktrees/` during a queue drain — two `_land-<role>` suites plus the role worktrees run at once (observed 09-18 00:00:45–00:01:53, `feature` and `dry` gate checks overlapping).

**Expected:** one number that bounds concurrent model load, whatever the work is called. A landing's reviewer run costs the backend exactly what an author's run costs; exempting it from the cap because it is "COMMITTED work awaiting completion" is a scheduling-priority argument, not a capacity argument. A separate landing permit, or a shared cap with the landing taking priority within it, would keep the interlock's intent (authors keep ticking) without letting total load float.

**Suspected cause:** the exemption is documented at src/orchestrator.ts:512-523 and reasoned entirely about *fairness* — not pausing committed work behind the budget and user-pause gates — with no consideration of aggregate backend load, because when it was written the review gate ran inside the author's tick and therefore inside the semaphore. Moving the gate to the landing slot (merge queue 3/5) moved one pi stream out from under the cap without anything noticing.

**Fix:** the landing drain now acquires the same `maxConcurrent` permit role ticks do before its reviewer (or a batch's per-change gates) runs — `withLandingSlot` in src/orchestrator.ts. The permit is taken at `LANDING_TIER` (-1, below every `roleTier`), so a queued landing — committed work whose author the interlock has already blocked — jumps ahead of parked role waiters instead of starving behind them, while authors keep ticking on the remaining slots. The landing's wait is bounded by one in-flight tick, and a landing aborted while parked still aborts (and follows its ref-discard rule) once a slot frees. The director's bypass is unchanged and deliberate: an explicit human prompt outranks the autonomous cap, so the ceiling is now `maxConcurrent + 1 director` instead of `maxConcurrent + 1 landing + 1 director`.

**Files:** src/orchestrator.ts (`LANDING_TIER`, `withLandingSlot`, both landing-promise sites); test/orchestrator.test.ts ("a landing's reviewer run takes the same maxConcurrent permit as a role tick").

**Related:** the restart-drain and build-check findings from 2026-09-18 all worsen under this concurrency — the starved sessions, the 300 s check timeout, and the flaky tests' vanishing margins.

### A transient `ENOTEMPTY` on `dist.prev` aborts the whole build swap: no `rmSync` in the harness passed `maxRetries` (found by log analysis 2026-09-18, fixed 2026-09-18)

**Symptom:** Three times in nine days the auto-restart reached the swap and failed on a directory removal: `swapping the new build into place failed: ENOTEMPTY, Directory not empty: /Users/zach/tumwater/.tumwater/build/dist.prev '/Users/zach/tumwater/.tumwater/build/dist.prev'` — 09-09 13:30:35, 09-11 00:36:11, 09-17 16:04:42. The same path appears as both operands, which rules out either `renameSync` and points at the `fs.rmSync(prev, …)` calls that bracket them (src/redeploy.ts:435 and :444). A swap error blocks the restart for that head by design, so each occurrence left the fleet running the stale build until the next episode cleared it — 32 minutes on 09-11 (00:36 → 01:08), 37 on 09-17 (16:04 → 16:41).

**Repro:** not reproduced directly — it is a race, three occurrences in nine days. `fs.rmSync` with `recursive: true` walks the tree and then `rmdir`s; any entry appearing between the walk and the `rmdir` raises `ENOTEMPTY`, which on macOS is routine (Spotlight, `.DS_Store`) and is precisely the class Node's `maxRetries` exists for. `force: true` does not help: it swallows `ENOENT` only.

**Expected:** a transient `ENOTEMPTY` should cost a retry, not a redeploy. Node retries `ENOTEMPTY`/`EBUSY`/`EPERM` when `maxRetries` is set, and it defaults to 0.

**Suspected cause:** none of the 14 `fs.rmSync` call sites under `src/` passed `maxRetries` or `retryDelay`, so every recursive delete in the harness was one transient filesystem race away from throwing. The swap is where it hurts most, because `swapDist` is the one caller whose throw is load-bearing — it blocks the restart — but the same exposure sat in the staging cleanup loop and in the scratch-dir cleanups elsewhere.

**Fix:** added `removeTree(dir)` to src/files.ts — one place for recursive deletes, passing `maxRetries: 3, retryDelay: 100` so Node retries the `ENOTEMPTY`/`EBUSY`/`EPERM` class; a failure that survives the retries still throws, so `swapDist`'s error policy is unchanged. Every recursive `fs.rmSync` in the harness now routes through it: the staged-build clear, both `dist.prev` removals and the superseded-staging sweep in `swapDist` (src/redeploy.ts), the stale-worktree clear (src/worktree.ts), and both lock-dir removals (src/lock.ts). The non-recursive deletes (file cleanup, markers) keep `removeQuiet`/`fs.rmSync`, where the retry options do not apply.

**Files:** src/files.ts (`removeTree`); src/redeploy.ts, src/worktree.ts, src/lock.ts (call sites); test/redeploy.test.ts (swapDist clears `dist.prev` with retries enabled).

### A landing build check that times out merges to main unverified: one skip on 2026-09-16 turned main red for five hours (found by log analysis 2026-09-18, fixed 2026-09-18)

**Symptom:** `runScopedBuildCheck` classifies a timeout as an environmental `skipped` and the caller proceeds — at `landing` scope that means "proceeding to merge", so a commit whose post-rebase suite never finished lands on main with no verification at all. This happened once in the observed week and the consequence was immediate. From `events.jsonl` on 2026-09-16:

- `02:04:43` `build_check coverage scope:landing status:skipped`, warning `landing build check timed out after 300s; proceeding to merge`, then `merged` + `landed` for "Unit-test writeJsonAtomic's success and failure paths in json-files".
- `02:04:46` `plan` merges an md-only re-audit on top; main head is now `d3652c43`.
- `03:27:14` the next code tick's baseline check runs: `build_check dry status:failed`, warning `main d3652c43 is red`.
- `03:27` → `08:35` every code tick returns `main_red` — six `tick_end result:main_red` events across `dry` and `coverage`, "code merges blocked until main is green" — until an md-only `readme` merge at 13:03.

The only code change in that range is the unverified one: `plan`'s commit is md-only and review-exempt, so it cannot fail a suite. The landing check is the in-lock *post-rebase* re-check — the one run whose entire purpose is to catch a semantic conflict with whatever landed while the author was working — and skipping it is exactly how such a conflict reaches main.

The gate scope fails open the same way (`proceeding to model review`): `organize` 09-11 05:59:13, `perf` 09-11 06:17:56, `dry` 09-17 11:30:10. So does the red-main baseline (src/main-red.ts:60, `proceeding with authoring unverified`): `dry` and `coverage` both at 09-16 12:09:11. Six fail-open skips in the week.

**Repro:** make the declared check exceed `BUILD_CHECK_TIMEOUT_MS` (src/build-check.ts:141, 300 s) at landing scope — in production, run it while the fleet is at full concurrency — and watch the merge proceed on a `skipped` outcome.

**Expected:** a timeout is not an environmental skip. "npm is missing from PATH" and "the toolchain is broken" are genuine environment verdicts that say nothing about the tree; "the suite did not finish in 300 s" says the tree is unverified, which at landing scope is the one place the harness has already decided not to fail open — `mainGreen`'s doc states "Nothing here is fail-open", and a red landing check rejects. At minimum the landing scope should treat a timeout as a deterministic reject (the author retries; nothing is lost but one tick), or the timeout should scale with observed suite duration rather than being a constant.

**Suspected cause:** src/build-check.ts:310 folds all three skip reasons into one branch — "Environmental — deliberately NOT fail-closed, so a hung build script cannot wedge every code tick into the 3-strike discard (gate) or every landing behind the merge lock." The reasoning is sound for `no-npm` and `toolchain` and for the gate scope, and it predates the landing scope sharing this helper. The constant is also calibrated for a quieter fleet: observed landing checks run 46–65 s (`build_check` durations 65 368 / 64 392 / 46 847 ms on 09-18), so a 300 s ceiling is ~5x headroom on paper, but it is the *tail* under concurrent suites that matters and two full suites run side by side already take ~66 s each.

**Related:** "`maxConcurrent` stopped bounding model load…" below — the concurrency that makes a 300 s suite run plausible.

**Fix:** `runScopedBuildCheck` now treats a timeout as a deterministic rejection at the two scopes whose next step is a merge. A `MERGE_SCOPES` set (`landing`, `batch`) remaps a `skipped`/`timeout` outcome to `failed` with a synthesized reason, logs the `build_check` event as `failed`, and warns `…; rejecting the merge`. The author keeps its commit and the next tick retries the landing through the same gate, so nothing is lost but a tick. The gate scope and the red-main baseline are unchanged — a timeout there still warns and proceeds, because the model reviewer and the landing path's own in-lock check stand behind the gate, and the baseline's skip only defers an authoring run.

**Files:** src/build-check.ts (`MERGE_SCOPES`, merge-scope timeout remap + reject warning); src/merge.ts, src/lander.ts (policy comments); test/build-check.test.ts (landing/batch timeout rejects, gate still skips).

### `quiet_killed` is the only tick outcome with no strike cap, no backoff and no alarm: hour-long empty retries consumed 44% of the fleet over two days (found by log analysis 2026-09-18, fixed 2026-09-18)

**Symptom:** A tick killed by the quiet watchdog retries immediately, on the same pi session, forever. From `events.jsonl`: `quiet_killed` did not occur once before 2026-09-16, then 23 times on 09-16 and 16 times on 09-17. The 41 kills consumed **69.7 h of slot time**, 62.7 h of it on those two days — **44% of the 3-slot fleet's 144 slot-hours**. The shape is a tight loop, not scattered bad luck: on 09-17 `feature` ticks 179–183 and `plan` ticks 175–179 each died at 60–66 min carrying no token count at all, back to back from 05:59 to 15:09. Ten ticks, nine hours, zero output, and the only `warning` logged fleet-wide in that window was an unrelated `dry` build-check timeout. Session size predicts the damage almost exactly (`.tumwater/sessions/<role>`): `plan` 16 MB → 11 kills, `feature` 15 MB → 13, `bugfix` 14 MB → 5, `dry` 5.2 MB → 1, `coverage` 4.0 MB → 1, `readme` 2.6 MB → 5, `steward` 2.5 MB → 4.

The backend is not down while this happens. `~/.omlx/logs/server.log.2026-09-17` shows completions landing continuously through the whole window (45–142 s each), and 17 of that day's 19 `[vlm_stream_generate] Aborting request` lines match a quiet-kill timestamp to the second — the harness aborting, not the server failing. The starved request leaves no other trace: `e5c0fd95-f6bd-4b67-8654-cf35ac5f6e66` (the 05:59:31 `feature` kill) appears in the server log **only** in its abort line — never a prefix-cache restore, never a `Chat completion`. It was accepted and never scheduled. The retry then re-sends the same, now slightly larger, session and starves the same way.

**Repro:** deterministic once a role's session is large enough that the backend defers it past `quietTimeoutSeconds`; the fleet reproduced it ten times in a row on 09-17. Without the backend, the scheduling half alone is enough: drive any role to a `quiet_killed` outcome (test/loop-2.test.ts:216's zombie-stream shim does this in ~1 s) and read `.tumwater/state/<role>.json` — `nextRunAt` is now, `backoffSeconds` is untouched, `consecutiveErrors` is 0, and no `warning` event was logged. Repeat indefinitely; nothing changes.

**Expected:** a bounded number of consecutive quiet kills, then escalation. Every sibling outcome already has a brake and this one has none:

| outcome | backoff | strike cap | alarm |
| --- | --- | --- | --- |
| `error` | `ERROR_BACKOFF` ladder | `consecutiveErrors` | warns at `ERROR_STREAK_WARN` |
| cut-off | min interval | `CUT_OFF_RESUME_LIMIT` | — |
| `quiet_killed` | none | none | none |

The cut-off branch is the closest precedent and the right model: after N resumes it gives up on the session and falls back to a fresh tick with normal backoff, precisely so "a task that outruns the ceiling every single time" cannot cycle forever (src/state.ts:241-247). A quiet-kill streak should likewise drop the session — the documented self-heal that already exists for context overflow and two consecutive `error` ticks — and raise one warning per episode, as the error streak does.

**Suspected cause:** two independent gaps in src/state.ts. First, `applyTickOutcome`'s `quiet_killed` branch (src/state.ts:216-225) sets `resumePending = true` and `nextRunAt = Date.now()` and nothing else: no ladder, no streak field, no limit. The resume then reuses the same session — `resumableSession` at src/loop.ts:513 feeds `continueSession: resume` at src/loop.ts:317 — so each attempt re-sends the input that caused the previous kill. Second, src/state.ts:182 resets `consecutiveErrors` to 0 on *any* non-`error` result, so a quiet-kill streak does not merely fail to raise the 2026-09-15 error-streak alarm, it actively disarms it: a loop alternating `error` and `quiet_killed` never reaches `ERROR_STREAK_WARN` (src/loop.ts:478). `loopPhase`'s `failing` label keys off the same counter, so status/TUI/GUI render a loop in this state as an ordinary sleeping loop.

**Why it went unnoticed:** the same observability failure as the two entries it most resembles — "Repeated tick failures raise no alarm" (Fixed, 2026-09-15) and the deferral latch below. A loop burning an hour per tick and producing nothing is indistinguishable, on every surface the harness offers, from a loop with nothing to do.

**Related:** "`maxConcurrent` stopped bounding model load…" below is the likely trigger — the extra concurrent stream is what pushes a large session past the point where the backend schedules it — but the two are separately fixable, and this entry is what turns a transient starvation into a nine-hour loop.

**Fix:** `quiet_killed` now has the brake its siblings have. `applyTickOutcome` counts
consecutive quiet kills in `LoopState.quietKillStreak` (reset by any other outcome) and
resumes the starved session only while the streak is at or under
`QUIET_KILL_RESUME_LIMIT` (3); past the limit it clears `resumePending` and takes a fresh
tick on the idle backoff ladder, so the backend is not asked to schedule the same large
session again and the loop sleeps instead of retrying immediately. `loop.ts` raises one
`warning` when the streak crosses the limit (once per episode, like the error streak), and
the status/TUI/GUI state cell reads `failing` from the same field, so an hour-per-tick empty
loop no longer looks like a sleeping one. The director keeps its existing prompt re-queue and
immediate retry: its prompts run fresh and a human is watching.

**Files:** src/types.ts (`quietKillStreak`); src/state.ts (`QUIET_KILL_RESUME_LIMIT`, streak
counting, bounded resume/give-up branch); src/loop.ts (one warning per episode);
src/ui/status-render.ts (`failing` label); test/state.test.ts (streak/resume/backoff pins);
test/loop.test.ts (warning + give-up e2e); test/status-render.test.ts (`failing` label).

### A deferred tick preserves the `no_change` that causes it: five maintenance roles were permanently off after their first idle tick (found by log analysis 2026-09-17, fixed 2026-09-18)

**Symptom:** Five of the nine deferrable roles had not run a single tick in days — `qa` for 120 h, `perf` 120 h, `clean` 121 h, `organize` 69 h, `improve` 60 h — while the fleet landed normally around them. The pattern had no exceptions: every deferrable role whose `lastResult` was `no_change` was dead; every one whose last result was anything else still ticked. `qa` was the worst case, off for five days while the fleet landed several hundred commits.

**Cause:** `deferTick` (src/scheduling.ts) keyed off `lastResult === "no_change"`, which only a completed tick updates — so a deferred tick froze the predicate's own precondition. With `workBacklogOpen` (PLANS.md `## Planned` or BUGS.md `## Open` non-empty, permanent for a healthy project) sufficient to defer on its own, the first `no_change` after backlog-aware deferral landed was terminal. Neither `tumwater wake` nor a restart escaped: the woken tick was deferred on the same poll, and a restart reloaded `lastResult` from disk.

**Fix:** `deferTick` takes `now` and refuses to defer once `deferralExpired` reports the due tick has waited past `DEFER_MAX_MS` (3 h). The reference is `nextRunAt`, which a deferred tick leaves untouched and which is persisted — so `now - nextRunAt` measures the deferral across restarts and does not fire for a `main moved` wake that arrives before the role's own clock. The forced tick refreshes `lastResult` and starts a new deferral episode, so maintenance roles now tick at least once per 3 h window even with a permanently open backlog, while the backlog-aware intent (queued feature/bugfix work outranks idle maintenance) is preserved. A never-scheduled role (`nextRunAt` 0) is never expired.

**Files:** src/scheduling.ts (`DEFER_MAX_MS`, `deferralExpired`, `deferTick`'s new `now` parameter + docs); src/orchestrator.ts (passes `now`); test/orchestrator.test.ts (unit pins for the cap boundary and the never-scheduled case; e2e regression "a maintenance role deferred past DEFER_MAX_MS ticks anyway, despite an open backlog", which seeds a long-deferred `no_change` state and asserts the role ticks).

### A red main latched by a single worktree deadlocks the fleet, and the warning that reports it names a stack frame instead of the failure (found by human investigation 2026-09-18, fixed 2026-09-18)

**Symptom:** On 2026-09-18 every code role ticked `main_red` — "code merges blocked until main is green" — against a main whose suite passed 1035/1035 in an isolated worktree, five runs straight. Two defects compound into a deadlock. First, `baselineCache` keyed a RED verdict by SHA and `mainRedGate` trusted it forever: `src/redeploy.ts` passed `reverifyRed` but `src/main-red.ts` never did, so one worktree's environmental red — the load-sensitive tests above, firing under the load the fleet itself creates — became the fleet-wide verdict. The cache is per-process and only a new SHA evicts it, but a new SHA needs a merge, and merges are exactly what the red blocks: the fleet could not clear its own false verdict, and 47 `main_red` ticks accumulated. Second, the warning built its reason from `red.outputTail?.[0]`, and `clipBuildTail` keeps the LAST ten lines — so a check that died on an unhandled rejection ends mid-stack and every warning in the log read `main c53dba4e is red (test: at process.processTicksAndRejections (node:internal/process/task_queues:104:5))`. The one surface that could have named the failing test named the event loop instead, which is why an intermittent red (18 of 132 baseline checks) went undiagnosed for ten days.

**Repro:** two worktrees of one SHA where the check passes in one and fails in the other (an untracked marker file stands in for the environment difference). Before the fix the second worktree inherited the first's red and ran nothing; only an explicit `reverifyRed` — which no role loop passes — could re-check it.

**Fix:** a red is now provisional until two DIFFERENT worktrees have seen it. `MainBaseline` carries `redFrom`, the worktrees that observed the red; `shouldRerunRed` re-runs a cached red for any worktree not already in that list while fewer than two are, and the in-flight key gains the worktree so a re-verification never joins the run whose environment it exists to re-test. A green at any point promotes the SHA fleet-wide exactly as before — which is what unblocks the role loops without main having to move — and a second red makes the verdict authoritative for everyone. The cost is bounded at ONE confirmation run per SHA, never one per role; `reverifyRed` still forces a run unconditionally for the redeploy gate, whose false block is expensive enough to always pay for its own opinion. Separately, `failureHeadline` picks the first line of a tail that is not a stack frame (falling back to the first line when they all are), and `mainRedGate` uses it — an assertion diff, a compiler error, or a bare test name now reaches the event feed.

**Note:** this is the third latching-verdict bug in the same family — "A broken toolchain is reported as 'main is red'…" (fixed 2026-09-15) and "A rejected `mainGreen` latches a false 'main is red'…" (fixed 2026-09-16) — and the first where the latch survived a correct classification: nothing here was misread as environmental, a genuinely-run check simply produced a red that one flaky test had earned and no path existed to re-evaluate it.

**Files:** src/build-check.ts (`failureHeadline`, `MainBaseline.redFrom`, `shouldRerunRed`, the cache-hit and cache-write paths, `baselineCache` doc); src/main-red.ts (uses `failureHeadline`); test/build-check.test.ts (the existing provisional-red test now pins automatic re-verification instead of "without the flag it inherits the red", plus: a headline unit test, a green-promotes-fleet-wide regression, and an authoritative-after-two-worktrees test that also pins `reverifyRed` still forcing a run past it).

### Two load-sensitive tests reject whatever commit is being gated: five unrelated commits lost in three days (found by log analysis and reproduced 2026-09-18, fixed 2026-09-18)

**Symptom:** Five landing rejections on 09-16/17/18 carry a byte-identical assertion failure — `actual: 'quiet_killed', expected: 'no_change'` — across three roles and five unrelated commits: `dry` `f5b9d77b` (09-16 01:02), `coverage` `88d4c011` (09-16 22:31), `coverage` `52542d66` (09-17 18:26), `dry` `e6778e03` (09-17 21:51), `dry` `23308c30` (09-18 00:01). None of those diffs touch the watchdog. Exactly one test in the suite asserts `no_change` against a live quiet watchdog: test/loop-2.test.ts:176, "a slow but talkative pi run is not killed by the quiet watchdog". It sets `quietTimeoutSeconds = 1` and drives a fake pi that prints a line every ~300 ms, leaving ~700 ms of slack per gap against a 1000 ms kill window (checked every 500 ms) — on a machine the fleet deliberately saturates. Work that already passed authoring and model review is discarded because the gate cannot keep a shell script's `sleep 0.3` under one second.

**Repro:** reproduced on the first attempt on 2026-09-18 by running two full suites concurrently, exactly as two overlapping landings do:

```
suite A: fail 2  ✖ a slow but talkative pi run is not killed by the quiet watchdog (2362ms)
                     actual: 'quiet_killed', expected: 'no_change'
                 ✖ a transient timeout that also hits the harness timeout is not retried (2177ms)
suite B: fail 0  ✔ a slow but talkative pi run is not killed by the quiet watchdog (2987ms)
```

Solo on an idle machine the same test passes 30/30 at ~1.6 s. Suite B passing at 2987 ms shows the margin is gone even when it survives. The same run flaked a second test, test/loop-2.test.ts:69 ("a transient timeout that also hits the harness timeout is not retried", `quietTimeoutSeconds = 2`). A third, test/orchestrator.test.ts:760 ("a live maxConcurrent edit resizes the cap without a restart"), caused three further rejections in the week with `Error: timed out waiting for overlapping runs after the grow` at 26 s.

**Expected:** a test that asserts the watchdog does *not* fire must leave a margin the loaded fleet cannot eat. The kill window is what the test controls; raising `quietTimeoutSeconds` for these cases (or shortening the shim's silent gaps in proportion) restores the invariant being pinned — "progress, however slow, is not a hang" — without depending on scheduler luck. The live-orchestrator resize test needs the same treatment for its `waitFor` budget.

**Suspected cause:** the three tests encode absolute wall-clock assumptions that were true when the fleet ran two concurrent pi streams and one suite at a time. The quiet watchdog is checked against the wall clock on a real interval by design (src/pi.ts:337-350, so it fires after a machine sleep), so it cannot be faked out by a test clock; the margin is the only lever. Precedent: "Flaky test: 'a resumed tick continues the interrupted session' fails with no_change under parallel load" (Fixed, 2026-08-27) is the same failure on the mirror-image assertion.

**Related:** "`maxConcurrent` stopped bounding model load…" below — the load that eats the margin. This entry is independently fixable and is the cheapest of the set.

**Fix:** every absolute wall-clock margin in the affected tests was widened, preserving the RATIO each one pins rather than the numbers. The three named above: the talkative-run test streams a line every 1 s for 4 s against a 3 s quiet window (was 0.3 s/1.2 s against 1 s), so the run is still longer than the window while no single gap approaches it; the harness-timeout test gets `tickTimeoutSeconds` 3 rather than 1, still far inside the shim's 30 s sleep but no longer expirable during process spawn; the live-resize test's "overlapping runs after the grow" wait gets 150 s.

Re-running the entry's own two-concurrent-suites repro against that fix surfaced seven MORE tests of the same shape, none of them in the original analysis — all absolute windows of 1–2 s: the hung-run kill and quiet-killed-keeps-edits tests (the watchdog fired before the shim's shell wrote the file the assertion looks for), the four tool-call stall tests (a 1 s warn threshold against a 2 s kill window, an ordering a loaded machine inverts), and the orchestrator shutdown bound (2000 ms, observed at 2066 ms; now 3500 ms, still well under the 5 s poll sleep it must beat to prove the abort WOKE the sleep). `waitFor`'s default deadline went 20 s → 60 s for the same reason: it is a deadline, not a sleep — it returns the moment its condition holds, so a generous budget costs nothing on the success path and buys only slower reporting of a real hang.

**Verified:** the entry's repro — two full suites concurrently — went from `fail 5` / `fail 4` to `fail 0` / `fail 0` at 1038 tests each, across four rounds of widening (each round's survivors were the next round's targets). Solo: 1038/1038.

**Files:** test/loop-2.test.ts (talkative chatter + quiet window, tick timeout, hung-run quiet window, stall pair); test/loop.test.ts (quiet-killed-keeps-edits window); test/pi.test.ts (three tool-call stall tests); test/orchestrator.test.ts (resize wait budget, shutdown bound); test/util.ts (`waitFor` default + a doc comment saying why the budget is generous).

### A torn land-queue head file clogs the landing slot forever: the live entry behind it never lands, and its role's interlock pins its ticks (found by bugfix loop 2026-09-17, fixed 2026-09-17)

**Symptom:** A hard crash (kill -9, OOM, power loss) landing inside `enqueueLanding`'s `fs.writeFileSync` leaves a truncated queue file in `.tumwater/land-queue/` — or a foreign file a user drops in. When that file sorts BEFORE the live entries (its timestamped name decides), `headLanding` reads null for it — `readEntry` skips unparseable files rather than throwing, by design — and the orchestrator's drain (`if (head) { … }`) then no-ops on EVERY poll: nothing ever removes the unreadable file, so every live landing enqueued behind it sits in the queue indefinitely. `queueDepth` grows on the dashboards, and each stranded entry's author stays interlocked (a non-empty `landingFor` blocks that role's next tick forever) — a crash that should be invisible to a recovered fleet instead bricks one role's landings until a human edits `.tumwater/land-queue/`. `queueFiles`/`queuedLandings` already skip the torn file for display; only the drain's slot was stuck on it.

**Repro:** seed one real commit ahead of main, pinned and queued (the restart-drain test's construction), then `fs.writeFileSync(<queue>/"0000000000-000000-1.json", '{"role": "clean", "sha": "abc')` — a torn file that sorts before the live entry — and start the live orchestrator: the live entry never drains and `queueDepth` stays 2 (test/orchestrator-2.test.ts, "a torn queue-head file is dropped at the drain so the queue drains" — failed with a 20 s waitFor timeout before the fix).

**Note:** the torn file's content is unrecoverable, but nothing recoverable is lost by dropping it: the crashed tick's commit, if any, still lives in `refs/tumwater/landing/<role>` (the pin write precedes the enqueue), and next-tick leftover recovery (leftover.ts) re-lands it through the full gate — the same semantics a non-terminal landing outcome already relies on. A torn head can only appear from a hard crash mid-write or a foreign file: in steady single-process operation `writeFileSync` is synchronous and unobservable mid-write from the poll loop, so the drain can never race a live writer. The reader-level behavior (headLanding reads null for an unreadable head, no throwing) is unchanged and remains pinned in test/land-queue.test.ts; the repair deliberately lives in the drain, which owns drops and events.

**Fix:** two parts. (1) `src/land-queue.ts` exports `staleHeadFile(root)` — the oldest queue file when the queue is non-empty but its head is unreadable (torn or foreign), null otherwise — the queue-internal knowledge (private `queueFiles` + `readEntry`) the drain needs to name the file to drop. (2) `src/orchestrator.ts`'s drain, when `headLanding` returns null, asks for the stale head; when one exists it `dropLanding`s it, logs one `warning` event under `harness` ("land queue head <name> is unreadable (torn or foreign) — dropped so the queue can drain"), and re-reads the head — a healthy entry surfacing behind it drains in the same poll. One file per poll bounds the work; each drop removes the file, so the sequence terminates.

**Files:** src/land-queue.ts (`staleHeadFile` + its doc); src/orchestrator.ts (drain's stale-head branch, import); test/orchestrator-2.test.ts (e2e regression: torn head + live entry drain end to end, one harness warning, no `land_failed`); test/land-queue.test.ts (unit pins for `staleHeadFile`: empty queue, healthy head, torn head, cleared; the existing torn-file test now names the drain as the clearing side).

### A rejected `mainGreen` latches a false "main is red" when the redeploy's own git call fails (found by bugfix loop 2026-09-15, fixed 2026-09-16)

**Symptom:** The 2026-09-15 toolchain failure reached the redeploy latch by two routes. The suite-failure route (a check that ran and exited nonzero on toolchain noise) is fixed: it now reads as a `toolchain` skip. The other route survives: when the `mainGreen` promise itself REJECTS — `ensureDetachedWorktree`'s git call failing inside the mirror worktree, e.g. git breaking between the orchestrator's own `rev-parse` of main and the mirror checkout — `track()` records the rejection with `error` set and `result` unset, and `Redeployer.poll` treats `result !== true` identically to a verified red: `block(mainHead, "main <sha> is red", …)`, no retry until main moves (src/redeploy.ts's `poll`). A toolchain broken hard enough to defeat the mirror checkout still latches a false red, and the fleet self-heals only when main moves — the same disease the sibling entry fixed, one code path down.

**Repro:** `fakeDeps({ mainGreen: () => Promise.reject(new Error(…)) })` drives exactly this shape in test/redeploy.test.ts ("a thrown green check blocks like a red one"): the poll ends in a block with `restartBlocked = "main bbbbbbbb is red"`, and no later poll re-checks the head.

**Note:** the current behavior is deliberate and pinned — the Redeployer's doc says "Nothing here is fail-open: a red main, a failed compile, or a swap error blocks the restart", and that test pins a thrown check blocking. A fix is a design change, not a classification change: distinguish "the check returned red" (a verdict — block, as today) from "the check could not run" (a rejection — e.g. drop the pending head, log one warning per episode, retry on the next poll, mirroring the baseline cache's "a red is provisional" stance). Sibling: the fixed "broken toolchain … main is red" entry below (the suite-failure half of the same incident).

**Fix:** `Redeployer.poll`'s green-check branch now splits a settled check's two meanings (src/redeploy.ts): a REJECTION — `track`'s `error` set, `result` unset — means the check could not run (git broke inside the mirror worktree, or the check itself threw) and is not a verdict about the tree, so it drops the pending head — no `blockedHead`, so `status()` shows no latched `restartBlocked` — logs one `warning` per head (a new `checkFailedHead` latch matching `cooldownWarnedHead`'s once-per-episode precedent, which likewise does not re-arm for the same head within one process), and the next poll re-runs the check on the same head — a fleet whose toolchain recovers redeploys itself without main ever moving. A resolved red verdict (`result === false`) still blocks exactly as before: a verdict blocks, missing evidence retries. The sibling entry's suite-failure route is untouched: a check that RAN and failed on toolchain noise already reads as a `toolchain` skip → green, and never reaches this branch.

**Files:** src/redeploy.ts (`checkFailedHead`, the could-not-run branch in `poll`, doc comments); test/redeploy.test.ts (rewrites "a thrown green check blocks like a red one" to pin drop + warn-once + retry without a latched block; adds a recovery regression: a check that rejects once and then resolves green still reaches the swap; the rejected-compile test stands — a failed step still blocks with its error text).

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

**Files:** src/build-check.ts (`probeToolchain`, `TOOLCHAIN_ERROR_PATTERNS`/`toolchainErrorInOutput`, `runBuildCheck` classification, `"toolchain"` in both `skipReason` unions, skip-warning wording); src/main-red.ts (toolchain skip-warning wording); src/merge.ts (doc comment); test/build-check.test.ts (regressions: a broken probe skips before the check runs, toolchain output in a failed run reads skipped not failed, a git-less PATH still runs a git-free check, `checkMainBaseline` reads a toolchain-failing suite as a skip — never red — and re-checks the same SHA once the toolchain is fixed); test/redeploy.test.ts (regression: the production `mainIsGreen` wiring on a toolchain-failing suite leaves no latched block and the restart proceeds). A related residual — a REJECTED `mainGreen` promise (git failing inside the mirror worktree itself) latched red the same way — was fixed the next day as its own entry above (2026-09-16): a rejected check now reads as "could not run" (drop the pending head, one warning per episode, retry on the next poll) while a red verdict still blocks, and test/redeploy.test.ts pins that new behavior.

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

- Maintenance roles tick on their normal clock while planned features or open bugs wait — deferral is reactive, not backlog-aware (reported by user 2026-09-12, fixed by bugfix loop 2026-09-12; commit 4c9acc4)
- Slot wait queue is FIFO across polls: a due feature/bugfix tick queues behind maintenance ticks that requested slots earlier (reported by user 2026-09-12, fixed by bugfix loop 2026-09-12; commit c1e307f)
- TUI's Ctrl+B budget editor accepted hex and exponent notation as a dollar cap (found by bugfix loop 2026-09-12, fixed 2026-09-12; commit f485acc)
- TUI/GUI "reviewing" state shows only elapsed time — no turn/ctx/tool detail like the "working" state does (reported by user 2026-09-11, fixed by bugfix loop 2026-09-12; commit 3a0410e)
- readTranscriptTail scanned a stale stat size when rotation recreated the path with a smaller file between its stat and open: one line dropped from the window, `end` past EOF (found by bugfix loop 2026-09-11, fixed 2026-09-11; commit d8cb85d)
- Tail readers threw ENOENT when log rotation renamed the file between their stat and open: a poll landing in that window crashed the TUI or `logs -f` process (found by bugfix loop 2026-09-11, fixed 2026-09-11; commit a48e388)
- Auto-restart completes on every stale episode under churn: rate-limit completed auto-restarts to at most one per 12 hours (reported by user 2026-09-11, fixed 2026-09-11; commit 003714f)
- readEvents' torn trailing line occupied one of the limit slots: while events.jsonl ended unterminated, feeds showed at most limit−1 events (found by bugfix loop 2026-09-11, fixed 2026-09-11; commit b5b937f)
- logEvent glued a new event onto an unterminated trailing line: after a crash mid-append, one complete event was lost from every consumer (found by bugfix loop 2026-09-11, fixed 2026-09-11; commit ab239ec)
- /api/report coerced hex/scientific/signed `days` spellings instead of degrading to the default window (found by bugfix loop 2026-09-11, fixed 2026-09-11; commit e7028ed)
- forEachTailChunk ignored onChunk's early stop, so every poll of a grown log re-read it whole (found by bugfix loop 2026-09-11, fixed 2026-09-11; commit d961312)
- The review gate checks the pre-rebase tree, so the bytes that land on main were never run through a check (found by human analysis 2026-09-08, fixed 2026-09-10; commit 7ce70ae)
- README promises `tumwater init` seeds a git repo, but it refuses to run outside an existing one (found by qa loop 2026-09-08, fixed 2026-09-10; commit 118f73a)
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
