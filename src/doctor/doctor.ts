import { loadConfigSafe } from "../config/config.js";
import { envPath } from "../files/files.js";
import { orchestratorAlive, readOrchestratorInfo } from "../team/orchestrator-info.js";
import { type ProcessProbe, systemProcessProbe } from "../process/process-table.js";
import { checkOrphans } from "./doctor-orphans.js";
import { checkBudget, checkClaudeWindow, checkErrorStreaks, checkMainRed, checkMaintenanceQuota, checkPause, checkProviderHolds, checkQuietHours } from "./doctor-holds.js";
import { checkRootInstall } from "./doctor-install.js";
import { checkNotify } from "./doctor-notify.js";
import { checkLaunchServicesPorts } from "./doctor-launch-services.js";
import { plural } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import { failOutcome, type CheckOutcome } from "./outcome.js";
import { errorMessage } from "../text/text.js";
import type { DoctorCheckName } from "./doctor-check-names.js";
import {
  checkBackendBinary,
  checkBrief,
  checkBootstrap,
  checkBuild,
  checkBuildCheck,
  checkClaudeTranscripts,
  checkFunes,
  checkGitBinary,
  checkConfigKeyNames,
  checkInit,
  checkDiskSpace,
  checkEventLog,
  checkFlakyChecks,
  checkOpencodeVersion,
  checkMergeLock,
  checkNodeVersion,
  checkPiExtensions,
  checkProviderConcurrency,
  checkCheckContention,
  checkProviderContention,
  checkRepo,
  checkStateDir,
  checkWorktreePool,
  checkLeftoverRoleBranches,
  checkTumwaterPins,
  checkWorkInstances,
  type DoctorReport,
} from "./doctor-checks.js";
import { checkClaudeAuth, checkClaudeVersion, checkAnthroApiKey, checkFallbackChain, checkFallbackModel, checkImageInput, checkOpencode, checkTierModels } from "./doctor-model-checks.js";
import { backendQualifiedSelector } from "../config/config-views.js";
import { seamsInUse } from "../config/config-fallbacks.js";
import { checkBacklogHeadings, checkFixClaims, checkLiveFinished, checkPlanDependencies, checkRefusedEntries, checkRegressedFixes, checkStaleQueuedMerges, checkStaleBugs, checkStalePrompts, checkStaleQuestions, checkStalledPlans, checkStrandedPlans, checkUncommittedBacklog, checkValidationGaps, checkWaitingBugs } from "./doctor-backlog.js";

/** Pre-flight environment check (`tumwater doctor`). The harness's preconditions are
 * scattered across fail-fast checks that each command re-runs on its own (requireReadyRepo in
 * cli.ts walks git-binary → repo → tumwater.json → commits and stops at the first failure;
 * cmdStart adds pi-on-PATH and orchestrator-alive), so a user facing a partially initialized or
 * drifted environment gets one error at a time. doctor runs every check, reports each result
 * individually instead of stopping at the first failure, and exits 0/1 so it can be scripted —
 * the pre-flight sibling of `status --json`, which queries live team state while doctor
 * verdicts on the environment. Every check is read-only against .tumwater/ (works with or
 * without a running harness) and none runs the project's build/test: that can take minutes and
 * belongs in the review gate / red-main check, not a pre-flight. The individual checks live in
 * doctor-checks.ts and doctor-model-checks.ts; this module composes them into the report. */

/** Run one doctor check, turning a throw or rejection into a fail row: a check that crashed
 * verified nothing, so it must not read as a pass or abort the report. */
export async function runDoctorCheck(run: () => CheckOutcome | null | Promise<CheckOutcome | null>): Promise<CheckOutcome | null> {
  try {
    return await run();
  } catch (err) {
    return failOutcome(`the check threw: ${errorMessage(err)}`);
  }
}

/** Run every check in order and compose the report. Read-only against .tumwater/ by
 * construction — no check removes or repairs anything (the state-dir probe writes a temp file
 * and deletes it again; the orphan check reports processes, never signals them) — so doctor
 * works identically with or without a running harness. `probe` feeds the orphan and port
 * checks, so tests can pin the report without reading the host's process table. `only` runs
 * just the named checks, in report order; a skipped check is never evaluated, and a named
 * conditional check that returns null leaves no row. A check that throws becomes its own fail
 * row, and every other check still runs. */
