import { eventUsage } from "./event-read.js";
import type { HarnessEvent } from "./events.js";
import { backendKindPhrase, budgetPhrase, firstReason, holdPhrase, plural, rolesPhrase, shortSpanPhrase } from "../text/phrases.js";
import { compactTokens, shortSha, usd } from "../text/format.js";
import { padToWidth } from "../text/text-width.js";
import { formatTimestamp } from "../text/datetime.js";
import { finiteNumber, isJsonObject, stringList } from "../files/json-object.js";
import { fallbackTierEntries } from "../budget/budget.js";

/** The `<N> tok · $<spent>` usage fragment every event that records a run's cost shares
 * (tick_end, landed): the usage numbers arrive via eventUsage (the loose-typing coercion
 * every usage consumer shares), rendered through the shared token/money formats
 * (compactTokens, usd) in one place. Either
 * part is omitted when zero or absent, so skipped ticks and zero-usage landings render
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
 * The null check is explicit because Number(null) is 0, which would otherwise read as "(in 0s)";
 * an absent field (undefined) is already rejected by the non-finite test. */
function elapsed(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0 || ms === null) return "";
  return ` (in ${shortSpanPhrase(n)})`;
}

/** A disk event's GB field as "12.3"-style text. A torn or hand-edited event whose value is
 * missing or non-numeric reads as "0.0", never "NaN" — the same corrupt-field rule budgetPhrase
 * applies to spentUsd/capUsd, since HarnessEvent's index signature hands every field over
 * unvalidated. */
function gigabytes(v: unknown): string {
  return finiteNumber(v, 0).toFixed(1);
}

/** A duration in whole minutes. A torn or hand-edited value that is missing or non-numeric
 * reads as 0, never NaN — the same corrupt-field rule gigabytes applies, for the fallback
 * episode's and the restart's minute counts. */
function minutes(ms: unknown): number {
  return Math.round(Number(finiteNumber(ms, 0)) / 60_000);
}

/** The backend a hold event names, rendered as " at <provider>" when one is configured
 * (pollFleetHold omits it for pi's default) and "" otherwise, so a multi-provider fleet can
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

/** An event's outcome string — a tick's `result`, or a landing's or build check's `status`,
 * whichever the event carries; undefined when neither does. The activity feeds' tone and
 * filter key (tone.ts's eventKind takes it beside the event type), also shipped as the
 * status payload's per-event `result` field, so the two surfaces cannot disagree on what a
 * feed row keys by. */
export function eventResult(e: HarnessEvent): string | undefined {
  return typeof e.result === "string" ? e.result : typeof e.status === "string" ? e.status : undefined;
}

/** Human one-liner for an event, shared by `logs`, `run` output, and the TUI activity pane:
 * the local `YYYY-MM-DD HH:MM:SS` stamp (formatTimestamp — the same zero-padded, locale-
 * independent phrasing the history table and transcript run separators print, not
 * toLocaleTimeString's locale-dependent "3:05:12 PM"), the loop padded to a column, then the
 * event's message (eventMessage).
 * Presentation only: depends on the event shape (events.ts's HarnessEvent), not on its log
 * I/O — so display surfaces never import formatting from the logging module. */
export function formatEvent(e: HarnessEvent): string {
  const time = formatTimestamp(e.ts);
  // Padded in terminal display columns (padToWidth), not String#padEnd's UTF-16 code units:
  // a custom loop name holding a wide character (CJK, emoji) counts one code unit but two
  // display columns, so a padEnd cell rendered wider than its column and the message column
  // sat right of every ASCII row's (the same unit mistake the aligned tables shed).
  const loop = padToWidth(String(e.loop), 9);
  return `${time} ${loop} ${eventMessage(e)}`;
}

/** An event's message alone — formatEvent's line without the time and loop columns. The GUI's
 * activity feed renders the time and loop itself (relative ages, loop chips), so the payload
 * ships this beside the event's type and loop instead of making the page re-parse a line. */
