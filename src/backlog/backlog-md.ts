/** The pure markdown layer of the backlog parsers: fence-aware reading of PLANS.md / BUGS.md /
 * QUESTIONS.md text, with no filesystem access — every function here takes the markdown text as
 * an argument. Split from src/backlog/backlog.ts, which keeps the stat-cached file readers
 * (sectionEntries, the root-based plannedPlans/openBugs/openQuestions family, and the
 * Done/Fixed date scan): consumers who only parse markdown (question-answer.ts's QUESTIONS.md
 * walks, backlog-write.ts's section appends, backlog-structure.ts's stranding checks)
 * import from here without reaching the file/cache layer, and a caller who parses a string never
 * pays for a stat. Both layers share one fenceTracker state machine, so independent readers can
 * never disagree about what is body content. */

/** The repo-root backlog markdown files shared by every layer that knows them by name: the
 * tracked files loops edit and readers parse by `## ` section — read by backlog-structure.ts's
 * structural checks, merge/backlog-conflicts.ts's mechanical insert-conflict resolver, and
 * doctor-backlog.ts's duplicate-heading check. One definition, so the three cannot disagree
 * about which files count. */
export const BACKLOG_FILES = new Set(["PLANS.md", "BUGS.md", "QUESTIONS.md"]);

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
 * bullets) must consult this, so two readers can never disagree about what is body content.
 * `open()` reports whether the tracker is inside a fence where the walk stopped — true when a
 * fence ran unclosed to the walk's end, so a caller that walked a bounded region can tell its
 * read is fence-degraded (the region's tail quoted real structure). */
export function fenceTracker(): { inside(line: string): boolean; open(): boolean } {
  // The open fence's marker (null = none): only a matching bare fence line closes it.
  let fence: { char: string; length: number } | null = null;
  return {
    open(): boolean {
      return fence !== null;
    },
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
          if (marker.startsWith("`") && info.includes("`")) return false;
          fence = { char: marker.charAt(0), length: marker.length };
        }
        else if (marker.startsWith(fence.char) && marker.length >= fence.length && line.trim() === marker)
          fence = null;
        return true; // The fence line itself is fence syntax, never structure.
      }
      return fence !== null;
    },
  };
}

/** The title of a markdown heading line at `prefix` level — or the empty string when the heading
 * carries no text. The prefix's own length drives the slice (never a hard-coded `3`/`4`), so the
 * two heading levels cannot drift. The single home of the heading-title slice, shared by
 * fencedHeadingTitle (which guards it with the fence tracker) and the readers in
 * backlog-structure.ts that already know they hold a heading line: sectionTitles, planHeadingKeys,
 * the stranded-entry and actionable-entry titles, and the in-section boundary compares. */
export function headingTitle(line: string, prefix: "## " | "### "): string {
  return line.slice(prefix.length).trim();
}

/** The trimmed title of `line` when it is a markdown heading line at `prefix` level and not
 * quoted content — null otherwise, including when fenceTracker reports the line inside a fenced
 * code block. The single home of the fence-aware heading guard (`!fenced.inside(line) &&
 * line.startsWith(prefix)` plus headingTitle) that every line-level reader of the backlog
 * docs repeats: sectionLines' section boundaries and parseEntryDetails' entry boundaries here,
 * and question-answer.ts's walks of QUESTIONS.md (the Open/Answered scan, the `### ` block
 * split, and the Answered section's start); that file's two pure next-`## ` boundary walks
 * go through nextSectionHeading below instead. Readers that walk
 * whole documents collecting heading lines go through fenceAwareHeadingLines instead; callers
 * that only need "is this a heading" pass a tracker and compare the title or test for null. */
export function fencedHeadingTitle(
  line: string,
  fenced: ReturnType<typeof fenceTracker>,
  prefix: "## " | "### ",
): string | null {
  return !fenced.inside(line) && line.startsWith(prefix) ? headingTitle(line, prefix) : null;
}

