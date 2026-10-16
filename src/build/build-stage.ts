// vocabulary: plain
import fs from "node:fs";
import path from "node:path";
import { distDir, stampBuild } from "./build-info.js";
import { clipBuildTail } from "./build-check-report.js";
import { resolveFromNodeModules } from "./build-check-detect.js";
import { ensureDir, removeTree } from "../files/files.js";
import { stagingDir, stagingRootDir } from "../paths.js";
import { execFileAsync } from "../process/process.js";
import { warnEvent, warnEventBestEffort } from "../events/events.js";
import { errorMessage } from "../text/text.js";
import { shortSha } from "../text/format.js";

/** Producing and swapping the compiled tree behind a self-redeploy (redeploy.ts): compile a
 * head's mirror checkout into a staging dir under .tumwater/build, then move that tree into
 * place as dist/. The redeploy state machine decides WHEN this happens (red main, cooldown,
 * drain, block); this module owns HOW — the filesystem mechanics — so the scheduler's policy
 * reads without the staging and rename detail. Split out of redeploy.ts for that reason. */

/** Hard cap on one compile of the harness; tsc on this codebase takes well under a minute. */
const COMPILE_TIMEOUT_MS = 5 * 60_000;

/** How old a superseded staged build may get before a later compile deletes it. A completed
 * compile stays consumable for one episode's tail — the drain hold is capped at
 * RESTART_DRAIN_MAX_MS (30 min) — so anything older than this grace cannot be swapped by any
 * live episode and is pure disk: a fleet whose restarts stay blocked (red main, a failing boot
 * gate) recompiles every new head it lands, and without a prune each landed commit left a full
 * staged tree behind until the NEXT successful swap cleaned them all up — ~750 MB across one
 * busy day (observed 2026-09-30: 128 staged builds, none swapped). A successful swap already
 * wipes every staging; this bounds the accumulation between swaps. */
export const STAGED_PRUNE_AFTER_MS = 45 * 60_000;

/** Delete staged builds other than `keep` that no live episode can still swap: directories
 * named for a head (40-hex SHA) whose mtime is older than STAGED_PRUNE_AFTER_MS. Everything
 * else under the staging root — dist.prev mid-swap, any non-SHA scratch — stays for swapDist's
 * own cleanup, and anything younger than the grace survives however the episode bookkeeping
 * turns out. Best-effort: a vanished entry or an unreadable stat only skips that entry, and a
 * failed deletion is left for the next compile or swap to retry — pruning must never turn a
 * good compile into a failed one. Returns how many stagings were removed. */
export function pruneStaleStagings(root: string, keep: string, now = Date.now()): number {
  const stagingRoot = stagingRootDir(root);
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stagingRoot, { withFileTypes: true });
  } catch {
    return 0; // No staging root yet (first compile) — nothing to prune.
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{40}$/.test(entry.name)) continue;
    const dir = path.join(stagingRoot, entry.name);
    if (dir === keep) continue;
    try {
      if (now - fs.statSync(dir).mtimeMs < STAGED_PRUNE_AFTER_MS) continue;
    } catch {
      continue; // Vanished (or unreadable) mid-scan — nothing to decide about it.
    }
    try {
      removeTree(dir);
      removed += 1;
    } catch {
      // Left for the next compile or swap: dead weight one tick longer is fine.
    }
  }
  return removed;
}

/** The outcome of one compile attempt. `rejected` marks a compile that produced no compiler
 * verdict — a missing toolchain, a spawn failure (ENOENT and friends), or a tsc that died by
 * signal: a rejection is not a verdict about the tree, so callers must not latch it the way a
 * real compiler exit is latched (BUGS.md 2026-09-28). */
export interface CompileResult {
  ok: boolean;
  detail: string;
  rejected?: boolean;
}

/** A compile rejection: no compiler verdict, only the environment's failure to produce one.
 * The single home of the `{ ok: false, rejected: true }` shape shared by the four rejection
 * sites (the missing toolchain, the primary spawn failing, the shebang fallback failing, and
 * a tsc killed by signal), so the flag callers must not latch is set in one place. */
