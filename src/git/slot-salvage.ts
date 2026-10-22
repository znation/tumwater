/** Saving what a pooled slot still holds before it is reset for another lease, and handing a
 * role's unfinished work back to its next run. A run the harness could not clean up after
 * (killed, or its own git calls failing, as every spawn did during the 2026-10-21 process-table
 * wedge) can release its slot with uncommitted edits still in it. The next lease resets the slot
 * to main, which used to fail on those edits for every role it was handed ("Your local changes …
 * would be overwritten by checkout"), and a role branch's forced checkout dropped them without a
 * trace. The reset now always succeeds (worktree.ts checks out with --force), so this is the step
 * that keeps the work: the edits become a patch and a warning names the slot, the role that left
 * them and the file.
 *
 * A patch whose run gave its slot up unsettled (the slot record's `unsettledRun`: an exception
 * escaped the run, or its process died holding the lease) waits under salvagePendingDir until
 * that role's next run, which restores it into its fresh checkout (restoreSalvagedWork) and
 * runs as a handoff over it. Every other patch is edits a settled run chose to discard, or a
 * verification's scratch output: those stay directly under salvageDir for the operator. Session
 * retention prunes both kinds (src/orchestrator/retention.ts). */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { salvageDir, salvagePendingDir } from "../paths.js";
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

/** Who a salvage is about: the slot's last holder (`leftBy`), the role whose unsettled run the
 * leftovers are (`recoverFor`, or null when they are not work to hand back) and the role whose
 * lease is about to reset the slot (`forRole`). */
interface SalvageParties {
  leftBy: string | null;
  recoverFor: string | null;
  forRole: string;
}

/** Save the uncommitted changes in `dir` (modified, deleted and untracked files, ignored ones
 * excepted) as a patch against its HEAD, and log a warning naming the slot, the role that left
 * them and the file, before `forRole`'s lease resets it. The patch waits for `recoverFor`'s next
 * run under salvagePendingDir when it is set, and is kept directly under salvageDir otherwise.
 * Returns the patch path, or null when there was nothing to save or `dir` is not a worktree git
 * can read (a slot about to be recreated). The patch is built through a temporary index, so the
 * slot's own index is untouched. Never throws: a salvage that fails is logged as a warning that
 * the edits are being discarded unsaved, and the reset goes ahead, since a slot that no lease
 * can reset would fail every role the pool hands it. */
export async function salvageSlotLeftovers(
  root: string,
  dir: string,
  { leftBy, recoverFor, forRole }: SalvageParties,
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
    const home = recoverFor === null ? salvageDir(root) : salvagePendingDir(root, recoverFor);
    const file = path.join(home, salvageFileName(now, dir, leftBy));
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      file,
      `# ${files} uncommitted file(s) ${by} left in workspace ${slot}, saved before ${forRole} reused it\n` +
        `# base ${base}; apply with: git apply --index <this file> on a checkout of that commit\n` +
        `${patch}\n`,
    );
    const saved = path.relative(root, file);
    warnEventBestEffort(
      root,
      TUMWATER_SOURCE,
      recoverFor === null
        ? `workspace ${slot} still held ${files} uncommitted file(s) ${by} left behind; saved them to ${saved} and reset it for ${forRole}`
        : `workspace ${slot} still held ${files} uncommitted file(s) from ${recoverFor}'s unfinished run; saved them to ${saved} for its next run and reset it for ${forRole}`,
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

/** The patches waiting for `role`'s next run, newest first (the timestamped names sort in time
 * order). Empty when none wait or the directory cannot be read. */
function pendingPatches(root: string, role: string): string[] {
  const dir = salvagePendingDir(root, role);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".patch"))
    .sort()
    .reverse()
    .map((name) => path.join(dir, name));
}

/** Move a pending patch out to salvageDir, where it is kept for the operator until retention
 * prunes it, and return its new path (the old one when the move fails, so the warning that
 * names it still points at the file). */
function settlePatch(root: string, file: string): string {
  const kept = path.join(salvageDir(root), path.basename(file));
  try {
    fs.renameSync(file, kept);
    return kept;
  } catch {
    return file;
  }
}

/** Restore the newest patch of `role`'s unfinished work waiting under salvagePendingDir into `dir`,
 * the fresh checkout of the role's branch its run is about to work in, as uncommitted edits. The
 * patch applies exactly when the checkout is still at the patch's base, or by a three-way merge
 * when the branch has moved, and the result is unstaged, so the run finds the worktree an
 * interrupted run would have kept. Returns the restored patch's path, now moved out to
 * salvageDir (older pending patches, superseded by it, move out with it); null when nothing was
 * pending or the restore failed. A patch that does not apply cleanly moves out with a warning
 * naming it, and `dir` is put back as it was, so the run starts fresh. Never throws. */
export async function restoreSalvagedWork(root: string, role: string, dir: string): Promise<string | null> {
  const [newest, ...older] = pendingPatches(root, role);
  if (newest === undefined) return null;
  for (const file of older) settlePatch(root, file);
  try {
    try {
      await git(dir, "apply", "--index", newest);
    } catch {
      await git(dir, "apply", "--3way", newest);
    }
    await git(dir, "reset", "-q");
    return settlePatch(root, newest);
  } catch (err) {
    await gitTry(dir, "reset", "-q", "--hard");
    await gitTry(dir, "clean", "-fdq");
    const kept = path.relative(root, settlePatch(root, newest));
    warnEventBestEffort(
      root,
      role,
      `could not restore the uncommitted work an earlier run left unfinished from ${kept} (${errorMessage(err)}); this run starts fresh, and the patch is kept`,
    );
    return null;
  }
}
