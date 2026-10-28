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

/** How many rotated event-log generations rotateIfLarge retains (plans/fast-merge.md
 * "Guardrails" G4): at most 96 MB with the live file, about six weeks at the series' daily
 * rate, so a by-hand audit of the team still sees months. A constant, not a config key, like
 * EVENTS_MAX_BYTES. */
export const EVENTS_KEEP = 5;

/** The rotation phrase the report headers render — `eventsRotationLabel()` rather than a
 * hardcoded "rotated at 16 MB" copy, so changing EVENTS_MAX_BYTES or EVENTS_KEEP updates the
 * header with it instead of leaving every report claiming a rotation the log no longer does. */
export function eventsRotationLabel(): string {
  return `rotated at ${EVENTS_MAX_BYTES / (1024 * 1024)} MB, ${EVENTS_KEEP} kept`;
}

/** One line in .tumwater/log/events.jsonl: what logEvent appends (a HarnessEventInput plus
 * its `ts` stamp) and every consumer (event-window, history, the report and failure
 * collectors) reads back. */
export interface HarnessEvent {
  ts: number;
  /** The runner id that wrote the event, or TUMWATER_SOURCE for tumwater's own events. */
  source: string;
  type:
    | "run_start" // carries run; model when one is configured — the selector string (formatModelSelector) of the config the run starts on (the budget fallback included)
    | "run_end" // carries run, the run's usage, its peakContextTokens (its largest single-request context, when the run reported one), providerCost, billing/agent (when the run reported billing or rate windows), cutOff (when the agent was truncated at the model's context ceiling and the next run resumes its session), and its wall-clock span
    | "merge_queued" // a changed run pinned its commit and enqueued it for the orchestrator's merge slot (merge queue 3/5); carries sha + summary
    | "merge_cancelled" // an operator cancelled a waiting merge with tumwater queue --cancel; carries commit + summary
    | "merge_topped" // an operator moved a waiting merge to the front (`tumwater queue --top`, the dashboard's per-row Move to top, or the Pending pane's Ctrl+V); carries commit + summary
    | "merge_done" // the merge slot finished with the change on main; carries commit, the merger's outcome, durationMs, queuedMs (enqueue to outcome), and the merge's own usage (incl. notionalByBackend when it spent subscription notional)
    | "merge_failed" // the merge slot finished without merging (review rejection, under-cap review failure, conflict, blocked ff, shutdown abort); carries the same payload (including queuedMs and the entry's summary, and notionalByBackend) — retry rides next-run leftover recovery, never the queue
    | "merged" // merged; carries commit and summary
    | "question_posted" // a merged diff added an entry to QUESTIONS.md's ## Open
    | "issue_filed" // a feedback run filed one GitHub issue on znation/tumwater (plans/feedback-role.md 2/2); carries issue (the number) and title
    | "entry_refused" // a refusal run's objection note merged on main (src/verdict/refusal.ts handleRefusal); carries reason, files and entries (the stamp-free titles of the plans and bugs whose Refused note is new) — the entry stays held until a human or the director lifts it
    | "wake"
    | "run_deferred" // need-based prioritization: a due maintenance run was deferred; carries reason "backlog" (PLANS.md `## Planned` or BUGS.md `## Open` non-empty) "no-work" (no feature/bugfix/director/operator/human commit since its last no_change run), or "plans-full" (the plan role's PLANS.md already holds its eligible-plan target); one per deferral episode
    | "orchestrator_start"
    | "orchestrator_stop" // carries cause (restart, once, signal or error); events logged before the field existed carry none
    | "prompt_enqueued"
    | "prompt_cancelled" // a queued prompt was removed before the director ran it (tumwater prompt --cancel)
    | "prompt_edited" // a queued prompt's text was rewritten in place (tumwater prompt --edit)
    | "prompt_topped" // a queued prompt was moved to the front of its role's inbox (tumwater prompt --top)
    | "prompt_taken" // a run dequeued a queued user prompt to run it (carries `run` and `preview`)
    | "counters_reset"
    | "run_aborted" // a user-initiated abort killed one role's in-flight run (tumwater abort)
    | "resume" // the interrupted run's session is picked back up; carries cause (restart|cut-off|hung-tool|timeout|budget-resumed|handoff)
    | "review_start" // carries head; model when one is configured — the reviewer's selector string; revision (round) when the merge is a revision (plans/revise-rejected.md part 2/2); afterMerge true on a review of an already merged commit (review.afterMerge); resumed true when the run continues a timed-out reviewer's session (PLANS.md, review-retry part 3/3)
    | "review_verdict" // approved; carries durationMs of the reviewer run; afterMerge true when the commit was already merged
    | "review_rejected" // build pre-check or reviewer said no; durationMs when a reviewer ran; afterMerge true when the commit was already merged
    | "review_failed" // a reviewer run or its verdict failed; carries head, message, durationMs, and attempt (1-based: the reviewer run within the verify — a failed run is retried in place twice before the attempt ends review_error)
    | "revision" // a rejected change's revision round: action applied|conflict|dropped|exhausted, with round and sha (plans/revise-rejected.md)
    | "conflict_handback" // a change whose merges kept conflicting was handed back to its author with the markers in place (PLANS.md "Robust conflict landing, part 2/2"); action queued|applied, with sha, reason merge|revision, and the conflicted paths on a successful re-apply
    | "build_check" // the project's declared check ran: scope gate|baseline|merge|batch, `full: false` on a merge/batch run of check.mergeCommand (merge is the merge lock's post-rebase re-check; batch is the batch merger's one check over the stacked tree), status, script, durationMs; spawnedAt/settledAt when a process ran, plus timeoutMs/deadlineLateMs when its deadline fired, and sleptMs when the host slept mid-run (build/build-check-events.ts buildCheckRunFields); installed/installMs (plus installError) when the check first installed the tree's drifted lockfile (build/dep-install.ts)
    | "dep_install" // the root checkout's install was re-synced after a merge moved main's lockfile (build/dep-install.ts syncRootInstall): packages (the drifted direct dependencies), status passed|failed, durationMs, error on a failure
    | "budget_warning" // team daily spend crossed 80% of maxDailyCostUsd; the gate is still open; `topRoles` ({ role, spentUsd }[], highest first, at most three) names who spent most today, omitted when none did
    | "budget_paused" // team daily spend reached maxDailyCostUsd with no usable free fallback; roles stop starting runs; `topRoles` as on budget_warning, omitted when none spent
    | "budget_fallback" // team daily spend reached maxDailyCostUsd and a cost-free fallback model is configured; roles keep running on it; `topRoles` as on budget_warning, omitted when none spent
    | "budget_resumed" // the cap was raised/disabled or a new local day started; roles run again
    | "budget_handback" // at budget_resumed: the in-flight runs still on the fallback were handed back to the primary (roles, provider, model); reason "window" when a used-up subscription window reset rather than the budget, carrying backend (that window's backend)
    | "fallback_switched" // a tier moved to a different step of its fallback chain, or back to its primary; carries `tiers` (tier → from, to, reason: window|reserve|cap|step-cap|overage|demoted|available; a null from/to is the primary)
    | "team_paused" // operator pause via `tumwater pause`; roles stop starting new runs, director exempt; carries `until` (ms epoch, timed pause only) and `reason` (the operator's `--reason`, when given) — events logged before carry neither
    | "team_resumed" // the pause was lifted (`tumwater resume`); roles run again; carries expired: true when the pause's `until` deadline lifted it (absent on older events and on a restarted orchestrator's first crossing)
    | "role_paused" // operator pause via `tumwater pause --role <id>`; that one role stops starting new runs (carries role, and `until` (ms epoch, the set's shared deadline, timed pause only) — events logged before carry no `until`)
    | "role_resumed" // the per-role pause was lifted (`tumwater resume --role <id>`); that role runs again (carries role; expired: true when the shared `until` deadline lifted it, absent as for team_resumed)
    | "role_streak_paused" // the error-streak circuit breaker auto-paused a role after ERROR_STREAK_BREAKER consecutive failed runs (src/gates/streak-gate.ts); carries role, streak, lastError when one is recorded
    | "role_cap_warning" // the role's local-day spend crossed 80% of its maxDailyCostUsdPerRole cap while it is still running (src/gates/role-cap-gates.ts); carries role, spentUsd, capUsd
    | "role_cap_paused" // the role's local-day spend reached its maxDailyCostUsdPerRole cap (src/gates/role-cap-gates.ts); it starts no new runs until local midnight or a live edit; carries role, spentUsd, capUsd
    | "role_cap_resumed" // the cap was raised/removed or a new local day started; that role runs again (carries role)
    | "main_red_hold" // main's declared check is verified red; warnMainRedOnce (src/baseline/main-red.ts) logs it once per process per newly verified red main SHA and queues the `ci` healer a heal prompt (no authoring block — a code role still authors on a red main; the failing tests' detail rides the watch's `main_culprit` event via queueCulpritHeal); carries sha, script, message, and failingTests (the named failures, fewer than FAILING_TESTS_MAX) when the red names them, whose first the message names; events logged before that carry no failingTests
    | "main_check" // the main watch (src/baseline/main-watch.ts) settled a full-check verdict on main's tip: sha, status passed|failed, durationMs (0 when cached or inherited), covered (first-parent commits since the previously watched head), failingTests when failed; a doc-only tip that inherited its green carries inherited: true; a red naming only quarantined flaky tests is recorded passed with quarantined: [tests]
    | "main_culprit" // the main watch (src/baseline/main-watch.ts) named main's red tip as its own culprit: commit (the tip itself), runner when a recent merged event names one, failingTests (the tip's)
    | "operator_revert" // an operator ran `tumwater revert` on a merged change (src/operator/revert.ts): commit (the reverted commit), revert (the inverse commit), runner (the role the reverted commit's stamp names — omitted for an unstamped (hand-made) commit and for the operator's or harness's own stamp; a director commit does name the director), and subject
    | "maintenance_quota_hold" // code-maintenance merges in the rolling 24 h window reached the allowance (plans/work-ratio.md, part 1b/4, src/gates/maintenance-quota.ts); the enabled maintenance roles start no new runs until it re-opens; carries work, maint, allowance
    | "maintenance_quota_resumed" // the rolling window re-opened below the allowance; the held maintenance roles run again; carries work, maint, allowance
    | "bootstrap_complete" // the bootstrap gate's plan target was reached (plans/work-ratio.md, part 2/2); the latch .tumwater/bootstrap-complete.json is written and the held maintenance roles are admitted; carries plansDone, untilPlansDone
    | "quiet_hours_started" // the configured quietHours window began; roles stop starting new runs until it ends, director exempt (carries window)
    | "quiet_hours_ended" // the configured quietHours window ended; roles run again (carries window)
    | "disk_low" // free space on the worktrees volume dropped below diskHoldGB; no new work starts — role runs, the director, verification and merges — until it climbs DISK_HOLD_HYSTERESIS_GB above (carries freeGB, holdGB)
    | "disk_ok" // the disk hold lifted: free space climbed back above diskHoldGB + the hysteresis band, or diskHoldGB was edited to 0; new work starts again (carries freeGB)
    | "disk_reclaim" // a reclaim pass deleted gitignored files from idle worktrees (plans/disk-floor.md, part 2/4); carries mode (pressure|idle|manual), the cleaned worktrees' basenames, the statfs delta freedGB, freeGB after the pass, and durationMs
    | "claim" // a work instance took (action assigned) or dropped (action released) its backlog entry; carries action, key, title and reason (src/scheduling/claims.ts)
    | "permit_reserve" // the permits withheld from maintenance for work roles that have work to take changed (plans/parallel-work-instances.md part 7/7); carries reserve
    | "slot_wait" // a pooled worktree lease waited SLOT_WAIT_EVENT_MS or more for a free slot; carries role, purpose, waitedMs, slots and pinned — the signal to raise worktreeSlots (plans/worktree-pool.md, part 5/5)
    | "check_wait" // a scoped check (gate, merge, or batch) waited CHECK_WAIT_EVENT_MS or more for a process-wide check permit (build-check-events.ts's logCheckWaitEvent); carries source/role, scope and waitedMs, plus heldBy (the holders' labels at park time: `<role> <scope>`, `main baseline`, or `a check`) and limit (the cap at park time) — events logged before those fields carry neither — the signal to raise maxConcurrentChecks
    | "provider_wait" // a role run's semaphore admission waited PROVIDER_WAIT_EVENT_MS or more for its team slot; carries role and waitedMs (orchestrator-launch.ts) — the signal to raise maxConcurrent
    | "rate_limit_hold" // several roles' runs ended on the same provider failure kind within a short window — 429s, or a connection/timeout/5xx/model-load backend failure (src/team/team-hold.ts); roles on that provider — when the reviewer's is hit, the roles a pre-merge review gates (a `review.afterMerge` role is exempt — it merges without a reviewer) — start nothing new until it re-opens; carries kind, roles, holdMs, escalation, and provider when one is configured
    | "rate_limit_resumed" // one provider's hold (429 or backend-failure kind) reached its deadline; roles on that provider run again; carries the ended hold's kind, and provider when one is configured
    | "subscription_window_reserved" // a subscription usage window reached its windowReserve fraction; carries backend (the subscription account's backend, "claude" today), windowType, utilization, reserve and resetsAt; once per window, the team stops using the subscription until it resets
    | "subscription_window_warning" // the subscription usage window first reported allowed_warning; carries backend (the subscription account's backend, "claude" today), the window type, plus its utilization and resetsAt when reported; once per window, observational (it gates nothing)
    | "subscription_window_limited" // a rejected subscription usage window placed the provider-wide hold; the subscription's seams start nothing new until resetsAt; carries backend (the subscription account's backend, "claude" today), the window type and resetsAt, and `tiers` (tier → fallback pair) when the window moved model jobs to a fallback; once per window
    | "subscription_window_reset" // the subscription window hold reached resetsAt and lifted; the subscription's seams run again; carries backend (the subscription account's backend, "claude" today); once per window
    | "max_concurrent_changed" // a live tumwater.json edit resized the concurrency cap (from → to)
    | "retention_changed" // a live tumwater.json edit changed sessionRetentionDays (from → to)
    | "config_changed" // a live tumwater.json edit changed other settings (keys)
    | "model_changed" // a live tumwater.json edit changed the team's model wiring; carries from/to (teamModelLabel of the previous/next config) and roles (the per-role selector diffs) when a roles.<id> model override changed
    | "backend_binary" // a live tumwater.json edit newly routed a seam to a backend the previous config did not use; carries agent and found (the resolved binary was present) — the binary check's verdict, logged so a newly added backend is verified like startup would
    | "opencode_free_model_billed" // a catalog-free OpenCode model reported a nonzero run cost, demoting it to priced (plans/opencode-backend.md §7, part 6c/7): carried as model (the catalog cache key) and costUsd, once per model (src/agent/opencode/opencode-catalog.ts observeOpencodeRun)
    | "image_blind" // a run's agent read an image its model cannot see (plans/image-input.md "Detecting a blind read"): pi strips such images, so an authoring run was killed and the run fails — carried as source, run, path, model, and action "fail" when the authoring run was killed, "logged" when only a gate run recorded the read
    | "build_stale" // main's build inputs moved past the running build (self-hosting teams; src/redeploy/redeploy.ts)
    | "restart_pending" // main is green; no new runs start until the restart lands
    | "restart" // dist/ now holds the new build; the orchestrator exits for the supervisor to respawn it
    | "restart_refused" // a new generation would fail `tumwater run`'s startup gate here (reason); the running build stays and the gate is re-asked every poll
    | "restart_blocked" // the restart for main was blocked and latched (reason: red main, a failed compile, a swap error); the running build stays until main moves
    | "restart_forced" // the operator pressed the dashboard's restart button: the pending restart's cooldown deferral is waived for the next poll (carries build)
    | "supervisor_exit" // the supervisor gave up without the operator asking: a generation exited with a failure (code/signal, reason when the startup gate names one) or the crash-loop guard tripped — the team is down
    | "state_migrated" // a startup migration moved persisted state to its current name (src/orchestrator/startup-migrations.ts): step, moved (count of changes, not kept collisions; older events may count them), detail (the changes, then any kept collisions); a step that only kept things logs nothing
    | "warning"; // something is off but the loop continues: message; the stage self-check's outcome warnings (run/run-stage.ts) also carry findings (the finding texts, capped) and, when some stayed open after the fix-up turn, open
  [key: string]: unknown;
}
/** An event to log. `logEvent` stamps `ts`; event-specific extra fields (run, summary, …)
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
 * omit-when-zero convention the two usage-emitters apply (run-finalize.ts's run_end,
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
  rotateIfLarge(file, EVENTS_MAX_BYTES, EVENTS_KEEP);
  appendEventLine(file, JSON.stringify(full) + "\n");
  // The event is committed to the log before dispatch, so a subscriber's own failure must not
  // make the write look like it failed to the caller, starve the other subscribers of this or
  // any later event, or crash an unwrapped writer (the orchestrator's poll-loop warn site)
  // for one listener's bug. Each listener is isolated: its throw is surfaced loudly on stderr
  // (a terminal boundary, so the text is sanitized) and the dispatch moves on. The set is
  // snapshotted so a listener that unsubscribes itself mid-dispatch cannot skip or double-run
  // a sibling.
  for (const listener of [...listeners]) {
    try {
      listener(full);
    } catch (err) {
      process.stderr.write(
        `tumwater: event subscriber failed: ${stripTerminalControls(errorMessage(err))}\n`,
      );
    }
  }
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
    // A terminal display boundary like cli-output's say()/fail(): the role id, event type, and
    // error text can carry model- or subprocess-supplied bytes, and stderr is a terminal. Strip
    // the control characters the same way so a fallback line cannot drive the operator's shell.
    const detail = `${event.source}: could not log ${event.type} event: ${errorMessage(err)}`;
    process.stderr.write(`tumwater: ${stripTerminalControls(detail)}\n`);
  }
}

/** warnEvent's twin of logEventBestEffort: the "something is off but the loop continues"
 * warning must not be the thing that ends the role it warns about. The fallback keeps the
 * warning's own text on stderr — when the feed is the failure, this line is the only place the
 * caller's message (a spawn failure, a rejected run) survives to be read. The single home of
 * the try-warn → message-bearing-stderr-fallback shape, so the notify hook and the launch pass
 * do not each carry a copy of it. */