function rejectedCompile(detail: string): CompileResult {
  return { ok: false, rejected: true, detail };
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
  /** Test seam: the node binary the primary spawn runs tsc under. Production always uses
   * process.execPath; a test injects a stale path to reproduce an interpreter an upgrade
   * removed from under the running build. */
  execPath: string = process.execPath,
): Promise<CompileResult> {
  const tsc = resolveFromNodeModules(root, path.join("typescript", "bin", "tsc"));
  if (!tsc)
    return rejectedCompile(`typescript is not installed under node_modules at or above ${root} — cannot rebuild`);
  const staged = stagingDir(root, mainHead);
  removeTree(staged);
  ensureDir(staged);
  // Primary spawn: node <tsc> … (execPath + the script as its first argument). Fallback spawn:
  // tsc … directly — the script's shebang resolves a live node through PATH.
  const tscArgs = ["-p", mirrorWt, "--outDir", staged];
  const args = [tsc, ...tscArgs];
  const opts = { cwd: mirrorWt, timeout: timeoutMs };
  try {
    await execFileAsync(execPath, args, opts);
  } catch (err) {
    const verdict = tscVerdict(err, timeoutMs);
    if (verdict) return verdict;
    // The spawn itself never produced a process. Name every input that did not exist at
    // failure time — with no child output, that existence check is the only evidence the
    // error carries, and it is what turns the next live `tsc exited ENOENT` (BUGS.md
    // 2026-09-29) into a diagnosis instead of a mystery.
    const missing = missingSpawnInputs(execPath, mirrorWt, tsc);
    // The one spawn failure a retry can beat: the running build's own node binary vanished
    // under it (an upgrade while the fleet stays up leaves process.execPath naming a file that
    // no longer exists, while every PATH-resolved spawn — git, npm, pi — keeps working). tsc's
    // own shebang resolves a live node through PATH at spawn time, so run it directly.
    if (fs.existsSync(execPath) || !fs.existsSync(mirrorWt))
      return rejectedCompile(`could not start the compile: ${errorMessage(err)}${missing}`);
    try {
      await execFileAsync(tsc, tscArgs, opts);
    } catch (fallbackErr) {
      const verdict = tscVerdict(fallbackErr, timeoutMs);
      if (verdict) return verdict;
      return rejectedCompile(
        `could not start the compile: ${errorMessage(err)}${missing}` +
          `; the shebang fallback also failed: ${errorMessage(fallbackErr)}`,
      );
    }
  }
  const stamped = await stampBuild(root, staged, mainHead);
  if (stamped) pruneStaleStagings(root, staged); // Superseded stagings die with the new build's success.
  return stamped ? { ok: true, detail: "" } : { ok: false, detail: "could not stamp the compiled update" };
}

/** Classify one failed compile spawn into its terminal CompileResult, or null when the error
 * carries no exit at all — a spawn failure the caller still has to diagnose. Shared by the
 * primary and shebang-fallback spawns so the two classification ladders cannot drift: a
 * numeric exit code is the one shape that is a verdict about the tree (tsc ran and chose it),
 * so latching anything else as a verdict pins the fleet on the stale build even after the
 * environment recovers (BUGS.md 2026-09-28), and misclassifying a real exit as a rejection
 * makes the redeployer drop a genuinely failing head and re-attempt it forever instead of
 * blocking on it (review objection 2026-09-29). A timeout (killed) and a death by signal are
 * the other two outcomes that say something; a string code (ENOENT and friends, whatever
 * output rode the error object with it) and a null code fall through as no-verdict
 * rejections. */
