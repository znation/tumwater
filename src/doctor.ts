import fs from "node:fs";
import path from "node:path";
import { enabledRoleIds, loadConfig } from "./config.js";
import { detectBuildCheck } from "./build-check.js";
import { type BuildInfo, type BuildStatus, buildStaleness, isSelfHosted, readBuildInfo } from "./build-info.js";
import { STALE_INPUTS_LABEL } from "./redeploy.js";
import { findOnPath } from "./files.js";
import { GIT_MISSING_MESSAGE, currentBranch, gitTry, hasCommits, isGitRepo } from "./git.js";
import { classifyLock, readLockPid } from "./lock.js";
import { STATE_DIR, configPath, mergeLockDir } from "./paths.js";
import { orchestratorAlive, readOrchestratorInfo } from "./state.js";
import { errorMessage } from "./text.js";

/** Pre-flight environment check (`tumwater doctor`). The harness's preconditions are
 * scattered across fail-fast checks that each command re-runs on its own (requireReadyRepo in
 * cli.ts walks git-binary → repo → tumwater.json → commits and stops at the first failure;
 * cmdRun adds pi-on-PATH and orchestrator-alive), so a user facing a partially initialized or
 * drifted environment gets one error at a time. doctor runs every check, reports each result
 * individually instead of stopping at the first failure, and exits 0/1 so it can be scripted —
 * the pre-flight sibling of `status --json`, which queries live fleet state while doctor
 * verdicts on the environment. Every check is read-only against .tumwater/ (works with or
 * without a running harness) and none runs the project's build/test: that can take minutes and
 * belongs in the review gate / red-main check, not a pre-flight. */

/** One line of the doctor report: a check's verdict plus what it found. "ok" and "warn" never
 * affect the exit code; only "fail" does (the CLI sets process.exitCode = 1 on any fail). */
export interface CheckOutcome {
  level: "ok" | "warn" | "fail";
  detail: string;
}

/** The full pre-flight report: a header carrying harness state, one entry per check in fixed
 * order, and the verdict line. */
export interface DoctorReport {
  header: string;
  checks: Array<{ name: string } & CheckOutcome>;
  verdict: string;
}

/** git binary — fail with the shared GIT_MISSING_MESSAGE so every entry point reports the
 * same fix for a machine without git installed. Takes an explicit PATH so tests can exercise
 * the missing branch by passing "" (no PATH mutation, no spawning). */
export function checkGitBinary(pathEnv: string = process.env.PATH ?? ""): CheckOutcome {
  const found = findOnPath("git", pathEnv);
  return found ? { level: "ok", detail: found } : { level: "fail", detail: GIT_MISSING_MESSAGE };
}

/** Repo ready — the git.ts predicates in requireReadyRepo's order, so doctor and the
 * readiness gate cannot drift: not a git repo → no commits yet → detached HEAD. */
export async function checkRepo(root: string): Promise<CheckOutcome> {
  if (!(await isGitRepo(root))) return { level: "fail", detail: "not a git repository (run `git init` first)" };
  if (!(await hasCommits(root)))
    return { level: "fail", detail: "the repo has no commits yet; `tumwater init` creates the first one" };
  const branch = await currentBranch(root);
  if (branch === null)
    return { level: "fail", detail: "the repo's primary checkout is detached; check out your main branch first" };
  return { level: "ok", detail: `on branch ${branch}` };
}

/** Initialized + config valid — tumwater.json present and loadConfig does not throw. The fail
 * detail carries the thrown message verbatim: it already holds validateConfig's full problem
 * list, so one edit can fix them all. */
export function checkInit(root: string): CheckOutcome {
  if (!fs.existsSync(configPath(root)))
    return { level: "fail", detail: "not initialized (run `tumwater init <prompt>` first)" };
  try {
    const config = loadConfig(root);
    return { level: "ok", detail: `${enabledRoleIds(config).length} roles enabled` };
  } catch (err) {
    return { level: "fail", detail: errorMessage(err) };
  }
}

/** pi binary — with cmdRun's existing install hint, so the two entry points cannot drift. */
export function checkPiBinary(pathEnv: string = process.env.PATH ?? ""): CheckOutcome {
  const found = findOnPath("pi", pathEnv);
  return found
    ? { level: "ok", detail: found }
    : {
        level: "fail",
        detail: "pi not found on PATH — install it (https://github.com/badlogic/pi-mono) or add its bin directory to your PATH",
      };
}

/** .tumwater writable — absent is fine (created on first run); present, prove it by writing
 * and deleting a temp file inside. The probe leaves the dir's listing unchanged after the run. */
