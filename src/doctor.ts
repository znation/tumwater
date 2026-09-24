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
import { detectBuildCheck } from "./build-check-detect.js";
import { fallbackModelFree, piModelsPath } from "./pi-models.js";
import type { TumwaterConfig } from "./config-schema.js";
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
import { EXAMPLE_CONFIG_BASENAME, STATE_DIR, configPath, mergeLockDir, worktreesDir } from "./paths.js";
import { orchestratorAlive, readOrchestratorInfo } from "./fleet-state.js";
import { type ProcessProbe, type ProcessRow, systemProcessProbe } from "./process.js";
import { errorMessage, formatTime, shortSha, truncate } from "./text.js";
import type { FallbackDemotion } from "./budget.js";
import { briefFile } from "./readme.js";
import { bugEntryBody, fixSymbols, fixedHeadings, sourceHaystack, unbackedSymbols } from "./fix-claim.js";

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

/** Which file holds the project brief (the managed initial prompt + status sections,
 * plans/portability.md §7a/7): TUMWATER.md first, README.md as the compatibility path. A repo
 * whose README carries no markers — or that has no brief at all — still boots, but every loop
 * runs without its project prompt, so that state is a warning, not an error: it is exactly
 * what a repo looks like between `git clone` and `tumwater init` on purpose (e.g. 7b's
 * `--dry-run`). */
