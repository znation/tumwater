// vocabulary: plain
import { loadConfigSafe } from "../config/config.js";
import { envPath } from "../files/files.js";
import { orchestratorAlive, readOrchestratorInfo } from "../team/orchestrator-info.js";
import { type ProcessProbe, systemProcessProbe } from "../process/process-table.js";
import { checkOrphans } from "./doctor-orphans.js";
import { checkBudget, checkClaudeWindow, checkErrorStreaks, checkMainRed, checkMaintenanceQuota, checkPause, checkProviderHolds, checkQuietHours } from "./doctor-holds.js";
import { checkNotify } from "./doctor-notify.js";
import { checkLaunchServicesPorts } from "./doctor-launch-services.js";
import { plural } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import {
  checkAgentBinary,
  checkBrief,
  checkBootstrap,
  checkBuild,
  checkBuildCheck,
  checkClaudeTranscripts,
  checkGitBinary,
  checkConfigKeyNames,
  checkInit,
  checkDiskSpace,
  checkEventLog,
  checkFlakyChecks,
  checkMergeLock,
  checkNodeVersion,
  checkProviderConcurrency,
  checkRepo,
  checkStateDir,
  checkWorktreePool,
  checkLeftoverRoleBranches,
  checkWorkInstances,
  type DoctorReport,
} from "./doctor-checks.js";
import { checkClaudeAuth, checkClaudeVersion, checkAnthroApiKey, checkFallbackChain, checkFallbackModel, checkImageInput, checkTierModels } from "./doctor-model-checks.js";
import { agentQualifiedSelector } from "../config/config-views.js";
import { seamsInUse } from "../config/config-fallbacks.js";
import { checkBacklogHeadings, checkFixClaims, checkPlanDependencies, checkRefusedEntries, checkStaleQueuedLandings, checkStaleBugs, checkStaleQuestions, checkStalledPlans, checkStrandedPlans, checkUncommittedBacklog } from "./doctor-backlog.js";

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
 * doctor-checks.ts and doctor-model-checks.ts; this module composes them into the report. */

/** Run every check in order and compose the report. Read-only against .tumwater/ by
 * construction — no check removes or repairs anything (the state-dir probe writes a temp file
 * and deletes it again; the orphan check reports processes, never signals them) — so doctor
 * works identically with or without a running harness. `probe` feeds the orphan and port
 * checks, so tests can pin the report without reading the host's process table. */