export function checkStateDir(root: string): CheckOutcome {
  const dir = path.join(root, STATE_DIR);
  if (!fs.existsSync(dir)) return { level: "ok", detail: "absent — created on first run" };
  const probe = path.join(dir, `.doctor-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
    fs.rmSync(probe);
    return { level: "ok", detail: "writable" };
  } catch (err) {
    return { level: "fail", detail: `not writable: ${errorMessage(err)}` };
  }
}

/** Merge lock — read-only classification via classifyLock (the same three cases the breaker
 * uses). A stale lock is a warning, not a failure: it self-heals on the next merge. */
export function checkMergeLock(root: string): CheckOutcome {
  const dir = mergeLockDir(root);
  switch (classifyLock(dir)) {
    case "absent":
      return { level: "ok", detail: "not held" };
    case "live": {
      const pid = readLockPid(dir);
      return {
        level: "ok",
        detail: pid !== null ? `held by running loop (pid ${pid})` : "held (pid not yet written)",
      };
    }
    case "stale":
      return { level: "warn", detail: "stale — will be broken on next merge" };
  }
}

/** Declared build check — names the script the review gate's deterministic pre-check will run,
 * without running it. None declared is informational (non-JS target projects are expected to
 * have no npm scripts), not a warning. */
export function checkBuildCheck(root: string): CheckOutcome {
  const check = detectBuildCheck(root);
  if (!check)
    return { level: "ok", detail: "none declared — the review gate's deterministic pre-check will be skipped" };
  const where = path.relative(root, check.rootDir);
  return { level: "ok", detail: where ? `npm ${check.script} in ${where}` : `npm ${check.script}` };
}

/** Build provenance — is the harness about to run (this process's dist/) the code main
 * describes? Only meaningful when this project IS the harness (isSelfHosted); elsewhere the
 * stamp is reported as-is. A stale build is a warning, not a failure: the fleet runs, just not
 * the newest code, and auto-restart (or a rebuild + restart) resolves it. `info`, `head` and
 * `running` are injectable so tests can exercise every branch without compiling anything. */
export async function checkBuild(
  root: string,
  info: BuildInfo | null = readBuildInfo(),
  head: string | null | undefined = undefined,
  /** What the running orchestrator published about this build (orchestrator.json), when one is
   * up. A stale build whose restart was REFUSED must not be reported with the boilerplate
   * "auto-restart does this for a running fleet": nothing will happen until main moves, and
   * doctor is where an operator goes to find out why. */
  running: BuildStatus | null = null,
): Promise<CheckOutcome> {
  if (!info) return { level: "ok", detail: "no build stamp — dist/ compiled without `npm run build`" };
  const sha = info.sha.slice(0, 8);
  if (!(await isSelfHosted(root, info)))
    return { level: "ok", detail: `dist/ from ${sha} (this project is not the harness itself)` };
  const mainHead = head === undefined ? await currentHead(root) : head;
  if (!mainHead) return { level: "ok", detail: `dist/ from ${sha}` };
  const stale = await buildStaleness(root, info.sha, mainHead);
  if (!stale) return { level: "ok", detail: `dist/ from ${sha}` };
  if (stale.stale) {
    const next = running?.restartBlocked
      ? `; auto-restart is BLOCKED (${running.restartBlocked}) and will not retry until main moves or the block clears`
      : running?.restartPending
        ? "; auto-restart is under way"
        : "; run \`npm run build\` and restart \`tumwater run\` (auto-restart does this for a running fleet)";
    return {
      level: "warn",
      detail: `dist/ from ${sha} is stale — main has ${stale.aheadCommits} later commit(s) touching ${STALE_INPUTS_LABEL}${next}`,
    };
  }
  return { level: "ok", detail: `dist/ from ${sha}, matches main` };
}

/** The primary checkout's HEAD sha, or null when it cannot be resolved (no repo). */
async function currentHead(root: string): Promise<string | null> {
  return gitTry(root, "rev-parse", "HEAD");
}

/** Run every check in order and compose the report. Read-only against .tumwater/ by
 * construction — no check removes or repairs anything (the state-dir probe writes a temp file
 * and deletes it again) — so doctor works identically with or without a running harness. */
export async function runDoctor(root: string, pathEnv: string = process.env.PATH ?? ""): Promise<DoctorReport> {
  const info = readOrchestratorInfo(root);
  const header =
    orchestratorAlive(root, info) && info
      ? `tumwater doctor — harness running (pid ${info.pid}${info.build ? `, build ${info.build.sha.slice(0, 8)}${info.build.stale ? " — STALE" : ""}${info.build.restartBlocked ? " (restart blocked)" : ""}` : ""})`
      : "tumwater doctor — harness not running";
  const checks: DoctorReport["checks"] = [
    { name: "git binary", ...checkGitBinary(pathEnv) },
    { name: "repo", ...(await checkRepo(root)) },
    { name: "init", ...checkInit(root) },
    { name: "pi binary", ...checkPiBinary(pathEnv) },
    { name: "state dir", ...checkStateDir(root) },
    { name: "merge lock", ...checkMergeLock(root) },
    { name: "build check", ...checkBuildCheck(root) },
    // The running fleet's own view of its build (staleness and what auto-restart made of it)
    // when there is one; without it the check still stands on its own git comparison.
    { name: "build", ...(await checkBuild(root, undefined, undefined, (orchestratorAlive(root, info) && info?.build) || null)) },
  ];
  const problems = checks.filter((c) => c.level === "fail").length;
  return { header, checks, verdict: problems === 0 ? "ready to run" : `${problems} problem${problems > 1 ? "s" : ""}` };
}

/** Render the report: a header line, one line per check (level, name, detail), and the
 * verdict. Warnings never affect the exit code — only fails do. */
export function renderDoctor(report: DoctorReport): string {
  const lines = [report.header];
  for (const c of report.checks) lines.push(`${c.level.padEnd(5)} ${c.name.padEnd(12)} ${c.detail}`);
  lines.push(report.verdict);
  return lines.join("\n");
}
