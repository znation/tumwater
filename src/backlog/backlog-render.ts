import type { BacklogEntry } from "./backlog-md.js";
import { entryMatches } from "./backlog.js";
import { groupBlockedSeries, partsLabel } from "./backlog-index-data.js";
import { holdMark, inProgressMark, type EntryHold } from "./backlog-eligibility.js";

/** The terminal's view of the project backlog — the same three open sections the GUI's
 * /api/backlog endpoint and the TUI's project-status browse show, rendered as Markdown for
 * `tumwater backlog`. The renderer consumes the payload backlogPayload collects — the three
 * backlog.ts entry readers with their cache behavior, placeholder skipping, and Done/Fixed
 * exclusion the dashboards rely on — so the terminal view cannot drift from the dashboard
 * view (one parser, two surfaces) and the CLI's --json/human branches share one collection
 * (sayJsonOrRender's thunk) instead of each reading the entry files afresh. Entries render
 * verbatim — heading text with its `(planned …)`/`(reported …)` suffix and, when the caller
 * passes holds, a trailing eligibility mark, body lines indented two spaces under it — because
 * these are markdown the roles wrote, including their Goal/Approach/Acceptance-criteria
 * structure; reflowing them here would make this command a worse reader of its own backlog
 * than the files it summarizes. An empty section renders a single `_(none)_` line rather than
 * disappearing, so an all-clear backlog reads as three explicit empties, not a suspiciously
 * short document. */

/** The eligibility holds parallel to a view's `plans` and `bugs` (backlogHolds), so the
 * operator reads why an entry is skipped rather than inferring it. Questions have no holds. */
interface BacklogHolds {
  plans: EntryHold[];
  bugs: EntryHold[];
}

/** The renderer's view: the payload it always consumed, plus optional holds parallel to
 * `plans` and `bugs`. A missing `holds`, or an array shorter than its entries, leaves a
 * heading byte-identically to today. */
/** A backlog entry with its 1-based section position (positionBacklog) — the number the
 * entry's own list command prints and `--show/--cancel <n>`/`questions answer <n>` take, so a
 * filtered --json row stays addressable without recounting the unfiltered arrays. */
export type PositionedEntry = BacklogEntry & { position: number };

/** The renderer's view: the three entry arrays (the same data backlogPayload collects —
 * the entry readers' file order, placeholder skipping, and Done/Fixed exclusion), plus
 * optional `holds` and `inProgress` parallel to `plans` and `bugs`. A missing `holds`, or an
 * array shorter than its entries, leaves a heading byte-identically to today. Generic over
 * the entry type so positionBacklog's positioned entries flow through the filters and the
 * Markdown render (which ignores the extra field) unchanged. Structurally assignable from
 * `BacklogPayload` (which has only the three `BacklogEntry` arrays). */
export interface BacklogView<E extends { title: string; body: string } = BacklogEntry> {
  plans: E[];
  bugs: E[];
  questions: E[];
  holds?: BacklogHolds;
  /** Runner ids working on each entry (backlogInProgress), parallel to `plans` and `bugs`. */
  inProgress?: { plans: (string | null)[]; bugs: (string | null)[] };
}

/** One `## ` section: its entries verbatim, or the single `_(none)_` placeholder line. When
 * `holds` is given, entry `i`'s hold mark rides on its `### ` heading. */
function renderSection<E extends { title: string; body: string }>(title: string, entries: E[], holds?: readonly EntryHold[],
  inProgress?: readonly (string | null)[],
): string[] {
  const lines: string[] = [`## ${title}`, ""];
  if (entries.length === 0) {
    lines.push("_(none)_", "");
    return lines;
  }
  for (let i = 0; i < entries.length; i++) lines.push(...renderEntry(entries[i]!, holds?.[i] ?? null, inProgress?.[i] ?? null));
  return lines;
}

/** One entry: its heading with hold and in-progress marks, then its body indented two spaces. */
function renderEntry(entry: { title: string; body: string }, hold: EntryHold, runner: string | null): string[] {
  const lines: string[] = [`### ${entry.title}${holdMark(hold)}${inProgressMark(runner)}`, ""];
  // The body is already trimmed by parseEntryDetails; only the indent is added here.
  for (const line of entry.body.split("\n")) lines.push(line === "" ? "" : `  ${line}`);
  lines.push("");
  return lines;
}

