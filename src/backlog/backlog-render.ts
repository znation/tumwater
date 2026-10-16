import type { BacklogEntry } from "./backlog-md.js";
import type { BacklogPayload } from "./backlog.js";
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
 * these are markdown the loops wrote, including their Goal/Approach/Acceptance-criteria
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
type BacklogView = BacklogPayload & {
  holds?: BacklogHolds;
  /** Runner ids working on each entry (backlogInProgress), parallel to `plans` and `bugs`. */
  inProgress?: { plans: (string | null)[]; bugs: (string | null)[] };
};

/** One `## ` section: its entries verbatim, or the single `_(none)_` placeholder line. When
 * `holds` is given, entry `i`'s hold mark rides on its `### ` heading. */
function renderSection(title: string, entries: BacklogEntry[], holds?: readonly EntryHold[],
  inProgress?: readonly (string | null)[],
): string[] {
  const lines: string[] = [`## ${title}`, ""];
  if (entries.length === 0) {
    lines.push("_(none)_", "");
    return lines;
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    lines.push(`### ${entry.title}${holdMark(holds?.[i] ?? null)}${inProgressMark(inProgress?.[i] ?? null)}`, "");
    // The body is already trimmed by parseEntryDetails; only the indent is added here.
    for (const line of entry.body.split("\n")) lines.push(line === "" ? "" : `  ${line}`);
    lines.push("");
  }
  return lines;
}

/** Render the backlog view (planned plans, open bugs, open questions, with any holds) as
 * Markdown. */
export function renderBacklogMarkdown(payload: BacklogView): string {
  const lines: string[] = ["# tumwater backlog", ""];
  lines.push(...renderSection("Planned features", payload.plans, payload.holds?.plans, payload.inProgress?.plans));
  lines.push(...renderSection("Open bugs", payload.bugs, payload.holds?.bugs, payload.inProgress?.bugs));
  lines.push(...renderSection("Open questions", payload.questions));
  return lines.join("\n").trimEnd();
}

/** The view with only the plans and bugs no hold keeps from being picked: entry `i` stays when
 * `holds.plans[i]` / `holds.bugs[i]` is null, and `holds` and `inProgress` are filtered by the
 * same indexes so the arrays stay parallel. An entry a role is working on has no hold, so it
 * stays with its in-progress mark. Questions carry no holds and pass through; a view without
 * `holds` is returned unchanged. */
export function readyBacklog(view: BacklogView): BacklogView {
  const holds = view.holds;
  if (!holds) return view;
  const keep = (hs: readonly EntryHold[], n: number): number[] =>
    Array.from({ length: n }, (_, i) => i).filter((i) => (hs[i] ?? null) === null);
  const plan = keep(holds.plans, view.plans.length);
  const bug = keep(holds.bugs, view.bugs.length);
  const pick = <T>(xs: readonly T[] | undefined, idx: number[]): T[] => idx.map((i) => xs?.[i] as T);
  return {
    ...view,
    plans: pick(view.plans, plan),
    bugs: pick(view.bugs, bug),
    holds: { plans: pick(holds.plans, plan), bugs: pick(holds.bugs, bug) },
    ...(view.inProgress
      ? { inProgress: { plans: pick(view.inProgress.plans, plan), bugs: pick(view.inProgress.bugs, bug) } }
      : {}),
  };
}
