// vocabulary: plain
/** The CLI shells of `tumwater bug` and `tumwater plan` — flag classification, the preflights,
 * and the confirmation each case prints — over the entry-writing primitives in
 * backlog-write.ts (the read half's mirror, backlog.ts). cli.ts reaches the file, cancel,
 * release, edit, list, and show cases only through the `*AndAnnounce` shells here; the markdown
 * surgery and the locked read-modify-write live in backlog-write.ts. The wake of the role that
 * should act stays in cli.ts beside the other command bodies. */

import { fail, say, sayJson, warnIfUncommitted } from "../cli/cli-output.js";
import { parseCountFlag, parsePositionFlag, rejectRepeatFlag } from "../cli/cli-args.js";
import { promptFileValue, readPromptFileArg } from "../cli/cli-command-args.js";
import {
  DONE_DATE_RE,
  FIXED_DATE_RE,
  completionDate,
  donePlanEntries,
  fixedBugEntries,
  openBugEntries,
  plannedPlanEntries, ageInDays,
  entryAgeSuffix,
  entryMatches,
  filingDate,
} from "./backlog.js";
import { allLiveClaims } from "../runner/runner-state.js";
import { backlogHolds, backlogInProgress, cancelledClaimNote, entryKey, holdMark, inProgressMark } from "./backlog-eligibility.js";
import { groupBlockedSeries, partsLabel } from "./backlog-structure.js";
import { collapseWhitespace } from "../text/text.js";
import { JSON_FLAG, rejectUnknownArgs } from "../cli/cli-flag-specs.js";
import { refuseTeamWorkspace, requireReadyRepo } from "../cli/cli-repo-gate.js";
import { editInEditor } from "../cli/cli-editor.js";
import { requestWake, submitRolePromptAndWake } from "../operator/operator-intent.js";
import { promptLengthProblem } from "../inbox/inbox-submit.js";
import { commitOperatorBacklogEdit } from "./backlog-commit.js";
import { stampedSubject } from "../git/commit-message.js";
import { type FiledEntry, sectionNoun, showEntry, splitEntryFile } from "./backlog-write.js";
import { archiveFinishedOnMain, describeArchivedFile } from "./backlog-archive.js";

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

/** A positional alongside `--file` on a `plan|bug` command is refused: the entry's text comes
 * from the file, so a stray positional almost always means the operator pasted prose or
 * forgot `--file`. The one home of that check, shared by fileAndAnnounce and editAndAnnounce
 * so the two `--file` preflights cannot drift on the message. */
function rejectStrayWithFile(stray: unknown): void {
  if (stray !== undefined) fail(`unexpected argument ${JSON.stringify(stray)} — with --file the entry comes from the file`);
}

/** The one home of the prose-carrying file commands' flag classification (the `bug`/`plan`
 * file forms and their `--edit` forms): `--json` is the one boolean, refused on a repeat
 * (the "each flag at most once" rule every spec-parsed command and the questions parser
 * apply); when a position flag is supplied it is the one valued flag, likewise refused on a
 * repeat and parsed through the shared plain-decimal rule (parsePositionFlag); `--help`/`-h`
 * rides into the prose positionals rather than being skipped, because the dispatcher's help
 * interception stands down for text-carrying invocations (cli.ts) so a help token here is
 * always content; every other flag-shaped token is named by rejectUnknownArgs, and every
 * bare token is prose. Tokens keep their original order. */
function scanProseFlags(
  args: string[],
  command: string,
  positionFlag?: { name: string; example: string },
): { json: boolean; positionals: string[]; position: number | null } {
  let json = false;
  let position: number | null = null;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--json") {
      rejectRepeatFlag(json, "--json");
      json = true;
      continue;
    }
    if (arg === positionFlag?.name) {
      rejectRepeatFlag(position !== null, positionFlag.name);
      position = parsePositionFlag(positionFlag.name, args[i + 1], positionFlag.example);
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      positionals.push(arg);
      continue;
    }
    if (arg.startsWith("-")) rejectUnknownArgs(command, [arg], [JSON_FLAG]);
    else positionals.push(arg);
  }
  return { json, positionals, position };
}

