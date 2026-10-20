/** The ink component tree that draws `tumwater tui`'s frame. Pure drawing: it takes the
 * frame tui.tsx's render step assembles — the same clipped StatusLines the tui-frame.ts
 * builders produce — and lays one line out per row, one styled Text per span. Ink
 * diff-renders the tree, so a changed cell rewrites only that cell's lines instead of
 * clearing the screen (the flicker BUGS.md recorded is gone); key handling lives in the
 * useTuiKeys hook below, which wraps ink's `useInput` and dispatches through the extracted
 * handler (tui-keys.ts).
 */
import { Box, Text, useInput } from "ink";
import type { StatusLine, StatusSpan } from "../status-render.js";
import { inkKeyToReadline } from "./tui-keymap.js";
import type { TuiKeys } from "./tui-keys.js";

/** A span tone's ink color: dim reads as gray, bold as bright white, and the brand mark as
 * bright cyan — the same hues the pre-ink ANSI painter used for the same tones. */
const TONE_COLORS: Record<NonNullable<StatusSpan["tone"]>, string> = {
  blue: "blue",
  red: "red",
  yellow: "yellow",
  green: "green",
  cyan: "cyan",
  magenta: "magenta",
  dim: "gray",
  bold: "whiteBright",
  brand: "cyanBright",
};

/** The ink color name a span tone paints with (empty string = the terminal's default). */
export function toneColor(tone: StatusSpan["tone"]): string {
  return tone ? TONE_COLORS[tone] : "";
}

/** One composed frame: the ordered lines tui.tsx's render step assembles, already clipped
 * to the terminal width. An empty line draws as a blank row. */
export interface TuiAppView {
  lines: readonly StatusLine[];
}

/** The TUI's key bridge: ink's `useInput` parses the stdin the render was given, and this
 * hook maps each parsed (input, key) pair to the readline shape the extracted handler (the
 * TuiKeys factory tui.tsx creates) consumes. Mounted inside the component tree so ink's
 * stdin context owns raw mode and the input stream for the TUI's whole lifetime. */
export function useTuiKeys(keys: TuiKeys): void {
  useInput((input, inkKey) => {
    const mapped = inkKeyToReadline(input, inkKey);
    keys.handleKey(mapped.str, mapped.key);
  });
}

/** The frame's component tree: a column of lines, each line's spans inline. A span with no
 * tone (or a NO_COLOR run) takes the terminal's default color. */
export function TuiApp({
  view,
  noColor,
  keys,
}: {
  view: TuiAppView;
  noColor: boolean;
  keys: TuiKeys;
}) {
  useTuiKeys(keys);
  return (
    <Box flexDirection="column">
      {view.lines.map((line, i) =>
        line.length === 0 ? (
          <Text key={i}> </Text>
        ) : (
          <Text key={i}>
            {line.map((sp, j) => (
              <Text key={j} color={noColor ? undefined : toneColor(sp.tone)}>
                {sp.text}
              </Text>
            ))}
          </Text>
        ),
      )}
    </Box>
  );
}
