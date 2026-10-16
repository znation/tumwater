// vocabulary: plain
/** The entry-writing half of `tumwater bug` and `tumwater plan` — the operator-authored
 * backlog writes, mirroring the read half in backlog.ts: file a bug into BUGS.md's `## Open`
 * or a plan request into PLANS.md's `## Planned`, stamped the way loops write those
 * entries, and cancel, edit, release, or show an entry by position. The markdown surgery is
 * more than a dispatch case: the entry must land after the section's last
 * entry and before the next `## ` heading, fenced-safe (a `## ` line quoted inside an
 * entry's code fence is body text, never a boundary — the same fenceTracker every backlog
 * reader consults), and a file tumwater init never seeded is created with init's template
 * rather than failing. Flag classification, preflights, and the printed confirmations live
 * in backlog-cli.ts; the wake of the loop that should act stays in cli.ts beside the other
 * command bodies. */
import path from "node:path";
import { fencedHeadingTitle, fenceTracker, headingMetadata, nextSectionHeading } from "./backlog-md.js";
import { actionableEntryRanges, stripEntryStamp, type ActionableEntryRange } from "./backlog-structure.js";
import { readTextIfExists, writeTextAtomic } from "../files/files.js";
import { formatDate } from "../text/datetime.js";
import { fail } from "../cli/cli-output.js";
import { backlogHolds, type EntryHold, withoutRefusalNotes } from "./backlog-eligibility.js";
import { collapseWhitespace, trimLeadingBlankLines, trimTrailingBlankLines } from "../text/text.js";
import { BUGS_TEMPLATE, PLANS_TEMPLATE } from "../init/init.js";
import { withStateLock } from "../concurrency/lock.js";
import { primaryWorktreeLockPath } from "../paths.js";

/** Today's stamp body every operator-filed entry carries, parenthesized by the caller that
 * builds the heading. Computed once per call (not module load) so a long-lived process
 * stamps with the date it filed on. */
const operatorStamp = () => `reported by the user ${formatDate(new Date())}`;

/** The kind's open-section markdown file and its `## ` heading: bugs live in BUGS.md's `Open`
 * section, plan requests in PLANS.md's `Planned`. Every position-based writer (cancel, edit,
 * release, show) resolves the same pair. */
function backlogTarget(kind: "bug" | "plan"): { fileName: string; sectionTitle: string } {
  return kind === "bug"
    ? { fileName: "BUGS.md", sectionTitle: "Open" }
    : { fileName: "PLANS.md", sectionTitle: "Planned" };
}

/** The section-append entry point: run the whole read-modify-write under the cross-process
 * primary-worktree lock (paths.ts), which a landing's working-tree fast-forward (`ffMainTo`)
 * takes too, so a filed entry and a landed change to the same backlog file cannot each clobber
 * the other. The section is one read plus one atomic rename — short, never held across a build
 * check — and withStateLock creates the state dir the lock lives under on first use. */
function appendEntry(
  root: string,
  fileName: string,
  template: string,
  sectionTitle: string,
  heading: string,
  body: string,
): void {
  withStateLock(primaryWorktreeLockPath(root), () =>
    appendEntryLocked(root, fileName, template, sectionTitle, heading, body),
  );
}

/** Append one `### ` entry to `<root>/<fileName>`'s `## <sectionTitle>` section, fence-safe
 * and placeholder-aware. The single home of the write-side walk the two file commands share:
 * locate the section's heading (a missing section or missing file falls back to the init
 * template's scaffolding), cut the section's content, drop its `_None yet._` placeholder
 * (a placeholder means "no entries", so leaving it above the new entry would claim the
 * section is empty), and append the entry before the next `## ` heading — a heading line
 * quoted inside a fenced block (entries quote markdown and shell traces) is body text,
 * never the boundary, per the shared fenceTracker. */
