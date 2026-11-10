import crypto from "node:crypto";
import path from "node:path";
import { cancelScheduledStop, isTeamPaused, scheduleStop } from "../team/team-state.js";
import { orchestratorAlive, readOrchestratorInfo } from "../team/team-orchestrator-info.js";
import { durationLabel } from "../text/duration.js";
import { formatDate, formatTime, humanUntil, DAY_MS } from "../text/datetime.js";
import { submitRolePrompt } from "../inbox/inbox-submit.js";
import type { PromptImageInput } from "../inbox/inbox-attachments.js";
import { questionAsker } from "../backlog/backlog-question-answer.js";
import { knownRoleIdsCached, loadConfigCached } from "../config/config.js";
import { baseRoleOf, runnerIds } from "../roles/runner-ids.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { saveRunnerState, zeroCounters } from "../runner/runner-state.js";
import { loadRunnerState } from "../runner/runner-state-load.js";
import { clearBackoff } from "../scheduling/backoff.js";
import { writeJsonAtomic } from "../files/json-files.js";
import { ensureDir } from "../files/files.js";
import { reclaimPass } from "../team/team-reclaim.js";
import { formatGB } from "../text/format.js";
import { plural } from "../text/phrases.js";
import { numberedList } from "../text/markdown.js";
import { cancelScheduledWakeAt, cancelScheduledWakes, pendingScheduledWakes } from "./operator-requests.js";
import {
  abortRequestPath,
  modelCheckRequestPath,
  reclaimRequestPath,
  resetRequestPath,
  restartRequestPath,
  scheduledWakeDir,
  wakeRequestPath,
} from "../paths.js";

/** The marker-writing cores of the operator-intent protocol, shared by every surface that writes
 * one (the `cmd*` CLI commands in src/operator/operator-commands.ts, the dashboard's POST routes
 * in src/gui/gui-endpoint-commands.ts, and the TUI's key bindings in src/ui/tui/tui-keys.ts): each
 * core returns the confirmation its caller prints verbatim, so the surfaces cannot drift on marker
 * format, idempotence, or wording. The team-side consumer half is
 * src/operator/operator-requests.ts; this module holds the producer half's shared core, split out
 * of operator/operator-commands.ts so the UI layer never depends on the CLI's arg parsing. */

/** The error every live-harness-only command reports (abort, stop): one literal so the two
 * surfaces cannot drift on the message an operator sees when nothing is running. */
export const NO_HARNESS_ERROR = "tumwater is not running — start it with `tumwater start` first";

/** How a marker command reports when its marker takes effect, derived from one liveness
 * check: `live` says whether a team will consume it now, `when` is the " within ~2s" such a
 * team picks it up in, and `tail` names the fallback ("takes effect on the next `tumwater
 * run`") while tumwater is not running. Every marker command shares this so none can promise a
 * timing the others deny — the one place that user-facing contract lives. */
export function markerApplyNote(root: string): { live: boolean; when: string; tail: string } {
  const live = orchestratorAlive(root);
  return {
    live,
    when: live ? " within ~2s" : "",
    tail: live ? "" : "; tumwater is not running, so it takes effect on the next `tumwater start`",
  };
}

/** The trailing liveness clause of a one-shot marker command's confirmation (reset-counters,
 * wake, and restart): with a live team, "a running team <verb><when>"; without one, where the
 * marker goes instead. The request* cores share this so their wording cannot drift — pause and
 * resume phrase their own confirmations around markerApplyNote's when/tail because their
 * sentences differ. */
function applyClause(live: boolean, when: string, verb: string): string {
  return live
    ? `the running team ${verb}${when}`
    : "takes effect on the next `tumwater start` (tumwater is not running)";
}

/** The marker-writing core of `reset-counters`: zero each target's state file directly when no
 * team is running, and drop the team marker a running team consumes within one poll cycle.
 * Returns the confirmation the CLI prints verbatim. The CLI and the GUI's
 * POST /api/reset-counters share this core. */
