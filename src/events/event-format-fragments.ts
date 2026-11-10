import type { HarnessEvent } from "./events.js";
import { eventUsage } from "./event-read.js";
import { shortSpanPhrase } from "../text/phrases.js";
import { compactTokens, formatGB, usd } from "../text/format.js";
import { isNonBlankString, textOr } from "../text/text.js";
import { formatClock } from "../text/datetime.js";
import { finiteNumber, isJsonObject } from "../files/json-object.js";

export function mostByPhrase(value: unknown): string {
  const top = Array.isArray(value)
    ? value.flatMap((r: unknown) =>
        isJsonObject(r) && typeof r.role === "string" && Number.isFinite(r.spentUsd)
          ? [`${r.role} ${usd(r.spentUsd as number)}`]
          : [],
      )
    : [];
  return top.length > 0 ? ` (most by ${top.join(", ")})` : "";
}

/** The `<N> tok · $<spent>` usage fragment every event that records a run's cost shares (run_end,
 * merge_done): the usage numbers arrive via eventUsage (the loose-typing coercion every usage
 * consumer shares), rendered through the shared token/money formats (compactTokens, usd) in one
 * place. Either part is omitted when zero or absent, so skipped runs and zero-usage merges render
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
export function usagePhrase(e: HarnessEvent): string {
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
export function elapsed(ms: unknown): string {
  const n = finiteNumber(ms, null);
  if (n === null || n < 0) return "";
  return ` (in ${shortSpanPhrase(n)})`;
}

/** The `waited <duration>` head of the three wait-family events (slot_wait, provider_wait,
 * check_wait) — each rendered its own `waited ${shortSpanPhrase(finiteNumber(e.waitedMs, 0))}`
 * inline, so the corrupt-field rule and the s/m bucketing cannot drift between them. Each
 * caller keeps its own `to start`/`for a run slot`/`for a check slot` tail and its own
 * parenthetical after it. */
export function waitedSpan(waitedMs: unknown): string {
  return `waited ${shortSpanPhrase(finiteNumber(waitedMs, 0))}`;
}

/** A disk event's GB field as "12.3 GB" text. A torn or hand-edited event whose value is
 * missing or non-numeric reads as "0.0 GB", never "NaN" — the same corrupt-field rule
 * budgetPhrase applies to spentUsd/capUsd, since HarnessEvent's index signature hands every
 * field over unvalidated. The rounding and unit are text/format.ts's formatGB. */
export function gigabytes(v: unknown): string {
  return formatGB(finiteNumber(v, 0));
}

/** A duration in whole minutes. A torn or hand-edited value that is missing or non-numeric
 * reads as 0, never NaN — the same corrupt-field rule gigabytes applies, for the fallback
 * episode's and the restart's minute counts. */
export function minutes(ms: unknown): number {
  return Math.round(Number(finiteNumber(ms, 0)) / 60_000);
}

/** ` until HH:MM:SS` for a timestamped pause event (team_paused/role_paused) whose until time is
 * present, or "" when it is missing or non-numeric — the same corrupt-field rule windowResetPhrase
 * applies (a torn or hand-edited line must not coerce Number("…") into a fabricated clock). Shared
 * by the event feed's pauseSuffix and the failure digest's pause lines so the three cannot drift on
 * the spacing or the clock format. */
export function untilClockSuffix(until: unknown): string {
  const ms = finiteNumber(until, null);
  return ms === null ? "" : ` until ${formatClock(ms)}`;
}

/** ` until HH:MM:SS` and `: reason` for a paused event, each "" when its field is absent or
 * the wrong type (the corrupt-field rule windowResetPhrase applies). The until half is
 * untilClockSuffix, so the feed and digest aggregators share it. */
export function pauseSuffix(until: unknown, reason: unknown): string {
  return `${untilClockSuffix(until)}${isNonBlankString(reason) ? `: ${reason}` : ""}`;
}

/** `, resets HH:MM` for a subscription-window event carrying resetsAt, or "" when the field is
 * absent or non-numeric (a torn line, or a window the account did not stamp) — the same
 * corrupt-field rule the other optional-field renderers apply. */
export function windowResetPhrase(e: HarnessEvent): string {
  const at = finiteNumber(e.resetsAt, null);
  return at === null ? "" : `, resets ${formatClock(at)}`;
}

/** The parenthesized ` (<window>)` a quiet-hours event names when it carries one, or "" when
 * the field is absent or blank (pollQuietHoursGate may send no window, so a routine hold must
 * not fabricate a pair). Shared by the started and ended lines so the two cannot drift on the
 * window's presence or format. */
export function windowSuffix(e: HarnessEvent): string {
  return isNonBlankString(e.window) ? ` (${textOr(e.window)})` : "";
}

/** The backend a hold event names, rendered as " at <provider>" when one is configured
 * (pollTeamHold omits it for pi's default) and "" otherwise, so a multi-provider team can
 * tell WHICH backend the storm was at. Shared by the hold and resumed lines. */
export function providerAt(e: HarnessEvent): string {
  return typeof e.provider === "string" ? ` at ${e.provider}` : "";
}

/** How a hold line scopes the roles it stops: "that provider" when the event names one, or
 * "every provider" when it does not (pi's default, or a hold that hit the only configured
 * backend). Shared by the hold and resumed lines so the scope cannot drift between them. */
export function providerScope(e: HarnessEvent): string {
  return typeof e.provider === "string" ? "that provider" : "every provider";
}

/** A subscription-window event's backend, rendered as the id the event names ("claude", or a
 * later backend's own id), falling back to "claude" for an event written before the window
 * events carried a `backend`. A claude-only team's lines read exactly as the older
 * `claude_window_*` lines did. */
export function backendLabel(e: HarnessEvent): string {
  return typeof e.backend === "string" && e.backend !== "" ? e.backend : "claude";
}

/** A subscription-window event's window, as "<backend> subscription window <type>" — the head
 * every `subscription_window_*` line names (windowType is a torn/older event's only nullable
 * half, so `reset` and the shaped lines differ only in what follows this prefix). One home so
 * the four lines cannot drift on the backend's label or the window-type word. */
export function subscriptionWindowPhrase(e: HarnessEvent): string {
  return `${backendLabel(e)} subscription window ${textOr(e.windowType)}`;
}

/** The provider/model pair a fallback-ish line names, as "provider/model", defaulting each
 * half when the event omits it (a bare pi run carries neither). Shared by the budget_fallback
 * line so the pair's shape and defaults cannot drift. */
export function providerModelPair(e: HarnessEvent, providerDefault: string, modelDefault: string): string {
  return `${textOr(e.provider, providerDefault)}/${textOr(e.model, modelDefault)}`;
}

/** An event's outcome string — a run's `result`, or a merge's or build check's `status`,
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
 * eventRun's run, never String(undefined)'s literal "undefined". The display surfaces — the
 * event line, the history row, the run drill-down — use this; eventResult stays undefined
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
