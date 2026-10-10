/** The CLI layer of `tumwater bug` and `tumwater plan` — the operator-authored backlog
 * write half, mirroring the read half in backlog.ts: file a bug into BUGS.md's `## Open`
 * or a plan request into PLANS.md's `## Planned`, stamped the way loops write those
 * entries, and render the confirmation. Split out of cli.ts because the markdown surgery
 * it performs is more than a dispatch case: the entry must land after the section's last
 * entry and before the next `## ` heading, fenced-safe (a `## ` line quoted inside an
 * entry's code fence is body text, never a boundary — the same fenceTracker every backlog
 * reader consults), and a file tumwater init never seeded is created with init's template
 * rather than failing. The wake of the loop that should act stays in cli.ts beside the
 * other command bodies. */
import path from "node:path";
import { fencedHeadingTitle, fenceTracker, headingMetadata, nextSectionHeading } from "./backlog-md.js";
import { actionableEntryRanges, stripEntryStamp, type ActionableEntryRange } from "./backlog-structure.js";
import { readTextIfExists, writeTextAtomic } from "../files/files.js";
import { formatDate } from "../text/datetime.js";
import { fail, say, sayJson } from "../cli/cli-output.js";
import { parsePositionFlag, rejectRepeatFlag } from "../cli/cli-args.js";
import { plannedPlanEntries, openBugEntries } from "./backlog.js";
import { backlogHolds, holdMark } from "./backlog-eligibility.js";
import { numberedList } from "../text/markdown.js";
import { collapseWhitespace, trimLeadingBlankLines, trimTrailingBlankLines } from "../text/text.js";
import { BUGS_TEMPLATE, PLANS_TEMPLATE } from "../init/init.js";
import { JSON_FLAG, rejectUnknownArgs } from "../cli/cli-flag-specs.js";
import { requireReadyRepo } from "../cli/cli-repo-gate.js";
import { submitRolePromptAndWake } from "../operator/operator-intent.js";
import { promptLengthProblem } from "../inbox/inbox-submit.js";
import { withStateLock } from "../concurrency/lock.js";
import { primaryWorktreeLockPath } from "../paths.js";

/** Today's stamp body every operator-filed entry carries, parenthesized by the caller that
 * builds the heading. Computed once per call (not module load) so a long-lived process
 * stamps with the date it filed on. */
const operatorStamp = () => `reported by the operator ${formatDate(new Date())}`;

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
function sectionNoun(sectionTitle: string): string {
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
  const entries = actionableEntryRanges(md, sectionTitle);
  const entry = entries[n - 1];
  if (entry === undefined) {
    fail(`no ${sectionNoun(sectionTitle)} at position ${n} (${entries.length} in ${fileName})`);
  }
  return entry;
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
  // The range's end is the 1-based line before the next heading (the separating blank line at a
  // well-formed section); start-1/end-1 are its 0-based bounds, and the length is end-start+1.
  lines.splice(entry.start - 1, entry.end - entry.start + 1);
  writeTextAtomic(file, lines.join("\n"));
  return { file: fileName, title: entry.title };
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
  return { file: fileName, title };
}

/** The result one file command returns: the file written, the entry's title (verbatim
 * heading text, the same string the backlog readers list), and the stamp it carried — the
 * {file, title, stamp} payload `--json` prints. */
interface FiledEntry {
  file: string;
  title: string;
  stamp: string;
}

/** The title each file command derives from the CLI positionals, exported so the CLI case
 * can hand fileAndAnnounce the same derivation the write will carry: fileAndAnnounce
 * preflights the composed wake prompt (wakeText(title)) against the submission cap BEFORE
 * the write, and a titleOf that drifted from file()'s own derivation would preflight the
 * wrong text. bugTitleOf(positionals) is exactly fileBug's symptom when the CLI case passes
 * positionals.join(" ") as its raw text; planTitleOf(positionals) is exactly filePlan's
 * title when it passes positionals[0]. */
