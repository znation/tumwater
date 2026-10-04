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
import { fencedHeadingTitle, fenceTracker } from "./backlog-md.js";
import { readTextOrNull, writeTextAtomic } from "./files.js";
import { formatDate } from "./datetime.js";
import { fail, say, sayJson } from "./cli-output.js";
import { collapseWhitespace } from "./text.js";
import { BUGS_TEMPLATE, PLANS_TEMPLATE } from "./init.js";
import { JSON_FLAG, rejectUnknownArgs } from "./cli-flag-specs.js";
import { peelPositionals } from "./cli-command-args.js";
import { requireReadyRepo } from "./cli-query-commands.js";
import { submitRolePromptAndWake } from "./operator-intent.js";

/** Today's stamp body every operator-filed entry carries, parenthesized by the caller that
 * builds the heading. Computed once per call (not module load) so a long-lived process
 * stamps with the date it filed on. */
const operatorStamp = () => `reported by the operator ${formatDate(new Date())}`;

/** Append one `### ` entry to `<root>/<fileName>`'s `## <sectionTitle>` section, fence-safe
 * and placeholder-aware. The single home of the write-side walk the two file commands share:
 * locate the section's heading (a missing section or missing file falls back to the init
 * template's scaffolding), cut the section's content, drop its `_None yet._` placeholder
 * (a placeholder means "no entries", so leaving it above the new entry would claim the
 * section is empty), and append the entry before the next `## ` heading — a heading line
 * quoted inside a fenced block (entries quote markdown and shell traces) is body text,
 * never the boundary, per the shared fenceTracker. */
function appendEntry(
  root: string,
  fileName: string,
  template: string,
  sectionTitle: string,
  heading: string,
  body: string,
): void {
  const file = path.join(root, fileName);
  const md = readTextOrNull(file) ?? template;
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
  let sectionEnd = lines.length;
  const fencedEnd = fenceTracker();
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (fencedEnd.inside(lines[i] ?? "")) continue;
    if ((lines[i] ?? "").startsWith("## ")) {
      sectionEnd = i;
      break;
    }
  }
  // The section's content between its heading and its end: real entries, with any
  // `_None yet._` skeleton placeholder dropped (fence-aware — a quoted placeholder line is
  // quoted content, not the marker) and the edge blanks trimmed.
  const fencedContent = fenceTracker();
  const content = lines
    .slice(sectionIdx + 1, sectionEnd)
    .filter((line) => fencedContent.inside(line) || line.trim() !== "_None yet._");
  while (content.length > 0 && (content[0] ?? "").trim() === "") content.shift();
  while (content.length > 0 && (content[content.length - 1] ?? "").trim() === "") content.pop();
  const rest = lines.slice(sectionEnd);
  // One blank line after the entry block, before whatever follows the section: the trailing
  // blanks the trim above popped were the separator between the section and the next `## `
  // heading, and without restoring one here the filed entry's heading abuts that heading —
  // the only writer of these files that produced a heading-on-heading join. When the section
  // ends at EOF the blank is the file's trailing newline shape, never an extra line.
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

/** The result one file command returns: the file written, the entry's title (verbatim
 * heading text, the same string the backlog readers list), and the stamp it carried — the
 * {file, title, stamp} payload `--json` prints. */
interface FiledEntry {
  file: string;
  title: string;
  stamp: string;
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
 * from the filed entry's title. */
export async function fileAndAnnounce(
  root: string,
  args: string[],
  command: string,
  file: (positionals: string[]) => FiledEntry,
  role: string,
  wakeText: (title: string) => string,
): Promise<void> {
  const { positionals, rest } = peelPositionals(args);
  rejectUnknownArgs(command, rest, [JSON_FLAG]);
  await requireReadyRepo(root);
  const json = rest.includes("--json"); // the one accepted flag: JSON_FLAG's spelling
  const filed = file(positionals);
  const wake = submitRolePromptAndWake(root, role, wakeText(filed.title));
  sayFiled(command, filed, json);
  if (!json) say(wake);
}

/** `tumwater bug "<symptom>"`: append one `### <symptom> (reported by the operator <date>)`
 * entry to BUGS.md's `## Open`. The symptom is operator prose, so it folds to one line
 * (collapseWhitespace, the questions answer precedent) — a multi-line raw text could carry
 * a `## `/`### ` line and grow a phantom section no reader wrote. An empty symptom fails
 * with the usage line and writes nothing. */
export function fileBug(root: string, rawText: string, usage: string): FiledEntry {
  const symptom = collapseWhitespace(rawText);
  if (symptom === "") fail(`bug needs a symptom: ${usage}`);
  const stamp = operatorStamp();
  const heading = `### ${symptom} (${stamp})`;
  appendEntry(root, "BUGS.md", BUGS_TEMPLATE, "Open", heading, "");
  return { file: "BUGS.md", title: symptom, stamp };
}

/** `tumwater plan "<title>" [body...]`: append one `### <title> (reported by the operator
 * <date>)` entry to PLANS.md's `## Planned`, with the optional body as the entry text. No
 * goal/approach/acceptance-criteria scaffolding is invented — the feature loop's
 * plan-refinement pass fleshes the stub out on pickup. An empty title fails with the usage
 * line and writes nothing. */
export function filePlan(root: string, rawTitle: string, rawBody: string, usage: string): FiledEntry {
  const title = collapseWhitespace(rawTitle);
  if (title === "") fail(`plan needs a title: ${usage}`);
  const body = collapseWhitespace(rawBody);
  const stamp = operatorStamp();
  const heading = `### ${title} (${stamp})`;
  appendEntry(root, "PLANS.md", PLANS_TEMPLATE, "Planned", heading, body);
  return { file: "PLANS.md", title, stamp };
}

/** One confirmation for both file commands, prose or `--json`: the JSON branch prints the
 * {file, title, stamp} payload as data, the prose branch one line naming the command, the
 * file, and the entry title. Private to this module — cli.ts reaches it through
 * fileAndAnnounce, the shared shell both file commands' CLI cases run through. */
function sayFiled(command: string, filed: FiledEntry, json: boolean): void {
  if (json) sayJson({ file: filed.file, title: filed.title, stamp: filed.stamp });
  else say(`filed ${command} in ${filed.file}: ${filed.title}`);
}