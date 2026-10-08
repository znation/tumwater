import { isFleetPaused } from "../fleet/fleet-state.js";
import { orchestratorAlive, readOrchestratorInfo } from "../fleet/orchestrator-info.js";
import { durationLabel } from "../cli/cli-args.js";
import { formatDate, formatTime } from "../text/datetime.js";
import { submitRolePrompt } from "../inbox/inbox-submit.js";
import type { PromptImageInput } from "../inbox/inbox-attachments.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { loadLoopState, saveLoopState, zeroCounters } from "../loop/loop-state.js";
import { clearBackoff } from "../scheduling/backoff.js";
import { writeJsonAtomic } from "../files/json-files.js";
import { abortRequestPath, reclaimRequestPath, resetRequestPath, restartRequestPath, wakeRequestPath } from "../paths.js";

/** The marker-writing cores of the operator-intent protocol, shared by every surface that writes
 * one (the `cmd*` CLI commands in src/operator/operator-commands.ts, the dashboard's POST routes
 * in src/gui/gui-endpoint-commands.ts, and the TUI's key bindings in src/ui/tui/tui-keys.ts): each
 * core returns the confirmation its caller prints verbatim, so the surfaces cannot drift on marker
 * format, idempotence, or wording. The fleet-side consumer half is
 * src/operator/operator-requests.ts; this module holds the producer half's shared core, split out
 * of operator/operator-commands.ts so the UI layer never depends on the CLI's arg parsing. */

/** The error every live-harness-only command reports (abort, stop): one literal so the two
 * surfaces cannot drift on the message an operator sees when nothing is running. */
export const NO_HARNESS_ERROR = "no harness is running — start it with `tumwater run` first";

/** How a marker command reports when its marker takes effect, derived from one liveness
 * check: `live` says whether a fleet will consume it now, `when` is the " within ~2s" such a
 * fleet picks it up in, and `tail` names the fallback ("takes effect on the next `tumwater
 * run`") while no harness is running. Every marker command shares this so none can promise a
 * timing the others deny — the one place that user-facing contract lives. */
export function markerApplyNote(root: string): { live: boolean; when: string; tail: string } {
  const live = orchestratorAlive(root);
  return {
    live,
    when: live ? " within ~2s" : "",
    tail: live ? "" : "; no harness is running, so it takes effect on the next `tumwater run`",
  };
}

/** The trailing liveness clause of a one-shot marker command's confirmation (reset-counters,
 * wake, and restart): with a live fleet, "a running fleet <verb><when>"; without one, where
 * the marker lands instead. The request* cores share this so their wording cannot drift — pause and
 * resume phrase their own confirmations around markerApplyNote's when/tail because their
 * sentences differ. */
function applyClause(live: boolean, when: string, verb: string): string {
  return live
    ? `a running fleet ${verb}${when}`
    : "takes effect on the next `tumwater run` (no harness is running)";
}

/** The marker-writing core of `reset-counters`: zero each target's state file directly (works
 * while the harness is not running) and drop the fleet marker a running fleet consumes within
 * one poll cycle. Returns the confirmation the CLI prints verbatim. Unlike the wake/abort
 * request* cores the GUI's POST endpoints share, no dashboard route exposes reset-counters,
 * so only the CLI consumes this core. */
export function requestResetCounters(root: string, roles: string[]): string {
  for (const r of roles) saveLoopState(root, zeroCounters(loadLoopState(root, r)));
  // Atomic: a concurrent poll reading the marker mid-write would see a torn file, which
  // readJsonFile folds to null — the corrupt-marker superset that wakes/resets EVERY runner.
  // For a scheduled wake (`--in`) that superset drops notBeforeMs, firing the wake hours early.
  writeJsonAtomic(resetRequestPath(root), { at: Date.now(), roles });
  // Only a live fleet consumes the marker; without one the state files are already zeroed and
  // the next `tumwater run` is when the in-memory copies catch up. Name which case this is
  // rather than promising a ~2s pickup that no process will make.
  const { live, when } = markerApplyNote(root);
  return `counters reset for ${roles.join(", ")} — ${applyClause(live, when, "picks this up")}`;
}

/** The marker-writing core of `wake [--in <duration>]`, shared with the GUI's POST /api/wake:
 * clear the named roles' backoff and pull nextRunAt to now (touching ONLY the schedule —
 * counters, wake tracking, and session continuity are untouched), and drop the marker a
 * running fleet consumes within one poll. With a positive `inMs` (`wake --in`'s parsed
 * duration) the wake is SCHEDULED: only the marker is written, its deadline this call's one
 * clock read plus inMs — the state change belongs to the deadline, not to the submit, so a
 * fleet stopped at submit (or restarted before the deadline) does not wake early;
 * consumeWakeRequest clears the schedules when it consumes the marker at or after the
 * deadline. The "wakes in" phrase is inMs itself, not the deadline minus a second clock read
 * (the rule timedPauseBits follows): a caller-computed deadline let a millisecond tick between
 * the two reads print "wakes in 2699999ms" for `--in 45m`. Returns the confirmation the CLI
 * prints verbatim and the GUI flashes. */