export function bugTitleOf(positionals: string[]): string {
  return collapseWhitespace(positionals.join(" "));
}
export function planTitleOf(positionals: string[]): string {
  return collapseWhitespace(positionals[0] ?? "");
}

/** The shared shell of the `bug` and `plan` CLI cases — the one home of the five-step
 * sequence both commands run in cli.ts: peel the free-form positionals (the questions
 * command's prose-token pattern), reject anything flag-shaped that is not `--json`, run the
 * ready-repo gate the other backlog commands run, write the entry via `file`, wake the
 * `role` loop that should act so it picks the entry up within one poll, then announce — the
 * wake always fires, its confirmation line rides the prose output only, in `--json` mode
 * stdout is the payload document alone (the prompt --json precedent) so a script can parse
 * it. The command name and usage string ride in for the reject/confirmation/empty-arg
 * wordings (fileBug/filePlan's empty-arg usage lines); `wakeText` builds the loop prompt
 * from the filed entry's title and `titleOf` derives that title from the positionals (the
 * exported bugTitleOf/planTitleOf, so the preflight and the write see one derivation).
 * The wake prompt rides into the target tick's prefill under the same submission cap every
 * prompt answers to, so fileAndAnnounce checks it (promptLengthProblem) BEFORE calling
 * `file` — otherwise an over-long operator text would write its entry and only then throw
 * inside submitRolePromptAndWake, half-applying the command with the backlog file already
 * grown. */
export async function fileAndAnnounce(
  root: string,
  args: string[],
  command: string,
  file: (positionals: string[]) => FiledEntry,
  role: string,
  wakeText: (title: string) => string,
  titleOf: (positionals: string[]) => string,
): Promise<void> {
  // peelPositionals cannot serve this command: bug/plan's text is operator prose, and a
  // standalone --help/-h token inside it ("the TUI mishandles --help output") is content —
  // the dispatcher's help interception stands down for text-carrying invocations (cli.ts),
  // so a help token that reaches here is always prose. peelPositionals would flag-shape it
  // into rest and rejectUnknownArgs would refuse the whole report; instead classify here,
  // keeping token order: --json is the one flag, --help/-h ride into the text, and any
  // other flag-shaped token is still named by the strictness gate.
  const positionals: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      // The "each flag at most once" rule every spec-parsed command and the questions
      // parser apply (cli-flag-specs.ts's rejectUnknownArgs, cli-command-args.ts's
      // rejectDuplicateFlags): a second --json was silently collapsed here while
      // `backlog --json --json` and `questions --json --json` refuse it.
      rejectRepeatFlag(json, "--json");
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      positionals.push(arg);
      continue;
    }
    if (arg.startsWith("-")) rejectUnknownArgs(command, [arg], [JSON_FLAG]);
    else positionals.push(arg);
  }
  await requireReadyRepo(root);
  const wakeProblem = promptLengthProblem(wakeText(titleOf(positionals)), role);
  if (wakeProblem) fail(wakeProblem);
  const filed = file(positionals);
  const wake = submitRolePromptAndWake(root, role, wakeText(filed.title));
  sayFiled(command, filed, json);
  if (!json) say(wake);
}

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

/** `tumwater bug "<symptom>"`: append one `### <symptom> (reported by the operator <date>)`
 * entry to BUGS.md's `## Open`. The symptom is operator prose, so it folds to one line
 * (collapseWhitespace, the questions answer precedent) — a multi-line raw text could carry
 * a `## `/`### ` line and grow a phantom section no reader wrote. An empty symptom fails
 * with the usage line and writes nothing. */
export function fileBug(root: string, rawText: string, usage: string): FiledEntry {
  const symptom = collapseWhitespace(rawText);
  if (symptom === "") fail(`bug needs a symptom: ${usage}`);
  return appendOperatorEntry(root, "BUGS.md", BUGS_TEMPLATE, "Open", symptom, "");
}

