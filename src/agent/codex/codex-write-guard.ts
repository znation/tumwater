/** codex's half of the write guard (src/agent/write-guard.ts holds the rule): a PreToolUse hook on
 * `apply_patch`, installed by part 6/9, refuses an `apply_patch` that writes under the team root
 * but outside the run's worktree. The entry point is write-guard-hook.ts beside this file.
 *
 * Codex's hook takes no argument naming the worktree, unlike claude's: codex trusts a hook by a
 * hash of its whole definition, so a command constant per build needs one trust lookup, while a
 * per-worktree argument would need one per slot (plans/codex-write-guard.md finding 3). The run's
 * directory is the payload's `cwd`, which is codex's session cwd and cannot be moved by a shell
 * `cd`, since every shell call is its own `zsh -lc`; with no `cwd` the hook returns null and lets
 * the patch run. */

import { fileURLToPath } from "node:url";
import { shellQuote, strayWriteRefusal } from "../write-guard.js";
import { patchWritePaths } from "./codex-patch-paths.js";

/** The tool a codex PreToolUse hook sees for file edits; anything else is not this hook's
 * business. */
const APPLY_PATCH = "apply_patch";

/** The refusal for one codex PreToolUse payload (the hook's stdin, parsed), or null to let the
 * patch run. It acts only when `tool_name` is `"apply_patch"` and `tool_input.command` is a
 * string; each path the patch writes is refused with `strayWriteRefusal(path, cwd)` in order if it
 * is under the team root but outside the worktree, a relative path resolving from `cwd` as
 * codex resolves it. A payload naming no `cwd`, or too broken to read, returns null and the patch
 * runs. */
export function codexWriteRefusal(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { tool_name: tool, tool_input: input, cwd } = payload as Record<string, unknown>;
  if (tool !== APPLY_PATCH) return null;
  if (typeof cwd !== "string" || cwd === "") return null;
  if (typeof input !== "object" || input === null) return null;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string") return null;
  for (const target of patchWritePaths(command)) {
    const refusal = strayWriteRefusal(target, cwd);
    if (refusal !== null) return refusal;
  }
  return null;
}

/** Seconds codex waits for the hook before running the tool anyway (the same timeout claude's
 * hook gets). */
const HOOK_TIMEOUT_SECONDS = 30;

/** The matcher the PreToolUse hook is registered with; codex sends only `apply_patch` here. */
const HOOK_MATCHER = "^apply_patch$";

/** `s` as a TOML basic string, escaping `\`, `"` and every control character (U+0000–U+001F
 * and DEL), so a nodeBin or hook path with any of them still round-trips through a `-c` value. */
export function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

/** The codex write guard's definition: the PreToolUse hook on `apply_patch` that runs the
 * compiled write-guard-hook.js with this process's node, falling back to `node` on PATH when
 * that binary has moved (as claude's and the notes shim do). The hook path resolves from this
 * module, so a staged build (.tumwater/build/<sha>) runs its own copy and gets its own hash. */
export function codexWriteGuardDefinition(nodeBin: string = process.execPath): {
  matcher: string;
  command: string;
  timeout: number;
} {
  const hook = fileURLToPath(new URL("./write-guard-hook.js", import.meta.url));
  const command = `n=${shellQuote(nodeBin)}; [ -x "$n" ] || n=node; exec "$n" ${shellQuote(hook)}`;
  return { matcher: HOOK_MATCHER, command, timeout: HOOK_TIMEOUT_SECONDS };
}

/** The `-c` value that installs `definition` as the session's PreToolUse hook, in codex's
 * `hooks.PreToolUse=[{matcher=…,hooks=[{type="command",command=…,timeout=…}]}]` inline-table
 * shape (finding 1). */
export function codexHookArg(definition: {
  matcher: string;
  command: string;
  timeout: number;
}): string {
  return `hooks.PreToolUse=[{matcher=${tomlString(definition.matcher)},hooks=[{type="command",command=${tomlString(definition.command)},timeout=${definition.timeout}}]}]`;
}

/** The `-c` value that trusts the hook identified by `trust.key` at `trust.hash`, in the
 * inline-table spelling `hooks.state={<key>={trusted_hash=<hash>}}`. The dotted
 * `hooks.state."<key>".trusted_hash=` spelling is ignored by codex because the key contains
 * dots (finding 2). */
export function codexHookTrustArg(trust: { key: string; hash: string }): string {
  return `hooks.state={${tomlString(trust.key)}={trusted_hash=${tomlString(trust.hash)}}}`;
}
