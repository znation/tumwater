// vocabulary: plain
import { claudeUtilizationPct } from "../agent/claude/claude-account.js";
import { eventRole, eventTick, eventUsage } from "./event-read.js";
import { eventTypeLabel } from "./event-labels.js";
import { roleLabel } from "../roles/role-labels.js";
import { TUMWATER_SOURCE, type HarnessEvent } from "./events.js";
import { ORCHESTRATOR_STOPPED, backendKindPhrase, budgetPhrase, firstReason, teamPausePhrase, teamResumePhrase, holdPhrase, plural, rolePausePhrase, roleResumePhrase, rolesPhrase, shortSpanPhrase } from "../text/phrases.js";
import { compactTokens, formatGB, shortSha, usd } from "../text/format.js";
import { padToWidth } from "../text/text-width.js";
import { squash, textOr, truncate } from "../text/text.js";
import { formatTimestamp, formatTime } from "../text/datetime.js";
import { finiteNumber, isJsonObject, stringList } from "../files/json-object.js";
import { fallbackTierEntries } from "../budget/budget.js";

/** The `<N> tok · $<spent>` usage fragment every event that records a run's cost shares (run_end,
 * merge_done): the usage numbers arrive via eventUsage (the loose-typing coercion every usage
 * consumer shares), rendered through the shared token/money formats (compactTokens, usd) in one
 * place. Either part is omitted when zero or absent, so skipped ticks and zero-usage merges render
 * byte-identical to a pre-feature line — no leading or trailing separator. "·" is the separator
 * the budget badge already uses. Sentence contexts prepend their own " · " via usagePhrase;
 * table-cell contexts (history's usage column) use the bare text. */
export function usageText(e: HarnessEvent): string {
  const { tokens, costUsd } = eventUsage(e);
  return (
    (tokens > 0 ? `${compactTokens(tokens)} tok` : "") +
    (costUsd > 0 ? `${tokens > 0 ? " · " : ""}${usd(costUsd)}` : "")
  );
}

/** The same fragment as a sentence clause: empty events contribute nothing, non-empty ones
 * ride a leading " · " so the fragment glues onto the message that precedes it. */
function usagePhrase(e: HarnessEvent): string {
  const usage = usageText(e);
  return usage === "" ? "" : ` · ${usage}`;
}

/** ` (in 57s)` / ` (in 12m)` for events that carry a durationMs; "" when absent (events written
 * by builds that predate the field render as before). Seconds under two minutes, minutes above.
 * The value is read through finiteNumber (the same corrupt-field rule this file's gigabytes
 * and minutes apply), so an absent OR non-number durationMs — a hand-edited line's quoted
 * `"4200"` included — reads as no duration instead of coercing to a fabricated `(in 4s)`
 * that the event never recorded. Number(null) is 0 and Number("4200") is 4200, so both would
 * otherwise pass a bare finite test. */
function elapsed(ms: unknown): string {
  const n = finiteNumber(ms, null);
  if (n === null || n < 0) return "";
  return ` (in ${shortSpanPhrase(n)})`;
}

/** A disk event's GB field as "12.3 GB" text. A torn or hand-edited event whose value is
 * missing or non-numeric reads as "0.0 GB", never "NaN" — the same corrupt-field rule
 * budgetPhrase applies to spentUsd/capUsd, since HarnessEvent's index signature hands every
 * field over unvalidated. The rounding and unit are text/format.ts's formatGB. */
function gigabytes(v: unknown): string {
  return formatGB(finiteNumber(v, 0));
}

/** A duration in whole minutes. A torn or hand-edited value that is missing or non-numeric
 * reads as 0, never NaN — the same corrupt-field rule gigabytes applies, for the fallback
 * episode's and the restart's minute counts. */
function minutes(ms: unknown): number {
  return Math.round(Number(finiteNumber(ms, 0)) / 60_000);
}

/** `, resets HH:MM` for a subscription-window event carrying resetsAt, or "" when the field is
 * absent or non-numeric (a torn line, or a window the account did not stamp) — the same
 * corrupt-field rule the other optional-field renderers apply. */
function windowResetPhrase(e: HarnessEvent): string {
  const at = finiteNumber(e.resetsAt, null);
  return at === null ? "" : `, resets ${formatTime(new Date(at))}`;
}

/** The parenthesized ` (<window>)` a quiet-hours event names when it carries one, or "" when
 * the field is absent or blank (pollQuietHoursGate may send no window, so a routine hold must
 * not fabricate a pair). Shared by the started and ended lines so the two cannot drift on the
 * window's presence or format. */
function windowSuffix(e: HarnessEvent): string {
  return typeof e.window === "string" && e.window.trim() ? ` (${textOr(e.window)})` : "";
}

/** The backend a hold event names, rendered as " at <provider>" when one is configured
 * (pollTeamHold omits it for pi's default) and "" otherwise, so a multi-provider team can
 * tell WHICH backend the storm was at. Shared by the hold and resumed lines. */
