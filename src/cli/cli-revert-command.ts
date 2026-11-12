/** The `tumwater revert` CLI command body (cmdRevert), split out of
 * cli-operator-commands.ts (the team-control marker commands) so the two unrelated command
 * families do not share one module: revert is a commit-on-main action under the
 * primary-worktree lock, while the control commands write request markers the orchestrator
 * consumes. The lock, branch guard, and fail-closed ref/conflict handling live in
 * src/operator/operator-revert.ts; this module parses the flags, resolves the target run's
 * sha, and renders the preview or the committed inverse. cli.ts reaches it through the same
 * `await import()` seam every command body keeps behind. */

import { fail, say, sayJson } from "./cli-output.js";
import { parseCountFlag } from "./cli-args.js";
import { shortSha } from "../text/format.js";
import { canonicalRoleId } from "../roles/legacy-role-ids.js";
import { knownRoleIdsCached } from "../config/config.js";
import { unknownRoleMessage } from "../roles/roles.js";
import { readRunRows } from "../history/history-data.js";
import { readRunDetail } from "../history/run-detail-data.js";
import { runNotFoundMessage } from "../history/run-detail.js";
import { previewRevert, revertFollowUp, revertMergedCommit, runRevertSha } from "../operator/operator-revert.js";

const REVERT_USAGE = "usage: tumwater revert <sha>|<role> <n>|<role> --last [--dry-run] [--json]";

/** The narrowed ok-payload of `previewRevert`, so the preview renderer can name it without
 * exporting the private union. */
type RevertPreviewOk = Extract<Awaited<ReturnType<typeof previewRevert>>, { ok: true }>;
/** The narrowed ok-payload of `revertMergedCommit`, so the outcome renderer can name it without
 * exporting the private union. */
type RevertResultOk = Extract<Awaited<ReturnType<typeof revertMergedCommit>>, { ok: true }>;

/** Scans `args` for `--dry-run`, `--last` and `--json`, refuses a flag-shaped token as a
 * dropped flag and checks the positional arity, returning the flags and the remaining
 * positionals. */
function parseRevertArgs(args: string[]): { dryRun: boolean; last: boolean; json: boolean; rest: string[] } {
  // `--dry-run` and `--last` are the only flags; the positionals select a sha (one), a run
  // (`<role> <n>`) or the newest run of a role (`<role>` with --last). A flag or any other
  // shape fails before anything is looked up or written.
  const dryRun = args.includes("--dry-run");
  const last = args.includes("--last");
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--dry-run" && a !== "--last" && a !== "--json");
  // A flag-shaped token is a dropped flag, not a commit: refuse it before rev-parse turns a
  // lone `--json` into the misleading "no such commit". Mirrors `config set`'s
  // flag-looking-value gate and gui-command.ts's --token gate, and a real sha never starts
  // with `-`.
  const flagged = rest.find((a) => a.startsWith("-"));
  if (flagged !== undefined)
    fail(`revert takes only --dry-run, --last and --json (got ${flagged}); pass the commit or run to undo as the argument`);
  if (last ? rest.length !== 1 : rest.length < 1 || rest.length > 2)
    fail(`revert needs a commit or a run (${REVERT_USAGE})`);
  return { dryRun, last, json, rest };
}

/** Resolves the target sha, its run line and its run ref (`revertRunSha` for `<role> <n>` and
 * `<role> --last`, else the sha positional directly). */
function revertTarget(
  root: string,
  rest: string[],
  last: boolean,
): { sha: string; runLine: string | null; runRef: { role: string; run: number } | null } {
  const run = last || rest.length === 2 ? revertRunSha(root, rest, last) : null;
  const sha = run?.sha ?? rest[0]!;
  const runLine = run?.line ?? null;
  const runRef = run === null ? null : { role: run.role, run: run.run };
  return { sha, runLine, runRef };
}

/** Renders the `--dry-run` preview (the run line, `would revert …`, the path list,
 * `applies cleanly`/`would conflict`/the dirty-checkout line) and its exit code. */