/** The body lines of the `## <sectionTitle>` section of a markdown document: everything
 * between that heading line and the next `## ` line (or EOF), neither boundary included. A
 * `## ` line inside a fenced code block (entries quote markdown templates and shell traces) is
 * body content, never a boundary. The single home of "where a section starts and ends" — every
 * reader of a `## ` section (backlog entry parsing here, the usage report's Done/Fixed date
 * scan in src/report/report-data.ts, and backlog-structure.ts's strandedPlanEntries) walks its
 * section through this, so independent readers can never disagree about the boundary. */
export function sectionLines(md: string, sectionTitle: string): string[] {
  const lines: string[] = [];
  let inSection = false;
  const fenced = fenceTracker();
  for (const line of md.split("\n")) {
    const title = fencedHeadingTitle(line, fenced, "## ");
    if (title !== null) {
      inSection = title === sectionTitle;
      continue;
    }
    if (inSection) lines.push(line);
  }
  return lines;
}

/** The index of the next `## ` section heading at or after `from`, fence-aware through the
 * caller's `fenced` tracker — or `lines.length` when none follows. The section-end boundary
 * rule as an index, for readers that must cut or splice at the boundary rather than collect
 * its content (question-answer.ts cuts the Open section at its end and inserts a moved
 * block before Answered's next `## `; backlog-write.ts cuts the section a filed entry is
 * appended to). Shares fencedHeadingTitle's guard with sectionLines, so
 * a boundary found here is the same boundary sectionLines would stop at. */
export function nextSectionHeading(
  lines: readonly string[],
  from: number,
  fenced: ReturnType<typeof fenceTracker>,
): number {
  for (let i = from; i < lines.length; i++) {
    if (fencedHeadingTitle(lines[i] ?? "", fenced, "## ") !== null) return i;
  }
  return lines.length;
}

/** The body lines of one `## <sectionTitle>` section with fenced content stripped: the
 * sectionLines walk, then a fresh fenceTracker's filter — the shape every reader that
 * classifies a section's lines as markdown structure (entry headings, bullets, dates) walks.
 * Exactly two call sites today: entryDates (below) and backlog-structure.ts's
 * strandedPlanEntries. The fresh tracker is in sync with the document here: sectionLines
 * only recognizes a `## ` boundary outside a fence, so the section's heading line is
 * non-fenced and the fence state at the section's first line is closed — a tracker started
 * there sees exactly what a document-wide tracker sees inside the section. Readers that
 * must KEEP fenced lines as body content (parseEntryDetails) do not use this. */
export function sectionBodyLines(md: string, sectionTitle: string): string[] {
  const fenced = fenceTracker();
  return sectionLines(md, sectionTitle).filter((line) => !fenced.inside(line));
}

/** The heading lines of `md` starting with `prefix` (a `"## "` section heading or a `"### "`
 * entry heading), in file order, fence-aware (fenceTracker): a heading line quoted inside a
 * fenced code block is body text, never structure. The single home of the whole-document
 * prefix-heading walk — backlog-structure.ts's sectionTitles ("## ") and planHeadingKeys
 * ("### ") each carried their own tracker before, so their fence handling could drift from
 * sectionLines'. Callers slice and trim the prefix themselves. (sectionLines does not use
 * this: its walk must track which section it is inside, not just collect headings; readers
 * inside one section go through sectionLines/sectionBodyLines instead.) */
export function fenceAwareHeadingLines(md: string, prefix: "## " | "### "): string[] {
  const fenced = fenceTracker();
  const lines: string[] = [];
  for (const line of md.split("\n")) {
    if (fenced.inside(line)) continue;
    if (line.startsWith(prefix)) lines.push(line);
  }
  return lines;
}

/** The entries inside one `## <sectionTitle>` section of a markdown document, each with its
 * full body: stops at the next `## ` line (so Done/Fixed entries never leak in), skips
 * non-heading placeholders like `_None yet._` and any prose before the first heading, keeps
 * interior blank lines within a body while trimming leading/trailing ones, and ends an open
 * entry's body at EOF as well as at the next heading. */
