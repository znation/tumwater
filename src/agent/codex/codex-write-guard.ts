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

import { strayWriteRefusal } from "../write-guard.js";
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