export async function runDoctor(
  root: string,
  pathEnv: string = envPath(),
  probe: ProcessProbe = systemProcessProbe,
  probeImages: "missing" | "all" | "never" = "never",
): Promise<DoctorReport> {
  // Loaded once for the checks that read config (repo's baseBranch); a broken file stays
  // undefined — checkInit reports it verbatim — so doctor still runs every other check.
  const { config } = loadConfigSafe(root);
  // The routing table: every seam the config can spawn, with the selector each one runs on and
  // the backend it routes to — read from the same one list the checks sweep, so an operator
  // sees (and the checks cover) a claude fallback exactly like a primary seam. A broken config
  // keeps it empty (the init check reports that separately).
  const routing: DoctorReport["routing"] = config
    ? seamsInUse(config).map((s) => ({
        label: s.label,
        selector: s.model !== undefined ? agentQualifiedSelector({ ...s, model: s.model }) : "no model declared",
        backend: s.agent ?? "pi",
      }))
    : [];
  const info = readOrchestratorInfo(root);
  const header =
    orchestratorAlive(root, info) && info
      ? `tumwater doctor — running (pid ${info.pid}${info.build ? `, version ${shortSha(info.build.sha)}${info.build.stale ? " — update available" : ""}${info.build.restartBlocked ? " (restart blocked)" : ""}` : ""})`
      : "tumwater doctor — not running";
  const checks: DoctorReport["checks"] = [
    { name: "node", ...checkNodeVersion() },
    { name: "git binary", ...checkGitBinary(pathEnv) },
    { name: "repo", ...(await checkRepo(root, config)) },
    { name: "init", ...checkInit(root) },
    { name: "config key names", ...checkConfigKeyNames(root) },
    { name: "brief", ...checkBrief(root) },
    // New-project bootstrap (plans/work-ratio.md, part 2/2): an active hold reports as ok
    // information, never a warning — a young project is not misconfigured.
    { name: "bootstrap", ...checkBootstrap(root, config) },
    { name: "pause", ...checkPause(root) },
    { name: "quiet hours", ...checkQuietHours(config) },
    { name: "budget", ...checkBudget(root, config, (orchestratorAlive(root, info) && info?.budget) || null) },
    { name: "claude window", ...checkClaudeWindow(root, undefined, (orchestratorAlive(root, info) && info?.chain) || undefined, config) },
    { name: "provider waits", ...checkProviderHolds(root) },
    { name: "maintenance allowance", ...checkMaintenanceQuota(root, config, orchestratorAlive(root, info)) },
    { name: "provider concurrency", ...checkProviderConcurrency(config, root) },
    { name: "repeated failures", ...checkErrorStreaks(root, config) },
    { name: "main's check", ...checkMainRed(root, config) },
    { name: "over-cap model", ...checkFallbackModel(root, undefined, (orchestratorAlive(root, info) && info?.fallbackDemoted) || null) },
    { name: "fallback chain", ...(await checkFallbackChain(root)) },
    { name: "models for each tier", ...(await checkTierModels(root)) },
    { name: "image input", ...(await checkImageInput(root, undefined, undefined, undefined, probeImages, pathEnv)) },
    { name: "claude auth", ...(await checkClaudeAuth(root, pathEnv)) },
    { name: "claude api key", ...(await checkAnthroApiKey(root, undefined, pathEnv)) },
    { name: "claude version", ...(await checkClaudeVersion(root, pathEnv)) },
    { name: "backend binary", ...checkAgentBinary(root, pathEnv) },
    // The transcript total is informational and only read when a seam routes to claude.
    { name: "claude transcripts", ...checkClaudeTranscripts(config) },
    { name: "state dir", ...checkStateDir(root) },
    { name: "event log", ...checkEventLog(root) },
    { name: "notify", ...checkNotify(root, config) },
    { name: "merge lock", ...checkMergeLock(root) },
    { name: "workspaces", ...checkWorktreePool(root) },
    { name: "parallel instances", ...checkWorkInstances(root, config) },
    { name: "leftover role branches", ...(await checkLeftoverRoleBranches(root, config)) },
    // The disk floor (plans/disk-floor.md, part 1/4): a broken config stays undefined (checkInit
    // reports it), so the check falls back to the 10 GB default rather than skipping itself.
    { name: "disk space", ...checkDiskSpace(root, config?.diskHoldGB ?? 10, config?.diskReclaimGB ?? 40) },
    { name: "check", ...checkBuildCheck(root, config) },
    // The review gate's flake memory, surfaced read-only: naming which checks the gate kept
    // excusing as flakes (ok/warn only, so a flaky suite never fails a scripted pre-flight).
    { name: "flaky checks", ...checkFlakyChecks(root) },
    { name: "claimed bugs", ...checkFixClaims(root) },
    { name: "plans stuck in Planned", ...checkStrandedPlans(root) },
    { name: "backlog headings", ...checkBacklogHeadings(root) },
    { name: "refusals", ...checkRefusedEntries(root) },
    { name: "stalled plans", ...checkStalledPlans(root) },
    { name: "plan dependencies", ...checkPlanDependencies(root) },
    { name: "stale questions", ...checkStaleQuestions(root) },
    { name: "stale bugs", ...checkStaleBugs(root) },
    { name: "stale merge-queue entries", ...checkStaleQueuedLandings(root, Date.now()) },
    { name: "uncommitted backlog", ...(await checkUncommittedBacklog(root, config)) },
    // The running fleet's own view of its build (staleness and what auto-restart made of it)
    // when there is one; without it the check still stands on its own git comparison.
    { name: "update", ...(await checkBuild(root, undefined, undefined, (orchestratorAlive(root, info) && info?.build) || null)) },
    { name: "orphans", ...(await checkOrphans(root, probe)) },
    { name: "macOS port leak", ...(await checkLaunchServicesPorts(probe)) },
  ];
  const problems = checks.filter((c) => c.level === "fail").length;
  return { header, checks, routing, verdict: problems === 0 ? "ready to run" : plural(problems, "problem") };
}
