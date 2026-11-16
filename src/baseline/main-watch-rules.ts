import { withMainTipWorktree } from "./main-red.js";
import { detectBuildCheck } from "../build/build-check-detect.js";
import { git, gitTry } from "../git/git-run.js";
import { gitLines } from "../git/git.js";
import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { shortSha } from "../text/format.js";
import { treeDiffFiles } from "../git/git-diff.js";
import { mergingRoleOf } from "../events/event-read.js";
import { isExemptDiff } from "../review/exemptions.js";
import { diffRuleReasons } from "../review/diff-rules.js";
import { headOf, markWatched, warnCouldNotCheck, type MainWatchState } from "./main-watch-state.js";

/** Concern B: the per-head diff-rules pass. The deterministic diff rules run in the shared
 * `_gate-main` mirror on every new head, covering every commit since the last watched head.
 * The full check no longer runs here — its own pass (fullPass) owns it in `_main-full` — so a
 * slow full run never holds this mirror behind the gate's main-tip verdicts. */

/** The per-head pass (Hourly full check, part 2c/4): the deterministic diff rules run in the
 * shared `_gate-main` mirror on every new head, covering every commit since the last watched
 * head. The full check no longer runs here — its own pass (fullPass) owns it in `_main-full` —
 * so a slow full run never holds this mirror behind the gate's main-tip verdicts. `previous`
 * is the newest head the rules pass has already been started for (lastRulesWatched), so a head
 * whose pass was busy when it arrived is still judged once rather than dropped. */
export async function rulesPass(
  root: string,
  mainBranch: string,
  state: MainWatchState,
  mainHead: string,
  previous: string | undefined,
  config: TumwaterConfig,
): Promise<void> {
  const hasBuildCheck = detectBuildCheck(root, config);
  if (!hasBuildCheck) {
    // No declared build check: nothing to watch for a build red, but the diff rules still run on
    // the tip, and the head counts as watched (the full-check pass never runs here, so it owns
    // no lastWatched either). No suspended full check can be due without a build check.
    markWatched(state, mainHead);
  }
  // The deterministic diff rules ("Every commit is verified on main, part 1/3"): run the full
  // six-check set the watch and gate share — the gate now runs only the three a later commit
  // cannot repair — against main's new tip. A rule failure is a deterministic red — it takes no
  // confirming re-run and never quarantines — reported as a warning naming the rule and the
  // head (and each committing role, when a recent merged event names one). It runs on every tip
  // the watch covers in a poll — a build green, a build red, and a head with no verdict (a
  // skipped or sleep-spanned check) or no declared build check at all — because a tip counts as
  // watched (lastWatched) either way, so this is the one chance to judge its diff before the
  // next head moves. The full check no longer runs here — its own pass (fullPass) owns it in
  // `_main-full` — so a slow full run never holds this mirror behind the gate's main-tip
  // verdicts (Hourly full check, part 2c/4).
  let judgedThrough: string | undefined;
  await withMainTipWorktree(root, mainBranch, async (wt) => {
    const tip = await headOf(wt);
    judgedThrough = tip;
    // Judge each first-parent commit in the range by its own diff and its own merged-event role,
    // not the tip's: a multi-commit range's union diff attributed to whichever role merged the
    // tip would report a legitimate director/steward PRINCIPLES.md edit in an intermediate commit
    // as unauthorized by the role that merged later. previous is undefined only before the first
    // watched head, when the range is the tip's own commit.
    //
    // The diff rules read the change's "head" side from the worktree (conflict markers,
    // brief/protected-file content, secrets, backlog structure) against a base revision, so the
    // mirror checkout must sit ON the commit being judged — not on the tip — or an intermediate
    // commit would be compared against the tip's content of its touched files rather than its
    // own. The range is walked oldest-first and ends back on the tip.
    const commits =
      previous === undefined
        ? [tip]
        : gitLines(await gitTry(wt, "rev-list", "--first-parent", "--reverse", `${previous}..${tip}`));
    for (const commit of commits) {
      await git(wt, "checkout", "-q", "--detach", "--force", commit);
      const parent = `${commit}^`;
      const files = (await treeDiffFiles(wt, parent, commit)) ?? [];
      const [ruleReason] = await diffRuleReasons(
        wt,
        parent,
        files,
        mergingRoleOf(root, commit) ?? "",
        isExemptDiff(files, config.review.exemptPaths),
        "watch",
      );
      judgedThrough = commit;
      if (ruleReason !== undefined) {
        warnEventBestEffort(
          root,
          TUMWATER_SOURCE,
          `main's tip ${shortSha(tip)} fails the diff rules: ${ruleReason}`,
        );
        // A finding stops the walk mid-range; put the mirror back on the tip. The first finding
        // across the range is reported once, like the gate's short-circuit.
        await git(wt, "checkout", "-q", "--detach", "--force", tip);
        return;
      }
    }
  });
  // The mirror can be re-pointed at a newer tip while this pass waited for the shared gate
  // mirror: mark the newest commit actually judged, or the next poll re-judges the commits this
  // pass already covered (the poll's optimistic lastRulesWatched was only the head it saw). A
  // finding stops the walk before later commits, so it marks the finding's own commit and a
  // newer head it never finished is still retried from the next commit.
  if (judgedThrough !== undefined) {
    state.lastRulesWatched = judgedThrough;
    if (!hasBuildCheck) state.lastWatched = judgedThrough;
  }
}

/** Start the per-head diff-rules pass behind its own in-flight guard: a rules pass that was
 * busy when a head arrived must still judge that head. */
export function startRulesPass(
  root: string,
  mainBranch: string,
  state: MainWatchState,
  mainHead: string,
  config: TumwaterConfig,
  rulesCovered: boolean,
): void {
  if (!state.rulesInFlight && !rulesCovered) {
    const previous = state.lastRulesWatched;
    state.lastRulesWatched = mainHead;
    state.rulesInFlight = rulesPass(root, mainBranch, state, mainHead, previous, config)
      .catch((err: unknown) => {
        // A failed rules pass (main unreadable, checkout refused) is not retried until main
        // moves, so a persistent failure warns once per head.
        warnCouldNotCheck(root, state, mainHead, err);
      })
      .finally(() => {
        state.rulesInFlight = null;
      });
  }
}
