/** The read-only CLI shells of `tumwater bug` and `tumwater plan` — `--list` (active and
 * `--done`, with `--grep`) and `--show` — split from backlog-cli.ts, which keeps the writing
 * shells (file, cancel, release, top, edit). Neither shell gates on a ready repo, commits, or
 * wakes a role. cli.ts reaches them through listAndAnnounce and showAndAnnounce. */

import { fail, say, sayJson } from "./cli-output.js";
import { failFollowJsonRival, parseCountFlag, rejectRepeatFlag, scanPositionArgs } from "./cli-args.js";
import { FOLLOW_FLAG, rejectUnknownArgs } from "./cli-flag-specs.js";
import { followView, type FollowViewSeams } from "./follow-view.js";
import {
  type BacklogEntry,
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
} from "../backlog/backlog.js";
import { backlogHolds, backlogInProgress, holdMark, inProgressMark, type EntryHold } from "../backlog/backlog-eligibility.js";
import { groupBlockedSeries, partsLabel } from "../backlog/backlog-index-data.js";
import { refuseTeamWorkspace } from "./cli-repo-gate.js";
import { sectionNoun, showEntry } from "../backlog/backlog-write.js";

/** `bug --list --done -n` / `plan --list --done -n` ceiling: bounds how many finished
 * entries one list shows, so a typo'd huge count fails fast with the shared `must be between
 * 1 and <max>` wording (the logs/history/report pattern) instead of silently meaning
 * "everything". The finished lists are small (PLANS.md/BUGS.md), so the cap never meaningfully
 * binds — it exists for the uniform count-flag contract and the clear over-range rebuke. */
const BACKLOG_MAX_LISTED = 100_000;

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

/** Scans the `--list` flag vocabulary (`--list`, `--json`, `--done`, `--ready`, `-n`,
 * `--grep`, `-f/--follow`, each once, plus tolerated `--help`/`-h`) into the parsed locals and
 * returns them with `rest`, the leftover args rejectUnknownArgs will refuse. The follow flag
 * is recognized only as an unconsumed token — a `--grep` that consumed the next token as its
 * pattern never sees `-f` (so `--list --grep -f` greps the literal "-f"), exactly as the
 * `backlog` and `questions` follows do. Reads no entry, filters nothing, prints nothing; the
 * `fail` calls it makes are the flag-usage refusals (a repeat or a `--grep`/`-n` with missing
 * text). */
function parseListArgs(args: string[], command: string): {
  json: boolean;
  done: boolean;
  ready: boolean;
  count: number | null;
  grep: string | null;
  follow: boolean;
  rest: string[];
} {
  let json = false;
  let list = false;
  let done = false;
  let ready = false;
  let count: number | null = null;
  let grep: string | null = null;
  let follow = false;
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
      count = parseCountFlag("-n", args[++i], BACKLOG_MAX_LISTED);
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
    if (FOLLOW_FLAG.names.includes(arg)) {
      rejectRepeatFlag(follow, "-f/--follow");
      follow = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") continue;
    rest.push(arg);
  }
  return { json, done, ready, count, grep, follow, rest };
}

/** The `--done` half of the list shell's frame builder: the newest finished entries (BUGS.md
 * ## Fixed or PLANS.md ## Done), filtered by `--grep`, limited by `-n`, as the exact `--json`
 * payload or prose text — re-read per call so a follow frame renumbers as a fresh list would.
 * The caller serializes the payload through sayJson (one-shot, byte-exact) or the follow's
 * frame wrapper; only prose passes through say's terminal sanitization. */
function renderFinishedList(
  root: string,
  fileName: string,
  bugSection: boolean,
  grep: string | null,
  count: number | null,
  json: boolean,
): string | object {
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
    return {
      entries: shown.map(({ entry: e, position }) => ({
        position,
        title: e.title,
        body: e.body,
        completedOn: completionDate(e.title, dateRe),
      })),
      older,
    };
  }
  const what = bugSection ? "fixed bugs" : "done plans";
  if (shown.length === 0) return pattern === null ? `no ${what}` : `no ${what} match "${pattern}"`;
  const lines = shown.map((m) => `${m.position}. ${m.entry.title}`);
  if (older > 0) lines.push(`(${older} older; -n ${matches.length} shows more)`);
  const header = pattern === null ? `${what} in ${fileName}, newest first:` : `${what} in ${fileName} matching "${pattern}", newest first:`;
  return `${header}\n${lines.join("\n")}`;
}

