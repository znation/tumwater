import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { HarnessEventInput } from "./events.js";
import {
  type BuildInfo,
  type BuildStaleness,
  type BuildStatus,
  BUILD_INPUTS,
  buildStaleness,
  distDir,
  isSelfHosted,
  readBuildInfo,
  stampBuild,
} from "./build-info.js";
import { type BuildCheckOutcome, checkMainBaseline, clipBuildTail, resolveFromNodeModules } from "./build-check.js";
import { ensureDir } from "./files.js";
import { ensureDetachedWorktree } from "./git.js";
import { mirrorWorktreePath, stagingDir, stagingRootDir } from "./paths.js";
import { shortSha } from "./text.js";

const execFileAsync = promisify(execFile);

/** Self-redeploy for a self-hosting fleet (see build-info.ts for why): when main's build inputs
 * have moved past the running build, verify that main is green, compile it into a staging dir,
 * drain the fleet (no new ticks; in-flight ones finish or are aborted resumably after
 * RESTART_DRAIN_MAX_MS), swap the compiled tree into dist/, and ask the supervisor (cli.ts,
 * supervisor.ts) to respawn the harness onto it by exiting RESTART_EXIT_CODE. Every step is
 * non-blocking from the orchestrator's poll: the green check and the compile run in the
 * background and are consulted on later polls, so a slow `npm test` never stalls scheduling.
 *
 * Nothing here is fail-open: a red main, a failed compile, or a swap error blocks the restart for
 * that head and the fleet keeps running the old build until main moves again. A block says so
 * out loud — one warning event, and the reason in BuildStatus.restartBlocked, which the
 * dashboards and doctor render — because a stale build that is about to be replaced and one
 * that never will be look identical otherwise (BUGS.md, 2026-09-08). Every tick a restart
 * interrupts resumes on the new build through the same resume machinery a Ctrl+C uses, so a
 * restart loses no work. */

/** The exit code a supervised `tumwater run` child uses to say "rebuilt; respawn me" — EX_TEMPFAIL,
 * distinct from success (0), fail() (1) and a forced Ctrl+C (130). */
export const RESTART_EXIT_CODE = 75;

/** How long a pending restart waits for in-flight ticks before aborting them (they resume on
 * the new build). Median ticks run ~35 min on local hardware; a half-hour drain lets most of
 * them finish while bounding how long the fleet keeps executing stale code. Measured across the
 * whole unbroken hold, not per head — see Redeployer.drainSince. */
export const RESTART_DRAIN_MAX_MS = 30 * 60_000;

/** Hard cap on one compile of the harness; tsc on this codebase takes well under a minute. */
export const COMPILE_TIMEOUT_MS = 5 * 60_000;

/** What the orchestrator should do this poll: `hold` starts no new ticks (a restart is pending),
 * `restart` means dist/ now holds the new build — stop and exit RESTART_EXIT_CODE. */
export type RedeployAction = "none" | "hold" | "restart";

export type { BuildStatus } from "./build-info.js";

/** The effects the redeploy policy drives, injectable so the policy is testable without git,
 * tsc, or a real fleet. Production wiring is createRedeployer below. */
export interface RedeployDeps {
  /** How far the running build is behind `mainHead` (null: not this repo's build). */
  staleness(mainHead: string): Promise<BuildStaleness | null>;
  /** Is main's own build/test suite green at `mainHead`? A project with no declared check (or
   * an environmental skip) reads as green — the same warn-and-proceed the gates use. */
  mainGreen(mainHead: string): Promise<boolean>;
  /** Compile `mainHead` into its staging dir and stamp it; `detail` explains a failure. */
  compile(mainHead: string): Promise<{ ok: boolean; detail: string }>;
  /** Move `mainHead`'s staged build into place as the live dist/. Throws on failure. */
  swap(mainHead: string): void;
}

/** A background task the poll consults without awaiting: settled flag plus result. */
interface Tracked<T> {
  done: boolean;
  result?: T;
  error?: string;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  const t: Tracked<T> = { done: false };
  promise.then(
    (r) => {
      t.result = r;
      t.done = true;
    },
    (err: unknown) => {
      t.error = err instanceof Error ? err.message : String(err);
      t.done = true;
    },
  );
  return t;
}

