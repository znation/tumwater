import path from "node:path";
import { cachedTextByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { entryDates, lastDate, parseEntryDetails, type BacklogEntry } from "./backlog-md.js";

export type { BacklogEntry } from "./backlog-md.js";

/** The stat-cached file readers of the project backlog data shown on both dashboards: planned
 * features (PLANS.md), open bugs (BUGS.md), and open questions (QUESTIONS.md). These are tracked
 * markdown that loops edit, so readers must never show a stale entry — but the dashboards poll them
 * every second while the files change only when a loop merges an edit. Each reader therefore serves
 * an unchanged file from a stat-keyed cache: one syscall per file per poll instead of re-reading
 * and re-parsing markdown that grows without bound over the project's lifetime (PLANS/BUGS are
 * append-only durable memory). Any write invalidates it via dev/ino/mtime/size
 * (stat-cache.cachedByStat, same freshness check as files/tail.ts's incremental log readers). The
 * pure markdown parsing underneath lives in src/backlog/backlog-md.ts — this module owns only
 * reading and caching. Each dashboard formats this data for its own surface (the TUI's lines live
 * in tui.tsx; the GUI renders HTML in gui-page.ts). The open-question count shown in the status
 * headers is just `openQuestions(root).length`, so the badge and the list always come from one
 * parse. */

/** Parsed sections keyed by file + section title (a future reader of a second section from the
 * same file must not collide with the first). Bounded inside cachedTextByStat: many short-lived
 * roots in tests would otherwise accumulate. Stores the richer {title, body} shape — one parse
 * per file change subsumes both the titles-only and the full-entry reads. */
const sectionCache = new Map<string, StatKeyedValue<BacklogEntry[]>>();

/** The entries under `<root>/<fileName>`'s `## <sectionTitle>`: fresh when the file's identity
 * or mtime/size changed since the last read, cached otherwise (see module docs). A missing or
 * unreadable file yields [] — a render path must never throw on backlog state. */
function sectionEntries(root: string, fileName: string, sectionTitle: string): BacklogEntry[] {
  const file = path.join(root, fileName);
  return (
    cachedTextByStat(
      sectionCache,
      `${file}\u0000${sectionTitle}`,
      file,
      (md) => parseEntryDetails(md, sectionTitle),
      (entries) => entries.map((e) => ({ ...e })), // A copy: callers may treat the result as their own.
    ) ?? []
  );
}

/** Stat-keyed cache of the completion-date reads, keyed by file + section + date regex (each
 * completion section's verbs differ) and bounded inside cachedTextByStat like sectionCache. */
const dateCache = new Map<string, StatKeyedValue<string[]>>();

/** Completion dates of an entry section (PLANS.md `## Done`, BUGS.md `## Fixed`), stat-cached like
 * sectionEntries above. The usage report scans these sections on every /api/report fetch, but the
 * files change only when a loop merges an edit — serving an unchanged file from the cache makes
 * that cost one stat instead of a full read plus an O(size) markdown walk of append-only documents
 * that grow without bound. The date regex is part of the cache key (each section's completion verbs
 * differ); a missing or unreadable file yields []. */
export function sectionCompletionDates(
  root: string,
  fileName: string,
  sectionTitle: string,
  dateRe: RegExp,
): string[] {
  const file = path.join(root, fileName);
  return (
    cachedTextByStat(
      dateCache,
      `${file}\u0000${sectionTitle}\u0000${dateRe.source}\u0000${dateRe.flags}`,
      file,
      (md) => entryDates(md, sectionTitle, dateRe),
      (dates) => dates.slice(), // A copy: callers may treat the result as their own.
    ) ?? []
  );
}

/** The first `YYYY-MM-DD` after a `planned`/`reported`/`found by` stamp word in an entry heading:
 * the filing date every eligible heading carries in prose (plans open with `(planned YYYY-MM-DD…)`,
 * bugs with `(found by …)` or `(reported …)`), parsed so `plan|bug --list` shows how long an entry
 * has waited, without opening the file. Read only the title — the whole heading, never the body,
 * because the stamp is the entry's own and the body may name other dates.
 * null when the heading carries no such clause. */
const STAMP_DATE_RE = /(?:planned|reported|found by)\b[^)]*?\b(\d{4}-\d{2}-\d{2})/;
export function filingDate(title: string): string | null {
  const m = STAMP_DATE_RE.exec(title);
  return m ? (m[1] as string) : null;
}

