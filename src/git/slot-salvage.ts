/** Saving what a pooled slot still holds before it is reset for another lease. A run the harness
 * could not clean up after (killed, or its own git calls failing, as every spawn did during the
 * 2026-10-21 process-table wedge) can release its slot with uncommitted edits still in it. The
 * next lease resets the slot to main, which used to fail on those edits for every role it was
 * handed ("Your local changes … would be overwritten by checkout"), and a role branch's forced
 * checkout dropped them without a trace. The reset now always succeeds (worktree.ts checks out
 * with --force), so this is the step that keeps the work: the edits become a patch under
 * `.tumwater/salvage/` and a warning names the slot, the role that left them and the file. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { salvageDir } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { git, gitTry, runGit } from "./git-run.js";

/** The patch file's name: a sortable local timestamp, the slot's directory name and the role that
 * last held it, so a listing reads in order and names whose work each file is. */
function salvageFileName(now: Date, slotDir: string, leftBy: string | null): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${path.basename(slotDir)}-${leftBy ?? "unknown"}.patch`;
}

/** Save the uncommitted changes in `dir` (modified, deleted and untracked files, ignored ones
 * excepted) as a patch against its HEAD under salvageDir, and log a warning naming the slot, the
 * role that left them (`leftBy`, the slot's last holder) and the file, before `forRole`'s lease
 * resets it. Returns the patch path, or null when there was nothing to save or `dir` is not a
 * worktree git can read (a slot about to be recreated). The patch is built through a temporary
 * index, so the slot's own index is untouched. Never throws: a salvage that fails is logged as
 * a warning that the edits are being discarded unsaved, and the reset goes ahead, since a slot
 * that no lease can reset would fail every role the pool hands it. */
export async function salvageSlotLeftovers(
  root: string,
  dir: string,
  leftBy: string | null,
  forRole: string,
  now: Date = new Date(),
): Promise<string | null> {
  const status = await gitTry(dir, "status", "--porcelain", "--untracked-files=all");
  if (!status) return null;
  const files = status.split("\n").filter((line) => line.trim() !== "").length;
  const slot = path.basename(dir);
  const by = leftBy ?? "an unknown role";
  let tmp: string | undefined;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tumwater-salvage-"));
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    await runGit(dir, ["read-tree", "HEAD"], env);
    await runGit(dir, ["add", "-A"], env);
    const patch = await runGit(dir, ["diff", "--cached", "--binary", "HEAD"], env);
    if (patch === "") return null;
    const base = await git(dir, "rev-parse", "HEAD");
    const file = path.join(salvageDir(root), salvageFileName(now, dir, leftBy));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `# ${files} uncommitted file(s) ${by} left in workspace ${slot}, saved before ${forRole} reused it\n` +
        `# base ${base}; apply with: git apply --index <this file> on a checkout of that commit\n` +
        `${patch}\n`,
    );
    warnEventBestEffort(
      root,
      TUMWATER_SOURCE,
      `workspace ${slot} still held ${files} uncommitted file(s) ${by} left behind; saved them to ${path.relative(root, file)} and reset it for ${forRole}`,
    );
    return file;
  } catch (err) {
    warnEventBestEffort(
      root,
      TUMWATER_SOURCE,
      `workspace ${slot} still held ${files} uncommitted file(s) ${by} left behind, and saving them failed (${errorMessage(err)}); resetting it for ${forRole} discards them`,
    );
    return null;
  } finally {
    if (tmp !== undefined) fs.rmSync(tmp, { recursive: true, force: true });
  }
}
