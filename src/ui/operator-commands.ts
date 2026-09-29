import { knownRoleIds, knownRoleIdsCached, loadConfig, loadConfigSafe } from "../config.js";
import { durationLabel, fail, failOverDurationCap, flagValue, parseDurationFlag, parsePromptArgs, parseRoleFlag, say } from "../cli-args.js";
import {
  type CancelOutcome,
  cancelRolePrompt,
  promptPreview,
  queuedPrompts,
  queuedRolePrompts,
  submitRolePrompt,
} from "../inbox.js";
import { formatTime } from "../datetime.js";
import { errorMessage } from "../text.js";
import { errCode } from "../errno.js";
import { allRoleIds, DIRECTOR_ROLE, unknownRoleMessage } from "../roles.js";
import { loadLoopState, saveLoopState, zeroCounters } from "../loop-state.js";
import { clearBackoff } from "../tick-outcome.js";
import {
  isFleetPaused,
  orchestratorAlive,
  pauseFleet,
  pauseRole,
  pausedRoles,
  readOrchestratorInfo,
  resumeFleet,
  resumeRole,
} from "../fleet-state.js";
import { pidAlive } from "../process.js";
import { writeJsonFile } from "../json-files.js";
import { abortRequestPath, resetRequestPath, wakeRequestPath } from "../paths.js";

/** The CLI half of the operator-intent protocol (the consumer half is src/operator-requests.ts):
 * `reset-counters`, `wake`, `abort`, `pause`, and `resume` write the on-disk markers the fleet
 * reads, split out of cli.ts so the whole marker protocol — producer and consumer — is legible
 * in one place. Every command here is deliberately usable without a live harness except
 * `abort`, which has nothing to consume its one-shot marker when no fleet is up. */

/** How a marker command reports when its marker takes effect, derived from one liveness
 * check: `live` says whether a fleet will consume it now, `when` is the " within ~2s" such a
 * fleet picks it up in, and `tail` names the fallback ("takes effect on the next `tumwater
 * run`") while no harness is running. Every marker command shares this so none can promise a
 * timing the others deny — the one place that user-facing contract lives. */
function markerApplyNote(root: string): { live: boolean; when: string; tail: string } {
  const live = orchestratorAlive(root);
  return {
    live,
    when: live ? " within ~2s" : "",
    tail: live ? "" : "; no harness is running, so it takes effect on the next `tumwater run`",
  };
}

/** The trailing liveness clause of a one-shot marker command's confirmation (reset-counters
 * and wake): with a live fleet, "a running fleet <verb><when>"; without one, where the marker
 * lands instead. The two request* cores share this so their wording cannot drift — pause and
 * resume phrase their own confirmations around markerApplyNote's when/tail because their
 * sentences differ. */
function applyClause(live: boolean, when: string, verb: string): string {
  return live
    ? `a running fleet ${verb}${when}`
    : "takes effect on the next `tumwater run` (no harness is running)";
}

/** The error every live-harness-only command reports (abort, stop): one literal so the two
 * surfaces cannot drift on the message an operator sees when nothing is running. */
const NO_HARNESS_ERROR = "no harness is running — start it with `tumwater run` first";

/** The `--role <id>` value when given, resolved WITHOUT tumwater.json when it names a
 * built-in catalog role: the fleet itself tolerates a broken config (the live reload keeps
 * the last-known-good one), so an operator marker aimed at a built-in loop must not depend
 * on the file parsing — the same resilience `logs --role` already has. A custom-loop id or
 * an unknown id falls through to the config-backed check, which fails with the honest error
 * (the config problem, or "unknown role" naming every valid id). Returns null when no
 * --role is given. */
function namedRole(root: string, args: string[]): string | null {
  const role = flagValue(args, "--role");
  if (role === null) return null;
  if (role && allRoleIds().includes(role)) return role;
  try {
    return parseRoleFlag(args, knownRoleIds(loadConfig(root)));
  } catch (err) {
    fail(errorMessage(err)); // same message main().catch would print, but via the standard fail()
  }
}

/** The role(s) a marker command targets: the `--role <id>` value when given, otherwise every
 * role in the config. reset-counters and wake share the same all-roles default, so it lives
 * here once instead of drifting between their bodies. */
function targetRoles(root: string, args: string[]): string[] {
  const role = namedRole(root, args);
  return role ? [role] : Object.keys(loadConfig(root).roles);
}

