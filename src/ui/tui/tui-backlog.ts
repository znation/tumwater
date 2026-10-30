import {
  answeredQuestionEntries,
  donePlanEntries,
  entryMatches,
  fixedBugEntries,
  openBugEntries,
  openQuestionEntries,
  plannedPlanEntries,
  type BacklogEntry,
} from "../../backlog/backlog.js";
import {
  backlogHolds,
  backlogInProgress,
  backlogMarks,
  type EntryHold,
} from "../../backlog/backlog-eligibility.js";
import { groupBlockedSeries, partsLabel } from "../../backlog/backlog-index-data.js";
import { clipToWidth } from "../../text/text-width.js";
import { DASHBOARD_ANSWERED_QUESTIONS, DASHBOARD_RECENT_FINISHED } from "../status-payload.js";

/** Pure project-status pane logic for the TUI (src/ui/tui/tui.tsx): the three-section backlog body
 * (`backlogLines`) and the entry browser — selection movement and the entry body's scroll
 * window. Split out of tui-input.ts — which keeps the prompt line editor and the terminal
 * guard — because the pane renders and navigates the project backlog (plans/bugs/questions), a
 * self-contained concern sharing no line-editor or key-handling state. Pure, so it is
 * unit-testable without a TTY. */

/** The project-status pane's flat entry list (plans, then bugs, then questions), each labeled
 * with its section and carrying its eligibility mark (empty for an eligible entry) plus the
 * hold and live claimer that mark was built from (questions: null and undefined), read fresh
 * — the one definition shared by the keypress handlers and the render (src/ui/tui/tui-keys.ts,
 * src/ui/tui/tui-pane.ts), so stale-selection clamping cannot drift. */
export function labeledBacklogEntries(
  root: string,
): Array<{ label: string; mark: string; hold: EntryHold; claimer: string | undefined } & BacklogEntry> {
  const runners = backlogInProgress(root);
  const marks = backlogMarks(root, runners);
  const holds = backlogHolds(root);
  return [
    ...plannedPlanEntries(root).map((e, i) => ({
      label: "plan",
      mark: marks.plans[i] ?? "",
      hold: holds.plans[i] ?? null,
      claimer: runners.plans[i] ?? undefined,
      ...e,
    })),
    ...openBugEntries(root).map((e, i) => ({
      label: "bug",
      mark: marks.bugs[i] ?? "",
      hold: holds.bugs[i] ?? null,
      claimer: runners.bugs[i] ?? undefined,
      ...e,
    })),
    ...openQuestionEntries(root).map((e) => ({
      label: "question",
      mark: "",
      hold: null,
      claimer: undefined,
      ...e,
    })),
  ];
}

/** The entries up/down browse in the project-status pane, in the list's visual order: the open
 * entries (`labeledBacklogEntries`), then the newest answered questions, done plans and fixed
 * bugs the list shows under "answered recently" / "done recently" / "fixed recently". Answered,
 * done and fixed rows are read-only: no edit key acts on them, and the open entries keep their
 * indexes. */
export function browsableBacklogEntries(root: string): ReturnType<typeof labeledBacklogEntries> {
  const finished = (label: string, entries: BacklogEntry[], count = DASHBOARD_RECENT_FINISHED) =>
    entries.slice(0, count).map((e) => ({
      label,
      mark: "",
      hold: null,
      claimer: undefined,
      ...e,
    }));
  return [
    ...labeledBacklogEntries(root),
    ...finished("answered", answeredQuestionEntries(root).reverse(), DASHBOARD_ANSWERED_QUESTIONS),
    ...finished("done", donePlanEntries(root)),
    ...finished("fixed", fixedBugEntries(root)),
  ];
}

/** The plan section's list lines: each row is its title plus mark, except a series' blocked
 * parts (two or more), which become one `<series>, N blocked parts (…)` line at the first
 * part — the text `plan --list` prints (groupBlockedSeries). Pure. */
export function planListLines(
  plans: ReadonlyArray<{ title: string; mark: string; hold: EntryHold; claimer: string | undefined }>,
): string[] {
  return groupBlockedSeries(plans).map((g) =>
    g.kind === "row"
      ? g.row.title + g.row.mark
      : `${g.series}, ${g.rows.length} blocked parts (${partsLabel(g.rows)}) [blocked: each waits on an earlier part]`,
  );
}

/** The project-status body lines for the TUI: a `plans (N):` subheader with one line per plan,
 * an `open bugs (M):` subheader and one line per bug, then an `open questions (K):` subheader
 * and one line per question. `planCount` is the number of planned entries when `plans` holds
 * collapsed series lines. An empty section renders `(none)` under its subheader; when all
 * three are empty and `answered` is too, the whole view is a single self-explanatory line.
 * A non-empty `answered` (the newest answered questions, one preformatted line each) adds an
 * `answered recently (K):` section; non-empty `finished.done` and `finished.fixed` (preformatted
 * lines too) then add `done recently (N):` and `fixed recently (N):`. An empty list adds nothing,
 * not even `(none)`, and the single-line view needs all of them empty.
 * Pure, so it is unit-testable without touching disk. */