function appendEntryLocked(
  root: string,
  fileName: string,
  template: string,
  sectionTitle: string,
  heading: string,
  body: string,
): void {
  const file = path.join(root, fileName);
  // Read-then-write: an unreadable file must fail here, not read as "absent" and get seeded
  // over (readTextIfExists tolerates only ENOENT — a transient EACCES must not destroy entries).
  const md = readTextIfExists(file) ?? template;
  const lines = md.split("\n");
  // Find the section's heading line (fence-aware; a `## <sectionTitle>` quoted in a fence
  // is never it), then the section's end at the next real `## ` line.
  const fenced = fenceTracker();
  let sectionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (fencedHeadingTitle(lines[i] ?? "", fenced, "## ") === sectionTitle) {
      sectionIdx = i;
      break;
    }
  }
  if (sectionIdx === -1) {
    // The file exists but lacks the section: grow it at the end with the section plus the
    // entry, so the write never silently drops the entry.
    const grown = `${md.replace(/\n+$/, "")}\n\n## ${sectionTitle}\n\n${heading}${body === "" ? "" : `\n\n${body}`}\n`;
    writeTextAtomic(file, grown.endsWith("\n") ? grown : `${grown}\n`);
    return;
  }
  // The section's end is the next real `## ` boundary after its heading — the same
  // fence-aware boundary walk the readers use, through backlog-md.ts's nextSectionHeading.
  const sectionEnd = nextSectionHeading(lines, sectionIdx + 1, fenceTracker());
  // The section's content between its heading and its end: real entries, with any
  // `_None yet._` skeleton placeholder dropped (fence-aware — a quoted placeholder line is
  // quoted content, not the marker) and the edge blanks trimmed.
  const fencedContent = fenceTracker();
  const content = lines
    .slice(sectionIdx + 1, sectionEnd)
    .filter((line) => fencedContent.inside(line) || line.trim() !== "_None yet._");
  trimLeadingBlankLines(content);
  trimTrailingBlankLines(content);
  const rest = lines.slice(sectionEnd);
  // One blank line after the entry block, before whatever follows the section: the trailing blanks
  // the trim above popped were the separator between the section and the next `## ` heading, and
  // without restoring one here the filed entry's heading abuts that heading — the only writer of
  // these files that produced a heading-on-heading join. The edge blanks are the trim helpers'
  // (text.ts's trimLeadingBlankLines/trimTrailingBlankLines). When the section ends at EOF the
  // blank is the file's trailing newline shape, never an extra line.
  const out = [
    ...lines.slice(0, sectionIdx + 1),
    ...(content.length > 0 ? ["", ...content] : []),
    "",
    heading,
    ...(body === "" ? [] : ["", body]),
    "",
    ...rest,
  ];
  writeTextAtomic(file, out.join("\n"));
}

/** The noun a cancel failure names the section by: the plan example's `no open bug at
 * position N`, and the parallel planned-feature wording for PLANS.md. */
export function sectionNoun(sectionTitle: string): string {
  if (sectionTitle === "Open") return "open bug";
  if (sectionTitle === "Planned") return "planned feature";
  return sectionTitle.toLowerCase();
}

/** The nth (1-based, as `tumwater backlog` lists it) actionable entry of `<fileName>`'s
 * `## <sectionTitle>` section, or a failure naming the section but not the position — the
 * shared lookup and out-of-range wording both the remove and the edit lock hold. */
function locateEntry(
  md: string,
  fileName: string,
  sectionTitle: string,
  n: number,
): ActionableEntryRange {
  const entry = findEntry(md, sectionTitle, n);
  if (entry === undefined) {
    const count = actionableEntryRanges(md, sectionTitle).length;
    fail(`no ${sectionNoun(sectionTitle)} at position ${n} (${count} in ${fileName})`);
  }
  return entry;
}

/** The non-exiting lookup under locateEntry: the nth (1-based) actionable entry of the section,
 * or undefined when the position is out of range. */
function findEntry(md: string, sectionTitle: string, n: number): ActionableEntryRange | undefined {
  return actionableEntryRanges(md, sectionTitle)[n - 1];
}

/** The shared read half of the two in-place entry rewrites (remove and edit): resolve the
 * file, read it — an absent file is an empty section, never a seed, since cancel removes and
 * edit rewrites but neither writes scaffolding — locate the nth actionable entry, and split
 * the text into the lines the splice operates on. */
function readEntryLines(
  root: string,
  fileName: string,
  sectionTitle: string,
  n: number,
): { file: string; lines: string[]; entry: ActionableEntryRange } {
  const file = path.join(root, fileName);
  const md = readTextIfExists(file) ?? "";
  const entry = locateEntry(md, fileName, sectionTitle, n);
  return { file, lines: md.split("\n"), entry };
}

