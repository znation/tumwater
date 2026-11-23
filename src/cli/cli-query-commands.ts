/** The read-only query commands' bodies (status, diff, backlog, quarantine), split out of
 * cli.ts's dispatcher: main() routes to a cmd* here exactly as it routes to cli-operator-commands's
 * cmdAbort or cli-config-commands's cmdConfig, and cli.ts keeps only routing and the help/version
 * surfaces. Each command owns its argument gate, ready-repo gating decision, and output shape,
 * with the wording and gating order moved verbatim from main()'s cases. */

import { fail, say, sayJson, sayJsonOrRender } from "../terminal.js";
import { followView, type FollowViewSeams } from "../follow.js";
import { failFollowJsonRival, flagValue, parseGrepFlag, parseRoleListScope, rejectFlagLookingValue, rejectRepeatFlag, scanPositionArgs } from "./cli-args.js";
import { CLOSED_FLAG, DIFF_PATH_FLAG, FOLLOW_FLAG, hasFollowFlag, HELD_FLAG, JSON_FLAG, LOST_FLAG, OPEN_FLAG, READY_FLAG, grepFlagSpec, modeNamed, rejectUnknownArgs, OVERLAPS_FLAG, ROLE_FLAG, STAT_FLAG } from "./cli-flag-specs.js";
import { refuseTeamWorkspace, requireReadyRepo } from "./cli-repo-gate.js";
import { scopeSnapshotToRoles, snapshot, snapshotForStatus } from "../status/status-data.js";
import { statusPayload } from "../ui/status-payload.js";
import { renderStatus } from "../ui/status-render.js";
import { gotSuffix } from "../text/text.js";
import { agree, plural, validPositionRange } from "../text/phrases.js";
import { backlogPayload } from "../backlog/backlog.js";
import { backlogHolds, backlogInProgress } from "../backlog/backlog-eligibility.js";
import { readyBacklog, heldBacklog, grepBacklog, positionBacklog, renderBacklogMarkdown, type BacklogView, type PositionedEntry } from "../backlog/backlog-render.js";
import { loadQuarantine, releaseQuarantinedTest } from "../review/known-flakes.js";
import { grepQuarantineRows, quarantineEntryAt, quarantineRows, renderQuarantine, renderQuarantineDetail, type QuarantineRow } from "../review/quarantine-render.js";
import { collectChangeOverlaps, scopeChangeOverlaps, scopeChangeOverlapsToPath, collectTeamChanges, collectRoleChange, collectRoleChanges, normalizeDiffPath } from "../change/change-data.js";
import { renderChangeOverlaps, renderTeamChange, renderRoleChange, renderRoleChanges } from "../change/change-render.js";
import { readGithubIssues, type GithubIssuesLedger } from "../github/github-issues-state.js";
import {
  grepIssueRows,
  issueAtPosition,
  issueRows,
  issuesHeader,
  issuesJson,
  renderIssueDetail,
  renderIssues,
  stateIssueRows,
} from "../github/github-issues-render.js";
import type { IssueRow, IssueState, IssuesHeader } from "../github/github-issues-render.js";
import { githubTarget } from "../observer/remote-ci.js";
import { loadConfigSafe } from "../config/config.js";

/** `tumwater status [-f/--follow]`: the team snapshot as rendered text or as the JSON
 * document GET /api/status serves. `-f/--follow` repaints the table every couple of seconds
 * until Ctrl+C or the process that started it exits, so a backgrounded follow does not
 * outlive its parent. */
export async function cmdStatus(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  rejectUnknownArgs("status", args, [ROLE_FLAG, JSON_FLAG, FOLLOW_FLAG]);
  const follow = hasFollowFlag(args);
  if (follow && args.includes("--json")) failFollowJsonRival("status --json");
  await requireReadyRepo(root);
  const scope = parseRoleListScope(root, args);
  if (follow) {
    await followStatus(root, scope, seams);
    return;
  }
  if (args.includes("--json")) {
    // Machine-readable team state — the document GET /api/status serves minus the
    // serving process's own `serverBuildSha`, printed with no server. A query, not a
    // health verdict: exit 0 on any successful read and let scripts interpret fields
    // themselves ("running": false is data, not failure).
    sayJson(await statusPayload(root, Date.now(), scope));
  } else {
    const snap = await snapshot(root);
    say(renderStatus(root, scope ? scopeSnapshotToRoles(snap, scope) : snap, process.stdout.isTTY ? process.stdout.columns : undefined, scope !== null));
  }
}

