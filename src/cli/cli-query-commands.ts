/** The read-only query commands' bodies (status, diff, backlog, quarantine), split out of
 * cli.ts's dispatcher: main() routes to a cmd* here exactly as it routes to cli-operator-commands's
 * cmdAbort or cli-config-commands's cmdConfig, and cli.ts keeps only routing and the help/version
 * surfaces. Each command owns its argument gate, ready-repo gating decision, and output shape,
 * with the wording and gating order moved verbatim from main()'s cases. */

import { fail, say, sayJson, sayJsonOrRender } from "./cli-output.js";
import { followView, type FollowViewSeams } from "./follow-view.js";
import { failFollowJsonRival, flagValue, parseGrepFlag, parseRoleListScope, rejectFlagLookingValue, rejectRepeatFlag, scanPositionArgs } from "./cli-args.js";
import { DIFF_PATH_FLAG, FOLLOW_FLAG, hasFollowFlag, HELD_FLAG, JSON_FLAG, READY_FLAG, grepFlagSpec, rejectUnknownArgs, OVERLAPS_FLAG, ROLE_FLAG, STAT_FLAG } from "./cli-flag-specs.js";
import { refuseTeamWorkspace, requireReadyRepo } from "./cli-repo-gate.js";
import { scopeSnapshotToRoles, snapshot, snapshotForStatus } from "../status/status-data.js";
import { statusPayload } from "../ui/status-payload.js";
import { renderStatus } from "../ui/status-render.js";
import { gotSuffix } from "../text/text.js";
import { backlogPayload } from "../backlog/backlog.js";
import { backlogHolds, backlogInProgress } from "../backlog/backlog-eligibility.js";
import { readyBacklog, heldBacklog, grepBacklog, positionBacklog, renderBacklogMarkdown, type BacklogView, type PositionedEntry } from "../backlog/backlog-render.js";
import { loadQuarantine, releaseQuarantinedTest } from "../review/known-flakes.js";
import { grepQuarantineRows, quarantineEntryAt, quarantineRows, renderQuarantine, renderQuarantineDetail, type QuarantineRow } from "../review/quarantine-render.js";
import { collectChangeOverlaps, scopeChangeOverlaps, scopeChangeOverlapsToPath, collectTeamChanges, collectRoleChange, collectRoleChanges, normalizeDiffPath } from "../change/change-data.js";
import { renderChangeOverlaps, renderTeamChange, renderRoleChange, renderRoleChanges } from "../change/change-render.js";

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
      ? `\n\n_(${r.hidden} ${held ? "unheld" : "held"} entries hidden; run \`tumwater backlog\` to see them)_` : "");
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
  const grepAt = args.indexOf("--grep");
  const grepValueIndex = grepAt >= 0 ? grepAt + 1 : -1;
  const modeNamed = (flag: string): boolean =>
    args.some((arg, i) => arg === flag && i !== grepValueIndex);
  if (modeNamed("--show")) {
    await cmdQuarantineShow(root, args);
    return;
  }
  if (modeNamed("--release")) {
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
    fail(`no quarantined test at position ${position} (flake quarantine holds ${entries.length} tests)`);
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
    fail(`no quarantined test at position ${position} (flake quarantine holds ${rows.length} tests)`);
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