/** The section-remove entry point, the appendEntry analogue: the same cross-process lock, so a
 * cancel and a landing's working-tree fast-forward cannot each clobber the other's
 * read-modify-write. */
function removeEntry(
  root: string,
  fileName: string,
  sectionTitle: string,
  n: number,
): { file: string; title: string } {
  return withStateLock(primaryWorktreeLockPath(root), () =>
    removeEntryLocked(root, fileName, sectionTitle, n),
  );
}

/** Remove the `n`th entry (1-based, as `tumwater backlog` lists it) from `<root>/<fileName>`'s
 * `## <sectionTitle>` section. The ranges come from actionableEntryRanges (backlog-structure.ts),
 * whose walk is fence-aware, so a `## `/`### ` line quoted inside an entry's code fence is body
 * text: slicing the range removes the heading and its body whole without mistaking a quoted line
 * for the boundary. An out-of-range position (an empty section, or one holding only the
 * `_None yet._` placeholder, has no entries) fails, writing nothing. The range carries the blank
 * line that separated the entry from the next heading, so the join leaves exactly one blank line
 * between the preceding content and whatever followed. */
function removeEntryLocked(
  root: string,
  fileName: string,
  sectionTitle: string,
  n: number,
): { file: string; title: string } {
  const { file, lines, entry } = readEntryLines(root, fileName, sectionTitle, n);
  spliceOutEntry(file, lines, entry);
  return { file: fileName, title: entry.title };
}

/** Write `lines` back to `file` without `entry`'s range. The range's end is the 1-based line
 * before the next heading (the separating blank line at a well-formed section); start-1/end-1
 * are its 0-based bounds, and the length is end-start+1. */
function spliceOutEntry(file: string, lines: string[], entry: ActionableEntryRange): void {
  lines.splice(entry.start - 1, entry.end - entry.start + 1);
  writeTextAtomic(file, lines.join("\n"));
}

/** What `tryCancelEntry` did: `cancelled` wrote the file; `gone` (no entry at the position) and
 * `moved` (the entry there is not the title the caller saw) refuse as data, writing nothing. */
export type CancelEntryOutcome =
  | { status: "cancelled"; file: string; title: string }
  | { status: "gone" }
  | { status: "moved"; title: string };

/** The non-exiting cancel the dashboard calls: removeEntry's lock and splice, but an
 * out-of-range position is `gone` and a different heading at the position is `moved`, both
 * decided inside the lock. `expectedTitle` is the heading the caller saw (the status payload's
 * `plans`/`bugs` strings, the same `### ` text as ActionableEntryRange.title). */
export function tryCancelEntry(
  root: string,
  kind: "bug" | "plan",
  n: number,
  expectedTitle: string,
): CancelEntryOutcome {
  const { fileName, sectionTitle } = backlogTarget(kind);
  return withStateLock(primaryWorktreeLockPath(root), () => {
    const file = path.join(root, fileName);
    const md = readTextIfExists(file) ?? "";
    const entry = findEntry(md, sectionTitle, n);
    if (entry === undefined) return { status: "gone" };
    if (entry.title !== expectedTitle) return { status: "moved", title: entry.title };
    spliceOutEntry(file, md.split("\n"), entry);
    return { status: "cancelled", file: fileName, title: entry.title };
  });
}

/** The section-edit entry point, the appendEntry/removeEntry analogue: the same
 * cross-process lock, so an edit and a landing's working-tree fast-forward cannot each clobber
 * the other's read-modify-write. */
function editEntry(
  root: string,
  fileName: string,
  sectionTitle: string,
  n: number,
  title: string,
  body: string,
): { file: string; title: string } {
  return withStateLock(primaryWorktreeLockPath(root), () =>
    editEntryLocked(root, fileName, sectionTitle, n, title, body),
  );
}