/** The shared shell of the `bug` and `plan` CLI cases — the one home of the five-step
 * sequence both commands run in cli.ts: peel the free-form positionals (the questions
 * command's prose-token pattern), reject anything flag-shaped that is not `--json`, run the
 * ready-repo gate the other backlog commands run, write the entry via `file`, wake the
 * role that should act so it picks the entry up within one poll, then announce — the
 * wake always fires, its confirmation line rides the prose output only, in `--json` mode
 * stdout is the payload document alone (the prompt --json precedent) so a script can parse
 * it. The command name and usage string ride in for the reject/confirmation/empty-arg
 * wordings (fileBug/filePlan's empty-arg usage lines); `wakeText` builds the role prompt
 * from the filed entry's title and `titleOf` derives that title from the positionals (the
 * exported bugTitleOf/planTitleOf, so the preflight and the write see one derivation).
 * The wake prompt rides into the target tick's prefill under the same submission cap every
 * prompt answers to, so fileAndAnnounce checks it (promptLengthProblem) BEFORE calling
 * `file` — otherwise an over-long operator text would write its entry and only then throw
 * inside submitRolePromptAndWake, half-applying the command with the backlog file already
 * grown. With `--file <path>` (`-` reads stdin) the entry comes from a markdown file instead
 * of positionals: `fileText` receives its text (splitEntryFile: first line the title, the rest
 * the body kept line for line), the same preflight runs on that title, and any positional
 * alongside --file is refused. */
export async function fileAndAnnounce(
  root: string,
  args: string[],
  command: string,
  file: (positionals: string[]) => FiledEntry,
  role: string,
  wakeText: (title: string) => string,
  titleOf: (positionals: string[]) => string,
  fileText: (text: string) => FiledEntry,
): Promise<void> {
  const fileFlag = args.indexOf("--file");
  if (fileFlag >= 0) {
    const file = promptFileValue(args[fileFlag + 1]);
    const rest = args.filter((_, i) => i !== fileFlag && i !== fileFlag + 1);
    rejectRepeatFlag(rest.includes("--file"), "--file");
    const { json, positionals } = scanProseFlags(rest, command);
    rejectStrayWithFile(positionals[0]);
    await requireReadyRepo(root);
    const text = readPromptFileArg(file);
    const wakeProblem = promptLengthProblem(wakeText(splitEntryFile(text).title), role);
    if (wakeProblem) fail(wakeProblem);
    await announceFiled(root, command, fileText(text), role, wakeText, json);
    return;
  }
  // peelPositionals cannot serve this command: bug/plan's text is operator prose, and a
  // standalone --help/-h token inside it ("the TUI mishandles --help output") is content —
  // the dispatcher's help interception stands down for text-carrying invocations (cli.ts),
  // so a help token that reaches here is always prose, and scanProseFlags keeps it in the
  // positionals rather than flag-shaping it into rest for rejectUnknownArgs to refuse.
  const { json, positionals } = scanProseFlags(args, command);
  await requireReadyRepo(root);
  const wakeProblem = promptLengthProblem(wakeText(titleOf(positionals)), role);
  if (wakeProblem) fail(wakeProblem);
  await announceFiled(root, command, file(positionals), role, wakeText, json);
}

/** The tail both fileAndAnnounce forms share: commit the entry on main, wake the `role`
 * role with the filed entry's title, then print the confirmation (the wake line rides the
 * prose output only). */
async function announceFiled(
  root: string,
  command: string,
  filed: FiledEntry,
  role: string,
  wakeText: (title: string) => string,
  json: boolean,
): Promise<void> {
  warnIfUncommitted(await commitOperatorBacklogEdit(root, filed.file, stampedSubject("operator", `File ${command}: ${filed.title}`)), filed.file); // vocabulary-ok: the tumwater(operator): commit prefix is a machine string
  const wake = submitRolePromptAndWake(root, role, wakeText(filed.title));
  sayFiled(command, filed, json);
  if (!json) say(wake);
}

