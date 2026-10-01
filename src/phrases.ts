import path from "node:path";
import { isJsonObject } from "./json-object.js";
import { shortSha, squash, usd } from "./text.js";

/** The single home of each human-facing PHRASE the fleet renders — the wording fragments
 * (a pause reason's suffix, a rate-limit hold's "for 60s", a backend hold's kind, a budget
 * transition's "$x of $y", main's red-tip naming, a tool call's one-line label, the plural
 * helper) shared by the event feed (event-format.ts), the failure digest (failure-report.ts
 * and failure-state-change.ts), the status surfaces (ui/), and the CLI messages
 * (operator-commands.ts, cli-run.ts), so their phrasing cannot drift per consumer. Pure
 * presentation: every phrase composes the shared formats text.ts pins (shortSha, usd, squash)
 * into words. Pure value formats — the token a number or hash renders as (compactTokens,
 * shortSha, usd, usdCap) — stay in text.ts; this module is where those tokens become words. */

/** A count and its noun as one phrase (`plural(3, "tick")` → `3 ticks`) — the single home of
 * the singular/plural selection the CLI's once summary (cli-run.ts), the day window's day label
 * (datetime.ts), the failure digest's loss-cause lines (failure-report.ts), and the fleet
 * alerts' banner titles (ui/fleet-alerts.ts, whose local copy this replaces) all rendered
 * inline before. `many` accepts a whole replacement form (`plural(n, "loop is", "loops are")`)
 * so verb-agreement titles share the helper; the plural-by-`s` default covers regular nouns.
 * (The GUI keeps its own JS copy in gui-client.ts: a separate runtime that cannot import
 * TypeScript.) */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The spine of every phrase naming main's tip as red — `main <short-sha> is red` — built here
 * once so the fleet-wide red-main warning (main-red.ts), the review gate's attribution detail
 * (review.ts), the landing check's attribution error (landing-core.ts), and the redeploy hold's
 * block reason (redeploy-policy.ts) cannot drift over how main's red is worded. Each caller
 * appends its own consequence — the gate's "— not this change's failure", the hold's
 * " — holding the restart until main is green". */
export function mainRedPhrase(sha: unknown): string {
  return `main ${shortSha(sha)} is red`;
}

/** The ` — "<reason>"` suffix the operator's pause reason (`pause --reason <text>`) rides on —
 * one home so the CLI's confirmation line (operator-commands.ts), the status header's pause
 * badge (ui/badges.ts), and the paused alert's title (ui/fleet-alerts.ts) cannot drift on the
 * quoting. No reason, no suffix: every caller's reasonless phrasing keeps today's byte-exact
 * form. (The GUI keeps its own JS copies in gui-client.ts: a separate runtime that cannot
 * import TypeScript.) */
export function pauseReasonSuffix(reason: string | undefined): string {
  return reason ? ` — "${reason}"` : "";
}

/** The `$<spent> of $<cap>` fragment every budget-transition event renders — the one home of
 * that phrasing, shared by the event feed (event-format.ts) and the failure digest's Fleet
 * state changes lines (failure-state-change.ts), so a budget transition reads the same on both
 * surfaces. Both fields arrive loosely typed on HarnessEvent, so each is coerced through the
 * cents-pinned money format (usd) here. */
export function budgetPhrase(spentUsd: unknown, capUsd: unknown): string {
  return `${usd(Number(spentUsd ?? 0))} of ${usd(Number(capUsd ?? 0))}`;
}

/** A short duration as `Ns` under two minutes, else whole `Nm` — the one home of that cutoff
 * and rounding, shared by holdPhrase ("for 60s") and the event feed's countdowns
 * ("(in 90s)"), so the threshold or the units cannot drift between the two renderings. */
export function shortSpanPhrase(ms: number): string {
  return ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

/** The `for <duration>[ (relapse N)]` fragment the rate_limit_hold event renders — the one
 * home of that phrasing, shared by the event feed (event-format.ts) and the failure digest's
 * Fleet state changes lines (failure-state-change.ts), like budgetPhrase. The duration is shortSpanPhrase
 * (seconds under two minutes, so the one-minute base hold reads `60s`); the relapse count is
 * named only when the storm resumed right after an earlier hold, the one fact that says the
 * hold doubled. Both fields arrive loosely typed on HarnessEvent, so each is coerced here. */
export function holdPhrase(holdMs: unknown, escalation: unknown): string {
  const ms = Math.max(0, Number(holdMs ?? 0)) || 0;
  const span = shortSpanPhrase(ms);
  const relapse = Number(escalation ?? 0);
  return `for ${span}${relapse > 0 ? ` (relapse ${relapse})` : ""}`;
}

/** The human phrase for a fleet hold's backend-failure kind — the one home of that phrasing,
 * shared by the event feed (event-format.ts) and the failure digest's Fleet state changes
 * lines (failure-state-change.ts), like holdPhrase above. A "rate-limit" hold (or a
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
 * warning (src/pi.ts names the hung command through it). Path-like keys reduce to the file
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
