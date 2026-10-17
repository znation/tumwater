import fs from "node:fs";
import { eventsLogPath } from "../paths.js";
import { ensureParentDir, rotateIfLarge, sameStatIdentity, statOrNull, terminateTornTail } from "../files/files.js";
import { normalizeLegacyEvent } from "./event-legacy.js";
import { errorMessage, stripTerminalControls } from "../text/text.js";

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
  /** The runner id that wrote the event, or TUMWATER_SOURCE for tumwater's own events. */
  source: string;
  type:
    | "run_start" // carries run; model when one is configured — the selector string (formatModelSelector) of the config the tick's runs start on (the budget fallback included)
    | "run_end"
    | "merge_queued" // a changed tick pinned its commit and enqueued it for the orchestrator's merge slot (merge queue 3/5); carries sha + summary
    | "merge_done" // the merge slot finished with the change on main; carries commit, the merger's outcome, durationMs, queuedMs (enqueue to outcome), and the merge's own usage
    | "merge_failed" // the merge slot finished without merging (review rejection, under-cap review failure, conflict, blocked ff, shutdown abort); carries the same payload (including queuedMs and the entry's summary) — retry rides next-tick leftover recovery, never the queue
    | "merged"
    | "question_posted" // a merged diff added an entry to QUESTIONS.md's ## Open
    | "entry_refused" // a refusal tick's objection note merged on main (src/verdict/refusal.ts handleRefusal); carries reason, files and entries (the stamp-free titles of the plans and bugs whose Refused note is new) — the entry stays held until a human or the director lifts it
    | "wake"
    | "run_deferred" // need-based prioritization: a due maintenance tick was deferred; carries reason "backlog" (PLANS.md `## Planned` or BUGS.md `## Open` non-empty) "no-work" (no feature/bugfix/director/operator/human commit since its last no_change tick), or "plans-full" (the plan loop's PLANS.md already holds its eligible-plan target); one per deferral episode
    | "orchestrator_start"
    | "orchestrator_stop"
    | "prompt_enqueued"
    | "prompt_cancelled" // a queued prompt was removed before the director ran it (tumwater prompt --cancel)
    | "prompt_edited" // a queued prompt's text was rewritten in place (tumwater prompt --edit)
    | "prompt_taken" // a tick dequeued a queued user prompt to run it (carries `run` and `preview`)
    | "counters_reset"
    | "run_aborted" // a user-initiated abort killed one loop's in-flight tick (tumwater abort)
    | "resume" // the interrupted tick's session is picked back up; carries cause (restart|cut-off|hung-tool|timeout|budget-resumed|handoff)
    | "review_start" // carries head; model when one is configured — the reviewer's selector string; revision (round) when the merge is a revision (plans/revise-rejected.md part 2/2); resumed true when the run continues a timed-out reviewer's session (PLANS.md, review-retry part 3/3)
    | "review_verdict" // approved; carries durationMs of the reviewer run
    | "review_rejected" // build pre-check or reviewer said no; durationMs when a reviewer ran
    | "review_failed"
    | "revision" // a rejected change's revision round: action applied|conflict|dropped|exhausted, with round and sha (plans/revise-rejected.md)
    | "conflict_handback" // a change whose merges kept conflicting was handed back to its author with the markers in place (PLANS.md "Robust conflict landing, part 2/2"); action queued|applied, with sha, reason merge|revision, and the conflicted paths on a successful re-apply
    | "build_check" // the project's declared check ran: scope gate|baseline|merge|batch (merge is the merge lock's post-rebase re-check; batch is the batch merger's one check over the stacked tree), status, script, durationMs; spawnedAt/settledAt when a process ran, plus timeoutMs/deadlineLateMs when its deadline fired, and sleptMs when the host slept mid-run (build/build-check-events.ts buildCheckRunFields); installed/installMs (plus installError) when the check first installed the tree's drifted lockfile (build/dep-install.ts)
    | "dep_install" // the root checkout's install was re-synced after a merge moved main's lockfile (build/dep-install.ts syncRootInstall): packages (the drifted direct dependencies), status passed|failed, durationMs, error on a failure
    | "budget_warning" // team daily spend crossed 80% of maxDailyCostUsd; the gate is still open
    | "budget_paused" // team daily spend reached maxDailyCostUsd with no usable free fallback; role loops stop starting ticks
    | "budget_fallback" // team daily spend reached maxDailyCostUsd and a cost-free fallback model is configured; role loops keep ticking on it
    | "budget_resumed" // the cap was raised/disabled or a new local day started; role loops tick again
    | "budget_handback" // at budget_resumed: the in-flight ticks still on the fallback were handed back to the primary (roles, provider, model); reason "window" when a used-up claude window reset rather than the budget
    | "fallback_switched" // a tier moved to a different step of its fallback chain, or back to its primary; carries `tiers` (tier → from, to, reason: window|reserve|cap|step-cap|overage|demoted|available; a null from/to is the primary)
    | "team_paused" // operator pause via `tumwater pause`; role loops stop starting new ticks, director exempt
    | "team_resumed" // the pause was lifted (`tumwater resume`); role loops tick again
    | "role_paused" // operator pause via `tumwater pause --role <id>`; that one role stops starting new ticks (carries role)
    | "role_resumed" // the per-role pause was lifted (`tumwater resume --role <id>`); that role ticks again (carries role)
    | "role_streak_paused" // the error-streak circuit breaker auto-paused a role after ERROR_STREAK_BREAKER consecutive failed ticks (src/gates/streak-gate.ts); carries role, streak, lastError when one is recorded
    | "role_cap_warning" // the role's local-day spend crossed 80% of its maxDailyCostUsdPerRole cap while it is still ticking (src/gates/role-cap-gates.ts); carries role, spentUsd, capUsd
    | "role_cap_paused" // the role's local-day spend reached its maxDailyCostUsdPerRole cap (src/gates/role-cap-gates.ts); it starts no new ticks until local midnight or a live edit; carries role, spentUsd, capUsd
    | "role_cap_resumed" // the cap was raised/removed or a new local day started; that role ticks again (carries role)
    | "main_red_hold" // main's declared check is verified red; warnMainRedOnce (src/baseline/main-red.ts) logs it once per process per newly verified red main SHA, and every code loop skips authoring until main is green; carries sha, script, message
    | "maintenance_quota_hold" // code-maintenance merges in the rolling 24 h window reached the allowance (plans/work-ratio.md, part 1b/4, src/gates/maintenance-quota.ts); the enabled maintenance loops start no new ticks until it re-opens; carries work, maint, allowance
    | "maintenance_quota_resumed" // the rolling window re-opened below the allowance; the held maintenance loops tick again; carries work, maint, allowance
    | "bootstrap_complete" // the bootstrap gate's plan target was reached (plans/work-ratio.md, part 2/2); the latch .tumwater/bootstrap-complete.json is written and the held maintenance loops are admitted; carries plansDone, untilPlansDone
    | "quiet_hours_started" // the configured quietHours window began; role loops stop starting new ticks until it ends, director exempt (carries window)
    | "quiet_hours_ended" // the configured quietHours window ended; role loops tick again (carries window)
    | "disk_low" // free space on the worktrees volume dropped below diskHoldGB; no new work starts — role ticks, the director, verification and merges — until it climbs DISK_HOLD_HYSTERESIS_GB above (carries freeGB, holdGB)
    | "disk_ok" // the disk hold lifted: free space climbed back above diskHoldGB + the hysteresis band, or diskHoldGB was edited to 0; new work starts again (carries freeGB)
    | "disk_reclaim" // a reclaim pass deleted gitignored files from idle worktrees (plans/disk-floor.md, part 2/4); carries mode (pressure|idle|manual), the cleaned worktrees' basenames, the statfs delta freedGB, freeGB after the pass, and durationMs
    | "claim" // a work instance took (action assigned) or dropped (action released) its backlog entry; carries action, key, title and reason (src/scheduling/claims.ts)
    | "permit_reserve" // the permits withheld from maintenance for work loops that have work to take changed (plans/parallel-work-instances.md part 7/7); carries reserve
    | "slot_wait" // a pooled worktree lease waited SLOT_WAIT_EVENT_MS or more for a free slot; carries role, purpose, waitedMs, slots and pinned — the signal to raise worktreeSlots (plans/worktree-pool.md, part 5/5)
    | "rate_limit_hold" // several roles' runs ended on the same provider failure kind within a short window — 429s, or a connection/timeout/5xx/model-load backend failure (src/team/team-hold.ts); role loops on that provider — every role when the reviewer's is hit — start nothing new until it re-opens; carries kind, roles, holdMs, escalation, and provider when one is configured
    | "rate_limit_resumed" // one provider's hold (429 or backend-failure kind) reached its deadline; roles on that provider tick again; carries the ended hold's kind, and provider when one is configured
    | "claude_window_reserved" // a subscription usage window reached its claudeWindowReserve fraction; carries windowType, utilization, reserve and resetsAt; once per window, the team stops using the subscription until it resets
    | "claude_window_warning" // the claude.ai subscription usage window first reported allowed_warning; carries the window type and its resetsAt when reported; once per window, observational (it gates nothing)
    | "claude_window_limited" // a rejected claude.ai subscription window placed the provider-wide hold; claude seams start nothing new until resetsAt; carries the window type and resetsAt, and `tiers` (tier → fallback pair) when the window moved model jobs to a fallback; once per window
    | "claude_window_reset" // the subscription window hold reached resetsAt and lifted; claude seams tick again; once per window
    | "max_concurrent_changed" // a live tumwater.json edit resized the concurrency cap (from → to)
    | "provider_concurrency_changed" // a live tumwater.json edit changed one provider's concurrency cap (provider, from → to)
    | "retention_changed" // a live tumwater.json edit changed sessionRetentionDays (from → to)
    | "config_changed" // a live tumwater.json edit changed other settings (keys)
    | "model_changed" // a live tumwater.json edit changed the team's model wiring; carries from/to (teamModelLabel of the previous/next config) and roles (the per-role selector diffs) when a roles.<id> model override changed
    | "backend_binary" // a live tumwater.json edit newly routed a seam to a backend the previous config did not use; carries agent and found (the resolved binary was present) — the binary check's verdict, logged so a newly added backend is verified like startup would
    | "model_fallback_started" // a role tripped its model-fallback episode after consecutive provider-class failures on the primary; carries provider/model of the fallback pair and the tripping reason
    | "model_fallback_ended" // a probe tick on the primary answered without a provider failure; carries durationMs of the episode and the primary's provider/model
    | "image_blind" // a run's agent read an image its model cannot see (plans/image-input.md "Detecting a blind read"): pi strips such images, so an authoring run was killed and the tick fails — carried as loop, run, path, model, and action "fail" when the authoring run was killed, "logged" when only a gate run recorded the read
    | "image_reroute" // a tick stopped for a blind image read moves its work to a tier that CAN read images (plans/image-input.md part 4/5): the next tick starts directly on the target — carried as loop, run, from, to, tier, and preflight true when the hop happened at model choice (an attachment preflight) before any run, false when it followed a blind-read failure
    | "build_stale" // main's build inputs moved past the running build (self-hosting teams; src/redeploy/redeploy.ts)
    | "restart_pending" // main is green; no new ticks start until the restart lands
    | "restart" // dist/ now holds the new build; the orchestrator exits for the supervisor to respawn it
    | "restart_refused" // a new generation would fail `tumwater run`'s startup gate here (reason); the running build stays and the gate is re-asked every poll
    | "restart_blocked" // the restart for main was blocked and latched (reason: red main, a failed compile, a swap error); the running build stays until main moves
    | "restart_forced" // the operator pressed the dashboard's restart button: the pending restart's cooldown deferral is waived for the next poll (carries build)
    | "supervisor_exit" // the supervisor gave up without the operator asking: a generation exited with a failure (code/signal, reason when the startup gate names one) or the crash-loop guard tripped — the team is down
    | "state_migrated" // a startup migration moved persisted state to its current name (src/orchestrator/startup-migrations.ts): step, moved (count), detail
    | "warning";
  [key: string]: unknown;
}
/** An event to log. `logEvent` stamps `ts`; event-specific extra fields (tick, summary, …)
 * are allowed via the index signature. Exported for modules that hand events to an injected
 * logger instead of calling logEvent directly (redeploy.ts). */