/** The shared shell of the `bug --cancel` and `plan --cancel` CLI cases, mirroring
 * fileAndAnnounce's flag handling: `--cancel <n>` is the one valued flag, `--json` the one
 * boolean (at most once), `--help`/`-h` tolerated; any positional or other flag is refused
 * through rejectUnknownArgs. The position parses through the plain-decimal rule every position
 * flag shares (parsePositionFlag, cli-args.ts), not Number(). After requireReadyRepo it prints
 * `cancelled <command> in <file>: <title>` or the `--json` payload {file, title}. Unlike
 * fileAndAnnounce there is no wake: removing work must not wake a role. */
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
  // Snapshot the claims first: the orchestrator may release the claim once the heading leaves.
  const claims = allLiveClaims(root);
  const removed = cancel(position);
  const workingOn = claims.get(entryKey(removed.title)) ?? null;
  warnIfUncommitted(await commitOperatorBacklogEdit(root, removed.file, stampedSubject("operator", `Cancel ${command}: ${removed.title}`)), removed.file); // vocabulary-ok: the tumwater(operator): commit prefix is a machine string
  if (json) sayJson({ file: removed.file, title: removed.title, ...(workingOn === null ? {} : { workingOn }) });
  else {
    say(`cancelled ${command} in ${removed.file}: ${removed.title}`);
    if (workingOn !== null) say(cancelledClaimNote(workingOn));
  }
}

/** The shell of the `bug --release` and `plan --release` CLI cases, parsed as cancelAndAnnounce
 * parses `--cancel`: `--release <n>`, an optional `--json`, anything else refused. After
 * requireReadyRepo it releases the entry, commits the file on main, and wakes `role` (the
 * released entry is eligible now, and that role may be backed off) with no queued prompt. Prints
 * `released <command> in <file>: <title>` plus the wake line, or only the `--json` payload. */
export async function releaseAndAnnounce(
  root: string,
  args: string[],
  command: "bug" | "plan",
  release: (n: number) => { file: string; title: string },
  role: string,
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
    if (arg === "--release") {
      rejectRepeatFlag(position !== null, "--release");
      position = parsePositionFlag("--release", args[i + 1], "--release 2");
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") continue;
    rest.push(arg as string);
  }
  rejectUnknownArgs(command, rest, []);
  if (position === null) fail(`--release needs a position (usage: tumwater ${command} --release <n>)`);
  await requireReadyRepo(root);
  const released = release(position);
  warnIfUncommitted(await commitOperatorBacklogEdit(root, released.file, stampedSubject("operator", `Release ${command}: ${released.title}`)), released.file); // vocabulary-ok: the tumwater(operator): commit prefix is a machine string
  const wake = requestWake(root, [role]);
  if (json) sayJson({ file: released.file, title: released.title });
  else {
    say(`released ${command} in ${released.file}: ${released.title}`);
    say(wake);
  }
}

/** The shell of the `bug --top` and `plan --top` CLI cases, parsed as releaseAndAnnounce parses
 * `--release`: `--top <n>`, an optional `--json`, anything else refused. After requireReadyRepo
 * it moves the entry to the head of its section and commits the file on main. No wake: a
 * reorder makes no entry newly eligible. Prints `moved <command> to the top of <file>: <title>`
 * or only the `--json` payload. */
export async function topAndAnnounce(
  root: string,
  args: string[],
  command: "bug" | "plan",
  top: (n: number) => { file: string; title: string },
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
    if (arg === "--top") {
      rejectRepeatFlag(position !== null, "--top");
      position = parsePositionFlag("--top", args[i + 1], "--top 2");
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") continue;
    rest.push(arg as string);
  }
  rejectUnknownArgs(command, rest, []);
  if (position === null) fail(`--top needs a position (usage: tumwater ${command} --top <n>)`);
  await requireReadyRepo(root);
  const moved = top(position);
  warnIfUncommitted(await commitOperatorBacklogEdit(root, moved.file, stampedSubject("operator", `Prioritize ${command}: ${moved.title}`)), moved.file); // vocabulary-ok: the tumwater(operator): commit prefix is a machine string
  if (json) sayJson({ file: moved.file, title: moved.title });
  else say(`moved ${command} to the top of ${moved.file}: ${moved.title}`);
}

/** Ascending positions as runs: consecutive ones join with an en dash (`13–17`), runs separate
 * with commas (`13–15, 18`). */
function positionRuns(positions: readonly number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < positions.length; ) {
    let j = i;
    while (j + 1 < positions.length && positions[j + 1] === positions[j]! + 1) j++;
    runs.push(j > i ? `${positions[i]}–${positions[j]}` : `${positions[i]}`);
    i = j + 1;
  }
  return runs.join(", ");
}

