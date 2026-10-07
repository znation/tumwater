import path from "node:path";
import { readTextOrNull } from "../files/files.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { entryDates, parseEntryDetails, type BacklogEntry } from "./backlog-md.js";

export type { BacklogEntry } from "./backlog-md.js";

/** The stat-cached file readers of the project backlog data shown on both dashboards: planned
 * features (PLANS.md), open bugs (BUGS.md), and open questions (QUESTIONS.md). These are tracked
 * markdown that loops edit, so readers must never show a stale entry — but the dashboards poll
 * them every second while the files change only when a loop lands an edit. Each reader therefore
 * serves an unchanged file from a stat-keyed cache: one syscall per file per poll instead of
 * re-reading and re-parsing markdown that grows without bound over the project's lifetime
 * (PLANS/BUGS are append-only durable memory). Any write invalidates it via dev/ino/mtime/size
 * (stat-cache.cachedByStat, same freshness check as files/tail.ts's incremental log readers). The pure
 * markdown parsing underneath lives in src/backlog/backlog-md.ts — this module owns only reading and
 * caching. Each dashboard formats this data for its own surface (the TUI's lines live in
 * tui.tsx; the GUI renders HTML in gui-page.ts). The open-question count shown in the status
 * headers is just `openQuestions(root).length`, so the badge and the list always come from
 * one parse. */

/** Parsed sections keyed by file + section title (a future reader of a second section from the
 * same file must not collide with the first). Bounded inside cachedByStat: many short-lived
 * roots in tests would otherwise accumulate. Stores the richer {title, body} shape — one parse
 * per file change subsumes both the titles-only and the full-entry reads. */
const sectionCache = new Map<string, StatKeyedValue<BacklogEntry[]>>();

/** One stat-cached read of a markdown file, or null when it is missing or unreadable — the
 * shared load half behind both section readers below: readTextOrNull reads the file and a null
 * (no data) propagates through cachedByStat, so a render path never throws on backlog state.
 * `parse` runs only on a cache miss; `clone` hands each caller its own copy. */
function cachedMarkdown<T>(
  cache: Map<string, StatKeyedValue<T>>,
  key: string,
  file: string,
  parse: (md: string) => T,
  clone: (value: T) => T,
): T | null {
  return cachedByStat(
    cache,
    key,
    file,
    () => {
      const md = readTextOrNull(file); // Missing or unreadable — no data.
      return md === null ? null : parse(md);
    },
    clone,
  );
}

/** The entries under `<root>/<fileName>`'s `## <sectionTitle>`: fresh when the file's identity
 * or mtime/size changed since the last read, cached otherwise (see module docs). A missing or
 * unreadable file yields [] — a render path must never throw on backlog state. */
function sectionEntries(root: string, fileName: string, sectionTitle: string): BacklogEntry[] {
  const file = path.join(root, fileName);
  return (
    cachedMarkdown(
      sectionCache,
      `${file}\u0000${sectionTitle}`,
      file,
      (md) => parseEntryDetails(md, sectionTitle),
      (entries) => entries.map((e) => ({ ...e })), // A copy: callers may treat the result as their own.
    ) ?? []
  );
}

/** Stat-keyed cache of the completion-date reads, keyed by file + section + date regex (each
 * completion section's verbs differ) and bounded inside cachedByStat like sectionCache. */
const dateCache = new Map<string, StatKeyedValue<string[]>>();

/** Completion dates of an entry section (PLANS.md `## Done`, BUGS.md `## Fixed`), stat-cached
 * like sectionEntries above. The usage report scans these sections on every /api/report fetch,
 * but the files change only when a loop lands an edit — serving an unchanged file from the
 * cache makes that cost one stat instead of a full read plus an O(size) markdown walk of
 * append-only documents that grow without bound. The date regex is part of the cache key
 * (each section's completion verbs differ); a missing or unreadable file yields []. */
export function sectionCompletionDates(
  root: string,
  fileName: string,
  sectionTitle: string,
  dateRe: RegExp,
): string[] {
  const file = path.join(root, fileName);
  return (
    cachedMarkdown(
      dateCache,
      `${file}\u0000${sectionTitle}\u0000${dateRe.source}\u0000${dateRe.flags}`,
      file,
      (md) => entryDates(md, sectionTitle, dateRe),
      (dates) => dates.slice(), // A copy: callers may treat the result as their own.
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

/** The backlog as one machine-readable document: the three entry arrays the Markdown renderer
 * and the GUI's /api/backlog endpoint serve, so `tumwater backlog --json` prints the same data
 * every surface reads (status --json's "print the endpoint's payload" pattern). Each array keeps
 * file order and {title, body} verbatim, and a missing or unreadable file degrades to [] like the
 * individual readers — a bare directory yields the all-empty object, never an error. */
export function backlogPayload(root: string): {
  plans: BacklogEntry[];
  bugs: BacklogEntry[];
  questions: BacklogEntry[];
} {
  return {
    plans: plannedPlanEntries(root),
    bugs: openBugEntries(root),
    questions: openQuestionEntries(root),
  };
}

/** The payload's shape, named for the Markdown renderer (backlog-render.ts) that consumes
 * the same collection the JSON document prints — one definition, two consumers. */
export type BacklogPayload = ReturnType<typeof backlogPayload>;