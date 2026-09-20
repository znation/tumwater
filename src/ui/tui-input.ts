import { cutSplitsSurrogatePair } from "../text.js";

/** Pure prompt-line editing for the TUI (src/ui/tui.ts): the line editor, its display window,
 * the daily-budget input parser, and the terminal guard message runTui throws at startup.
 * Split out of tui.ts — which keeps the terminal lifecycle, rendering, and input dispatch —
 * so this TTY-free logic is testable in isolation and the run loop reads as orchestration
 * rather than string surgery. The project-status pane (its body lines, entry selection, and
 * scrolling) lives in tui-backlog.ts. */

/** The key fields applyKey cares about (a structural subset of readline.Key, so tests can
 * pass plain objects without a TTY). */
interface KeyLike {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

/** Apply one keypress to the prompt text (pure, so it is unit-testable without a TTY).
 * Printable characters insert at the cursor — including multi-character strings readline
 * delivers for IME-composed input, which advance the cursor by their full length; backspace
 * deletes before it, delete after it, and left/right move it. Control/meta combinations are
 * ignored. Returns the new state; an out-of-range cursor is clamped instead of corrupting
 * the edit. Backspace/delete remove a whole character: when the unit they would cut is one
 * half of a surrogate pair (an astral character such as emoji), both units go together so no
 * lone surrogate — which terminals render as garbage — is ever left behind (the same
 * surrogate-safe rule truncate in text.ts applies to display clipping). The cursor itself
 * only ever sits on a character boundary: a stale mid-pair cursor is snapped to the pair's
 * start, and left/right step over a whole astral character rather than into the middle of
 * its pair (which would otherwise let backspace/delete cut the pair in half). */
export function applyKey(
  text: string,
  cursor: number,
  str: string | undefined,
  key: KeyLike,
): { text: string; cursor: number } {
  const clamp = Math.max(0, Math.min(cursor, text.length));
  // Snap a cursor that sits between a pair's halves to the pair's start, so no edit can cut
  // the pair in half.
  const c = cutSplitsSurrogatePair(text, clamp) ? clamp - 1 : clamp;
  switch (key.name) {
    case "left": {
      const n = Math.max(0, c - 1);
      // A cut at n would land inside a pair: step over the whole astral character instead.
      return { text, cursor: cutSplitsSurrogatePair(text, n) ? n - 1 : n };
    }
    case "right": {
      const n = Math.min(text.length, c + 1);
      return { text, cursor: cutSplitsSurrogatePair(text, n) ? n + 1 : n };
    }
    case "backspace":
      if (c === 0) return { text, cursor: 0 };
      // The character before the cursor is a surrogate pair [c-2, c-1]: delete both units.
      if (cutSplitsSurrogatePair(text, c - 1)) {
        return { text: text.slice(0, c - 2) + text.slice(c), cursor: c - 2 };
      }
      return { text: text.slice(0, c - 1) + text.slice(c), cursor: c - 1 };
    case "delete":
      if (c >= text.length) return { text, cursor: c };
      // The character at the cursor is a surrogate pair [c, c+1]: delete both units.
      if (cutSplitsSurrogatePair(text, c + 1)) {
        return { text: text.slice(0, c) + text.slice(c + 2), cursor: c };
      }
      return { text: text.slice(0, c) + text.slice(c + 1), cursor: c };
  }
  if (str && !key.ctrl && !key.meta && str >= " ") {
    // str can hold a whole composed string (IME input arrives as one keypress); the cursor
    // must land after ALL of it, not one unit in.
    return { text: text.slice(0, c) + str + text.slice(c), cursor: c + str.length };
  }
  return { text, cursor: c };
}

/** Parse a daily cost budget cap from the TUI's Ctrl+B edit line: empty → 0 (disabled —
 * empty means "no cap" on save), otherwise a plain decimal number ≥ 0 with fractional
 * dollars allowed ("25", "12.34", ".5") — hex and exponent notation are rejected, so the
 * TUI admits exactly what the GUI's number input and the server check admit. Returns an
 * actionable error for invalid input so the flash can show it and the editor stays open
 * for a fix. Pure, like applyKey. */
export function parseBudgetInput(
  text: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const t = text.trim();
  if (t === "") return { ok: true, value: 0 };
  // Plain decimal dollars only — Number() would also read hex ("0x10" → 16) and finite
  // exponent notation ("1e2" → 100) as a cap, neither of which an operator means when typing
  // a USD amount; the GUI's number input + server check already admit plain decimals, so both
  // surfaces share one rule. The isFinite backstop catches absurd digit counts (→ Infinity).
  if (!/^\d*\.?\d+$/.test(t))
    return { ok: false, error: `budget must be a number of 0 or more (got ${JSON.stringify(text)})` };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0)
    return { ok: false, error: `budget must be a number of 0 or more (got ${JSON.stringify(text)})` };
  return { ok: true, value: n };
}

