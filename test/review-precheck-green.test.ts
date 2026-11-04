/** The review gate's attribution on a main not known red: a pre-check failure that survives its
 * one re-run is judged from main's own verdict at its tip. With no verdict for main (its check
 * skipped) the failure is the change's, and the reasons say the baseline was unavailable; a
 * nameless repeat matching no recorded flake does not trust main's cached green but runs the gate
 * command fresh at the tip; and a change that fails beyond its red base's failures is rejected
 * once main's tip is green. Split from review-precheck.test.ts (a red
 * main); the other sibling slices are review-precheck-verdict.test.ts (the gate deciding
 * alone), review-precheck-closed.test.ts (a pre-check with no verdict about the tree fails
 * closed) and review-precheck-watch.test.ts (the attribution when the main watch verifies
 * main). The shared scaffolding lives in fixtures/gate-fixtures.ts and
 * fixtures/precheck-fixtures.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reviewAheadOfMain } from "../src/review/review.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { defaultConfig } from "../src/config/config.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import { createMainWatch, knownMainFailures } from "../src/baseline/main-watch.js";
import { eventsOfType, warningMessages } from "./fixtures/log-fixtures.js";
import { projManifest, writeScript } from "./fakes/fake-commands.js";
import { commitIn, mainSha, makeRepo, sh } from "./fixtures/repo-fixtures.js";
import { piRanMarker, withPi } from "./fakes/fake-pi.js";
import { gateCtx, reviewGate, ROLE } from "./fixtures/gate-fixtures.js";
import {
  buildCheckEvents,
  gateBuildFixture,
  seedGreenMain,
  uniqueMain,
} from "./fixtures/precheck-fixtures.js";

test("a pre-check that fails twice with no verdict for main rejects, saying the baseline was unavailable", async () => {
  // The configured command fails fast when change.txt is present and otherwise exits nonzero
  // matching a toolchain signature: on the change's tree the run is `boom`, and on main's clean
  // attribution worktree it dies on `/xcrun: error/`, so main's run is an environmental skip with
  // no verdict. Deterministic — no `sleep` raced against a timeout — so the two wall-clock races
  // this test once had (a deadline firing >DEADLINE_LATE_TOLERANCE_MS late on a loaded box, or a
  // stalled event loop letting `sleep 5` finish first) cannot flip it. BUGS.md 2026-10-26.
  const root = makeRepo();
  uniqueMain(root);
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(path.join(wt, "change.txt"), "change\n");
  commitIn(wt, "wip change");
  const ctx = {
    ...gateCtx(root, wt),
    config: {
      ...defaultConfig(),
      check: {
        command:
          "if [ -f change.txt ]; then echo 'boom'; exit 1; fi; echo 'xcrun: error: unable to find utility'; exit 1",
      },
    },
  };
  const marker = piRanMarker();
  await withPi(`touch '${marker}'`, async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain(ctx, state);
    assert.equal(result.decision, "rejected", "the author's failure is the safe default");
    assert.ok(!fs.existsSync(marker), "no pi run");
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /^check failed \(`.*`\): boom$/);
    assert.equal(
      reasons.at(-1),
      "main's baseline was unavailable (its check was skipped (toolchain)), so the failure is attributed to this change",
    );
    assert.deepEqual(buildCheckEvents(root), ["gate:failed", "gate:failed", "gate:skipped"]);
  });
});

// BUGS.md 2026-10-06: a nameless failure matching no recorded flake is decided by the gate
// command at main's tip, never by main's cached verdict: even a SHA seeded green is asked fresh,
// and a failing tip makes the change's failure main's too.
test("a repeat nameless failure asks the gate command at main's tip fresh, not its cached green", async () => {
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'error TS2345: boom' >&2\nexit 1\n",
  );
  seedGreenMain(root); // an earlier merge verified this SHA green; the test now fails on it
  await withPi("true", async () => {
    const state = freshRunnerState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "approved");
    assert.deepEqual(
      buildCheckEvents(root),
      ["gate:failed", "gate:failed", "gate:failed"],
      "the cached green is bypassed and the gate command runs at main's tip",
    );
  });
});

// A branch behind a fix: its base was red with X (the watch recorded it), main's tip is green now.

const FIXED_ON_MAIN_TOOL =
  "#!/bin/sh\nout=0\n[ -f x-broken.txt ] && { echo '✖ X (1ms)'; out=1; }\n[ -f y.txt ] && { echo '✖ Y (1ms)'; out=1; }\nexit $out\n";

/** The base commit has `x-broken.txt` (check fails X) and the change branches from it; main then
 * removes it and the watch records the tip green. `alsoY` makes the change fail Y too. */
async function fixedOnMainFixture(alsoY: boolean): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  writeScript(path.join(root, "node_modules", ".bin", "buildcheck-tool"), FIXED_ON_MAIN_TOOL);
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ build: "buildcheck-tool" }));
  fs.writeFileSync(path.join(root, "x-broken.txt"), "x\n");
  sh(root, "git", "add", "x-broken.txt", "package.json");
  sh(root, "git", "commit", "-m", "main breaks X");
  uniqueMain(root);
  const watch = createMainWatch(root, "main");
  watch.poll(mainSha(root), false, defaultConfig());
  await watch.idle();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(path.join(wt, "package.json"), projManifest({ build: "buildcheck-tool" }));
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  if (alsoY) fs.writeFileSync(path.join(wt, "y.txt"), "y\n");
  commitIn(wt, "wip change");
  sh(root, "git", "rm", "x-broken.txt");
  sh(root, "git", "commit", "-m", "main fixes X");
  watch.poll(mainSha(root), false, defaultConfig());
  await watch.idle();
  assert.deepEqual(knownMainFailures(root), [], "the newest verdict is green");
  return { root, wt };
}

test("a gate failure beyond the base's red failures is still rejected on a green main", async () => {
  const { root, wt } = await fixedOnMainFixture(true);
  await withPi('true', async () => {
    const { result } = await reviewGate(root, wt);
    assert.equal(result.decision, "rejected");
    assert.match(String(eventsOfType(root, "review_rejected")[0]?.reasons), /Y/);
    assert.ok(!warningMessages(root).some((m) => m.includes("already failed")));
  });
});
