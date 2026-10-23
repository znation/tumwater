/** The PreToolUse hook claude runs before each file write in a team run (claude-write-guard.ts
 * installs it through `--settings`): `node write-guard-hook.js <worktree>` with claude's hook
 * payload on stdin. To block the write it prints a `deny` decision with the refusal as its reason:
 * the model reads only the reason, where a refusal by exit 2 would also quote the whole hook
 * command. It prints nothing to let the write run. Any failure of its own lets the write run, so a
 * broken hook cannot stop every edit of a run; the stray-write warning in runner-run.ts still sees
 * a write that slips through. The stdin read and the deny-decision printing are runGuardHook's
 * (src/agent/write-guard.ts), shared with the codex PreToolUse hook; only the refusal computation
 * differs, and it needs the run's checkout, which this process receives as its first argument. */

import { runGuardHook } from "../write-guard.js";
import { claudeWriteRefusal } from "./claude-write-guard.js";

const runDir = process.argv[2];
runGuardHook((payload) => (runDir ? claudeWriteRefusal(payload, runDir) : null));