/** The marker-writing core of `reset-counters`: zero each target's state file directly (works
 * while the harness is not running) and drop the fleet marker a running fleet consumes within
 * one poll cycle. Returns the confirmation the CLI prints verbatim. Unlike the wake/abort
 * request* cores the GUI's POST endpoints share, no dashboard route exposes reset-counters,
 * so this stays module-internal. */
function requestResetCounters(root: string, roles: string[]): string {
  for (const r of roles) saveLoopState(root, zeroCounters(loadLoopState(root, r)));
  writeJsonFile(resetRequestPath(root), { at: Date.now(), roles });
  // Only a live fleet consumes the marker; without one the state files are already zeroed and
  // the next `tumwater run` is when the in-memory copies catch up. Name which case this is
  // rather than promising a ~2s pickup that no process will make.
  const { live, when } = markerApplyNote(root);
  return `counters reset for ${roles.join(", ")} — ${applyClause(live, when, "picks this up")}`;
}

/** `tumwater reset-counters [--role <id>]`: zero the per-loop counters shown in the
 * dashboards so a fresh observation window can begin. Scheduling fields and pi session
 * continuity are untouched: loops keep sleeping/waking exactly as before. */
export async function cmdResetCounters(root: string, args: string[]): Promise<void> {
  say(requestResetCounters(root, targetRoles(root, args)));
}

/** The marker-writing core of `wake`, shared with the GUI's POST /api/wake: clear the named
 * roles' backoff and pull nextRunAt to now (touching ONLY the schedule — counters, wake
 * tracking, and session continuity are untouched), and drop the marker a running fleet
 * consumes within one poll. Returns the confirmation the CLI prints verbatim and the GUI
 * flashes. */
export function requestWake(root: string, roles: string[]): string {
  const now = Date.now();
  for (const r of roles) saveLoopState(root, clearBackoff(loadLoopState(root, r), now));
  writeJsonFile(wakeRequestPath(root), { at: now, roles });
  // Same liveness contract as reset-counters and pause/resume: only a live fleet consumes the
  // marker, so say so instead of promising a poll that will not happen.
  const { live, when } = markerApplyNote(root);
  return `wake requested for ${roles.join(", ")} — ${applyClause(live, when, "applies it")}`;
}

/** Queue a prompt for one loop and wake that loop — the one workflow `tumwater prompt
 * --role`, the dashboard's POST /api/prompt-role, and the TUI's Ctrl+R submit all share:
 * submitRolePrompt enqueues into the loop's own queue (length-capped by the shared rule)
 * and logs under the loop, then requestWake's single-role marker brings a live fleet's
 * loop in within one poll instead of whenever its backoff next expires (and is safe with
 * no fleet running — the same contract as `tumwater wake`). Returns requestWake's
 * confirmation so a surface can show what the wake did. Keeping enqueue and wake in one
 * call keeps a surface from ever queueing a prompt without the wake that delivers it
 * promptly — the pairing is the invariant, not each surface's private discipline. */
export function submitRolePromptAndWake(root: string, role: string, text: string): string {
  submitRolePrompt(root, role, text);
  return requestWake(root, [role]);
}

/** `tumwater wake [--role <id>]`: tell the fleet "whatever the loops were failing on is
 * fixed — try again", so the named roles tick within one poll instead of sleeping until
 * their backoff expires. */
export async function cmdWake(root: string, args: string[]): Promise<void> {
  say(requestWake(root, targetRoles(root, args)));
}

/** `tumwater abort --role <id>`: kill one loop's in-flight tick right now. The CLI cannot
 * reach into the orchestrator process, so the request rides on disk like reset-counters':
 * a per-role marker file a running fleet consumes within one poll cycle (the runner's
 * abortTick kills the pi child and resets the worktree to main). Requires a live harness —
 * with no fleet there is nothing to consume the marker. The loop stays enabled: it backs
 * off normally and later ticks proceed as usual. */
export async function cmdAbort(root: string, args: string[]): Promise<void> {
  // As in cmdLogs: the config exists only to validate the id against built-ins plus
  // user-defined loops; a missing --role fails before it is ever needed.
  const role = namedRole(root, args);
  if (!role) fail("abort requires --role <id> (e.g. `--role feature`)");
  const result = requestAbort(root, role);
  if (!result.ok) fail(result.error);
  say(result.message);
}

/** The marker-writing core of `abort`, shared with the GUI's POST /api/abort: drop the
 * per-role marker a running fleet consumes within one poll cycle. Reports the liveness gate
 * and the director's discarded-prompt note structurally ({ok, message|error}) so the CLI can
 * fail() and the GUI can shape its 409/200 — neither re-derives the wording. */
