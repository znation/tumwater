import path from "node:path";
import { readTextOrNull } from "./files.js";
import { cachedByStat, type StatKeyedValue } from "./stat-cache.js";

/** The project backlog data shown on both dashboards: planned features (PLANS.md), open bugs
 * (BUGS.md), and open questions (QUESTIONS.md). These are tracked markdown that loops edit, so
 * readers must never show a stale entry — but the dashboards poll them every second while the
 * files change only when a loop lands an edit. Each reader therefore serves an unchanged file
 * from a stat-keyed cache: one syscall per file per poll instead of re-reading and re-parsing
 * markdown that grows without bound over the project's lifetime (PLANS/BUGS are append-only
 * durable memory). Any write invalidates it via dev/ino/mtime/size (stat-cache.cachedByStat,
 * same freshness check as tail.ts's incremental log readers). Each dashboard formats this data
 * for its own surface (the TUI's lines live in tui.ts; the GUI renders HTML in gui-page.ts) —
 * this module owns only reading and parsing. The open-question count shown in the status
 * headers is just `openQuestions(root).length`, so the badge and the list always come from
 * one parse. */

/** One backlog entry as parsed from a markdown section: the full `### ` heading text (kept
 * verbatim, including any `(planned …)`/`(reported …)` suffix) plus the entry's body — the
 * trimmed lines between its heading and the next `### `/`## ` line (empty string for a bare
 * heading). The dashboards' list views show titles only; the TUI/GUI browse surfaces render
 * the full body in place. */
export interface BacklogEntry {
  title: string;
  body: string;
}

/** A per-line CommonMark fenced-code state machine, shared by every line-level parser of
 * backlog markdown. `inside(line)` feeds one line and returns whether it is fence syntax or
 * fenced content — never markdown structure: a fence opens at a ```` ``` ````/`~~~` line (an
 * info string is allowed, except that a backtick fence's info string may not contain a
 * backtick — such a line is paragraph text that opens nothing), closes only at a bare fence
 * line of the same character at least as long, and an unclosed fence runs to EOF. Every reader
 * that classifies backlog lines as markdown structure (section boundaries, entry headings,
 * bullets) must consult this, so two readers can never disagree about what is body content. */
export function fenceTracker(): { inside(line: string): boolean } {
  // The open fence's marker (null = none): only a matching bare fence line closes it.
  let fence: { char: string; length: number } | null = null;
  return {
    inside(line: string): boolean {
      const fenceLine = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fenceLine) {
        const marker = fenceLine[1] ?? ""; // The group always participates; "" keeps types honest.
        if (fence === null) {
          // CommonMark: an info string for a backtick fence cannot contain a backtick, so a
          // line like ````md / ## Done / ````` quoted in prose is paragraph text, not a fence
          // opener — taken as one, no later bare fence line can close it and the fence runs to
          // EOF, swallowing the rest of the document as fenced content.
          const info = line.replace(/^ {0,3}/, "").slice(marker.length);
          if (marker.charAt(0) === "`" && info.includes("`")) return false;
          fence = { char: marker.charAt(0), length: marker.length };
        }
        else if (marker.charAt(0) === fence.char && marker.length >= fence.length && line.trim() === marker)
          fence = null;
        return true; // The fence line itself is fence syntax, never structure.
      }
      return fence !== null;
    },
  };
}

/** The body lines of the `## <sectionTitle>` section of a markdown document: everything
 * between that heading line and the next `## ` line (or EOF), neither boundary included. A
 * `## ` line inside a fenced code block (entries quote markdown templates and shell traces) is
 * body content, never a boundary. The single home of "where a section starts and ends" — every
 * reader of a `## ` section (backlog entry parsing here, the usage report's Done/Fixed date
 * scan in src/report-data.ts) walks its section through this, so two independent readers can
 * never disagree about the boundary. */
function sectionLines(md: string, sectionTitle: string): string[] {
  const lines: string[] = [];
  let inSection = false;
  const fenced = fenceTracker();
  for (const line of md.split("\n")) {
    const inFence = fenced.inside(line);
    if (!inFence && line.startsWith("## ")) {
      inSection = line.slice(3).trim() === sectionTitle;
      continue;
    }
    if (inSection) lines.push(line);
  }
  return lines;
}

/** The entries inside one `## <sectionTitle>` section of a markdown document, each with its
 * full body: stops at the next `## ` line (so Done/Fixed entries never leak in), skips
 * non-heading placeholders like `_None yet._` and any prose before the first heading, keeps
 * interior blank lines within a body while trimming leading/trailing ones, and ends an open
 * entry's body at EOF as well as at the next heading. */
export function parseEntryDetails(md: string, sectionTitle: string): BacklogEntry[] {
  const entries: BacklogEntry[] = [];
  let title: string | null = null; // The open entry's heading (null = no entry open yet).
  let bodyLines: string[] = [];
  const close = (): void => {
    if (title !== null) entries.push({ title, body: bodyLines.join("\n").trim() });
    title = null;
    bodyLines = []; // Prose before the first heading never becomes a body.
  };
  // A `### ` line inside a fenced code block is quoted content, never an entry boundary: an
  // entry quoting a markdown template keeps its whole body instead of splitting into a phantom
  // entry at the quoted heading.
  const fenced = fenceTracker();
  for (const line of sectionLines(md, sectionTitle)) {
    if (fenced.inside(line)) bodyLines.push(line);
    else if (line.startsWith("### ")) {
      close();
      title = line.slice(4).trim();
    } else {
      bodyLines.push(line);
    }
  }
  close(); // An entry at the end of file ends with EOF, not a heading.
  return entries;
}

