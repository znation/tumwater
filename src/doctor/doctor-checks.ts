import fs from "node:fs";
import path from "node:path";
import {
  enabledRoleIds,
  loadConfig,
  loadConfigSafe,
} from "../config/config.js";
import { exampleConfigProblem, exampleDrift } from "../config/config-example.js";
import { detectBuildCheck } from "../build/build-check-detect.js";
import { type CheckConfigSlice, type TumwaterConfig } from "../config/config-schema.js";
import { type BuildInfo, type BuildStatus, buildStaleness, isSelfHosted, readBuildInfo, STALE_INPUTS_LABEL } from "../build/build-info.js";
import { findOnPath } from "../files/files.js";
import { PACKAGE_JSON, belowNodeFloor, packageEnginesNode } from "../version.js";
import { GIT_MISSING_MESSAGE } from "../git/git-run.js";
import {
  branchExists,
  currentBranch,
  hasCommits,
  branchesPhrase,
  isGitRepo,
  refSha,
  repoToplevel,
} from "../git/git.js";
import {
  DETACHED_HEAD_MESSAGE,
  NOT_A_REPO_MESSAGE,
  NOT_INITIALIZED_MESSAGE,
  NO_COMMITS_MESSAGE,
  agentBinSourceLabel,
  findAgentBinary,
  piMissingMessage,
  resolveAgentBin,
} from "../gates/readiness.js";
import { classifyLock, readLockPid } from "../concurrency/lock.js";
import { EXAMPLE_CONFIG_BASENAME, STATE_DIR, configPath, mergeLockDir } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { shortSha } from "../text/format.js";
import { briefFile } from "../readme.js";

/** The doctor report contract and the environment/repo pre-flight checks, split out of
 * doctor.ts. The sibling check modules (doctor-orphans.ts, doctor-backlog.ts, and
 * process/launch-services.ts) depend on the shared CheckOutcome shape directly instead of type-importing
 * it from the aggregator that runs them, and the checks themselves live here so doctor.ts stays
 * the composition layer only: runDoctor calls each check in fixed order and folds the results
 * into a DoctorReport. The model-readiness checks (the cap fallback, the agent binary's
 * credential probe, the declared tiers) live in doctor-model-checks.ts; the backlog-document
 * checks (BUGS.md / PLANS.md readers) live in doctor-backlog.ts; the report's terminal
 * rendering lives beside the CLI's other Markdown/terminal renderers (doctor-render.ts), and
 * doctor.ts stays the composition layer only. */

/** One line of the doctor report: a check's verdict plus what it found. "ok" and "warn" never
 * affect the exit code; only "fail" does (the CLI sets process.exitCode = 1 on any fail). The
 * orphan check lives in doctor-orphans.ts and returns this shape too. */
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

/** The floor doctor falls back to when package.json — the one source of the declared
 * engines.node spec, read below — cannot be read (a broken install, the version command's
 * story). The CLI's startup gate enforces the spec itself; this check stays a warning so a
 * runtime that usually still works does not block a scripted pre-flight. */
const NODE_FLOOR_FALLBACK = ">=20";

/** Node runtime — warn when this process runs below the declared floor: package.json's
 * engines.node spec, the same one the CLI's startup gate fails on, read here so the check
 * and the gate cannot drift (the literal fallback above covers only an unreadable package).
 * The comparison is belowNodeFloor's component-wise spec match, not a major-only read, so
 * `v20.0.0` against `>=20.3` warns here exactly as the gate refuses it. Takes the version
 * string (defaulting to process.versions.node) so the below-floor branch is unit-testable
 * without swapping the runtime. A warning, not a failure: doctor reports the mismatch so the
 * operator can decide, and a runtime that usually still works does not block a scripted
 * pre-flight. */
export function checkNodeVersion(
  version: string = process.versions.node,
  floor: string = packageEnginesNode(PACKAGE_JSON) ?? NODE_FLOOR_FALLBACK,
): CheckOutcome {
  const major = Number.parseInt(version, 10);
  if (!Number.isInteger(major) || major <= 0)
    return { level: "warn", detail: `unrecognized Node version ${JSON.stringify(version)}` };
  if (!belowNodeFloor(version, floor)) return { level: "ok", detail: `v${version}` };
  return {
    level: "warn",
    detail: `v${version} is below the ${floor} Node floor declared in package.json engines — upgrade Node`,
  };
}

/** git binary — fail with the shared GIT_MISSING_MESSAGE so every entry point reports the
 * same fix for a machine without git installed. Takes an explicit PATH so tests can exercise
 * the missing branch by passing "" (no PATH mutation, no spawning). The agent-binary check's
 * rule is richer (bare name vs path-shaped) and lives in readiness.ts's findAgentBinary. */
export function checkGitBinary(pathEnv: string = process.env.PATH ?? ""): CheckOutcome {
  const found = findOnPath("git", pathEnv);
  if (!found) return { level: "fail", detail: GIT_MISSING_MESSAGE };
  return { level: "ok", detail: found };
}

