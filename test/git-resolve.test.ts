import test from "node:test";
import assert from "node:assert/strict";
import { resolvedGitBin } from "../src/git/git-run.js";
import { withWedgedXcrun, xcrunProbeUnsupported } from "./helpers/wedged-xcrun.js";

/** The one-time macOS `xcrun --find git` probe runs through a synchronous spawnSync, so a
 * wedged xcrun blocks the whole event loop — no timer or watchdog can run. This pins the
 * bound: a fake xcrun that never answers is abandoned at `timeoutMs` and the harness falls
 * back to spawning `git` by name. Before the fix the call waited out the fake and returned
 * after it exited on its own, so the elapsed-time assertion failed. */
test(
  "a wedged xcrun cannot freeze git resolution: the probe is bounded and git falls back to its PATH name",
  { skip: xcrunProbeUnsupported },
  () => {
    withWedgedXcrun("tw-xcrun-", () => {
      const started = Date.now();
      const resolved = resolvedGitBin(300);
      const elapsed = Date.now() - started;
      assert.equal(resolved, "git", "an unanswered probe falls back to spawning git by name");
      assert.ok(elapsed < 1_500, `resolution took ${elapsed}ms; the probe was not bounded`);
    });
  },
);