/** The completion dates ("YYYY-MM-DD") of the entries inside one `## <sectionTitle>` section.
 * An entry starts at a `### ` heading or `- ` bullet line and ends at the next such line; only
 * its METADATA is matched for dates — never its body, so a body's "**Done 2026-…**" recap line
 * (or a prose cross-reference like "(done 2026-…)") cannot double-count. Fenced lines are
 * body content, never entry starts — an entry quoting a markdown template with a
 * `### … (fixed DATE)` heading inside must not count as a completion of its own. Metadata is
 * headingMetadata's join (below). Entries without a parseable date are skipped.
 *
 * A `- ` line needs more than a date to be an entry: the sections also hold body bullets (an
 * entry's repro steps, a plan's task breakdown), and a body bullet that merely mentions a
 * completion — "- same shape as the sibling bug (fixed 2026-09-24)" — is not one. The epitaph
 * shape separates them: an epitaph always closes its line with a parenthetical that records
 * both the completion date and the landing commit ("(planned …, done …; commit abc1234)"),
 * so a bullet counts only when its trailing `(…)` group carries the date AND a `commit`
 * reference; a heading entry keeps the plain metadata match (headings are the primary entry
 * format and always close their metadata parenthetical by convention). */
export function entryDates(md: string, sectionTitle: string, dateRe: RegExp): string[] {
  const dates: string[] = [];
  // A section always starts at its non-fenced `## ` heading, so a fresh tracker is in sync
  // with the document's fence state here and for the whole section.
  const fenced = fenceTracker();
  const lines = sectionLines(md, sectionTitle).filter((line) => !fenced.inside(line));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith("### ") && !line.startsWith("- ")) continue;
    const meta = headingMetadata(lines, i);
    let date: string | null = null;
    if (line.startsWith("- ")) {
      // Epitaph guard (see the doc comment): the date must live in the line's trailing
      // parenthetical beside a commit reference, or the bullet is body text, not an entry.
      // Within the parenthetical the completion is the LAST dated verb, matching the heading
      // branch: a decomposition cross-reference ("decomposed from the sibling bug fixed
      // <date>, fixed <date>") precedes the entry's own completion record.
      const tail = trailingParenthetical(line);
      if (/\bcommits?\b/.test(tail)) date = lastDate(tail, dateRe);
    } else {
      date = lastDate(meta.text, dateRe);
    }
    if (date) dates.push(date);
    i = meta.next - 1; // The loop's ++ resumes at the first line not consumed as metadata.
  }
  return dates;
}

/** A `### `/`- ` entry start's METADATA, joined for matching: the start line plus, for `### `
 * headings only, continuation lines up to and including the first line ending in `)` (capped
 * at 3 lines) — wrapped headings carry their date on the second line, while `- ` epitaphs are
 * single-line by construction, so a bullet's own line is its whole metadata (a following prose
 * paragraph is body, never matched). Joining with a space keeps "done\n2026-…" matchable.
 * Returns the joined text and the index of the first line NOT consumed as metadata, so a
 * walker can resume its scan there. Extracted from entryDates (its only original caller) so
 * the stranded-plan detector (src/backlog-structure.ts) matches dates against exactly the
 * same joined text instead of growing a second, drifting copy of the join rule. */
export function headingMetadata(lines: string[], start: number): { text: string; next: number } {
  const line = lines[start] ?? "";
  const meta: string[] = [line];
  let closed = line.endsWith(")");
  let j = start + 1;
  // Continuation is a heading-only concern (wrapped headings); bullets are single-line.
  while (line.startsWith("### ") && meta.length < 3 && j < lines.length && !closed) {
    const next = lines[j] ?? "";
    if (next.startsWith("### ") || next.startsWith("- ")) break; // The entry ends at the next start.
    meta.push(next);
    j++;
    closed = next.endsWith(")");
  }
  return { text: meta.join(" "), next: j };
}

/** A `- ` line's trailing parenthetical's inner text, nesting-aware: a backward scan from the
 * line's closing ")" to its matching "(" returns the group's FULL inner text, so an epitaph
 * that quotes a parenthetical of its own — "(planned …, done …; commit abc1234 (re-landed
 * after review fix))" — still yields its date-bearing text. The previous flat `\([^()]*\)$`
 * match saw only the innermost group ("" when the line ended in two closes) and silently
 * dropped the epitaph's date from the day report (BUGS.md 2026-09-29). Unbalanced text (no
 * matching open paren) yields "" — the guard then treats the bullet as body text, as before. */
function trailingParenthetical(line: string): string {
  if (!line.endsWith(")")) return "";
  let depth = 0;
  for (let i = line.length - 1; i >= 0; i--) {
    const ch = line[i];
    if (ch === ")") depth++;
    else if (ch === "(" && --depth === 0) return line.slice(i + 1, -1);
  }
  return "";
}

/** A text's LAST `<dateRe>` capture — the completion rule both branches of entryDates share:
 * an entry's completion is its LAST dated verb, not the first, because found-by,
 * decomposition, and sibling mentions ("decomposed from the X bug fixed <date>") all precede
 * the completion record, so first-match let a sibling's date steal the entry's count onto the
 * wrong day (BUGS.md 2026-09-29). dateRe is cloned with the g flag so matchAll sees every
 * date; a text with no date yields null. */
function lastDate(text: string, dateRe: RegExp): string | null {
  const global = new RegExp(dateRe.source, dateRe.flags.includes("g") ? dateRe.flags : `${dateRe.flags}g`);
  const all = [...text.matchAll(global)];
  return all[all.length - 1]?.[1] ?? null;
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
        const md = readTextOrNull(file); // Missing or unreadable — no data.
        return md === null ? null : parseEntryDetails(md, sectionTitle);
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