export function warnEventBestEffort(root: string, source: string, message: string): void {
  try {
    warnEvent(root, source, message);
  } catch (err) {
    // The warning's own text is very often model-supplied (a stalled tool call's label, a run's
    // lastError) and the role id can be a custom one, so this fallback is a terminal boundary:
    // sanitize exactly as say()/fail() do before the line reaches the operator's terminal.
    const detail = `${source}: ${message} (warning log unwritable: ${errorMessage(err)})`;
    process.stderr.write(`tumwater: ${stripTerminalControls(detail)}\n`);
  }
}

/** Run a best-effort bookkeeping step: when `step` throws, warn "could not <what>: <error>" under
 * `source` and return false, so the caller keeps going (or returns early on false). */
export function tryOrWarn(root: string, source: string, what: string, step: () => void): boolean {
  try {
    step();
    return true;
  } catch (err) {
    warnEventBestEffort(root, source, `could not ${what}: ${errorMessage(err)}`);
    return false;
  }
}

/** The `{ emit, warn }` pair for a caller on a catch-less path (the orchestrator's poll loop
 * and the live config reload it drives): both route through logEventBestEffort and
 * warnEventBestEffort, so the "an unwritable feed must not end the team" policy has one home
 * and the harness-level warning shorthand cannot drift from warnEvent's event shape. */
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
// (eventDayKey/eventRole/eventUsage, runStartMap/runSpanMs), and the stat-cached tail
// reader (readEvents/readEventsTailWithEnd) — lives in event-read.ts, so the append path's
// fs machinery and stat-memo cache stay apart from the read path's parse-and-scan machinery
// and its own stat-keyed cache. Human-facing formatting of events lives in event-format.ts;
// the windowed reader in event-window.ts; both beside this module because each is used by
// both display surfaces (src/ui/) and core consumers (the `run` banner's live stream,
// cli/cli-start.ts), and src/ui/ is imported only by itself and the CLI command layer that
// drives it (cli.ts and the src/ command bodies — DEVELOPMENT.md Layout).
