/** The one macOS `xcrun --find git` probe, shared by the harness's git-binary resolution
 * (git-run.ts's `resolvedGitBin`) and the test runner's suite environment (test/test-runner.ts's
 * `suiteEnv`). Both need the same synchronous `spawnSync` — with a SIGKILL-bound timeout, so a
 * wedged xcrun (an Xcode license prompt, a corrupt developer directory) cannot block the event
 * loop — and the same definition of a usable answer, so the bound and the validation rule cannot
 * drift between them. Node built-ins only; each caller owns its platform/`/usr/bin/git`-stub
 * guard and the timeout it passes. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The absolute real git an `xcrun --find git` probe names, or null when the probe does not
 * answer within `timeoutMs` or names anything but a different, existing binary. The timeout is a
 * parameter so a test can drive it down against a fake wedged xcrun; production callers pass
 * their own default. Takes no cache — a caller that wants one (resolvedGitBin) keeps it. */
export function realGitFromXcrun(timeoutMs: number): string | null {
  const found = spawnSync("xcrun", ["--find", "git"], {
    encoding: "utf8",
    timeout: timeoutMs,
    // SIGKILL: the bound must hold even for a probe that traps SIGTERM.
    killSignal: "SIGKILL",
  });
  const real = found.status === 0 ? found.stdout.trim() : "";
  return real && path.isAbsolute(real) && real !== "/usr/bin/git" && fs.existsSync(real) ? real : null;
}