/** Replace the `n`th entry (1-based, as `tumwater backlog` lists it) of `<root>/<fileName>`'s
 * `## <sectionTitle>` section with `### <title><stamp>` plus `body`, in place: the entry keeps
 * its position and its original trailing stamp parenthetical. The ranges come from
 * actionableEntryRanges (backlog-structure.ts), whose fence-aware walk means a `## `/`### `
 * line quoted inside an entry's code fence is body text, so the spliced range covers exactly
 * the heading and body without mistaking a quoted line for the boundary. The stamp is the
 * trailing suffix of the JOINED heading metadata (headingMetadata folds a wrapped heading onto
 * one line), sliced off the stamp-stripped text (stripEntryStamp) — empty when the heading
 * carries no `(planned …)`/`(reported …)` parenthetical. An out-of-range position fails,
 * writing nothing. The rebuilt entry keeps the append/remove blank-line shape: one blank line
 * before whatever followed, and none at EOF. */
function editEntryLocked(
  root: string,
  fileName: string,
  sectionTitle: string,
  n: number,
  title: string,
  body: string,
): { file: string; title: string } {
  const { file, lines, entry } = readEntryLines(root, fileName, sectionTitle, n);
  spliceInEditedEntry(file, lines, entry, title, body);
  return { file: fileName, title };
}

/** Write `lines` back to `file` with `entry`'s range replaced by `### <title><stamp>` plus
 * `body`: the stamp is the trailing suffix of the entry's joined heading metadata (empty with no
 * parenthetical). Shared by the CLI edit and tryEditEntry so the two cannot drift. */
function spliceInEditedEntry(
  file: string,
  lines: string[],
  entry: ActionableEntryRange,
  title: string,
  body: string,
): void {
  const metaText = headingMetadata(lines, entry.start - 1).text;
  const stamp = metaText.slice(stripEntryStamp(metaText).length);
  // rest starts at the line after the range's last line: for a well-formed section that is the
  // next `## `/`### ` heading, since the range already carried the separating blank line.
  const rest = lines.slice(entry.end);
  const rebuilt = [`### ${title}${stamp}`, ...(body === "" ? [] : ["", body])];
  // One blank line before whatever follows, unless the entry is the file's last content (then
  // rest is empty or only the phantom line the trailing newline splits off, and the file keeps
  // its existing trailing-newline shape).
  if (rest.some((line) => line.trim() !== "")) rebuilt.push("");
  lines.splice(entry.start - 1, entry.end - entry.start + 1, ...rebuilt);
  writeTextAtomic(file, lines.join("\n"));
}

/** Why `body` cannot be written as an entry body, or null: a `## `/`### ` heading line outside a
 * code fence, or a fence left open, would make actionableEntryRanges misread what follows. */
export function bodyStructureProblem(body: string): string | null {
  const tracker = fenceTracker();
  for (const line of body.split("\n")) {
    // inside() advances the fence state, so ask it once per line: "## " and "### " are
    // distinct prefixes (a `### ` line never starts with `## `), so one level check covers both.
    if (!tracker.inside(line) && (line.startsWith("## ") || line.startsWith("### "))) {
      return "the body may not contain a `## `/`### ` heading line outside a code fence";
    }
  }
  return tracker.open() ? "the body leaves a code fence open" : null;
}

/** What `tryEditEntry` did, the CancelEntryOutcome shape: `edited` wrote the file; `gone` and
 * `moved` refuse as data, writing nothing. */
export type EditEntryOutcome =
  | { status: "edited"; file: string; title: string }
  | { status: "gone" }
  | { status: "moved"; title: string };

/** The non-exiting, title-checked edit the dashboard calls: editEntry's lock and splice, with the
 * body's line structure kept (no whitespace fold). The caller validates (bodyStructureProblem,
 * non-empty title) first, since fail() exits the process. */
export function tryEditEntry(
  root: string,
  kind: "bug" | "plan",
  n: number,
  expectedTitle: string,
  rawTitle: string,
  rawBody: string,
): EditEntryOutcome {
  const { fileName, sectionTitle } = backlogTarget(kind);
  const title = stripEntryStamp(collapseWhitespace(rawTitle));
  const body = rawBody.replace(/\r\n?/g, "\n").trim();
  return withStateLock(primaryWorktreeLockPath(root), () => {
    const file = path.join(root, fileName);
    const md = readTextIfExists(file) ?? "";
    const entry = findEntry(md, sectionTitle, n);
    if (entry === undefined) return { status: "gone" };
    if (entry.title !== expectedTitle) return { status: "moved", title: entry.title };
    spliceInEditedEntry(file, md.split("\n"), entry, title, body);
    return { status: "edited", file: fileName, title };
  });
}