export function requestResetCounters(root: string, roles: string[]): string {
  // A live team's orchestrator is the state files' single writer: consumeResetRequest zeroes
  // the affected runners' in-memory copies and the runners save them, and writes the file for a
  // requested role that has no runner (a disabled role). Rewriting the files here too would be
  // a second writer racing those whole-file saves — an overwrite from a snapshot the
  // orchestrator has since moved past (a just-ended run's result, a claim, a schedule), which
  // the lost update discards. So with a live team only the marker is written; with none there
  // is no concurrent writer and the direct write is what carries the reset to the next run.
  const { live, when } = markerApplyNote(root);
  if (!live) for (const r of roles) saveRunnerState(root, zeroCounters(loadRunnerState(root, r)));
  // Atomic: a concurrent poll reading the marker mid-write would see a torn file, which
  // readJsonFile folds to null — the corrupt-marker superset that wakes/resets EVERY runner.
  // For a scheduled wake (`--in`) that superset drops notBeforeMs, firing the wake hours early.
  writeJsonAtomic(resetRequestPath(root), { at: Date.now(), roles });
  // Only a live team consumes the marker; without one the state files are already zeroed and
  // the next `tumwater start` is when the in-memory copies catch up. Name which case this is
  // rather than promising a ~2s pickup that no process will make.
  return `counters reset for ${roles.join(", ")} — ${applyClause(live, when, "picks this up")}`;
}


/** The empty-list wording both wake-list renderers share — `cancelWakes`'s no-op arm and
 * `renderWakeList`'s empty list: one literal so the two surfaces cannot drift on what an
 * operator sees when nothing is pending, plus a ` for <roles>` suffix when the view was
 * role-scoped. */
function noWakePending(roles?: string[]): string {
  return `no scheduled wake pending${roles ? ` for ${roles.join(", ")}` : ""}`;
}

/** Drop pending scheduled wakes (`tumwater wake --cancel`, the dashboard's POST /api/wake-cancel):
 * every pending wake, or only the named roles' share of them. Returns the confirmation the CLI
 * prints verbatim and the GUI flashes, so the surfaces cannot drift on wording. */
export function cancelWakes(root: string, roles?: string[]): string {
  return cancelWakesOutcome(root, roles).message;
}

/** `tumwater wake --cancel [--json]`'s data: the same walk as `cancelWakes` plus a one-object
 * acknowledgement for scripts. `status` is `cancelled` when at least one pending wake was
 * dropped, `no_scheduled_wake` when none was pending; `count` is the number of wake files
 * removed or rewritten; `roles` is present only when the call was role-scoped. The `message`
 * is the text `cancelWakes` prints today, so every surface's wording is one read. */
export function cancelWakesOutcome(root: string, roles?: string[]): { message: string; payload: Record<string, unknown> } {
  const n = cancelScheduledWakes(root, roles);
  const forRole = roles ? ` for ${roles.join(", ")}` : "";
  const message = n > 0 ? `cancelled ${plural(n, "scheduled wake")}${forRole}` : noWakePending(roles);
  const payload: Record<string, unknown> = { command: "wake", status: n > 0 ? "cancelled" : "no_scheduled_wake", count: n };
  if (roles) payload.roles = roles;
  return { message, payload };
}

/** Drop ONE pending scheduled wake by its 1-based position in the pending list (`wake --cancel
 * 2`), or with `roles` the position in the list restricted to wakes naming any of them. The
 * success wording is the list row's own under the position — `cancelWakeAt` prints the same
 * `in <duration> — <roles>` fragment `renderWakeList` lines show, so the number always means
 * what `wake --list` shows. Returns the confirmation the CLI prints verbatim. */
export function cancelWakeAt(root: string, position: number, roles?: string[], now = Date.now()): string {
  return cancelWakeAtOutcome(root, position, roles, now).message;
}