export function requestWake(root: string, roles: string[], inMs?: number): string {
  const now = Date.now();
  // Deferred only for a genuinely positive delay: zero or less reads as immediate, so the
  // immediate and scheduled paths share one consumer contract.
  const deferred = inMs !== undefined && inMs > 0;
  if (!deferred)
    for (const r of roles) saveLoopState(root, clearBackoff(loadLoopState(root, r), now));
  // Atomic — see requestResetCounters: a torn wake marker reads as corrupt and wakes every
  // runner immediately, dropping a scheduled wake's notBeforeMs on the floor.
  writeJsonAtomic(
    wakeRequestPath(root),
    deferred ? { at: now, roles, notBeforeMs: now + inMs } : { at: now, roles },
  );
  // Same liveness contract as reset-counters and pause/resume: only a live fleet consumes the
  // marker, so say so instead of promising a poll that will not happen.
  const { live, when } = markerApplyNote(root);
  if (deferred)
    return (
      `wake scheduled for ${roles.join(", ")} — wakes in ${durationLabel(inMs)} — ` +
      (live
        ? "a running fleet applies it within one poll after the deadline"
        : "no harness is running — the next `tumwater run` applies it after the deadline")
    );
  return `wake requested for ${roles.join(", ")} — ${applyClause(live, when, "applies it")}`;
}

/** The structured outcome of a boolean-claiming marker request (requestRestart/requestAbort):
 * a refusal carries the reason a surface renders, success the human-readable confirmation. */
export type RequestResult = { ok: true; message: string } | { ok: false; error: string };

/** The marker-writing core of the forced restart, shared with the GUI's POST /api/restart:
 * drop the marker a running fleet consumes within one poll, telling the redeployer to waive
 * its post-restart cooldown. Forcing never bypasses a refusal — a red main, a failed compile,
 * a swap error, or a boot refusal still blocks — so a press is only meaningful while a restart
 * is actually pending: with a live fleet whose published build is not stale, nothing is written
 * and the reply says so. With no fleet running the marker is written harmlessly (the next `run`
 * consumes it on its first poll) and the reply carries the same liveness contract as `wake`.
 * Returns the structured confirmation the CLI prints verbatim and the GUI flashes. */
export function requestRestart(root: string): RequestResult {
  const info = readOrchestratorInfo(root);
  if (info?.build && info.build.stale !== true) {
    return { ok: false, error: "no restart is pending — the running build is current with main" };
  }
  writeJsonAtomic(restartRequestPath(root), { at: Date.now() });
  const { live, when } = markerApplyNote(root);
  const message =
    `restart requested — ${applyClause(live, when, "applies it")}` +
    (live ? " (the restart cooldown is waived; a blocked restart still blocks)" : "");
  return { ok: true, message };
}

/** The marker-writing core of `tumwater reclaim` (plans/disk-floor.md, part 3/4): drop the
 * marker a running orchestrator consumes within one poll and run one manual pass over every
 * candidate, in-use worktrees respected. Returns the confirmation the CLI prints. A caller
 * with no live fleet must run the pass in-process instead (cmdReclaim), because nothing would
 * consume the marker. */
export function requestReclaim(root: string): string {
  writeJsonAtomic(reclaimRequestPath(root), { at: Date.now() });
  const { live, when } = markerApplyNote(root);
  return `reclaim requested — ${applyClause(live, when, "reclaims idle worktrees")}`;
}

/** Queue a prompt for one loop and wake that loop — the one workflow `tumwater prompt
 * --role`, the dashboard's POST /api/prompt-role, and the TUI's Ctrl+R submit all share:
 * submitRolePrompt enqueues into the loop's own queue (length-capped by the shared rule)
 * and logs under the loop, then requestWake's single-role marker brings a live fleet's
 * loop in within one poll instead of whenever its backoff next expires (and is safe with
 * no fleet running — the same contract as `tumwater wake`). Returns requestWake's
 * confirmation so a surface can show what the wake did. Keeping enqueue and wake in one
 * call keeps a surface from ever queueing a prompt without the wake that delivers it
 * promptly — the pairing is the invariant, not each surface's private discipline. An optional
 * `notBeforeMs` defers the prompt (PLANS.md "tumwater prompt --at <duration>"); the wake
 * still fires — it brings the loop in at its time to find a deliverable queue, and a queue
 * holding only future prompts keeps it asleep. */
export function submitRolePromptAndWake(root: string, role: string, text: string, images?: PromptImageInput[], notBeforeMs?: number): string {
  submitRolePrompt(root, role, text, images, notBeforeMs);
  return requestWake(root, [role]);
}

/** The marker-writing core of `abort`, shared with the GUI's POST /api/abort: drop the
 * per-role marker a running fleet consumes within one poll cycle. Reports the liveness gate
 * and the director's discarded-prompt note structurally ({ok, message|error}) so the CLI can
 * fail() and the GUI can shape its 409/200 — neither re-derives the wording. */