/** `tumwater status -f`'s live loop: the team snapshot repainted until the parent exits. The
 * frame read stays synchronous (snapshotForStatus): followView repaints on a fixed interval and
 * the mock-clock follow tests depend on exactly one frame per tick, a shape only a same-turn
 * read keeps (the first paint must land in the tick that scheduled it, not a later one). When
 * the read becomes genuinely async (the pin re-point, next part) this moves to `await
 * snapshot`, which followView already guards (its `painting` flag skips a tick mid-frame). */
async function followStatus(root: string, scope: string[] | null, seams: FollowViewSeams): Promise<void> {
  const tty = seams.tty ?? process.stdout.isTTY;
  await followView(() => renderStatus(root, scope ? scopeSnapshotToRoles(snapshotForStatus(root), scope) : snapshotForStatus(root), tty ? process.stdout.columns : undefined, scope !== null), seams);
}

/** `tumwater diff`: one line per role holding pending work, the files two or more roles touch
 * with `--overlaps` (`--role` keeps those a listed role holds, `--path` those at or under it),
 * or the full per-role view of each role listed with `--role <id>[,<id>...]`. */
export async function cmdDiff(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  // The repo half of requireReadyRepo still gates: a directory tumwater cannot read yet
  // (no git, not a repository, no tumwater.json, no commits) has no team to ask about,
  // and the change view's own degradation would misreport that as "main branch <name>
  // does not exist" — so the shared readiness wording answers here, like every sibling
  // command. Past the gate an absent worktree still degrades to a `no worktree for
  // <role>` line (exit 0), so the command answers in any initialized directory —
  // report's rationale.
  rejectUnknownArgs("diff", args, [ROLE_FLAG, JSON_FLAG, STAT_FLAG, OVERLAPS_FLAG, DIFF_PATH_FLAG, FOLLOW_FLAG]);
  await requireReadyRepo(root);
  rejectRepeatFlag(args.filter((a) => a === "--path").length > 1, "--path");
  const follow = hasFollowFlag(args);
  if (follow && args.includes("--json")) failFollowJsonRival("diff --json");
  if (args.includes("--overlaps")) {
    if (args.includes("--stat")) fail("diff --overlaps prints paths, not patches; drop --stat");
    // Overlaps are computed across every role; --role only filters which entries print.
    const scope = parseRoleListScope(root, args);
    const path = diffPathArg(args);
    // The read and its zero-arg render are factored into one thunk so the follow's frame
    // and the snapshot print exactly the same text from the same reader.
    const readOverlaps = async () => {
      let view = await collectChangeOverlaps(root);
      if (scope === null && path === undefined) return { view, render: () => renderChangeOverlaps(view) };
      if (scope !== null) view = scopeChangeOverlaps(view, scope);
      if (path !== undefined) view = scopeChangeOverlapsToPath(view, path);
      return { view, render: () => renderChangeOverlaps(view, scope ?? undefined, path) };
    };
    if (follow) {
      await followView(async () => (await readOverlaps()).render(), seams);
      return;
    }
    const { view, render } = await readOverlaps();
    sayJsonOrRender(args, view, () => render());
    return;
  }
  // Absent --role is the team-wide form: one line per role holding pending work
  // (parseRoleListScope returns null only for an absent flag — an empty or unknown piece
  // already failed above). One named role keeps the single per-role view; a list prints each
  // listed role's view in order.
  const roles = parseRoleListScope(root, args);
  const path = roles === null ? undefined : diffPathArg(args);
  // The roster/role reads below are factored into a thunk (view + zero-arg render) so the
  // follow's frame and the snapshot share one reader and print byte-identical text.
  const readChange = async (): Promise<{ view: unknown; render: () => string }> => {
    if (roles === null) {
      if (args.includes("--stat")) fail("diff --stat needs --role <id> (the team roster prints no patch)");
      if (args.includes("--path")) fail("diff --path needs --role <id> (the team roster prints no patch)");
      const view = await collectTeamChanges(root);
      return { view, render: () => renderTeamChange(view) };
    }
    if (roles.length === 1) {
      const change = await collectRoleChange(root, roles[0]!, { stat: args.includes("--stat"), path });
      return { view: change, render: () => renderRoleChange(change) };
    }
    const view = await collectRoleChanges(root, roles, { stat: args.includes("--stat"), path });
    return { view, render: () => renderRoleChanges(view) };
  };
  if (follow) {
    await followView(async () => (await readChange()).render(), seams);
    return;
  }
  const { view, render } = await readChange();
  sayJsonOrRender(args, view, () => render());
}

