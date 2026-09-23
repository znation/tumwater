import fs from "node:fs";
import path from "node:path";
import {
  enabledRoleIds,
  exampleConfigProblem,
  exampleDrift,
  fallbackPair,
  loadConfig,
  loadConfigSafe,
} from "./config.js";
import { detectBuildCheck } from "./build-check.js";
import { fallbackModelFree, piModelsPath } from "./pi-models.js";
import type { TumwaterConfig } from "./types.js";
import { type BuildInfo, type BuildStatus, buildStaleness, isSelfHosted, readBuildInfo } from "./build-info.js";
import { STALE_INPUTS_LABEL } from "./redeploy.js";
import { findOnPath } from "./files.js";
import {
  GIT_MISSING_MESSAGE,
  branchExists,
  currentBranch,
  gitTry,
  hasCommits,
  isGitRepo,
  listBranches,
  repoToplevel,
} from "./git.js";
import {
  DETACHED_HEAD_MESSAGE,
  NOT_A_REPO_MESSAGE,
  NOT_INITIALIZED_MESSAGE,
  NO_COMMITS_MESSAGE,
  agentBinSourceLabel,
  piMissingMessage,
} from "./readiness.js";
import { resolveAgentBin } from "./pi.js";
import { classifyLock, readLockPid } from "./lock.js";
import { EXAMPLE_CONFIG_BASENAME, STATE_DIR, configPath, mergeLockDir } from "./paths.js";
import { orchestratorAlive, readOrchestratorInfo } from "./fleet-state.js";
import { errorMessage, shortSha } from "./text.js";

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
interface CheckOutcome {
  level: "ok" | "warn" | "fail";
  detail: string;
}

/** The full pre-flight report: a header carrying harness state, one entry per check in fixed
 * order, and the verdict line. */
interface DoctorReport {
  header: string;
  checks: Array<{ name: string } & CheckOutcome>;
  verdict: string;
}

/** The Node.js major version this harness supports — the floor declared in package.json's
 * `engines` (">=20"). The build targets ES2023 and the code deliberately stays off Node
 * 20.12-only APIs (files.ts), so an older runtime may still work, but it is outside what the
 * project declares and tests. */
const MIN_NODE_MAJOR = 20;

/** Node runtime — warn when this process runs below the declared floor. Takes the version
 * string (defaulting to process.versions.node) so the below-floor branch is unit-testable
 * without swapping the runtime. A warning, not a failure: doctor reports the mismatch so the
 * operator can decide, and a runtime that usually still works does not block a scripted
 * pre-flight. */
export function checkNodeVersion(version: string = process.versions.node): CheckOutcome {
  const major = Number.parseInt(version, 10);
  if (!Number.isInteger(major) || major <= 0)
    return { level: "warn", detail: `unrecognized Node version ${JSON.stringify(version)}` };
  if (major >= MIN_NODE_MAJOR) return { level: "ok", detail: `v${version}` };
  return {
    level: "warn",
    detail: `v${version} is below the v${MIN_NODE_MAJOR} minimum declared in package.json engines — upgrade Node`,
  };
}

/** Resolve a required binary on PATH: its absolute path when found, else `missing` at fail
 * level — the shared shape of the git and pi checks below, so both resolve and report
 * identically. `describeFound` optionally rewords the ok detail (the agent-binary check
 * names where a non-default value came from); git passes none and keeps today's text. */
function checkBinary(
  name: string,
  missing: string,
  pathEnv: string,
  describeFound?: (found: string) => string,
): CheckOutcome {
  const found = findOnPath(name, pathEnv);
  if (!found) return { level: "fail", detail: missing };
  return { level: "ok", detail: describeFound ? describeFound(found) : found };
}

/** git binary — fail with the shared GIT_MISSING_MESSAGE so every entry point reports the
 * same fix for a machine without git installed. Takes an explicit PATH so tests can exercise
 * the missing branch by passing "" (no PATH mutation, no spawning). */
export function checkGitBinary(pathEnv: string = process.env.PATH ?? ""): CheckOutcome {
  return checkBinary("git", GIT_MISSING_MESSAGE, pathEnv);
}

