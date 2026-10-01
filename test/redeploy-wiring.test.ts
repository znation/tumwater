import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { HarnessEventInput } from "../src/events.js";
import { readBuildInfo } from "../src/build-info.js";
import { createRedeployer, redeployDeps } from "../src/redeploy.js";
import { Redeployer } from "../src/redeploy-policy.js";
import { IDLE } from "./redeploy-fixtures.js";
import { autoRestartStampPath, mirrorWorktreePath, witnessWorktreePath } from "../src/paths.js";
import { makeRepo, sh } from "./repo-fixtures.js";
import { projManifest } from "./fake-commands.js";

/** The production WIRING half of the self-redeploy tests, mirroring the src split
 * (redeploy-policy.ts / redeploy.ts): redeployDeps's real mainGreen/buildRed — the mirror
 * worktree, the live config read, the baseline build_check events, the witness-worktree
 * cold-cache recovery — and createRedeployer's composition from the running build's own stamp.
 * The policy half (the Redeployer state machine driven with scripted deps) lives in
 * redeploy.test.ts beside the other policy clusters. */

test("the production mainGreen wiring runs the real check in a fresh mirror and logs the baseline event", async () => {
  // createRedeployer's own closures never ran under test: isSelfHosted pins it to the repo the
  // running build was stamped in (a fixture never reads as self-hosted), so the unit tier drove
  // Redeployer with scripted deps while the real wiring — mirror worktree, live config read,
  // baseline build_check event — executed only inside a live daemon whose main actually moved.
  // redeployDeps is that wiring, exposed: a real repo, the real npm check, green and red alike.
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ test: "node -e 'process.exit(0)'" }),
  );
  fs.mkdirSync(path.join(root, "node_modules")); // untracked install marker detectBuildCheck walks up to
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "project");
  const greenHead = sh(root, "git", "rev-parse", "HEAD");

  const events: HarnessEventInput[] = [];
  const deps = redeployDeps(root, { sha: greenHead, builtAt: 1, root }, (e) => events.push(e), async () => null);
  assert.equal(await deps.mainGreen(greenHead), true, "a passing suite reads green");

  // A red main reads false — the verdict the restart gate blocks a swap on.
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ test: "node -e 'process.exit(1)'" }),
  );
  sh(root, "git", "commit", "-aqm", "break the suite");
  const redHead = sh(root, "git", "rev-parse", "HEAD");
  assert.equal(await deps.mainGreen(redHead), false, "a failing suite reads red");

  // Each check priced exactly one baseline build_check event through the wiring's own log —
  // the feed's record that the fleet spent this minute verifying its successor.
  const baseline = events.filter((e) => e.type === "build_check" && e.scope === "baseline");
  assert.deepEqual(
    baseline.map((e) => [e.status, e.loop, e.script]),
    [
      ["passed", "harness", "test"],
      ["failed", "harness", "test"],
    ],
  );
  // The mirror worktree the closure created is real and repointed at each asked head.
  assert.equal(
    sh(mirrorWorktreePath(root), "git", "rev-parse", "HEAD"),
    redHead,
    "the mirror sits at the head its check verified",
  );

  // The urgency carve-out's verdict source (BUGS.md 2026-09-30): the red for redHead is already
  // cached (the mainGreen call above paid for it), so buildRed answers without running anything.
  const baselineCountAfterWarm = events.filter((e) => e.type === "build_check" && e.scope === "baseline").length;
  assert.equal(await deps.buildRed(redHead), true, "a cached red verdict reads red without running anything");
  assert.equal(await deps.buildRed(greenHead), false, "a cached green verdict reads not red");
  assert.equal(
    events.filter((e) => e.type === "build_check" && e.scope === "baseline").length,
    baselineCountAfterWarm,
    "cached verdicts cost no new suite run",
  );

  // Cold-cache recovery: a third commit no check has ever seen in this process. buildRed must
  // establish the verdict from the tree itself — one suite run in the witness worktree — instead
  // of waiting for role ticks that will never baseline a SHA that is no longer main's tip.
  sh(root, "git", "commit", "-q", "--allow-empty", "-m", "another red tree, never baselined");
  const coldRedHead = sh(root, "git", "rev-parse", "HEAD");
  assert.equal(await deps.buildRed(coldRedHead), true, "a cold-cache red verdict is established by the witness check");
  assert.equal(
    sh(witnessWorktreePath(root), "git", "rev-parse", "HEAD"),
    coldRedHead,
    "the witness worktree sits at the build SHA it verified",
  );
  const baselineEvents = events.filter((e) => e.type === "build_check" && e.scope === "baseline");
  assert.equal(baselineEvents.length, baselineCountAfterWarm + 1, "exactly one new suite run — the witness check");
  assert.equal(baselineEvents[baselineEvents.length - 1]!.status, "failed");
  assert.equal(await deps.buildRed(coldRedHead), true, "the second consult reads the cache — no second run");
  assert.equal(
    events.filter((e) => e.type === "build_check" && e.scope === "baseline").length,
    baselineCountAfterWarm + 1,
    "no second suite run",
  );
});