/** The shared shell of the `bug --list` and `plan --list` CLI cases — the read half of the
 * operator queue whose `--edit`/`--cancel` flags address entries by position. Reads the same
 * entries, in the same file order, that locateEntry numbers for `--edit`/`--cancel`, pairs
 * each with its eligibility hold (backlogHolds), and prints them numbered from 1, or the
 * command's `no …` line on an empty or missing file. Like `tumwater backlog` and `tumwater
 * questions` it is read-only: no requireReadyRepo gate and no wake. `--list` and `--json` are
 * the two booleans this shell consumes (repeats refused), `--help`/`-h` is tolerated, and any
 * positional or other flag is refused through rejectUnknownArgs.
 *
 * `--grep <text>` searches the active entries too: it keeps the entries whose heading or
 * body contains the text (case-insensitive), each under its unfiltered number so a printed
 * position still reaches `--show`/`--edit`/`--cancel` — the active twin of the finished
 * entries' `--done --grep`.
 *
 * `--done [-n <count>] [--grep <text>]` (each once; `-n` and `--grep` need `--done`) lists the
 * newest finished entries instead (BUGS.md ## Fixed or PLANS.md ## Done, numbered, default 10)
 * with `older` counting those left out; --json carries each entry's `position` and
 * `completedOn` heading date. `--grep` keeps the entries whose heading or body contains the
 * text (case-insensitive); each keeps its unfiltered number, so it is the `--show <n> --done`
 * number, and `older` counts matches left out. `plan --list` prose
 * groups a series' blocked parts into one line (groupBlockedSeries). */
export function listAndAnnounce(
  root: string,
  args: string[],
  command: string,
  fileName: string,
  sectionTitle: string,
): void {
  let json = false;
  let list = false;
  let done = false;
  let count: number | null = null;
  let grep: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--grep") {
      rejectRepeatFlag(grep !== null, "--grep");
      const text = args[++i];
      if (text === undefined || text === "") {
        fail(`--grep needs text (usage: tumwater ${command} --list --grep <text>)`);
      }
      grep = text;
      continue;
    }
    if (arg === "--done") {
      rejectRepeatFlag(done, "--done");
      done = true;
      continue;
    }
    if (arg === "-n") {
      rejectRepeatFlag(count !== null, "-n");
      count = parseCountFlag("-n", args[++i]);
      continue;
    }
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
  refuseTeamWorkspace(root);
  if (count !== null && !done) fail("-n needs --done (it limits the finished entries listed)");
  // BUGS.md's `## Open` is the one section whose noun is "bug"; every other caller is a plan.
  const bugSection = sectionTitle === "Open";
  if (done) {
    const numbered = (bugSection ? fixedBugEntries(root) : donePlanEntries(root)).map((entry, i) => ({
      entry,
      position: i + 1,
    }));
    const pattern = grep;
    const matches = pattern === null ? numbered : numbered.filter((m) => entryMatches(m.entry, pattern));
    const limit = count ?? 10;
    const shown = matches.slice(0, limit);
    const older = matches.length - shown.length;
    if (json) {
      const dateRe = bugSection ? FIXED_DATE_RE : DONE_DATE_RE;
      sayJson({
        entries: shown.map(({ entry: e, position }) => ({
          position,
          title: e.title,
          body: e.body,
          completedOn: completionDate(e.title, dateRe),
        })),
        older,
      });
      return;
    }
    const what = bugSection ? "fixed bugs" : "done plans";
    if (shown.length === 0) {
      say(pattern === null ? `no ${what}` : `no ${what} match "${pattern}"`);
      return;
    }
    const lines = shown.map((m) => `${m.position}. ${m.entry.title}`);
    if (older > 0) lines.push(`(${older} older; -n ${matches.length} shows more)`);
    const header = pattern === null ? `${what} in ${fileName}, newest first:` : `${what} in ${fileName} matching "${pattern}", newest first:`;
    say(`${header}\n${lines.join("\n")}`);
    return;
  }
  const entries = bugSection ? openBugEntries(root) : plannedPlanEntries(root);
  const holds = backlogHolds(root);
  const entryHolds = bugSection ? holds.bugs : holds.plans;
  const inProgress = backlogInProgress(root);
  const entryRunners = bugSection ? inProgress.bugs : inProgress.plans;
  // Numbering is the unfiltered 1-based position `--edit`/`--cancel`/`--show <n>` address;
  // `--grep` keeps each match's original position so a printed number still reaches them.
  const numbered = entries.map((entry, i) => ({ entry, position: i + 1 }));
  const matches = grep === null ? numbered : numbered.filter((m) => entryMatches(m.entry, grep));
  if (json) {
    sayJson({
      entries: matches.map(({ entry, position }) => {
        const since = filingDate(entry.title);
        return {
          position,
          title: entry.title,
          body: entry.body,
          hold: entryHolds[position - 1] ?? null,
          inProgress: entryRunners[position - 1] ?? null,
          // The filing stamp the entry's own heading carries, and how many days it has waited
          // since then (both present only when the heading names a stamp — an undated entry
          // keeps the pre-existing shape with neither key).
          ...(since === null ? {} : { since, ageDays: ageInDays(since) }),
        };
      }),
    });
    return;
  }
  const noun = sectionNoun(sectionTitle);
  if (grep === null && entries.length === 0) {
    say(`no ${noun}s`);
    return;
  }
  if (matches.length === 0) {
    say(`no ${noun}s match "${grep}"`);
    return;
  }
  const line = (entry: { title: string }, i: number): string =>
    `${entry.title}${holdMark(entryHolds[i] ?? null)}${inProgressMark(entryRunners[i] ?? null)}${entryAgeSuffix(entry.title)}`;
  if (bugSection) {
    say(`${noun}s in ${fileName}:\n${matches.map(({ entry, position }) => `${position}. ${line(entry, position - 1)}`).join("\n")}`);
    return;
  }
  // Plans: a series' blocked parts show as one line naming their positions, as the prompt's
  // backlog index does; numbering is unchanged so --show/--edit/--cancel <n> reach every part.
  const rows = matches.map(({ entry, position }) => ({
    position,
    title: entry.title,
    hold: entryHolds[position - 1] ?? null,
    claimer: entryRunners[position - 1] ?? undefined,
  }));
  let grouped = false;
  const lines = groupBlockedSeries(rows).map((g) => {
    if (g.kind === "row") return `${g.row.position}. ${line(g.row, g.row.position - 1)}`;
    grouped = true;
    return `${positionRuns(g.rows.map((r) => r.position))}. ${g.series}, ${g.rows.length} blocked parts (${partsLabel(g.rows)}) [blocked: each waits on an earlier part]`;
  });
  if (grouped) lines.push("(each blocked series is one line; --show <n> prints a part, --json lists every entry)");
  say(`${noun}s in ${fileName}:\n${lines.join("\n")}`);
}