/** `tumwater wake --cancel <n> [--json]`'s data: the same removal as `cancelWakeAt` plus a
 * one-object acknowledgement. A hit carries `status: "cancelled"` with `position`, the
 * removed wake's own role list (`wakeRoles` — distinct from the call's target scope `roles`,
 * which a scoped call also carries) and deadline, and `pending`, the pendings left after the
 * removal. A miss (a position past the (scoped) list) carries `status: "not_found"` with
 * `position` and `pending` and nothing else — no `wakeRoles` and no `atMs`. `message` is the
 * text `cancelWakeAt` prints today. */
export function cancelWakeAtOutcome(
  root: string,
  position: number,
  roles?: string[],
  now = Date.now(),
): { message: string; payload: Record<string, unknown> } {
  const { wake, pending } = cancelScheduledWakeAt(root, position, now, roles);
  if (!wake) {
    return {
      message: `no scheduled wake at position ${position}${roles ? ` for ${roles.join(", ")}` : ""} (${plural(pending, "scheduled wake")} pending)`,
      payload: { command: "wake", status: "not_found", position, pending, ...(roles ? { roles } : {}) },
    };
  }
  return {
    message: `cancelled scheduled wake ${position} (in ${humanUntil(wake.atMs, now)} — ${wake.roles.join(", ")})`,
    payload: { command: "wake", status: "cancelled", position, wakeRoles: wake.roles, atMs: wake.atMs, pending, ...(roles ? { roles } : {}) },
  };
}

/** The pending scheduled wakes (`tumwater wake --list`), earliest first; with `roles`, only the
 * wakes naming any of them. Each row carries its 1-based `position` in the (optionally scoped)
 * list — the same number `wake --list` prints and `wake --cancel <n>` addresses. Read-only. */
export function listWakes(
  root: string,
  roles: string[] | undefined,
  now: number,
): { position: number; roles: string[]; atMs: number }[] {
  const wakes = pendingScheduledWakes(root, now);
  const kept = roles ? wakes.filter((w) => w.roles.some((r) => roles.includes(r))) : wakes;
  return kept.map((w, i) => ({ position: i + 1, ...w }));
}

/** `wake --list`'s text: one numbered line per wake, or the empty wording `cancelWakes` uses. */
export function renderWakeList(wakes: { roles: string[]; atMs: number }[], now: number, roles?: string[]): string {
  return numberedList(
    wakes.map((w) => `in ${humanUntil(w.atMs, now)} — ${w.roles.join(", ")}`),
    noWakePending(roles),
  );
}

/** The string-returning confirmation of `wake [--in <duration>]`, kept for the surfaces that
 * print prose: the dashboard's POST /api/wake flash, the TUI's wake editor, and the backlog
 * role-wake. It is a thin wrapper over `requestWakeOutcome` (the marker-writing core beside
 * it) that returns only the message, so every surface's wording is one read and the `--json`
 * acknowledgement cannot drift from it. */
export function requestWake(root: string, roles: string[], inMs?: number): string {
  return requestWakeOutcome(root, roles, inMs).message;
}

/** The marker-writing core of `wake [--in <duration>]`, shared with the GUI's POST /api/wake
 * and the TUI through `requestWake`: clear the named roles' backoff and pull nextRunAt to now
 * (touching ONLY the schedule — counters, wake tracking, and session continuity are
 * untouched), and drop the marker a running team consumes within one poll. With a positive
 * `inMs` (`wake --in`'s parsed duration) the wake is SCHEDULED: only the marker is written,
 * its deadline this call's one clock read plus inMs — the state change belongs to the
 * deadline, not to the submit, so a team stopped at submit (or restarted before the deadline)
 * does not wake early; consumeWakeRequest clears the schedules when it consumes the marker at
 * or after the deadline. The "wakes in" phrase is inMs itself, not the deadline minus a
 * second clock read (the rule timedPauseBits follows): a caller-computed deadline let a
 * millisecond of clock time between the two reads print "wakes in 2699999ms" for `--in 45m`.
 * Returns the confirmation the surfaces print verbatim (`message`) plus the `--json`
 * acknowledgement: `status` `requested` (immediate) or `scheduled` (`inMs` positive, adding
 * `inMs` — the call's own duration, never a recomputed deadline delta — and `atMs`, the
 * scheduled marker's `notBeforeMs`), `roles`, `live`, and the disabled targets `disabled`.
 * The single-writer rule and atomicity notes `requestResetCounters` carries apply here too:
 * with a live team only the marker is written; a scheduled wake gets its own file so a later
 * wake request cannot overwrite it. */