export interface HarnessEventInput {
  source: string;
  type: HarnessEvent["type"];
  [key: string]: unknown;
};

/** The `source` of events tumwater writes about itself rather than on a role's behalf. */
export const TUMWATER_SOURCE = "tumwater";

/** The usage fields an event carries, as a fragment with both omitted when zero — the
 * omit-when-zero convention the two usage-emitters apply (tick-finalize.ts's run_end,
 * merge-slot.ts's merge_done/merge_failed): a zero-token, zero-cost run (a free model, an abort
 * before any tokens) renders without usage, so event-format's usage fragment and
 * `tumwater history` show nothing rather than "$0.00". Spreading the fragment keeps the
 * fields absent rather than 0; readers (event-read.ts's eventUsage and the index-signature
 * consumers) treat absent and 0 identically. Its two call sites are the logEvent emissions
 * that carry usage. */
export function usageFragment(
  tokens: number,
  costUsd: number,
  notionalCostUsd = 0,
): { tokens?: number; costUsd?: number; notionalCostUsd?: number } {
  return {
    ...(tokens > 0 ? { tokens } : {}),
    ...(costUsd > 0 ? { costUsd } : {}),
    // Subscription spend rides on the same fragment (plans/agent-backends.md part 6a): it is
    // omitted when zero like the other fields, so an API-only team's lines are unchanged.
    ...(notionalCostUsd > 0 ? { notionalCostUsd } : {}),
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
  const full = normalizeLegacyEvent({ ts: Date.now(), ...event }) as HarnessEvent;
  const file = eventsLogPath(root);
  ensureParentDir(file);
  rotateIfLarge(file, EVENTS_MAX_BYTES);
  appendEventLine(file, JSON.stringify(full) + "\n");
  for (const listener of listeners) listener(full);
  return full;
}

/** Log a warning event: the harness's "something is off but the loop continues" signal. The
 * single home of the `{ source, type: "warning", message }` shape every warn site constructs —
 * without it, each caller restates the event object and a field can drift between them. */
export function warnEvent(root: string, source: string, message: string): HarnessEvent {
  return logEvent(root, { source, type: "warning", message });
}

/** logEvent for a caller on a path that cannot handle a throw — the orchestrator's
 * catch-less poll loop and the gate family it runs every couple of seconds. An unwritable
 * events feed (ENOSPC, EACCES, the path replaced) must not skip the caller's real work; the
 * failure is reported on stderr so it stays visible rather than swallowed. */
export function logEventBestEffort(root: string, event: HarnessEventInput): void {
  try {
    logEvent(root, event);
  } catch (err) {
    // A terminal display boundary like cli-output's say()/fail(): the loop id, event type, and
    // error text can carry model- or subprocess-supplied bytes, and stderr is a terminal. Strip
    // the control characters the same way so a fallback line cannot drive the operator's shell.
    const detail = `${event.source}: could not log ${event.type} event: ${errorMessage(err)}`;
    process.stderr.write(`tumwater: ${stripTerminalControls(detail)}\n`);
  }
}

/** warnEvent's twin of logEventBestEffort: the "something is off but the loop continues"
 * warning must not be the thing that ends the loop it warns about. The fallback keeps the
 * warning's own text on stderr — when the feed is the failure, this line is the only place the
 * caller's message (a spawn failure, a rejected tick) survives to be read. The single home of
 * the try-warn → message-bearing-stderr-fallback shape, so the notify hook and the launch pass
 * do not each carry a copy of it. */
export function warnEventBestEffort(root: string, source: string, message: string): void {
  try {
    warnEvent(root, source, message);
  } catch (err) {
    // The warning's own text is very often model-supplied (a stalled tool call's label, a tick's
    // lastError) and the loop id can be a custom one, so this fallback is a terminal boundary:
    // sanitize exactly as say()/fail() do before the line reaches the operator's terminal.
    const detail = `${source}: ${message} (warning log unwritable: ${errorMessage(err)})`;
    process.stderr.write(`tumwater: ${stripTerminalControls(detail)}\n`);
  }
}

/** The `{ emit, warn }` pair for a caller on a catch-less path (the orchestrator's poll loop
 * and the live config reload it drives): both route through logEventBestEffort and
 * warnEventBestEffort, so the "an unwritable feed must not end the team" policy has one home
 * and the harness-loop warning shorthand cannot drift from warnEvent's event shape. */
export function bestEffortEventLogger(root: string): {
  emit: (event: HarnessEventInput) => void;
  warn: (message: string) => void;
} {
  return {
    emit: (event) => logEventBestEffort(root, event),
    warn: (message) => warnEventBestEffort(root, TUMWATER_SOURCE, message),
  };
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
  const knownClean = st !== null && memo !== undefined && sameStatIdentity(st, memo);
  const terminated = knownClean ? false : terminateTornTail(file, st);
  fs.appendFileSync(file, line);
  if (st) {
    appendedShape.set(file, {
      dev: st.dev,
      ino: st.ino,
      // The append writes UTF-8 BYTES, so the growth is Buffer.byteLength, not the string's
      // code-unit length: a multi-byte event line (an em dash in an agent's message is enough)
      // would otherwise leave the memo short of the file's real size, every later stat would
      // miss it, and the memo would silently never hit on the team's actual traffic.
      size: st.size + (terminated ? 1 : 0) + Buffer.byteLength(line, "utf8"),
    });
  } else {
    appendedShape.delete(file);
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
