import { clipToWidth } from "../text.js";

/** Pure project-status pane logic for the TUI (src/ui/tui.ts): the three-section backlog body
 * (`backlogLines`) and the entry browser — selection movement and the entry body's scroll
 * window. Split out of tui-input.ts — which keeps the prompt line editor and the terminal
 * guard — because the pane renders and navigates the project backlog (plans/bugs/questions), a
 * self-contained concern sharing no line-editor or key-handling state. Pure, so it is
 * unit-testable without a TTY. */

/** The project-status body lines for the TUI: a `plans (N):` subheader with one line per plan,
 * an `open bugs (M):` subheader and one line per bug, then an `open questions (K):` subheader
 * and one line per question. An empty section renders `(none)` under its subheader; when all
 * three are empty the whole view is a single self-explanatory line.
 * Pure, so it is unit-testable without touching disk. */
export function backlogLines(plans: string[], bugs: string[], questions: string[]): string[] {
  if (plans.length === 0 && bugs.length === 0 && questions.length === 0)
    return ["(no planned features, open bugs, or open questions)"];
  const lines = [`plans (${plans.length}):`];
  lines.push(...(plans.length ? plans : ["(none)"]));
  lines.push(`open bugs (${bugs.length}):`);
  lines.push(...(bugs.length ? bugs : ["(none)"]));
  lines.push(`open questions (${questions.length}):`);
  lines.push(...(questions.length ? questions : ["(none)"]));
  return lines;
}

/** Move the project-status entry selection one step in `dir` across the flat entry list
 * (plans, then bugs, then questions), wrapping at both ends. A null cursor means "list mode":
 * the first down opens the first entry and the first up opens the last; with no entries there
 * is nothing to select (a stale selection clears too). Pure, so it is unit-testable without a
 * TTY — runTui feeds it the three sections' lengths. */
export function moveEntrySelection(
  count: number,
  selected: number | null,
  dir: "up" | "down",
): number | null {
  if (count <= 0) return null;
  if (selected === null) return dir === "down" ? 0 : count - 1;
  return dir === "down" ? (selected + 1) % count : (selected - 1 + count) % count;
}

/** The visible window of one backlog entry's body for the TUI pane: lines `offset` through
 * `offset + budget`, each clipped to `width`. At offset 0 this is today's head-keeping view —
 * a plan's goal comes first, like the list view. The offset is clamped at render time so a
 * terminal resize or a queued-prompt budget shrink cannot strand the window past either end.
 * Returns the clipped lines plus the body's total line count (so the caller can decide the
 * scroll affordance without re-splitting). An empty body (a bare heading) renders a single
 * self-explanatory placeholder and reports zero lines. Pure, so it is unit-testable without
 * a TTY. */
export function entryBodyWindow(
  body: string,
  offset: number,
  budget: number,
  width: number,
): { lines: string[]; total: number } {
  if (!body) return { lines: ["(no details for this entry)"], total: 0 };
  const all = body.split("\n");
  const start = Math.max(0, Math.min(offset, Math.max(0, all.length - budget)));
  return {
    lines: all.slice(start, start + Math.max(1, budget)).map((l) => clipToWidth(l, width)),
    total: all.length,
  };
}

/** Step the within-body scroll offset one page in `dir` (PgDn = "down", PgUp = "up"),
 * clamped to `[0, max(0, totalLines − budget)]`. A body that fits its budget has a single
 * window — every step is a no-op at the head. Pure, so it is unit-testable without a TTY. */
export function stepEntryScroll(
  offset: number,
  totalLines: number,
  budget: number,
  dir: "up" | "down",
): number {
  const maxOffset = Math.max(0, totalLines - budget);
  if (maxOffset === 0) return 0;
  const next = dir === "down" ? offset + budget : offset - budget;
  return Math.max(0, Math.min(maxOffset, next));
}