export function requestWakeOutcome(root: string, roles: string[], inMs?: number): { message: string; payload: Record<string, unknown> } {
  const now = Date.now();
  const deferred = inMs !== undefined && inMs > 0;
  const { live, when } = markerApplyNote(root);
  const disabled = disabledOf(root, roles);
  const disabledNote = disabled.length === 0 ? "" : disabledWakeNote(root, roles);
  if (deferred) {
    ensureDir(scheduledWakeDir(root));
    const atMs = now + inMs;
    writeJsonAtomic(
      path.join(scheduledWakeDir(root), `${now}-${process.pid}-${crypto.randomBytes(4).toString("hex")}.json`),
      { at: now, roles, notBeforeMs: atMs },
    );
    const message =
      `wake scheduled for ${roles.join(", ")} — wakes in ${durationLabel(inMs)} — ` +
      (live
        ? "the running team applies it within one poll after the deadline"
        : "tumwater is not running — the next `tumwater start` applies it after the deadline") +
      disabledNote;
    return { message, payload: { command: "wake", status: "scheduled", roles, inMs, atMs, live, disabled } };
  }
  if (!live)
    for (const r of roles) saveRunnerState(root, clearBackoff(loadRunnerState(root, r), now));
  writeJsonAtomic(wakeRequestPath(root), { at: now, roles });
  const message = `wake requested for ${roles.join(", ")} — ${applyClause(live, when, "applies it")}${disabledNote}`;
  return { message, payload: { command: "wake", status: "requested", roles, live, disabled } };
}

/** The ids among `roles` whose config entry is `enabled: false`; empty when the config
 * cannot be read. */
function disabledOf(root: string, roles: string[]): string[] {
  const { config } = loadConfigCached(root);
  if (!config) return [];
  return roles.filter((id) => config.roles[baseRoleOf(id)]?.enabled === false);
}

/** The confirmation clause naming the woken roles that are disabled: a disabled role has no
 * runner, so the wake only ends its sleep. Empty when none is disabled or the config
 * cannot be read (the cached read, so a broken tumwater.json never makes a wake throw). */
function disabledWakeNote(root: string, roles: string[]): string {
  const disabled = disabledOf(root, roles);
  if (disabled.length === 0) return "";
  const one = disabled.length === 1;
  return (
    `; ${disabled.join(", ")} ${one ? "is" : "are"} disabled, so the wake only ends ` +
    `${one ? "its" : "their"} sleep — ${one ? "it" : "they"} won't run until you enable ` +
    `${one ? "it" : "them"} with ` +
    `tumwater config set roles.${one ? disabled[0]! : "<id>"}.enabled true`
  );
}

/** Schedule a graceful team stop `inMs` from now (`tumwater stop --in`, the dashboard's "Stop the
 * team later"): the marker means nothing without a live team to consume it, so a stopped one
 * refuses with NO_HARNESS_ERROR. The caller has already validated `inMs` (positive, within
 * PAUSE_FOR_MAX_MS). */
export function requestScheduledStop(root: string, inMs: number): RequestResult {
  if (!orchestratorAlive(root)) return { ok: false, error: NO_HARNESS_ERROR };
  scheduleStop(root, Date.now() + inMs);
  return {
    ok: true,
    message: `stop scheduled in ${durationLabel(inMs)} — the team finishes current work, then stops; \`tumwater stop --cancel\` drops it`,
  };
}

