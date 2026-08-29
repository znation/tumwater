import fs from "node:fs";
import path from "node:path";

/** The project backlog data shown on both dashboards: planned features (PLANS.md), open bugs
 * (BUGS.md), and open questions (QUESTIONS.md). These are tracked markdown that loops edit
 * constantly, so every reader takes a fresh read — the same no-caching pattern as events and
 * transcripts. Each dashboard formats this data for its own surface (the TUI's lines live in
 * tui.ts; the GUI renders HTML in gui-page.ts) — this module owns only reading and parsing.
 * The open-question count shown in the status headers is just `openQuestions(root).length`,
 * so the badge and the list always come from one parse. */

/** The `### ` heading texts inside one `## <sectionTitle>` section of a markdown document:
 * stops at the next `## ` line (so Done/Fixed entries never leak in), ignores body text under
 * an entry, skips non-heading placeholders like `_None yet._`, and keeps the full heading text
 * including any `(planned …)`/`(reported …)` suffix. */
export function parseEntries(md: string, sectionTitle: string): string[] {
  const entries: string[] = [];
  let inSection = false;
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      inSection = line.slice(3).trim() === sectionTitle;
      continue;
    }
    if (inSection && line.startsWith("### ")) entries.push(line.slice(4).trim());
  }
  return entries;
}

/** Planned features: the `### ` headings under PLANS.md's `## Planned` section. A missing or
 * unreadable file yields [] — a render path must never throw on backlog state. */
export function plannedPlans(root: string): string[] {
  const md = readMd(path.join(root, "PLANS.md"));
  return md === null ? [] : parseEntries(md, "Planned");
}

/** Open bugs: the `### ` headings under BUGS.md's `## Open` section. Missing or unreadable → []. */
export function openBugs(root: string): string[] {
  const md = readMd(path.join(root, "BUGS.md"));
  return md === null ? [] : parseEntries(md, "Open");
}

/** Open questions: the `### ` headings under QUESTIONS.md's `## Open` section — loops post
 * them when a decision is genuinely the user's (see plans/questions-outbox.md). Missing or
 * unreadable → []. */
export function openQuestions(root: string): string[] {
  const md = readMd(path.join(root, "QUESTIONS.md"));
  return md === null ? [] : parseEntries(md, "Open");
}

function readMd(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
