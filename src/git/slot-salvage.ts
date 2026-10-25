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
 * runs as a handoff over it. A patch the role's branch has moved under still goes back: files
 * that conflict keep their markers, and hunks git cannot place at all reach the run as text to
 * apply by hand. Every other patch is edits a settled run chose to discard, or a verification's
 * scratch output: those stay directly under salvageDir for the operator. Session retention
 * prunes both kinds (src/orchestrator/retention.ts).
 *
 * Neither half throws work away on a git that could not start (gitCouldNotStart, the wedge's
 * EAGAIN): the salvage leaves the slot as it is and fails the lease, and the restore leaves the
 * patch waiting, so the next attempt finds everything where it was. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { warnEventBestEffort, TUMWATER_SOURCE } from "../events/events.js";
import { ensureDir, writeTextAtomic } from "../files/files.js";
import { conflictedFiles } from "../merge/merge-git.js";
import { salvageDir, salvagePendingDir } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { pad2 } from "../text/datetime.js";
import { git, gitCouldNotStart, gitTry, runGit } from "./git-run.js";
import { isUsableWorktree } from "./worktree.js";

/** The patch file's name: a sortable local timestamp, the slot's directory name and the role that
 * last held it, so a listing reads in order and names whose work each file is. */
function salvageFileName(now: Date, slotDir: string, leftBy: string | null): string {
  const stamp =
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
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
 * slot's own index is untouched. Throws only when git could not start (gitCouldNotStart), which
 * fails the lease with the slot untouched: the lease that finds git running again saves the
 * edits. Any other failure to save is logged as a warning that the edits are being discarded
 * unsaved, and the reset goes ahead, since a slot that no lease can reset would fail every role
 * the pool hands it. */
export async function salvageSlotLeftovers(
  root: string,
  dir: string,
  { leftBy, recoverFor, forRole }: SalvageParties,
  now: Date = new Date(),
): Promise<string | null> {
  const slot = path.basename(dir);
  let status: string;
  try {
    status = await git(dir, "status", "--porcelain", "--untracked-files=all");
  } catch (err) {
    if (gitCouldNotStart(err) && (await isUsableWorktree(dir))) throw err;
    return null;
  }
  if (status === "") return null;
  const files = status.split("\n").filter((line) => line.trim() !== "").length;
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
    ensureDir(home);
    // Atomic: the patch is the only copy left once the lease resets the workspace, so a kill
    // mid-write must never leave a truncated .patch that a later restore reads and partially
    // applies. Written to a temp name and renamed, a reader (restoreSalvagedWork) sees either
    // no file or the complete patch, never a prefix.
    writeTextAtomic(
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
    if (gitCouldNotStart(err)) throw err;
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

/** What restoring a salvaged patch into a checkout did: the patch's new path under salvageDir,
 * the files left with conflict markers (`<<<<<<< ours` the branch now, `>>>>>>> theirs` the saved
 * edits), and the hunks git could not place at all, per file, as diff text. */
interface RestoredWork {
  patch: string;
  conflicted: string[];
  unplaced: { path: string; diff: string }[];
}

/** Restore the newest patch of `role`'s unfinished work waiting under salvagePendingDir into `dir`,
 * the fresh checkout of the role's branch its run is about to work in, as uncommitted edits. The
 * patch applies exactly when the checkout is still at the patch's base. When the branch has moved,
 * each file goes back on its own (placeSalvagedFile): by a three-way merge, which may leave
 * conflict markers, else hunk by hunk, with the hunks that fit nowhere returned as text. The
 * result is unstaged, so the run finds the worktree an interrupted run would have kept. The
 * patch, and any older one it supersedes, then moves out to salvageDir. Returns null when
 * nothing was pending. When git could not start or the patch could not be read, the checkout is
 * put back as it was, the patch stays waiting for the role's next run, and a warning says so.
 * Never throws. */
export async function restoreSalvagedWork(root: string, role: string, dir: string): Promise<RestoredWork | null> {
  const [newest, ...older] = pendingPatches(root, role);
  if (newest === undefined) return null;
  let placed: Omit<RestoredWork, "patch">;
  try {
    placed = await applySalvage(dir, newest);
  } catch (err) {
    await gitTry(dir, "reset", "-q", "--hard");
    await gitTry(dir, "clean", "-fdq");
    warnEventBestEffort(
      root,
      role,
      `could not restore the uncommitted work an earlier run left unfinished (${errorMessage(err)}); it stays waiting at ${path.relative(root, newest)} for the next run`,
    );
    return null;
  }
  for (const file of older) settlePatch(root, file);
  return { patch: settlePatch(root, newest), ...placed };
}

/** Apply `patch` into the clean checkout `dir`: exactly when it fits, else file by file. Throws
 * only when git could not start or the patch cannot be read. */
async function applySalvage(dir: string, patch: string): Promise<Omit<RestoredWork, "patch">> {
  try {
    await git(dir, "apply", "--index", patch);
    await git(dir, "reset", "-q");
    return { conflicted: [], unplaced: [] };
  } catch (err) {
    if (gitCouldNotStart(err)) throw err;
  }
  const unplaced: RestoredWork["unplaced"] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tumwater-restore-"));
  try {
    const sections = fs.readFileSync(patch, "utf8").split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "));
    for (const [i, section] of sections.entries()) {
      const file = path.join(tmp, `${i}.patch`);
      fs.writeFileSync(file, section);
      unplaced.push(...(await placeSalvagedFile(dir, file, section)));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // Read before the reset drops the unmerged index entries; the markers stay in the files.
  const conflicted = await conflictedFiles(dir);
  await git(dir, "reset", "-q");
  return { conflicted, unplaced };
}

/** The paths one file's section of a patch touches (`git apply --numstat -z`: a rename names its
 * new path), without decoding git's quoting by hand. */
async function sectionPaths(dir: string, file: string): Promise<string[]> {
  const fields = (await git(dir, "apply", "--numstat", "-z", file)).split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const m = /^[-\d]+\t[-\d]+\t(.*)$/s.exec(fields[i]!);
    if (m === null) continue;
    if (m[1] !== "") paths.push(m[1]!);
    else if (fields[i + 2] !== undefined) {
      paths.push(fields[i + 2]!); // a rename: the empty path is followed by its old and new path
      i += 2;
    }
  }
  return paths;
}

/** Put one file's section of a salvaged patch back into `dir`: by a three-way merge, which leaves
 * conflict markers where both sides changed the same lines, else by direct application hunk by
 * hunk. Returns the hunks that fit nowhere (git's `.rej` text, read and removed so it is never
 * committed), or the whole section when git could place none of it; empty when all of it went
 * back. */
async function placeSalvagedFile(dir: string, file: string, section: string): Promise<RestoredWork["unplaced"]> {
  const paths = await sectionPaths(dir, file).catch((err: unknown) => {
    if (gitCouldNotStart(err)) throw err;
    return [];
  });
  const label = paths.join(", ") || (/^diff --git a\/(.*?) b\//.exec(section)?.[1] ?? "a file");
  if (await applied(dir, ["apply", "--3way", file])) return [];
  if (paths.length > 0 && (await git(dir, "--literal-pathspecs", "ls-files", "-u", "--", ...paths)) !== "") return [];
  // A deletion whose file the branch has already removed is done; there is nothing to hand back.
  if (/^deleted file mode /m.test(section) && paths.length > 0 && paths.every((p) => !fs.existsSync(path.join(dir, p)))) {
    return [];
  }
  if (await applied(dir, ["apply", "--reject", file])) return [];
  const rejected: RestoredWork["unplaced"] = [];
  for (const p of paths) {
    const rej = path.join(dir, `${p}.rej`);
    if (!fs.existsSync(rej)) continue;
    rejected.push({ path: p, diff: fs.readFileSync(rej, "utf8") });
    fs.rmSync(rej, { force: true });
  }
  return rejected.length > 0 ? rejected : [{ path: label, diff: section }];
}

/** Run one `git apply` and say whether it succeeded; a git that could not start throws. */
async function applied(dir: string, args: string[]): Promise<boolean> {
  try {
    await git(dir, ...args);
    return true;
  } catch (err) {
    if (gitCouldNotStart(err)) throw err;
    return false;
  }
}
