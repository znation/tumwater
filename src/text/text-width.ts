/** Terminal-column geometry: how many cells a string occupies on a terminal, and clipping and
 * padding to a column budget. Split from text.ts, whose other helpers budget by UTF-16 code
 * units (truncate's character count) — a different unit than the display column this module
 * measures, kept apart so the two meanings of "width" cannot be confused. Consumers: the event
 * log's aligned table (event-format.ts), the CLI tables (status-render.ts, history.ts), and the
 * TUI's line rendering (tui-frame.ts, tui-input.ts, tui-backlog.ts). Presentation only:
 * depends on node built-ins alone. */

/** East Asian Wide/Fullwidth and common emoji code-point ranges that render two terminal
 * columns wide — an approximate wcwidth table covering the CJK, Hangul, fullwidth, and emoji
 * text this harness's labels and lines realistically carry. Combining marks and variation
 * selectors count as one column, which only overestimates width, so clippers driven by these
 * numbers cut earlier than strictly needed and can never overflow the budget. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/** The terminal display width of one code point: 2 in the wide ranges above, else 1. */
function codePointWidth(cp: number): number {
  for (const [lo, hi] of WIDE_RANGES) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

/** The terminal display width of `s` in columns: each code point counts 1, except the wide
 * ranges above, which count 2. Iterating by code point (not code units) makes an astral
 * character such as emoji one unit of width 2 — not two half-width halves — so a surrogate
 * pair can never be measured or cut apart. */
export function displayWidth(s: string): number {
  let total = 0;
  for (const ch of s) total += codePointWidth(ch.codePointAt(0)!);
  return total;
}

/** Pad `s` with trailing spaces until it occupies exactly `width` terminal display columns —
 * the display-width sibling of String#padEnd, which counts UTF-16 code units and under-pads
 * any cell holding wide characters (CJK, emoji), letting its column drift right. Text already
 * past `width` is returned unchanged; callers clip first when a cell must not exceed the
 * column. Shared by the aligned tables (status-render.ts, history.ts). */
export function padToWidth(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/** Clip `s` to `width` terminal display columns with a trailing ellipsis when over — the
 * column-budget sibling of truncate (text.ts), which caps by character budget. Widths are
 * measured by displayWidth, so East Asian wide characters and emoji count their real two
 * columns and a clipped line cannot overflow a terminal of that many columns. The invariants,
 * held at every width including the degenerate ones: the result's display width never exceeds
 * `width`; text that fits is returned unchanged; and a cut never splits a surrogate pair,
 * because cuts land on code-point boundaries and a wide character that cannot fit is dropped
 * whole. Widths ≤ 1 leave no room for an ellipsis, so they clip bare — a leading run of
 * single-column characters up to the budget, possibly nothing when the text opens with a wide
 * character. A non-positive width fits nothing and yields the empty string. Shared by the
 * status table (status-render.ts) and the backlog pane's entry body (tui-backlog.ts). */
export function clipToWidth(text: string, width: number): string {
  if (width <= 0) return ""; // A non-positive width fits nothing.
  if (displayWidth(text) <= width) return text;
  const clip = (budget: number): string => {
    let total = 0;
    let end = 0;
    for (const ch of text) {
      const w = codePointWidth(ch.codePointAt(0)!);
      if (total + w > budget) break; // Cut on a code-point boundary — never mid-surrogate-pair.
      total += w;
      end += ch.length;
    }
    return text.slice(0, end);
  };
  if (width <= 1) return clip(width); // No room for an ellipsis at degenerate widths.
  return `${clip(width - 1)}…`; // The ellipsis itself takes one column.
}
