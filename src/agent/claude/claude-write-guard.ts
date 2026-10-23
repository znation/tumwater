/** claude's half of the write guard (src/agent/write-guard.ts holds the rule): a PreToolUse hook on
 * the file-writing tools, passed to each run through `--settings`, refuses a write under the team
 * root but outside the run's worktree.
 *
 * Hooks run under `--permission-mode bypassPermissions` too, and a hook's `deny` decision blocks
 * the call and hands its reason to the model (checked live with claude 2.1.295 on 2026-10-23).
 * `--setting-sources project` leaves the operator's own hooks out of a run, while `--settings`
 * still loads this one. The hook gets the run's worktree as an argument rather than reading
 * claude's `cwd`, which follows the Bash tool's `cd` into subdirectories. The entry point is
 * write-guard-hook.ts beside this file. */

import { fileURLToPath } from "node:url";
import { strayWriteRefusal } from "../write-guard.js";

/** claude's file-writing tools a team run has: claude-args.ts's `--tools` allows only these two,
 * and `--tools` is a reserved flag, so no passthrough can add another. */
const WRITE_TOOLS = ["Edit", "Write"] as const;

/** Seconds claude waits for the hook before running the tool anyway. */
const HOOK_TIMEOUT_SECONDS = 30;

/** `s` single-quoted for sh. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `--settings` value for a run in `cwd`: one PreToolUse hook on the file-writing tools that
 * runs the compiled write-guard-hook.js with this process's node, falling back to `node` on PATH
 * when that binary has moved (as the notes shim does), and the run's worktree as its argument. The
 * hook path resolves from this module, so a staged build (.tumwater/build/<sha>) runs its own
 * copy. */
export function writeGuardSettings(cwd: string, nodeBin: string = process.execPath): string {
  const hook = fileURLToPath(new URL("./write-guard-hook.js", import.meta.url));
  const command = `n=${shellQuote(nodeBin)}; [ -x "$n" ] || n=node; exec "$n" ${shellQuote(hook)} ${shellQuote(cwd)}`;
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: WRITE_TOOLS.join("|"), hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] },
      ],
    },
  });
}

/** The refusal for one PreToolUse payload (claude's hook stdin, parsed) from a run in `runDir`, or
 * null to let the call run. A relative path resolves from the payload's `cwd`, where claude's
 * tools would resolve it. */
export function claudeWriteRefusal(payload: unknown, runDir: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { tool_name: tool, tool_input: input, cwd } = payload as Record<string, unknown>;
  if (typeof tool !== "string" || !(WRITE_TOOLS as readonly string[]).includes(tool)) return null;
  if (typeof input !== "object" || input === null) return null;
  const target = (input as Record<string, unknown>).file_path;
  if (typeof target !== "string" || target === "") return null;
  return strayWriteRefusal(target, runDir, typeof cwd === "string" && cwd !== "" ? cwd : runDir);
}