/** The `Validation gap` tag of one already-parsed entry body — the first line outside a fence
 * matching `` **Validation gap:** <tag> `` (an optional `- ` bullet before the marker is
 * allowed), the tag lowercased, or `null` when no such line exists. Fence-aware because a
 * `## Fixed` body may quote the bug template (the case BUGS.md's "a fix narrative can land on
 * main without its fix" entry records): a quoted `**Validation gap:**` line inside a fenced
 * block is an example, not this entry's own trace, and must not count. The consumer that owns
 * the closed tag vocabulary (the bugfix role guidance's VALIDATION_GAP_TAGS) validates the
 * returned tag; this reader only records that a trace line exists and what it named. Walked
 * line by line through the module's fenceTracker so this reader can never disagree with
 * sectionLines/parseEntryDetails about what is fenced content. Returns the FIRST such line:
 * a body with two validation-gap lines records the first (the tally counts an entry once). */
export function validationGapTag(body: string): string | null {
  const fenced = fenceTracker();
  const re = /^\s*(?:[-*]\s+)?\*\*Validation gap:\*\*\s*([A-Za-z][A-Za-z-]*)/;
  for (const line of body.split("\n")) {
    if (fenced.inside(line)) continue;
    const m = re.exec(line);
    if (m) return (m[1] as string).toLowerCase();
  }
  return null;
}

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
    else {
      const heading = fencedHeadingTitle(line, fenced, "### ");
      if (heading !== null) {
        close();
        title = heading;
      } else {
        bodyLines.push(line);
      }
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
 * completion — "- same shape as the sibling bug (fixed 2026-09-24)" — is not one. The epitaph shape
 * separates them: an epitaph always closes its line with a parenthetical that records both the
 * completion date and the merge commit ("(planned …, done …; commit abc1234)"), so a bullet counts
 * only when its trailing `(…)` group carries the date AND a `commit` reference; a heading entry
 * keeps the plain metadata match (headings are the primary entry format and always close their
 * metadata parenthetical by convention).
 *
 * The LAST dated match is the completion rule when `first` is false (the default): found-by,
 * decomposition, and sibling mentions precede the completion record, so a sibling's date must
 * not steal the count. `first` selects the FIRST dated match instead — the filing rule the
 * filing read uses, matching the canonical `filingDate` (via firstDate). */
export function entryDates(
  md: string,
  sectionTitle: string,
  dateRe: RegExp,
  first = false,
): string[] {
  const dates: string[] = [];
  const pick = first ? firstDate : lastDate;
  const lines = sectionBodyLines(md, sectionTitle);
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
      if (/\bcommits?\b/.test(tail)) date = pick(tail, dateRe);
    } else {
      date = pick(meta.text, dateRe);
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
 * paragraph is body, never matched). A continuation is joined ONLY when the start line leaves a
 * parenthetical open: a heading that already balances its parens has no wrapped metadata, so the
 * body lines after it — which may themselves end in a stamp-like `(planned …)`/`(reported …)` —
 * are never pulled into the join (BUGS.md 2026-10-09). Joining with a space keeps "done\n2026-…"
 * matchable. Returns the joined text and the index of the first line NOT consumed as metadata,
 * so a walker can resume its scan there. Extracted from entryDates (its only original caller) so
 * the stranded-plan detector (src/backlog/backlog-structure.ts) matches dates against exactly the
 * same joined text instead of growing a second, drifting copy of the join rule. */
export function headingMetadata(lines: string[], start: number): { text: string; next: number } {
  const line = lines[start] ?? "";
  const meta: string[] = [line];
  // A wrapped heading's first line opens a parenthetical its continuation will close; an
  // unbalanced count is therefore the only shape that has metadata beyond the first line.
  const wrapped =
    (line.match(/\(/g) ?? []).length > (line.match(/\)/g) ?? []).length;
  let closed = line.endsWith(")");
  let j = start + 1;
  // Continuation is a heading-only concern (wrapped headings); bullets are single-line.
  while (wrapped && line.startsWith("### ") && meta.length < 3 && j < lines.length && !closed) {
    const next = lines[j] ?? "";
    if (next.startsWith("### ") || next.startsWith("- ")) break; // The entry ends at the next start.
    meta.push(next);
    j++;
    closed = next.endsWith(")");
  }
  return { text: meta.join(" "), next: j };
}

/** A `- ` line's or `### ` heading's trailing parenthetical's inner text, nesting-aware: a
 * backward scan from the text's closing ")" to its matching "(" returns the group's FULL inner
 * text, so an epitaph that quotes a parenthetical of its own — "(planned …, done …; commit
 * abc1234 (re-landed after review fix))" — still yields its date-bearing text. The previous
 * flat `\([^()]*\)$` match saw only the innermost group ("" when the line ended in two closes)
 * and silently dropped the epitaph's date from the day report (BUGS.md 2026-09-29). Unbalanced
 * text (no matching open paren) yields "" — the guard then treats the bullet as body text, as
 * before. The one home for this rule: entryDates reads it for `- ` epitaphs and
 * backlog-eligibility.ts's requiredParts for a heading's prerequisite clause (falling back to
 * openParenthetical when the heading's parenthetical wraps past the line). */
export function trailingParenthetical(line: string): string {
  if (!line.endsWith(")")) return "";
  let depth = 0;
  for (let i = line.length - 1; i >= 0; i--) {
    const ch = line[i];
    if (ch === ")") depth++;
    else if (ch === "(" && --depth === 0) return line.slice(i + 1, -1);
  }
  return "";
}

/** The text after the outermost "(" still open at the end of `line`, or "" when every group
 * closes: a wrapped `### ` heading's stamp parenthetical continues on the following lines, so
 * the heading line has no closing ")". A ")" at depth 0 is ignored. */
export function openParenthetical(line: string): string {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "(") {
      if (depth++ === 0) open = i;
    } else if (ch === ")" && depth > 0) depth--;
  }
  return depth > 0 ? line.slice(open + 1) : "";
}

