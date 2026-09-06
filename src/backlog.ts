import fs from "node:fs";
import path from "node:path";
import { cachedByStat, type StatKeyedValue } from "./stat-cache.js";

/** The project backlog data shown on both dashboards: planned features (PLANS.md), open bugs
 * (BUGS.md), and open questions (QUESTIONS.md). These are tracked markdown that loops edit, so
 * readers must never show a stale entry — but the dashboards poll them every second while the
 * files change only when a loop lands an edit. Each reader therefore serves an unchanged file
 * from a stat-keyed cache: one syscall per file per poll instead of re-reading and re-parsing
 * markdown that grows without bound over the project's lifetime (PLANS/BUGS are append-only
 * durable memory). Any write invalidates it via dev/ino/mtime/size (stat-cache.cachedByStat,
 * same freshness check as tail.ts's incremental log readers). Each dashboard formats this data
 * for its own surface (the
 * TUI's lines live in tui.ts; the GUI renders HTML in gui-page.ts) — this module owns only
 * reading and parsing. The open-question count shown in the status headers is just
 * `openQuestions(root).length`, so the badge and the list always come from one parse. */

/** One backlog entry as parsed from a markdown section: the full `### ` heading text (kept
 * verbatim, including any `(planned …)`/`(reported …)` suffix) plus the entry's body — the
 * trimmed lines between its heading and the next `### `/`## ` line (empty string for a bare
 * heading). The dashboards' list views show titles only; the TUI/GUI browse surfaces render
 * the full body in place. */
export interface BacklogEntry {
  title: string;
  body: string;
}

/** The entries inside one `## <sectionTitle>` section of a markdown document, each with its
 * full body: stops at the next `## ` line (so Done/Fixed entries never leak in), skips
 * non-heading placeholders like `_None yet._` and any prose before the first heading, keeps
 * interior blank lines within a body while trimming leading/trailing ones, and ends an open
 * entry's body at EOF as well as at the next heading. */
export function parseEntryDetails(md: string, sectionTitle: string): BacklogEntry[] {
  const entries: BacklogEntry[] = [];
  let inSection = false;
  let title: string | null = null; // The open entry's heading (null = no entry open yet).
  let bodyLines: string[] = [];
  const close = (): void => {
    if (title !== null) entries.push({ title, body: bodyLines.join("\n").trim() });
    title = null;
    bodyLines = []; // Prose before the first heading never becomes a body.
  };
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      close(); // A new ## section ends both the open entry's body and the section itself.
      inSection = line.slice(3).trim() === sectionTitle;
      continue;
    }
    if (!inSection) continue;
    if (line.startsWith("### ")) {
      close();
      title = line.slice(4).trim();
      continue;
    }
    bodyLines.push(line);
  }
  close(); // An entry at the end of file ends with EOF, not a heading.
  return entries;
}

/** The `### ` heading texts inside one `## <sectionTitle>` section — titles only, for the
 * list views (status badges, dashboard lists). Thin wrapper over parseEntryDetails so both
 * shapes come from one parse. */
export function parseEntries(md: string, sectionTitle: string): string[] {
  return parseEntryDetails(md, sectionTitle).map((e) => e.title);
}

/** Parsed sections keyed by file + section title (a future reader of a second section from the
 * same file must not collide with the first). Bounded inside cachedByStat: many short-lived
 * roots in tests would otherwise accumulate. Stores the richer {title, body} shape — one parse
 * per file change subsumes both the titles-only and the full-entry reads. */
const sectionCache = new Map<string, StatKeyedValue<BacklogEntry[]>>();

/** The entries under `<root>/<fileName>`'s `## <sectionTitle>`: fresh when the file's identity
 * or mtime/size changed since the last read, cached otherwise (see module docs). A missing or
 * unreadable file yields [] — a render path must never throw on backlog state. */
function sectionEntries(root: string, fileName: string, sectionTitle: string): BacklogEntry[] {
  const file = path.join(root, fileName);
  return (
    cachedByStat(
      sectionCache,
      `${file}\u0000${sectionTitle}`,
      file,
      () => {
        let md: string;
        try {
          md = fs.readFileSync(file, "utf8");
        } catch {
          return null; // Unreadable — no data.
        }
        return parseEntryDetails(md, sectionTitle);
      },
      (entries) => entries.map((e) => ({ ...e })), // A copy: callers may treat the result as their own.
    ) ?? []
  );
}

/** Planned features: the `### ` headings under PLANS.md's `## Planned` section. Missing or
 * unreadable → []. */
export function plannedPlans(root: string): string[] {
  return sectionEntries(root, "PLANS.md", "Planned").map((e) => e.title);
}

/** Open bugs: the `### ` headings under BUGS.md's `## Open` section. Missing or unreadable → []. */
export function openBugs(root: string): string[] {
  return sectionEntries(root, "BUGS.md", "Open").map((e) => e.title);
}

/** Open questions: the `### ` headings under QUESTIONS.md's `## Open` section — loops post
 * them when a decision is genuinely the user's (see plans/questions-outbox.md). Missing or
 * unreadable → []. */
export function openQuestions(root: string): string[] {
  return sectionEntries(root, "QUESTIONS.md", "Open").map((e) => e.title);
}

/** Planned features as full entries (title + body), in file order — the TUI's project-status
 * browse and the GUI's /api/backlog endpoint read these. Missing or unreadable → []. */
export function plannedPlanEntries(root: string): BacklogEntry[] {
  return sectionEntries(root, "PLANS.md", "Planned");
}

/** Open bugs as full entries (title + body), in file order. Missing or unreadable → []. */
export function openBugEntries(root: string): BacklogEntry[] {
  return sectionEntries(root, "BUGS.md", "Open");
}

/** Open questions as full entries (title + body), in file order. Missing or unreadable → []. */
export function openQuestionEntries(root: string): BacklogEntry[] {
  return sectionEntries(root, "QUESTIONS.md", "Open");
}
