import { HOUR_MS, DAY_MS } from "./datetime.js";

/** Millis per unit, the multiplier parseDurationMs's regex group is applied to. The
 * hour and day multipliers are HOUR_MS / DAY_MS (text/datetime.ts's shared units, the
 * convention that records why no two sites may spell them differently); second and minute
 * keep their own literals as there is no shared MINUTE_MS/SECOND_MS constant to fold onto.
 * The one home for the duration grammar, shared by the CLI parser (cli/cli-args.ts's
 * parseDurationFlag) and every surface that echoes a duration back in the same vocabulary —
 * a pause confirmation, a wake/stop notice, a report window, a TUI input echo — so the
 * parser's acceptance and the renders' phrasing cannot drift. */
const UNIT_MS = { s: 1_000, m: 60_000, h: HOUR_MS, d: DAY_MS } as const;

/** The position of each unit in the descending order a composite duration must follow
 * (d → h → m → s), so `30m1h` and `1h30m1h` fail instead of parsing to a surprising total. */
const UNIT_ORDER: Record<keyof typeof UNIT_MS, number> = { d: 0, h: 1, m: 2, s: 3 };

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
 * `--since/--until` windows share with the history TUI and `history`'s bounded empties.
 * Unbounded windows keep their own "last …"/"in …" phrasing; only the two-ended form is
 * folded here so the sites cannot drift. The two bounds are labeled in caller order (older
 * before newer at every current site), and each is run through durationLabel, so a phrase
 * always echoes a form the parser accepts. Lives beside durationLabel for that reason. */
export function betweenWindow(older: number, newer: number): string {
  return `between ${durationLabel(older)} and ${durationLabel(newer)} ago`;
}