export function requestAbort(root: string, role: string): { ok: true; message: string } | { ok: false; error: string } {
  if (!orchestratorAlive(root)) {
    return { ok: false, error: NO_HARNESS_ERROR };
  }
  writeJsonFile(abortRequestPath(root, role), { at: Date.now() });
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
 * reads must not turn "30m" into "1799999ms". Both empty for an indefinite pause, so
 * today's wording stands. */
function timedPauseBits(timed: TimedPause | undefined): { forPhrase: string; note: string } {
  if (!timed) return { forPhrase: "", note: "" };
  return {
    forPhrase: ` for ${durationLabel(timed.ms)}`,
    note: ` — resumes automatically at ${formatTime(new Date(timed.untilMs))}`,
  };
}

/** The per-role pause confirmation `tumwater pause --role` prints and the TUI's Ctrl+P
 * flashes — one literal so the two surfaces cannot drift (the same single-writer discipline
 * requestWake's wording already follows). `changed` is pauseRole's return: false reports the
 * idempotent no-op in the CLI's own words instead of a fresh confirmation. `timed` is the
 * deadline this command's `--for` set, echoed back with its wall-clock resume time; the TUI
 * (which cannot pass a deadline) omits it and keeps the plain wording. */
export function rolePauseMessage(root: string, role: string, changed: boolean, timed?: TimedPause): string {
  if (!changed) return `role ${role} is already paused`;
  const { when, tail } = markerApplyNote(root);
  const { forPhrase, note } = timedPauseBits(timed);
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
 * "resumes automatically at NaN:NaN:NaN"). Lives beside the parse it guards so the CLI's one
 * `--for` surface cannot outgrow it unnoticed. */
const PAUSE_FOR_MAX_MS = 90 * 24 * 60 * 60 * 1000;

/** `tumwater pause [--role <id>] [--for <duration>]`: with a role, stop THAT loop from starting new ticks —
 * in-flight ones finish, every other role (the director included) keeps running; without one,
 * stop every role loop from starting NEW ticks while in-flight ones finish and the director
 * keeps running (its prompts outrank operator gates, like under the budget cap). The markers
 * are persistent state, not one-shot requests: presence means paused until `resume` removes
 * it — so pausing before startup starts an already-paused fleet. Unlike abort, no live
 * harness is required; when none runs, say where the pause takes effect instead of failing.
 * Idempotent: a second pause reports the existing marker as-is. */
export async function cmdPause(root: string, args: string[] = []): Promise<void> {
  // `--for <duration>` (the timed pause): the ms-epoch deadline pauseFleet/pauseRole write
  // into the marker and every consumer honors — the gate in cli.ts has already restricted
  // the flag to this command, so its value is parsed (and fails fast) here, beside the
  // writers it feeds.
  const forRaw = flagValue(args, "--for");
  const forMs = forRaw !== null ? parseDurationFlag("--for", forRaw) : undefined;
  // Fail fast beside the parse, before any marker is written: an over-cap deadline is a
  // standing pause in disguise, and the message names the command that is one (the same
  // capped-flag idiom the --since windows in cli.ts use).
  if (forMs !== undefined)
    failOverDurationCap(
      "pause --for",
      forMs,
      PAUSE_FOR_MAX_MS,
      "for a longer or standing pause run bare `tumwater pause` (lift it with `tumwater resume`)",
    );
  const timed = forMs === undefined ? undefined : { ms: forMs, untilMs: Date.now() + forMs };
  const untilMs = timed?.untilMs;
  // Per-role branch: pauseRole in src/fleet-state.ts is the single writer of the role marker
  // (the plan 2/2 dashboard endpoint will call it too), so CLI and dashboard cannot drift on
  // format or idempotence; a false return means the role was already in the set.
  const role = namedRole(root, args);
  if (role) {
    // pauseRole in src/fleet-state.ts is the single writer of the role marker (the TUI's
    // Ctrl+P calls it too), so CLI and TUI cannot drift on format or idempotence; a false
    // return means the role was already in the set, which rolePauseMessage words — unless a
    // `--for` stands, which overwrites the deadline and reports the fresh confirmation.
    say(rolePauseMessage(root, role, pauseRole(root, role, untilMs), timed));
    return;
  }
  // pauseFleet in src/fleet-state.ts is the single writer of the pause marker — the GUI's
  // /api/pause toggle calls it too, so the CLI and the dashboard cannot drift on format
  // or idempotence; a false return means the marker was already there (a `--for` never
  // no-ops: it overwrites the standing deadline instead).
  if (!pauseFleet(root, untilMs)) {
    say("already paused");
    return;
  }
  const { when, tail } = markerApplyNote(root);
  const { forPhrase, note } = timedPauseBits(timed);
  say(
    `fleet paused${forPhrase} — role loops stop starting new ticks${when} (in-flight ticks finish; the director keeps running your prompts)${note}${tail}`,
  );
}

/** Deliver the stop signal to the recorded orchestrator pid: "signalled" when SIGTERM was
 * delivered, "gone" when the process died between the caller's liveness check and the
 * signal (ESRCH) — stop's goal is already met in that case, so the caller reports it as
 * done instead of failing with a raw `kill ESRCH`. Any other delivery error is rethrown
 * with the pid named: an operator seeing Node's bare "kill EPERM" cannot tell it means a
 * process they cannot signal (recycled pid owned by another user), not a broken harness. */
export function signalOrchestrator(pid: number): "signalled" | "gone" {
  try {
    process.kill(pid, "SIGTERM");
    return "signalled";
  } catch (err) {
    const code = errCode(err);
    if (code === "ESRCH") return "gone";
    if (code === "EPERM")
      throw new Error(
        `stop could not signal pid ${pid} (EPERM) — it is owned by another user or the pid was recycled; kill it directly with \`kill ${pid}\``,
      );
    throw err;
  }
}

/** `tumwater stop`: SIGTERM the running orchestrator, which drains its in-flight ticks and
 * exits — exactly the shutdown the supervised child's own SIGINT/SIGTERM handler performs, so
 * Ctrl+C and `stop` from another terminal are the same code path (the supervisor needs no
 * signal of its own: a clean child exit already ends its loop). Unlike the marker commands
 * above this reaches a real process, so a live harness is required. The pid-recycling risk
 * that `orchestratorAlive` already accepts everywhere (status, abort, pause) applies here
 * too: the info file is refreshed by the live orchestrator, so the window is small, and the
 * signal is the same one a human `kill <pid>` would send. */
export async function cmdStop(root: string): Promise<void> {
  // Deliberately the same liveness gate and wording `requestAbort` uses: an unreadable info
  // file (torn write) and a dead recorded pid both mean nothing is running to stop.
  const info = readOrchestratorInfo(root);
  if (!info || !pidAlive(info.pid)) {
    fail(NO_HARNESS_ERROR);
  }
  // A pid that dies between the liveness check and the signal (ESRCH) means the fleet is
  // already stopped — say so and exit clean rather than surfacing Node's raw kill error;
  // anything else (EPERM on a recycled pid, …) comes back as signalOrchestrator's message.
  if (signalOrchestrator(info.pid) === "signalled")
    say("stop requested — the fleet drains its in-flight ticks and exits (the same path as Ctrl+C)");
  else
    say("the orchestrator exited before the stop signal landed — nothing is running");
}

/** `tumwater config`: print the effective merged config — exactly what `loadConfig(root)`
 * returns — as pretty JSON, so an operator debugging scheduling or custom-loop wiring sees
 * what the fleet would actually load instead of overlaying defaults onto tumwater.json by
 * hand. A query, not a writer: no redaction (the config holds no secrets — provider keys
 * belong to pi's own env) and no transformation, including the per-role entries custom loops
 * merge into. A malformed or invalid tumwater.json fails with validateConfig's actionable
 * message and prints no JSON — the same surfacing doctor's config check produces. */
export async function cmdConfig(root: string): Promise<void> {
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) fail(error); // validateConfig's message, via the standard fail()
  say(JSON.stringify(config, null, 2));
}

