/** The write guard on a run's file-editing tools: pi's `edit`/`write` (src/pi-extension/
 * write-guard.ts) and claude's `Edit`/`Write` (src/agent/claude/write-guard-hook.ts) refuse a
 * write that would land under the team root but outside the run's own checkout.
 *
 * Why a guard and not only the prompt rule: every run's checkout sits inside the primary checkout
 * (`<root>/.tumwater/worktrees/<name>`). An absolute path that drops that infix, or a relative one
 * that climbs out with `../../..`, names a real file with the same contents in the primary
 * checkout or in another run's slot, so the edit succeeds and nothing says it went astray. The run
 * then commits its unchanged checkout. runner-run.ts's stray-write warning only notices afterwards
 * and cannot say which run wrote. Refusing at the tool lets the model retry at the path the
 * refusal names.
 *
 * Writes outside the team root (scratch files under `$TMPDIR`, `/tmp`) are not this guard's
 * business and pass, as does every write from a run that is not in a team worktree. Bash is not
 * covered: a shell command's writes cannot be read from its text.
 *
 * Pure apart from realpath lookups, so the rule is testable without pi or claude. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { roleNotesPath, STATE_DIR, worktreesDir } from "../paths.js";

/** A run's checkout and the team root it sits in. */
interface RunCheckout {
  root: string;
  checkout: string;
}

/** True when `p` is `dir` or inside it. Both are absolute and normalized. */
function isWithin(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** `p` with its longest existing prefix resolved through realpath, so a symlink, a `/tmp` that is
 * `/private/tmp`, or a path typed in the wrong case on a case-insensitive disk compares as the
 * file it reaches. The part that does not exist yet (a file a write would create) is appended
 * unchanged. */
function realish(p: string): string {
  let existing = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return p;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** A tool's path argument as pi's tools resolve it (pi `resolveToCwd`): a leading `@` dropped,
 * `~` expanded to the home directory, and a relative path taken from `base`. */
function resolveToolPath(target: string, base: string): string {
  let p = target.startsWith("@") ? target.slice(1) : target;
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(base, p);
}

/** The team checkout `dir` is in, or null when it is in none. Read from the path's shape: the
 * innermost `<root>/.tumwater/worktrees/<name>` that holds `dir`. The nearest ancestor holding a
 * `.tumwater` directory would not do, because a run's own tests can leave one inside its checkout
 * (one sat in `_slot-3` on 2026-10-23), and then the primary checkout would read as outside the
 * team and every write to it would pass. */
function runCheckoutOf(dir: string): RunCheckout | null {
  const real = realish(path.resolve(dir));
  const marker = `${path.sep}${STATE_DIR}${path.sep}worktrees${path.sep}`;
  const at = real.lastIndexOf(marker);
  if (at < 0) return null;
  const root = real.slice(0, at) || path.sep;
  const name = real.slice(at + marker.length).split(path.sep)[0];
  if (!name) return null;
  return { root, checkout: path.join(worktreesDir(root), name) };
}

/** The refusal text for a write to `target` from a run whose checkout holds `runDir`, or null when
 * the write may go ahead. A relative `target` resolves from `resolveFrom` (default `runDir`): pi
 * resolves from the run's directory, while claude resolves from its shell's current directory,
 * which the hook receives separately. The text names the corrected path inside the checkout
 * whenever the stray path has a twin there. */
export function strayWriteRefusal(target: string, runDir: string, resolveFrom: string = runDir): string | null {
  const run = runCheckoutOf(runDir);
  if (!run) return null;
  const abs = realish(resolveToolPath(target, resolveFrom));
  if (isWithin(abs, run.checkout) || !isWithin(abs, run.root)) return null;
  const { root, checkout } = run;
  let where: string;
  let rest: string[] = [];
  let instead: string | null = null;
  if (isWithin(abs, worktreesDir(root))) {
    const [other, ...inside] = path.relative(worktreesDir(root), abs).split(path.sep);
    where = `another checkout (${other ?? ""})`;
    rest = inside;
  } else if (isWithin(abs, path.join(root, STATE_DIR))) {
    where = "tumwater's own state";
    if (isWithin(abs, path.dirname(roleNotesPath(root, "role")))) {
      instead = "Save role notes with `tumwater-notes write` instead.";
    }
  } else {
    where = "the primary checkout";
    rest = path.relative(root, abs).split(path.sep).filter(Boolean);
    // The worktree borrows the primary's dependencies; a twin path would create a node_modules
    // inside the worktree and break that borrowing.
    if (rest[0] === "node_modules") rest = [];
  }
  if (rest.length > 0) {
    instead = `Write ${path.join(checkout, ...rest)} instead: your worktree has the same files.`;
  }
  return `Refused: ${abs} is in ${where}, outside this run's worktree ${checkout}. Only changes `
    + `inside the worktree are committed, so this write would be lost. `
    + (instead ?? "Leave it alone and work only inside the worktree.");
}