/** Drop a scheduled stop; needs no live team. The confirmation `stop --cancel` prints. */
export function cancelScheduledStopMessage(root: string): string {
  return cancelScheduledStop(root) ? "scheduled stop cancelled" : "no stop scheduled";
}

/** The structured outcome of a boolean-claiming marker request (requestRestart/requestAbort):
 * a refusal carries the reason a surface renders, success the human-readable confirmation. */
export type RequestResult = { ok: true; message: string } | { ok: false; error: string };

/** The marker-writing core of the forced restart, shared with the GUI's POST /api/restart:
 * drop the marker a running team consumes within one poll, telling the redeployer to waive
 * its post-restart cooldown. Forcing never bypasses a refusal — a red main, a failed compile,
 * a swap error, or a boot refusal still blocks — so a press is only meaningful while a restart
 * is actually pending: with a live team whose published build is not stale, nothing is written
 * and the reply says so. With no team running the marker is written harmlessly (the next `run`
 * consumes it on its first poll) and the reply carries the same liveness contract as `wake`.
 * Returns the structured confirmation the CLI prints verbatim and the GUI flashes. */
export function requestRestart(root: string): RequestResult {
  const info = readOrchestratorInfo(root);
  if (info?.build && info.build.stale !== true) {
    return { ok: false, error: "no update is waiting — tumwater is current with main" };
  }
  writeJsonAtomic(restartRequestPath(root), { at: Date.now() });
  const { live, when } = markerApplyNote(root);
  const message =
    `restart requested — ${applyClause(live, when, "applies it")}` +
    (live ? " (the restart cooldown is waived; a blocked restart still blocks)" : "");
  return { ok: true, message };
}

/** The marker-writing core of the model-check re-check, shared with the GUI's POST
 * /api/model-check (part 2/2 of the re-check plan): drop the one-shot marker a running team
 * consumes within one poll — a consumed marker clears every failed pair's back-off, so a fixed
 * server is noticed on the next poll instead of up to 30 minutes out. The check exists only in
 * a long-running team (the orchestrator holds the per-pair state in memory), and the next
 * `tumwater start` re-probes every pair anyway, so with no live team nothing is written and the
 * refusal is returned instead of a marker no one would consume. */
export function requestModelCheck(root: string): RequestResult {
  if (!markerApplyNote(root).live) {
    return { ok: false, error: NO_HARNESS_ERROR };
  }
  writeJsonAtomic(modelCheckRequestPath(root), { at: Date.now() });
  return { ok: true, message: "model check requested — the running team probes every failed pair within ~2s" };
}

/** The marker-writing core of `tumwater reclaim` (plans/disk-floor.md, part 3/4): drop the
 * marker a running orchestrator consumes within one poll and run one manual pass over every
 * candidate, in-use worktrees respected. Returns the confirmation the CLI prints. A caller
 * with no live team must run the pass in-process instead (cmdReclaim), because nothing would
 * consume the marker. */
function requestReclaim(root: string): string {
  writeJsonAtomic(reclaimRequestPath(root), { at: Date.now() });
  const { live, when } = markerApplyNote(root);
  return `reclaim requested — ${applyClause(live, when, "reclaims idle worktrees")}`;
}

/** Queue a prompt for one role and wake that role — the one workflow `tumwater prompt
 * --role`, the dashboard's POST /api/prompt-role, and the TUI's Ctrl+R submit all share:
 * submitRolePrompt enqueues into the role's own queue (length-capped by the shared rule)
 * and logs under the role, then requestWake's single-role marker brings a live team's
 * role in within one poll instead of whenever its backoff next expires (and is safe with
 * no team running — the same contract as `tumwater wake`). Returns requestWake's
 * confirmation so a surface can show what the wake did. Keeping enqueue and wake in one
 * call keeps a surface from ever queueing a prompt without the wake that delivers it
 * promptly — the pairing is the invariant, not each surface's private discipline. An optional
 * `notBeforeMs` defers the prompt (PLANS.md "tumwater prompt --at <duration>"); the wake
 * still fires — it brings the role in at its time to find a deliverable queue, and a queue
 * holding only future prompts keeps it asleep. */
