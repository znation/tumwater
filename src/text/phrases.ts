import path from "node:path";
import { finiteNumber, isJsonObject } from "../files/json-object.js";
import { squash } from "./text.js";
import { shortSha, usd } from "./format.js";

/** The single home of each human-facing PHRASE the fleet renders — the wording fragments (a pause
 * reason's suffix, a rate-limit hold's "for 60s", a backend hold's kind, a budget transition's "$x
 * of $y", main's red-tip naming, a tool call's one-line label, the plural helper) shared by the
 * event feed (event-format.ts), the failure digest (src/failure/failure-render.ts and
 * src/failure/failure-state-change.ts), the status surfaces (ui/), and the CLI messages
 * (operator/operator-commands.ts, cli/cli-run.ts), so their phrasing cannot drift per consumer.
 * Pure presentation: every phrase composes the shared formats format.ts pins (shortSha, usd,
 * squash) into words. Pure value formats — the token a number or hash renders as (compactTokens,
 * shortSha, usd, usdCap) — stay in format.ts; this module is where those tokens become words. */

const NO_REASONS_GIVEN = "no reasons given";

/** The reason an over-long prompt or config field carries: the text rides into a tick's
 * prefill, so a longer value bloats every tick's context. The single home of that tail,
 * shared by init's seed check (init/init.ts) and config-validation's customLoops task and
 * roles-instructions caps (config/config-validation.ts), so the three cannot drift on the
 * wording. inbox-submit's promptLengthProblem renders a role-scoped variant ("it rides into
 * the <role> tick's prefill") and keeps its own wording. */
export const PREFILL_REASON = "it rides into every tick's prefill";

/** The reason a review rejection leads with — its first listed reason, or `no reasons given`
 * when the list is empty or its first entry is not a string. One home so the fallback cannot
 * drift across the four surfaces that show just that first reason: the review gate's returned
 * detail (review.ts), the event feed's one-line reject (event-format.ts), the failure digest's
 * rejection clusters (failure-data.ts), and the error a loop's next tick records (tick-apply.ts).
 * Sites that render the whole reason list, or intentionally omit the fallback (time-spend.ts's
 * first-reason example, review.ts's rejection event `reason`), keep their own handling. */
export function firstReason(reasons: readonly unknown[] | undefined): string {
  const first = reasons?.[0];
  return typeof first === "string" ? first : NO_REASONS_GIVEN;
}