function providerAt(e: HarnessEvent): string {
  return typeof e.provider === "string" ? ` at ${e.provider}` : "";
}

/** How a hold line scopes the roles it stops: "that provider" when the event names one, or
 * "every provider" when it does not (pi's default, or a hold that hit the only configured
 * backend). Shared by the hold and resumed lines so the scope cannot drift between them. */
function providerScope(e: HarnessEvent): string {
  return typeof e.provider === "string" ? "that provider" : "every provider";
}

/** The provider/model pair a fallback-ish line names, as "provider/model", defaulting each
 * half when the event omits it (a bare pi run carries neither). Shared by the budget_fallback
 * and model_fallback lines so the pair's shape and defaults cannot drift between them. */
function providerModelPair(e: HarnessEvent, providerDefault: string, modelDefault: string): string {
  return `${textOr(e.provider, providerDefault)}/${textOr(e.model, modelDefault)}`;
}

/** An event's outcome string — a tick's `result`, or a merge's or build check's `status`,
 * whichever the event carries; undefined when neither does. The activity feeds' tone and
 * filter key (tone.ts's eventKind takes it beside the event type), also shipped as the
 * status payload's per-event `result` field, so the two surfaces cannot disagree on what a
 * feed row keys by. */
export function eventResult(e: HarnessEvent): string | undefined {
  return typeof e.result === "string" ? e.result : typeof e.status === "string" ? e.status : undefined;
}

/** eventResult as a display cell: the outcome text when the event carries one, else "?". A
 * torn or hand-edited event whose result/status is missing or non-string — the loose payload
 * HarnessEvent's index signature hands over unvalidated — reads "?" like eventRole's role and
 * eventTick's tick, never String(undefined)'s literal "undefined". The display surfaces — the
 * event line, the history row, the tick drill-down — use this; eventResult stays undefined
 * for the tone and filter keys, which must tell "no outcome" apart from a real one. */
export function outcomeText(e: HarnessEvent): string {
  return eventResult(e) ?? "?";
}

/** Why a `run_deferred` event fired, as the clause that can follow "deferred — ": scheduling's
 * reason ("backlog", "no-work" or "plans-full"). Shared by the event feed (eventMessage) and
 * the failure digest (describeStateChange) so the two cannot disagree on the deferral's cause.
 * A missing or
 * unknown value — a torn line, or an event written before the field existed — reads as the
 * no-work spelling, the only clause the pre-field builds could log. */
export function deferredReasonText(e: HarnessEvent): string {
  if (e.reason === "plans-full") return "plan backlog at its target";
  return e.reason === "backlog" ? "feature/bugfix backlog open" : "nothing merged since the last run";
}

/** Human one-liner for an event, shared by `logs`, `run` output, and the TUI activity pane:
 * the local `YYYY-MM-DD HH:MM:SS` stamp (formatTimestamp — the same zero-padded, locale-
 * independent phrasing the history table and transcript run separators print, not
 * toLocaleTimeString's locale-dependent "3:05:12 PM"), the role padded to a column, then the
 * event's message (eventMessage).
 * Presentation only: depends on the event shape (events.ts's HarnessEvent), not on its log
 * I/O — so display surfaces never import formatting from the logging module. */
export function formatEvent(e: HarnessEvent): string {
  const time = formatTimestamp(e.ts);
  // Padded in terminal display columns (padToWidth), not String#padEnd's UTF-16 code units:
  // a custom role name holding a wide character (CJK, emoji) counts one code unit but two
  // display columns, so a padEnd cell rendered wider than its column and the message column
  // sat right of every ASCII row's (the same unit mistake the aligned tables shed). The role
  // itself goes through eventRole, so a torn or hand-edited event with no role shows "?" like
  // the usage report and failure digest, never String(undefined)'s literal "undefined".
  const source = eventRole(e);
  const roleCell = padToWidth(source === TUMWATER_SOURCE ? "tumwater" : roleLabel(source), 10);
  return `${time} ${roleCell} ${eventMessage(e)}`;
}

/** One event as the dashboard's activity feed consumes it: `result` is a tick's outcome, a
 * merge's result, or a build check's status — whichever string the event carries. The event
 * layer owns the event shape's projection, so both the status poll (ui/status-payload.ts) and
 * the slice endpoint (gui/gui-endpoints.ts's handleLogs) read the same fields, and a feed row's
 * shape cannot drift between them. */
export function eventFeedItem(e: HarnessEvent): { ts: number; source: string; type: string; result?: string; message: string } {
  const result = eventResult(e);
  // eventRole renders a missing/empty role as "?" like the reports, so a torn or hand-edited
  // event never shows a literal "undefined" role chip in the dashboard's activity feed.
  return { ts: e.ts, source: eventRole(e), type: e.type, ...(result === undefined ? {} : { result }), message: eventMessage(e) };
}

/** The feed's `--grep`/Search match rule: case-insensitive substring over the raw event type
 * prefixed to the rendered line — exactly the haystack the operator would otherwise read. One
 * home shared by the CLI's `tumwater logs --grep` (cli/log-commands.ts) and the dashboard's
 * /api/logs search, so the two surfaces cannot disagree about what a pattern matches. */