/** The Planned section. With holds, each series with two or more blocked parts prints as one
 * body-less heading at its first part's place (the grouping `plan --list` uses); every other
 * entry prints as renderSection would. Without holds it is renderSection itself. */
function renderPlannedSection<E extends { title: string; body: string }>(
  entries: E[],
  holds?: readonly EntryHold[],
  inProgress?: readonly (string | null)[],
): string[] {
  if (!holds || entries.length === 0) return renderSection("Planned features", entries, holds, inProgress);
  const rows = entries.map((entry, index) => ({
    index, title: entry.title, hold: holds[index] ?? null, claimer: inProgress?.[index] ?? undefined,
  }));
  const lines: string[] = ["## Planned features", ""];
  let grouped = false;
  for (const g of groupBlockedSeries(rows)) {
    if (g.kind === "row") {
      lines.push(...renderEntry(entries[g.row.index]!, g.row.hold, inProgress?.[g.row.index] ?? null));
      continue;
    }
    grouped = true;
    lines.push(
      `### ${g.series}, ${g.rows.length} blocked parts (${partsLabel(g.rows)}) [blocked: each waits on an earlier part]`,
      "",
    );
  }
  if (grouped) {
    lines.push("_(each blocked series is one heading; `tumwater plan --show <n>` prints a part, `tumwater backlog --json` lists every entry)_", "");
  }
  return lines;
}

/** Render the backlog view (planned plans, open bugs, open questions, with any holds) as
 * Markdown. */
export function renderBacklogMarkdown(payload: BacklogView): string {
  const lines: string[] = ["# tumwater backlog", ""];
  lines.push(...renderPlannedSection(payload.plans, payload.holds?.plans, payload.inProgress?.plans));
  lines.push(...renderSection("Open bugs", payload.bugs, payload.holds?.bugs, payload.inProgress?.bugs));
  lines.push(...renderSection("Open questions", payload.questions));
  return lines.join("\n").trimEnd();
}

/** Pick the elements of a parallel array at the kept indexes: `pickByIndex(xs, idx)[k]` is
 * `xs[idx[k]]`, so the holds and inProgress slices stay parallel to the filtered
 * plans/bugs/questions. A missing array (a view with no holds) yields no picks. Both
 * readyBacklog and grepBacklog rebuild their views through it. */
function pickByIndex<T>(xs: readonly T[] | undefined, idx: readonly number[]): T[] {
  return idx.map((i) => xs?.[i] as T);
}

/** The indexes a filter keeps over a 0..n-1 range — the two filters' shared construction, so
 * each returns one kept-index array and the parallel picks below step in lock with it. */
function keptIndexes(n: number, isKept: (i: number) => boolean): number[] {
  return Array.from({ length: n }, (_, i) => i).filter(isKept);
}

/** The holds half of a filtered view, picked by the same kept indexes; `{}` when the view
 * carries no holds, so the spreading caller leaves its own field untouched. */
function filterHolds(
  holds: BacklogHolds | undefined,
  plan: readonly number[],
  bug: readonly number[],
): { holds: BacklogHolds } | {} {
  return holds ? { holds: { plans: pickByIndex(holds.plans, plan), bugs: pickByIndex(holds.bugs, bug) } } : {};
}

/** The in-progress half of a filtered view, picked by the same kept indexes; `{}` when the
 * view carries no inProgress. */
function filterInProgress(
  inProgress: BacklogView["inProgress"],
  plan: readonly number[],
  bug: readonly number[],
): { inProgress: NonNullable<BacklogView["inProgress"]> } | {} {
  return inProgress
    ? { inProgress: { plans: pickByIndex(inProgress.plans, plan), bugs: pickByIndex(inProgress.bugs, bug) } }
    : {};
}

/** The view with only the plans and bugs no hold keeps from being picked: entry `i` stays when
 * `holds.plans[i]` / `holds.bugs[i]` is null, and `holds` and `inProgress` are filtered by the
 * same indexes so the arrays stay parallel. An entry a role is working on has no hold, so it
 * stays with its in-progress mark. Questions carry no holds and pass through; a view without
 * `holds` is returned unchanged. */
