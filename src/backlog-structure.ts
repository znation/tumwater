import path from "node:path";
import { readTextOrNull } from "./files.js";
import { fenceTracker, headingMetadata } from "./backlog.js";

/** Deterministic structural checks on the backlog markdown (PLANS.md, BUGS.md, QUESTIONS.md) —
 * the same files loops edit and readers parse, but read here for states no reader wants: an
 * entry filed under the wrong `## ` section. This module holds PLANS.md's stranding rules
 * (plans: "Stranded-plan detection", part 3/4): a `(planned …)` heading sitting under `## Done`
 * never entered a reader's section, and a `done`-dated heading still sitting under
 * `## Planned` invites re-implementation. Detection is pure markdown reading — no pi, no git —
 * so the clean loop's tick prompt and `tumwater doctor` can both afford it every time. */

/** A `### ` heading the detector found filed under the wrong `## ` section of PLANS.md:
 * `title` is the full heading text (verbatim, dates and all), `section` the section it sits
 * in now — which tells the repairer where it does NOT belong, since a heading's own dates
 * say where it does. */
export interface StrandedPlanEntry {
  title: string;
  section: "Planned" | "Done";
}

/** A heading's parenthetical dates: `(planned YYYY-MM-DD` opens a plan entry; `done
 * YYYY-MM-DD` records its completion. Matched against the JOINED heading metadata
 * (headingMetadata), never the bare first line — many headings wrap their dates onto a
 * second line (`(planned 2026-09-02, done` / `2026-09-03)`). */
const PLANNED_DATE = /\(planned \d{4}-\d{2}-\d{2}/;
const DONE_DATE = /\bdone \d{4}-\d{2}-\d{2}/;

/** The `### ` headings of `md`'s PLANS.md that sit under the wrong section, in file order:
 * (a) entries under `## Done` whose heading carries a `(planned YYYY-MM-DD…)` parenthetical
 * but no `done YYYY-MM-DD` — written as plans, never stamped done, and invisible to every
 * Planned reader (`plannedPlanEntries` reads only `## Planned`); and (b) entries under
 * `## Planned` whose heading already carries `done YYYY-MM-DD` — finished and never moved,
 * so the feature loop may implement them again. Fence-aware through backlog.ts's shared
 * machinery: a `### `/`## ` line inside a fenced code block is quoted content, not structure,
 * and heading dates are matched against the same joined metadata entryDates matches against.
 * BUGS.md and QUESTIONS.md are deliberately out of scope — their Fixed-section headings do
 * not all carry a date suffix, so the same rule would misfire there. */
export function strandedPlanEntries(md: string): StrandedPlanEntry[] {
  const stranded: StrandedPlanEntry[] = [];
  // A section always starts at its non-fenced `## ` heading, so a fresh tracker stays in sync
  // with the document's fence state — the same filter entryDates scans through.
  const fenced = fenceTracker();
  const lines = md.split("\n").filter((line) => !fenced.inside(line));
  let section: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      continue;
    }
    if ((section !== "Planned" && section !== "Done") || !line.startsWith("### ")) continue;
    const { text } = headingMetadata(lines, i);
    if (section === "Done" ? PLANNED_DATE.test(text) && !DONE_DATE.test(text) : DONE_DATE.test(text))
      stranded.push({ title: line.slice(4).trim(), section });
  }
  return stranded;
}

/** The clean loop's `<backlog-structure>` prompt block for the primary checkout at `root`
 * (the same root the telemetry digest and qa coverage blocks read): a rendered block listing
 * each stranded heading with its current section, or undefined when PLANS.md is missing,
 * unreadable, or clean — an unreadable or clean file gives no block, so the prompt is
 * unchanged in the common case. */
export function renderBacklogStructureBlock(root: string): string | undefined {
  let md: string | null;
  try {
    md = readTextOrNull(path.join(root, "PLANS.md"));
  } catch {
    md = null;
  }
  if (md === null) return undefined;
  const stranded = strandedPlanEntries(md);
  if (stranded.length === 0) return undefined;
  const listed = stranded
    .map((e) => `- (now under ## ${e.section}) ${e.title}`)
    .join("\n");
  // The task wording lives in the clean role's find text (src/roles.ts); the block only
  // carries the evidence, like the digest and coverage blocks do.
  return `Plan headings filed under the wrong section of PLANS.md — invisible to the readers
that scan one section, so no loop sees them as backlog work:
<backlog-structure>
${listed}
</backlog-structure>`;
}
