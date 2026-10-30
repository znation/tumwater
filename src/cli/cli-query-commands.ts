/** The read-only query commands' bodies (status, diff, queue, backlog), split out of
 * cli.ts's dispatcher: main() routes to a cmd* here exactly as it routes to operator-commands's
 * cmdAbort or cli-config-commands's cmdConfig, and cli.ts keeps only routing and the help/version
 * surfaces. Each command owns its argument gate, ready-repo gating decision, and output shape,
 * with the wording and gating order moved verbatim from main()'s cases. */

import { fail, say, sayJson, sayJsonOrRender } from "./cli-output.js";
import { cancelQueuedMerge, type CancelQueuedOutcome } from "../merge/merge-cancel.js";
import { moveQueuedMergeToTop, type TopQueuedOutcome } from "../merge/merge-top.js";
import { followView, type FollowViewSeams } from "./follow-view.js";
import { flagValue, parseGrepFlag, parseRoleListScope, rejectRepeatFlag, scanPositionArgs } from "./cli-args.js";
import { DIFF_PATH_FLAG, FOLLOW_FLAG, hasFollowFlag, JSON_FLAG, READY_FLAG, grepFlagSpec, rejectUnknownArgs, OVERLAPS_FLAG, ROLE_FLAG, STAT_FLAG } from "./cli-flag-specs.js";
import { refuseTeamWorkspace, requireReadyRepo } from "./cli-repo-gate.js";
import { scopeSnapshotToRoles, snapshot } from "../status/status-data.js";
import { statusPayload } from "../ui/status-payload.js";
import { renderStatus } from "../ui/status-render.js";
import { gotSuffix } from "../text/text.js";
import { backlogPayload } from "../backlog/backlog.js";
import { backlogHolds, backlogInProgress } from "../backlog/backlog-eligibility.js";
import { readyBacklog, grepBacklog, renderBacklogMarkdown } from "../backlog/backlog-render.js";
import { loadQuarantine, releaseQuarantinedTest } from "../review/known-flakes.js";
import { quarantineRows, renderQuarantine } from "../review/quarantine-render.js";
import { collectChangeOverlaps, scopeChangeOverlaps, scopeChangeOverlapsToPath, collectTeamChanges, collectRoleChange, collectRoleChanges, normalizeDiffPath } from "../change/change-data.js";
import { renderChangeOverlaps, renderTeamChange, renderRoleChange, renderRoleChanges } from "../change/change-render.js";
import { readMergeQueue, type MergeQueueView } from "../merge/merge-queue.js";
import { renderMergeQueue, scopeMergeQueue } from "../merge/merge-queue-render.js";
import { mergeHoldsSha, type MergeInFlight } from "../merge/merge-slot.js";
import { shortSha } from "../text/format.js";
import { roleLabel } from "../roles/role-labels.js";
import { orchestratorAlive } from "../team/team-orchestrator-info.js";
import { queueInFlight } from "../status/status-polls.js";
import { roleInScope } from "../roles/runner-ids.js";

/** `tumwater status [-f/--follow]`: the team snapshot as rendered text or as the JSON
 * document GET /api/status serves. `-f/--follow` repaints the table every couple of seconds
 * until Ctrl+C or the process that started it exits, so a backgrounded follow does not
 * outlive its parent. */
export async function cmdStatus(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  rejectUnknownArgs("status", args, [ROLE_FLAG, JSON_FLAG, FOLLOW_FLAG]);
  const follow = hasFollowFlag(args);
  if (follow && args.includes("--json")) fail("status --json prints one document; -f/--follow repaints a live view — drop one of them");
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
    sayJson(statusPayload(root, Date.now(), scope));
  } else {
    const snap = snapshot(root);
    say(renderStatus(root, scope ? scopeSnapshotToRoles(snap, scope) : snap, process.stdout.isTTY ? process.stdout.columns : undefined, scope !== null));
  }
}