/** Event input as the orchestrator logs it (logEvent stamps ts). */
type RedeployEvent = HarnessEventInput;

/** The redeploy state machine — one per orchestrator process. `poll` is called every scheduler
 * cycle with main's current head and the number of in-flight ticks and returns what to do; it
 * never throws and never awaits anything slower than a git query. */
export class Redeployer {
  private lastHead: string | null = null;
  private staleness: BuildStaleness | null = null;
  /** The head a restart is pending for. */
  private pendingHead: string | null = null;
  /** When the fleet's current unbroken hold began — 0 when it is not being held. The drain
   * deadline is measured from here and NOT from when the current head became pending: a busy
   * self-hosting fleet merges while it drains, and giving each new head its own full window
   * handed the same in-flight ticks another 30 minutes every time main moved. On 2026-09-08 that
   * held the fleet for 38 minutes under a 30-minute cap and reported the last 30 (BUGS.md).
   * Nothing new starts during a hold, so the ticks a drain waits on can only be the ones it
   * began with — one window is all they are owed. */
  private drainSince = 0;
  private green: Tracked<boolean> | null = null;
  private compiled: Tracked<{ ok: boolean; detail: string }> | null = null;
  /** A head whose restart was blocked (red main, compile failure, swap error): no retry until
   * main moves — the warning was logged once. */
  private blockedHead: string | null = null;
  /** Why, in a few words, for status() to publish alongside the staleness verdict. */
  private blockedReason: string | null = null;

  constructor(
    readonly build: BuildInfo,
    /** False when this project is not the harness itself: the build is then never stale with
     * respect to this main, and poll is a no-op (see isSelfHosted). */
    readonly selfHosted: boolean,
    private readonly deps: RedeployDeps,
    private readonly log: (event: RedeployEvent) => void,
    /** How long to wait for in-flight ticks before aborting them (default RESTART_DRAIN_MAX_MS);
     * a test seam. */
    private readonly drainMaxMs: number = RESTART_DRAIN_MAX_MS,
  ) {}

  /** What orchestrator.json publishes (see BuildStatus). */
  status(): BuildStatus {
    const s: BuildStatus = { sha: this.build.sha, builtAt: this.build.builtAt };
    if (this.lastHead !== null && this.staleness) {
      s.stale = this.staleness.stale;
      s.aheadCommits = this.staleness.aheadCommits;
      s.checkedHead = this.lastHead;
      // Why a stale build is still the one running. Staleness alone cannot say: a restart that
      // is minutes away and one that was refused hours ago look identical, and on 2026-09-08
      // that gap is what let a blocked restart sit unnoticed while the fleet ticked on stale
      // code (BUGS.md). Mutually exclusive by construction — block() clears the pending head.
      if (this.pendingHead === this.lastHead) s.restartPending = true;
      else if (this.blockedHead === this.lastHead && this.blockedReason) s.restartBlocked = this.blockedReason;
    }
    return s;
  }