export function backlogLines(
  plans: string[],
  bugs: string[],
  questions: string[],
  planCount: number = plans.length,
  answered: string[] = [],
  finished: { done?: string[]; fixed?: string[] } = {},
): string[] {
  const done = finished.done ?? [];
  const fixed = finished.fixed ?? [];
  if (plans.length + bugs.length + questions.length + answered.length + done.length + fixed.length === 0)
    return ["(no planned features, open bugs, or open questions)"];
  const lines = [`plans (${planCount}):`];
  lines.push(...(plans.length ? plans : ["(none)"]));
  lines.push(`open bugs (${bugs.length}):`);
  lines.push(...(bugs.length ? bugs : ["(none)"]));
  lines.push(`open questions (${questions.length}):`);
  lines.push(...(questions.length ? questions : ["(none)"]));
  if (answered.length) lines.push(`answered recently (${answered.length}):`, ...answered);
  if (done.length) lines.push(`done recently (${done.length}):`, ...done);
  if (fixed.length) lines.push(`fixed recently (${fixed.length}):`, ...fixed);
  return lines;
}

/** The project-status pane's open-entry labels — plans, bugs and questions — the labels a `/`
 * text search can select. The answered/done/fixed rows the pane shows are read-only and are
 * hidden while a search is applied. Pure. */
export function isOpenBacklogLabel(label: string): boolean {
  return label === "plan" || label === "bug" || label === "question";
}

/** The flat entries a `/` text search keeps visible: with no pattern, every open entry's index
 * (label plan, bug or question); with a pattern, only the open entries whose heading or body
 * matches it case-insensitively (the exported entryMatches, the same rule the finished-entry
 * listings use). When `readyOnly` is true it keeps only the open entries no hold keeps from
 * being picked (`hold === null`; questions and the answered/done/fixed rows carry null and so
 * stay), the terminal twin of `tumwater backlog --ready`; `/` composes with it. It never
 * returns an answered/done/fixed index. Pure, so it is unit-testable without a TTY — the pane
 * calls it before moveEntrySelection so up/down step within the matching indexes. */
export function visibleBacklogIndexes(
  entries: ReadonlyArray<{ label: string; hold?: EntryHold | null } & BacklogEntry>,
  pattern: string | null,
  readyOnly = false,
): number[] {
  const open = (e: { label: string }): boolean => isOpenBacklogLabel(e.label);
  const out: number[] = [];
  entries.forEach((e, i) => {
    if (open(e) && (pattern === null || entryMatches(e, pattern)) && (!readyOnly || e.hold === null || e.hold === undefined)) out.push(i);
  });
  return out;
}

/** Move the project-status entry selection one step in `dir` across the flat entry list
 * (plans, then bugs, then questions), wrapping at both ends. A null cursor means "list mode":
 * the first down opens the first entry and the first up opens the last; with no entries there
 * is nothing to select (a stale selection clears too). An optional `visible` list (the `/`
 * search's matching indexes, ascending) restricts the steps to those entries and wraps at that
 * list's ends, returning an unfiltered index into the full flat list; a stale selection
 * outside `visible` restarts at its first (down) or last (up) match, and an empty list returns
 * null. The two-argument callers (and their behavior) are unchanged. Pure, so it is
 * unit-testable without a TTY — runTui feeds it the three sections' lengths. */
export function moveEntrySelection(
  count: number,
  selected: number | null,
  dir: "up" | "down",
  visible?: ReadonlyArray<number>,
): number | null {
  if (count <= 0) return null;
  if (visible === undefined) {
    if (selected === null) return dir === "down" ? 0 : count - 1;
    // A stale index past the new count (the backlog shrank between renders) clamps to the
    // last entry first, so the wrap moves from where the pane actually shows the selection —
    // (selected + 1) % count on an unclamped stale index lands on an arbitrary entry (BUGS.md
    // 2026-10-02 latent-bug hunt over tui-backlog's extraction).
    const sel = Math.min(selected, count - 1);
    return dir === "down" ? (sel + 1) % count : (sel - 1 + count) % count;
  }
  // Filtered (search) selection: step within the matching indexes and wrap at their ends. A
  // null cursor or a stale selection outside the matches restarts at the first (down) or last
  // (up) match; an empty match list has nothing to select.
  if (visible.length === 0) return null;
  if (selected === null) return dir === "down" ? visible[0]! : visible[visible.length - 1]!;
  const pos = visible.indexOf(selected);
  if (pos === -1) return dir === "down" ? visible[0]! : visible[visible.length - 1]!;
  return dir === "down" ? visible[(pos + 1) % visible.length]! : visible[(pos - 1 + visible.length) % visible.length]!;
}

/** The visible window of one backlog entry's body for the TUI pane: `budget` lines starting at
 * `offset` (at least one, even for a zero budget), each clipped to `width`. At offset 0 this is
 * today's head-keeping view —
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

/** Page a cached Markdown body by one screenful in `dir`, measuring its height as its line
 * count (an empty or missing body reads as zero lines) and clamping to `[0, lines − budget]`.
 * The within-body PgDn/PgUp step the Markdown panes share: the notes/change views, the
 * run-trail view, the Usage/Failures panes, and the backlog entry body each derive a cached
 * string's line count and page with it, so this is the one place that height is measured and
 * the step applied. Pure, so it is unit-testable without a TTY. */
export function pageMarkdownBody(
  offset: number,
  body: string | null | undefined,
  budget: number,
  dir: "up" | "down",
): number {
  return stepEntryScroll(offset, body ? body.split("\n").length : 0, budget, dir);
}
