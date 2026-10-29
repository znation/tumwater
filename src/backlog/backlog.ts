import path from "node:path";
import { cachedTextByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { entryDates, entryLags, finishedArchiveOf, firstDate, lastDate, parseEntryDetails, type BacklogEntry } from "./backlog-md.js";
import { CHECK_DECLARATION_MARKER } from "../roles/role-guidance.js";
import { DAY_MS } from "../text/datetime.js";

export type { BacklogEntry } from "./backlog-md.js";

/** The stat-cached file readers of the project backlog data shown on both dashboards: planned
 * features (PLANS.md), open bugs (BUGS.md), and open questions (QUESTIONS.md). These are tracked
 * markdown that roles edit, so readers must never show a stale entry — but the dashboards poll them
 * every second while the files change only when a role merges an edit. Each reader therefore serves
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
 * files change only when a role merges an edit — serving an unchanged file from the cache makes
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

/** Filing dates of an entry section (PLANS.md `## Planned` and `## Done`; BUGS.md `## Open`
 * and `## Fixed`), stat-cached and detected exactly like sectionCompletionDates — the per-day
 * filing twin of that completion read, but reading each entry's FIRST stamp date (entryDates'
 * `first` mode) rather than the completion read's last-date: the filing date is the day the
 * entry first opened, matching the canonical `filingDate` first-match that `plan|bug --list`
 * and the doctor's unfixed-bug age use, so a later re-filing or a cross-reference
 * ("found by … <early date>; found by … <later date>") cannot land the filing on the later day.
 * Where the completion read keys its cache by the section
 * date regex, this
 * uses the module's fixed STAMP_DATE_RE, so the cache key carries a distinct `\u0000planned` marker
 * instead (Plan adds and bug filings share the stamp verb set, so the section title alone cannot
 * tell this read from a completion read of the same section). Every eligible heading carries its
 * filing stamp in prose (`planned DATE`, `reported DATE`, `found by … DATE`), and the Usage view
 * collects them per day so an operator can read net progress (opened vs done). A missing or
 * unreadable file yields []. */
export function sectionFilingDates(
  root: string,
  fileName: string,
  sectionTitle: string,
): string[] {
  const file = path.join(root, fileName);
  return (
    cachedTextByStat(
      dateCache,
      `${file}\u0000${sectionTitle}\u0000planned`,
      file,
      (md) => entryDates(md, sectionTitle, STAMP_DATE_RE, true),
      (dates) => dates.slice(), // A copy: callers may treat the result as their own.
    ) ?? []
  );
}

/** Stat-keyed cache of the completion-lag reads, keyed like the date reads by file + section +
 * the completion date regex. Bounded inside cachedTextByStat like the others. */
const lagCache = new Map<string, StatKeyedValue<{ date: string; lagDays: number }[]>>();

/** The filing-to-done span of each finished entry in a live or archive backlog file's finished
 * section (PLANS.md `## Done`, BUGS.md `## Fixed`), stat-cached like sectionCompletionDates.
 * One `{ date, lagDays }` per finished entry that carries BOTH a completion stamp (`dateRe`,
 * the day it completed) and a filing stamp (the module's STAMP_DATE_RE, its first stamp) and
 * whose filing is not after its completion — read through entryLags, so the lag read pairs
 * exactly the same entries and dates the completion and filing reads count. `lagDays` is the
 * whole-day span from filing to done. The date regex is part of the cache key (each section's
 * completion verbs differ); a missing or unreadable file yields []. */
export function sectionCompletionLags(
  root: string,
  fileName: string,
  sectionTitle: string,
  dateRe: RegExp,
): { date: string; lagDays: number }[] {
  const file = path.join(root, fileName);
  return (
    cachedTextByStat(
      lagCache,
      `${file}\u0000${sectionTitle}\u0000${dateRe.source}\u0000${dateRe.flags}`,
      file,
      (md) => entryLags(md, sectionTitle, dateRe, STAMP_DATE_RE).map((l) => ({ date: l.done, lagDays: l.lagDays })),
      (lags) => lags.map((l) => ({ date: l.date, lagDays: l.lagDays })), // A copy: callers may treat the result as their own.
    ) ?? []
  );
}

/** The first `YYYY-MM-DD` after a `planned`/`reported`/`found by` stamp word in an entry heading:
 * the filing date every eligible heading carries in prose (plans open with `(planned YYYY-MM-DD…)`,
 * bugs with `(found by …)` or `(reported …)`), parsed so `plan|bug --list` shows how long an entry
 * has waited, without opening the file. Read only the title — the whole heading, never the body,
 * because the stamp is the entry's own and the body may name other dates.
 * null when the heading carries no such clause. Routed through backlog-md.ts's firstDate -
 * the one first-match mechanism - with this module's own stamp regex.
 * questionFilingDate (backlog-question-answer.ts) is the same recipe for the `asked by` verb. */
const STAMP_DATE_RE = /(?:planned|reported|found by)\b[^)]*?\b(\d{4}-\d{2}-\d{2})/;
export function filingDate(title: string): string | null {
  return firstDate(title, STAMP_DATE_RE);
}

