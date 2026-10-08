import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolvedGitBin } from "../src/git/git-run.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** The one-time macOS `xcrun --find git` probe runs through a synchronous spawnSync, so a
 * wedged xcrun blocks the whole event loop — no timer or watchdog can run. This pins the
 * bound: a fake xcrun that never answers is abandoned at `timeoutMs` and the harness falls
 * back to spawning `git` by name. Before the fix the call waited out the fake and returned
 * after it exited on its own, so the elapsed-time assertion failed. */
test(
  "a wedged xcrun cannot freeze git resolution: the probe is bounded and git falls back to its PATH name",
  { skip: process.platform !== "darwin" || !fs.existsSync("/usr/bin/git") },
  () => {
    const scratch = tmpdir("tw-xcrun-");
    const oldPath = process.env.PATH;
    try {
      const bin = path.join(scratch, "bin");
      fs.mkdirSync(bin);
      const fake = path.join(bin, "xcrun");
      // `exec` makes the sleeping process the child spawnSync's timeout kills, with no
      // grandchild left holding the capture pipe open past the kill.
      fs.writeFileSync(fake, "#!/bin/sh\nexec sleep 3\n");
      fs.chmodSync(fake, 0o755);
      // Only the fake xcrun is prepended; `git` still resolves to /usr/bin/git (the stub the
      // probe guards on) because no earlier PATH entry holds a git.
      process.env.PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
      const started = Date.now();
      const resolved = resolvedGitBin(300);
      const elapsed = Date.now() - started;
      assert.equal(resolved, "git", "an unanswered probe falls back to spawning git by name");
      assert.ok(elapsed < 1_500, `resolution took ${elapsed}ms; the probe was not bounded`);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  },
);
