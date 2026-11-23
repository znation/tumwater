import { HOUR_MS, DAY_MS, boundedWindowLine, sinceWindowLine } from "./datetime.js";

/** Millis per unit, the multiplier parseDurationMs's regex group is applied to. The
 * hour and day multipliers are HOUR_MS / DAY_MS (text/datetime.ts's shared units, the
 * convention that records why no two sites may spell them differently); second and minute
 * keep their own literals as there is no shared MINUTE_MS/SECOND_MS constant to fold onto.
 * The one home for the duration grammar, shared by the CLI parser (cli/cli-args.ts's
 * parseDurationFlag) and every surface that echoes a duration back in the same vocabulary —
 * a pause confirmation, a wake/stop notice, a report window — so the
 * parser's acceptance and the renders' phrasing cannot drift. */
const UNIT_MS = { s: 1_000, m: 60_000, h: HOUR_MS, d: DAY_MS } as const;

/** The position of each unit in the descending order a composite duration must follow
 * (d → h → m → s), so `30m1h` and `1h30m1h` fail instead of parsing to a surprising total. */
const UNIT_ORDER: Record<keyof typeof UNIT_MS, number> = { d: 0, h: 1, m: 2, s: 3 };

/** The unit letters in the order the grammar accepts them, highest first. */
const DURATION_UNIT_ORDER = ["d", "h", "m", "s"];

/** Why `raw` is not a duration, as one short clause a caller appends to the message that already
 * states the grammar. parseDurationMs answers every malformed spelling with the same null, so
 * both of its refusals (cli/cli-args.ts's parseDurationFlag, which serves `--since`, `--until`,
 * `--for`, `--in` and `--at`, and gui/gui-prompt-commands.ts's `defer` field) printed one message
 * for every slip: a value typed as `2hours`, as `1h 30m`, or as a bare `45` all came back as
 * "needs a duration like 45s, 90m, 1h30m, or 2d (got …)", leaving the operator to spot the slip
 * themselves in a value they had just typed. The clause names which slip it is — a missing unit,
 * a unit spelled as a word, whitespace, a negative, a fractional or zero count, a repeated or
 * out-of-order unit, or a final number left without one.
 * It is a clause, not a report: it never quotes `raw` (every call site appends gotSuffix, which
 * does) and never rewords the standing message, so the existing prefix pins of that message still
 * match. The branches run most-specific first, so a value that matches two shapes names the one
 * to fix first (`-1h 30m` reports the sign, not the space). Callers reach it only on a value the
 * grammar refused; it answers "" for the empty value (the grammar line already says everything
 * there), for a lone `-` (a flag fragment, not a negative count — naming one would be a guess),
 * and for a refusal it cannot explain better than the grammar line does, so a caller appends it
 * unconditionally. test/duration-slip.test.ts pins that no spelling the grammar accepts gains a
 * clause, over a generated space of them, which is what keeps these branches honest. */
export function durationSlipClause(raw: string): string {
  if (raw === "") return "";
  if (/^-(?:\d|\.)/.test(raw)) return " — a duration may not be negative";
  // A lone leading `-` with no count after it (a `-` flag fragment, `--json`) is not a negative
  // count, so naming one would be a guess; the CLI refuses such tokens before the grammar is ever
  // asked, and here the clause stays out of the way.
  if (raw.startsWith("-")) return "";
  if (/^\s|\s$/.test(raw)) return " — it has leading or trailing whitespace";
  if (/\s/.test(raw)) return " — its components must touch, with no space between them";
  const runs = raw.match(/[a-z]+/gi) ?? [];
  const misspelled = runs.find((run) => !/^[dhms]+$/i.test(run));
  if (misspelled !== undefined)
    return ` — the unit must be one of d, h, m, or s, not ${JSON.stringify(misspelled)}`;
  if (/^\d+$/.test(raw)) return " — it has no unit; the units are d, h, m, and s";
  if (/^[a-z]/i.test(raw)) return " — every unit needs a number before it";
  if (/^\d*\.\d/.test(raw)) return " — a component's count must be a whole number";
  if (runs.length === 0) return " — it needs a number and a unit; the units are d, h, m, and s";
  const units = runs.join("").toLowerCase().split("");
  if (units.some((u, i) => units.indexOf(u) !== i)) return " — a unit may not repeat";
  if (!isDescendingUnitOrder(units)) return ` — units must descend ${DURATION_UNIT_ORDER.join(" → ")}`;
  if (/\d$/.test(raw)) return " — every number needs the unit that follows it";
  if ((raw.match(/\d+/g) ?? []).some((count) => count.startsWith("0")))
    return " — a component's count may not be 0 or start with 0";
  return "";
}

/** Do the unit letters in `units` run highest-first with none repeated — the order the grammar
 * matches its components in. A repeat already returned its own clause at the caller, so the
 * `<=` here only ever answers for a genuinely out-of-order pair. */
