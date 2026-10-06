import { type BuildInfo, buildStaleness, distDir, isSelfHosted, readBuildInfo } from "./build-info.js";
import { buildCheckEvent } from "./build-check/build-check-events.js";
import { type BuildCheckOutcome } from "./build-check/build-check.js";
import { liveConfig } from "./config/config.js";
import { cachedBaselineVerdict, checkMainBaseline, mainIsGreen } from "./main-baseline.js";
import { compileStaged, swapDist } from "./build-stage.js";
import { readJsonFile, writeJsonFile } from "./json-files.js";
import { finiteNumber } from "./json-object.js";
import { ensureDetachedWorktree } from "./worktree.js";
import { autoRestartStampPath, mirrorWorktreePath, witnessWorktreePath } from "./paths.js";
import { type AutoRestartRecord, type RedeployDeps, RESTART_DRAIN_MAX_MS } from "./redeploy-policy.js";
import { type RedeployEvent, Redeployer } from "./redeployer.js";

/** The self-redeploy WIRING (the state machine itself lives in redeployer.ts): the
 * production RedeployDeps bound to one repo — the mirror worktree both the green check and the
 * compile run in, the baseline check that reads the live config per call, the staged compile,
 * and the dist swap — plus the completed-restart record's small state file and the
 * createRedeployer composition the run boot (cli/cli-run.ts) builds. */

/** The production AutoRestartRecord: one JSON file under .tumwater/state/. A missing or torn
 * file reads as "no completed restart yet" — the same no-data policy as every other state reader. */
export function autoRestartRecord(root: string): AutoRestartRecord {
  const file = autoRestartStampPath(root);
  const stored = readJsonFile<{ at?: unknown }>(file)?.at;
  return {
    lastAt: finiteNumber(stored, null),
    record: (at) => writeJsonFile(file, { at }),
  };
}

/** The redeployer's production effects, bound to one repo: the mirror worktree both the green
 * check and the compile run in, the baseline check that reads the live config per call, the
 * staged compile, and the dist swap. Extracted from createRedeployer so the wiring itself is
 * unit-testable — isSelfHosted pins createRedeployer to the repo the running build was stamped
 * in (a fixture repo never reads as self-hosted), but these closures are plain repo-rooted
 * effects any fixture can drive. */
export function redeployDeps(
  root: string,
  build: BuildInfo,
  log: (event: RedeployEvent) => void,
  bootProblem: () => Promise<string | null>,
): RedeployDeps {
  const dist = distDir();
  // The mirror worktree — main checked out detached at the pending head — serves both the green
  // check and the compile; it is (re)pointed at each head before use.
  const mirror = async (mainHead: string) => ensureDetachedWorktree(root, mirrorWorktreePath(root), mainHead);
  return {
    staleness: (mainHead) => buildStaleness(root, build.sha, mainHead),
    mainGreen: async (mainHead) =>
      // The live config per call (a mid-run edit applies to the next green check like it
      // does everywhere else); a broken file degrades to defaults — no declared check.
      mainIsGreen(
        await mirror(mainHead),
        liveConfig(root),
        ({ outcome, durationMs }) => log(buildCheckEvent("harness", "baseline", outcome, durationMs)),
      ),
    compile: async (mainHead) => compileStaged(root, await mirror(mainHead), mainHead),
    swap: (mainHead) => swapDist(root, dist, mainHead),
    bootProblem,
    // The urgency carve-out's verdict (BUGS.md 2026-09-30): a cached verdict answers free;
    // otherwise the baseline check runs on the running build's own SHA, in a dedicated witness
    // worktree — never the mirror, which the green check and compile serve at main's heads —
    // and lands in the same fleet-shared cache every later consult reads. A fresh red is
    // provisional (BUGS.md 2026-09-30): the gate's flake rule applies here too, so one
    // immediate re-run must confirm it before the carve-out may cut the cooldown on it — a
    // green on the re-run promotes the SHA fleet-wide, and a skipped re-run leaves the verdict
    // unsettled (null), which the policy reads as not-red.
    buildRed: async (buildSha) => {
      const cached = cachedBaselineVerdict(buildSha);
      if (cached !== undefined) return cached === "red";
      const witness = await ensureDetachedWorktree(root, witnessWorktreePath(root), buildSha);
      const onRun = ({ outcome, durationMs }: { outcome: BuildCheckOutcome; durationMs: number }) =>
        log(buildCheckEvent("harness", "baseline", outcome, durationMs));
      const baseline = await checkMainBaseline(witness, liveConfig(root), onRun);
      if (!baseline.baseline || baseline.baseline.status !== "red") {
        return baseline.baseline ? false : null;
      }
      const retry = await checkMainBaseline(witness, liveConfig(root), onRun, true);
      return retry.baseline ? retry.baseline.status === "red" : null;
    },
  };
}

/** The production Redeployer for `root`, or null when the running dist carries no build stamp
 * (compiled with a bare tsc): then provenance is unknown and there is nothing to compare. */
export async function createRedeployer(
  root: string,
  log: (event: RedeployEvent) => void,
  /** The successor's startup gate (RedeployDeps.bootProblem) — cli/cli-run.ts binds
   * runStartupProblem to the invocation's own flags, the ones the supervisor forwards to every
   * generation. */
  bootProblem: () => Promise<string | null>,
): Promise<Redeployer | null> {
  const build = readBuildInfo();
  if (!build) return null;
  const selfHosted = await isSelfHosted(root, build);
  return new Redeployer(
    build,
    selfHosted,
    redeployDeps(root, build, log, bootProblem),
    log,
    RESTART_DRAIN_MAX_MS,
    autoRestartRecord(root),
  );
}
