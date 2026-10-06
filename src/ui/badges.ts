import type { TestCounts } from "../build/build-check-counts.js";
import type { StatusSnapshot } from "../status/status-data.js";
import { budgetGate, budgetReached, type BudgetGate } from "../budget/budget.js";
import { quietWindowEnd } from "../scheduling/quiet-hours.js";
import { humanSeconds, pad2, secondsUntil } from "../text/datetime.js";
import { pauseReasonSuffix } from "../text/phrases.js";
import { shortSha, usd, usdCap } from "../text/format.js";

/** The status header's BADGE fragments, phrased once for both observer surfaces: the terminal
 * table (status-render.ts's renderStatus header) and the JSON/GUI payload
 * (status-payload.ts's preformatted badge fields). Split from status-model.ts, which keeps the
 * per-loop display model (phase, rows, token metrics) — the badges are header-scale fleet
 * facts (build, main check, budget, land queue, timed pause) rather than per-loop state, and
 * their one-home rule ("the page cannot re-derive and drift from these strings") is easier to
 * see when the module is exactly the badges. The duration phrasing they share (humanSeconds)
 * lives in datetime.ts — core modules need it too, so it sits below the ui layer. */

/** The header's build fragment: which commit the running harness was compiled from and, when
 * main's build inputs have moved past it, how far — the fleet is then executing code main no
 * longer describes (auto-restart lands the new build; off, restart `tumwater run` by hand).
 * A stale build also says what auto-restart is doing about it: `restart pending` resolves
 * itself, `restart BLOCKED` never will until main moves, and telling them apart at a glance is
 * the whole point (see BuildStatus.restartBlocked). Empty when the dist carries no stamp.
 * Shared by the TUI/status header and the GUI's. */
export function buildBadge(build: StatusSnapshot["build"]): string {
  if (!build) return "";
  const stale = build.stale ? ` — STALE: main +${build.aheadCommits ?? 0} commit(s) since` : "";
  const restart = build.restartBlocked
    ? `; restart BLOCKED: ${build.restartBlocked}`
    : build.restartPending
      ? "; restart pending"
      : "";
  return `, build ${shortSha(build.sha)}${stale}${restart}`;
}

/** The counts fragment of main's check, phrased once for every surface that renders it:
 * `2429/2430`, appending a parenthetical for each non-passing count the block carries —
 * `(2 failed · 1 skipped)` — so a skip or failure is never silently folded into the pass
 * ratio (a fully green `2429/2430` with one skip must not read like one failure). Empty
 * when the block carries no counts. mainCheckBadge and the JSON payload's mainCounts field
 * (status-payload.ts) are the readers; the GUI sidebar renders this fragment verbatim
 * instead of re-deriving it, which is the drift this one-home rule exists to prevent. */
export function mainCountsFragment(counts: TestCounts | undefined): string {
  if (!counts) return "";
  const notes: string[] = [];
  if (counts.fail > 0) notes.push(`${counts.fail} failed`);
  if (counts.skipped > 0) notes.push(`${counts.skipped} skipped`);
  return `${counts.pass}/${counts.tests}${notes.length > 0 ? ` (${notes.join(" · ")})` : ""}`;
}

/** One home for the main-check status → display mapping the observer surfaces share:
 * passed→green (check glyph), failed→red (fail glyph), and a skipped/unverified check reads
 * its raw status word with `fallbackTone` for color — callers pick the tone their palette
 * uses (the TUI's status header renders yellow, the GUI sidebar amber). The verdict word
 * never reads green for an unverified tree. Readers: mainCheckBadge (below) and the header
 * badge tone in status-render.ts. The GUI sidebar's status row (gui-client-fleet.ts) ships
 * its own copy of the mapping — it is browser-side JS spliced into gui-client.ts and cannot
 * import this module; its three-line ternary block is deliberately left as is. */
export function mainCheckVerdict(
  status: string,
  fallbackTone: string = status,
): { word: string; tone: string; glyph: string } {
  const passed = status === "passed";
  const failed = status === "failed";
  return {
    word: passed ? "green" : failed ? "red" : status,
    tone: passed ? "green" : failed ? "red" : fallbackTone,
    glyph: passed ? "check" : failed ? "fail" : "info",
  };
}

