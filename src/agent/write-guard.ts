/** The write guard on a run's file-editing tools: pi's `edit`/`write` (src/pi-extension/
 * write-guard.ts), claude's `Edit`/`Write` (src/agent/claude/claude-write-guard-hook.ts) and
 * OpenCode's
 * `edit` permission (src/agent/opencode/write-guard-plugin/index.ts) refuse a write that would
 * land under the team root but outside the run's own checkout.
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
 * covered: a shell command's writes cannot be read from its text. The codex backend is not
 * covered yet.
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

/** `p` with its symlinks resolved as the file it reaches: each component is peeled and a
 * symlink is followed to its target, so a symlinked checkout or a `/tmp` that is `/private/tmp`
 * compares as the path it reaches. The not-yet-existing tail (a file a write would create) is
 * appended unchanged. A broken symlink — target absent, the write/create case, where
 * `realpathSync` throws ENOENT and the old longest-existing-prefix walk read the link as its
 * own location inside the checkout — is followed to its target instead: the write would follow
 * it, so the guard must see where it points. */
function realish(p: string): string {
  // Peel the path component by component, exactly as `realpath` does: a regular component is
  // kept, a symlink is replaced by the components its target resolves to, and the first absent
  // component ends the walk, so a not-yet-existing tail is appended unchanged. Replacing the
  // link with its target — instead of keeping the link's own path — is what catches a broken
  // symlink: its target is absent (the write/create case, where `realpathSync` throws ENOENT
  // and the old longest-existing-prefix walk read the link as its location inside the
  // checkout), yet the write would still follow it, so the guard must see where it points. A
  // depth bound stops a symlink cycle (a → b → a) from looping instead of escaping through the
  // tail.
  let q = path.resolve(p).split(path.sep).filter(Boolean);
  const out: string[] = [];
  let depth = 0;
  while (q.length > 0) {
    const part = q[0] as string; // the loop's length check guarantees a first component
    const here = path.join(path.sep, ...out, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(here);
    } catch {
      out.push(part, ...q.slice(1)); // absent: this and the rest are the not-yet-existing tail
      break;
    }
    if (!st.isSymbolicLink()) {
      out.push(part);
      q = q.slice(1);
    } else if (depth++ > 100) {
      out.push(part, ...q.slice(1)); // cycle: give up rather than loop
      break;
    } else {
      let raw: string;
      try {
        raw = fs.readlinkSync(here); // a relative target is relative to the link's dir
      } catch {
        out.push(part, ...q.slice(1)); // unreadable: treat as the not-yet-existing tail
        break;
      }
      // The target, absolute-resolved, becomes the whole remaining path to peel: the link's
      // own directory is dropped and replaced by wherever the link points.
      const target = path.isAbsolute(raw) ? raw : path.resolve(path.join(path.sep, ...out), raw);
      q = [...target.split(path.sep).filter(Boolean), ...q.slice(1)];
      out.length = 0;
    }
  }
  return path.join(path.sep, ...out);
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

/** `s` single-quoted for sh (the `'…'` quoting every hook command in both backends embeds a path
 * in). The one home of a POSIX-shell single-quote, shared by the claude and codex write-guard
 * settings builders (src/agent/claude/claude-write-guard.ts, src/agent/codex/codex-write-guard.ts)
 * so the escape cannot drift between the backends. A path with a single quote becomes
 * `'…'\''…'`, which sh assembles back into the original. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The shell command that runs `nodeBin`, falling back to PATH's `node` when the recorded binary
 * has moved (a node upgrade under the running team — BUGS.md 2026-10-21), then execs each
 * `command` arg in turn. The one home of the recorded-node-then-PATH fallback the claude and codex
 * write-guard hook commands (claude-write-guard.ts, codex-write-guard.ts) and the notes shim
 * (notes-shim.ts) each re-spelled, so the fallback and its quoting cannot drift between them. The
 * `[ -x "$n" ]` check answers at run time, so a shim or hook command written before an upgrade
 * still survives it. */
export function nodeFallbackExec(nodeBin: string, ...command: string[]): string {
  return `n=${shellQuote(nodeBin)}; [ -x "$n" ] || n=node; exec "$n" ${command.map(shellQuote).join(" ")}`;
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

/** The stdin-driven guard-hook driver shared by the claude and codex PreToolUse hooks
 * (src/agent/claude/claude-write-guard-hook.ts, src/agent/codex/codex-write-guard-hook.ts). Each
 * hook runs as `node claude-write-guard-hook.js` / `node codex-write-guard-hook.js` with the
 * backend's hook payload JSON on stdin; this reads it in one
 * place, asks `computeRefusal` for a refusal string (null lets the edit/patch run), and prints the
 * `deny` decision only when there is a refusal. Any failure — unreadable stdin, malformed JSON, a
 * throw — reads as "no refusal" (null), so a broken hook cannot stop every edit of a run; the
 * stray-write warning in runner-run.ts still sees a write that slips through. The deny payload's
 * shape (`hookSpecificOutput` with a `PreToolUse` deny and the refusal as its reason) lives only
 * here so the two hooks cannot drift it apart. */
export function runGuardHook(computeRefusal: (payload: unknown) => string | null): void {
  let refusal: string | null = null;
  try {
    refusal = computeRefusal(JSON.parse(fs.readFileSync(0, "utf8")));
  } catch {
    refusal = null;
  }
  if (refusal !== null) {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refusal },
    })}\n`);
  }
}

