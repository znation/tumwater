import fs from "node:fs";
import path from "node:path";
import { stampBuild } from "./build-info.js";
import { clipBuildTail } from "./build-check-report.js";
import { resolveFromNodeModules } from "./build-check-detect.js";
import { ensureDir, removeTree } from "./files.js";
import { stagingDir, stagingRootDir } from "./paths.js";
import { execFileAsync } from "./process.js";
import { errorMessage, shortSha } from "./text.js";

/** Producing and swapping the compiled tree behind a self-redeploy (redeploy.ts): compile a
 * head's mirror checkout into a staging dir under .tumwater/build, then move that tree into
 * place as dist/. The redeploy state machine decides WHEN this happens (red main, cooldown,
 * drain, block); this module owns HOW — the filesystem mechanics — so the scheduler's policy
 * reads without the staging and rename detail. Split out of redeploy.ts for that reason. */

/** Hard cap on one compile of the harness; tsc on this codebase takes well under a minute. */
const COMPILE_TIMEOUT_MS = 5 * 60_000;

/** The outcome of one compile attempt. `rejected` marks a compile that never ran — a missing
 * toolchain or a spawn failure (ENOENT and friends): a rejection is not a verdict about the
 * tree, so callers must not latch it the way a real compiler exit is latched (BUGS.md
 * 2026-09-28). */
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
  try {
    await execFileAsync(process.execPath, [tsc, "-p", mirrorWt, "--outDir", staged], {
      cwd: mirrorWt,
      timeout: timeoutMs,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; code?: unknown };
    if (e.killed) return { ok: false, detail: `tsc timed out after ${timeoutMs / 1000}s` };
    const tail = clipBuildTail(`${e.stdout ?? ""}${e.stderr ?? ""}`).slice(-3).join(" | ");
    // Distinguish "tsc ran and failed" (a numeric exit code, or output to explain it) from "tsc
    // never ran" (a spawn failure: ENOENT for the executable or the cwd, with nothing on either
    // stream). The former is a verdict about the tree; the latter is a rejection — naming the
    // commit as the thing that failed tells the operator nothing, and latching it pins the
    // fleet on the stale build even after the environment recovers (BUGS.md 2026-09-28).
    if (typeof e.code !== "number" && !tail)
      return { ok: false, rejected: true, detail: `could not start the compile: ${errorMessage(err)}` };
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
