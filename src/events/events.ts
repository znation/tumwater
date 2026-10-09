import fs from "node:fs";
import { eventsLogPath } from "../paths.js";
import { ensureParentDir, openForRead, rotateIfLarge, statOrNull } from "../files/files.js";
import { errorMessage } from "../text/text.js";

type EventListener = (event: HarnessEvent) => void;
const listeners = new Set<EventListener>();

/** Get notified of every event logged in this process (e.g. to narrate `tumwater run`).
 * Returns an unsubscribe function. */
export function subscribeEvents(listener: EventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** events.jsonl rotation threshold. Role pi logs use the configurable logMaxBytes; the
 * harness event log is small per event, so a fixed cap keeps logEvent config-free. Exported
 * because the report headers name the threshold — a fact only this module owns. */
export const EVENTS_MAX_BYTES = 16 * 1024 * 1024;

/** The rotation phrase the report headers render — `eventsRotationLabel()` rather than a
 * hardcoded "rotated at 16 MB" copy, so changing EVENTS_MAX_BYTES updates the header with it
 * instead of leaving every report claiming a size the log no longer rotates at. */
export function eventsRotationLabel(): string {
  return `rotated at ${EVENTS_MAX_BYTES / (1024 * 1024)} MB`;
}

/** One line in .tumwater/log/events.jsonl: what logEvent appends (a HarnessEventInput plus
 * its `ts` stamp) and every consumer (event-window, history, the report and failure
 * collectors) reads back. */
export interface HarnessEvent {
  ts: number;
  loop: string;
  type:
    | "tick_start" // carries tick; model when one is configured — the selector string (formatModelSelector) of the config the tick's runs start on (the budget fallback included)
    | "tick_end"
    | "land_queued" // a changed tick pinned its commit and enqueued it for the orchestrator's landing slot (merge queue 3/5); carries sha + summary
    | "landed" // the landing slot finished with the change on main; carries commit, the lander's outcome, durationMs, and the landing's own usage
    | "land_failed" // the landing slot finished without landing (review rejection, under-cap review failure, conflict, blocked ff, shutdown abort); carries the same payload — retry rides next-tick leftover recovery, never the queue
    | "merged"
    | "question_posted" // a merged diff added an entry to QUESTIONS.md's ## Open
    | "wake"
    | "tick_deferred" // need-based prioritization: a due maintenance tick was deferred; carries reason "backlog" (PLANS.md `## Planned` or BUGS.md `## Open` non-empty) or "no-work" (no feature/bugfix/director/human commit since its last no_change tick); one per deferral episode
    | "orchestrator_start"
    | "orchestrator_stop"
    | "prompt_enqueued"
    | "prompt_cancelled" // a queued prompt was removed before the director ran it (tumwater prompt --cancel)
    | "prompt_edited" // a queued prompt's text was rewritten in place (tumwater prompt --edit)
    | "counters_reset"
    | "tick_aborted" // a user-initiated abort killed one loop's in-flight tick (tumwater abort)
    | "resume"
    | "review_start" // carries head; model when one is configured — the reviewer's selector string; revision (round) when the landing is a revision (plans/revise-rejected.md part 2/2)
    | "review_verdict" // approved; carries durationMs of the reviewer run
    | "review_rejected" // build pre-check or reviewer said no; durationMs when a reviewer ran
    | "review_failed"
    | "revision" // a rejected change's revision round: action applied|conflict|dropped|exhausted, with round and sha (plans/revise-rejected.md)
    | "conflict_handback" // a change whose landings kept conflicting was handed back to its author with the markers in place (PLANS.md "Robust conflict landing, part 2/2"); action queued|applied, with sha, reason landing|revision, and the conflicted paths on a successful re-apply
    | "build_check" // the project's declared check ran: scope gate|baseline|landing|batch (landing is the merge lock's post-rebase re-check; batch is the batch lander's one check over the stacked tree), status, script, durationMs; spawnedAt/settledAt when a process ran, plus timeoutMs/deadlineLateMs when its deadline fired, and sleptMs when the host slept mid-run (build/build-check-events.ts buildCheckRunFields); installed/installMs (plus installError) when the check first installed the tree's drifted lockfile (build/dep-install.ts)
    | "dep_install" // the root checkout's install was re-synced after a landing moved main's lockfile (build/dep-install.ts syncRootInstall): packages (the drifted direct dependencies), status passed|failed, durationMs, error on a failure
    | "budget_warning" // fleet daily spend crossed 80% of maxDailyCostUsd; the gate is still open
    | "budget_paused" // fleet daily spend reached maxDailyCostUsd with no usable free fallback; role loops stop starting ticks
    | "budget_fallback" // fleet daily spend reached maxDailyCostUsd and a cost-free fallback model is configured; role loops keep ticking on it
    | "budget_resumed" // the cap was raised/disabled or a new local day started; role loops tick again
    | "budget_handback" // at budget_resumed: the in-flight ticks still on the fallback were handed back to the primary (roles, provider, model)
    | "fleet_paused" // operator pause via `tumwater pause`; role loops stop starting new ticks, director exempt
    | "fleet_resumed" // the pause was lifted (`tumwater resume`); role loops tick again
    | "role_paused" // operator pause via `tumwater pause --role <id>`; that one role stops starting new ticks (carries role)
    | "role_resumed" // the per-role pause was lifted (`tumwater resume --role <id>`); that role ticks again (carries role)
    | "role_streak_paused" // the error-streak circuit breaker auto-paused a role after ERROR_STREAK_BREAKER consecutive failed ticks (src/gates/streak-gate.ts); carries role, streak, lastError when one is recorded
    | "role_cap_paused" // the role's local-day spend reached its maxDailyCostUsdPerRole cap (src/gates/role-cap-gates.ts); it starts no new ticks until local midnight or a live edit; carries role, spentUsd, capUsd
    | "role_cap_resumed" // the cap was raised/removed or a new local day started; that role ticks again (carries role)
    | "maintenance_quota_hold" // code-maintenance landings in the rolling 24 h window reached the allowance (plans/work-ratio.md, part 1b/4, src/gates/maintenance-quota.ts); the enabled maintenance loops start no new ticks until it re-opens; carries work, maint, allowance
    | "maintenance_quota_resumed" // the rolling window re-opened below the allowance; the held maintenance loops tick again; carries work, maint, allowance
    | "bootstrap_complete" // the bootstrap gate's plan target was reached (plans/work-ratio.md, part 2/2); the latch .tumwater/bootstrap-complete.json is written and the held maintenance loops are admitted; carries plansDone, untilPlansDone
    | "quiet_hours_started" // the configured quietHours window began; role loops stop starting new ticks until it ends, director exempt (carries window)
    | "quiet_hours_ended" // the configured quietHours window ended; role loops tick again (carries window)
    | "disk_low" // free space on the worktrees volume dropped below diskHoldGB; no new work starts — role ticks, the director, vets and merges — until it climbs DISK_HOLD_HYSTERESIS_GB above (carries freeGB, holdGB)
    | "disk_ok" // the disk hold lifted: free space climbed back above diskHoldGB + the hysteresis band, or diskHoldGB was edited to 0; new work starts again (carries freeGB)
    | "disk_reclaim" // a reclaim pass deleted gitignored files from idle worktrees (plans/disk-floor.md, part 2/4); carries mode (pressure|idle|manual), the cleaned worktrees' basenames, the statfs delta freedGB, freeGB after the pass, and durationMs
    | "claim" // a work instance took (action assigned) or dropped (action released) its backlog entry; carries action, key, title and reason (src/scheduling/claims.ts)
    | "slot_wait" // a pooled worktree lease waited SLOT_WAIT_EVENT_MS or more for a free slot; carries role, purpose, waitedMs, slots and pinned — the signal to raise worktreeSlots (plans/worktree-pool.md, part 5/5)
    | "rate_limit_hold" // several roles' runs ended on the same provider failure kind within a short window — 429s, or a connection/timeout/5xx/model-load backend failure (src/fleet/fleet-hold.ts); role loops on that provider — every role when the reviewer's is hit — start nothing new until it re-opens; carries kind, roles, holdMs, escalation, and provider when one is configured
    | "rate_limit_resumed" // one provider's hold (429 or backend-failure kind) reached its deadline; roles on that provider tick again; carries the ended hold's kind, and provider when one is configured
    | "max_concurrent_changed" // a live tumwater.json edit resized the concurrency cap (from → to)
    | "retention_changed" // a live tumwater.json edit changed sessionRetentionDays (from → to)
    | "config_changed" // a live tumwater.json edit changed other settings (keys)
    | "model_changed" // a live tumwater.json edit changed the fleet's model wiring; carries from/to (fleetModelLabel of the previous/next config) and roles (the per-role selector diffs) when a roles.<id> model override changed
    | "model_fallback_started" // a role tripped its model-fallback episode after consecutive provider-class failures on the primary; carries provider/model of the fallback pair and the tripping reason
    | "model_fallback_ended" // a probe tick on the primary answered without a provider failure; carries durationMs of the episode and the primary's provider/model
    | "build_stale" // main's build inputs moved past the running build (self-hosting fleets; src/redeploy/redeploy.ts)
    | "restart_pending" // main is green and compiling; no new ticks start until the restart lands
    | "restart" // dist/ now holds the new build; the orchestrator exits for the supervisor to respawn it
    | "restart_refused" // a new generation would fail `tumwater run`'s startup gate here (reason); the running build stays and the gate is re-asked every poll
    | "restart_blocked" // the restart for main was blocked and latched (reason: red main, a failed compile, a swap error); the running build stays until main moves
    | "restart_forced" // the operator pressed the dashboard's restart button: the pending restart's cooldown deferral is waived for the next poll (carries build)
    | "supervisor_exit" // the supervisor gave up without the operator asking: a generation exited with a failure (code/signal, reason when the startup gate names one) or the crash-loop guard tripped — the fleet is down
    | "warning";
  [key: string]: unknown;
}
/** An event to log. `logEvent` stamps `ts`; event-specific extra fields (tick, summary, …)
 * are allowed via the index signature. Exported for modules that hand events to an injected
 * logger instead of calling logEvent directly (redeploy.ts). */
export interface HarnessEventInput {
  loop: string;
  type: HarnessEvent["type"];
  [key: string]: unknown;
}

/** The usage fields an event carries, as a fragment with both omitted when zero — the
 * omit-when-zero convention the two usage-emitters apply (tick-finalize.ts's tick_end,
 * landing-slot.ts's landed/land_failed): a zero-token, zero-cost run (a free model, an abort
 * before any tokens) renders without usage, so event-format's usage fragment and
 * `tumwater history` show nothing rather than "$0.00". Spreading the fragment keeps the
 * fields absent rather than 0; readers (event-read.ts's eventUsage and the index-signature
 * consumers) treat absent and 0 identically. Its two call sites are the logEvent emissions
 * that carry usage. */
export function usageFragment(
  tokens: number,
  costUsd: number,
): { tokens?: number; costUsd?: number } {
  return {
    ...(tokens > 0 ? { tokens } : {}),
    ...(costUsd > 0 ? { costUsd } : {}),
  };
}

/** Append one event to the project's events.jsonl and notify in-process subscribers.
 * A torn trailing line (a crash or power loss mid-append leaves the last line without its
 * newline) is terminated first: appended raw, the new event would glue onto the fragment and
 * both lines would fail JSON.parse forever — one complete event lost from every consumer
 * (report totals, feeds) until rotation. The termination check re-reads the log's last byte,
 * so it runs only when the file's shape differs from what this process's last append left —
 * a steady stream of events costs one stat, not an fd cycle, per event. */
export function logEvent(root: string, event: HarnessEventInput): HarnessEvent {
  const full = { ts: Date.now(), ...event };
  const file = eventsLogPath(root);
  ensureParentDir(file);
  rotateIfLarge(file, EVENTS_MAX_BYTES);
  appendEventLine(file, JSON.stringify(full) + "\n");
  for (const listener of listeners) listener(full);
  return full;
}

/** Log a warning event: the harness's "something is off but the loop continues" signal. The
 * single home of the `{ loop, type: "warning", message }` shape every warn site constructs —
 * without it, each caller restates the event object and a field can drift between them. */
export function warnEvent(root: string, loop: string, message: string): HarnessEvent {
  return logEvent(root, { loop, type: "warning", message });
}

/** logEvent for a caller on a path that cannot handle a throw — the orchestrator's
 * catch-less poll loop and the gate family it runs every couple of seconds. An unwritable
 * events feed (ENOSPC, EACCES, the path replaced) must not skip the caller's real work; the
 * failure is reported on stderr so it stays visible rather than swallowed. */
export function logEventBestEffort(root: string, event: HarnessEventInput): void {
  try {
    logEvent(root, event);
  } catch (err) {
    process.stderr.write(
      `tumwater: ${event.loop}: could not log ${event.type} event: ${errorMessage(err)}\n`,
    );
  }
}

/** warnEvent's twin of logEventBestEffort: the "something is off but the loop continues"
 * warning must not be the thing that ends the loop it warns about. The fallback keeps the
 * warning's own text on stderr — when the feed is the failure, this line is the only place the
 * caller's message (a spawn failure, a rejected tick) survives to be read. The single home of
 * the try-warn → message-bearing-stderr-fallback shape, so the notify hook and the launch pass
 * do not each carry a copy of it. */
export function warnEventBestEffort(root: string, loop: string, message: string): void {
  try {
    warnEvent(root, loop, message);
  } catch (err) {
    process.stderr.write(
      `tumwater: ${loop}: ${message} (warning log unwritable: ${errorMessage(err)})\n`,
    );
  }
}

/** The shape this process's last event append left a log in, per log path: while the file
 * still stats exactly this way, its last byte is the newline our own append wrote, so the
 * torn-tail check's open/fstat/last-byte read is redundant. Any other stat — an operator
 * command's append from another process, a rotation's fresh inode, a crash-sibling's torn
 * fragment — misses the memo and re-checks, so the safety property is unchanged. One entry
 * per log path this process has appended to (a handful; no cap needed). */
const appendedShape = new Map<string, { dev: number; ino: number; size: number }>();

/** Append one complete event line to `file`, terminating a torn trailing line first unless
 * the file's stat still matches the shape this process's last append left it in (see
 * appendedShape). A first-ever append (no file yet) records no shape — the next call stats
 * the new file and memoizes it. */
function appendEventLine(file: string, line: string): void {
  const st = statOrNull(file);
  const memo = st ? appendedShape.get(file) : undefined;
  const knownClean =
    st !== null && memo !== undefined && memo.dev === st.dev && memo.ino === st.ino && memo.size === st.size;
  const terminated = knownClean ? false : terminateTornTail(file, st);
  fs.appendFileSync(file, line);
  if (st) {
    appendedShape.set(file, {
      dev: st.dev,
      ino: st.ino,
      // The append writes UTF-8 BYTES, so the growth is Buffer.byteLength, not the string's
      // code-unit length: a multi-byte event line (an em dash in an agent's message is enough)
      // would otherwise leave the memo short of the file's real size, every later stat would
      // miss it, and the memo would silently never hit on the fleet's actual traffic.
      size: st.size + (terminated ? 1 : 0) + Buffer.byteLength(line, "utf8"),
    });
  } else {
    appendedShape.delete(file);
  }
}

/** Append a newline when `file`'s last byte is not one — terminating a torn trailing line so
 * the next append starts on its own line instead of gluing onto the fragment. Returns whether
 * a newline was appended (the caller folds it into the memoized post-append shape). No-op for
 * a missing, empty, or already-terminated file; never throws (a vanished file just means there
 * is nothing to terminate). `st` is the caller's fresh stat of `file`; the opened fd is still
 * fstat'd for size — correct even if rotation renamed the file between the stat and the open.
 * Runs after rotateIfLarge: rotation moves any torn tail into the unread `.1` archive and
 * starts an empty file that needs no termination. */
function terminateTornTail(file: string, st: { size: number } | null): boolean {
  if (!st || st.size === 0) return false; // No log yet.
  const fd = openForRead(file);
  if (fd === null) return false; // Vanished between stat and open — nothing to terminate.
  try {
    const size = fs.fstatSync(fd).size; // fstat on the opened inode: correct even if rotation renamed the file mid-check.
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    const got = fs.readSync(fd, buf, 0, 1, size - 1);
    if (got !== 1 || (buf[0] ?? 0) === 10) return false; // Already newline-terminated (or vanished).
    fs.appendFileSync(file, "\n");
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

// The READ side of this feed — parseEventLine, the per-event query conventions
// (eventDayKey/eventRole/eventUsage, tickStartMap/tickSpanMs), and the stat-cached tail
// reader (readEvents/readEventsTailWithEnd) — lives in event-read.ts, so the append path's
// fs machinery and stat-memo cache stay apart from the read path's parse-and-scan machinery
// and its own stat-keyed cache. Human-facing formatting of events lives in event-format.ts;
// the windowed reader in event-window.ts; both beside this module because each is used by
// both display surfaces (src/ui/) and core consumers (the `run` banner's live stream,
// cli/cli-run.ts), and src/ui/ is imported only by itself and the CLI command layer that
// drives it (cli.ts and the src/ command bodies — DEVELOPMENT.md Layout).