function tscVerdict(err: unknown, timeoutMs: number): CompileResult | null {
  const e = err as { stdout?: string; stderr?: string; killed?: boolean; code?: unknown; signal?: unknown };
  if (e.killed) return { ok: false, detail: `tsc timed out after ${timeoutMs / 1000}s` };
  const tail = clipBuildTail(`${e.stdout ?? ""}${e.stderr ?? ""}`).slice(-3).join(" | ");
  if (typeof e.code === "number")
    return { ok: false, detail: `tsc exited ${String(e.code)}${tail ? `: ${tail}` : ""}` };
  if (e.signal)
    return rejectedCompile(
      `tsc died by signal ${String(e.signal)} — no compiler verdict${tail ? `: ${tail}` : ""}`,
    );
  return null;
}

/** Which of the compile spawn's inputs did not exist at failure time: the interpreter, the
 * working directory, the toolchain. A spawn failure's child leaves no output of its own, so
 * this existence check is the only evidence the error carries — it is what turns the next
 * live `tsc exited ENOENT` into a diagnosis instead of a mystery (BUGS.md 2026-09-29). */
function missingSpawnInputs(execPath: string, cwd: string, tsc: string): string {
  const missing: string[] = [];
  if (!fs.existsSync(execPath)) missing.push(`the node binary at ${execPath}`);
  if (!fs.existsSync(cwd)) missing.push(`the compile cwd at ${cwd}`);
  if (!fs.existsSync(tsc)) missing.push(`tsc at ${tsc}`);
  return missing.length > 0 ? ` (missing: ${missing.join("; ")})` : "";
}

/** Move `mainHead`'s staged build into place as `dist`: the old tree steps aside first and is
 * restored if the second rename fails, so dist/ is never left missing. The running process has
 * every module loaded already (no dynamic imports in the harness), so replacing the files under
 * it is safe; only the respawned child reads them. Other staged builds are cleaned up. */
export function swapDist(root: string, dist: string, mainHead: string): void {
  const staged = stagingDir(root, mainHead);
  if (!fs.existsSync(staged)) throw new Error(`no staged update for ${shortSha(mainHead)}`);
  const prev = path.join(stagingRootDir(root), "dist.prev");
  removeTree(prev);
  const hadDist = fs.existsSync(dist);
  if (hadDist) fs.renameSync(dist, prev);
  try {
    fs.renameSync(staged, dist);
  } catch (err) {
    if (hadDist) {
      try {
        fs.renameSync(prev, dist); // Put the old build back before reporting.
      } catch (restoreErr) {
        // A restore failure leaves dist/ MISSING — the operator must hear that plus where
        // the old build sits, not just the raw ENOENT/ENOSPC of whichever rename lost.
        throw new Error(
          `could not restore the previous dist after a failed update swap for ${shortSha(mainHead)}` +
            `: ${errorMessage(err)}; dist is missing and the old update is preserved at ${prev}` +
            ` (restore failed: ${errorMessage(restoreErr)})`,
        );
      }
    }
    // The raw error alone ("ENOTDIR", "EACCES") never says which move failed or which
    // staged build was lost: name the head and the dist path the swap was serving.
    throw new Error(
      `could not move the staged update for ${shortSha(mainHead)} into ${dist}: ${errorMessage(err)}`,
    );
  }
  // The swap is committed: the rename above put the new build at dist/. Everything below is
  // cleanup of superseded trees — the old build stepped aside at dist.prev, and the stagings
  // of heads that moved on before their own swap. It is dead weight a later swap or compile
  // collects, so a removal that fails (a directory surviving removeTree's retries, an
  // unreadable staging root) must not be reported as a failed swap: the redeployer would
  // block the restart while dist/ already holds the new build, leaving the fleet running the
  // old code under a misleading `restart BLOCKED: swapping the new build into place failed`.
  // Warn and continue, the same best-effort policy pruneStaleStagings applies so pruning
  // never fails the work it follows.
  removeSupersededQuiet(root, prev);
  sweepSupersededStagings(root);
}