/** The result one file command returns: the file written, the entry's title (verbatim
 * heading text, the same string the backlog readers list), and the stamp it carried — the
 * {file, title, stamp} payload `--json` prints. */
export interface FiledEntry {
  file: string;
  title: string;
  stamp: string;
}

/** Split a markdown entry file into its title and body: the title is the first non-blank line
 * (a leading `#`-marker stripped, folded through collapseWhitespace), the body every later
 * line kept as written with trailing whitespace stripped and edge blank lines dropped. */
export function splitEntryFile(text: string): { title: string; body: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((line) => line.trim() !== "");
  if (at < 0) return { title: "", body: "" };
  const title = collapseWhitespace((lines[at] ?? "").replace(/^\s*#{1,6}\s+/, ""));
  return { title, body: normalizeEntryBody(lines.slice(at + 1).join("\n")) };
}

/** Normalize an entry body: CRLF to LF, trailing whitespace stripped from each line, edge
 * blank lines dropped, inner blank lines kept. */
export function normalizeEntryBody(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd());
  trimLeadingBlankLines(lines);
  trimTrailingBlankLines(lines);
  return lines.join("\n");
}

/** Fail with the kind's empty-field usage line when the title/symptom is empty: the plan
 * form names its missing field a "title", the bug form a "symptom". The single home of those
 * two strings, shared by the inline, `--file`, and `--edit` forms so the CLI and dashboard
 * can't drift. */
function requireEntryTitle(kind: "bug" | "plan", title: string, usage: string): void {
  if (title === "") fail(kind === "plan" ? `plan needs a title: ${usage}` : `bug needs a symptom: ${usage}`);
}

/** Fail when a split `--file` body would grow a phantom section (bodyStructureProblem). verb is
 * the CLI verb in the message: "filed" for `--file`, "written" for `--edit <n> --file`. */
function requireBodyStructurallySound(body: string, verb: "filed" | "written"): void {
  const problem = bodyStructureProblem(body);
  if (problem) fail(`the --file body cannot be ${verb}: ${problem}`);
}

/** File an already-validated title and body under PLANS.md's `## Planned` (plan) or BUGS.md's
 * `## Open` (bug). Shared by the `--file` forms and the dashboard file endpoint; the caller has
 * checked the title is non-empty and the body passes bodyStructureProblem. */
export function fileEntryWithBody(root: string, kind: "bug" | "plan", title: string, body: string): FiledEntry {
  const t = collapseWhitespace(title);
  return kind === "plan"
    ? appendOperatorEntry(root, "PLANS.md", PLANS_TEMPLATE, "Planned", t, body)
    : appendOperatorEntry(root, "BUGS.md", BUGS_TEMPLATE, "Open", t, body);
}

/** `tumwater plan --file`: file the markdown file's title and line-for-line body under
 * PLANS.md's `## Planned`. A body that would grow a phantom section writes nothing. */
export function filePlanFromText(root: string, text: string, usage: string): FiledEntry {
  const { title, body } = splitEntryFile(text);
  requireEntryTitle("plan", title, usage);
  requireBodyStructurallySound(body, "filed");
  return fileEntryWithBody(root, "plan", title, body);
}

/** `tumwater bug --file`: the bug twin of filePlanFromText, under BUGS.md's `## Open`. */
export function fileBugFromText(root: string, text: string, usage: string): FiledEntry {
  const { title, body } = splitEntryFile(text);
  requireEntryTitle("bug", title, usage);
  requireBodyStructurallySound(body, "filed");
  return fileEntryWithBody(root, "bug", title, body);
}

/** The loop prompt a filed bug wakes the `bugfix` loop with — one wording for the CLI's
 * `tumwater bug` and the dashboard's backlog-file endpoint. */
export function bugWakeText(title: string): string {
  return `The user filed a new bug with \`tumwater bug\`: "${title}" — it is under BUGS.md ## Open; fix it.`;
}

/** The loop prompt a requested plan wakes the `feature` loop with, shared like bugWakeText. */
export function planWakeText(title: string): string {
  return `The user requested a plan with \`tumwater plan\`: "${title}" — it is under PLANS.md ## Planned; flesh out the plan stub.`;
}

/** The loop each operator-filed kind wakes and the wording it wakes it with, keyed by the
 * kind the dashboard posts. */
export const OPERATOR_FILE_KINDS = {
  bug: { role: "bugfix", wakeText: bugWakeText },
  plan: { role: "feature", wakeText: planWakeText },
} as const;

/** The one home of an operator-filed entry's shape — the pairing fileBug and filePlan both
 * perform: stamp the entry, build the `### <title> (<stamp>)` heading, append it under the
 * section through appendEntry, and return the FiledEntry the confirmation prints. fileBug files
 * under BUGS.md's `## Open` with no body; filePlan under PLANS.md's `## Planned` with the
 * folded body. */
function appendOperatorEntry(
  root: string,
  fileName: string,
  template: string,
  sectionTitle: string,
  title: string,
  body: string,
): FiledEntry {
  const stamp = operatorStamp();
  appendEntry(root, fileName, template, sectionTitle, `### ${title} (${stamp})`, body);
  return { file: fileName, title, stamp };
}

/** `tumwater bug "<symptom>"`: append one `### <symptom> (reported by the user <date>)`
 * entry to BUGS.md's `## Open`. The symptom is operator prose, so it folds to one line
 * (collapseWhitespace, the questions answer precedent) — a multi-line raw text could carry
 * a `## `/`### ` line and grow a phantom section no reader wrote. An empty symptom fails
 * with the usage line and writes nothing. */
export function fileBug(root: string, rawText: string, usage: string): FiledEntry {
  const symptom = collapseWhitespace(rawText);
  requireEntryTitle("bug", symptom, usage);
  return appendOperatorEntry(root, "BUGS.md", BUGS_TEMPLATE, "Open", symptom, "");
}

/** `tumwater plan "<title>" [body...]`: append one `### <title> (reported by the user
 * <date>)` entry to PLANS.md's `## Planned`, with the optional body as the entry text. No
 * goal/approach/acceptance-criteria scaffolding is invented — the feature loop's
 * plan-refinement pass fleshes the stub out on pickup. An empty title fails with the usage
 * line and writes nothing. */
export function filePlan(root: string, rawTitle: string, rawBody: string, usage: string): FiledEntry {
  const title = collapseWhitespace(rawTitle);
  requireEntryTitle("plan", title, usage);
  return appendOperatorEntry(root, "PLANS.md", PLANS_TEMPLATE, "Planned", title, collapseWhitespace(rawBody));
}

/** `tumwater bug --cancel <n>`: remove the nth entry from BUGS.md's `## Open`, as
 * `tumwater backlog` lists it. The returned title is the removed `### ` heading's text. */
export function cancelBug(root: string, n: number): { file: string; title: string } {
  return removeEntry(root, "BUGS.md", "Open", n);
}

/** `tumwater plan --cancel <n>`: remove the nth entry from PLANS.md's `## Planned`, as
 * `tumwater backlog` lists it. The returned title is the removed `### ` heading's text. */
export function cancelPlan(root: string, n: number): { file: string; title: string } {
  return removeEntry(root, "PLANS.md", "Planned", n);
}

/** `tumwater plan --edit <n> --file`: rewrite the nth `## Planned` entry from a markdown file,
 * title and body kept line for line (splitEntryFile), position and original stamp kept. A body
 * that would grow a phantom section writes nothing. */
export function editPlanFromText(root: string, n: number, text: string, usage: string): { file: string; title: string } {
  const { title: rawTitle, body } = splitEntryFile(text);
  // A first line pasted back as the full heading carries the entry's stamp; the splice re-adds it.
  const title = stripEntryStamp(rawTitle);
  requireEntryTitle("plan", title, usage);
  requireBodyStructurallySound(body, "written");
  return editEntry(root, "PLANS.md", "Planned", n, title, body);
}

/** `tumwater bug --edit <n> --file`: the bug twin of editPlanFromText over `## Open`. The body is
 * written as the file gives it, so a bug filed with `--file` can be revised with its body. */
export function editBugFromText(root: string, n: number, text: string, usage: string): { file: string; title: string } {
  const { title: rawTitle, body } = splitEntryFile(text);
  const title = stripEntryStamp(rawTitle);
  requireEntryTitle("bug", title, usage);
  requireBodyStructurallySound(body, "written");
  return editEntry(root, "BUGS.md", "Open", n, title, body);
}

/** `tumwater bug --edit <n> "<symptom>"`: replace the nth BUGS.md `## Open` entry's heading
 * text with the new symptom, keeping its position and its original `(reported by …)` stamp.
 * The symptom folds to one line (collapseWhitespace, the fileBug rule), so it can never grow
 * a phantom section; an empty one fails with the usage line and writes nothing. A bug has no
 * body, so the rebuilt entry is its heading alone. */
export function editBug(root: string, n: number, rawText: string, usage: string): { file: string; title: string } {
  const symptom = collapseWhitespace(rawText);
  requireEntryTitle("bug", symptom, usage);
  return editEntry(root, "BUGS.md", "Open", n, symptom, "");
}

/** `tumwater plan --edit <n> "<title>" [body...]`: replace the nth PLANS.md `## Planned`
 * entry's heading and body, keeping its position and its original `(planned …)`/`(reported …)`
 * stamp. Both title and body fold to one line (collapseWhitespace), so neither can grow a
 * phantom section; an empty title fails with the usage line and writes nothing. */
export function editPlan(
  root: string,
  n: number,
  rawTitle: string,
  rawBody: string,
  usage: string,
): { file: string; title: string } {
  const title = collapseWhitespace(rawTitle);
  requireEntryTitle("plan", title, usage);
  const body = collapseWhitespace(rawBody);
  return editEntry(root, "PLANS.md", "Planned", n, title, body);
}

/** Drop the Refused note from `entry`'s slice of `lines`, in place. False (and `lines` untouched)
 * when the entry carries no note; shared by releaseEntry and tryReleaseEntry so they cannot
 * drift. */
function liftRefusal(lines: string[], entry: ActionableEntryRange): boolean {
  const slice = lines.slice(entry.start - 1, entry.end);
  const kept = withoutRefusalNotes(slice);
  if (kept.length === slice.length) return false;
  lines.splice(entry.start - 1, slice.length, ...kept);
  return true;
}

/** What `tryReleaseEntry` did: `released` wrote the file; `gone`, `moved` and `not_refused`
 * refuse as data, writing nothing. */
export type ReleaseEntryOutcome =
  | { status: "released"; file: string; title: string }
  | { status: "gone" }
  | { status: "moved"; title: string }
  | { status: "not_refused"; title: string };

/** The non-exiting release the dashboard calls: releaseEntry's splice with tryCancelEntry's
 * title check, all decided inside the lock. */
export function tryReleaseEntry(
  root: string,
  kind: "bug" | "plan",
  n: number,
  expectedTitle: string,
): ReleaseEntryOutcome {
  const { fileName, sectionTitle } = backlogTarget(kind);
  return withStateLock(primaryWorktreeLockPath(root), () => {
    const file = path.join(root, fileName);
    const md = readTextIfExists(file) ?? "";
    const entry = findEntry(md, sectionTitle, n);
    if (entry === undefined) return { status: "gone" };
    if (entry.title !== expectedTitle) return { status: "moved", title: entry.title };
    const lines = md.split("\n");
    if (!liftRefusal(lines, entry)) return { status: "not_refused", title: entry.title };
    writeTextAtomic(file, lines.join("\n"));
    return { status: "released", file: fileName, title: entry.title };
  });
}

/** Lift the Refused note from the `n`th entry (1-based, as `--list` numbers them) of the
 * kind's open section and write the file, under the same lock the cancel and edit writers hold.
 * An out-of-range position fails with locateEntry's wording; an entry without a Refused note
 * fails too, writing nothing. */
export function releaseEntry(root: string, kind: "bug" | "plan", n: number): { file: string; title: string } {
  const { fileName, sectionTitle } = backlogTarget(kind);
  return withStateLock(primaryWorktreeLockPath(root), () => {
    const { file, lines, entry } = readEntryLines(root, fileName, sectionTitle, n);
    if (!liftRefusal(lines, entry)) fail(`${kind} #${n} "${entry.title}" carries no Refused note`);
    writeTextAtomic(file, lines.join("\n"));
    return { file: fileName, title: entry.title };
  });
}

/** Move the `n`th entry (1-based, as `--list` numbers them) of the kind's open section to the
 * head of that section and write the file, under the same lock as the other writers. Position
 * 1 fails ("is already first") and an out-of-range one fails with locateEntry's wording, both
 * writing nothing. The entry's lines move byte for byte; only the blank lines around the cut
 * and the splice are normalized, and an entry that was the file's last content leaves the file
 * ending as it did before the move (a trailing newline iff it had one). */
export function moveEntryToTop(root: string, kind: "bug" | "plan", n: number): { file: string; title: string } {
  const { fileName, sectionTitle } = backlogTarget(kind);
  return withStateLock(primaryWorktreeLockPath(root), () => {
    const { file, lines, entry } = readEntryLines(root, fileName, sectionTitle, n);
    if (n === 1) fail(`${kind} #1 "${entry.title}" is already first`);
    spliceEntryToTop(lines, sectionTitle, entry);
    writeTextAtomic(file, lines.join("\n"));
    return { file: fileName, title: entry.title };
  });
}

/** Cut `entry` out of `lines` and put it at the head of the section, in place; shared by
 * moveEntryToTop and tryMoveEntryToTop so their bytes cannot drift. */
function spliceEntryToTop(lines: string[], sectionTitle: string, entry: ActionableEntryRange): void {
  const first = findEntry(lines.join("\n"), sectionTitle, 1) as ActionableEntryRange;
  const endsWithNewline = lines[lines.length - 1] === "";
  const atEof = lines.slice(entry.end).every((l) => l.trim() === "");
  const cut = lines.slice(entry.start - 1, entry.end);
  trimTrailingBlankLines(cut);
  lines.splice(entry.start - 1, entry.end - entry.start + 1);
  if (atEof) {
    trimTrailingBlankLines(lines);
    if (endsWithNewline) lines.push("");
  }
  lines.splice(first.start - 1, 0, ...cut, "");
}

/** What `tryMoveEntryToTop` did: `moved_to_top` wrote the file; `gone`, `moved` and
 * `already_first` refuse as data, writing nothing. */
export type MoveEntryOutcome =
  | { status: "moved_to_top"; file: string; title: string }
  | { status: "gone" }
  | { status: "moved"; title: string }
  | { status: "already_first"; title: string };

/** The non-exiting reorder the dashboard calls: moveEntryToTop's splice with tryReleaseEntry's
 * title check, all decided inside the lock. */
export function tryMoveEntryToTop(
  root: string,
  kind: "bug" | "plan",
  n: number,
  expectedTitle: string,
): MoveEntryOutcome {
  const { fileName, sectionTitle } = backlogTarget(kind);
  return withStateLock(primaryWorktreeLockPath(root), () => {
    const file = path.join(root, fileName);
    const md = readTextIfExists(file) ?? "";
    const entry = findEntry(md, sectionTitle, n);
    if (entry === undefined) return { status: "gone" };
    if (entry.title !== expectedTitle) return { status: "moved", title: entry.title };
    if (n === 1) return { status: "already_first", title: entry.title };
    const lines = md.split("\n");
    spliceEntryToTop(lines, sectionTitle, entry);
    writeTextAtomic(file, lines.join("\n"));
    return { status: "moved_to_top", file: fileName, title: entry.title };
  });
}

/** The nth entry as the markdown file `--edit <n> --file` reads back: the stamp-stripped title
 * and the body with its indentation kept (read from the raw lines, not the trimmed
 * BacklogEntry.body), plus the entry's eligibility hold. Read-only. */
export function showEntry(
  root: string,
  kind: "bug" | "plan",
  n: number,
): { position: number; title: string; body: string; hold: EntryHold } {
  const { fileName, sectionTitle } = backlogTarget(kind);
  const { lines, entry } = readEntryLines(root, fileName, sectionTitle, n);
  const meta = headingMetadata(lines, entry.start - 1);
  const title = collapseWhitespace(stripEntryStamp(meta.text.replace(/^### /, "")));
  const body = normalizeEntryBody(lines.slice(meta.next, entry.end).join("\n"));
  const holds = backlogHolds(root);
  const hold = (kind === "bug" ? holds.bugs : holds.plans)[n - 1] ?? null;
  return { position: n, title, body, hold };
}

