import { textOr } from "./text.js";

/** Shared number, money, and hash FORMATS for human-facing text — the display layer's token
 * counts (compactTokens), abbreviated commit hashes (shortSha), and money strings (usd,
 * usdCap). Split from text.ts beside the other single-format homes it already names:
 * datetime.ts (dates and durations), text-width.ts (terminal-column geometry), and text/phrases.ts
 * (wording fragments). Presentation only: depends on node built-ins alone, so any layer
 * (harness or observer) can import it — and each format lives in exactly one place so the
 * abbreviation length, decimal width, and compaction thresholds cannot drift per consumer. */

/** Compact token count for tight table cells and commit trailers — bare integers below
 * 10,000, one-decimal k at and above 10,000, one-decimal M at and above 1,000,000. The single
 * home of the token display format shared by the status table's gen/peak-ctx columns and the
 * commit trailer's ctx field — pinned here so those surfaces cannot drift even though they
 * live in different modules. */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The abbreviated form of a commit hash for human-facing text — its first 8 characters.
 * The single home of this format: the event feed's merged/review lines and the review gate's
 * discard warning all render hashes through it, so the abbreviation length cannot drift per
 * consumer. Takes unknown because harness events carry their fields loosely typed (the
 * index signature): a string or finite number abbreviates as the inline `String(…).slice(0, 8)`
 * did before, while a missing or foreign value reads as "?" (textOr), never String(undefined)'s
 * literal "undefined". */
export function shortSha(sha: unknown): string {
  return textOr(sha).slice(0, 8);
}

/** A USD amount with its dollar sign and exactly two decimals ($12.34) — the single home of
 * the cents-pinned money format shared by the event feed's budget/usage lines (event-format.ts),
 * the status table's cost/today cells plus totals row (status-render.ts), and the usage
 * report's totals line plus per-day cost column (report-render.ts), so the decimal width cannot
 * drift per consumer. The cap variant that drops whole-dollar `.00` is a different
 * format (`usdCap` below); the GUI's row cells still format money from their own inline JS (a
 * separate runtime that cannot import TypeScript), while header badges like `budgetBadge`
 * arrive preformatted. */
export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** A USD cap for display: whole dollars stay bare ($50), fractional ones keep their cents
 * ($12.34) — the budget badge reads `· budget: $12.34/$50 today`, and the TUI's cap-edit
 * confirmation reads `budget set to $25`. The single home of the drop-`.00` rule, shared by
 * badges.ts's `budgetBadge` and the TUI's budget-edit flash so the two cannot drift (the
 * GUI renders the same rule from its own JS copy in gui-client.ts: a separate runtime that
 * cannot import TypeScript). */
export function usdCap(n: number): string {
  return `$${n.toFixed(2).replace(/\.00$/, "")}`;
}

/** A disk size in GB for display: one decimal and the unit (`12.3 GB`) — the single home of
 * the disk-size format shared by the event feed's disk lines (event-format.ts), the status
 * header's disk badge (badges.ts's `diskBadge`), the fleet's low-disk alert (fleet-alerts.ts),
 * the doctor's disk check detail (doctor-checks.ts), and `tumwater reclaim`'s freed-size line
 * (operator-commands.ts), so the decimal width and unit cannot drift per consumer. A caller
 * reading the value from an untrusted event field applies event-format.ts's `gigabytes`
 * wrapper (finiteNumber's corrupt-field rule) over this. */
export function formatGB(n: number): string {
  return `${n.toFixed(1)} GB`;
}