export function eventMatchesGrep(e: HarnessEvent, patternLower: string): boolean {
  return `${e.type} ${formatEvent(e)}`.toLowerCase().includes(patternLower);
}

/** An event's message alone — formatEvent's line without the time and role columns. The GUI's
 * activity feed renders the time and role itself (relative ages, role chips), so the payload
 * ships this beside the event's type and role instead of making the page re-parse a line. */
export function eventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "run_start":
      return `run #${eventTick(e)} started${e.model !== undefined ? ` on ${textOr(e.model)}` : ""}`;
    case "run_end": {
      // The payload that explains the outcome: summary for changed/refused/rejected/
      // review_error ticks, error (lastError) for error and merge-failed ones. Showing it
      // for every result that carries one keeps the event feed self-explanatory — a bare
      // "tick #N refused" would force operators to open the transcript for the reason.
      const extra = e.summary ? ` — ${textOr(e.summary)}` : e.error ? ` — ${textOr(e.error)}` : "";
      // Per-tick usage: where the day's spend went.
      return `run #${eventTick(e)} ${eventTypeLabel(outcomeText(e))}${extra}${usagePhrase(e)}`;
    }
    case "merged":
      return `merged ${shortSha(e.commit)} to main — ${textOr(e.summary)}`;
    case "merge_queued":
      // Merge queue 3/5: routine state change (the tick committed and the merge slot is
      // ahead) — no warning prefix. The merge's own events follow it.
      return `waiting to merge ${shortSha(e.commit)} — ${textOr(e.summary)}`;
    case "merge_done":
      // The merge slot finished with the change on main; the usage is the merge's own
      // spend (reviewer + conflict resolution), omitted when zero so review-exempt merges
      // render bare — the same phrase run_end carries for its run.
      return `merge of ${shortSha(e.commit)} done${elapsed(e.durationMs)}${usagePhrase(e)}`;
    case "merge_failed":
      // The event names its reason itself (writeMergeOutcome); the review/check events still
      // carry the full text. An old event without `reason` renders the bare outcome.
      return `merge of ${shortSha(e.commit)} failed (${eventTypeLabel(outcomeText(e))}${typeof e.reason === "string" && e.reason.trim() ? `: ${truncate(e.reason.trim(), 120)}` : ""})${elapsed(e.durationMs)}${typeof e.summary === "string" && e.summary.trim() ? ` — ${truncate(e.summary, 80)}` : ""}`;
    case "question_posted":
      // Routine operation (a role asked the user something), not a warning.
      // The position is the `<n>` `questions answer` takes, so the notify page is actionable.
      return `question posted: ${textOr(e.question)}${typeof e.position === "number" && Number.isInteger(e.position) && e.position >= 1 ? ` — question ${e.position} in \`tumwater questions\`; answer it with \`tumwater questions answer ${e.position} "<decision>"\`` : ""}`;
    case "entry_refused":
      // Routine operation (a refusal note merged), not a warning — like question_posted.
      const files = Array.isArray(e.files) ? e.files.join(", ") : "";
      const titles = stringList(e.entries);
      if (titles.length === 0) return `entry refused: ${textOr(e.reason)} (${files})`;
      const more = titles.length > 1 ? ` (and ${titles.length - 1} more)` : "";
      return `entry refused: "${truncate(titles[0]!, 80)}"${more}: ${textOr(e.reason)} (${files})`;
    case "wake":
      return `woke (${textOr(e.reason)})`;
    case "run_deferred":
      // Routine state change (need-based prioritization), like counters_reset — no warning
      // prefix. One per deferral episode; the tick's own events cover the episode's end.
      return `deferred — ${deferredReasonText(e)}`;
    case "orchestrator_start":
      return `tumwater started (pid ${textOr(e.pid)}${e.build ? `, version ${shortSha(e.build)}` : ""})`;
    case "orchestrator_stop":
      return ORCHESTRATOR_STOPPED;
    case "prompt_enqueued":
      return `message added to the inbox: ${textOr(e.preview)}`;
    case "prompt_cancelled":
      // Routine operation (the user removed a queued prompt), not a warning.
      return `message removed from the inbox: ${textOr(e.preview)}`;
    case "prompt_edited":
      // Routine operation (the user corrected a queued prompt), not a warning.
      return `inbox message edited: ${textOr(e.preview)}`;
    case "prompt_topped":
      // Routine operation (the user reordered a queued prompt), not a warning.
      return `inbox message moved to the front: ${textOr(e.preview)}`;
    case "prompt_taken":
      // Routine: a tick dequeued the operator's request to run it.
      return `inbox message taken by run #${eventTick(e)}: ${textOr(e.preview)}`;
    case "counters_reset": {
      // One role → the event is filed under that role; several → one harness-level event
      // listing them.
      const roles = rolesPhrase(e.roles, "");
      const scope = roles ? ` for ${roles}` : "";
      return `counters reset${scope} (runs, merges, tokens, cost)`;
    }
    case "run_aborted":
      // Routine state change (the user stopped one role's tick), like counters_reset — no
      // warning prefix. The resulting run_end line carries the user_aborted outcome.
      return `run stopped by you`;
    case "review_start": {
      // A resumed review continues a timed-out reviewer's session (PLANS.md, review-retry part
      // 3/3). The verb names that, because a bare "reviewing" line reads as a from-scratch run;
      // the revision and model suffixes are unchanged and independent of the flag.
      const revision = e.revision !== undefined ? ` (revision ${textOr(e.revision)})` : "";
      const model = e.model !== undefined ? ` on ${textOr(e.model)}` : "";
      return `${e.resumed ? "review resumed" : "reviewing"} ${shortSha(e.head)}${revision} before merge${model}`;
    }
    case "review_verdict":
      return `review approved ${shortSha(e.head)}${e.reason ? ` — ${textOr(e.reason)}` : ""}${elapsed(e.durationMs)}`;
    case "review_rejected": {
      const reasons = stringList(e.reasons);
      // Only the first reason renders; when more exist, say so instead of letting the
      // one-liner read as the complete verdict — the full list rides in state.lastReview
      // into the author's next tick prompt, and this line is the operator's pointer to it.
      const more =
        reasons.length > 1
          ? ` (+${reasons.length - 1} more — the author's next run carries every reason)`
          : "";
      return `review rejected ${shortSha(e.head)} — ${firstReason(reasons)}${more}${elapsed(e.durationMs)}`;
    }
    case "review_failed":
      return `review failed for ${shortSha(e.head)}: ${textOr(e.message)} (commit kept for re-review)${elapsed(e.durationMs)}`;
    case "revision":
      // A rejected change's revision round (plans/revise-rejected.md): applied onto current main,
      // conflicted with it, dropped by its author, or exhausted its rounds.
      return `revision ${textOr(e.round)} ${textOr(e.action)} ${shortSha(e.sha)}`;
    case "conflict_handback": {
      // A change whose merges kept conflicting was handed back to its author with the markers
      // in place (PLANS.md "Robust conflict landing, part 2/2"): queued, applied, or failed.
      const files = stringList(e.conflicted);
      const where = files.length > 0 ? `: ${files.join(", ")}` : "";
      const why = e.reason === "revision" ? " (revision)" : "";
      return `conflict hand-back ${textOr(e.action)} ${shortSha(e.sha)}${why}${where}`;
    }
    case "build_check":
      // The deterministic check's cost, per run: scope names which gate paid (the pre-merge review
      // gate, the red-main baseline check of main itself, or the merge lock's post-rebase re-check
      // of the tree about to merge). script carries the npm script name for an npm check but the
      // FULL configured command otherwise (checkScriptName in build/build-check.ts), so no "npm"
      // prefix is asserted here — the bare name reads correctly for both kinds ("npm test" would
      // misrender a cargo or make-based project's check).
      return `check (${textOr(e.scope)}): ${textOr(e.script)} ${eventTypeLabel(outcomeText(e))}${elapsed(e.durationMs)}`;
    case "dep_install": {
      // The root checkout's install catching up with a merged lockfile change — routine on
      // success; a failure also rides its own warning, which says what happens meanwhile.
      const pkgs = stringList(e.packages).join(", ");
      return `root install (${pkgs}) ${eventTypeLabel(outcomeText(e))}${e.error ? ` — ${textOr(e.error)}` : ""}${elapsed(e.durationMs)}`;
    }
    case "budget_warning":
      // The early page beside budget_paused: the cap is not reached yet, so say so — the
      // operator still has room to raise it or fix the fallback before the team stops.
      return `budget warning — ${budgetPhrase(e.spentUsd, e.capUsd)} of the daily cap spent; runs still start`;
    case "budget_paused": {
      // Routine state change, like counters_reset — no warning prefix. A configured fallback
      // the gate refused is named here: it is the whole reason the team stopped instead of
      // switching over, and an operator reading the feed must be able to act on it. So is a
      // free fallback the breaker demoted because its ticks kept failing (BUGS.md 2026-09-20):
      // the backend, not the price, is what to fix, and the team retries it on its own.
      // Like role_cap_paused, the line names the lift paths: a raised or removed cap, or the
      // local day rolling over (the demoted branch's cool-down retry is the automatic third).
      const refused = e.fallbackRejected
        ? ` (over-cap model ${textOr(e.fallbackRejected)} is not a cost n/a model in pi's models.json)`
        : e.fallbackDemoted
          ? ` (over-cap model ${textOr(e.fallbackDemoted)} is not serving — ${textOr(e.failures)} runs failed in a row on it; one trial run retries it after a cool-down)`
          : "";
      return `budget paused — ${budgetPhrase(e.spentUsd, e.capUsd)} daily cost reached${refused}; roles start no new runs until maxDailyCostUsd is raised or removed in tumwater.json or the local day rolls over`;
    }
    case "budget_fallback": {
      // The cap is spent but the team keeps working: name the free model it switched to, the
      // one fact that distinguishes this from a pause. When the event carries the per-tier
      // map (tiers, part 7b/8 — only emitted when the tiers resolve to two or more distinct
      // pairs), list each tier's pair and let the borrowed ones' `(from …)` suffixes show a
      // strong-tier borrow at a glance; a tier-free event keeps today's single-pair text.
      const tierEntries = fallbackTierEntries(isJsonObject(e.tiers) ? e.tiers : undefined);
      if (tierEntries.length >= 2)
        return `over-cap model — ${budgetPhrase(e.spentUsd, e.capUsd)} daily cost reached; roles continue on ${tierEntries.join(", ")} (cost n/a)`;
      return `over-cap model — ${budgetPhrase(e.spentUsd, e.capUsd)} daily cost reached; roles continue on ${providerModelPair(e, "pi's default provider", "pi's default model")} (cost n/a)`;
    }
    case "budget_resumed":
      return `budget resumed (${budgetPhrase(e.spentUsd, e.capUsd)} today)`;
    case "budget_handback": {
      // Which ticks were handed back: the roles still running on the fallback when the budget
      // reopened. Their ticks end `aborted` and resume promptly on the primary, so an operator
      // reading the feed can connect the aborted ticks to this one line.
      const roles = rolesPhrase(e.roles, "?");
      if (e.reason === "window") return `claude subscription window reset: handed ${roles} back to claude`;
      return `budget reopened: handed ${roles} back to the primary`;
    }
    case "fallback_switched": {
      // One line for the poll's changes: `<tier> → <pair> (<reason>)`, the primary as "primary".
      const tiers = isJsonObject(e.tiers) ? e.tiers : {};
      const parts = Object.entries(tiers).map(([tier, v]) => {
        const t = isJsonObject(v) ? v : {};
        return `${tier} → ${typeof t.to === "string" ? t.to : "primary"} (${textOr(t.reason)})`;
      });
      return `fallback: ${parts.join("; ")}`;
    }
    case "team_paused":
      // Routine state change, like counters_reset — no warning prefix.
      return `${teamPausePhrase()} (director keeps running)`;
    case "state_migrated":
      return `state migrated — ${textOr(e.detail)}`;
    case "team_resumed":
      return teamResumePhrase();
    case "role_paused":
      // Routine state change, like team_paused — no warning prefix.
      return `${rolePausePhrase(textOr(e.role))} (the rest of the team keeps running)`;
    case "role_resumed":
      return roleResumePhrase(textOr(e.role));
    case "role_streak_paused":
      // Routine-with-explanation, like rate_limit_hold — no warning prefix: the pause IS the
      // harness handling the failure. Names the streak depth and the lift command, so the
      // operator knows why the role stopped and what to do about it; names the last error
      // when one is recorded.
      return `role ${textOr(e.role)} paused — ${textOr(e.streak)} runs failed in a row${typeof e.lastError === "string" && e.lastError.trim() ? ` — last error: ${squash(e.lastError, 120)}` : ""}; fix the cause and resume it (tumwater resume --role <id>)`;
    case "role_cap_warning":
      // The per-role early page beside role_cap_paused: the cap is not reached yet, so say so —
      // the operator still has room to raise it before the role stops.
      return `role ${textOr(e.role)} at ${budgetPhrase(e.spentUsd, e.capUsd)} of its daily cap — it keeps running; raise or remove the cap in tumwater.json before it pauses`;
    case "role_cap_paused":
      // Routine state change, like budget_paused — no warning prefix: the pause IS the harness
      // holding the role's own spend line. Names the role, its spend vs its cap, and the two
      // lift paths, so the operator knows why the role stopped and what to do about it.
      return `role ${textOr(e.role)} paused — ${budgetPhrase(e.spentUsd, e.capUsd)} of its daily cap spent; it starts no new runs until the cap is raised or removed in tumwater.json or the local day rolls over`;
    case "role_cap_resumed":
      return `role ${textOr(e.role)} resumed — it is under its daily cap again and runs again`;
    case "main_check": {
      const failing = Array.isArray(e.failingTests) ? e.failingTests.map(String) : [];
      const covered = Number(e.covered) > 1 ? ` (${textOr(e.covered)} commits)` : "";
      const verdict = e.status === "failed" ? "failed" : "passed";
      const names = failing.length > 0 ? `: ${failing.slice(0, 3).join("; ")}${failing.length > 3 ? `; +${failing.length - 3} more` : ""}` : "";
      return `main ${shortSha(String(e.sha ?? ""))}${covered} full check ${verdict}${names}`;
    }
    case "main_culprit": {
      const by = typeof e.runner === "string" && e.runner !== "" ? ` (merged by ${e.runner})` : "";
      return `main turned red at ${shortSha(String(e.commit ?? ""))}${by}; last green ${shortSha(String(e.green ?? ""))}`;
    }
    case "main_revert":
      return `reverted ${shortSha(String(e.commit ?? ""))} (merged by ${textOr(e.runner)}) as ${shortSha(String(e.revert ?? ""))}`;
    case "main_red_hold":
      // The message already names the SHA, script, and consequence; the problem tone comes
      // from PROBLEM_EVENTS.
      return textOr(e.message);
    case "maintenance_quota_hold":
      // Routine state change, like role_cap_paused — no warning prefix: the hold IS the harness
      // keeping maintenance merges in proportion to work. Names the window's counts so the
      // operator can see why the hygiene roles stopped and what would re-open them.
      return `waiting: maintenance allowance used — ${textOr(e.maint)} maintenance merges against an allowance of ${textOr(e.allowance)} in the last 24h (${textOr(e.work)} work); the maintenance roles wait until the window rolls over`;
    case "maintenance_quota_resumed":
      return `maintenance allowance reopened — ${textOr(e.maint)} maintenance merges against an allowance of ${textOr(e.allowance)} in the last 24h; the maintenance roles run again`;
    case "bootstrap_complete":
      // Routine state change, like counters_reset — no warning prefix: the team just finished
      // its bootstrap and the maintenance roles are admitted.
      return `bootstrap complete — ${textOr(e.plansDone)}/${textOr(e.untilPlansDone)} plans done; the maintenance roles now run`;
    case "disk_low":
      // Routine state change, like team_paused — no warning prefix: the hold IS the harness
      // handling the low disk, and naming the free space and the floor tells the operator
      // whether to clear space or lower diskHoldGB in tumwater.json.
      return `waiting: low disk — ${gigabytes(e.freeGB)} free on the workspaces volume (floor ${gigabytes(e.holdGB)}); new work waits until space recovers`;
    case "quiet_hours_started": {
      // Routine hold, like disk_low — no warning prefix: the window is configured, and the line
      // says what stops and what keeps running. pollQuietHoursGate may send no window.
      return `waiting: quiet hours${windowSuffix(e)} — roles start no new runs until the window ends; the director still runs`;
    }
    case "quiet_hours_ended": {
      return `quiet hours ended${windowSuffix(e)} — roles start runs again`;
    }
    case "disk_ok":
      return `disk recovered — ${gigabytes(e.freeGB)} free on the workspaces volume; new work starts again`;
    case "disk_reclaim": {
      // Routine maintenance, no warning prefix: the pass freed space so the hold need not
      // engage. Naming the mode, the worktrees, and the delta tells the operator what and why.
      const names = stringList(e.worktrees);
      const from = names.length > 0 ? names.join(", ") : "?";
      return `disk reclaim (${textOr(e.mode, "pressure")}) — freed ${gigabytes(e.freedGB)} from ${from}; ${gigabytes(e.freeGB)} free now`;
    }
    case "rate_limit_hold": {
      // Routine state change, like team_paused — no warning prefix: the hold IS the harness
      // handling the storm. Names who saw the failure and when the team re-opens on its own.
      // The rate-limit kind keeps the wording every historical event has; a backend-failure
      // kind names itself instead, since "429" would be a lie about a connection error.
      const roles = rolesPhrase(e.roles, "several roles");
      if (e.kind && e.kind !== "rate-limit")
        return `waiting: backend failing (${backendKindPhrase(e.kind)})${providerAt(e)} — ${roles} hit backend failures; roles on ${providerScope(e)} start no new runs ${holdPhrase(e.holdMs, e.escalation)} (director keeps running)`;
      return `waiting: provider limit${providerAt(e)} — ${roles} rate-limited by the provider; roles on ${providerScope(e)} start no new runs ${holdPhrase(e.holdMs, e.escalation)} (director keeps running)`;
    }
    case "rate_limit_resumed": {
      // The ended hold's kind rides the resumed event (pollTeamHold logs it), so the lift
      // names what actually ended — the same split as the hold line above: "429 hold lifted"
      // after a connection-error hold would be a lie about a connection error.
      if (e.kind && e.kind !== "rate-limit")
        return `backend recovered (${backendKindPhrase(e.kind)})${providerAt(e)} — roles on ${providerScope(e)} run again`;
      return `provider limit lifted${providerAt(e)} — roles on ${providerScope(e)} run again`;
    }
    case "claude_window_warning": {
      // Routine-with-explanation, like rate_limit_hold — no warning prefix: the account is
      // telling us the window is filling, not failing. It names the window and when it resets.
      const used = finiteNumber(e.utilization, null);
      const fill = used === null ? "" : ` (at ${claudeUtilizationPct(used)}% used)`;
      return `claude subscription window ${textOr(e.windowType)} near its limit${fill}${windowResetPhrase(e)} — subscription claude model jobs keep running`;
    }
    case "claude_window_reserved": {
      const used = finiteNumber(e.utilization, null);
      const line = finiteNumber(e.reserve, null);
      const pct = (f: number | null) => (f === null ? "?" : `${Math.round(f * 100)}%`);
      return `claude subscription window ${textOr(e.windowType)} at ${pct(used)}, past its ${pct(line)} reserve${windowResetPhrase(e)} — the team leaves it to you (director keeps running)`;
    }
    case "claude_window_limited":
      // Routine-with-explanation, like rate_limit_hold — no warning prefix: waiting is the
      // harness handling the account's own throttle. Names the window, the reset, and which
      // seams stop, so the operator knows why claude held and what keeps running.
      // With a fallback the work moves rather than waits: `tiers` names where each moved tier's
      // work went (the budget poll's window move), the director and any tier with no fallback
      // still wait.
      {
        const moved = fallbackTierEntries(isJsonObject(e.tiers) ? e.tiers : undefined);
        if (moved.length > 0)
          return `claude subscription window ${textOr(e.windowType)} rejected — claude model jobs move to ${moved.join(", ")}${windowResetPhrase(e)} (director keeps waiting)`;
      }
      return `waiting: claude subscription window ${textOr(e.windowType)} rejected — claude model jobs wait${windowResetPhrase(e)} (director keeps running)`;
    case "claude_window_reset":
      return `claude subscription window reset — claude model jobs run again`;
    case "max_concurrent_changed": {
      // Routine state change, like counters_reset — no warning prefix.
      return `maxConcurrent changed: ${textOr(e.from)} → ${textOr(e.to)}`;
    }
    case "provider_concurrency_changed": {
      // Routine state change, its maxConcurrent sibling's per-provider form — no warning prefix.
      return `concurrency for ${textOr(e.provider)} changed: ${textOr(e.from)} → ${textOr(e.to)}`;
    }
    case "retention_changed": {
      // Routine state change, like its maxConcurrent sibling — no warning prefix.
      return `sessionRetentionDays changed: ${textOr(e.from)} → ${textOr(e.to)}`;
    }
    case "config_changed": {
      // Routine state change, like its maxConcurrent/retention siblings — no warning prefix.
      // A bare/empty keys array (a torn or hand-edited line) still renders.
      const keys = stringList(e.keys).join(", ");
      return `config changed${keys ? `: ${keys}` : ""}`;
    }
    case "model_changed":
      // The live-edit sibling of config_changed: names the new selector, the one fact the key
      // list cannot show. The per-role diffs stay structured on the event.
      return `model changed — now ${textOr(e.to, "pi's default")}`;
    case "backend_binary":
      // The binary check for a newly routed backend: found is the routine verdict; a missing
      // binary is the warning.
      return e.found === false
        ? `warning: newly routed ${textOr(e.agent)} backend — its binary was not found`
        : `newly routed ${textOr(e.agent)} backend checked — binary found`;
    case "model_fallback_started":
      // Routine-with-explanation, like rate_limit_hold: the switch IS the harness handling the
      // failure. Names the pair the role now runs on and why the primary was abandoned.
      return `model fallback — ${providerModelPair(e, "pi's default", "pi's default")} engaged (primary failing: ${textOr(e.reason, "backend failure")})`;
    case "model_fallback_ended":
      // The return counterpart: names the pair ticks resume on and how long the episode ran.
      return `model fallback ended — back on ${providerModelPair(e, "pi's default", "pi's default")} after ${minutes(e.durationMs)}m`;
    case "opencode_free_model_billed":
      // The promotion ended (plans/opencode-backend.md §7, part 6c/7): a run billed what the
      // catalog called free, so the team now prices that model as paid from here on. No warning
      // prefix — the demotion is the harness handling the spend — but it names the model and the
      // cost so the operator sees why a badge stopped saying "cost n/a".
      return `opencode ${textOr(e.model, "model")} billed ${usd(finiteNumber(e.costUsd, 0))} — demoted from free to priced`;
    case "image_blind": {
      // Routine-with-explanation like the model-fallback events — no warning prefix: the
      // run was stopped (or a gate run noted) because the model cannot see the image. Names
      // the file, the model, and whether the tick failed on it or a gate run only logged it.
      const action =
        e.action === "logged"
          ? " (gate run logged)"
          : e.action === "fail"
            ? " — run failed"
            : "";
      return `blind image read: ${textOr(e.path)} on ${textOr(e.model, "the model")}${action}`;
    }
    case "image_reroute":
      // The tick's work moves to a model that can read the image (plans/image-input.md part
      // 4/5). Routine-with-explanation — no warning prefix: names the hop the way the
      // handoff reads, and whether the traits-of-attachment preflight avoided a failed tick.
      return e.preflight === true
        ? `image attachment routed to ${textOr(e.to, "the target")} (${textOr(e.tier, "a peer tier")}) to read its image — no failed run`
        : `image rerouted to ${textOr(e.to, "the target")} (${textOr(e.tier, "a peer tier")}) — next run goes there after a blind read on ${textOr(e.from, "the prior model")}`;
    case "build_stale":
      // Self-hosting teams only (src/redeploy/redeploy.ts): the code main describes is not the
      // code running. Not a warning prefix — a stale build is a state, and auto-restart resolves
      // it.
      return `update available (${plural(finiteNumber(e.aheadCommits, 0), "commit")} behind) — restarts when idle`;
    case "restart_pending":
      return `restart pending — main ${shortSha(e.head)} is green; finishing current runs (no new runs start)`;
    case "restart": {
      const aborted = finiteNumber(e.abortedRuns, 0);
      return `restarting onto update ${shortSha(e.to)} (finished current work in ${minutes(e.finishedMs)}m${
          aborted > 0 ? `, ${aborted} run(s) resume after the restart` : ""
        })`;
    }
    case "restart_refused":
      // The restart is refused, not failed: the running build stays and the gate is re-asked
      // every poll, so the line names both builds and what the operator must repair.
      return `restart onto update ${shortSha(e.to)} refused — the new version could not start here: ${textOr(e.reason)}; staying on version ${shortSha(e.from)} until it can`;
    case "restart_blocked":
      // The restart is blocked, not refused: a verdict latched this head, so the line names
      // what failed and that only main moving can end it.
      return `restart blocked for main ${shortSha(e.to)} — ${textOr(e.reason)}; staying on version ${shortSha(e.from)} until main moves`;
    case "restart_forced":
      // The operator's own override: names the running build, the one fact the type code lacks.
      return `restart forced by you — the update skips its cooldown (running version ${shortSha(e.build)})`;
    case "supervisor_exit": {
      // The team is DOWN and nothing will bring it back: the one line that must say so, since
      // the dead generation's own stderr reached only the supervisor's terminal.
      const how = e.signal ? `was killed by ${textOr(e.signal)}` : `exited ${textOr(e.code)}`;
      return `tumwater is down — restart ${textOr(e.generation)} ${how}${e.reason ? `: ${textOr(e.reason)}` : ""}; start it again with \`tumwater start\``;
    }
    case "resume":
      // Two causes share the resume machinery; the line names the real one so an operator
      // reading the feed can tell a restart from a role fighting the context ceiling, and a
      // cross-agent handoff from either — the handoff keeps the worktree but starts fresh.
      return e.cause === "cut-off"
        ? "resuming the run cut off at the context ceiling (compacted pi session, same workspace)"
        : e.cause === "handoff"
          ? "handing the interrupted run off to a fresh session on another agent (same workspace, uncommitted edits kept)"
          : e.cause === "image-reroute"
            ? "handing the blind-read run off to a fresh session on an image-capable model (same workspace, uncommitted edits kept)"
            : "resuming the run a shutdown interrupted (same agent session and workspace)";
    case "slot_wait": {
      // Routine-with-explanation, like rate_limit_hold — no warning prefix: waiting is the pool
      // working as designed. Names the wait, the pool it waited on, and how many slots are
      // pinned, so the operator can raise worktreeSlots with the numbers in hand.
      const purpose = e.purpose === "verify" ? "check" : "run";
      return `waited ${shortSpanPhrase(finiteNumber(e.waitedMs, 0))} to start (${textOr(e.role)} ${purpose}; ${textOr(e.slots)} workspaces, ${textOr(e.pinned)} pinned)`;
    }
    case "provider_wait": {
      // Routine-with-explanation, like slot_wait: waiting for a provider/team slot is the cap
      // working as designed, so no warning prefix. Names the wait and the key (or the run cap
      // when the seam has none), so the operator can raise maxConcurrentPerProvider with the
      // numbers in hand.
      return `waited ${shortSpanPhrase(finiteNumber(e.waitedMs, 0))} for a ${typeof e.key === "string" && e.key.length > 0 ? `${e.key} slot` : "run slot"} (${textOr(e.role)})`;
    }
    case "check_wait":
      // Routine-with-explanation, like slot_wait: waiting for a check permit is the cap working
      // as designed, so no warning prefix.
      return `waited ${shortSpanPhrase(finiteNumber(e.waitedMs, 0))} for a check slot (${textOr(e.role)} ${textOr(e.scope)} check)`;
    case "claim":
      // Parallel work instances (plans/parallel-work-instances.md "Observability", part 6/7):
      // the assignment/release is the harness working as designed, so no warning prefix.
      return e.action === "released"
        ? `released "${textOr(e.title)}" (${textOr(e.reason, "?")})`
        : `assigned "${textOr(e.title)}"`;
    case "permit_reserve":
      // Priority headroom (part 7/7): a reserve appearing or vanishing is the scheduler working
      // as designed; it names the permits withheld for the work tier so an operator can see why
      // maintenance concurrency dipped.
      return `${finiteNumber(e.reserve, 0)} permit(s) reserved for work roles that have work to take`;
    case "warning":
      return `warning: ${textOr(e.message)}`;
    default:
      // An unrecognized type is normally a newer build's string and renders as-is; a torn or
      // hand-edited event object with no type at all must read the "?" stand-in, never
      // String(undefined)'s literal "undefined" (parseEventLine admits any JSON object).
      return textOr(e.type);
  }
}