export function checkBrief(root: string): CheckOutcome {
  const owner = briefFile(root);
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

/** Fallback model readiness — the daily-cost budget's third state (plans/fallback-model.md):
 * with `fallbackModel` set, pi's definitions must price that pair at zero or the gate refuses
 * it and role loops pause at the cap exactly as if no fallback existed. That refusal is the
 * right runtime behavior (spend must never climb past the cap), but a typo'd id would otherwise
 * surface only after the day's budget is already spent — so doctor checks it up front, before
 * the operator needs it. Read-only: it inspects pi's definitions file, never pi or the network.
 * A price is not readiness, though: whether the backend can SERVE is known only from the
 * fallback's own ticks (src/budget.ts's breaker, BUGS.md 2026-09-20), so a free pair reads
 * "serving not verified" — unless the running orchestrator has published that its breaker
 * demoted the pair (`demoted`, from orchestrator.json; runDoctor passes it only while that
 * orchestrator is alive), which warns with the failure count and the next probe time. No
 * fallbackModel configured is informational, not a warning — plenty of fleets intend to stop
 * at the cap. `modelsPath` is injectable so tests need no real pi install. */
export function checkFallbackModel(
  root: string,
  modelsPath: string = piModelsPath(),
  demoted: FallbackDemotion | null = null,
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
  if (fallbackModelFree(config, modelsPath)) {
    if (demoted)
      return {
        level: "warn",
        detail: `${name} is priced at zero but not serving — the running fleet demoted it after ${demoted.failures} consecutive failed ticks, so role loops pause at the cap; one probe tick retries it from ${formatTime(new Date(demoted.probeAt))}`,
      };
    return { level: "ok", detail: `${name} — priced at zero (cost n/a), serving not verified` };
  }
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

/** Declared project check — names what the review gate's deterministic pre-check, the
 * red-main baseline, and redeploy's green check will run, without running it: a configured
 * `check.command` (plans/portability.md §6/7), else the npm auto-detection. None declared is
 * a warn, not informational (the 2026-09-05 stance predates non-npm targets being supported,
 * when a warn would have been noise no operator could act on — with `check.command` available
 * the warning is actionable): the three gates degrade to "no check" and a silently absent
 * safety layer is the failure this check exists to surface. Warn does not fail the exit code
 * (the checkFallbackModel precedent). */
export function checkBuildCheck(
  root: string,
  config?: { check?: { command: string; cwd?: string; timeoutSeconds?: number } } | null,
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

/** How many Fixed records the fix-claims check verifies: the newest, since the section is
 * newest-first by template convention. Older records drift as the code evolves — a symbol
 * legitimately fixed long ago gets renamed later — so a whole-section scan would warn forever
 * on records nobody should rewrite. */
const FIX_CLAIMS_CHECKED = 10;

/** A second or later suspect record's heading is trimmed to this many characters in the warn —
 * the first is named in full, the rest only enough to find them in BUGS.md. */
const FIX_CLAIM_HEADING_MAX = 60;

/** Fix claims — the standalone half of the landing gate's false-fix check (src/fix-claim.ts):
 * that gate fires only when an md-only diff moves a BUGS.md entry to Fixed, so a phantom fix
 * that reached main any other way (landed before the gate existed, or through a path it never
 * sees) was visible only to a human reading raw history. This re-verifies the newest Fixed
 * records against the tree at `root` — the primary checkout IS main's tree — with the gate's
 * own parsing and existence rules. Deliberately looser than the gate: a record warns only
 * when EVERY symbol its Fix paragraph names is absent (one live symbol passes — the phantom
 * signature, not a half-stale narrative), and a record naming no symbols is skipped, since
 * pure-documentation fixes are legitimate. A warn, never a fail (the checkFallbackModel
 * precedent): a suspicious record is operator signal, not a broken environment. */
export function checkFixClaims(root: string): CheckOutcome {
  const bugsPath = path.join(root, "BUGS.md");
  if (!fs.existsSync(bugsPath)) return { level: "ok", detail: "no BUGS.md — nothing to verify" };
  let doc: string;
  try {
    doc = fs.readFileSync(bugsPath, "utf8");
  } catch (err) {
    return { level: "warn", detail: `cannot read BUGS.md — ${errorMessage(err)}` };
  }
  const headings = fixedHeadings(doc).slice(0, FIX_CLAIMS_CHECKED);
  // The haystack walks src/, test/ and scripts/: build it only once a record names something.
  let haystack: string | undefined;
  const phantoms: Array<{ heading: string; missing: string[] }> = [];
  for (const heading of headings) {
    const symbols = fixSymbols(bugEntryBody(doc, heading));
    if (symbols.length === 0) continue;
    haystack ??= sourceHaystack(root);
    const missing = unbackedSymbols(root, symbols, haystack);
    if (missing.length === symbols.length) phantoms.push({ heading, missing });
  }
  const [first, ...rest] = phantoms;
  if (!first)
    return { level: "ok", detail: `newest ${headings.length} Fixed record(s) name code that exists on this tree` };
  // falseFixReason's message shape: the heading, then up to 3 missing names.
  const { heading, missing } = first;
  const names = missing.length <= 3 ? missing.join(", ") : `${missing.slice(0, 3).join(", ")}…`;
  // Every other suspect is still named, shortened: a doctor check is one line.
  const more =
    rest.length > 0
      ? ` (and ${rest.length} more record(s): ${rest.map((p) => `"${truncate(p.heading, FIX_CLAIM_HEADING_MAX)}"`).join(", ")})`
      : "";
  return {
    level: "warn",
    detail:
      `BUGS.md records "${heading}" as Fixed, but none of the symbols its Fix paragraph names ` +
      `exist on this tree: ${names}${more} — land the fix or keep the bug Open / refresh a stale record`,
  };
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

/** How many orphans the doctor line itemizes before counting the rest: a check is one line,
 * and the 2026-09-21 incident this check exists for had five. */
const ORPHANS_LISTED_MAX = 8;

/** An itemized orphan's command is trimmed to this many characters, after the repo root is
 * cut from it — enough for the program, the script and its subcommand and flags. */
const ORPHAN_COMMAND_MAX = 80;

/** A RELATIVE worktree path in an argv: `.tumwater/worktrees/<name>/`, at the start of an
 * argument or after a relative prefix (`./`, `../../`, `sub/`), never after a leading `/` —
 * absolute paths are compared against this repo's dirs directly (argvNamesDir). Captures the
 * path up to the worktree dir, and the worktree's name. */
const RELATIVE_WORKTREE_ARG = /(?:^|[\s"'=:])((?:[^\s"'=:/][^\s"'=:]*\/)?\.tumwater\/worktrees\/([^\s"'=:/]+))\//g;

/** The repo root in every spelling a process can report it: as given, and symlink-resolved —
 * lsof and /proc report a cwd resolved (macOS's /var is /private/var), while an argv holds
 * whatever path was typed. */
function rootSpellings(root: string): string[] {
  const given = path.resolve(root);
  try {
    const real = fs.realpathSync(given);
    return real === given ? [given] : [given, real];
  } catch {
    return [given];
  }
}

/** True when `p` is one of `dirs` or lies under one. */
function isUnder(p: string, dirs: string[]): boolean {
  return dirs.some((d) => p === d || p.startsWith(`${d}/`));
}

/** True when an argv names an absolute path under one of `dirs` — at the start of an
 * argument, so a different checkout whose path merely ends in this one's is not matched. */
function argvNamesDir(command: string, dirs: string[]): boolean {
  return dirs.some((d) => {
    const needle = `${d}/`;
    for (let i = command.indexOf(needle); i !== -1; i = command.indexOf(needle, i + 1))
      if (i === 0 || /[\s"'=:]/.test(command.charAt(i - 1))) return true;
    return false;
  });
}

/** True when an argv's RELATIVE worktree path (`node .tumwater/worktrees/qa/dist/src/cli.js
 * gui …`) is this repo's. Resolved against the process's cwd it must land here; one that lands
 * in a worktree that exists elsewhere belongs to another checkout's fleet and is not blamed on
 * this one. When the resolution lands nowhere — the cwd is unreadable, or is a scratch dir
 * since deleted (the leaked qa GUI's was), or the process chdir'd after exec — the worktree's
 * name is the evidence left: it counts only when this repo has a worktree by that name. */
function relativeArgvIsOurs(command: string, cwd: string | undefined, root: string, dirs: string[]): boolean {
  for (const [, rel = "", name = ""] of command.matchAll(RELATIVE_WORKTREE_ARG)) {
    if (cwd !== undefined) {
      const resolved = path.resolve(cwd, rel);
      if (isUnder(resolved, dirs)) return true;
      if (fs.existsSync(resolved)) continue; // Another checkout's live worktree.
    }
    if (fs.existsSync(path.join(worktreesDir(root), name))) return true;
  }
  return false;
}

/** How many processes descend from `pid`, given the table's parent → children map — an
 * orphaned test runner's workers keep the runner as their parent, so they are the orphan's
 * tree, not orphans of their own, and killing the runner alone leaves them running. */
function descendantCount(children: Map<number, number[]>, pid: number): number {
  const seen = new Set<number>();
  const stack = [...(children.get(pid) ?? [])];
  for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
    if (seen.has(p) || p === pid) continue;
    seen.add(p);
    stack.push(...(children.get(p) ?? []));
  }
  return seen.size;
}

/** Orphaned worktree processes — the detector half of the grandchild-leak fix (BUGS.md
 * 2026-09-21): a process reparented to PID 1 that belongs to one of this repo's worktrees.
 * Leaks of this kind (a killed tick's tool-call grandchildren, a timed-out build check's test
 * tree, a pi run's backgrounded server, a stray orchestrator an orphaned suite started) hold
 * no lock, write no event and touch no state file, so nothing else in the harness can see
 * them. A process is this repo's when its argv names a path under `.tumwater/worktrees/`
 * (absolute; or relative, confirmed by cwd where it can be — relativeArgvIsOurs) or when its
 * cwd lies under it: a leaked `node dist/src/test-runner.js` names no worktree at all.
 *
 * PPID 1 is what keeps the live fleet out: a running orchestrator's pi runs and build checks
 * have the orchestrator as parent, and the orchestrator and its supervisor run from the repo
 * root, never from a worktree, even when a detached `nohup` launch leaves them parentless.
 * (macOS always reparents an orphan to launchd, PID 1; on Linux a process under a child
 * subreaper — `systemd --user` in a desktop session — is reparented to that instead, and is
 * not seen here.)
 *
 * Cheap by construction: one `ps`, then one cwd lookup covering only the parentless
 * processes argv did not already settle (and only those this user can inspect — lsof and
 * /proc cannot read anyone else's, root reads all). An unreadable table degrades to a warn,
 * never a crashed doctor; unreadable cwds degrade to the argv match and say so. Any orphan is
 * a fail — the exit code is the point: a scripted doctor must notice. `probe` is injectable so
 * tests run against a fake table. */
export async function checkOrphans(
  root: string,
  probe: ProcessProbe = systemProcessProbe,
): Promise<CheckOutcome> {
  let rows: ProcessRow[];
  try {
    rows = await probe.list();
  } catch (err) {
    return { level: "warn", detail: `could not scan the process table — ${errorMessage(err)}` };
  }
  const roots = rootSpellings(root);
  const dirs = roots.map(worktreesDir);
  // Never doctor itself, should it be run parentless from a worktree's build.
  const parentless = rows.filter((r) => r.ppid === 1 && r.pid !== process.pid);
  const byArgv = new Set(parentless.filter((r) => argvNamesDir(r.command, dirs)).map((r) => r.pid));
  const uid = process.getuid?.();
  const ask = parentless
    .filter((r) => !byArgv.has(r.pid) && (uid === undefined || uid === 0 || r.uid === uid))
    .map((r) => r.pid);
  let cwds = new Map<number, string>();
  let cwdProblem: string | null = null;
  if (ask.length > 0) {
    try {
      cwds = await probe.cwds(ask);
    } catch (err) {
      cwdProblem = errorMessage(err);
    }
  }
  const orphans = parentless.filter((r) => {
    if (byArgv.has(r.pid)) return true;
    const cwd = cwds.get(r.pid);
    return (cwd !== undefined && isUnder(cwd, dirs)) || relativeArgvIsOurs(r.command, cwd, root, dirs);
  });
  if (orphans.length === 0) {
    if (cwdProblem !== null)
      return {
        level: "warn",
        detail: `none named in argv, but process cwds are unreadable (${cwdProblem}) — an orphan started inside a worktree, like a leaked test runner, would be missed`,
      };
    return { level: "ok", detail: "none — no process reparented to PID 1 runs from .tumwater/worktrees/" };
  }
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const siblings = children.get(r.ppid);
    if (siblings) siblings.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  // The root is cut from each shown command, longest spelling first: the resolved one can
  // contain the given one (/private/var/… holds /var/…).
  const cut = [...roots].sort((a, b) => b.length - a.length);
  const listed = orphans.slice(0, ORPHANS_LISTED_MAX).map((r) => {
    const n = descendantCount(children, r.pid);
    const tree = n > 0 ? `, +${n} descendant${n > 1 ? "s" : ""}` : "";
    const command = cut.reduce((c, rt) => c.split(`${rt}/`).join(""), r.command);
    return `pid ${r.pid} (age ${r.etime}, cpu ${r.time}${tree}) ${truncate(command, ORPHAN_COMMAND_MAX)}`;
  });
  const more = orphans.length - listed.length;
  const count = `${orphans.length} orphaned worktree process${orphans.length > 1 ? "es" : ""} (PPID 1)`;
  return {
    level: "fail",
    detail:
      `${count}: ${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}` +
      " — nothing reaps these; kill each with its descendants" +
      (cwdProblem !== null ? ` (process cwds unreadable — ${cwdProblem}; argv matched only)` : ""),
  };
}

/** Run every check in order and compose the report. Read-only against .tumwater/ by
 * construction — no check removes or repairs anything (the state-dir probe writes a temp file
 * and deletes it again; the orphan check reports processes, never signals them) — so doctor
 * works identically with or without a running harness. `probe` feeds the orphan check, so
 * tests can pin the report without reading the host's process table. */
export async function runDoctor(
  root: string,
  pathEnv: string = process.env.PATH ?? "",
  probe: ProcessProbe = systemProcessProbe,
): Promise<DoctorReport> {
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
    { name: "brief", ...checkBrief(root) },
    { name: "fallback", ...checkFallbackModel(root, undefined, (orchestratorAlive(root, info) && info?.fallbackDemoted) || null) },
    { name: "pi binary", ...checkAgentBinary(root, pathEnv) },
    { name: "state dir", ...checkStateDir(root) },
    { name: "merge lock", ...checkMergeLock(root) },
    { name: "project check", ...checkBuildCheck(root, config) },
    { name: "fix claims", ...checkFixClaims(root) },
    // The running fleet's own view of its build (staleness and what auto-restart made of it)
    // when there is one; without it the check still stands on its own git comparison.
    { name: "build", ...(await checkBuild(root, undefined, undefined, (orchestratorAlive(root, info) && info?.build) || null)) },
    { name: "orphans", ...(await checkOrphans(root, probe)) },
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
