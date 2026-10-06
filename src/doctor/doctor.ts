import { loadConfigSafe } from "../config/config.js";
import { orchestratorAlive, readOrchestratorInfo } from "../fleet/fleet-state.js";
import { type ProcessProbe, systemProcessProbe } from "../process/process-table.js";
import { checkOrphans } from "./doctor-orphans.js";
import { checkLaunchServicesPorts } from "../launch-services.js";
import { plural } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import {
  checkAgentBinary,
  checkBrief,
  checkBuild,
  checkBuildCheck,
  checkFallbackModel,
  checkGitBinary,
  checkInit,
  checkMergeLock,
  checkNodeVersion,
  checkRepo,
  checkStateDir,
  type DoctorReport,
} from "./doctor-checks.js";
import { checkBacklogHeadings, checkFixClaims, checkStrandedPlans } from "./doctor-backlog.js";

/** Pre-flight environment check (`tumwater doctor`). The harness's preconditions are
 * scattered across fail-fast checks that each command re-runs on its own (requireReadyRepo in
 * cli.ts walks git-binary → repo → tumwater.json → commits and stops at the first failure;
 * cmdRun adds pi-on-PATH and orchestrator-alive), so a user facing a partially initialized or
 * drifted environment gets one error at a time. doctor runs every check, reports each result
 * individually instead of stopping at the first failure, and exits 0/1 so it can be scripted —
 * the pre-flight sibling of `status --json`, which queries live fleet state while doctor
 * verdicts on the environment. Every check is read-only against .tumwater/ (works with or
 * without a running harness) and none runs the project's build/test: that can take minutes and
 * belongs in the review gate / red-main check, not a pre-flight. The individual checks live in
 * doctor-checks.ts; this module composes them into the report. */

/** Run every check in order and compose the report. Read-only against .tumwater/ by
 * construction — no check removes or repairs anything (the state-dir probe writes a temp file
 * and deletes it again; the orphan check reports processes, never signals them) — so doctor
 * works identically with or without a running harness. `probe` feeds the orphan and port
 * checks, so tests can pin the report without reading the host's process table. */
export async function runDoctor(
  root: string,
  pathEnv: string = process.env.PATH ?? "",
  probe: ProcessProbe = systemProcessProbe,
): Promise<DoctorReport> {
  // Loaded once for the checks that read config (repo's baseBranch); a broken file stays
  // undefined — checkInit reports it verbatim — so doctor still runs every other check.
  const { config } = loadConfigSafe(root);
  const info = readOrchestratorInfo(root);
  const header =
    orchestratorAlive(root, info) && info
      ? `tumwater doctor — harness running (pid ${info.pid}${info.build ? `, build ${shortSha(info.build.sha)}${info.build.stale ? " — STALE" : ""}${info.build.restartBlocked ? " (restart blocked)" : ""}` : ""})`
      : "tumwater doctor — harness not running";
  const checks: DoctorReport["checks"] = [
    { name: "node", ...checkNodeVersion() },
    { name: "git binary", ...checkGitBinary(pathEnv) },
    { name: "repo", ...(await checkRepo(root, config)) },
    { name: "init", ...checkInit(root) },
    { name: "brief", ...checkBrief(root) },
    { name: "fallback", ...checkFallbackModel(root, undefined, (orchestratorAlive(root, info) && info?.fallbackDemoted) || null) },
    { name: "pi binary", ...checkAgentBinary(root, pathEnv) },
    { name: "state dir", ...checkStateDir(root) },
    { name: "merge lock", ...checkMergeLock(root) },
    { name: "project check", ...checkBuildCheck(root, config) },
    { name: "fix claims", ...checkFixClaims(root) },
    { name: "stranded plans", ...checkStrandedPlans(root) },
    { name: "backlog headings", ...checkBacklogHeadings(root) },
    // The running fleet's own view of its build (staleness and what auto-restart made of it)
    // when there is one; without it the check still stands on its own git comparison.
    { name: "build", ...(await checkBuild(root, undefined, undefined, (orchestratorAlive(root, info) && info?.build) || null)) },
    { name: "orphans", ...(await checkOrphans(root, probe)) },
    { name: "mach ports", ...(await checkLaunchServicesPorts(probe)) },
  ];
  const problems = checks.filter((c) => c.level === "fail").length;
  return { header, checks, verdict: problems === 0 ? "ready to run" : plural(problems, "problem") };
}