/** `tumwater status -f`'s live loop: the team snapshot repainted until the parent exits. */
async function followStatus(root: string, scope: string[] | null, seams: FollowViewSeams): Promise<void> {
  const tty = seams.tty ?? process.stdout.isTTY;
  await followView(() => renderStatus(root, scope ? scopeSnapshotToRoles(snapshot(root), scope) : snapshot(root), tty ? process.stdout.columns : undefined, scope !== null), seams);
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
  if (follow && args.includes("--json")) fail("diff --json prints one document; -f/--follow repaints a live view — drop one of them");
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
 * and trailing `/` characters stripped, failing on an empty, absolute or `..`-bearing result. */
function diffPathArg(args: string[]): string | undefined {
  const raw = flagValue(args, "--path");
  if (raw === null || raw === undefined) return undefined;
  const norm = normalizeDiffPath(raw);
  if (norm === null)
    fail(`diff --path takes a repo-relative path such as src/cli.ts (as diff --overlaps prints it)${gotSuffix(raw)}`);
  return norm;
}

/** `tumwater queue [-f/--follow]`: the durable merge queue in execution order, as text or as
 * the `{entries, unreadable}` document. `-f/--follow` repaints the queue every couple of
 * seconds until Ctrl+C or the process that started it exits, so a backgrounded follow does
 * not outlive its parent (the same rule `status -f` uses). */
export async function cmdQueue(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  // `tumwater queue --cancel <n>` is the read-only command's one destructive mode: route it
  // to its own branch before the read gate, so --cancel never leaks into the view parsing.
  if (args.includes("--cancel")) {
    await cmdQueueCancel(root, args);
    return;
  }
  if (args.includes("--top")) {
    await cmdQueueTop(root, args);
    return;
  }
  // The repo half of requireReadyRepo gates: like every repo-bound query, a directory
  // tumwater cannot read yet has no queue to show. Past the gate an absent queue dir reads
  // as an empty queue (a `merge queue empty` line, exit 0), so no merge ever queued is
  // data, not an error.
  rejectUnknownArgs("queue", args, [ROLE_FLAG, JSON_FLAG, FOLLOW_FLAG]);
  await requireReadyRepo(root);
  const roles = parseRoleListScope(root, args);
  const follow = hasFollowFlag(args);
  if (follow && args.includes("--json")) fail("queue --json prints one document; -f/--follow repaints a live view — drop one of them");
  // Scoped read shared by the follow and the one-shot branches, so the render's age and the
  // in-flight marker share one clock read and each frame re-reads the queue. --role keeps
  // the listed roles' entries (a base id taking its instances too) under their whole-queue
  // positions; the in-flight marker is judged against the kept entries only, and
  // `unreadable` stays whole because an unreadable file has no role to attribute it to.
  const readQueue = (): { view: MergeQueueView; inFlight: MergeInFlight | undefined; scope: ReturnType<typeof scopeMergeQueue>["scope"] | undefined } => {
    const whole = readMergeQueue(root);
    const scoped = roles ? scopeMergeQueue(whole, roles, (r) => roleInScope(r, roles)) : undefined;
    const view = scoped ? scoped.view : whole;
    return { view, inFlight: queueInFlight(root, view.entries, orchestratorAlive(root)), scope: scoped?.scope };
  };
  if (follow) {
    await followView(() => {
      const { view, inFlight, scope } = readQueue();
      return renderMergeQueue(view, Date.now(), inFlight, scope);
    }, seams);
    return;
  }
  const { view, inFlight, scope } = readQueue();
  sayJsonOrRender(args, inFlight ? { ...view, inFlight } : view, () => renderMergeQueue(view, Date.now(), inFlight, scope));
}

/** The `tumwater queue --cancel <n>` branch (PLANS.md): remove the Nth queued merge `tumwater
 * queue` lists and delete its role's merge pin, so next-run leftover recovery cannot silently
 * re-enqueue the change. Parsed as cancelAndAnnounce parses `--cancel` (backlog-cli.ts):
 * `--cancel <n>` the one valued flag, `--json` the one boolean (at most once), `--help`/-h
 * tolerated, anything else refused. --role and -f/--follow are refused by name — a live view
 * repaints a read, and position numbers come from the whole queue, whose numbering is
 * `tumwater queue`'s. An entry a live merge marker names for this sha is refused (wait for it
 * to land, then revert); an out-of-range position fails naming the current depth. */
async function cmdQueueCancel(root: string, args: string[]): Promise<void> {
  const { json, position, rest } = scanPositionArgs(args, "--cancel", "--cancel 2");
  // The vocabulary a cancel invocation accepts is exactly --cancel and --json, both consumed
  // above; --role and -f/--follow are refused with the queue-specific wording the tests pin.
  if (rest.includes("--role")) fail("queue --cancel cancels by whole-queue position from `tumwater queue`; --role scopes a read only — drop it");
  if (rest.includes("--follow") || rest.includes("-f")) fail("queue --cancel removes one entry; -f/--follow repaints a live view — drop it");
  rejectUnknownArgs("queue", rest, []);
  if (position === null) fail("--cancel needs a position (usage: tumwater queue --cancel <n>)");
  await requireReadyRepo(root);
  // Refuse the entry a live merge marker names before touching it: it is mid-flight (being
  // reviewed or merged), so cancelling it would race the slot that owns it.
  const view = readMergeQueue(root);
  const inFlight = queueInFlight(root, view.entries, orchestratorAlive(root));
  const target = view.entries[position - 1];
  if (inFlight && target && mergeHoldsSha(inFlight, target.sha)) {
    fail(`queue entry ${position} is being merged right now — wait for it to land, then \`tumwater revert ${shortSha(target.sha)}\``);
  }
  const outcome: CancelQueuedOutcome = await cancelQueuedMerge(root, position);
  if (outcome.status === "out-of-range") {
    fail(`no queued merge at position ${position} (merge queue holds ${outcome.depth})`);
  }
  if (json) {
    sayJson({ cancelled: { role: outcome.role, commit: outcome.sha, summary: outcome.summary } });
  } else {
    say(`cancelled queue entry ${position}: ${roleLabel(outcome.role)} ${shortSha(outcome.sha)} — ${outcome.summary}`);
  }
}

/** The `tumwater queue --top <n>` branch (PLANS.md): move the Nth queued merge `tumwater
 * queue` lists to the front of the execution order by renaming its queue file to a stamp
 * below the queue's minimum, so it merges next when ready. `cmdQueueCancel`'s twin: `--top
 * <n>` the one valued flag, `--json` the one boolean (at most once), `--help`/-h tolerated,
 * anything else refused. --role and -f/--follow are refused by name — a live view repaints
 * a read, and position numbers come from the whole queue, whose numbering is
 * `tumwater queue`'s. An entry a live merge marker names for this sha is refused — it is past
 * the queue, so there is nothing to top (unlike `--cancel`, reverting it would undo the change
 * the operator wanted first; the guidance says only that it is already heading in); an
 * out-of-range position fails naming the current depth; position 1 prints the already-first
 * line and exits 0; a concurrently-drained entry prints the gone line and exits 0. */
async function cmdQueueTop(root: string, args: string[]): Promise<void> {
  const { json, position, rest } = scanPositionArgs(args, "--top", "--top 2");
  // The vocabulary a top invocation accepts is exactly --top and --json, both consumed
  // above; --role and -f/--follow are refused with the queue-specific wording the tests pin.
  if (rest.includes("--role")) fail("queue --top moves by whole-queue position from `tumwater queue`; --role scopes a read only — drop it");
  if (rest.includes("--follow") || rest.includes("-f")) fail("queue --top moves one entry; -f/--follow repaints a live view — drop it");
  rejectUnknownArgs("queue", rest, []);
  if (position === null) fail("--top needs a position (usage: tumwater queue --top <n>)");
  await requireReadyRepo(root);
  // Refuse the entry a live merge marker names before touching it: it is mid-flight (being
  // reviewed or merged), so topping it would race the slot that owns it.
  const view = readMergeQueue(root);
  const inFlight = queueInFlight(root, view.entries, orchestratorAlive(root));
  const target = view.entries[position - 1];
  if (inFlight && target && mergeHoldsSha(inFlight, target.sha)) {
    fail(`queue entry ${position} is being merged right now — it's already heading into the merge, so there's nothing to top`);
  }
  const outcome: TopQueuedOutcome = moveQueuedMergeToTop(root, position);
  if (outcome.status === "out-of-range") {
    fail(`no queued merge at position ${position} (merge queue holds ${outcome.depth})`);
  }
  if (json) {
    // Every non-failure outcome, `gone` included, exits 0 with a parseable document; the
    // drained entry carries no role/sha/summary, so its JSON names only the position, and
    // an already-first no-op names its own key rather than masquerading as a top.
    if (outcome.status === "gone") {
      sayJson({ gone: { position } });
    } else if (outcome.status === "already-first") {
      sayJson({ "already-first": { role: outcome.role, commit: outcome.sha, summary: outcome.summary } });
    } else {
      sayJson({ topped: { role: outcome.role, commit: outcome.sha, summary: outcome.summary } });
    }
    return;
  }
  if (outcome.status === "gone") {
    say(`queue entry ${position} was already taken by the merge before it could be moved to the front`);
    return;
  }
  if (outcome.status === "already-first") {
    say(`queue entry ${position} is already first: ${roleLabel(outcome.role)} ${shortSha(outcome.sha)} — ${outcome.summary}`);
  } else {
    say(`moved queue entry ${position} to the front: ${roleLabel(outcome.role)} ${shortSha(outcome.sha)} — ${outcome.summary}`);
  }
}

/** `tumwater backlog`: the planned/open entries as Markdown or as the GUI's JSON payload. */
export async function cmdBacklog(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  // No requireReadyRepo gate: the entry readers degrade to [] on a missing file, so the
  // command prints three empty sections in any directory (report's rationale, not config's);
  // the team-workspace refusal still applies.
  // --grep filters the three entry arrays to the matches, the finished-entry lists' one
  // matcher (entryMatches) on the active backlog; it composes with --ready (grep first, so
  // the hidden count and the kept entries count only the matches) and with --json. The
  // missing-value wording lives in BACKLOG_GREP_VALUE_ERROR, the flag gate's and this
  // parser's shared string. -f/--follow repaints the same view every couple of seconds
  // until Ctrl+C or the parent process exits, composing with --ready and --grep; it refuses
  // --json (a live view is one repainted document, not one snapshot).
  const BACKLOG_GREP_VALUE_ERROR = "backlog --grep needs text (usage: tumwater backlog --grep <text>)";
  rejectUnknownArgs("backlog", args, [JSON_FLAG, READY_FLAG, grepFlagSpec(BACKLOG_GREP_VALUE_ERROR), FOLLOW_FLAG]);
  refuseTeamWorkspace(root);
  const { rest, pattern } = parseGrepFlag(args, BACKLOG_GREP_VALUE_ERROR);
  const ready = rest.includes("--ready");
  const follow = hasFollowFlag(rest);
  if (follow && rest.includes("--json")) fail("backlog --json prints one document; -f/--follow repaints a live view — drop one of them");
  // Machine-readable backlog — the three entry arrays the Markdown view renders and the
  // GUI's /api/backlog serves (status --json's "print the endpoint's payload" pattern),
  // plus `holds.plans`/`holds.bugs` parallel to the entry arrays so a skipped entry's
  // reason is data, not inference: a pretty-printed JSON document in every exit-0 case,
  // never prose. The payload is read once per branch (snapshot or frame) so the Markdown
  // renderer and the JSON document consume the same arrays.
  // --ready filters both branches through readyBacklog; the Markdown branch adds a count of
  // the held entries it hid. The --json/--ready reads go over `rest` (the --grep value token
  // removed), so a flag-shaped pattern like `--grep --json` greps for "--json" rather than
  // flipping this branch into JSON mode.
  const readBacklog = (): { view: ReturnType<typeof backlogPayload>; hidden: number } => {
    const view = { ...backlogPayload(root), holds: backlogHolds(root), inProgress: backlogInProgress(root) };
    const filtered = pattern === null ? view : grepBacklog(view, pattern);
    if (!ready) return { view: filtered, hidden: 0 };
    const kept = readyBacklog(filtered);
    return { view: kept, hidden: filtered.plans.length + filtered.bugs.length - kept.plans.length - kept.bugs.length };
  };
  const renderBacklogText = (r: { view: ReturnType<typeof backlogPayload>; hidden: number }): string =>
    renderBacklogMarkdown(r.view) + (r.hidden > 0
      ? `\n\n_(${r.hidden} held entries hidden; run \`tumwater backlog\` to see them)_` : "");
  if (follow) {
    await followView(() => renderBacklogText(readBacklog()), seams);
    return;
  }
  const result = readBacklog();
  sayJsonOrRender(rest, result.view, () => renderBacklogText(result));
}

// `tumwater quarantine [--release <n>] [--json]` — the view of the review gate's flake
// quarantine, read-only except the one destructive `--release <n>` mode that removes the Nth
// entry the list prints at the operator's request. The read path keeps its no-gate
// refuseTeamWorkspace stance: loadQuarantine degrades an absent or malformed file to the empty
// list, so the command prints the empty line in any directory and the read never writes
// quarantine.json (a test otherwise leaves the list through releaseQuarantine). --json serves
// the same positioned rows to scripts.
export async function cmdQuarantine(root: string, args: string[]): Promise<void> {
  // `--release <n>` is the read-only command's one destructive mode: route it to its own
  // branch before the read gate, exactly as cmdReviews routes `--accept`.
  if (args.includes("--release")) {
    await cmdQuarantineRelease(root, args);
    return;
  }
  rejectUnknownArgs("quarantine", args, [JSON_FLAG]);
  refuseTeamWorkspace(root);
  const rows = quarantineRows(loadQuarantine(root));
  sayJsonOrRender(args, { tests: rows }, () => renderQuarantine(rows, Date.now()));
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