/** The normalised `--path` value of `diff --role` (undefined when absent): leading `./` pieces
 * and trailing `/` characters stripped, failing on an empty, absolute or `..`-bearing result.
 * A `--` token in the value slot is refused via rejectFlagLookingValue first, so `diff --role
 * feature --path --json` names the flag instead of failing downstream as a path nobody meant. */
function diffPathArg(args: string[]): string | undefined {
  const raw = flagValue(args, "--path");
  if (raw === null || raw === undefined) return undefined;
  rejectFlagLookingValue("--path", raw);
  const norm = normalizeDiffPath(raw);
  if (norm === null)
    fail(`diff --path takes a repo-relative path such as src/cli.ts (as diff --overlaps prints it)${gotSuffix(raw)}`);
  return norm;
}

/** `tumwater backlog`: the planned/open entries as Markdown or as the GUI's JSON payload. */
export async function cmdBacklog(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  // No requireReadyRepo gate: the entry readers degrade to [] on a missing file, so the
  // command prints three empty sections in any directory (report's rationale, not config's);
  // the team-workspace refusal still applies.
  // --grep filters the three entry arrays to the matches, the finished-entry lists' one
  // matcher (entryMatches) on the active backlog; it composes with --ready or --held (grep
  // first, so the hidden count and the kept entries count only the matches) and with
  // --json. The missing-value wording lives in BACKLOG_GREP_VALUE_ERROR, the flag gate's
  // and this parser's shared string. -f/--follow repaints the same view every couple of
  // seconds until Ctrl+C or the parent process exits, composing with --ready/--held and
  // --grep; it refuses --json (a live view is one repainted document, not one snapshot).
  const BACKLOG_GREP_VALUE_ERROR = "backlog --grep needs text (usage: tumwater backlog --grep <text>)";
  rejectUnknownArgs("backlog", args, [JSON_FLAG, READY_FLAG, HELD_FLAG, grepFlagSpec(BACKLOG_GREP_VALUE_ERROR), FOLLOW_FLAG]);
  refuseTeamWorkspace(root);
  const { rest, pattern } = parseGrepFlag(args, BACKLOG_GREP_VALUE_ERROR);
  const ready = rest.includes("--ready");
  const held = rest.includes("--held");
  if (ready && held) fail("--ready and --held are mutually exclusive: each keeps the entries the other hides");
  const follow = hasFollowFlag(rest);
  if (follow && rest.includes("--json")) failFollowJsonRival("backlog --json");
  // Machine-readable backlog — the three entry arrays the Markdown view renders and the
  // GUI's /api/backlog serves (status --json's "print the endpoint's payload" pattern),
  // plus `holds.plans`/`holds.bugs` parallel to the entry arrays so a skipped entry's
  // reason is data, not inference: a pretty-printed JSON document in every exit-0 case,
  // never prose. The payload is read once per branch (snapshot or frame) so the Markdown
  // renderer and the JSON document consume the same arrays.
  // --ready filters both branches through readyBacklog, --held through heldBacklog (its
  // inverse); the Markdown branch adds a count of the entries the filter hid (held for
  // --ready, unheld for --held). The --json/--ready/--held reads go over `rest` (the --grep
  // value token removed), so a flag-shaped pattern like `--grep --json` greps for "--json"
  // rather than flipping this branch into JSON mode. positionBacklog numbers every row 1-based
  // in its section's file order — the number `plan|bug --show/--cancel <n>` and `questions
  // answer <n>` take — before the filters run, so a kept row keeps its unfiltered position in
  // the --json document (the filters pick their survivors by index); the Markdown renderer
  // ignores the extra field, so the text output is unchanged.
  const readBacklog = (): { view: BacklogView<PositionedEntry>; hidden: number } => {
    const view = positionBacklog({ ...backlogPayload(root), holds: backlogHolds(root), inProgress: backlogInProgress(root) });
    const filtered = pattern === null ? view : grepBacklog(view, pattern);
    if (!ready && !held) return { view: filtered, hidden: 0 };
    const kept = ready ? readyBacklog(filtered) : heldBacklog(filtered);
    return { view: kept, hidden: filtered.plans.length + filtered.bugs.length - kept.plans.length - kept.bugs.length };
  };
  const renderBacklogText = (r: { view: BacklogView<PositionedEntry>; hidden: number }): string =>
    renderBacklogMarkdown(r.view) + (r.hidden > 0
      ? `\n\n_(${r.hidden} ${held ? "unheld" : "held"} ${agree(r.hidden, "entry", "entries")} hidden; run \`tumwater backlog\` to see them)_` : "");
  if (follow) {
    await followView(() => renderBacklogText(readBacklog()), seams);
    return;
  }
  const result = readBacklog();
  sayJsonOrRender(rest, result.view, () => renderBacklogText(result));
}