/** One numbered entry as the active list prints it: `position` is the unfiltered 1-based
 * position `--edit`/`--cancel`/`--show <n>` address, carried through `--grep` and `--ready`. */
interface NumberedEntry {
  entry: BacklogEntry;
  position: number;
}

/** The active list's read-and-filter phase: the section's entries, each position's hold and
 * live claimer, the `--grep` matches under their unfiltered positions, the `--ready`
 * survivors, `hidden` (how many matches `--ready` dropped), the section's noun, and the
 * `--grep`/`--ready` flags the later phases re-check. */
interface ActiveListView {
  entries: BacklogEntry[];
  entryHolds: EntryHold[];
  entryRunners: (string | null)[];
  matches: NumberedEntry[];
  kept: NumberedEntry[];
  hidden: number;
  noun: string;
  grep: string | null;
  ready: boolean;
}

/** The active list's read-and-filter phase: reads the section's entries and each position's
 * hold and live claimer, numbers them unfiltered, keeps the `--grep` matches under those
 * positions, drops to the `--ready` survivors, counts what `--ready` hid, and names the noun. */
function activeListView(
  root: string,
  bugSection: boolean,
  sectionTitle: string,
  grep: string | null,
  ready: boolean,
): ActiveListView {
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
  return {
    entries,
    entryHolds,
    entryRunners,
    matches,
    kept,
    hidden: matches.length - kept.length,
    noun: sectionNoun(sectionTitle),
    grep,
    ready,
  };
}

/** The `--json` body: each kept entry as its position, title, verbatim body, hold,
 * in-progress claim and — only when the heading names a filing stamp — its `since`/`ageDays`. */
function activeListJson(view: ActiveListView): { entries: Record<string, unknown>[] } {
  const { kept, entryHolds, entryRunners } = view;
  return {
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
  };
}

/** The prose `no …` line for an empty list, a `--grep` with no match, or a `--ready` list
 * whose every match is held; null when `view.kept` has rows to print. */
function activeListEmptyLine(view: ActiveListView, command: string): string | null {
  const { entries, matches, kept, hidden, noun, grep, ready } = view;
  if (grep === null && entries.length === 0) return `no ${noun}s`;
  if (matches.length === 0) return `no ${noun}s match "${grep}"`;
  if (ready && kept.length === 0) return `no ${noun}s ready (${hidden} held; run \`tumwater ${command} --list\` to see them)`;
  return null;
}

/** The prose body of a non-empty active list: the bug list's numbered `line` rows, or the
 * plan list's `groupBlockedSeries` rows, each with the hidden-held notice when `hidden > 0`. */