export function readyBacklog<E extends { title: string; body: string }>(view: BacklogView<E>): BacklogView<E> {
  const holds = view.holds;
  if (!holds) return view;
  const plan = keptIndexes(view.plans.length, (i) => (holds.plans[i] ?? null) === null);
  const bug = keptIndexes(view.bugs.length, (i) => (holds.bugs[i] ?? null) === null);
  return {
    ...view,
    plans: pickByIndex(view.plans, plan),
    bugs: pickByIndex(view.bugs, bug),
    ...filterHolds(holds, plan, bug),
    ...filterInProgress(view.inProgress, plan, bug),
  };
}

/** The view with only the plans and bugs a hold keeps from being picked — the inverse of
 * readyBacklog: entry `i` stays when `holds.plans[i]` / `holds.bugs[i]` is non-null, and
 * `holds` and `inProgress` are filtered by the same indexes so the arrays stay parallel. An
 * entry a role is working on has no hold, so it drops with the rest of the unheld. Questions
 * carry no holds and pass through; a view without `holds` is returned unchanged. */
export function heldBacklog<E extends { title: string; body: string }>(view: BacklogView<E>): BacklogView<E> {
  const holds = view.holds;
  if (!holds) return view;
  const plan = keptIndexes(view.plans.length, (i) => (holds.plans[i] ?? null) !== null);
  const bug = keptIndexes(view.bugs.length, (i) => (holds.bugs[i] ?? null) !== null);
  return {
    ...view,
    plans: pickByIndex(view.plans, plan),
    bugs: pickByIndex(view.bugs, bug),
    ...filterHolds(holds, plan, bug),
    ...filterInProgress(view.inProgress, plan, bug),
  };
}

/** The view with only the entries whose heading or body contains `pattern` (case-insensitively) —
 * the active-entry twin of the finished-entry `--grep`, through the same one matcher
 * (entryMatches, backlog.ts) the finished-entry lists use: keep plan `i`, bug `i` and question
 * `i` only when entryMatches(entry, pattern), and filter `holds.plans`/`holds.bugs` and
 * `inProgress.plans`/`inProgress.bugs` by the same kept indexes so the parallel arrays stay
 * aligned (the same pickByIndex/filterHolds/filterInProgress trio readyBacklog uses). Questions
 * carry no holds and filter by entryMatches alone. A view without `holds`/`inProgress` only
 * filters the entry arrays. */
export function grepBacklog<E extends { title: string; body: string }>(view: BacklogView<E>, pattern: string): BacklogView<E> {
  const plan = keptIndexes(view.plans.length, (i) => entryMatches(view.plans[i]!, pattern));
  const bug = keptIndexes(view.bugs.length, (i) => entryMatches(view.bugs[i]!, pattern));
  const question = keptIndexes(view.questions.length, (i) => entryMatches(view.questions[i]!, pattern));
  return {
    ...view,
    plans: pickByIndex(view.plans, plan),
    bugs: pickByIndex(view.bugs, bug),
    questions: pickByIndex(view.questions, question),
    ...filterHolds(view.holds, plan, bug),
    ...filterInProgress(view.inProgress, plan, bug),
  };
}

/** The view with each of its `plans`, `bugs` and `questions` entries carrying its 1-based
 * position in its section's file order — the number the entry's own list command (`plan
 * --list`, `bug --list`, `questions`) prints and `plan|bug --show/--cancel <n>` or
 * `questions answer <n>` take. cmdBacklog applies it once, before its `--grep` and
 * `--ready`/`--held` filters, so a kept row keeps its unfiltered position through them and
 * `backlog --json` is addressable from a filtered row. `holds`/`inProgress` pass through
 * untouched (the filters above re-pick them), and the Markdown renderer ignores the extra
 * field, so only the --json document's rows change. backlogPayload itself stays {title,
 * body}: the GUI's /api/backlog payload and the shared shape are untouched. */
export function positionBacklog(view: BacklogView): BacklogView<PositionedEntry> {
  return {
    ...view,
    plans: view.plans.map((e, i) => ({ position: i + 1, ...e })),
    bugs: view.bugs.map((e, i) => ({ position: i + 1, ...e })),
    questions: view.questions.map((e, i) => ({ position: i + 1, ...e })),
  };
}