/** A count and its noun as one phrase (`plural(3, "tick")` → `3 ticks`) — the single home of the
 * singular/plural selection the CLI's once summary (cli/cli-run.ts), the day window's day label
 * (datetime.ts), the failure digest's loss-cause lines (src/failure/failure-render.ts), and the
 * fleet alerts' banner titles (ui/fleet-alerts.ts, whose local copy this replaces), and the
 * build_stale lines' "N commit(s) ahead" (event-format.ts, src/failure/failure-state-change.ts —
 * the singular/plural wording their tests pin, once "N commit(s)" with the old literal, now "N
 * commits"/"1 commit"), and the stage self-check and dropped-attachment notes
 * (src/tick/tick-stage.ts, inbox/inbox-attachments.ts) all rendered inline before. `many` accepts a
 * whole replacement form (`plural(n, "loop is", "loops are")`) so verb-agreement titles share the
 * helper; the plural-by-`s` default covers regular nouns. (The GUI keeps its own JS copy in
 * gui-client.ts: a separate runtime that cannot import TypeScript.) */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The number form of a word that agrees with `n`, without the count — `agree(1, "is", "are")` →
 * `is`, `agree(2, "cause", "causes")` → `causes` — the companion to plural for the slots plural's
 * count-plus-noun shape cannot fill: a subject or noun whose count is printed elsewhere in the
 * sentence (a subject phrase such as listRoles's role list, a count named earlier) still needs the
 * right number form. The fleet alerts' banner titles (ui/fleet-alerts.ts), the resume
 * confirmation's still-paused note (operator/operator-commands.ts), the dropped-attachment note
 * (inbox-attachments.ts), the failure digest's loss-cause and cluster remainders
 * (failure/failure-render.ts), the doctor's oh-my-pi and model notes
 * (doctor/doctor-model-checks.ts), and `tumwater role`'s queued-prompt remainder
 * (roles/role-render.ts) all rendered the same `=== 1 ? … : …` selection inline before, so the
 * singular/plural decision now has one home beside plural's. */
export function agree(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The spine of every phrase naming main's tip as red — `main <short-sha> is red` — built here once
 * so the fleet-wide red-main warning (main-red.ts), the review gate's attribution detail
 * (review.ts), the landing check's attribution error (landing-check-failures.ts), and the redeploy
 * hold's block reason (src/redeploy/redeployer.ts) cannot drift over how main's red is worded. Each
 * caller appends its own consequence — the gate's "— not this change's failure", the hold's " —
 * holding the restart until main is green". */
export function mainRedPhrase(sha: unknown): string {
  return `main ${shortSha(sha)} is red`;
}

/** The main-red attribution detail — main's redness is not this change's failure — the review
 * pre-check's reject detail (review-precheck.ts) and the landing check's lastError
 * (landing-check-failures.ts) both build as mainRedPhrase plus the consequence suffix. One
 * home beside mainRedPhrase so the two attribution surfaces cannot drift over the wording
 * their tests pin. The other mainRedPhrase callers keep their own consequences: main-red.ts
 * names the failing script and its action, src/redeploy/redeployer.ts holds the restart. */
export function mainRedNotMine(sha: unknown): string {
  return `${mainRedPhrase(sha)} — not this change's failure`;
}

/** The ` — "<reason>"` suffix the operator's pause reason (`pause --reason <text>`) rides on — one
 * home so the CLI's confirmation line (operator/operator-commands.ts), the status header's pause
 * badge (ui/badges.ts), and the paused alert's title (ui/fleet-alerts.ts) cannot drift on the
 * quoting. No reason, no suffix: every caller's reasonless phrasing keeps today's byte-exact form.
 * (The GUI keeps its own JS copies in gui-client.ts: a separate runtime that cannot import
 * TypeScript.) */
export function pauseReasonSuffix(reason: string | undefined): string {
  return reason ? ` — "${reason}"` : "";
}

/** The harness warning a loop crossing the error-streak threshold raises — `3 consecutive
 * tick failures: <reason>` — shared by the tick-side crossing (tick-finalize.ts, an error or
 * recovery failure) and the landing-side crossing a review rejection resolves
 * (landing-slot.ts), the two sites that build the message, so the operator-facing wording
 * their tests pin cannot drift between them. */
export function consecutiveFailuresWarning(count: number, reason: string): string {
  return `${count} consecutive tick failures: ${reason}`;
}

/** The base line for an operator fleet pause — `fleet paused — role loops stop starting new
 * ticks` — built here so the event feed (event-format.ts, which appends its own `(director
 * keeps running)` consequence) and the failure digest's Fleet state changes lines
 * (src/failure/failure-state-change.ts, which keeps the short form) cannot drift on the base
 * wording. `tumwater pause`'s confirmation (operator/operator-commands.ts) interleaves its
 * `--for`/`--reason` spans before the dash, so it composes its own line and keeps that wording
 * inline. */
export function fleetPausePhrase(): string {
  return "fleet paused — role loops stop starting new ticks";
}

/** The base line for lifting the fleet pause — `fleet resumed — role loops tick again` — shared
 * by the event feed (event-format.ts), the failure digest's Fleet state changes lines
 * (src/failure/failure-state-change.ts), and `tumwater resume`'s confirmation
 * (operator/operator-commands.ts, which appends its `--for` and still-paused-role spans), so the
 * three cannot drift. */
export function fleetResumePhrase(): string {
  return "fleet resumed — role loops tick again";
}

/** The base line for a per-role pause — `role <id> paused — it stops starting new ticks` — shared
 * by the event feed (event-format.ts, which appends `(the rest of the fleet keeps running)`) and
 * the failure digest's Fleet state changes lines (src/failure/failure-state-change.ts, which
 * deliberately keeps the short form), so the two cannot drift on the base wording. The role is
 * coerced, so the digest's byte-sliced `field()` output and the feed's raw field both render. */
export function rolePausePhrase(role: unknown): string {
  return `role ${String(role)} paused — it stops starting new ticks`;
}

/** The base line for a per-role resume — `role <id> resumed — it ticks again` — shared by the
 * event feed (event-format.ts) and the failure digest's Fleet state changes lines
 * (src/failure/failure-state-change.ts), so the two cannot drift. The role is coerced, like
 * rolePausePhrase. */
export function roleResumePhrase(role: unknown): string {
  return `role ${String(role)} resumed — it ticks again`;
}

/** The line for an orchestrator shutdown — the event feed (event-format.ts) and the failure
 * digest's Fleet state changes lines (src/failure/failure-state-change.ts) both render it. */
export const ORCHESTRATOR_STOPPED = "orchestrator stopped";

/** A HarnessEvent's loosely typed `roles` list as a `A, B, C` phrase — the single home of the array
 * coercion and join, shared by the event feed (event-format.ts: counters_reset's scope,
 * budget_handback's handed-back list, the rate_limit_hold line) and the failure digest's state-
 * change lines (src/failure/failure-state-change.ts, whose hold lines cap the list and slice each
 * role), so the two surfaces cannot disagree on how an absent or malformed roles field renders. A
 * non-array falls back to `fallback`; with `max`, extra roles are dropped from the tail; with
 * `format`, each role is rendered through it (the digest passes its byte-slicing field()). */
export function rolesPhrase(
  roles: unknown,
  fallback: string,
  max?: number,
  format: (role: unknown) => string = String,
): string {
  if (!Array.isArray(roles)) return fallback;
  const list = roles.map(format);
  if (max !== undefined) list.length = Math.min(list.length, max);
  return list.length > 0 ? list.join(", ") : fallback;
}

/** The `$<spent> of $<cap>` fragment every budget-transition event renders — the one home of that
 * phrasing, shared by the event feed (event-format.ts) and the failure digest's Fleet state changes
 * lines (src/failure/failure-state-change.ts), so a budget transition reads the same on both
 * surfaces. Both fields arrive loosely typed on HarnessEvent, so each is coerced through
 * finiteNumber (a non-number or non-finite value reads as 0, exactly as event-read.ts's eventUsage
 * reads a corrupt usage field) before the cents-pinned money format (usd) renders it — a string or
 * NaN must never reach usd, which would print "$NaN". */
export function budgetPhrase(spentUsd: unknown, capUsd: unknown): string {
  return `${usd(finiteNumber(spentUsd, 0))} of ${usd(finiteNumber(capUsd, 0))}`;
}

/** A short duration as `Ns` under two minutes, else whole `Nm` — the one home of that cutoff
 * and rounding, shared by holdPhrase ("for 60s") and the event feed's countdowns
 * ("(in 90s)"), so the threshold or the units cannot drift between the two renderings. */
export function shortSpanPhrase(ms: number): string {
  return ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

/** The `for <duration>[ (relapse N)]` fragment the rate_limit_hold event renders — the one home of
 * that phrasing, shared by the event feed (event-format.ts) and the failure digest's Fleet state
 * changes lines (src/failure/failure-state-change.ts), like budgetPhrase. The duration is
 * shortSpanPhrase (seconds under two minutes, so the one-minute base hold reads `60s`); the relapse
 * count is named only when the storm resumed right after an earlier hold, the one fact that says
 * the hold doubled. Both fields arrive loosely typed on HarnessEvent, so each is coerced here. */
export function holdPhrase(holdMs: unknown, escalation: unknown): string {
  const ms = Math.max(0, Number(holdMs ?? 0)) || 0;
  const span = shortSpanPhrase(ms);
  const relapse = Number(escalation ?? 0);
  return `for ${span}${relapse > 0 ? ` (relapse ${relapse})` : ""}`;
}

/** The human phrase for a fleet hold's backend-failure kind — the one home of that phrasing,
 * shared by the event feed (event-format.ts) and the failure digest's Fleet state changes
 * lines (src/failure/failure-state-change.ts), like holdPhrase above. A "rate-limit" hold (or a
 * hold with no readable kind — a torn line) never renders through this: those keep the 429
 * wording, which is the shape every historical event already has. */
export function backendKindPhrase(kind: unknown): string {
  switch (kind) {
    case "connection":
      return "connection error";
    case "timeout":
      return "request timed out";
    case "server":
      return "server error";
    case "model-load":
      return "model load failure";
    case "stream-severed":
      return "stream severed";
    default:
      return "backend failure";
  }
}

/** One-line description of a tool call from its name and args — shared by live progress data
 * collection (LiveProgress.lastTool), transcript rendering, and the harness's stalled-tool-call
 * warning (src/pi/pi.ts names the hung command through it). Path-like keys reduce to the file
 * name; the other candidate keys are shown verbatim. */
export function describeToolCall(toolName: string, args: unknown): string {
  let detail = "";
  if (isJsonObject(args)) {
    const candidate = args.path ?? args.file_path ?? args.command ?? args.cmd ?? args.pattern ?? args.url;
    if (typeof candidate === "string") {
      detail =
        candidate === args.path || candidate === args.file_path ? path.basename(candidate) : candidate;
    }
  }
  detail = squash(detail, 32);
  // An empty name (pi omits toolName on some start events) yields the bare detail — no
  // leading space in front of it.
  return detail ? (toolName ? `${toolName} ${detail}` : detail) : toolName;
}

/** The ` (+N more)` remainder suffix a capped list appends when `count` entries were omitted —
 * empty when none were, so the item fits an already-built line either way. The single home of that
 * parenthesized remainder, shared by the reviewer suite-rerun warning (review/suite-rerun.ts) and
 * the stage self-check's missing-path and lost-final-newline findings (tick/stage-check.ts), so the
 * three cannot drift on the spacing or the parenthesized form. The other remainder phrasings keep
 * their own wording: the failure digest's bare `+N more` role list and its `_+N more …_` lines
 * (failure/failure-render.ts), doctor's `and N more` (doctor/doctor-orphans.ts), the TUI alert
 * pointer (ui/tui/tui-frame.ts), and the review-reject reasons, whose extra clause sits inside the
 * parentheses (events/event-format.ts). */
export function moreSuffix(count: number): string {
  return count > 0 ? ` (+${count} more)` : "";
}