export function submitRolePromptAndWake(root: string, role: string, text: string, images?: PromptImageInput[], notBeforeMs?: number): string {
  submitRolePrompt(root, role, text, images, notBeforeMs);
  return requestWake(root, [role]);
}

/** The marker-writing core of `abort`, shared with the GUI's POST /api/abort: drop the
 * per-role marker a running team consumes within one poll cycle. Reports the liveness gate
 * and the director's discarded-prompt note structurally ({ok, message|error}) so the CLI can
 * fail() and the GUI can shape its 409/200 — neither re-derives the wording. */
export function requestAbort(root: string, role: string): RequestResult {
  if (!orchestratorAlive(root)) {
    return { ok: false, error: NO_HARNESS_ERROR };
  }
  writeJsonAtomic(abortRequestPath(root, role), { at: Date.now() });
  let confirmation = `abort requested for ${role} — the running team applies it within ~2s`;
  if (role === DIRECTOR_ROLE) {
    // The director's in-flight prompt was dequeued from the inbox file at run start and an
    // abort discards it without re-queueing — say so, since the discard is otherwise silent.
    confirmation +=
      "; its current in-flight prompt will be discarded (re-submit with `tumwater prompt` if you want it retried)";
  }
  return { ok: true, message: confirmation };
}

/** The marker-writing core of `tumwater abort --all`, shared with the GUI's POST /api/abort-all:
 * drop one per-role marker per enabled runner (the same ids `runnerIds` names, each enabled role's
 * bare id plus its `-2`… instances) that a running team consumes within one poll cycle — the
 * team-wide twin of `requestAbort`'s one marker for one role. Idle roles' markers are swept by
 * `consumeAbortRequests`' per-marker pass without aborting anything (`removeQuiet` runs even when
 * no runner matches), so passing every enabled id is the same safe no-op `abort --role` of an idle
 * role is. Reports the liveness gate structurally ({ok, message|error}) like requestAbort so the
 * CLI can fail() and the GUI can shape its 409/200. */
export function requestAbortAll(root: string): RequestResult {
  if (!orchestratorAlive(root)) {
    return { ok: false, error: NO_HARNESS_ERROR };
  }
  const { config } = loadConfigCached(root);
  const ids = config ? runnerIds(config) : [];
  if (ids.length === 0) return { ok: false, error: "no roles are enabled to abort" };
  for (const id of ids) writeJsonAtomic(abortRequestPath(root, id), { at: Date.now() });
  return {
    ok: true,
    message: `abort requested for ${plural(ids.length, "role", "roles")} — the running team applies each within ~2s`,
  };
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
  const disabledNote = disabledOf(root, [role]).length > 0
    ? `; ${role} is disabled, so it starts no runs either way — the pause holds once you enable it`
    : "";
  return `role ${role} paused${forPhrase} — it starts no new runs${when} (current runs finish; the rest of the team is unaffected)${note}${disabledNote}${tail}`;
}

/** The per-role resume confirmation, shared between `tumwater resume --role` and the TUI's
 * Ctrl+P for the same no-drift reason. Carries the team-pause interplay note cmdResume
 * phrases: the team pause is the stronger gate, so with its marker present a freshly
 * resumed role still starts no runs (the director is exempt from that gate, so its
 * resumption is real) — saying nothing would promise running the scheduler then deny, the
 * same honest-confirmation contract markerApplyNote's tail serves. */
export function roleResumeMessage(root: string, role: string, changed: boolean): string {
  if (!changed) return `role ${role} was not paused`;
  const { when, tail } = markerApplyNote(root);
  const teamNote = isTeamPaused(root) && role !== DIRECTOR_ROLE
    ? " (the team pause is still active — `tumwater resume` lifts it)"
    : "";
  const starts = disabledOf(root, [role]).length > 0
    ? `it is disabled, so it still starts no runs — enable it with tumwater config set roles.${role}.enabled true`
    : "it starts new runs again";
  return `role ${role} resumed — ${starts}${when}${teamNote}${tail}`;
}

