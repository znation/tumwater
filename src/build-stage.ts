import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { stampBuild } from "./build-info.js";
import { clipBuildTail } from "./build-check.js";
import { resolveFromNodeModules } from "./build-check-detect.js";
import { ensureDir, removeTree } from "./files.js";
import { stagingDir, stagingRootDir } from "./paths.js";
import { shortSha } from "./text.js";

/** Producing and swapping the compiled tree behind a self-redeploy (redeploy.ts): compile a
 * head's mirror checkout into a staging dir under .tumwater/build, then move that tree into
 * place as dist/. The redeploy state machine decides WHEN this happens (red main, cooldown,
 * drain, block); this module owns HOW — the filesystem mechanics — so the scheduler's policy
 * reads without the staging and rename detail. Split out of redeploy.ts for that reason. */

const execFileAsync = promisify(execFile);

/** Hard cap on one compile of the harness; tsc on this codebase takes well under a minute. */
const COMPILE_TIMEOUT_MS = 5 * 60_000;

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
  removeTree(staged);
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
  removeTree(prev);
  const hadDist = fs.existsSync(dist);
  if (hadDist) fs.renameSync(dist, prev);
  try {
    fs.renameSync(staged, dist);
  } catch (err) {
    if (hadDist) fs.renameSync(prev, dist); // Put the old build back before reporting.
    throw err;
  }
  removeTree(prev);
  // Superseded staged builds (heads that moved on before their swap) are dead weight.
  for (const entry of fs.readdirSync(stagingRootDir(root), { withFileTypes: true })) {
    if (entry.isDirectory()) removeTree(path.join(stagingRootDir(root), entry.name));
  }
}