/** `tumwater resume [--role <id>]`: with a role, lift that one role's pause (removed from the
 * per-role marker set); without one, lift a fleet pause by removing its marker. Idempotent
 * like pause: with no marker there is nothing to do. No live harness required — resuming
 * before startup just means the next `tumwater run` starts unpaused. */
export async function cmdResume(root: string, args: string[] = []): Promise<void> {
  const role = namedRole(root, args);
  if (role) {
    // resumeRole (src/fleet-state.ts) is the single remover of the per-role marker; a false
    // return means the role was never paused — the changed-state contract roleResumeMessage
    // words ("is already paused" vs "was not paused").
    say(roleResumeMessage(root, role, resumeRole(root, role)));
    return;
  }
  // resumeFleet (src/fleet-state.ts) is the single remover, shared with the GUI toggle; a false
  // return means there was no marker to lift.
  if (!resumeFleet(root)) {
    say("not paused");
    return;
  }
  const { when, tail } = markerApplyNote(root);
  // The per-role pause outlives a fleet resume (the markers are independent), so the resumed
  // fleet's confirmation must name the roles still individually paused instead of claiming
  // "role loops tick again" for loops the scheduler keeps gated.
  const still = pausedRoles(root);
  const roleNote = still.length > 0
    ? ` (${still.join(", ")} ${still.length === 1 ? "is" : "are"} still individually paused — \`tumwater resume --role <id>\` lifts each)`
    : "";
  say(`fleet resumed — role loops tick again${when}${roleNote}${tail}`);
}