// `tumwater quarantine [-f/--follow] [--release <n>] [--json]` — the view of the review
// gate's flake quarantine, read-only except the one destructive `--release <n>` mode that
// removes the Nth entry the list prints at the operator's request. `-f/--follow` repaints the
// list every couple of seconds until Ctrl+C or the process that started it exits, so a
// backgrounded follow does not outlive its parent (the same rule `queue -f` uses). The read
// path keeps its no-gate refuseTeamWorkspace stance: loadQuarantine degrades an absent or
// malformed file to the empty list, so the command prints the empty line in any directory and
// the read never writes quarantine.json (a test otherwise leaves the list through
// releaseQuarantine). --json serves the same positioned rows to scripts.
export async function cmdQuarantine(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  // `--release <n>` is the read-only command's one destructive mode, and `--show <n>` its
  // read-only detail view: route each to its own branch before the read gate, exactly as
  // cmdReviews routes `--accept`. `--show` is checked first so its own flag gate owns a
  // `--release` it finds beside it, refusing it by name. A `--show`/`--release` token in
  // --grep's value slot is the pattern, not the mode: routing on it would make
  // `--grep --release` or `--grep --show` fail with that mode's missing-position error
  // instead of filtering.
  if (modeNamed(args, "--show")) {
    await cmdQuarantineShow(root, args);
    return;
  }
  if (modeNamed(args, "--release")) {
    await cmdQuarantineRelease(root, args);
    return;
  }
  // --grep filters the positioned rows to the entries whose test path or filed-bug heading
  // contains the text (case-insensitively), each kept row's position unchanged so `--show`/
  // `--release` keep addressing the whole list. The missing-value wording lives in
  // QUARANTINE_GREP_VALUE_ERROR, the flag gate's and this parser's shared string.
  // -f/--follow and --json scan over `rest` (the pattern token removed), so a flag-shaped
  // pattern like `--grep --json` is the text "--json", not the rival flag.
  const QUARANTINE_GREP_VALUE_ERROR = "quarantine --grep needs text (usage: tumwater quarantine --grep <text>)";
  rejectUnknownArgs("quarantine", args, [JSON_FLAG, FOLLOW_FLAG, grepFlagSpec(QUARANTINE_GREP_VALUE_ERROR)]);
  refuseTeamWorkspace(root);
  const { rest, pattern } = parseGrepFlag(args, QUARANTINE_GREP_VALUE_ERROR);
  const follow = hasFollowFlag(rest);
  if (follow && rest.includes("--json")) failFollowJsonRival("quarantine --json");
  // Each frame re-reads the quarantine file and reads the clock once, so an entry that
  // appears, ages toward the ceiling, or leaves when its bug closes shows up in the next
  // repaint — the same per-frame read `queue -f` uses. The --grep filter applies inside the
  // per-frame read, so a filtered frame still numbers the kept rows whole-list.
  const readRows = (): { full: QuarantineRow[]; kept: QuarantineRow[] } => {
    const rows = quarantineRows(loadQuarantine(root));
    return { full: rows, kept: pattern === null ? rows : grepQuarantineRows(rows, pattern) };
  };
  // The no-match prose is a filter's line (the list is non-empty but nothing matches); a
  // genuinely empty quarantine keeps "flake quarantine is empty", and --json prints the
  // filtered rows in both cases.
  const renderRows = (r: { full: QuarantineRow[]; kept: QuarantineRow[] }): string =>
    pattern !== null && r.kept.length === 0 && r.full.length > 0
      ? `no quarantined tests match "${pattern}"`
      : renderQuarantine(r.kept, Date.now());
  if (follow) {
    await followView(() => renderRows(readRows()), seams);
    return;
  }
  const rows = readRows();
  sayJsonOrRender(rest, { tests: rows.kept }, () => renderRows(rows));
}

