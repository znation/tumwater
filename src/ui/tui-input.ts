import { cutSplitsSurrogatePair } from "../text.js";
import { displayWidth } from "../text-width.js";

/** Pure prompt-line editing for the TUI (src/ui/tui.tsx): the line editor, its display window,
 * the daily-budget input parser, and the terminal guard message runTui throws at startup.
 * Split out of tui.tsx — which keeps the terminal lifecycle, rendering, and input dispatch —
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

/** Clamp a cursor into `text` and snap a cursor that sits between a surrogate pair's halves
 * to the pair's start — the single home of the edit-cursor invariant both applyKey and
 * inputViewWindow enforce, so no edit or window ever anchors inside a pair (which an edit
 * would cut in half, leaving a lone surrogate the terminal renders as garbage). */
function snapCursor(text: string, cursor: number): number {
  const clamp = Math.max(0, Math.min(cursor, text.length));
  return cutSplitsSurrogatePair(text, clamp) ? clamp - 1 : clamp;
}

/** The character immediately before index `i`, as its whole [start, i) span: a surrogate
 * pair is never split, so the backward word-scan killWordBefore runs on always steps a
 * whole character and its boundary lands where a cut is safe. Null at the text's start. */
function prevChar(text: string, i: number): { start: number; ch: string } | null {
  if (i <= 0) return null;
  const start = cutSplitsSurrogatePair(text, i - 1) ? i - 2 : i - 1;
  return { start, ch: text.slice(start, i) };
}

/** Backward word kill (readline's unix-word-rubout, Alt+Backspace): whitespace immediately
 * before the cursor goes first, then the non-whitespace token that precedes it — on
 * "configure the  loop" it kills "  loop", leaving "configure the". The whitespace-first
 * skip is what makes a second press eat the separator between tokens, so repeated presses
 * peel words off one at a time instead of doing nothing on the spaces between them.
 * Boundaries come from prevChar, so an astral token is killed whole. */
function killWordBefore(text: string, c: number): { text: string; cursor: number } {
  let i = c;
  for (let p = prevChar(text, i); p !== null && /\s/.test(p.ch); p = prevChar(text, i)) i = p.start;
  for (let p = prevChar(text, i); p !== null && !/\s/.test(p.ch); p = prevChar(text, i)) i = p.start;
  return { text: text.slice(0, i) + text.slice(c), cursor: i };
}

/** Apply one keypress to the prompt text (pure, so it is unit-testable without a TTY).
 * Printable characters insert at the cursor — including multi-character strings readline
 * delivers for IME-composed input, which advance the cursor by their full length; backspace
 * deletes before it, delete after it, left/right move it, and home/end jump to the text's
 * start/end (the readline navigation an operator expects while editing a long prompt).
 * Three readline kill keys work too: Alt+Backspace kills the word before the cursor,
 * Ctrl+U kills from the line start to it, and Ctrl+K kills from it to the line end —
 * the two directions of half-line discard (a long prompt often wants one, the other, or
 * both: type the tail, Ctrl+U it away, retype). Every other control/meta combination is
 * ignored — Ctrl+W cannot join the kill set because the TUI's transcript views already
 * bind it to per-loop wake (tui.tsx). Returns the new state; an out-of-range cursor is
 * clamped instead of corrupting the edit. Backspace/delete remove a whole character: when the unit they would cut is one
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
  const c = snapCursor(text, cursor);
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
      if (key.meta) return killWordBefore(text, c); // Alt+Backspace: kill the previous word
      if (c === 0) return { text, cursor: 0 };
      // The character before the cursor is a surrogate pair [c-2, c-1]: delete both units.
      if (cutSplitsSurrogatePair(text, c - 1)) {
        return { text: text.slice(0, c - 2) + text.slice(c), cursor: c - 2 };
      }
      return { text: text.slice(0, c - 1) + text.slice(c), cursor: c - 1 };
    case "home":
      return { text, cursor: 0 };
    case "end":
      return { text, cursor: text.length };
    case "u":
      // Ctrl+U (readline's unix-line-discard) kills from the line start to the cursor; a
      // plain "u" breaks here and reaches the printable insert branch below, unchanged.
      if (key.ctrl) return { text: text.slice(c), cursor: 0 };
      break;
    case "k":
      // Ctrl+K (readline's kill-line) kills from the cursor to the line end; a plain "k"
      // breaks here and reaches the printable insert branch below, unchanged.
      if (key.ctrl) return { text: text.slice(0, c), cursor: c };
      break;
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
  // surfaces share one rule. The MAX_SAFE_INTEGER bound is the same overflow rule text.ts's
  // parseDecimalInt applies to every count/position input: a 25-digit run stays finite (1e24)
  // yet is no longer an exactly representable dollar amount, and checkDailyBudgetUsd (the
  // setter's own screen) admits any finite non-negative number — without this bound a
  // one-zero typo silently writes an effectively uncapped budget.
  if (!/^\d*\.?\d+$/.test(t))
    return { ok: false, error: `budget must be a number of 0 or more (got ${JSON.stringify(text)})` };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER)
    return { ok: false, error: `budget must be a number of 0 or more (got ${JSON.stringify(text)})` };
  return { ok: true, value: n };
}

/** Parse the TUI's Ctrl+R role-prompt line: the trimmed text when non-empty, otherwise an
 * error so the flash can show it and the editor stays open for a fix — whitespace-only input
 * queues nothing, exactly like the director prompt line's Enter rule, and the error names Esc
 * so an operator who opened the editor by accident learns the way out. Pure, like
 * parseBudgetInput; the submit path itself (the shared submitRolePromptAndWake, wired to
 * the editor by tui.tsx) lives with the other disk-writing handlers. */