export async function runDoctor(
  root: string,
  pathEnv: string = envPath(),
  probe: ProcessProbe = systemProcessProbe,
  probeImages: "missing" | "all" | "never" = "never",
  only?: readonly DoctorCheckName[],
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
        selector: s.model !== undefined ? backendQualifiedSelector({ ...s, model: s.model }) : "no model declared",
        backend: s.agent ?? "pi",
      }))
    : [];
  const info = readOrchestratorInfo(root);
  const header =
    orchestratorAlive(root, info) && info
      ? `tumwater doctor — running (pid ${info.pid}${info.build ? `, version ${shortSha(info.build.sha)}${info.build.stale ? " — update available" : ""}${info.build.restartBlocked ? " (restart blocked)" : ""}` : ""})`
      : "tumwater doctor — not running";
  const steps: Array<{
    name: DoctorCheckName;
    run: () => CheckOutcome | null | Promise<CheckOutcome | null>;
  }> = [
    { name: "node", run: () => checkNodeVersion() },
    { name: "git binary", run: () => checkGitBinary(pathEnv) },
    { name: "repo", run: () => checkRepo(root, config) },
    { name: "init", run: () => checkInit(root) },
    { name: "config key names", run: () => checkConfigKeyNames(root) },
    { name: "brief", run: () => checkBrief(root) },
    // New-project bootstrap (plans/work-ratio.md, part 2/2): an active hold reports as ok
    // information, never a warning — a young project is not misconfigured.
    { name: "bootstrap", run: () => checkBootstrap(root, config) },
    { name: "pause", run: () => checkPause(root) },
    { name: "quiet hours", run: () => checkQuietHours(config) },
    { name: "budget", run: () => checkBudget(root, config, (orchestratorAlive(root, info) && info?.budget) || null) },
    { name: "claude window", run: () => checkClaudeWindow(root, undefined, (orchestratorAlive(root, info) && info?.chain) || undefined, config) },
    { name: "provider waits", run: () => checkProviderHolds(root) },
    { name: "maintenance allowance", run: () => checkMaintenanceQuota(root, config, orchestratorAlive(root, info)) },
    { name: "provider concurrency", run: () => checkProviderConcurrency(config, root) },
    { name: "provider contention", run: () => checkProviderContention(root, config) },
    { name: "check contention", run: () => checkCheckContention(root, config) },
    { name: "repeated failures", run: () => checkErrorStreaks(root, config) },
    { name: "main's check", run: () => checkMainRed(root, config) },
    { name: "over-cap model", run: () => checkFallbackModel(root, undefined, (orchestratorAlive(root, info) && info?.fallbackDemoted) || null) },
    { name: "fallback chain", run: () => checkFallbackChain(root) },
    { name: "models for each tier", run: () => checkTierModels(root) },
    { name: "image input", run: () => checkImageInput(root, undefined, undefined, undefined, probeImages, pathEnv) },
    { name: "claude auth", run: () => checkClaudeAuth(root, pathEnv) },
    { name: "claude api key", run: () => checkAnthroApiKey(root, undefined, pathEnv) },
    { name: "claude version", run: () => checkClaudeVersion(root, pathEnv) },
    { name: "opencode version", run: () => checkOpencodeVersion(root, pathEnv) },
    { name: "opencode", run: () => checkOpencode(root, pathEnv) },
    { name: "backend binary", run: () => checkBackendBinary(root, pathEnv) },
    // The transcript total is informational and only read when a seam routes to claude.
    { name: "claude transcripts", run: () => checkClaudeTranscripts(config) },
    // The receive-side guards name what a running team skips, so an operator tool meant for the
    // team (a pi package, an extension file, an mcp.json server, or funes) does not vanish
    // silently. Each check returns null to omit its row: the pi row for a team with no pi seam,
    // the funes row when funes is not on PATH.
    { name: "pi extensions", run: () => checkPiExtensions(config, undefined, pathEnv) },
    { name: "funes", run: () => checkFunes(config, pathEnv) },
    { name: "state dir", run: () => checkStateDir(root) },
    { name: "event log", run: () => checkEventLog(root) },
    { name: "notify", run: () => checkNotify(root, config) },
    { name: "merge lock", run: () => checkMergeLock(root) },
    { name: "workspaces", run: () => checkWorktreePool(root) },
    { name: "parallel instances", run: () => checkWorkInstances(root, config) },
    { name: "leftover role branches", run: () => checkLeftoverRoleBranches(root, config) },
    { name: "tumwater pins", run: () => checkTumwaterPins(root) },
    // The disk floor (plans/disk-floor.md, part 1/4): a broken config stays undefined (checkInit
    // reports it), so the check falls back to the 10 GB default rather than skipping itself.
    { name: "disk space", run: () => checkDiskSpace(root, config?.diskHoldGB ?? 10, config?.diskReclaimGB ?? 40) },
    { name: "check", run: () => checkBuildCheck(root, config) },
    { name: "root install", run: () => checkRootInstall(root) },
    // The review gate's flake memory, surfaced read-only: naming which checks the gate kept
    // excusing as flakes (ok/warn only, so a flaky suite never fails a scripted pre-flight).
    { name: "flaky checks", run: () => checkFlakyChecks(root) },
    { name: "claimed bugs", run: () => checkFixClaims(root) },
    { name: "validation gaps", run: () => checkValidationGaps(root) },
    { name: "plans stuck in Planned", run: () => checkStrandedPlans(root) },
    { name: "backlog headings", run: () => checkBacklogHeadings(root) },
    { name: "backlog archive", run: () => checkLiveFinished(root) },
    { name: "refusals", run: () => checkRefusedEntries(root) },
    { name: "stalled plans", run: () => checkStalledPlans(root) },
    { name: "plan dependencies", run: () => checkPlanDependencies(root) },
    { name: "stale questions", run: () => checkStaleQuestions(root) },
    { name: "stale bugs", run: () => checkStaleBugs(root) },
    { name: "waiting bugs", run: () => checkWaitingBugs(root) },
    { name: "regressed fixes", run: () => checkRegressedFixes(root) },
    { name: "stale merge-queue entries", run: () => checkStaleQueuedMerges(root, Date.now()) },
    { name: "stale prompts", run: () => checkStalePrompts(root, Date.now()) },
    { name: "uncommitted backlog", run: () => checkUncommittedBacklog(root, config) },
    // The running team's own view of its build (staleness and what auto-restart made of it)
    // when there is one; without it the check still stands on its own git comparison.
    { name: "update", run: () => checkBuild(root, undefined, undefined, (orchestratorAlive(root, info) && info?.build) || null) },
    { name: "orphans", run: () => checkOrphans(root, probe) },
    { name: "macOS port leak", run: () => checkLaunchServicesPorts(probe) },
  ];
  const checks: DoctorReport["checks"] = [];
  for (const step of steps) {
    if (only && !only.includes(step.name)) continue;
    const outcome = await runDoctorCheck(step.run);
    if (outcome !== null) checks.push({ name: step.name, ...outcome });
  }
  const problems = checks.filter((c) => c.level === "fail").length;
  return { header, checks, routing, verdict: problems === 0 ? "ready to run" : plural(problems, "problem") };
}
