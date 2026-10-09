/** The shared fixture for the two tests that pin the macOS `xcrun --find git` probe's timeout
 * bound — git-run's `resolvedGitBin` and the test runner's `suiteEnv`, both probing through
 * xcrun-git.ts's synchronous spawnSync. A wedged xcrun (an Xcode license prompt, a corrupt
 * developer directory) would block the whole event loop with no timer or watchdog able to run,
 * so each test plants a fake xcrun that never answers and asserts the probe is abandoned at its
 * timeoutMs. The fake script, the PATH override that keeps the real /usr/bin/git reachable as
 * the stub the probe guards on, and the restore/cleanup live here once instead of per test. */
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "../fixtures/repo-fixtures.js";

/** Skip condition both timeout tests carry: the probe only runs on macOS with the /usr/bin/git
 * stub present, so a fake xcrun is only meaningful there. */
export const xcrunProbeUnsupported =
  process.platform !== "darwin" || !fs.existsSync("/usr/bin/git");

/** Run `body` with a fake `xcrun` first on PATH that never answers (an `exec sleep 3`, so the
 * sleeping process is the child spawnSync's timeout kills, with no grandchild left holding the
 * capture pipe open past the kill). `git` still resolves to /usr/bin/git — no earlier PATH entry
 * holds a git. Restores PATH and removes the scratch dir afterward. */
export function withWedgedXcrun<T>(prefix: string, body: () => T): T {
  const scratch = tmpdir(prefix);
  const oldPath = process.env.PATH;
  try {
    const bin = path.join(scratch, "bin");
    fs.mkdirSync(bin);
    const fake = path.join(bin, "xcrun");
    fs.writeFileSync(fake, "#!/bin/sh\nexec sleep 3\n");
    fs.chmodSync(fake, 0o755);
    process.env.PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    return body();
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