test("createRedeployer composes the production Redeployer from the running build's own stamp", async () => {
  // The composition itself (redeploy.ts's createRedeployer) had never run under test: the unit
  // tier drove Redeployer with scripted deps while the real boot executed only inside a live
  // `tumwater run`. The stamp exists in the test process's dist (stamp-build ran before the
  // suite), so the composition is exercised here against a fixture repo — which never reads as
  // self-hosted, so the wired Redeployer proves inert while still being the production object.
  const root = makeRepo();
  const events: HarnessEventInput[] = [];
  let bootAsks = 0;
  const r = await createRedeployer(root, (e) => events.push(e), async () => {
    bootAsks += 1;
    return null;
  });
  assert.ok(r, "the running dist carries a build stamp during tests");
  assert.ok(r instanceof Redeployer, "the production class, not a test double");
  assert.equal(r.build.sha, readBuildInfo()?.sha, "the stamp read is the running build's own");
  assert.equal(r.selfHosted, false, "a fixture repo is never the build's own repo");

  // Through the real wiring, a non-self-hosted build takes no action on any main move — and
  // never asks the successor's startup gate or writes the restart record, which only a
  // restart decision touches.
  const head = sh(root, "git", "rev-parse", "HEAD");
  assert.equal(await r.poll(head, IDLE, true), "none");
  assert.equal(await r.poll(head, IDLE, true), "none", "the inert verdict is not a one-poll accident");
  assert.deepEqual(events, [], "no build_stale, no restart events");
  assert.deepEqual(
    r.status(),
    { sha: r.build.sha, builtAt: r.build.builtAt },
    "no staleness verdict is ever computed for a foreign repo",
  );
  assert.equal(bootAsks, 0, "the successor's startup gate is asked only on a restart decision");
  assert.ok(!fs.existsSync(autoRestartStampPath(root)), "the restart record is only written by an actual restart");
});

test("buildRed with no declared check answers unknown (null), not not-red", async () => {
  // The urgency carve-out's third verdict: a repo whose check detection finds nothing gives
  // the baseline no verdict at all. The caller must read null as "cannot decide" — reading it
  // as false ("main is green") would drop a red-build deferral on a project whose checks are
  // simply undeclared, restarting onto a build nobody ever verified.
  const root = makeRepo(); // no package.json, no declared check anywhere
  const events: HarnessEventInput[] = [];
  const deps = redeployDeps(root, { sha: "stale", builtAt: 1, root }, (e) => events.push(e), async () => null);
  const head = sh(root, "git", "rev-parse", "HEAD");
  assert.equal(await deps.buildRed(head), null, "no check means no verdict, not a green one");
  assert.deepEqual(events, [], "a null verdict costs no suite run and logs no build_check");
});
