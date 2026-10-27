import { openQuestionEntries, ageInDays } from "../backlog/backlog.js";
import { stripEntryStamp } from "../backlog/backlog-structure.js";
import { questionFilingDate } from "../backlog/question-answer.js";
import { byDaysThenIndex } from "../collections.js";
import { eventsSince } from "../events/event-window.js";
import type { HarnessEvent } from "../events/events.js";
import { STALE_QUESTION_DAYS } from "../doctor/doctor-backlog.js";
import { regressedFixCandidates, matchedRegressedFixes, regressedFixesPhrase, type RegressedFix, type RegressedFixCandidate } from "../doctor/doctor-backlog-bugs.js";
import { planDependencyProblem } from "../doctor/doctor-backlog-plans.js";
import { checkWaitContention, providerConcurrencyProblems, providerWaitContention, slotWaitContention, smallPoolProblems, staleWorkspacePins, CHECK_WAIT_CHECK_WINDOW_MS, PROVIDER_WAIT_CHECK_WINDOW_MS, SLOT_WAIT_CHECK_WINDOW_MS, type WaitContention } from "../doctor/doctor-contention-checks.js";
import { readSlotsState } from "../git/slots-state.js";
import { configForStatus } from "../status/status-polls.js";
import { piModelsPath } from "../pi/pi-models.js";
import { piSettingsPath, readPiDefaultModel } from "../pi/pi-settings.js";
import type { PlanDependencyProblem, StaleQuestion } from "./team-alerts.js";

/** This module is the alert-feed half of src/ui/status-payload.ts: each always-on team alert's
 * data-sourcing function (capacityContention, …) lives here, a
 * sibling of the src/ui/team-alert-*.ts builders that turn them into banners. status-payload.ts
 * stays the one status-document builder, importing these feeds and folding each feed's result
 * into the `alerts` field; status-render.ts reads the feeds directly for the TUI. */
/** The open questions the doctor's 7-day rule (src/doctor/doctor-backlog-bugs.ts
 * checkStaleQuestions, STALE_QUESTION_DAYS) calls stale: an open QUESTIONS.md entry whose
 * `(asked by …)` stamp is at least 7 days old. This is the always-on feed for the stale-questions
 * team alert — the shared rule's twin on every observer surface, computed from the same threshold
 * and the same questionFilingDate parser the doctor's check uses, so the two cannot drift on which
 * questions are stale. An undated heading is skipped (like the doctor's check); questions carry no
 * refused note to filter. The returned objects carry the 1-based position (for
 * `tumwater questions answer <n>`), the 0-based index (kept only as the file-order tiebreak), the
 * stamp-stripped title, and the whole-day age. Returned oldest-first — most days waited, ties in
 * file order — so a caller naming the first element names the most-stale question. */
export function staleOpenQuestions(root: string, now = Date.now()): StaleQuestion[] {
  return openQuestionEntries(root)
    .flatMap((entry, index) => {
      const stamp = questionFilingDate(entry.title);
      if (stamp === null) return [];
      const days = ageInDays(stamp, now);
      return days >= STALE_QUESTION_DAYS ? [{ index, position: index + 1, title: stripEntryStamp(entry.title), days }] : [];
    })
    .sort(byDaysThenIndex);
}

/** A broken plan-dependency clause, the always-on twin of the doctor's `plan dependencies` row
 * (src/doctor/doctor-backlog-plans.ts checkPlanDependencies): the same rule's problem set,
 * severity order, and exact message, so the alert and the doctor cannot drift. The reader owns
 * the rule — planDependencyAlert passes the doctor's planDependencyProblem through unchanged,
 * like staleOpenQuestions and the other stale feeds do their doctor's rules. null when PLANS.md's
 * planned entries have no cycle, dangling ref, unparsed clause, or misworded dependency. */
export function planDependencyAlert(root: string): PlanDependencyProblem | null {
  return planDependencyProblem(root);
}

/** The doctor's three `_wait` contention rows (src/doctor/doctor-contention-checks.ts
 * `slotWaitContention`/`providerWaitContention`/`checkWaitContention`) folded into one
 * always-on feed for the `contention` team alert (src/ui/team-alert-tail.ts): the standing twin of
 * the doctor's `workspaces`, `provider contention` and `check contention` rows, read off the
 * same `*_wait` events and the same ten-minute thresholds the doctor sums, so the alert and
 * the doctor cannot drift on the trigger or the knob-raising advice. Reads each window with
 * `eventsSince` (a read error skips that row, exactly like the doctor's own read-error arms),
 * sizing the slot row with readSlotsState's slot count and the provider/check rows with the
 * same last-known-good config the snapshot uses (configForStatus). One entry per row whose
 * window crosses its threshold, `[]` when none does. */