/** The `tumwater quarantine --show <n>` branch: print the Nth entry `tumwater quarantine`
 * lists read-only and in full — the whole test path, both ages, flake count, the whole
 * filed-bug heading (`not filed` when none), a `recurred` entry's recurrence line, and the kept
 * failing output verbatim when one is stored — so an operator can read why the gate is
 * excusing a test without opening quarantine.json. It is the detail twin of `--release <n>`'s
 * position addressing and shares its parse (`scanPositionArgs`) and out-of-range wording, but
 * stays on the read's `refuseTeamWorkspace` (no `requireReadyRepo`) so it never needs a
 * ready-tree like the destructive branch does. `--json` serves the entry's unsquashed fields.
 */
async function cmdQuarantineShow(root: string, args: string[]): Promise<void> {
  const { json, position, rest } = scanPositionArgs(args, "--show", "--show 2");
  rejectUnknownArgs("quarantine", rest, []);
  if (position === null) fail("--show needs a position (usage: tumwater quarantine --show <n>)");
  refuseTeamWorkspace(root);
  const entries = loadQuarantine(root);
  const entry = quarantineEntryAt(entries, position);
  if (entry === null) {
    const range = validPositionRange(entries.length);
    fail(`no quarantined test at position ${position} (flake quarantine holds ${plural(entries.length, "test")})${range}`);
  }
  if (json) {
    sayJson({
      position,
      test: entry.test,
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
      count: entry.count,
      bug: entry.bug,
      ...(entry.tail ? { tail: entry.tail } : {}),
      ...(entry.recurred ? { recurred: true } : {}),
    });
  } else {
    say(renderQuarantineDetail(entry, position, Date.now()));
  }
}

/** The `tumwater quarantine --release <n>` branch: remove the Nth entry `tumwater quarantine`
 * lists (the same oldest-first 1..N row `quarantineRows` prints) at the operator's request,
 * the manual twin of the auto-release that fires when a filed bug leaves `## Open`. Parsed the
 * way cmdReviewsAccept parses `--accept`: `--release <n>` the one valued flag, `--json` the one
 * boolean (at most once), `--help`/`-h` tolerated, anything else refused. An out-of-range
 * position fails naming the current depth; a concurrent removal answers `false`. */
async function cmdQuarantineRelease(root: string, args: string[]): Promise<void> {
  const { json, position, rest } = scanPositionArgs(args, "--release", "--release 2");
  rejectUnknownArgs("quarantine", rest, []);
  if (position === null) fail("--release needs a position (usage: tumwater quarantine --release <n>)");
  await requireReadyRepo(root);
  const rows = quarantineRows(loadQuarantine(root));
  if (position < 1 || position > rows.length) {
    const range = validPositionRange(rows.length);
    fail(`no quarantined test at position ${position} (flake quarantine holds ${plural(rows.length, "test")})${range}`);
  }
  const test = rows[position - 1]!.test;
  if (!releaseQuarantinedTest(root, test)) {
    fail(`quarantined test at position ${position} is already gone`);
  }
  if (json) {
    sayJson({ released: { position, test } });
  } else {
    say(`released quarantined test ${position}: ${test} — the gate no longer excuses it`);
  }
}


