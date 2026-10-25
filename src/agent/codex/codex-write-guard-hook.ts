/** The PreToolUse hook codex runs before each `apply_patch` in a team run (part 6/9 installs it
 * through `-c`): `node codex-write-guard-hook.js` with codex's hook payload on stdin. To block
 * the patch
 * it prints a `deny` decision with the refusal as its reason, in the shape finding 5 showed codex
 * accepts: the model reads only the reason, so a denial by exit code would not carry it. It prints
 * nothing to let the patch run, and exits 0 either way. Any failure of its own (bad JSON, a throw)
 * prints nothing, so a broken hook lets the patch run and the stray-write warning in runner-run.ts
 * still sees a stray write. The stdin read and the deny-decision printing are runGuardHook's
 * (src/agent/write-guard.ts), shared with the claude PreToolUse hook; only the refusal computation
 * differs. */

import { runGuardHook } from "../write-guard.js";
import { codexWriteRefusal } from "./codex-write-guard.js";

runGuardHook((payload) => codexWriteRefusal(payload));