export interface CapacityBottleneck {
  name: string;
  detail: string;
}
/** @see CapacityBottleneck */
export function capacityContention(root: string, now = Date.now()): CapacityBottleneck[] {
  const out: CapacityBottleneck[] = [];
  /** Resolve one capacity verdict and push a "capacity bottleneck" row when it warns. Shared
   * by the three capacity checks (workspace, provider, check slots) so the try/catch that keeps
   * each one from crying wolf on an unreadable event log lives in one place, and the row's
   * `name`/`detail` shape cannot drift between them. */
  const maybeWarn = (
    name: string,
    windowMs: number,
    keep: (ev: HarnessEvent) => boolean,
    resolve: (waits: readonly HarnessEvent[]) => WaitContention,
  ): void => {
    try {
      const verdict = resolve(eventsSince(root, windowMs, now, keep));
      if (verdict.warn) out.push({ name, detail: verdict.detail });
    } catch {
      // A read error skips this row, so the alert never cries wolf on an unreadable log.
    }
  };
  maybeWarn("workspace slots", SLOT_WAIT_CHECK_WINDOW_MS, (ev) => ev.type === "slot_wait", (waits) => slotWaitContention(waits, readSlotsState(root).slots.length));
  maybeWarn("provider slots", PROVIDER_WAIT_CHECK_WINDOW_MS, (ev) => ev.type === "provider_wait", (waits) => providerWaitContention(waits, configForStatus(root)));
  maybeWarn("check slots", CHECK_WAIT_CHECK_WINDOW_MS, (e) => e.type === "check_wait", (waits) => checkWaitContention(waits, configForStatus(root)));
  return out;
}

/** A `maxConcurrentPerProvider` map that cannot do its job — the always-on twin of the doctor's
 * `provider concurrency` row (src/doctor/doctor-contention-checks.ts checkProviderConcurrency):
 * a cap key no seam resolves to (a typo, or a provider the team never runs on), a cap at or
 * above `maxConcurrent` (it never binds), or a keyless seam in a capped team. The `contention`
 * and `provider-hold` alerts fire only once a too-small cap has already parked runs or a storm
 * has struck; this standing alert names the static misconfiguration itself, which the doctor
 * row is the only other surface that otherwise exposes. Reads the same last-known-good config
 * the snapshot uses (configForStatus) and audits it through the row's own
 * providerConcurrencyProblems, so the alert and the row cannot drift on the trigger or the
 * wording; `[]` when no cap is configured or the map is well-formed. */
export function providerCapProblems(root: string): string[] {
  return providerConcurrencyProblems(
    configForStatus(root),
    readPiDefaultModel(piSettingsPath(piModelsPath()), root),
  );
}

/** The always-on twin of the doctor `parallel instances` row's pool-mismatch clause
 * (doctor-contention-checks.ts smallPoolProblems): an enabled `feature`/`bugfix` running
 * more than one instance while slotCount(config) sits below maxConcurrent — the shared pool
 * is smaller than the run cap, so those instances contend for the same checkouts. Built from
 * the same smallPoolProblems selector the doctor row uses, so the alert and the row cannot
 * drift on the trigger, the role list, or the wording. configForStatus never returns
 * undefined (an unreadable tumwater.json falls back to defaultConfig(), whose pool is the
 * default maxConcurrent + 1 — never below maxConcurrent), so the [] is the only silent
 * outcome. */
export function instancePoolProblems(root: string): string[] {
  return smallPoolProblems(configForStatus(root));
}

/** How far back the regressed-fixes alert looks — one day, so a recently Fixed test that failed
 * again is a standing amber alert until a day passes (or the failure is filed). The doctor's
 * own `regressed fixes` row keeps its since-the-fix read; this is the alert's daily trigger, the
 * same trailing day the regressed-fixes alert reads. */
export const REGRESSED_FIX_WINDOW_MS = 24 * 60 * 60_000;
/** A Fixed record whose quoted test failed again in the trailing day — the always-on feed for the
 * `regressed-fixes` team alert (src/ui/team-alert-tail.ts), carrying the doctor's own sentence
 * (regressedFixesPhrase) so the alert and the `regressed fixes` row cannot drift on the wording.
 * null when no Fixed record's quoted test failed in the window. */
export interface RegressedFixAlert {
  count: number;
  detail: string;
}
/** The always-on twin of the doctor's `regressed fixes` row (src/doctor/doctor-backlog-bugs.ts
 * checkRegressedFixes): the same candidate selection (regressedFixCandidates) and the same
 * failureMentions match (matchedRegressedFixes) and sentence (regressedFixesPhrase), read off the
 * trailing REGRESSED_FIX_WINDOW_MS of events (the doctor, whose window is since each fix, still
 * warns on an older recurrence). An unreadable event log yields none. */
export function regressedFixesAlert(root: string, now = Date.now()): RegressedFixAlert | null {
  const candidates: RegressedFixCandidate[] = regressedFixCandidates(root);
  const rows: RegressedFix[] = matchedRegressedFixes(candidates, eventsSince(root, REGRESSED_FIX_WINDOW_MS, now));
  const detail = regressedFixesPhrase(rows);
  return detail === null ? null : { count: rows.length, detail };
}
/** Re-export so the always-on alert's stale-pin selector stays in its one home
 * (src/doctor/doctor-contention-checks.ts) while tui.tsx keeps importing every alert feed from
 * this one module. */
export { staleWorkspacePins };