/** `tumwater prompt [--role <id>] <text|list|cancel <n>>`: submit a steering prompt to the
 * director (default) or one role's queue, list what is queued with per-loop position
 * numbering, or cancel a queued prompt by position. The dispatcher in cli.ts gates on a ready
 * repo and delegates here; list output is grouped by loop — the director first (its queue is
 * the shared one every pre-1/2 prompt landed in), then each role with queued prompts — so a
 * per-role queue's position numbering stays unambiguous. */
export async function cmdPrompt(root: string, args: string[]): Promise<void> {
  const parsed = parsePromptArgs(args);
  // `--role <id>` scopes every mode to one loop's queue; the value is validated here, with
  // the same message every other --role consumer uses. The director is always valid: its
  // queue is the historical inbox (inbox.ts).
  //
  // Where the id set comes from differs by mode, following parseRoleScope's split: --list is
  // a read-only view, so a transiently broken tumwater.json must not take it down — it falls
  // back to the built-in catalog (knownRoleIdsCached), exactly like cmdLogs/cmdHistory's
  // --role scope, at the cost of a broken config hiding a custom loop's queued section. The
  // state-changing modes (enqueue, cancel) instead read through loadConfig and fail loudly
  // when an id was given: before writing to a named loop's queue the operator is owed the
  // config error, not a built-ins-only guess about whether the loop exists. With no --role
  // neither state-changing mode reads the config at all — the director queue (inbox.ts) needs
  // none, and a broken tumwater.json must not block steering the director.
  const validIds = parsed.mode === "list"
    ? knownRoleIdsCached(root)
    : parsed.role !== null
      ? knownRoleIds(loadConfig(root))
      : null;
  if (validIds !== null && parsed.role !== null && !validIds.includes(parsed.role)) {
    fail(unknownRoleMessage(parsed.role, validIds));
  }
  const role = parsed.role;
  if (parsed.mode === "list") {
    // Full text, verbatim: this is the inspection command that tells you what a queued
    // prompt actually says before you cancel it.
    if (role !== null) {
      const prompts = queuedRolePrompts(root, role);
      if (prompts.length === 0) {
        say(`nothing queued for ${role}`);
      } else {
        say(`${role}:`);
        prompts.forEach((p, i) => say(`${i + 1}. ${p}`));
      }
      return;
    }
    const sections: string[] = [];
    const director = queuedPrompts(root);
    if (director.length > 0) {
      sections.push(`director:\n${director.map((p, i) => `${i + 1}. ${p}`).join("\n")}`);
    }
    for (const r of validIds as string[]) {
      if (r === DIRECTOR_ROLE) continue;
      const prompts = queuedRolePrompts(root, r);
      if (prompts.length > 0) {
        sections.push(`${r}:\n${prompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}`);
      }
    }
    if (sections.length === 0) {
      say("nothing queued");
    } else {
      say(sections.join("\n"));
    }
    return;
  }
  if (parsed.mode === "cancel") {
    const target = role ?? DIRECTOR_ROLE;
    let outcome: CancelOutcome;
    try {
      outcome = cancelRolePrompt(root, target, parsed.position);
    } catch (err) {
      fail(errorMessage(err));
    }
    if (outcome.status === "gone") {
      // A concurrent dequeue is a normal race, not an error: report it and exit clean.
      say(`prompt ${parsed.position} is no longer queued — ${target} already took it`);
    } else {
      say(`cancelled: ${promptPreview(outcome.text)}`);
    }
    return;
  }
  const target = role ?? DIRECTOR_ROLE;
  const wake = submitRolePromptAndWake(root, target, parsed.text);
  if (role === null) {
    say("queued for the director loop");
  } else {
    say(`queued for the ${role} loop`);
  }
  say(wake);
}