/** The completion stamp of a `## Done` plan heading. */
export const DONE_DATE_RE = /done (\d{4}-\d{2}-\d{2})/;
// The completion verbs track the phrasing the harness's own roles actually write: the bugfix prompt
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
  return Math.max(0, Math.floor((now - Date.parse(since)) / DAY_MS));
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

/** The finished entries of a live backlog file, newest first: its own finished section's
 * (normally none — tumwater moves a finished entry to the archive as the change that finished it
 * commits) followed by its archive file's (plans/backlog-archive.md). Both reads are stat-cached
 * like every section read here. */
function finishedEntries(root: string, file: "PLANS.md" | "BUGS.md"): BacklogEntry[] {
  const { section, archive } = finishedArchiveOf(file);
  return [...sectionEntries(root, file, section), ...sectionEntries(root, archive, section)];
}

/** The files a live backlog file's finished entries sit in: the file itself, then its archive.
 * The per-day date reads below are per file, so the report walks both. */
export function finishedFiles(file: "PLANS.md" | "BUGS.md"): [string, string] {
  return [file, finishedArchiveOf(file).archive];
}

/** Done plans: the `### ` headings under `## Done` in PLANS.md and PLANS-DONE.md. The bootstrap
 * gate (src/gates/bootstrap-gates.ts) counts these to decide when to latch bootstrap complete;
 * the stat-keyed cache means unchanged files cost one syscall each per poll, not a re-read. */
export function donePlans(root: string): string[] {
  return finishedEntries(root, "PLANS.md").map((e) => e.title);
}

/** Done plans as entries (title and body), newest first. */
export function donePlanEntries(root: string): BacklogEntry[] {
  return finishedEntries(root, "PLANS.md");
}

/** Fixed bugs as entries (title and body), newest first. */
export function fixedBugEntries(root: string): BacklogEntry[] {
  return finishedEntries(root, "BUGS.md");
}

/** Open bugs: the `### ` headings under BUGS.md's `## Open` section. Missing or unreadable →
 * []. */
export function openBugs(root: string): string[] {
  return sectionEntries(root, "BUGS.md", "Open").map((e) => e.title);
}

/** Open questions: the `### ` headings under QUESTIONS.md's `## Open` section — roles post
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

/** The PLANS.md `## Planned` entry that declares this project's deterministic check — the one
 * whose body carries CHECK_DECLARATION_MARKER (the plan role writes it under the no-check note's
 * direction, src/prompt/gate-notes.ts buildNoCheckNote; the feature role reads it as its task).
 * Null when no planned entry declares one, so a declaration already waiting is never
 * double-planned and a feature run implements only a declaration the plan role actually wrote. */
export function declarationPlanEntry(root: string): BacklogEntry | null {
  return plannedPlanEntries(root).find((e) => e.body.includes(CHECK_DECLARATION_MARKER)) ?? null;
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

/** Whether an entry's heading or body contains `pattern`, ignoring case: the one matcher behind
 * the finished-entry lists' `--grep`. */
export function entryMatches(entry: BacklogEntry, pattern: string): boolean {
  return `${entry.title}\n${entry.body}`.toLowerCase().includes(pattern.toLowerCase());
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