function isDescendingUnitOrder(units: string[]): boolean {
  let last = -1;
  for (const unit of units) {
    const rank = DURATION_UNIT_ORDER.indexOf(unit);
    if (rank <= last) return false;
    last = rank;
  }
  return true;
}

/** Parse a composite duration spelling: one or more `<n><unit>` components in strictly
 * descending unit order (e.g. `45s`, `90m`, `1h30m`, `1h30m15s`), each a plain-decimal
 * count — no leading zero (`007s` fails) and none zero (`0h30m` fails; write `30m`).
 * A gap between components (whitespace, junk) and an out-of-order or repeated unit return
 * null; returns the total in milliseconds, or null. Kept a pure text→ms parser here so a
 * server surface can validate a duration without ending the process through the CLI's
 * parseDurationFlag's fail() wrapper. */
export function parseDurationMs(raw: string): number | null {
  const re = /([1-9]\d*)([smhd])/g;
  let ms = 0;
  let consumed = 0;
  let prevOrder = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index !== consumed) return null; // a gap: whitespace or junk between components
    const order = UNIT_ORDER[m[2] as keyof typeof UNIT_MS];
    if (order <= prevOrder) return null; // repeated or out-of-order unit
    prevOrder = order;
    ms += Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
    // A digit run past Number's range overflows the sum to Infinity; returning it would let
    // a call report a total no operator wrote and the cap check render the nonsense
    // "got Infinityms". No honest duration to return here either, so fail the shape.
    if (!Number.isFinite(ms)) return null;
    consumed = re.lastIndex;
  }
  return consumed === raw.length && consumed > 0 ? ms : null;
}

/** The human phrase for a millisecond duration (`45000` → `45s`, `5400000` → `90m`,
 * `3600000` → `1h`): the same `<n><unit>` vocabulary parseDurationMs accepts, so everything
 * that echoes a duration back — a pause confirmation, a report window, an inbox-delivery
 * notice — uses a form an operator could re-type. A duration that divides evenly into a day,
 * hour, or minute reads that single unit (a whole hour reads `1h`, not `60m`, so ninety
 * minutes reads `90m`); anything else decomposes greedily, largest unit first
 * (`5403s` → `1h30m3s`, `90s` → `1m30s`, `45s` unchanged); a sub-second remainder (possible
 * from computed deltas) keeps the raw-millisecond form. */
export function durationLabel(ms: number): string {
  const units = Object.entries(UNIT_MS).reverse() as [keyof typeof UNIT_MS, number][];
  if (ms === 0) return "0s";
  for (const [unit, size] of units) {
    if (size >= UNIT_MS.m && ms % size === 0) return `${ms / size}${unit}`;
  }
  let rest = ms;
  const parts: string[] = [];
  for (const [unit, size] of units) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }
  return rest === 0 ? parts.join("") : `${ms}ms`;
}

/** The human phrase for a two-ended time window — `between 2h and 1h ago` — the shape
 * `--since/--until` windows share with `history`'s and `logs`' bounded empties.
 * Unbounded windows keep their own "last …"/"in …" phrasing; only the two-ended form is
 * folded here so the sites cannot drift. The two bounds are labeled in caller order (older
 * before newer at every current site), and each is run through durationLabel, so a phrase
 * always echoes a form the parser accepts. Lives beside durationLabel for that reason. */
export function betweenWindow(older: number, newer: number): string {
  return `between ${durationLabel(older)} and ${durationLabel(newer)} ago`;
}

/** The trailing-window header line — `window: last <duration> (since …)`, or
 * `window: <older> to <newer> ago (since …, until …)` when the window ends before now — that the
 * usage report's `--since` render and the failure digest's since shape each print as their window
 * line. Both built it from the raw `untilMs`/`toIso` fields with the same bounded-or-since split
 * (a window is bounded when both `untilMs` and `toIso` are present, `sinceMs` being always
 * present at either site), so the two surfaces' window wording cannot drift: the bounded branch
 * runs both bounds through durationLabel, the since branch its length, and the day-shape window
 * line is a different unit and stays with the day renderer. The since/bounded line builders in
 * datetime.ts take already-phrased duration strings, so this helper does the durationLabel step
 * (and passes the raw `fromIso`/`toIso` ISO strings through) — callers hand it the raw window
 * fields as the collectors produce them. Lives beside betweenWindow — the one other home of the
 * bounded-window phrase. */
export function trailingWindowLine(sinceMs: number, fromIso: string, untilMs?: number, toIso?: string): string {
  return untilMs !== undefined && toIso !== undefined
    ? boundedWindowLine(durationLabel(sinceMs), durationLabel(untilMs), fromIso, toIso)
    : sinceWindowLine(durationLabel(sinceMs), fromIso);
}