/** The shell of `bug --show` and `plan --show`: `--show <n>` (once), an optional `--json`
 * and `--done` (each once; `--done` shows the Nth newest finished entry, as `--list --done`
 * numbers them, with its heading stamp kept and `completedOn` in --json),
 * `--help`/`-h` tolerated, anything else refused through rejectUnknownArgs. Read-only like
 * `--list`: no repo gate, commit, or wake. Prose is the title, a blank line, then the body, so
 * stdout is the file `--edit <n> --file` takes back. */
export function showAndAnnounce(root: string, args: string[], command: "bug" | "plan"): void {
  let position: number | null = null;
  let json = false;
  let done = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--done") {
      rejectRepeatFlag(done, "--done");
      done = true;
      continue;
    }
    if (arg === "--json") {
      rejectRepeatFlag(json, "--json");
      json = true;
      continue;
    }
    if (arg === "--show") {
      rejectRepeatFlag(position !== null, "--show");
      position = parsePositionFlag("--show", args[i + 1], "--show 2");
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") continue;
    rest.push(arg as string);
  }
  rejectUnknownArgs(command, rest, []);
  refuseTeamWorkspace(root);
  if (position === null) fail(`--show needs a position (usage: tumwater ${command} --show <n>)`);
  if (done) {
    const bug = command === "bug";
    const all = bug ? fixedBugEntries(root) : donePlanEntries(root);
    const entry = all[position - 1];
    if (entry === undefined) {
      const range = all.length > 0 ? ` — valid: 1-${all.length}` : "";
      fail(`no ${bug ? "fixed bug" : "done plan"} at position ${position} (${all.length} in ${bug ? "BUGS.md" : "PLANS.md"})${range}`);
    }
    if (json) {
      const dateRe = bug ? FIXED_DATE_RE : DONE_DATE_RE;
      sayJson({ position, title: entry.title, body: entry.body, completedOn: completionDate(entry.title, dateRe) });
    } else say(renderShownEntry({ title: entry.title, body: entry.body }));
    return;
  }
  const shown = showEntry(root, command, position);
  if (json) sayJson(shown);
  else say(renderShownEntry(shown));
}