/** `tumwater plan "<title>" [body...]`: append one `### <title> (reported by the operator
 * <date>)` entry to PLANS.md's `## Planned`, with the optional body as the entry text. No
 * goal/approach/acceptance-criteria scaffolding is invented — the feature loop's
 * plan-refinement pass fleshes the stub out on pickup. An empty title fails with the usage
 * line and writes nothing. */
export function filePlan(root: string, rawTitle: string, rawBody: string, usage: string): FiledEntry {
  const title = collapseWhitespace(rawTitle);
  if (title === "") fail(`plan needs a title: ${usage}`);
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

/** `tumwater bug --edit <n> "<symptom>"`: replace the nth BUGS.md `## Open` entry's heading
 * text with the new symptom, keeping its position and its original `(reported by …)` stamp.
 * The symptom folds to one line (collapseWhitespace, the fileBug rule), so it can never grow
 * a phantom section; an empty one fails with the usage line and writes nothing. A bug has no
 * body, so the rebuilt entry is its heading alone. */
export function editBug(root: string, n: number, rawText: string, usage: string): { file: string; title: string } {
  const symptom = collapseWhitespace(rawText);
  if (symptom === "") fail(`bug needs a symptom: ${usage}`);
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
  if (title === "") fail(`plan needs a title: ${usage}`);
  const body = collapseWhitespace(rawBody);
  return editEntry(root, "PLANS.md", "Planned", n, title, body);
}

/** The shared shell of the `bug --cancel` and `plan --cancel` CLI cases, mirroring
 * fileAndAnnounce's flag handling: `--cancel <n>` is the one valued flag, `--json` the one
 * boolean (at most once), `--help`/`-h` tolerated; any positional or other flag is refused
 * through rejectUnknownArgs. The position parses through the plain-decimal rule every position
 * flag shares (parsePositionFlag, cli-args.ts), not Number(). After requireReadyRepo it prints
 * `cancelled <command> in <file>: <title>` or the `--json` payload {file, title}. Unlike
 * fileAndAnnounce there is no wake: removing work must not wake a loop. */
export async function cancelAndAnnounce(
  root: string,
  args: string[],
  command: string,
  cancel: (n: number) => { file: string; title: string },
): Promise<void> {
  let position: number | null = null;
  let json = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      rejectRepeatFlag(json, "--json");
      json = true;
      continue;
    }
    if (arg === "--cancel") {
      rejectRepeatFlag(position !== null, "--cancel");
      position = parsePositionFlag("--cancel", args[i + 1], "--cancel 2");
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") continue;
    rest.push(arg as string);
  }
  // rejectUnknownArgs names both a stray positional and an unknown flag, with this command's
  // (empty) valid-flag list — the vocabulary a cancel invocation accepts is exactly --cancel
  // and --json, both consumed above.
  rejectUnknownArgs(command, rest, []);
  if (position === null) fail(`--cancel needs a position (usage: tumwater ${command} --cancel <n>)`);
  await requireReadyRepo(root);
  const removed = cancel(position);
  if (json) sayJson({ file: removed.file, title: removed.title });
  else say(`cancelled ${command} in ${removed.file}: ${removed.title}`);
}

/** The shared shell of the `bug --list` and `plan --list` CLI cases — the read half of the
 * operator queue whose `--edit`/`--cancel` flags address entries by position. Reads the same
 * entries, in the same file order, that locateEntry numbers for `--edit`/`--cancel`, pairs
 * each with its eligibility hold (backlogHolds), and prints them numbered from 1, or the
 * command's `no …` line on an empty or missing file. Like `tumwater backlog` and `tumwater
 * questions` it is read-only: no requireReadyRepo gate and no wake. `--list` and `--json` are
 * the two booleans this shell consumes (repeats refused), `--help`/`-h` is tolerated, and any
 * positional or other flag is refused through rejectUnknownArgs. */