export function parseRolePromptInput(
  text: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const t = text.trim();
  if (!t) return { ok: false, error: "prompt text is empty — type something, or Esc to cancel" };
  return { ok: true, value: t };
}

/** The prompt line's session history: every successfully submitted prompt (director and
 * per-role alike — one list, like a shell's), recallable with Up/Down the way readline does
 * it. Pure state, so the recall rules are unit-testable without a TTY; tui.tsx owns pushing
 * on submit and wiring the arrow keys, this file owns the rules.
 *
 * Readline's two habits are kept: consecutive duplicates are not recorded twice (ignoredups
 * — re-sending the same nudge does not fill the history with copies), and the draft the
 * operator was typing when the first Up fired is saved and restored when Down walks back
 * past the newest entry, so history browsing never costs the unfinished line. */
export interface PromptHistory {
  /** Submitted prompts, oldest first. */
  items: string[];
  /** Where recall sits: `items.length` means the live draft (not browsing history). */
  index: number;
  /** The draft saved when the first Up left the live line; restored on Down past the end. */
  draft: string;
  /** Where the draft's cursor sat when the first Up fired, restored with the draft. */
  draftCursor: number;
}

export function newPromptHistory(): PromptHistory {
  return { items: [], index: 0, draft: "", draftCursor: 0 };
}

/** Record one submitted prompt and return to the live-draft state. Pure: the input state is
 * untouched, the next state is returned. An empty prompt records nothing — it queues nothing
 * either — and a repeat of the newest entry only resets the recall position. */
export function pushPromptHistory(h: PromptHistory, text: string): PromptHistory {
  const items = text !== "" && h.items[h.items.length - 1] !== text ? [...h.items, text] : h.items;
  return { items, index: items.length, draft: "", draftCursor: 0 };
}

/** One step through the history: `older` (Up) walks back from the live line or the current
 * entry, `newer` (Down) walks forward and — past the newest entry — restores the saved
 * draft. Null when the step does nothing: an empty history, or Down while already on the
 * live draft. The recalled cursor lands at the text's end, where a submit or an edit-over
 * begins. Pure, like applyKey. */
export function recallPromptHistory(
  h: PromptHistory,
  current: string,
  cursor: number,
  dir: "older" | "newer",
): { history: PromptHistory; text: string; cursor: number } | null {
  if (dir === "older") {
    if (h.items.length === 0) return null;
    const browsing = h.index < h.items.length;
    const index = browsing ? Math.max(0, h.index - 1) : h.items.length - 1;
    const text = h.items[index]!;
    return {
      history: browsing
        ? { items: h.items, index, draft: h.draft, draftCursor: h.draftCursor }
        : { items: h.items, index, draft: current, draftCursor: cursor },
      text,
      cursor: text.length,
    };
  }
  if (h.index >= h.items.length) return null; // already on the live draft
  const index = h.index + 1;
  if (index < h.items.length) {
    const text = h.items[index]!;
    return {
      history: { items: h.items, index, draft: h.draft, draftCursor: h.draftCursor },
      text,
      cursor: text.length,
    };
  }
  // Back past the newest entry: the saved draft returns, cursor and all, and browsing ends.
  return {
    history: { items: h.items, index, draft: "", draftCursor: 0 },
    text: h.draft,
    cursor: h.draftCursor,
  };
}

/** Hand the prompt line over to another editor (role-prompt or budget mode) mid-recall: if
 * history browsing is in flight, the recalled entry on the line is swapped back for the
 * draft the arrows saved — with its cursor — and the recall state resets, so the other
 * editor saves the text the operator was actually writing and no stale index or draft
 * survives the switch. Not browsing: nothing changes, the same history comes back. Pure. */
export function settlePromptRecall(
  h: PromptHistory,
  current: string,
  cursor: number,
): { history: PromptHistory; text: string; cursor: number } {
  if (h.index >= h.items.length) return { history: h, text: current, cursor };
  return {
    history: { items: h.items, index: h.items.length, draft: "", draftCursor: 0 },
    text: h.draft,
    cursor: h.draftCursor,
  };
}

/** Put the history back to the live-draft state after a mode switch restored a saved draft:
 * the restored line is the draft now, so the next Up saves it afresh instead of resuming a
 * stale browse (whose saved draft could belong to the other editor's line). Pure. */