/** The prose `--show` prints: the title, a blank line, then the body (the title alone when the
 * body is empty). */
function renderShownEntry(shown: { title: string; body: string }): string {
  return shown.body === "" ? shown.title : `${shown.title}\n\n${shown.body}`;
}

/** The shared shell of the `bug --edit` and `plan --edit` CLI cases, mirroring
 * fileAndAnnounce's prose classification and cancelAndAnnounce's flag handling: `--edit <n>` is
 * the one valued flag, `--json` the one boolean (at most once), `--help`/`-h` ride into the new
 * text, and any other flag-shaped token is refused through rejectUnknownArgs. Unlike cancel,
 * what remains after the flags is the new text the callback folds to one line (so a `## `/`### `
 * line quoted in it can never grow a phantom section). After requireReadyRepo it prints
 * `edited <command> in <file>: <title>` or the `--json` payload {file, title}. Unlike
 * fileAndAnnounce there is no wake: an edit adds no work for a role to pick up. With
 * `--file <path>` (`-` reads stdin) the new entry comes from a markdown file instead of
 * positionals: `editText` receives its text, and any positional alongside --file is refused.
 * With neither positionals nor --file the entry, rendered as `--show` prints it, opens in
 * $VISUAL/$EDITOR and the saved buffer goes through `editText`; an unchanged buffer writes and
 * commits nothing (`unchanged <command> <n>: <title>`), and an out-of-range position fails
 * before the editor launches. */
export async function editAndAnnounce(
  root: string,
  args: string[],
  command: "bug" | "plan",
  edit: (n: number, positionals: string[]) => { file: string; title: string },
  editText: (n: number, text: string) => { file: string; title: string },
): Promise<void> {
  const fileFlag = args.indexOf("--file");
  const path = fileFlag >= 0 ? promptFileValue(args[fileFlag + 1]) : null;
  const rest = path === null ? args : args.filter((_, i) => i !== fileFlag && i !== fileFlag + 1);
  if (path !== null) rejectRepeatFlag(rest.includes("--file"), "--file");
  const { json, positionals, position } = scanProseFlags(rest, command, {
    name: "--edit",
    example: "--edit 2",
  });
  if (path !== null) rejectStrayWithFile(positionals[0]);
  if (position === null) fail(`--edit needs a position (usage: tumwater ${command} --edit <n>)`);
  await requireReadyRepo(root);
  let text: string | null = null;
  if (path === null && positionals.length === 0) {
    const shown = showEntry(root, command, position);
    const before = renderShownEntry(shown);
    const after = editInEditor(before, `${command}-${position}.md`);
    if (after.trim() === before.trim()) {
      const file = command === "bug" ? "BUGS.md" : "PLANS.md";
      if (json) sayJson({ file, title: shown.title, changed: false });
      else say(`unchanged ${command} ${position}: ${shown.title}`);
      return;
    }
    text = after;
  } else if (path !== null) text = readPromptFileArg(path);
  const edited = text === null ? edit(position, positionals) : editText(position, text);
  warnIfUncommitted(await commitOperatorBacklogEdit(root, edited.file, stampedSubject("operator", `Edit ${command}: ${edited.title}`)), edited.file); // vocabulary-ok: the tumwater(operator): commit prefix is a machine string
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

/** How long `tumwater archive` waits for a merge in progress to release the merge lock: a merge
 * holds it through its in-lock check, which can run several minutes. */
const ARCHIVE_LOCK_WAIT_MS = 15 * 60_000;

/** `tumwater archive`: move the finished entries still under PLANS.md's `## Done` and BUGS.md's
 * `## Fixed` to PLANS-DONE.md and BUGS-FIXED.md and commit them on the base branch
 * (plans/backlog-archive.md) — the hand-run twin of the archive a starting team makes. Prints
 * what moved and the commit, or why nothing was written (a refusal fails the command). */
export async function cmdArchive(root: string): Promise<void> {
  const outcome = await archiveFinishedOnMain(root, { lockTimeoutMs: ARCHIVE_LOCK_WAIT_MS });
  if (outcome.status === "nothing") {
    say("nothing to archive: PLANS.md ## Done and BUGS.md ## Fixed hold no finished entries");
    return;
  }
  if (outcome.status === "skipped") fail(`nothing archived: ${outcome.reason}`);
  for (const f of outcome.moved) say(describeArchivedFile(f));
  say(`committed ${outcome.commit.slice(0, 8)}`);
}