export function listAndAnnounce(
  root: string,
  args: string[],
  command: string,
  fileName: string,
  sectionTitle: string,
): void {
  let json = false;
  let list = false;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--list") {
      rejectRepeatFlag(list, "--list");
      list = true;
      continue;
    }
    if (arg === "--json") {
      rejectRepeatFlag(json, "--json");
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") continue;
    rest.push(arg);
  }
  // rejectUnknownArgs names a stray positional and an unknown flag with this command's (empty)
  // valid-flag list: the vocabulary a list invocation accepts is exactly --list and --json,
  // both consumed above.
  rejectUnknownArgs(command, rest, []);
  // BUGS.md's `## Open` is the one section whose noun is "bug"; every other caller is a plan.
  const bugSection = sectionTitle === "Open";
  const entries = bugSection ? openBugEntries(root) : plannedPlanEntries(root);
  const holds = backlogHolds(root);
  const entryHolds = bugSection ? holds.bugs : holds.plans;
  if (json) {
    sayJson({
      entries: entries.map((entry, i) => ({
        position: i + 1,
        title: entry.title,
        body: entry.body,
        hold: entryHolds[i] ?? null,
      })),
    });
    return;
  }
  const noun = sectionNoun(sectionTitle);
  if (entries.length === 0) {
    say(`no ${noun}s`);
    return;
  }
  const numbered = entries.map((entry, i) => `${entry.title}${holdMark(entryHolds[i] ?? null)}`);
  say(`${noun}s in ${fileName}:\n${numberedList(numbered)}`);
}

/** The shared shell of the `bug --edit` and `plan --edit` CLI cases, mirroring
 * fileAndAnnounce's prose classification and cancelAndAnnounce's flag handling: `--edit <n>` is
 * the one valued flag, `--json` the one boolean (at most once), `--help`/`-h` ride into the new
 * text, and any other flag-shaped token is refused through rejectUnknownArgs. Unlike cancel,
 * what remains after the flags is the new text the callback folds to one line (so a `## `/`### `
 * line quoted in it can never grow a phantom section). After requireReadyRepo it prints
 * `edited <command> in <file>: <title>` or the `--json` payload {file, title}. Unlike
 * fileAndAnnounce there is no wake: an edit adds no work for a loop to pick up. */
export async function editAndAnnounce(
  root: string,
  args: string[],
  command: string,
  edit: (n: number, positionals: string[]) => { file: string; title: string },
): Promise<void> {
  let position: number | null = null;
  let json = false;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--json") {
      rejectRepeatFlag(json, "--json");
      json = true;
      continue;
    }
    if (arg === "--edit") {
      rejectRepeatFlag(position !== null, "--edit");
      position = parsePositionFlag("--edit", args[i + 1], "--edit 2");
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      positionals.push(arg);
      continue;
    }
    if (arg.startsWith("-")) rejectUnknownArgs(command, [arg], [JSON_FLAG]);
    else positionals.push(arg as string);
  }
  if (position === null) fail(`--edit needs a position (usage: tumwater ${command} --edit <n>)`);
  await requireReadyRepo(root);
  const edited = edit(position, positionals);
  if (json) sayJson({ file: edited.file, title: edited.title });
  else say(`edited ${command} in ${edited.file}: ${edited.title}`);
}

/** One confirmation for both file commands, prose or `--json`: the JSON branch prints the
 * {file, title, stamp} payload as data, the prose branch one line naming the command, the
 * file, and the entry title. Private to this module — cli.ts reaches it through
 * fileAndAnnounce, the shared shell both file commands' CLI cases run through. */
function sayFiled(command: string, filed: FiledEntry, json: boolean): void {
  if (json) sayJson({ file: filed.file, title: filed.title, stamp: filed.stamp });
  else say(`filed ${command} in ${filed.file}: ${filed.title}`);
}