/** Main's newest merge-scope check as a header badge (PLANS.md "Retire the README freshness
 * stamp"): `· main <sha>: green · N/N (N skipped)` — the live replacement for the committed
 * README stamp the readme role used to maintain. Empty when the snapshot carries no check
 * (none has run yet), so a quiet header stays byte-identical to a pre-check fleet. The
 * verdict maps passed→green, failed→red; anything else (a skipped scope check) renders its
 * raw word — an unverified tree must not read green. The counts fragment (mainCountsFragment)
 * omits parentheticals for zero counts, matching the stamp wording the README carried. */
export function mainCheckBadge(mainCheck: StatusSnapshot["mainCheck"]): string {
  if (!mainCheck) return "";
  const verdict = mainCheckVerdict(mainCheck.status).word;
  const fragment = mainCountsFragment(mainCheck.counts);
  const counts = fragment ? ` · ${fragment}` : "";
  const sha = mainCheck.sha ? `${shortSha(mainCheck.sha)}: ` : "";
  return ` · main ${sha}${verdict}${counts}`;
}

/** The fleet's current budget-gate state, derived from a snapshot's budget block — the one
 * home for the budgetReached + fallback-readiness wiring both observer surfaces share: the
 * TUI/status table needs the `paused` verdict for loopPhase, the JSON/GUI payload ships the
 * same one, and budgetBadge needs `fallback` — so the three-valued display rule cannot
 * drift between the surfaces. loopPhase (via loopRowCells, in status-model.ts) and budgetBadge
 * are the only readers. */
export function fleetBudgetGate(budget: StatusSnapshot["budget"]): BudgetGate {
  return budgetGate(budgetReached(budget), budget.fallback !== null);
}

/** The header's daily-cost-budget fragment, standing in every cap state (the badge is also
 * the affordance for editing the cap, so a disabled fleet needs it too): `· budget: n/a`
 * for a fleet whose models are all free (spend can never accumulate against a cap that
 * cannot be reached — and no priced model means no daily spend to count, hence no "today"
 * — checked first, in every cap state), `· budget: $X.XX/$Y today` while enabled with
 * priced models, and `· budget: $X today · no cap` when disabled. One
 * home for the rule — renderStatus renders it in the TUI/status header and status-payload.ts
 * ships its output preformatted as `budgetBadge`, so the GUI page cannot drift from this
 * string.
 * While a burn-rate forecast stands (the snapshot's `capHitAt`, budget.ts's projectCapHit —
 * null exactly when no forecast may be stated), the enabled reading appends
 * `· ~cap at HH:MM`: when the cap falls today at today's burn, wall-clock local, hours and
 * minutes only (formatTime's seconds are noise for a forecast). The `~` marks it a forecast —
 * the rate is linear over the whole day, so quiet hours make the morning figure pessimistic
 * about the remaining day. The null test is the whole condition: projectCapHit returns null
 * exactly when the gate is no longer open, so no gate check is needed here, and every
 * no-forecast state stays byte-identical to the pre-projection badge. The `no cap` branch
 * needs no forecast slot: a disabled cap never carries a capHitAt (projectCapHit returns null
 * for capUsd <= 0), and the fallback fragment only stands once the cap IS reached — the one
 * state where the forecast is itself null — so the fragments can never compete for the line. */
export function budgetBadge(budget: StatusSnapshot["budget"]): string {
  if (budget.free) return " · budget: n/a";
  // Only while the fallback is actually carrying the fleet (plans/fallback-model.md): the cap
  // is spent, so the dollar figure alone would read like a stopped fleet. Naming the model
  // answers the operator's next question — what is it running on now? Its cost is n/a by
  // construction (the gate engages nothing else), so no second figure is shown. Off-gate the
  // badge is byte-identical to before.
  const fallback =
    fleetBudgetGate(budget) === "fallback"
      ? ` · fallback: ${budget.fallback?.model ?? budget.fallback?.provider ?? "pi default"} (cost n/a)`
      : "";
  const forecast =
    budget.capHitAt !== null
      ? ` · ~cap at ${pad2(new Date(budget.capHitAt).getHours())}:${pad2(new Date(budget.capHitAt).getMinutes())}`
      : "";
  if (budget.capUsd > 0)
    return ` · budget: ${usd(budget.spentUsd)}/${usdCap(budget.capUsd)} today${forecast}${fallback}`;
  return ` · budget: ${usd(budget.spentUsd)} today · no cap`;
}

