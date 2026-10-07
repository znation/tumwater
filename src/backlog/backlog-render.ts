import type { BacklogEntry } from "./backlog-md.js";
import type { BacklogPayload } from "./backlog.js";

/** The terminal's view of the project backlog — the same three open sections the GUI's
 * /api/backlog endpoint and the TUI's project-status browse show, rendered as Markdown for
 * `tumwater backlog`. The renderer consumes the payload backlogPayload collects — the three
 * backlog.ts entry readers with their cache behavior, placeholder skipping, and Done/Fixed
 * exclusion the dashboards rely on — so the terminal view cannot drift from the dashboard
 * view (one parser, two surfaces) and the CLI's --json/human branches share one collection
 * (sayJsonOrRender's thunk) instead of each reading the entry files afresh. Entries render
 * verbatim — heading text with its `(planned …)`/`(reported …)` suffix, body lines
 * indented two spaces under it — because these are markdown the loops
 * wrote, including their Goal/Approach/Acceptance-criteria structure; reflowing them here
 * would make this command a worse reader of its own backlog than the files it summarizes. An
 * empty section renders a single `_(none)_` line rather than disappearing, so an all-clear
 * backlog reads as three explicit empties, not a suspiciously short document. */

/** One `## ` section: its entries verbatim, or the single `_(none)_` placeholder line. */
function renderSection(title: string, entries: BacklogEntry[]): string[] {
  const lines: string[] = [`## ${title}`, ""];
  if (entries.length === 0) {
    lines.push("_(none)_", "");
    return lines;
  }
  for (const entry of entries) {
    lines.push(`### ${entry.title}`, "");
    // The body is already trimmed by parseEntryDetails; only the indent is added here.
    for (const line of entry.body.split("\n")) lines.push(line === "" ? "" : `  ${line}`);
    lines.push("");
  }
  return lines;
}

/** Render the backlog payload (planned plans, open bugs, open questions) as Markdown. */
export function renderBacklogMarkdown(payload: BacklogPayload): string {
  const lines: string[] = ["# tumwater backlog", ""];
  lines.push(...renderSection("Planned features", payload.plans));
  lines.push(...renderSection("Open bugs", payload.bugs));
  lines.push(...renderSection("Open questions", payload.questions));
  return lines.join("\n").trimEnd();
}
