/** The `tumwater land` CLI command body (cmdSteer), shaped on cli-revert-command.ts (the
 * commit-on-main action) but landing the operator's OWN commits instead of reverting one. The
 * lock, branch guard, refusals and the fast-forward-or-replay logic live in
 * src/operator/operator-land.ts; this module parses the flags, renders the preview or the
 * landed head, and maps a refusal to exit 1. cli.ts reaches it through the same `await import()`
 * seam every command body keeps behind. */

import { fail, say, sayJson } from "../terminal.js";
import { shortSha } from "../text/format.js";
import { plural } from "../text/phrases.js";
import { previewSteer, steerToMain } from "../operator/operator-land.js";

/** The narrowed ok-payloads, so the renderers can name them without exporting the private union. */
type SteerOutcomeOk = Extract<Awaited<ReturnType<typeof steerToMain>>, { ok: true }>;
type SteerPreviewOk = Extract<Awaited<ReturnType<typeof previewSteer>>, { ok: true }>;

const STEER_USAGE = "usage: tumwater land [<ref>] [--dry-run] [--json]";

/** Scans `args` for `--dry-run` and `--json`, refuses a flag-shaped token as a dropped flag, and
 * returns the flags plus at most one positional (the ref, defaulting to HEAD). */
function parseSteerArgs(args: string[]): { dryRun: boolean; json: boolean; ref: string } {
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--dry-run" && a !== "--json");
  const flagged = rest.find((a) => a.startsWith("-"));
  if (flagged !== undefined)
    fail(`land takes only --dry-run and --json (got ${flagged}); pass the commit or branch to land as the argument`);
  if (rest.length > 1) fail(`land takes at most one ref (${STEER_USAGE})`);
  return { dryRun, json, ref: rest[0] ?? "HEAD" };
}

/** Renders the `--dry-run` preview (the commits, the paths, whether a replay is needed, and
 * whether it would apply) and its exit code. A refusal or a non-applying replay is exit 1. */
function saySteerPreview(p: SteerPreviewOk, json: boolean): void {
  if (json) {
    sayJson({ dryRun: true, commits: p.commits.map(({ sha, subject }) => ({ sha, subject })), paths: p.paths, replay: p.replay, applies: p.applies });
    return;
  }
  say(`would land ${plural(p.commits.length, "commit")} on main (${p.replay ? "main has moved, so it would replay them onto a fresh main" : "a plain fast-forward"}):`);
  for (const { sha, subject } of p.commits) say(`  ${shortSha(sha)} ${subject}`);
  say(`  touches ${plural(p.paths.length, "file")}${p.paths.length > 0 ? `: ${p.paths.join(", ")}` : ""}`);
  say(p.applies ? "applies cleanly; nothing was written" : "would conflict; nothing was written");
  if (!p.applies) process.exitCode = 1;
}

/** Renders the landed outcome (main's new head, the commit count, and where the operator's branch
 * stands) or its `--json` payload. */
function saySteerOutcome(o: SteerOutcomeOk, json: boolean): void {
  if (json) {
    sayJson({ dryRun: false, steered: true, beforeSha: o.beforeSha, headSha: o.headSha, replayed: o.replayed, commits: o.commits.map(({ sha, subject }) => ({ sha, subject })), refNote: o.refNote });
    return;
  }
  say(`main is now ${shortSha(o.headSha)}${o.replayed ? ` (replayed ${plural(o.commits.length, "commit")} onto a moved main)` : ` (fast-forwarded ${plural(o.commits.length, "commit")})`}`);
  say(o.refNote);
}

/** `tumwater land [<ref>] [--dry-run] [--json]`: put the operator's commit(s) on main under the
 * team's merge lock. Default ref is the cwd's worktree HEAD. `--dry-run` reports the commits,
 * their paths, whether a replay is needed and whether it would apply, and writes nothing. */
export async function cmdSteer(root: string, args: string[]): Promise<void> {
  const { dryRun, json, ref } = parseSteerArgs(args);
  if (dryRun) {
    const p = await previewSteer(root, ref);
    if (!p.ok) fail(p.error);
    saySteerPreview(p, json);
    return;
  }
  const result = await steerToMain(root, ref);
  if (!result.ok) fail(result.error);
  saySteerOutcome(result, json);
}
