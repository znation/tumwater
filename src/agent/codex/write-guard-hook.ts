/** The PreToolUse hook codex runs before each `apply_patch` in a team run (part 6/9 installs it
 * through `-c`): `node write-guard-hook.js` with codex's hook payload on stdin. To block the patch
 * it prints a `deny` decision with the refusal as its reason, in the shape finding 5 showed codex
 * accepts: the model reads only the reason, so a denial by exit code would not carry it. It prints
 * nothing to let the patch run, and exits 0 either way. Any failure of its own (bad JSON, a throw)
 * prints nothing, so a broken hook lets the patch run and the stray-write warning in runner-run.ts
 * still sees a stray write. */

import fs from "node:fs";
import { codexWriteRefusal } from "./codex-write-guard.js";

let refusal: string | null = null;
try {
  refusal = codexWriteRefusal(JSON.parse(fs.readFileSync(0, "utf8")));
} catch {
  refusal = null;
}
if (refusal !== null) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refusal },
  })}\n`);
}
