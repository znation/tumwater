import fs from "node:fs";
import path from "node:path";
import { stampBuild } from "./build-info.js";
import { clipBuildTail } from "./build-check/build-check-report.js";
import { resolveFromNodeModules } from "./build-check/build-check-detect.js";
import { ensureDir, removeTree } from "./files.js";
import { stagingDir, stagingRootDir } from "./paths.js";
import { execFileAsync } from "./process/process.js";
import { errorMessage } from "./text.js";
import { shortSha } from "./format.js";

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
    return {
      ok: false,
      rejected: true,
      detail: `typescript is not installed under node_modules at or above ${root} — cannot rebuild`,
    };
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
      return {
        ok: false,
        rejected: true,
        detail: `could not start the compile: ${errorMessage(err)}${missing}`,
      };
    try {
      await execFileAsync(tsc, tscArgs, opts);
    } catch (fallbackErr) {
      const verdict = tscVerdict(fallbackErr, timeoutMs);
      if (verdict) return verdict;
      return {
        ok: false,
        rejected: true,
        detail:
          `could not start the compile: ${errorMessage(err)}${missing}` +
          `; the shebang fallback also failed: ${errorMessage(fallbackErr)}`,
      };
    }
  }
  const stamped = await stampBuild(root, staged, mainHead);
  if (stamped) pruneStaleStagings(root, staged); // Superseded stagings die with the new build's success.
  return stamped ? { ok: true, detail: "" } : { ok: false, detail: "could not stamp the compiled build" };
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
    return {
      ok: false,
      rejected: true,
      detail: `tsc died by signal ${String(e.signal)} — no compiler verdict${tail ? `: ${tail}` : ""}`,
    };
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
  if (!fs.existsSync(staged)) throw new Error(`no staged build for ${shortSha(mainHead)}`);
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
          `could not restore the previous dist after a failed build swap for ${shortSha(mainHead)}` +
            `: ${errorMessage(err)}; dist is missing and the old build is preserved at ${prev}` +
            ` (restore failed: ${errorMessage(restoreErr)})`,
        );
      }
    }
    // The raw error alone ("ENOTDIR", "EACCES") never says which move failed or which
    // staged build was lost: name the head and the dist path the swap was serving.
    throw new Error(
      `could not move the staged build for ${shortSha(mainHead)} into ${dist}: ${errorMessage(err)}`,
    );
  }
  removeTree(prev);
  // Superseded staged builds (heads that moved on before their swap) are dead weight.
  for (const entry of fs.readdirSync(stagingRootDir(root), { withFileTypes: true })) {
    if (entry.isDirectory()) removeTree(path.join(stagingRootDir(root), entry.name));
  }
}