/** The header's land-queue fragment (plans/merge-queue.md 4/5): `· land queue: N` while any
 * landing is queued or in flight, empty when the queue is idle — so an idle fleet keeps
 * every existing header byte intact. One home for the rule, like buildBadge and budgetBadge:
 * renderStatus renders it in the TUI/status header and status-payload.ts ships its output
 * preformatted, so the GUI page cannot drift from this string. */
export function landingBadge(landQueue: { depth: number }): string {
  return landQueue.depth > 0 ? ` · land queue: ${landQueue.depth}` : "";
}

/** The header's fleet timed-pause fragment: `· paused — auto-resumes in <duration>` while a
 * timed pause stands, empty otherwise — so an operator can tell at a glance whether a paused
 * fleet will come back on its own or needs a manual `resume` (the Timed pause plan left the
 * display out on purpose). The snapshot's `pausedUntil` is the FLEET marker's deadline (ms
 * epoch, plans/daily-cost-budget.md item 5), so the badge stands exactly when the fleet
 * itself is timed-paused: a role-only timed pause leaves the header unchanged, and an absent
 * or already-expired deadline renders nothing — the read side treats an expired marker as
 * unpaused, so the badge never claims a countdown that is over. The duration goes through
 * pauseCountdown, the one home of that guard and rounding. renderStatus renders it in
 * the TUI/status header after the budget badge; the GUI recomputes the ticking number
 * client-side from the payload's raw `pausedUntil` (status-payload.ts) using its own
 * humanSeconds copy, pinned against this one by test. `reason` (the operator's
 * `pause --reason <text>` note) rides after the countdown — and makes the untimed pause
 * visible as ` · paused — "<reason>"`, the one case an indefinite pause shows up here;
 * without a reason the badge keeps today's byte-exact form. */
export function pauseBadge(pausedUntil: number | undefined, now: number, reason?: string): string {
  const left = pauseCountdown(pausedUntil, now);
  // The operator's why rides after the countdown (`pause --reason <text>`); a reasonless
  // badge keeps today's byte-exact form, including the empty badge an indefinite pause
  // has always had — a reason standing is the one thing that makes the untimed pause
  // visible up here, because the operator wrote down why and the header should say it.
  const why = pauseReasonSuffix(reason);
  if (!left && !reason) return "";
  return left ? ` · paused — auto-resumes in ${left}${why}` : ` · paused${why}`;
}

/** The countdown a timed fleet pause has left, as humanSeconds — `null` when there is none
 * (no deadline, or an already-expired one: the read side treats an expired marker as
 * unpaused). The one home of the guard + ms→seconds rounding behind the fleet's pause
 * countdowns, shared by pauseBadge's header fragment and fleet-alerts.ts's paused alert
 * title, so the two surfaces cannot disagree about how much time remains. The guard is this
 * function's own; the ms→seconds rounding rides datetime.ts's secondsUntil. The GUI's pause
 * control recomputes the ticking number client-side from the payload's raw `pausedUntil`
 * (gui-client-operator.ts) — a separate runtime that cannot import TypeScript. */
export function pauseCountdown(pausedUntil: number | undefined, now: number): string | null {
  if (pausedUntil === undefined || pausedUntil <= now) return null;
  return humanSeconds(secondsUntil(pausedUntil, now));
}

/** The header's quiet-hours fragment (plans: "Quiet hours … part 2/2, observability"): the
 * schedule as standing information in every configured state — `· quiet until 07:00` while
 * the local clock sits inside the window (the active reading answers "why are the loops
 * idle?" with when they start again) and `· quiet 23:00-07:00` otherwise — and empty when
 * the snapshot carries no window, so a fleet without the schedule keeps its header
 * byte-identical. The window end comes from quiet-hours.ts's quietWindowEnd — read back out of
 * the window string, not re-parsed into minutes — so the badge renders the operator's own
 * spelling.
 * renderStatus renders it in the TUI/status header after the pause badge; the GUI page
 * renders its sidebar chip from the payload's raw fields and its active indicator from
 * fleet-alerts' quiet alert, so both dashboards say the same thing. */
export function quietBadge(quietHours: string | undefined, inQuietHours: boolean): string {
  if (!quietHours) return "";
  const end = quietWindowEnd(quietHours);
  return inQuietHours ? ` · quiet until ${end}` : ` · quiet ${quietHours}`;
}
