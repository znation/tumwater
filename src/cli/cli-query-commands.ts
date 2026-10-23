/** The read-only query commands' bodies (status, diff, queue, backlog), split out of
 * cli.ts's dispatcher: main() routes to a cmd* here exactly as it routes to operator-commands's
 * cmdAbort or config-commands's cmdConfig, and cli.ts keeps only routing and the help/version
 * surfaces. Each command owns its argument gate, ready-repo gating decision, and output shape,
 * with the wording and gating order moved verbatim from main()'s cases. */

import { fail, say, sayJson, sayJsonOrRender } from "./cli-output.js";
import { followView, type FollowViewSeams } from "./follow-view.js";
import { flagValue, parseGrepFlag, parseRoleListScope, rejectRepeatFlag } from "./cli-args.js";
import { DIFF_PATH_FLAG, FOLLOW_FLAG, hasFollowFlag, JSON_FLAG, READY_FLAG, grepFlagSpec, rejectUnknownArgs, OVERLAPS_FLAG, ROLE_FLAG, STAT_FLAG } from "./cli-flag-specs.js";
import { refuseTeamWorkspace, requireReadyRepo } from "./cli-repo-gate.js";
import { scopeSnapshotToRoles, snapshot } from "../status/status-data.js";
import { statusPayload } from "../ui/status-payload.js";
import { renderStatus } from "../ui/status-render.js";
import { backlogPayload } from "../backlog/backlog.js";
import { backlogHolds, backlogInProgress } from "../backlog/backlog-eligibility.js";
import { readyBacklog, grepBacklog, renderBacklogMarkdown } from "../backlog/backlog-render.js";
import { collectChangeOverlaps, scopeChangeOverlaps, scopeChangeOverlapsToPath, collectTeamChanges, collectRoleChange, collectRoleChanges, normalizeDiffPath } from "../change/change-data.js";
import { renderChangeOverlaps, renderTeamChange, renderRoleChange, renderRoleChanges } from "../change/change-render.js";
import { readMergeQueue, type MergeQueueView } from "../merge/merge-queue.js";
import { renderMergeQueue, scopeMergeQueue } from "../merge/merge-queue-render.js";
import type { MergeInFlight } from "../merge/merge-slot.js";
import { orchestratorAlive } from "../team/orchestrator-info.js";
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
  if (norm === null) fail("diff --path takes a repo-relative path such as src/cli.ts (as diff --overlaps prints it)");
  return norm;
}

/** `tumwater queue [-f/--follow]`: the durable merge queue in execution order, as text or as
 * the `{entries, unreadable}` document. `-f/--follow` repaints the queue every couple of
 * seconds until Ctrl+C or the process that started it exits, so a backgrounded follow does
 * not outlive its parent (the same rule `status -f` uses). */
export async function cmdQueue(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
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

