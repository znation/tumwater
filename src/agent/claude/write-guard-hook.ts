/** The PreToolUse hook claude runs before each file write in a team run (claude-write-guard.ts
 * installs it through `--settings`): `node write-guard-hook.js <worktree>` with claude's hook
 * payload on stdin. To block the write it prints a `deny` decision with the refusal as its reason:
 * the model reads only the reason, where a refusal by exit 2 would also quote the whole hook
 * command. It prints nothing to let the write run. Any failure of its own lets the write run, so a
 * broken hook cannot stop every edit of a run; the stray-write warning in runner-run.ts still sees
 * a write that slips through. */

import fs from "node:fs";
import { claudeWriteRefusal } from "./claude-write-guard.js";

let refusal: string | null = null;
try {
  const runDir = process.argv[2];
  if (runDir) refusal = claudeWriteRefusal(JSON.parse(fs.readFileSync(0, "utf8")), runDir);
} catch {
  refusal = null;
}
if (refusal !== null) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refusal },
  })}\n`);
}