export function eventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "tick_start":
      return `tick #${e.tick} started${e.model !== undefined ? ` on ${String(e.model)}` : ""}`;
    case "tick_end": {
      // The payload that explains the outcome: summary for changed/refused/rejected/
      // review_error ticks, error (lastError) for error and merge-failed ones. Showing it
      // for every result that carries one keeps the event feed self-explanatory — a bare
      // "tick #N refused" would force operators to open the transcript for the reason.
      const extra = e.summary ? ` — ${e.summary}` : e.error ? ` — ${e.error}` : "";
      // Per-tick usage (PLANS.md, per-tick-usage plan): where the day's spend went.
      return `tick #${e.tick} ${e.result}${extra}${usagePhrase(e)}`;
    }
    case "merged":
      return `merged ${shortSha(e.commit)} to main — ${e.summary}`;
    case "land_queued":
      // Merge queue 3/5: routine state change (the tick committed and the landing slot is
      // ahead) — no warning prefix. The landing's own events follow it.
      return `queued ${shortSha(e.commit)} for landing — ${e.summary}`;
    case "landed":
      // The landing slot finished with the change on main; the usage is the landing's own
      // spend (reviewer + conflict resolution), omitted when zero so review-exempt landings
      // render bare — the same phrase tick_end carries for its run.
      return `landing of ${shortSha(e.commit)} complete${elapsed(e.durationMs)}${usagePhrase(e)}`;
    case "land_failed":
      // Routine failure detail: the review events themselves (review_rejected/review_failed)
      // or the merged/build_check lines carry the reason in the feed.
      return `landing of ${shortSha(e.commit)} did not land (${e.result})${elapsed(e.durationMs)}`;
    case "question_posted":
      // Routine operation (a loop asked the user something), not a warning.
      return `question posted: ${e.question}`;
    case "wake":
      return `woke (${e.reason})`;
    case "tick_deferred":
      // Routine state change (need-based prioritization), like counters_reset — no warning
      // prefix. One per deferral episode; the tick's own events cover the episode's end.
      return `deferred — no work landed since last tick`;
    case "orchestrator_start":
      return `orchestrator started (pid ${e.pid}${e.build ? `, build ${shortSha(e.build)}` : ""})`;
    case "orchestrator_stop":
      return `orchestrator stopped`;
    case "prompt_enqueued":
      return `user prompt queued: ${String(e.preview)}`;
    case "prompt_cancelled":
      // Routine operation (the user removed a queued prompt), not a warning.
      return `user prompt cancelled: ${String(e.preview)}`;
    case "prompt_edited":
      // Routine operation (the user corrected a queued prompt), not a warning.
      return `user prompt edited: ${String(e.preview)}`;
    case "counters_reset": {
      // One role → the event is filed under that loop; several → one harness-level event
      // listing them.
      const roles = rolesPhrase(e.roles, "");
      const scope = roles ? ` for ${roles}` : "";
      return `counters reset${scope} (ticks, commits, tokens, cost)`;
    }
    case "tick_aborted":
      // Routine state change (the user stopped one loop's tick), like counters_reset — no
      // warning prefix. The resulting tick_end line carries the user_aborted outcome.
      return `tick aborted by user`;
    case "review_start":
      return `reviewing ${shortSha(e.head)}${e.revision !== undefined ? ` (revision ${e.revision})` : ""} before merge${e.model !== undefined ? ` on ${String(e.model)}` : ""}`;
    case "review_verdict":
      return `review approved ${shortSha(e.head)}${e.reason ? ` — ${e.reason}` : ""}${elapsed(e.durationMs)}`;
    case "review_rejected": {
      const reasons = stringList(e.reasons);
      // Only the first reason renders; when more exist, say so instead of letting the
      // one-liner read as the complete verdict — the full list rides in state.lastReview
      // into the author's next tick prompt, and this line is the operator's pointer to it.
      const more =
        reasons.length > 1
          ? ` (+${reasons.length - 1} more — the author's next tick carries every reason)`
          : "";
      return `review rejected ${shortSha(e.head)} — ${firstReason(reasons)}${more}${elapsed(e.durationMs)}`;
    }
    case "review_failed":
      return `review failed for ${shortSha(e.head)}: ${e.message} (commit kept for re-review)${elapsed(e.durationMs)}`;
    case "revision":
      // A rejected change's revision round (plans/revise-rejected.md): applied onto current main,
      // conflicted with it, dropped by its author, or exhausted its rounds.
      return `revision ${String(e.round)} ${String(e.action)} ${shortSha(String(e.sha))}`;
    case "build_check":
      // The deterministic check's cost, per run: scope names which gate paid (the pre-merge
      // review gate, the red-main baseline check of main itself, or the merge lock's
      // post-rebase re-check of the tree about to land). script carries the npm script name
      // for an npm check but the FULL configured command otherwise (checkScriptName in
      // build/build-check.ts), so no "npm" prefix is asserted here — the bare name reads correctly
      // for both kinds ("npm test" would misrender a cargo or make-based project's check).
      return `build check (${e.scope}): ${e.script} ${e.status}${elapsed(e.durationMs)}`;
    case "dep_install": {
      // The root checkout's install catching up with a landed lockfile change — routine on
      // success; a failure also rides its own warning, which says what happens meanwhile.
      const pkgs = stringList(e.packages).join(", ");
      return `root install (${pkgs}) ${e.status}${e.error ? ` — ${e.error}` : ""}${elapsed(e.durationMs)}`;
    }
    case "budget_warning":
      // The early page beside budget_paused: the cap is not reached yet, so say so — the
      // operator still has room to raise it or fix the fallback before the fleet stops.
      return `budget warning — ${budgetPhrase(e.spentUsd, e.capUsd)} of the daily cap spent; the gate is still open`;
    case "budget_paused": {
      // Routine state change, like counters_reset — no warning prefix. A configured fallback
      // the gate refused is named here: it is the whole reason the fleet stopped instead of
      // switching over, and an operator reading the feed must be able to act on it. So is a
      // free fallback the breaker demoted because its ticks kept failing (BUGS.md 2026-09-20):
      // the backend, not the price, is what to fix, and the fleet retries it on its own.
      const refused = e.fallbackRejected
        ? ` (fallback ${e.fallbackRejected} is not a cost n/a model in pi's models.json)`
        : e.fallbackDemoted
          ? ` (fallback ${e.fallbackDemoted} is not serving — ${e.failures ?? "?"} consecutive ticks failed on it; one probe tick retries it after a cool-down)`
          : "";
      return `budget paused — ${budgetPhrase(e.spentUsd, e.capUsd)} daily cost reached${refused}`;
    }
    case "budget_fallback": {
      // The cap is spent but the fleet keeps working: name the free model it switched to, the
      // one fact that distinguishes this from a pause. When the event carries the per-tier
      // map (tiers, part 7b/8 — only emitted when the tiers resolve to two or more distinct
      // pairs), list each tier's pair and let the borrowed ones' `(from …)` suffixes show a
      // strong-tier borrow at a glance; a tier-free event keeps today's single-pair text.
      const tierEntries = fallbackTierEntries(isJsonObject(e.tiers) ? e.tiers : undefined);
      if (tierEntries.length >= 2)
        return `budget fallback — ${budgetPhrase(e.spentUsd, e.capUsd)} daily cost reached; role loops continue on ${tierEntries.join(", ")} (cost n/a)`;
      return `budget fallback — ${budgetPhrase(e.spentUsd, e.capUsd)} daily cost reached; role loops continue on ${e.provider ?? "pi's default provider"}/${e.model ?? "pi's default model"} (cost n/a)`;
    }
    case "budget_resumed":
      return `budget resumed (${budgetPhrase(e.spentUsd, e.capUsd)} today)`;
    case "budget_handback": {
      // Which ticks were handed back: the roles still running on the fallback when the budget
      // reopened. Their ticks end `aborted` and resume promptly on the primary, so an operator
      // reading the feed can connect the aborted ticks to this one line.
      const roles = rolesPhrase(e.roles, "?");
      return `budget reopened: handed ${roles} back to the primary`;
    }
    case "fleet_paused":
      // Routine state change, like counters_reset — no warning prefix.
      return `fleet paused — role loops stop starting new ticks (director keeps running)`;
    case "fleet_resumed":
      return `fleet resumed — role loops tick again`;
    case "role_paused":
      // Routine state change, like fleet_paused — no warning prefix.
      return `role ${e.role ?? "?"} paused — it stops starting new ticks (the rest of the fleet keeps running)`;
    case "role_resumed":
      return `role ${e.role ?? "?"} resumed — it ticks again`;
    case "role_streak_paused":
      // Routine-with-explanation, like rate_limit_hold — no warning prefix: the pause IS the
      // harness handling the failure. Names the streak depth and the lift command, so the
      // operator knows why the loop stopped and what to do about it.
      return `role ${e.role ?? "?"} paused — ${e.streak ?? "?"} ticks failed in a row; fix the cause and resume it (tumwater resume --role <id>)`;
    case "role_cap_paused":
      // Routine state change, like budget_paused — no warning prefix: the pause IS the harness
      // holding the role's own spend line. Names the role, its spend vs its cap, and the two
      // lift paths, so the operator knows why the loop stopped and what to do about it.
      return `role ${e.role ?? "?"} paused — ${budgetPhrase(e.spentUsd, e.capUsd)} of its daily cap spent; it starts no new ticks until the cap is raised or removed in tumwater.json or the local day rolls over`;
    case "role_cap_resumed":
      return `role ${e.role ?? "?"} resumed — it is under its daily cap again and ticks again`;
    case "disk_low":
      // Routine state change, like fleet_paused — no warning prefix: the hold IS the harness
      // handling the low disk, and naming the free space and the floor tells the operator
      // whether to clear space or lower diskHoldGB in tumwater.json.
      return `disk low — ${gigabytes(e.freeGB)} GB free on the worktrees volume (floor ${gigabytes(e.holdGB)} GB); new work is held until space recovers`;
    case "disk_ok":
      return `disk recovered — ${gigabytes(e.freeGB)} GB free on the worktrees volume; new work starts again`;
    case "disk_reclaim": {
      // Routine maintenance, no warning prefix: the pass freed space so the hold need not
      // engage. Naming the mode, the worktrees, and the delta tells the operator what and why.
      const names = Array.isArray(e.worktrees) ? e.worktrees.join(", ") : "?";
      return `disk reclaim (${e.mode ?? "pressure"}) — freed ${gigabytes(e.freedGB)} GB from ${names}; ${gigabytes(e.freeGB)} GB free now`;
    }
    case "rate_limit_hold": {
      // Routine state change, like fleet_paused — no warning prefix: the hold IS the harness
      // handling the storm. Names who saw the failure and when the fleet re-opens on its own.
      // The rate-limit kind keeps the wording every historical event has; a backend-failure
      // kind names itself instead, since "429" would be a lie about a connection error.
      const roles = rolesPhrase(e.roles, "several roles");
      if (e.kind && e.kind !== "rate-limit")
        return `backend hold (${backendKindPhrase(e.kind)})${providerAt(e)} — ${roles} hit backend failures; role loops on ${providerScope(e)} start nothing new ${holdPhrase(e.holdMs, e.escalation)} (director keeps running)`;
      return `429 hold${providerAt(e)} — ${roles} rate-limited by the provider; role loops on ${providerScope(e)} start nothing new ${holdPhrase(e.holdMs, e.escalation)} (director keeps running)`;
    }
    case "rate_limit_resumed": {
      // The ended hold's kind rides the resumed event (pollFleetHold logs it), so the lift
      // names what actually ended — the same split as the hold line above: "429 hold lifted"
      // after a connection-error hold would be a lie about a connection error.
      if (e.kind && e.kind !== "rate-limit")
        return `backend hold lifted (${backendKindPhrase(e.kind)})${providerAt(e)} — role loops on ${providerScope(e)} tick again`;
      return `429 hold lifted${providerAt(e)} — role loops on ${providerScope(e)} tick again`;
    }
    case "max_concurrent_changed": {
      // Routine state change, like counters_reset — no warning prefix.
      return `maxConcurrent changed: ${e.from} → ${e.to}`;
    }
    case "retention_changed": {
      // Routine state change, like its maxConcurrent sibling — no warning prefix.
      return `sessionRetentionDays changed: ${e.from} → ${e.to}`;
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
      return `model changed — now ${e.to ?? "pi's default"}`;
    case "model_fallback_started":
      // Routine-with-explanation, like rate_limit_hold: the switch IS the harness handling the
      // failure. Names the pair the role now runs on and why the primary was abandoned.
      return `model fallback — ${e.provider ?? "pi's default"}/${e.model ?? "pi's default"} engaged (primary failing: ${e.reason ?? "backend failure"})`;
    case "model_fallback_ended":
      // The return counterpart: names the pair ticks resume on and how long the episode ran.
      return `model fallback ended — back on ${e.provider ?? "pi's default"}/${e.model ?? "pi's default"} after ${minutes(e.durationMs)}m`;
    case "build_stale":
      // Self-hosting fleets only (src/redeploy/redeploy.ts): the code main describes is not the code
      // running. Not a warning prefix — a stale build is a state, and auto-restart resolves it.
      return `build ${shortSha(e.build)} is stale — main ${shortSha(e.head)} is ${plural(finiteNumber(e.aheadCommits, 0), "commit")} ahead in src/`;
    case "restart_pending":
      return `restart pending — main ${shortSha(e.head)} is green; compiling and draining in-flight ticks (no new ticks start)`;
    case "restart": {
      const aborted = finiteNumber(e.abortedTicks, 0);
      return `restarting onto build ${shortSha(e.to)} (drained ${minutes(e.drainedMs)}m${
          aborted > 0 ? `, ${aborted} tick(s) will resume on the new build` : ""
        })`;
    }
    case "restart_refused":
      // The restart is refused, not failed: the running build stays and the gate is re-asked
      // every poll, so the line names both builds and what the operator must repair.
      return `restart onto build ${shortSha(e.to)} refused — the new build could not start here: ${e.reason}; staying on build ${shortSha(e.from)} until it can`;
    case "restart_blocked":
      // The restart is blocked, not refused: a verdict latched this head, so the line names
      // what failed and that only main moving can end it.
      return `restart blocked for main ${shortSha(e.to)} — ${e.reason}; staying on build ${shortSha(e.from)} until main moves`;
    case "supervisor_exit": {
      // The fleet is DOWN and nothing will bring it back: the one line that must say so, since
      // the dead generation's own stderr reached only the supervisor's terminal.
      const how = e.signal ? `was killed by ${e.signal}` : `exited ${e.code}`;
      return `fleet down — generation ${e.generation} ${how}${e.reason ? `: ${e.reason}` : ""}; the supervisor exited (restart with \`tumwater run\`)`;
    }
    case "resume":
      // Two causes share the resume machinery; the line names the real one so an operator
      // reading the feed can tell a restart from a loop fighting the context ceiling.
      return e.cause === "cut-off"
        ? "resuming the run cut off at the context ceiling (compacted pi session, same worktree)"
        : "resuming the tick a shutdown interrupted (same pi session and worktree)";
    case "warning":
      return `warning: ${e.message}`;
    default:
      return `${e.type}`;
  }
}