/** `tumwater issues [-f/--follow] [--open|--closed|--lost] [--show <n>] [--grep <text>] [--json]`:
 * the GitHub-issues mirror read from its ledger file alone. The mirror series
 * (plans/github-issues.md) scans GitHub
 * after each merge and records what it saw and what tumwater did about each issue in
 * .tumwater/state/github-issues.json; until this command the only views of that record were the
 * doctor's one `github issues` row and the status snapshot's counts. The read goes through
 * `readGithubIssues` and never shells out to `gh` — invariant 2 of that plan keeps `gh` calls in
 * the orchestrator's scan and the doctor's check, so the command works with `gh` nowhere on PATH
 * and on any branch. `--show <n>`, `--grep <text>` and `--json` follow the shape `cmdQuarantine`
 * established for the same three views. `-f/--follow` repaints this read on the shared follow
 * interval, re-reading the ledger each frame, so an operator can watch a merge's scan and its
 * closes land without rerunning the command. `--open`/`--closed`/`--lost` narrow the rows to one
 * state at the same place `--grep` does, so all three filters keep whole-list positions and the
 * header keeps naming the mirror's own counts. */
export async function cmdIssues(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  // `--show <n>` is routed before the flag gate exactly as cmdQuarantine routes its own detail
  // mode, so the detail branch owns its flag gate and refuses a `--grep` beside it by name. A
  // `--show` token in --grep's value slot is the pattern, not the mode (modeNamed skips that slot).
  if (modeNamed(args, "--show")) {
    await cmdIssuesShow(root, args);
    return;
  }
  // --grep keeps only the issues whose number or title contains the text (case-insensitively),
  // each kept row still numbered as the full list numbers it, so `--show` addresses the same
  // issue. The missing-value wording is shared by this parser and the flag gate.
  const ISSUES_GREP_VALUE_ERROR = "issues --grep needs text (usage: tumwater issues --grep <text>)";
  rejectUnknownArgs("issues", args, [JSON_FLAG, FOLLOW_FLAG, grepFlagSpec(ISSUES_GREP_VALUE_ERROR), OPEN_FLAG, CLOSED_FLAG, LOST_FLAG]);
  refuseTeamWorkspace(root);
  // -f/--follow and --json scan over `rest` (the pattern token removed), so a flag-shaped
  // pattern like `--grep --json` is the text "--json", not the rival flag. --json is a rival of
  // the follow exactly as it is for `quarantine -f`: the follow is the human's view.
  const { rest, pattern } = parseGrepFlag(args, ISSUES_GREP_VALUE_ERROR);
  // The state filter, read off `rest` for the same reason --json is: `--grep --closed` takes
  // "--closed" as the pattern, so that token is filter text, not the flag. Each of the three
  // flags keeps the rows the others hide, so spelling two is a contradiction, worded as
  // `backlog --ready --held` words its own pair — one wording per pair, so the refusal names the
  // two flags actually written. A repeat of one spelling is stopped earlier, by the flag gate's
  // "may only be given once" rule.
  refuseRivalStates(rest);
  const state: IssueState | null =
    rest.includes("--closed") ? "closed" : rest.includes("--lost") ? "lost" : rest.includes("--open") ? "open" : null;
  const follow = hasFollowFlag(rest);
  if (follow && rest.includes("--json")) failFollowJsonRival("issues --json");
  // Each frame re-reads the ledger file, so a scan that lands while the follow runs shows in the
  // next repaint — the same per-frame read `quarantine -f` uses, and why the follow needs no
  // interval of its own: one frame is one file read, so it cannot straddle a scan the way a
  // poller's own cadence would. The --grep filter and the state filter both apply inside the
  // read, so a filtered frame still numbers its kept rows by their whole-list positions. `full`
  // stays the whole list so the frame can tell an empty mirror from a filter that kept nothing.
  const readIssues = (): { ledger: GithubIssuesLedger | null; full: IssueRow[]; kept: IssueRow[] } => {
    const ledger = readGithubIssues(root);
    const full = ledger === null ? [] : issueRows(ledger);
    let kept = full;
    if (pattern !== null) kept = grepIssueRows(kept, pattern);
    if (state !== null) kept = stateIssueRows(kept, state);
    return { ledger, full, kept };
  };
  // The text the read answers with, for a frame or a one-shot print alike. A mirror that has
  // never been read is a state, not an empty list, so it is said in words (the same reason the
  // quarantine list says its empty line) and --json carries it as read:false. The no-match prose
  // is a filter's line (the mirror holds issues but none match); a mirror with nothing on record
  // keeps the header's `0 open` line. A pattern owns that line even beside a state filter — the
  // pattern is the narrower question — while a state filter alone names the state it found empty.
  const renderIssuesFrame = (): string => {
    const { ledger, full, kept } = readIssues();
    if (ledger === null) return "the GitHub issues mirror has not been read yet";
    if (kept.length === 0 && full.length > 0) {
      if (pattern !== null) return `no GitHub issues match "${pattern}"`;
      // The state's own empty line, named by the flag that asked for it. A bare read (state null)
      // cannot reach here with nothing kept and a non-empty mirror, so it keeps the open wording.
      return state === "lost" ? "no lost GitHub issues" : state === "closed" ? "no closed GitHub issues" : "no open GitHub issues";
    }
    const header: IssuesHeader = issuesHeader(ledger);
    return renderIssues(kept, header, Date.now());
  };
  if (follow) {
    await followView(renderIssuesFrame, seams);
    return;
  }
  const { ledger, kept } = readIssues();
  if (rest.includes("--json")) {
    // No scan has written a ledger yet (or the file is unreadable): an empty answer, not an
    // error, the way the quarantine command answers an absent quarantine file. --json names the
    // resolved target so a script can tell which remote the mirror would read.
    if (ledger === null) {
      sayJson({ read: false, ...(await issuesTarget(root)) });
      return;
    }
    sayJson(issuesJson(kept, issuesHeader(ledger)));
    return;
  }
  say(renderIssuesFrame());
}