/** The completion stamp of a `## Done` plan heading. */
export const DONE_DATE_RE = /done (\d{4}-\d{2}-\d{2})/;
// The completion verbs track the phrasing the harness's own loops actually write: the bugfix prompt
// pins the date, not the verb, and the re-merge flow's own epitaph — "re-merged <date>" on an entry
// whose first merge was rejected in review — is a completion the report must count (a rejected
// merge is not a fix, the re-merge is). Body verbs without a date ("was fixed;") match nothing, and
// a bare "merged <date>" stays out: headings mention sibling merges, and a sibling's date is not
// this entry's. The completion stamp of a `## Fixed` bug heading. */
export const FIXED_DATE_RE = /\b(?:re-landed|fixed|closed|resolved) (\d{4}-\d{2}-\d{2})/;

/** The date a finished entry's heading records for `dateRe` (DONE_DATE_RE / FIXED_DATE_RE): its
 * LAST match. Reads only the heading line, like filingDate; a date on a wrapped continuation
 * line or in the body yields null. */
export function completionDate(title: string, dateRe: RegExp): string | null {
  return lastDate(title, dateRe);
}

/** Whole days between a filing stamp and `now`, floored at 0 so a future-dated entry reads as
 * fresh (0d) rather than negative. Shared by the suffix and the `--list --json` `ageDays` field. */
export function ageInDays(since: string, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - Date.parse(since)) / 86400000));
}

/** The ` · since YYYY-MM-DD (Nd)`/`(today)` tail a listing line gains for its entry's filing
 * stamp — the one place the wording and the today/`Nd` choice live, so the plans/bugs list
 * (entryAgeSuffix, stamp parsed by filingDate) and the questions list (questionAgeSuffix,
 * parsed by questionFilingDate) cannot drift. `date` is the already-parsed stamp; the caller
 * returns `""` for an undated heading. */
export function ageSuffix(date: string, now: number = Date.now()): string {
  const n = ageInDays(date, now);
  return ` · since ${date} (${n === 0 ? "today" : `${n}d`})`;
}

/** The ` · since YYYY-MM-DD (Nd)`/`(today)` tail an entry's listing line gains when its heading
 * parses a filing stamp, else `""` — rendered through ageSuffix, the one place the age is
 * worded (shared with the questions list's questionAgeSuffix). */
export function entryAgeSuffix(title: string, now: number = Date.now()): string {
  const since = filingDate(title);
  return since === null ? "" : ageSuffix(since, now);
}

/** Planned features: the `### ` headings under PLANS.md's `## Planned` section. Missing or
 * unreadable → []. */
export function plannedPlans(root: string): string[] {
  return sectionEntries(root, "PLANS.md", "Planned").map((e) => e.title);
}

/** Done plans: the `### ` headings under PLANS.md's `## Done` section. The bootstrap gate
 * (src/gates/bootstrap-gates.ts) counts these to decide when to latch bootstrap complete; the
 * stat-keyed cache means an unchanged PLANS.md costs one syscall per poll, not a re-read. */
export function donePlans(root: string): string[] {
  return sectionEntries(root, "PLANS.md", "Done").map((e) => e.title);
}

/** Done plans as entries (title and body), in file order: the newest first. */
export function donePlanEntries(root: string): BacklogEntry[] {
  return sectionEntries(root, "PLANS.md", "Done");
}

/** Fixed bugs as entries (title and body), in file order: the newest first. */
export function fixedBugEntries(root: string): BacklogEntry[] {
  return sectionEntries(root, "BUGS.md", "Fixed");
}

/** Open bugs: the `### ` headings under BUGS.md's `## Open` section. Missing or unreadable →
 * []. */
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

/** Answered questions as full entries (title + body), in file order — oldest first, since
 * tryAnswerQuestion appends. Missing or unreadable → []. */
export function answeredQuestionEntries(root: string): BacklogEntry[] {
  return sectionEntries(root, "QUESTIONS.md", "Answered");
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