  /** Decide this poll's action. `autoRestart` is the live config flag: off keeps the staleness
   * verdict (dashboards still show it) but never drains or restarts. */
  async poll(mainHead: string, inFlight: number, autoRestart: boolean, now = Date.now()): Promise<RedeployAction> {
    if (!this.selfHosted || !mainHead) return this.endDrain();
    if (mainHead !== this.lastHead) {
      const wasStale = this.staleness?.stale ?? false;
      this.lastHead = mainHead;
      this.staleness = await this.deps.staleness(mainHead);
      const stale = this.staleness?.stale ?? false;
      if (stale && !wasStale) {
        this.log({
          loop: "harness",
          type: "build_stale",
          build: this.build.sha,
          head: mainHead,
          aheadCommits: this.staleness?.aheadCommits ?? 0,
        });
      }
      // A moved main supersedes any restart in progress for the previous head: its compile
      // (if running) finishes into its own staging dir and is simply never swapped in.
      if (this.pendingHead !== null && this.pendingHead !== mainHead) this.clearPending();
    }
    if (!this.staleness?.stale || !autoRestart || this.blockedHead === mainHead) return this.endDrain();

    if (this.pendingHead === null) {
      this.pendingHead = mainHead;
      // Only when the fleet was not already being held: a superseded head hands its drain over
      // to the new one rather than starting a fresh window (see drainSince).
      if (!this.drainSince) this.drainSince = now;
      this.green = track(this.deps.mainGreen(mainHead));
      this.compiled = null;
      return "hold";
    }
    if (!this.green?.done) return "hold";
    if (this.green.result !== true) {
      const reason = `main ${shortSha(mainHead)} is red`;
      this.block(mainHead, reason, `${reason} — holding the restart until main is green`);
      return this.endDrain();
    }
    if (!this.compiled) {
      this.compiled = track(this.deps.compile(mainHead));
      this.log({
        loop: "harness",
        type: "restart_pending",
        build: this.build.sha,
        head: mainHead,
        aheadCommits: this.staleness.aheadCommits,
      });
      return "hold";
    }
    if (!this.compiled.done) return "hold";
    const c = this.compiled.result;
    if (!c?.ok) {
      const reason = `rebuild of ${shortSha(mainHead)} failed`;
      this.block(
        mainHead,
        reason,
        `${reason} — staying on build ${shortSha(this.build.sha)}: ${c?.detail ?? this.compiled.error ?? "compile threw"}`,
      );
      return this.endDrain();
    }
    if (inFlight > 0 && now - this.drainSince < this.drainMaxMs) return "hold";
    try {
      this.deps.swap(mainHead);
    } catch (err) {
      const reason = "swapping the new build into place failed";
      this.block(mainHead, reason, `${reason}: ${err instanceof Error ? err.message : String(err)}`);
      return this.endDrain();
    }
    this.log({
      loop: "harness",
      type: "restart",
      from: this.build.sha,
      to: mainHead,
      drainedMs: now - this.drainSince,
      abortedTicks: inFlight,
    });
    return "restart";
  }

  /** Nothing is being waited for any more — the fleet schedules normally again, so whatever
   * drain was running is over and the next one starts its clock from scratch. Every path out of
   * poll that is not a `hold` goes through here. */
  private endDrain(): "none" {
    this.drainSince = 0;
    return "none";
  }

  private clearPending(): void {
    this.pendingHead = null;
    this.green = null;
    this.compiled = null;
  }

  /** Refuse the restart for `head` until main moves: `reason` is the short form status()
   * publishes, `message` the full sentence the one warning event carries. */
  private block(head: string, reason: string, message: string): void {
    this.blockedHead = head;
    this.blockedReason = reason;
    this.clearPending();
    this.log({ loop: "harness", type: "warning", message });
  }
}

/** Compile `mainHead` — checked out detached in the mirror worktree — into its staging dir with
 * the project's own tsc, then stamp it. The mirror is the compile source (not the primary
 * checkout, which may be dirty or on another branch): it holds exactly the tree main names. tsc
 * needs no node_modules of its own there — like npm's script PATH walk, its @types lookup climbs
 * ancestor node_modules, and the mirror lives under <root>/.tumwater/. The compiler itself is
 * found the same way (resolveFromNodeModules): a checkout that never ran `npm install` — every
 * tumwater worktree — still has the install of an ancestor to borrow, and demanding a local one
 * is what left the fleet unable to rebuild itself on 2026-09-08 (BUGS.md). Never throws. */