/** Repo ready — the git.ts predicates in requireReadyRepo's order, so doctor and the
 * readiness gate cannot drift: not a git repo → no commits yet → detached HEAD. Reports the
 * resolved toplevel (not the cwd — doctor must say where .tumwater/ lives) and the branch the
 * fleet would target: a configured `baseBranch` wins (`run --branch` is per-invocation), and
 * one that does not exist fails here instead of at the first tick. `config` is optional so
 * the check stands alone; runDoctor passes the loaded config behind a guard. */
export async function checkRepo(root: string, config?: TumwaterConfig): Promise<CheckOutcome> {
  if (!(await isGitRepo(root))) return { level: "fail", detail: NOT_A_REPO_MESSAGE };
  if (!(await hasCommits(root))) return { level: "fail", detail: NO_COMMITS_MESSAGE };
  const toplevel = (await repoToplevel(root)) ?? root;
  const configured = config?.baseBranch;
  if (configured !== undefined) {
    if (!(await branchExists(root, configured))) {
      const existing = (await listBranches(root)).join(", ") || "none";
      return {
        level: "fail",
        detail: `repo at ${toplevel} — configured baseBranch ${configured} does not exist (branches: ${existing})`,
      };
    }
    return { level: "ok", detail: `repo at ${toplevel} — targeting branch ${configured}` };
  }
  const branch = await currentBranch(root);
  if (branch === null) return { level: "fail", detail: DETACHED_HEAD_MESSAGE };
  return { level: "ok", detail: `repo at ${toplevel} — on branch ${branch}` };
}

/** Initialized + config valid — tumwater.json present and loadConfig does not throw. The fail
 * detail carries the thrown message verbatim: it already holds validateConfig's full problem
 * list, so one edit can fix them all. On a valid config it folds in template drift
 * (plans/portability.md §4a/7): when the tracked tumwater.example.json sets keys the local file
 * lacks, the check warns naming them — a warn never touches the exit code — with a remedy that
 * actually works (init skips an existing config, so reseeding means deleting it first), and the
 * no-drift detail stays the pinned "N roles enabled". A template that cannot serve as one —
 * unparseable or invalid — warns too: seedConfig silently seeds the bare defaults from it and
 * exampleDrift reports no drift, so without this the operator's template intent fails with no
 * signal anywhere (a broken template only bites fresh checkouts, which is exactly when nobody
 * is watching). The template problem outranks drift: drift is computed from a parse that has
 * already failed. */
export function checkInit(root: string): CheckOutcome {
  if (!fs.existsSync(configPath(root))) return { level: "fail", detail: NOT_INITIALIZED_MESSAGE };
  try {
    const config = loadConfig(root);
    const templateProblem = exampleConfigProblem(root);
    if (templateProblem !== null) {
      return {
        level: "warn",
        detail: `broken template: ${templateProblem} — init seeds the bare defaults from it on fresh checkouts; fix the file so new clones get your roles/intervals baseline`,
      };
    }
    const drift = exampleDrift(root);
    if (drift.length > 0) {
      return {
        level: "warn",
        detail:
          `template drift: tumwater.json lacks keys ${EXAMPLE_CONFIG_BASENAME} sets (${drift.join(", ")})` +
          " — copy them in, or delete tumwater.json and re-run `tumwater init` to reseed from the " +
          "template (it omits machine keys like provider/model, so re-add those after reseeding)",
      };
    }
    return { level: "ok", detail: `${enabledRoleIds(config).length} roles enabled` };
  } catch (err) {
    return { level: "fail", detail: errorMessage(err) };
  }
}

/** Fallback model readiness — the daily-cost budget's third state (plans/fallback-model.md):
 * with `fallbackModel` set, pi's definitions must price that pair at zero or the gate refuses
 * it and role loops pause at the cap exactly as if no fallback existed. That refusal is the
 * right runtime behavior (spend must never climb past the cap), but a typo'd id would otherwise
 * surface only after the day's budget is already spent — so doctor checks it up front, before
 * the operator needs it. Read-only: it inspects pi's definitions file, never pi or the network.
 * No fallbackModel configured is informational, not a warning — plenty of fleets intend to stop
 * at the cap. `modelsPath` is injectable so tests need no real pi install. */