/** The visible slice of the prompt line for a terminal `width` columns: the whole text
 * when it fits, otherwise a non-empty window that keeps the cursor inside it (at or near
 * the right edge) so mid-text edits stay visible. Both window edges fall on character
 * boundaries, so the displayed line never carries a lone surrogate (terminals render it as
 * garbage) — the display-side sibling of the edit-side rule applyKey enforces. With the
 * "> " prefix the rendered line never exceeds `width` columns for width >= 4, preserving
 * the one-logical-line-per-visual-line invariant.
 */
export function renderInputView(text: string, cursor: number, width: number): string {
  const room = Math.max(1, width - 3); // headroom for the "> " prefix and a leading ellipsis
  if (text.length <= room) return text;
  const { start, end } = inputViewWindow(text, cursor, room);
  const slice = text.slice(start, end);
  const withEllipsis = start > 0 ? `…${slice}` : slice;
  // Degenerate narrow case: at room 1–2 an astral character at the cursor needs one unit
  // more than `room` (inputViewWindow's whole-character fallback), so the ellipsis no longer
  // fits beside it. The "> " prefix already fixes the line's floor at `width` - 2 columns,
  // so spending one more would wrap the prompt line; drop the truncation cue instead, since
  // showing the character being edited matters more than signalling clipped text.
  return withEllipsis.length <= width - 2 ? withEllipsis : slice;
}

/** The code-unit window `[start, end)` renderInputView shows for a prompt line longer than
 * `room` units. The cursor is clamped into the text and snapped to the start of any
 * surrogate pair it lands inside, then the window is placed with the cursor at its right
 * edge (or left of it when the cursor is near the start). An edge that would split a
 * surrogate pair is nudged to the nearest boundary: the start is floored over the pair only
 * when the wider window still fits (it lands at 0, where the ellipsis column is free),
 * otherwise stepped forward over the pair while the right edge stays anchored; the end is
 * backed off the pair. Either way the window contains the cursor (a cursor inside a pair is
 * first snapped to that pair's start), so the edit point is always visible. At room 1–2
 * around adjacent astral characters those two nudges can meet at the cursor and leave an
 * empty window — which renderInputView would draw as a bare ellipsis — so the smallest
 * whole-character window around the cursor (the character it sits on, or the one before it
 * at end of text) is returned instead; it may exceed `room` by one unit, and renderInputView
 * drops the ellipsis when the pair no longer both fit. Pure, so it is unit-testable without
 * a TTY. */
export function inputViewWindow(
  text: string,
  cursor: number,
  room: number,
): { start: number; end: number } {
  const clamp = Math.max(0, Math.min(cursor, text.length));
  const c = cutSplitsSurrogatePair(text, clamp) ? clamp - 1 : clamp;
  const start0 = Math.max(0, Math.min(c - (room - 1), text.length - room));
  let start = cutSplitsSurrogatePair(text, start0) ? (start0 === 1 ? 0 : start0 + 1) : start0;
  const end0 = Math.min(text.length, start0 + room);
  let end = cutSplitsSurrogatePair(text, end0) ? end0 - 1 : end0;
  if (end <= start && text.length > 0) {
    if (c < text.length) {
      // The cursor sits on a character: show that whole character (two units when astral).
      start = c;
      end = cutSplitsSurrogatePair(text, c + 1) ? c + 2 : c + 1;
    } else {
      // Cursor at end of text: show the whole character before it.
      end = c;
      start = cutSplitsSurrogatePair(text, c - 1) ? c - 2 : c - 1;
    }
  }
  return { start, end };
}

/** The runTui start guard's error message: names the missing stream — a piped stdin and a
 * redirected stdout are distinct failures (the former cannot take typed prompts, the latter
 * cannot display the dashboard), so `tumwater tui` in a script or a pipe fails with a
 * fixable diagnosis instead of a generic refusal — and points at the non-interactive
 * observers. Pure, so it is unit-testable without touching the process's own TTY flags. */
export function tuiTerminalError(stdinTty: boolean, stdoutTty: boolean): string {
  const which =
    !stdinTty && !stdoutTty
      ? "neither stdin (prompt input) nor stdout (the dashboard) is a TTY"
      : !stdinTty
        ? "stdin (prompt input) is not a TTY"
        : "stdout (the dashboard) is not a TTY";
  return `tumwater tui needs an interactive terminal: ${which} — use \`tumwater status\` or \`tumwater gui\` for a non-interactive view`;
}