function sayRevertPreview(
  p: RevertPreviewOk,
  runLine: string | null,
  runRef: { role: string; run: number } | null,
  json: boolean,
): void {
  if (json) {
    sayJson({ dryRun: true, run: runRef, sha: p.sha, subject: p.subject, paths: p.paths, head: p.head, primary: p.primary, applies: p.applies, dirty: p.dirty });
  } else {
    if (runLine !== null) say(runLine);
    say(`would revert ${shortSha(p.sha)} ${p.subject}`);
    for (const path of p.paths) say(`  ${path}`);
    const on = `on ${p.primary} (HEAD ${shortSha(p.head)}); nothing was written`;
    if (p.applies && !p.dirty) say(`applies cleanly ${on}`);
    if (!p.applies) say(`would conflict ${on}`);
    if (p.dirty)
      say("the checkout has staged or unstaged changes, so tumwater revert would refuse until they are committed or stashed; nothing was written");
  }
  if (!p.applies || p.dirty) process.exitCode = 1;
}

/** Renders the committed revert (`main is now …`, the role follow-up) or its `--json` payload. */
function sayRevertOutcome(
  result: RevertResultOk,
  runLine: string | null,
  runRef: { role: string; run: number } | null,
  json: boolean,
): void {
  if (json) {
    sayJson({ dryRun: false, run: runRef, subject: result.subject, headSha: result.headSha, beforeSha: result.beforeSha, followUp: revertFollowUp(result.subject) });
    return;
  }
  if (runLine !== null) say(runLine);
  say(`main is now ${shortSha(result.headSha)}`);
  const followUp = revertFollowUp(result.subject);
  if (followUp !== null) say(followUp);
}

/** The sha the run `<role> <n>` (or the newest completed run of `<role>` under `last`) merged
 * under, resolved the way `tumwater history <role> <n>` and the dashboard's revert resolve it
 * (`runMergedSha`). Fails, exit 1, when the run is unknown or did not merge: revert is an
 * action, so a miss is an error rather than history's exit-0 "not found". */
function revertRunSha(root: string, positionals: string[], last: boolean): { sha: string; line: string; role: string; run: number } {
  const role = canonicalRoleId(positionals[0]!);
  const ids = knownRoleIdsCached(root);
  if (!ids.includes(role)) fail(`${unknownRoleMessage(role, ids)} (${REVERT_USAGE})`);
  const run = last
    ? (readRunRows(root, 1, role)[0]?.run ?? null)
    : parseCountFlag("revert <n>", positionals[1]);
  if (run === null) fail(`no completed run of ${role} in the event log`);
  const detail = readRunDetail(root, role, run);
  if (detail === null) fail(runNotFoundMessage(role, run));
  const found = runRevertSha(role, run, detail);
  if (!found.ok) fail(found.error);
  const sha = found.sha;
  return { sha, line: `run ${role} #${run} merged as ${shortSha(sha)}`, role, run };
}

/** `tumwater revert <sha>|<role> <n>|<role> --last`: undo one merged change on main,
 * committing the inverse as `tumwater(operator): Revert <short sha>` under the primary-worktree
 * lock. The lock, branch guard, and fail-closed ref/conflict handling live in
 * src/operator/operator-revert.ts; this renderer names the new main head and names the role
 * that made the reverted commit, when one did, as the one that may redo the work.
 * `--json` prints the preview or the revert as one JSON object instead (refusals still fail on
 * stderr). */
export async function cmdRevert(root: string, args: string[]): Promise<void> {
  const { dryRun, last, json, rest } = parseRevertArgs(args);
  const { sha, runLine, runRef } = revertTarget(root, rest, last);
  if (dryRun) {
    const p = await previewRevert(root, sha);
    if (!p.ok) fail(p.error);
    sayRevertPreview(p, runLine, runRef, json);
    return;
  }
  const result = await revertMergedCommit(root, sha);
  if (!result.ok) fail(result.error);
  sayRevertOutcome(result, runLine, runRef, json);
}
