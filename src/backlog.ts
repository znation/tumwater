import fs from "node:fs";
import path from "node:path";
import { statOrNull } from "./files.js";

/** The project backlog data shown on both dashboards: planned features (PLANS.md), open bugs
 * (BUGS.md), and open questions (QUESTIONS.md). These are tracked markdown that loops edit, so
 * readers must never show a stale entry — but the dashboards poll them every second while the
 * files change only when a loop lands an edit. Each reader therefore serves an unchanged file
 * from a stat-keyed cache: one syscall per file per poll instead of re-reading and re-parsing
 * markdown that grows without bound over the project's lifetime (PLANS/BUGS are append-only
 * durable memory). Any write invalidates via dev/ino/mtime/size — the same freshness check as
 * tail.ts's incremental log readers. Each dashboard formats this data for its own surface (the
 * TUI's lines live in tui.ts; the GUI renders HTML in gui-page.ts) — this module owns only
 * reading and parsing. The open-question count shown in the status headers is just
 * `openQuestions(root).length`, so the badge and the list always come from one parse. */

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

/** One cached parse: the file's identity and freshness at read time plus its parsed entries. */
interface SectionCache {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
  entries: string[];
}

/** Parsed sections keyed by file + section title (a future reader of a second section from the
 * same file must not collide with the first). Bounded like tail.ts's tail maps: many short-lived
 * roots in tests would otherwise accumulate. */
const sectionCache = new Map<string, SectionCache>();
/** Safety cap so the cache can never grow unbounded (e.g. many short-lived roots in tests).
 * Evicting only costs one re-read per file on the next call. */
const MAX_CACHED_SECTIONS = 64;

/** The `### ` headings under `<root>/<fileName>`'s `## <sectionTitle>`: fresh when the file's
 * identity or mtime/size changed since the last read, cached otherwise (see module docs). A
 * missing or unreadable file yields [] — a render path must never throw on backlog state. */
function sectionEntries(root: string, fileName: string, sectionTitle: string): string[] {
  const file = path.join(root, fileName);
  const st = statOrNull(file);
  if (!st) {
    sectionCache.delete(`${file}\u0000${sectionTitle}`); // Vanished — drop any stale entry.
    return [];
  }
  const key = `${file}\u0000${sectionTitle}`;
  const cached = sectionCache.get(key);
  if (
    cached &&
    cached.dev === st.dev &&
    cached.ino === st.ino &&
    cached.mtimeMs === st.mtimeMs &&
    cached.size === st.size
  ) {
    return cached.entries.slice(); // A copy: callers may treat the result as their own.
  }
  let md: string;
  try {
    md = fs.readFileSync(file, "utf8");
  } catch {
    sectionCache.delete(key);
    return [];
  }
  const entries = parseEntries(md, sectionTitle);
  if (sectionCache.size >= MAX_CACHED_SECTIONS) sectionCache.clear();
  sectionCache.set(key, { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, entries });
  return entries.slice();
}

/** Planned features: the `### ` headings under PLANS.md's `## Planned` section. Missing or
 * unreadable → []. */
export function plannedPlans(root: string): string[] {
  return sectionEntries(root, "PLANS.md", "Planned");
}

/** Open bugs: the `### ` headings under BUGS.md's `## Open` section. Missing or unreadable → []. */
export function openBugs(root: string): string[] {
  return sectionEntries(root, "BUGS.md", "Open");
}

/** Open questions: the `### ` headings under QUESTIONS.md's `## Open` section — loops post
 * them when a decision is genuinely the user's (see plans/questions-outbox.md). Missing or
 * unreadable → []. */
export function openQuestions(root: string): string[] {
  return sectionEntries(root, "QUESTIONS.md", "Open");
}
