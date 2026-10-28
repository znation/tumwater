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

/** The flag-named keys in their chain order, each an ink flag and the readline name it maps
 * to — the ordered table the inkKeyToReadline chain used to hand-roll as a flat if-chain.
 * Named keys win first (ink sets `ctrl` alongside arrows too). */
const NAMED_KEYS: ReadonlyArray<readonly [keyof InkKey, string]> = [
  ["delete", "delete"],
  ["tab", "tab"],
  ["upArrow", "up"],
  ["downArrow", "down"],
  ["leftArrow", "left"],
  ["rightArrow", "right"],
  ["pageUp", "pageup"],
  ["pageDown", "pagedown"],
  ["home", "home"],
  ["end", "end"],
];

/** The name a flag-named key maps to — the backspace/backspace+meta pair first, then the
 * NAMED_KEYS table scan (an arrow that also carries `ctrl` still returns the arrow name,
 * because this runs before controlKey). undefined when no named-key flag matches. */
function namedKeyName(
  key: InkKey,
): { name: string; meta?: boolean } | undefined {
  if (key.backspace) {
    return key.meta ? { name: "backspace", meta: true } : { name: "backspace" };
  }
  for (const [flag, name] of NAMED_KEYS) {
    if (key[flag]) return { name };
  }
  return undefined;
}

/** The modifier-chord shape a Ctrl/Alt key maps to, or undefined when neither matches — the
 * Ctrl branch (readline `ctrl: true` plus the bare lowercased letter from `input`), then the
 * Alt single-char branch (`meta: true` plus the lowercased `input`). */
function controlKey(
  input: string,
  key: InkKey,
): { ctrl?: boolean; meta?: boolean; name?: string } | undefined {
  if (key.ctrl) return { ctrl: true, name: input.toLowerCase() };
  if (key.meta && input.length === 1) {
    return { meta: true, name: input.toLowerCase() };
  }
  return undefined;
}

/** The printable/empty fallback: text with no key flags flows through as `str`, and an empty
 * non-key input (ink suppresses text for unrecognized sequences) is inert (str undefined). */
function printableKey(input: string): { str: string | undefined; key: {} } {
  return { str: input || undefined, key: {} };
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
  const named = namedKeyName(key);
  if (named) return { str: undefined, key: named };
  const chord = controlKey(input, key);
  if (chord) return { str: undefined, key: chord };
  return printableKey(input);
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