export function requestAbort(root: string, role: string): RequestResult {
  if (!orchestratorAlive(root)) {
    return { ok: false, error: NO_HARNESS_ERROR };
  }
  writeJsonAtomic(abortRequestPath(root, role), { at: Date.now() });
  let confirmation = `abort requested for ${role} — a running fleet applies it within ~2s`;
  if (role === DIRECTOR_ROLE) {
    // The director's in-flight prompt was dequeued from the inbox file at tick start and an
    // abort discards it without re-queueing — say so, since the discard is otherwise silent.
    confirmation +=
      "; its current in-flight prompt will be discarded (re-submit with `tumwater prompt` if you want it retried)";
  }
  return { ok: true, message: confirmation };
}

/** The parsed `--for <duration>` of one pause command: the duration as typed (ms, for the
 * "for 30m" phrase) and the marker deadline it produced (ms epoch, for the resume-time
 * phrase). Kept together so the confirmation cannot phrase one without the other. */
interface TimedPause {
  ms: number;
  untilMs: number;
}

/** The timed-pause clauses both pause confirmations share, in the plan's "… paused for
 * 30m — resumes automatically at 14:05" shape. The duration phrase comes from the parsed
 * value, not from until minus the message's own now — a few ms of clock skew between the two
 * reads must not turn "30m" into "1799999ms". A deadline on today's calendar reads as the
 * bare clock (the common same-day pause); once `--for` crosses midnight the clock alone is
 * ambiguous — `--for 90d` printing "resumes automatically at 17:25:45" names no day — so the
 * local calendar date rides along ("on 2026-12-29 at 17:25:45"), rendered through the shared
 * formatDate/formatTime pair. Both clauses empty for an indefinite pause, so today's wording
 * stands. `now` is injected for callers with a captured instant (tests); the default reads
 * the clock once. */
export function timedPauseBits(
  timed: TimedPause | undefined,
  now: number = Date.now(),
): { forPhrase: string; note: string } {
  if (!timed) return { forPhrase: "", note: "" };
  const until = new Date(timed.untilMs);
  const when = formatDate(until) === formatDate(new Date(now))
    ? `at ${formatTime(until)}`
    : `on ${formatDate(until)} at ${formatTime(until)}`;
  return {
    forPhrase: ` for ${durationLabel(timed.ms)}`,
    note: ` — resumes automatically ${when}`,
  };
}

/** The per-role pause confirmation `tumwater pause --role` prints and the TUI's Ctrl+P
 * flashes — one literal so the two surfaces cannot drift (the same single-writer discipline
 * requestWake's wording already follows). `changed` is pauseRole's return: false reports the
 * idempotent no-op in the CLI's own words instead of a fresh confirmation. `timed` is the
 * deadline this command's `--for` set, echoed back with its wall-clock resume time; the TUI
 * (which cannot pass a deadline) omits it and keeps the plain wording. */
export function rolePauseMessage(
  root: string,
  role: string,
  changed: boolean,
  timed?: TimedPause,
  now: number = Date.now(),
): string {
  if (!changed) return `role ${role} is already paused`;
  const { when, tail } = markerApplyNote(root);
  const { forPhrase, note } = timedPauseBits(timed, now);
  return `role ${role} paused${forPhrase} — it stops starting new ticks at its next eligibility check${when} (in-flight ticks finish; the rest of the fleet is unaffected)${note}${tail}`;
}

/** The per-role resume confirmation, shared between `tumwater resume --role` and the TUI's
 * Ctrl+P for the same no-drift reason. Carries the fleet-pause interplay note cmdResume
 * phrases: the fleet pause is the stronger gate, so with its marker present a freshly
 * resumed role still starts no ticks (the director is exempt from that gate, so its
 * resumption is real) — saying nothing would promise ticking the scheduler then deny, the
 * same honest-confirmation contract markerApplyNote's tail serves. */
export function roleResumeMessage(root: string, role: string, changed: boolean): string {
  if (!changed) return `role ${role} was not paused`;
  const { when, tail } = markerApplyNote(root);
  const fleetNote = isFleetPaused(root) && role !== DIRECTOR_ROLE
    ? " (the fleet pause is still active — `tumwater resume` lifts it)"
    : "";
  return `role ${role} resumed — it starts ticking again at its next eligibility check${when}${fleetNote}${tail}`;
}

/** The `tumwater pause --for <duration>` cap: 90 days. A timed pause is meant to answer "step
 * away for a while and come back to a resumed fleet" — the same bound the report's day windows
 * enforce (REPORT_MAX_DAYS in event-window.ts), and comfortably past any absence a deadline
 * should encode. Beyond it the deadline stops being a timed pause and becomes a standing one:
 * bare `pause` (lifted with `resume`) is that, and it says so instead of silently accepting a
 * value whose wall-clock resume time no `Date` can even hold (a `--for 100000000d` once printed
 * "resumes automatically at NaN:NaN:NaN"). Lives beside the marker contract it caps, which
 * every surface shares, so no new `--for` consumer can outgrow it unnoticed. */
export const PAUSE_FOR_MAX_MS = 90 * 24 * 60 * 60 * 1000;