function activeListProse(view: ActiveListView, fileName: string, command: string, bugSection: boolean): string {
  const { kept, entryHolds, entryRunners, hidden, noun } = view;
  const hiddenNote = `(${hidden} held entries hidden; run \`tumwater ${command} --list\` to see them)`;
  const line = (entry: { title: string }, i: number): string =>
    `${entry.title}${holdMark(entryHolds[i] ?? null)}${inProgressMark(entryRunners[i] ?? null)}${entryAgeSuffix(entry.title)}`;
  if (bugSection) {
    const bugLines = kept.map(({ entry, position }) => `${position}. ${line(entry, position - 1)}`);
    if (hidden > 0) bugLines.push(hiddenNote);
    return `${noun}s in ${fileName}:\n${bugLines.join("\n")}`;
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
  return `${noun}s in ${fileName}:\n${lines.join("\n")}`;
}

/** The active half of the list shell's frame builder: the open entries with their holds,
 * in-progress claim marks and age suffixes, optionally reduced to the ready ones, as the exact
 * `--json` payload or prose text, grouping a plan's blocked parts into one line
 * (groupBlockedSeries) — re-read per call so a follow frame renumbers as a fresh list would.
 * Orchestrates the four named phases below — the read-and-filter view (activeListView), the
 * `--json` body (activeListJson), the empty-list prose line (activeListEmptyLine) and the
 * bug/plan prose body (activeListProse). */
function renderActiveList(
  root: string,
  fileName: string,
  command: string,
  bugSection: boolean,
  sectionTitle: string,
  grep: string | null,
  ready: boolean,
  json: boolean,
): string | object {
  const view = activeListView(root, bugSection, sectionTitle, grep, ready);
  if (json) return activeListJson(view);
  const empty = activeListEmptyLine(view, command);
  if (empty !== null) return empty;
  return activeListProse(view, fileName, command, bugSection);
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
 * groups a series' blocked parts into one line (groupBlockedSeries).
 *
 * `-f/--follow` (the shared FOLLOW_FLAG, recognized only from an unconsumed token) repaints
 * the active or `--done` list every couple of seconds until Ctrl+C or the process that started
 * it exits — each frame re-reads the entries, the holds and the claims and renumbers as a
 * fresh list would. It composes with `--ready`, `--grep` and `-n`, and refuses `--json`
 * (a live view is one repainted document, not one snapshot). The one-shot branch prints
 * exactly the frame text through `say`. */
export async function listAndAnnounce(
  root: string,
  args: string[],
  command: string,
  fileName: string,
  sectionTitle: string,
  seams: FollowViewSeams = {},
): Promise<void> {
  const { json, done, ready, count, grep, follow, rest } = parseListArgs(args, command);
  // rejectUnknownArgs names a stray positional and an unknown flag with this command's (empty)
  // valid-flag list: every flag a list invocation accepts is consumed above, so anything left
  // is outside the vocabulary.
  rejectUnknownArgs(command, rest, []);
  refuseTeamWorkspace(root);
  if (count !== null && !done) fail("-n needs --done (it limits the finished entries listed)");
  // BUGS.md's `## Open` is the one section whose noun is "bug"; every other caller is a plan.
  if (ready && done) fail("--ready needs the active list (finished entries carry no holds)");
  if (follow && json) failFollowJsonRival(`${command} --list --json`);
  const bugSection = sectionTitle === "Open";
  const build = (): string | object =>
    done
      ? renderFinishedList(root, fileName, bugSection, grep, count, json)
      : renderActiveList(root, fileName, command, bugSection, sectionTitle, grep, ready, json);
  if (follow) {
    // follow refuses --json above, so every frame is prose here; stringify defensively for the
    // union the one-shot branch shares with it.
    await followView(() => {
      const frame = build();
      return typeof frame === "string" ? frame : JSON.stringify(frame, null, 2);
    }, seams);
    return;
  }
  const frame = build();
  // Prose goes through say's terminal sanitization; the JSON document keeps its raw bytes
  // through sayJson, the data-surface rule every --json command follows.
  if (typeof frame === "string") say(frame);
  else sayJson(frame);
}

/** The shell of `bug --show` and `plan --show`: `--show <n>` (once), an optional `--json`
 * and `--done` (each once; `--done` shows the Nth newest finished entry, as `--list --done`
 * numbers them, with its heading stamp kept and `completedOn` in --json),
 * `--help`/`-h` tolerated, anything else refused through rejectUnknownArgs. Read-only like
 * `--list`: no repo gate, commit, or wake. Prose is the title, a blank line, then the body, so
 * stdout is the file `--edit <n> --file` takes back. */
export function showAndAnnounce(root: string, args: string[], command: "bug" | "plan"): void {
  const { json, flags, position, rest } = scanPositionArgs(args, "--show", "--show 2", ["--done"]);
  rejectUnknownArgs(command, rest, []);
  refuseTeamWorkspace(root);
  if (position === null) fail(`--show needs a position (usage: tumwater ${command} --show <n>)`);
  if (flags["--done"]) {
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
