import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { HarnessEventInput } from "../src/events/events.js";
import { readBuildInfo } from "../src/build/build-info.js";
import { createRedeployer, redeployDeps } from "../src/redeploy/redeploy.js";
import { Redeployer } from "../src/redeploy/redeployer.js";
import { IDLE } from "./redeploy-fixtures.js";
import { autoRestartStampPath, mirrorWorktreePath, witnessWorktreePath } from "../src/paths.js";
import { makeRepo, sh } from "./fixtures/repo-fixtures.js";
import { projManifest } from "./fakes/fake-commands.js";

/** The production WIRING half of the self-redeploy tests, mirroring the src split
 * (src/redeploy/redeployer.ts / src/redeploy/redeploy.ts): redeployDeps's real mainGreen/buildRed — the mirror
 * worktree, the live config read, the baseline build_check events, the witness-worktree
 * cold-cache recovery — and createRedeployer's composition from the running build's own stamp.
 * The state-machine half (the Redeployer driven with scripted deps) lives in
 * redeployer.test.ts beside the other state-machine clusters; the policy knobs it decides
 * with are in src/redeploy/redeploy-policy.ts. */

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
  // establish the verdict from the tree itself — a witness check plus its confirmation re-run
  // (the gate's flake rule, BUGS.md 2026-09-30) — instead of waiting for role ticks that will
  // never baseline a SHA that is no longer main's tip.
  sh(root, "git", "commit", "-q", "--allow-empty", "-m", "another red tree, never baselined");
  const coldRedHead = sh(root, "git", "rev-parse", "HEAD");
  assert.equal(
    await deps.buildRed(coldRedHead),
    true,
    "a cold-cache red verdict is established by the witness check and survives its confirmation re-run",
  );
  assert.equal(
    sh(witnessWorktreePath(root), "git", "rev-parse", "HEAD"),
    coldRedHead,
    "the witness worktree sits at the build SHA it verified",
  );
  const baselineEvents = events.filter((e) => e.type === "build_check" && e.scope === "baseline");
  assert.equal(
    baselineEvents.length,
    baselineCountAfterWarm + 2,
    "a cold red pays the witness check plus its confirmation re-run",
  );
  assert.deepEqual(
    baselineEvents.slice(-2).map((e) => e.status),
    ["failed", "failed"],
    "both runs failed: the red was real, not a flake",
  );
  assert.equal(await deps.buildRed(coldRedHead), true, "the second consult reads the cache — no second run");
  assert.equal(
    events.filter((e) => e.type === "build_check" && e.scope === "baseline").length,
    baselineCountAfterWarm + 2,
    "no further suite run",
  );

  // A witness red that does not reproduce on the immediate re-run is a flake, not a red tree
  // (BUGS.md 2026-09-30): one suite run failing 1 of 2,458 tests must not cut a 12 h cooldown
  // to 15 min. The script fails its first run and passes every later one — exactly the
  // load-flake shape the gate's rule exists for.
  const failOnce = "node -e 'const fs=require(\"fs\"),p=\".flake-marker\";if(fs.existsSync(p))process.exit(0);fs.writeFileSync(p,\"x\");process.exit(1)'";
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: failOnce }));
  sh(root, "git", "commit", "-aqm", "a suite that fails once, then passes");
  const flakeHead = sh(root, "git", "rev-parse", "HEAD");
  assert.equal(
    await deps.buildRed(flakeHead),
    false,
    "a red that passes its confirmation re-run reads not red — the ordinary cooldown stands",
  );
  const flakeEvents = events.filter((e) => e.type === "build_check" && e.scope === "baseline").slice(-2);
  assert.deepEqual(flakeEvents.map((e) => e.status), ["failed", "passed"], "the re-run reproduced nothing");
  // The re-run's green promoted the SHA in the fleet-shared cache: later consults stay free.
  assert.equal(await deps.buildRed(flakeHead), false, "the promoted green answers the second consult");
  assert.equal(
    events.filter((e) => e.type === "build_check" && e.scope === "baseline").length,
    baselineCountAfterWarm + 4,
    "the flake head cost exactly its two runs",
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

test("the staleness, compile, and swap closures drive the real mechanics in a fixture repo", async () => {
  // The other wiring here covers mainGreen and buildRed; these three are the rest of
  // redeployDeps and none had ever run under test: staleness decides a restart is due at all,
  // compile stages the successor build, and swap moves it into dist — a swapped argument or a
  // lost mirror in any of them would silently break or misfire the self-redeploy. A fixture
  // drives each closure for real: git reads, a detached mirror worktree, the staged-compile
  // resolution, and the swap's own guard.
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: "node -e 'process.exit(0)'" }));
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "project");
  const buildSha = sh(root, "git", "rev-parse", "HEAD");
  const deps = redeployDeps(root, { sha: buildSha, builtAt: 1, root }, () => {}, async () => null);

  // A build sitting at main's head is fresh. A commit touching none of the build inputs
  // leaves it fresh too — the inputs filter is the difference between redeploying on every
  // docs commit and redeploying only when the code moved.
  assert.deepEqual(await deps.staleness(buildSha), { stale: false, aheadCommits: 0 });
  fs.writeFileSync(path.join(root, "NOTES.md"), "docs only\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "docs");
  const docsHead = sh(root, "git", "rev-parse", "HEAD");
  assert.deepEqual(await deps.staleness(docsHead), { stale: false, aheadCommits: 1 });

  // One package.json commit later the same closure reads stale with the ahead count the
  // dashboards publish.
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: "node -e 'process.exit(1)'" }));
  sh(root, "git", "commit", "-aqm", "move main");
  const newHead = sh(root, "git", "rev-parse", "HEAD");
  assert.deepEqual(await deps.staleness(newHead), { stale: true, aheadCommits: 2 });

  // A sha that is no commit of this repo reads null — the "not our build" verdict isSelfHosted
  // also answers, so a foreign sha can never order a restart.
  assert.equal(await deps.staleness("f".repeat(40)), null);

  // The compile closure serves its compile from the mirror worktree, repointed at the asked
  // head. The fixture installs no typescript at or above itself, so the staged compile rejects
  // without running tsc — the same verdict a real mirror without an install gets — but the
  // mirror it built for the attempt is real and sits exactly where main points.
  const compiled = await deps.compile(newHead);
  assert.equal(compiled.ok, false, "a fixture without typescript cannot stage a build");
  assert.match(compiled.detail, /typescript is not installed/);
  assert.equal(
    sh(mirrorWorktreePath(root), "git", "rev-parse", "HEAD"),
    newHead,
    "the compile's mirror sits at the head it was to compile",
  );

  // The swap guard fires through the closure too: with nothing staged for the head it names
  // the head rather than leaking a bare ENOENT from the rename below it.
  assert.throws(() => deps.swap(newHead), /no staged build for/);
});
