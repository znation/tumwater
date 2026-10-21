/** The read-only CLI shells of `tumwater bug` and `tumwater plan` — `--list` (active and
 * `--done`, with `--grep`) and `--show` — split from backlog-cli.ts, which keeps the writing
 * shells (file, cancel, release, top, edit). Neither shell gates on a ready repo, commits, or
 * wakes a role. cli.ts reaches them through listAndAnnounce and showAndAnnounce. */

import { fail, say, sayJson } from "../cli/cli-output.js";
import { parseCountFlag, parsePositionFlag, rejectRepeatFlag } from "../cli/cli-args.js";
import {
  DONE_DATE_RE,
  FIXED_DATE_RE,
  completionDate,
  donePlanEntries,
  fixedBugEntries,
  openBugEntries,
  plannedPlanEntries,
  ageInDays,
  entryAgeSuffix,
  entryMatches,
  filingDate,
} from "./backlog.js";
import { backlogHolds, backlogInProgress, holdMark, inProgressMark } from "./backlog-eligibility.js";
import { groupBlockedSeries, partsLabel } from "./backlog-structure.js";
import { rejectUnknownArgs } from "../cli/cli-flag-specs.js";
import { refuseTeamWorkspace } from "../cli/cli-repo-gate.js";
import { sectionNoun, showEntry } from "./backlog-write.js";

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
 * `--ready` keeps the entries with no hold under their unfiltered numbers (composes with
 * `--grep` and `--json`; refused with `--done`, whose entries carry no holds).
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
  let ready = false;
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
    if (arg === "--ready") {
      rejectRepeatFlag(ready, "--ready");
      ready = true;
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
  if (ready && done) fail("--ready needs the active list (finished entries carry no holds)");
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
  const kept = ready ? matches.filter((m) => (entryHolds[m.position - 1] ?? null) === null) : matches;
  const hidden = matches.length - kept.length;
  if (json) {
    sayJson({
      entries: kept.map(({ entry, position }) => {
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
  if (ready && kept.length === 0) {
    say(`no ${noun}s ready (${hidden} held; run \`tumwater ${command} --list\` to see them)`);
    return;
  }
  const hiddenNote = `(${hidden} held entries hidden; run \`tumwater ${command} --list\` to see them)`;
  const line = (entry: { title: string }, i: number): string =>
    `${entry.title}${holdMark(entryHolds[i] ?? null)}${inProgressMark(entryRunners[i] ?? null)}${entryAgeSuffix(entry.title)}`;
  if (bugSection) {
    const bugLines = kept.map(({ entry, position }) => `${position}. ${line(entry, position - 1)}`);
    if (hidden > 0) bugLines.push(hiddenNote);
    say(`${noun}s in ${fileName}:\n${bugLines.join("\n")}`);
    return;
  }
  // Plans: a series' blocked parts show as one line naming their positions, as the prompt's
  // backlog index does; numbering is unchanged so --show/--edit/--cancel <n> reach every part.
  const rows = kept.map(({ entry, position }) => ({
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
  if (hidden > 0) lines.push(hiddenNote);
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
export function renderShownEntry(shown: { title: string; body: string }): string {
  return shown.body === "" ? shown.title : `${shown.title}\n\n${shown.body}`;
}