/** The `tumwater pause --for <duration>` cap: 90 days. A timed pause is meant to answer "step
 * away for a while and come back to a resumed team" — the same bound the report's day windows
 * enforce (REPORT_MAX_DAYS in event-window.ts), and comfortably past any absence a deadline
 * should encode. Beyond it the deadline stops being a timed pause and becomes a standing one:
 * bare `pause` (lifted with `resume`) is that, and it says so instead of silently accepting a
 * value whose wall-clock resume time no `Date` can even hold (a `--for 100000000d` once printed
 * "resumes automatically at NaN:NaN:NaN"). Lives beside the marker contract it caps, which
 * every surface shares, so no new `--for` consumer can outgrow it unnoticed. */
export const PAUSE_FOR_MAX_MS = 90 * DAY_MS;

/** The one `tumwater reclaim --json` acknowledgement object, named by what the pass did: with a
 * live team it says the pass was requested (the running team does the cleaning); with none
 * running it says which worktrees it reclaimed and what that freed, or that nothing was
 * reclaimable. The CLI prints it instead of the prose line; the prose itself stays the message
 * in the outcome, so the surfaces that show prose are unchanged. */
type ReclaimAck =
  | { command: "reclaim"; status: "requested" }
  | { command: "reclaim"; status: "nothing_to_reclaim" }
  | {
      command: "reclaim";
      status: "reclaimed";
      worktrees: string[];
      freedGB: number;
      freeGB: number;
      durationMs: number;
    };

/** One manual reclaim, shared by `tumwater reclaim`, the dashboard's POST /api/reclaim and the
 * TUI's Health Ctrl+E: with a live team the pass is requested through the marker the
 * orchestrator consumes (so in-use worktrees are respected); with none running it runs
 * in-process, since nothing is in use. Returns the prose confirmation and its `--json`
 * acknowledgement together, never failing, so a server or TUI can show the prose and a CLI can
 * print the data from one call. */
export async function runManualReclaimOutcome(root: string): Promise<{ message: string; payload: ReclaimAck }> {
  if (markerApplyNote(root).live) {
    return { message: requestReclaim(root), payload: { command: "reclaim", status: "requested" } };
  }
  const result = await reclaimPass(root, "manual", { reclaimGB: 0 });
  if (!result) {
    return { message: "nothing to reclaim", payload: { command: "reclaim", status: "nothing_to_reclaim" } };
  }
  return {
    message: `reclaimed ${result.worktrees.join(", ")} — freed ${formatGB(result.freedGB)}`,
    payload: {
      command: "reclaim",
      status: "reclaimed",
      worktrees: result.worktrees,
      freedGB: result.freedGB,
      freeGB: result.freeGB,
      durationMs: result.durationMs,
    },
  };
}

/** The prose confirmation of a manual reclaim (runManualReclaimOutcome's message): the line
 * `tumwater reclaim`'s text form, the dashboard's POST /api/reclaim and the TUI's Health Ctrl+E
 * all print verbatim. Kept as a one-line wrapper so those callers are unchanged. */
export async function runManualReclaim(root: string): Promise<string> {
  return (await runManualReclaimOutcome(root)).message;
}

/** Wake the role named in an answered question's `(asked by <role> …)` clause, so it reads the
 * decision it was blocked on without waiting out its backoff. Returns requestWake's confirmation,
 * or null when the heading names no known role (asked by the user, an unknown or removed role,
 * or no clause) — never throws for an unknown asker. */
export function wakeQuestionAsker(root: string, title: string): string | null {
  const asker = questionAsker(title);
  if (asker === null || !knownRoleIdsCached(root).includes(asker)) return null;
  return requestWake(root, [asker]);
}