/** Refuse two of the three `issues` state flags. Each keeps the rows the other hides, so naming
 * the written pair is the whole message; the three pairs share one sentence shape, spelled out
 * rather than generated, so each wording is greppable as the exact line the operator reads. A
 * repeat of one spelling never reaches here — the flag gate stops it first. */
function refuseRivalStates(rest: readonly string[]): void {
  const pairs: readonly [string, string][] = [
    ["--open", "--closed"],
    ["--open", "--lost"],
    ["--closed", "--lost"],
  ];
  for (const [a, b] of pairs) {
    if (rest.includes(a) && rest.includes(b)) {
      fail(`${a} and ${b} are mutually exclusive: each keeps the issues the other hides`);
    }
  }
}

/** The `tumwater issues --show <n>` branch: print the Nth issue the list prints, in full — the
 * whole title, url, author and its association, labels, the ISO update time, tumwater's own state
 * for that issue (queued, declined with its reason, fixed by a sha, closed, waiting for a push, or
 * every mirroring entry retired), and the body excerpt when the ledger holds one — so an operator
 * can read why an issue was left alone without opening the ledger. It shares the quarantine
 * detail view's position parse (`scanPositionArgs`) and out-of-range wording, and stays on
 * `refuseTeamWorkspace`: reading a ledger needs no ready repo and no `gh`. */
async function cmdIssuesShow(root: string, args: string[]): Promise<void> {
  const { json, position, rest } = scanPositionArgs(args, "--show", "--show 2");
  rejectUnknownArgs("issues", rest, []);
  if (position === null) fail("--show needs a position (usage: tumwater issues --show <n>)");
  refuseTeamWorkspace(root);
  // A project with no ledger answers the same way the quarantine detail view answers an absent
  // quarantine file: the position is past the end of a mirror holding 0 issues. The whole
  // numbering+miss rule lives in the render module (issueAtPosition), because the dashboard's
  // GET /api/issues-show states the same case in the same words (INV-DE6).
  const at = issueAtPosition(readGithubIssues(root), position);
  if ("message" in at) fail(at.message);
  const row = at.row;
  // The row already carries its position (issueRows numbers it), so --json serves it as-is.
  if (json) sayJson({ ...row });
  else say(renderIssueDetail(row, position, Date.now()));
}

/** The repo and branch the mirror reads, for the no-ledger `--json` document: the same
 * `githubTarget` resolution the scan and the doctor's `github issues` check use (a read-only
 * `git config` lookup, no network). Both fields are null when the project pushes to no GitHub
 * remote, which is exactly when the mirror never runs. */
async function issuesTarget(root: string): Promise<{ repo: string | null; branch: string | null }> {
  const loaded = loadConfigSafe(root);
  if (!loaded.config) return { repo: null, branch: null }; // a broken tumwater.json names no target
  const target = await githubTarget(root, loaded.config);
  return { repo: target?.repo ?? null, branch: target?.branch ?? null };
}