/** Repo ready — the git/git.ts predicates in requireReadyRepo's order, so doctor and the
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
      const existing = await branchesPhrase(root);
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

/** Which file holds the project brief (the managed initial prompt + status sections,
 * plans/portability.md §7a/7): TUMWATER.md first, README.md as the compatibility path. A repo
 * whose README carries no markers — or that has no brief at all — still boots, but every loop
 * runs without its project prompt, so that state is a warning, not an error: it is exactly
 * what a repo looks like between `git clone` and `tumwater init` on purpose (e.g. 7b's
 * `--dry-run`). */
export function checkBrief(root: string): CheckOutcome {
  // briefFile throws on a brief candidate that exists but cannot be read (a directory at
  // the README.md path, a permission-lost file) — report it as the check's failure instead
  // of crashing doctor: the fleet would run without its brief every tick.
  let owner: string | null;
  try {
    owner = briefFile(root);
  } catch (err) {
    return { level: "fail", detail: errorMessage(err) };
  }
  if (owner) return { level: "ok", detail: `brief in ${owner}` };
  if (fs.existsSync(path.join(root, "README.md"))) {
    return {
      level: "warn",
      detail:
        `README.md carries no tumwater:prompt markers — the fleet would run without its project brief; add the block or re-run \`tumwater init\``,
    };
  }
  return { level: "warn", detail: "no brief file — run `tumwater init <prompt>` to seed one" };
}

/** Agent binary (plans/portability.md §5/7) — resolves TUMWATER_PI_BIN → agentBin → "pi"
 * through the same resolveAgentBin the spawn uses, so doctor and the harness can never
 * disagree about which pi runs (a malformed tumwater.json resolves to defaults; checkInit
 * reports the config problem separately). Executability is readiness.ts's shared
 * findAgentBinary — the same bare-name PATH lookup, path-shaped accessSync(X_OK) rule, and
 * null-on-unusable verdict the startup gate asks — so doctor cannot pass a binary the gate
 * would reject. resolveAgentBin normalizes path-shaped values against the process cwd at
 * resolution time, so what doctor tests is exactly what spawns. The ok detail names the
 * resolved path AND its source whenever the value is not the PATH default, so a configured
 * binary is never mistaken for the ambient one; the check label stays "pi binary". */
export function checkAgentBinary(
  root: string,
  pathEnv: string = process.env.PATH ?? "",
): CheckOutcome {
  const { config } = loadConfigSafe(root);
  const resolved = resolveAgentBin(config ?? {});
  const found = findAgentBinary(resolved, pathEnv);
  if (!found) return { level: "fail", detail: piMissingMessage(resolved) };
  if (resolved.source === "default") return { level: "ok", detail: found };
  const from = agentBinSourceLabel(resolved.source);
  return { level: "ok", detail: `${found} — resolved from ${from}` };
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

/** Declared project check — names what the review gate's deterministic pre-check, the
 * red-main baseline, and redeploy's green check will run, without running it: a configured
 * `check.command` (plans/portability.md §6/7), else the npm auto-detection. None declared is
 * a warn, not informational (the 2026-09-05 stance predates non-npm targets being supported,
 * when a warn would have been noise no operator could act on — with `check.command` available
 * the warning is actionable): the three gates degrade to "no check" and a silently absent
 * safety layer is the failure this check exists to surface. Warn does not fail the exit code
 * (the fallback check's precedent, doctor-model-checks.ts's checkFallbackModel). */
export function checkBuildCheck(
  root: string,
  config?: CheckConfigSlice | null,
): CheckOutcome {
  const check = detectBuildCheck(root, config ?? undefined);
  if (!check)
    return {
      level: "warn",
      detail: "none declared — the review gate's build pre-check, the red-main baseline, and redeploy's green check are all off (set `check.command` in tumwater.json for a non-npm repo)",
    };
  if (check.kind === "command") {
    const where = path.relative(root, check.cwd);
    return { level: "ok", detail: where ? `${check.command} (cwd ${where})` : check.command };
  }
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
    // Not "dist/ from …": in someone else's project that names a dist/ directory the project
    // does not have — the stamp read here is the running harness install's own, so say that.
    return { level: "ok", detail: `harness build ${sha} (this project is not the harness itself)` };
  const mainHead = head === undefined ? await currentHead(root) : head;
  if (!mainHead) return { level: "ok", detail: `dist/ from ${sha}` };
  const stale = await buildStaleness(root, info.sha, mainHead);
  if (!stale) return { level: "ok", detail: `dist/ from ${sha}` };
  if (stale.stale) {
    const next = running?.restartBlocked
      ? `; auto-restart is BLOCKED (${running.restartBlocked}) and will not retry until main moves or the block clears`
      : running?.restartPending
        ? "; auto-restart is under way"
        : "; run `npm run build` and restart `tumwater run` (auto-restart does this for a running fleet)";
    return {
      level: "warn",
      detail: `dist/ from ${sha} is stale — main has ${stale.aheadCommits} later commit(s) touching ${STALE_INPUTS_LABEL}${next}`,
    };
  }
  return { level: "ok", detail: `dist/ from ${sha}, matches main` };
}

/** The primary checkout's HEAD sha, or null when it cannot be resolved (no repo) —
 * git/git.ts's refSha, the one home of the rev-parse probe. */
function currentHead(root: string): Promise<string | null> {
  return refSha(root, "HEAD");
}