/** A text's LAST `<dateRe>` capture — the completion rule both branches of entryDates share:
 * an entry's completion is its LAST dated verb, not the first, because found-by,
 * decomposition, and sibling mentions ("decomposed from the X bug fixed <date>") all precede
 * the completion record, so first-match let a sibling's date steal the entry's count onto the
 * wrong day (BUGS.md 2026-09-29). Also read by completionDate (backlog.ts) for the finished-entry
 * listings. dateRe is cloned with the g flag so matchAll sees every
 * date; a text with no date yields null. */
export function lastDate(text: string, dateRe: RegExp): string | null {
  const global = new RegExp(dateRe.source, dateRe.flags.includes("g") ? dateRe.flags : `${dateRe.flags}g`);
  const all = [...text.matchAll(global)];
  return all[all.length - 1]?.[1] ?? null;
}

/** A text's FIRST `<dateRe>` capture — the filing rule, the mirror of lastDate: an entry's
 * filing month is its FIRST stamp verb, because a later re-filing or a cross-reference
 * ("found by bugfix <date>; found by doctor <date>") records a later date that must not move
 * the filing onto a later day. This is the same first-match the canonical `filingDate`
 * (backlog.ts) applies to a heading line, so the filing read and `plan|bug --list`'s age agree
 * about when an entry opened. dateRe is cloned with the g flag so matchAll sees every date; a
 * text with no date yields null. Module-local: entryDates (its only caller) selects it with
 * `first`, so the walker stays single-homed like lastDate's completion rule. */
function firstDate(text: string, dateRe: RegExp): string | null {
  const global = new RegExp(dateRe.source, dateRe.flags.includes("g") ? dateRe.flags : `${dateRe.flags}g`);
  const match = global.exec(text);
  return match?.[1] ?? null;
}