export async function compileStaged(
  root: string,
  mirrorWt: string,
  mainHead: string,
  timeoutMs = COMPILE_TIMEOUT_MS,
): Promise<{ ok: boolean; detail: string }> {
  const tsc = resolveFromNodeModules(root, path.join("typescript", "bin", "tsc"));
  if (!tsc)
    return { ok: false, detail: `typescript is not installed under node_modules at or above ${root} — cannot rebuild` };
  const staged = stagingDir(root, mainHead);
  fs.rmSync(staged, { recursive: true, force: true });
  ensureDir(staged);
  try {
    await execFileAsync(process.execPath, [tsc, "-p", mirrorWt, "--outDir", staged], {
      cwd: mirrorWt,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; code?: unknown };
    if (e.killed) return { ok: false, detail: `tsc timed out after ${timeoutMs / 1000}s` };
    const tail = clipBuildTail(`${e.stdout ?? ""}${e.stderr ?? ""}`).slice(-3).join(" | ");
    return { ok: false, detail: `tsc exited ${String(e.code)}${tail ? `: ${tail}` : ""}` };
  }
  const stamped = await stampBuild(root, staged, mainHead);
  return stamped ? { ok: true, detail: "" } : { ok: false, detail: "could not stamp the compiled build" };
}

/** Move `mainHead`'s staged build into place as `dist`: the old tree steps aside first and is
 * restored if the second rename fails, so dist/ is never left missing. The running process has
 * every module loaded already (no dynamic imports in the harness), so replacing the files under
 * it is safe; only the respawned child reads them. Other staged builds are cleaned up. */
export function swapDist(root: string, dist: string, mainHead: string): void {
  const staged = stagingDir(root, mainHead);
  if (!fs.existsSync(staged)) throw new Error(`no staged build for ${shortSha(mainHead)}`);
  const prev = path.join(stagingRootDir(root), "dist.prev");
  fs.rmSync(prev, { recursive: true, force: true });
  const hadDist = fs.existsSync(dist);
  if (hadDist) fs.renameSync(dist, prev);
  try {
    fs.renameSync(staged, dist);
  } catch (err) {
    if (hadDist) fs.renameSync(prev, dist); // Put the old build back before reporting.
    throw err;
  }
  fs.rmSync(prev, { recursive: true, force: true });
  // Superseded staged builds (heads that moved on before their swap) are dead weight.
  for (const entry of fs.readdirSync(stagingRootDir(root), { withFileTypes: true })) {
    if (entry.isDirectory()) fs.rmSync(path.join(stagingRootDir(root), entry.name), { recursive: true, force: true });
  }
}

/** Is main green at the mirror worktree's HEAD? The review gate's pre-check seeds a green
 * verdict for every merged SHA (noteGreenBaseline), so the common case is a cache hit;
 * otherwise the project's declared check runs once in the mirror. No declared check or an
 * environmental skip reads as green — the gates' warn-and-proceed policy.
 *
 * A cached RED, though, is re-verified here (checkMainBaseline's `reverifyRed`) instead of
 * being taken as given. A red verdict can belong to the worktree that produced it rather than
 * to the tree, and this gate is the one place where believing a wrong red is expensive: it
 * strands the whole fleet on a stale build with no retry until main moves. One extra suite run
 * per red head buys that, and a green from it promotes the SHA for every other gate too. */
export async function mainIsGreen(
  mirrorWt: string,
  /** Hook for the build_check event — this run is a minute of the fleet's time and belongs in
   * the feed like the role loops' own baseline checks. */
  onRun?: (run: { outcome: BuildCheckOutcome; durationMs: number }) => void,
): Promise<boolean> {
  const check = await checkMainBaseline(mirrorWt, onRun, true);
  return check.baseline ? check.baseline.status === "green" : true;
}

/** The production Redeployer for `root`, or null when the running dist carries no build stamp
 * (compiled with a bare tsc): then provenance is unknown and there is nothing to compare. */
export async function createRedeployer(
  root: string,
  log: (event: RedeployEvent) => void,
): Promise<Redeployer | null> {
  const build = readBuildInfo();
  if (!build) return null;
  const selfHosted = await isSelfHosted(root, build);
  const dist = distDir();
  // The mirror worktree — main checked out detached at the pending head — serves both the green
  // check and the compile; it is (re)pointed at each head before use.
  const mirror = async (mainHead: string) => ensureDetachedWorktree(root, mirrorWorktreePath(root), mainHead);
  const deps: RedeployDeps = {
    staleness: (mainHead) => buildStaleness(root, build.sha, mainHead),
    mainGreen: async (mainHead) =>
      mainIsGreen(await mirror(mainHead), ({ outcome, durationMs }) =>
        log({ loop: "harness", type: "build_check", scope: "baseline", status: outcome.status, script: outcome.script, durationMs }),
      ),
    compile: async (mainHead) => compileStaged(root, await mirror(mainHead), mainHead),
    swap: (mainHead) => swapDist(root, dist, mainHead),
  };
  return new Redeployer(build, selfHosted, deps, log);
}

/** The inputs whose change stales a build — re-exported so operator-facing text (doctor, the
 * stale warning) names them from one definition. */
export const STALE_INPUTS_LABEL = BUILD_INPUTS.join(", ");