export function resetPromptRecall(h: PromptHistory): PromptHistory {
  return { items: h.items, index: h.items.length, draft: "", draftCursor: 0 };
}

/** The visible slice of the prompt line for a terminal `width` columns: the whole text
 * when it fits, otherwise a non-empty window that keeps the cursor inside it (at or near
 * the right edge) so mid-text edits stay visible. Widths are measured in terminal display
 * columns (displayWidth), not UTF-16 code units: a CJK character is one code unit but two
 * columns, and a unit-budgeted line rendered wider than the terminal and wrapped. Both
 * window edges fall on character boundaries, so the displayed line never carries a lone
 * surrogate (terminals render it as garbage) — the display-side sibling of the edit-side
 * rule applyKey enforces. With the "> " prefix the rendered line never exceeds `width`
 * columns for width >= 4, preserving the one-logical-line-per-visual-line invariant.
 */
export function renderInputView(text: string, cursor: number, width: number): string {
  const room = Math.max(1, width - 3); // headroom for the "> " prefix and a leading ellipsis
  // The whole prompt fits beside the two-column prefix: show it all — the one column of
  // slack over `room` is free when no ellipsis is spent, and hiding fit-able text behind a
  // window would only make the edit point harder to see in context.
  if (displayWidth(text) <= width - 2) return text;
  const { start, end } = inputViewWindow(text, cursor, room);
  const slice = text.slice(start, end);
  const withEllipsis = start > 0 ? `…${slice}` : slice;
  // Degenerate narrow case: at room 1–2 a wide character at the cursor needs one column
  // more than `room` (inputViewWindow's whole-character fallback), so the ellipsis no longer
  // fits beside it. The "> " prefix already fixes the line's floor at `width` - 2 columns,
  // so spending one more would wrap the prompt line; drop the truncation cue instead, since
  // showing the character being edited matters more than signalling clipped text.
  return displayWidth(withEllipsis) <= width - 2 ? withEllipsis : slice;
}

/** The code-unit window `[start, end)` renderInputView shows for a prompt line wider than
 * its `room` display columns. The budget is spent in terminal display columns — each
 * character costs its displayWidth, so a CJK character costs two and astral pairs are never
 * measured as halves — while the returned window stays in UTF-16 code units so text.slice
 * keeps working unchanged. The cursor is clamped into the text and snapped to the start of
 * any surrogate pair it lands inside, then the window is placed with the cursor's character
 * at its right edge (or anchored at the text's start, filled rightward, when the cursor is
 * near the beginning). The window contains the cursor, so the edit point is always visible.
 * When the character under the cursor alone is wider than `room` (a wide character at room
 * 1), no fitting window exists — the smallest whole-character window around the cursor (the
 * character it sits on, or the one before it at end of text) is returned instead; it may
 * exceed `room` by one column, and renderInputView drops the ellipsis when it no longer
 * both fit. Pure, so it is unit-testable without a TTY. */
export function inputViewWindow(
  text: string,
  cursor: number,
  room: number,
): { start: number; end: number } {
  const c = snapCursor(text, cursor);
  // Per-character decomposition: where each code point starts (in units) and how many
  // terminal columns it renders as. The cursor is always on a character boundary (applyKey
  // snaps mid-pair cursors; BMP characters are one unit each), so it names a character.
  const chars = Array.from(text);
  const n = chars.length;
  const starts: number[] = [];
  let units = 0;
  for (const ch of chars) {
    starts.push(units);
    units += ch.length;
  }
  const prefix: number[] = [0]; // prefix[k] = display columns before character k
  for (let k = 0; k < n; k++) prefix.push(prefix[k]! + displayWidth(chars[k]!));
  // The character the cursor sits on; past the last character it is a virtual end marker.
  let ci = n;
  for (let k = 0; k < n; k++) {
    if (starts[k]! <= c && c < starts[k]! + chars[k]!.length) {
      ci = k;
      break;
    }
  }
  // Window ending at the cursor's character, extended left while the column budget holds
  // (cursor at the right edge); anchored at the text's start instead when the cursor is
  // near the beginning, then filled rightward up to the budget.
  const cursorEnd = Math.min(n, ci + 1);
  let startCp = cursorEnd;
  while (startCp > 0 && prefix[cursorEnd]! - prefix[startCp - 1]! <= room) startCp--;
  let endCp = cursorEnd;
  if (startCp === 0 && endCp < n) {
    while (endCp < n && prefix[endCp + 1]! - prefix[0]! <= room) endCp++;
  }
  let start = startCp < n ? starts[startCp]! : units;
  let end = endCp < n ? starts[endCp]! : units;
  if (end <= start && n > 0) {
    // The character under the cursor alone exceeds the budget: show that whole character
    // (two columns when wide), or the whole character before it at end of text.
    const k = ci < n ? ci : n - 1;
    start = starts[k]!;
    end = starts[k]! + chars[k]!.length;
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