/** Restore dist/ after a swap that died between its two renames: `swapDist` moves the old
 * build aside to `dist.prev` and then moves the staged build into `dist`, and a process killed
 * (SIGKILL — the OOM killer) in that microsecond window leaves `dist` missing. Nothing in the
 * swap can close the window, because the survivor is the supervisor and it exits on the dead
 * generation; the next `tumwater run` then cannot even load `dist/src/cli.js` and fails with
 * MODULE_NOT_FOUND, so the repo is wedged until someone renames `dist.prev` back by hand. The
 * supervisor calls this before it exits (src/cli/cli-run.ts, via superviseRun's onDone): while
 * it is still up, it renames the preserved old build back into place so the next boot works.
 *
 * Only acts when `dist` is missing and a `dist.prev` exists — both conditions together are the
 * interrupted swap. A completed swap leaves a live `dist` (prev is swept later), and a swap
 * that failed and restored also leaves one, so neither is touched. Throws when the restore
 * rename itself fails — the caller reports it, and `dist` stays missing for a hand fix —
 * never leaves a half-restored tree. Returns whether it restored. */
export function recoverInterruptedSwap(root: string, dist: string): boolean {
  const prev = path.join(stagingRootDir(root), "dist.prev");
  if (fs.existsSync(dist) || !fs.existsSync(prev)) return false;
  fs.renameSync(prev, dist); // Atomic: dist is either the restored old build or still missing.
  return true;
}

/** The supervisor's end-of-supervision repair (src/cli/cli-run.ts wires this into
 * superviseRun's onDone): recover dist/ after an interrupted swap and, either way, put the
 * outcome on the event feed. Kept beside recoverInterruptedSwap so the CLI wiring is one call.
 * cli-run.ts imports this module statically, so the code is in memory before a swap can move
 * dist/ away — recovering via an import at call time would fail ERR_MODULE_NOT_FOUND exactly
 * when it is needed, the window this closes. `dist` defaults to this process's own dist
 * (build-info.distDir, a pure path computation captured at load), overridable so a test can
 * point it at a temp root. A failed restore is reported, never thrown: the hook runs on the
 * way out and must not change the supervisor's exit code. */
export function repairInterruptedSwap(root: string, dist = distDir()): void {
  try {
    if (recoverInterruptedSwap(root, dist))
      warnEventBestEffort(root, "harness", "an interrupted update swap left dist/ missing — restored it from .tumwater/build/dist.prev"); // vocabulary-ok: event source stays "harness" until the event log rename
  } catch (err) {
    warnEventBestEffort(
      root,
      "harness", // vocabulary-ok: event source stays "harness" until the event log rename
      `dist/ is missing after an interrupted update swap and could not be restored from .tumwater/build/dist.prev: ${errorMessage(err)}`,
    );
  }
}

/** Remove one post-swap leftover tree, warning instead of throwing: the swap is already
 * committed, so a failure here is dead weight for a later pass, not a failed swap. */
function removeSupersededQuiet(root: string, dir: string): void {
  try {
    removeTree(dir);
  } catch (err) {
    warnCleanup(root, `could not remove superseded update tree ${dir}: ${errorMessage(err)}`);
  }
}

/** Best-effort sweep of the staging root after a successful swap: every directory left there
 * is a superseded staging. An unreadable root or a directory that will not remove is warned
 * and skipped, never thrown (see the caller). */
function sweepSupersededStagings(root: string): void {
  const stagingRoot = stagingRootDir(root);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stagingRoot, { withFileTypes: true });
  } catch (err) {
    warnCleanup(root, `could not list staged builds under ${stagingRoot}: ${errorMessage(err)}`);
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) removeSupersededQuiet(root, path.join(stagingRoot, entry.name));
  }
}

/** Log a post-swap cleanup failure without letting the warning itself fail the swap: if the
 * event log is unwritable too, the new dist/ is already in place and stays the outcome. */
function warnCleanup(root: string, message: string): void {
  try {
    warnEvent(root, "harness", message); // vocabulary-ok: event source stays "harness" until the event log rename
  } catch {
    // Cleanup must not throw; the swap already succeeded.
  }
}