export function checkFallbackModel(
  root: string,
  modelsPath: string = piModelsPath(),
): CheckOutcome {
  let config: TumwaterConfig;
  try {
    config = loadConfig(root);
  } catch (err) {
    // checkInit already fails on a broken tumwater.json; this check only says it could not run.
    return { level: "warn", detail: `cannot check — ${errorMessage(err)}` };
  }
  const pair = fallbackPair(config);
  if (!pair) return { level: "ok", detail: "none configured — role loops pause at the cap" };
  // A pair missing either half would fall through to pi's own (unverified) default, so it can
  // never be free; naming that case beats rendering a bare "?/model".
  const name =
    pair.provider && pair.model ? `${pair.provider}/${pair.model}` : "a half-resolved pair";
  if (fallbackModelFree(config, modelsPath))
    return { level: "ok", detail: `${name} — priced at zero (cost n/a)` };
  return {
    level: "warn",
    detail: `${name} is not priced at zero in ${modelsPath} — at the cap role loops pause instead of switching`,
  };
}

/** Agent binary (plans/portability.md §5/7) — resolves TUMWATER_PI_BIN → agentBin → "pi"
 * through the same resolveAgentBin the spawn uses, so doctor and the harness can never
 * disagree about which pi runs (a malformed tumwater.json resolves to defaults; checkInit
 * reports the config problem separately). A bare name resolves through the shared
 * checkBinary helper — the same PATH resolution the git check uses; a path-shaped value is
 * tested directly with accessSync(X_OK), already normalized against the process cwd at
 * resolution time, so what doctor tests is exactly what spawns. The ok detail names the
 * resolved path AND its source whenever the value is not the PATH default, so a configured
 * binary is never mistaken for the ambient one; the check label stays "pi binary". */
export function checkAgentBinary(
  root: string,
  pathEnv: string = process.env.PATH ?? "",
): CheckOutcome {
  const { config } = loadConfigSafe(root);
  const resolved = resolveAgentBin(config ?? {});
  if (resolved.source === "default") return checkBinary("pi", piMissingMessage(resolved), pathEnv);
  const from = agentBinSourceLabel(resolved.source);
  const describeFound = (found: string) => `${found} — resolved from ${from}`;
  if (!resolved.bin.includes("/"))
    return checkBinary(resolved.bin, piMissingMessage(resolved), pathEnv, describeFound);
  try {
    fs.accessSync(resolved.bin, fs.constants.X_OK);
    return { level: "ok", detail: describeFound(resolved.bin) };
  } catch {
    return { level: "fail", detail: piMissingMessage(resolved) };
  }
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
  const sha = shortSha(info.sha);
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
  // Loaded once for the checks that read config (repo's baseBranch); a broken file stays
  // null — checkInit reports it verbatim — so doctor still runs every other check.
  let config: TumwaterConfig | null = null;
  try {
    config = loadConfig(root);
  } catch {
    // checkInit reports the config problem.
  }
  const info = readOrchestratorInfo(root);
  const header =
    orchestratorAlive(root, info) && info
      ? `tumwater doctor — harness running (pid ${info.pid}${info.build ? `, build ${shortSha(info.build.sha)}${info.build.stale ? " — STALE" : ""}${info.build.restartBlocked ? " (restart blocked)" : ""}` : ""})`
      : "tumwater doctor — harness not running";
  const checks: DoctorReport["checks"] = [
    { name: "node", ...checkNodeVersion() },
    { name: "git binary", ...checkGitBinary(pathEnv) },
    { name: "repo", ...(await checkRepo(root, config ?? undefined)) },
    { name: "init", ...checkInit(root) },
    { name: "fallback", ...checkFallbackModel(root) },
    { name: "pi binary", ...checkAgentBinary(root, pathEnv) },
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
