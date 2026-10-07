/** The ink→readline key-mapping layer of the TUI (extracted from tui-keys.ts): ink's
 * `useInput` delivers parsed (input, key) pairs, while the keypress dispatch in
 * tui-keys.ts's createTuiKeys consumes the readline (str, key) shape — this module mints
 * those names and classifies the vertical directions the dispatch branches steer by. Pure,
 * so every mapping is unit-testable without ink mounted. */

/** The fields of ink's parsed key object (useInput's second argument) the adapter maps
 * from — a plain-object subset, so tests can build keys without ink mounted. Inferred in
 * the exported signature via Parameters<typeof inkKeyToReadline>[1]. */
interface InkKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/** Map one ink `useInput` (input, key) pair to the shape handleKey consumes — ink's parsed
 * flags and input text become the readline (str, key) pair the 2a dispatch was extracted
 * with. Pure, so the mapping is unit-testable without ink mounted. Named keys win first
 * (ink sets `ctrl` alongside arrows too); Ctrl+letter arrives as the bare letter in `input`
 * with `ctrl` set, and Alt+Backspace as the backspace flag with `meta`; anything else is
 * printable text — including whole composed strings, which flow through as one `str`. */
export function inkKeyToReadline(
  input: string,
  key: InkKey,
): { str: string | undefined; key: { ctrl?: boolean; meta?: boolean; name?: string } } {
  if (key.escape) return { str: undefined, key: { name: "escape" } };
  if (key.return) return { str: undefined, key: { name: "return" } };
  if (key.backspace) {
    return { str: undefined, key: key.meta ? { name: "backspace", meta: true } : { name: "backspace" } };
  }
  if (key.delete) return { str: undefined, key: { name: "delete" } };
  if (key.tab) return { str: undefined, key: { name: "tab" } };
  if (key.upArrow) return { str: undefined, key: { name: "up" } };
  if (key.downArrow) return { str: undefined, key: { name: "down" } };
  if (key.leftArrow) return { str: undefined, key: { name: "left" } };
  if (key.rightArrow) return { str: undefined, key: { name: "right" } };
  if (key.pageUp) return { str: undefined, key: { name: "pageup" } };
  if (key.pageDown) return { str: undefined, key: { name: "pagedown" } };
  if (key.home) return { str: undefined, key: { name: "home" } };
  if (key.end) return { str: undefined, key: { name: "end" } };
  if (key.ctrl) return { str: undefined, key: { ctrl: true, name: input.toLowerCase() } };
  if (key.meta && input.length === 1) {
    return { str: undefined, key: { meta: true, name: input.toLowerCase() } };
  }
  return { str: input || undefined, key: {} };
}

/** The `"up" | "down"` direction an arrow key names — Up/Down only, so the branches that
 * reserve the arrows for one purpose (entry browse, history recall) reject the page keys —
 * null for anything else. Shared by handleKey's entry-browse and history-recall branches so
 * the key→direction mapping lives in one place beside inkKeyToReadline, which mints the
 * names. Pure, so it is unit-testable without a TTY. */
export function arrowDir(name: string | undefined): "up" | "down" | null {
  if (name === "up") return "up";
  if (name === "down") return "down";
  return null;
}

/** The `"up" | "down"` direction a page key names — PgUp walks up, PgDn walks down, the
 * inversion handleKey's two pane-scroll branches used to hand-roll inline (a `pagedown ?
 * "down" : "up"` ternary at each) — null for anything else. Pure, so it is unit-testable
 * without a TTY. */
export function pageDir(name: string | undefined): "up" | "down" | null {
  if (name === "pageup") return "up";
  if (name === "pagedown") return "down";
  return null;
}
