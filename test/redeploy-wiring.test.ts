import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HarnessEventInput } from "../src/events/events.js";
import { readBuildInfo } from "../src/build/build-info.js";
import { createRedeployer, redeployDeps } from "../src/redeploy/redeploy.js";
import { checkMainBaseline, noteGreenBaseline, watchVerifiesMain } from "../src/baseline/main-baseline.js";
import { redeployTarget } from "../src/redeploy/redeploy-target.js";
import { Redeployer } from "../src/redeploy/redeployer.js";
import { IDLE } from "./fixtures/redeploy-fixtures.js";
import { autoRestartStampPath, mirrorWorktreePath, witnessWorktreePath } from "../src/paths.js";
import { defaultConfig } from "../src/config/config.js";
import { headSha, makeRepo, pinnedCommit, sh } from "./fixtures/repo-fixtures.js";
import { projManifest } from "./fakes/fake-commands.js";

/** The production WIRING half of the self-redeploy tests, mirroring the src split
 * (src/redeploy/redeployer.ts / src/redeploy/redeploy.ts): redeployDeps's real mainGreen/buildRed
 * — the mirror
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
  const greenHead = headSha(root);

  const events: HarnessEventInput[] = [];
  const deps = redeployDeps(root, { sha: greenHead, builtAt: 1, root }, (e) => events.push(e), async () => null);
  assert.equal(await deps.mainGreen(greenHead), true, "a passing suite reads green");

  // A red main reads false — the verdict the restart gate blocks a swap on.
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ test: "node -e 'process.exit(1)'" }),
  );
  sh(root, "git", "commit", "-aqm", "break the suite");
  const redHead = headSha(root);
  assert.equal(await deps.mainGreen(redHead), false, "a failing suite reads red");

  // Each check priced exactly one baseline build_check event through the wiring's own log —
  // the feed's record that the team spent this minute verifying its successor.
  const baseline = events.filter((e) => e.type === "build_check" && e.scope === "baseline");
  assert.deepEqual(
    baseline.map((e) => [e.status, e.source, e.script]),
    [
      ["passed", "tumwater", "test"],
      ["failed", "tumwater", "test"],
    ],
  );
  // The mirror worktree the closure created is real and repointed at each asked head.
  assert.equal(
    headSha(mirrorWorktreePath(root)),
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
  // (the gate's flake rule, BUGS.md 2026-09-30) — instead of waiting for role runs that will
  // never baseline a SHA that is no longer main's tip.
  sh(root, "git", "commit", "-q", "--allow-empty", "-m", "another red tree, never baselined");
  const coldRedHead = headSha(root);
  assert.equal(
    await deps.buildRed(coldRedHead),
    true,
    "a cold-cache red verdict is established by the witness check and survives its confirmation re-run",
  );
  assert.equal(
    headSha(witnessWorktreePath(root)),
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
  // (BUGS.md 2026-09-30): one suite run failing 1 of 2,458 tests must not cut the ordinary cooldown
  // to 15 min. The script fails its first run and passes every later one — exactly the
  // load-flake shape the gate's rule exists for.
  const failOnce = "node -e 'const fs=require(\"fs\"),p=\".flake-marker\";if(fs.existsSync(p))process.exit(0);fs.writeFileSync(p,\"x\");process.exit(1)'";
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: failOnce }));
  sh(root, "git", "commit", "-aqm", "a suite that fails once, then passes");
  const flakeHead = headSha(root);
  assert.equal(
    await deps.buildRed(flakeHead),
    false,
    "a red that passes its confirmation re-run reads not red — the ordinary cooldown stands",
  );
  const flakeEvents = events.filter((e) => e.type === "build_check" && e.scope === "baseline").slice(-2);
  assert.deepEqual(flakeEvents.map((e) => e.status), ["failed", "passed"], "the re-run reproduced nothing");
  // The re-run's green promoted the SHA in the team-shared cache: later consults stay free.
  assert.equal(await deps.buildRed(flakeHead), false, "the promoted green answers the second consult");
  assert.equal(
    events.filter((e) => e.type === "build_check" && e.scope === "baseline").length,
    baselineCountAfterWarm + 4,
    "the flake head cost exactly its two runs",
  );
});

test("an unwritable event feed cannot reject the green check it reports on", async (t) => {
  // The green check's onRun hook calls the redeploy wiring's log (logEvent); before the fix that
  // throw propagated out of checkMainBaseline's run hook and rejected the whole check, so the
  // redeployer read a green main as "could not run" and re-ran the suite every poll instead of
  // redeploying. The verdict must not depend on a best-effort event write.
  const root = makeRepo();
  // A manifest byte-identical to the previous test's would give this commit the SAME sha
  // (git ids hash tree+author+committer+timestamp+message, and two fixtures committed
  // inside the same second under the suite's fixed identity collide — CI hit exactly
  // that: the prior test's cached green answered this consult without running, so no
  // onRun fired and the stderr assertion saw nothing). A distinct name keeps the sha
  // unique so this consult always runs for real.
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "unwritable-feed-probe", version: "1.0.0", scripts: { test: "node -e 'process.exit(0)'" } }),
  );
  fs.mkdirSync(path.join(root, "node_modules"));
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "unwritable feed probe");
  const head = headSha(root);

  const errWrites: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    errWrites.push(String(chunk));
    return true;
  });
  const deps = redeployDeps(
    root,
    { sha: head, builtAt: 1, root },
    () => {
      throw new Error("EISDIR: illegal operation on a directory, open '.tumwater/log/events.jsonl'");
    },
    async () => null,
  );
  assert.equal(
    await deps.mainGreen(head),
    true,
    "the check's green verdict stands even though its event could not be written",
  );
  assert.match(
    errWrites.join(""),
    /could not record build_check event: EISDIR/,
    "the swallowed write failure stays loud on stderr",
  );
});

test("createRedeployer composes the production Redeployer from the running build's own stamp", async () => {
  // The composition itself (redeploy.ts's createRedeployer) had never run under test: the unit
  // tier drove Redeployer with scripted deps while the real boot executed only inside a live
  // `tumwater start`. The stamp exists in the test process's dist (stamp-build ran before the
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
  const head = headSha(root);
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
  const head = headSha(root);
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
  const buildSha = headSha(root);
  const deps = redeployDeps(root, { sha: buildSha, builtAt: 1, root }, () => {}, async () => null);

  // A build sitting at main's head is fresh. A commit touching none of the build inputs
  // leaves it fresh too — the inputs filter is the difference between redeploying on every
  // docs commit and redeploying only when the code moved.
  assert.deepEqual(await deps.staleness(buildSha), { stale: false, aheadCommits: 0 });
  fs.writeFileSync(path.join(root, "NOTES.md"), "docs only\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "docs");
  const docsHead = headSha(root);
  assert.deepEqual(await deps.staleness(docsHead), { stale: false, aheadCommits: 1 });

  // One package.json commit later the same closure reads stale with the ahead count the
  // dashboards publish.
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: "node -e 'process.exit(1)'" }));
  sh(root, "git", "commit", "-aqm", "move main");
  const newHead = headSha(root);
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
    headSha(mirrorWorktreePath(root)),
    newHead,
    "the compile's mirror sits at the head it was to compile",
  );

  // The swap guard fires through the closure too: with nothing staged for the head it names
  // the head rather than leaking a bare ENOENT from the rename below it.
  assert.throws(() => deps.swap(newHead), /no staged update for/);
});

test("redeployTarget picks main's newest green commit newer than the running build, never a red or unverified-green one", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: "node -e 'process.exit(0)'" }));
  fs.mkdirSync(path.join(root, "node_modules"));
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "A");
  const a = headSha(root);
  fs.writeFileSync(path.join(root, "b.txt"), "b");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "B");
  const b = headSha(root);
  noteGreenBaseline(b);
  const deps = redeployDeps(root, { sha: a, builtAt: 1, root }, () => {}, async () => null);

  // Running A, main A -> B (green): the green tip deploys as today.
  assert.equal(await redeployTarget(root, b, a), b);

  // A -> B (green) -> C (red): the target falls back to B.
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: "node -e 'process.exit(1)'" }));
  sh(root, "git", "commit", "-aqm", "C");
  const c = headSha(root);
  assert.equal(await redeployTarget(root, c, a), c, "an unchecked tip is the target (the redeployer checks it)");
  assert.equal(await deps.mainGreen(c), false);
  assert.equal(await redeployTarget(root, c, a), b, "a red tip falls back to the newest green");

  // Running B, main B -> C (red): nothing newer is green, so the red tip stays the target and
  // the redeployer blocks that commit alone.
  assert.equal(await redeployTarget(root, c, b), c);
});

test("redeployTarget never targets an older commit that no check has called green", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: "node -e 'process.exit(1)'" }));
  fs.mkdirSync(path.join(root, "node_modules"));
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "A");
  const a = headSha(root);
  fs.writeFileSync(path.join(root, "b.txt"), "b");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "B (no verdict)");
  const b = headSha(root);
  fs.writeFileSync(path.join(root, "c.txt"), "c");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "C");
  const c = headSha(root);
  const deps = redeployDeps(root, { sha: a, builtAt: 1, root }, () => {}, async () => null);
  assert.equal(await deps.mainGreen(c), false);
  assert.equal(await redeployTarget(root, c, a), c, "B has no verdict, so it is not a fallback");
  assert.notEqual(b, c);
});

test("redeployTarget keeps the tip when the build is not a first-parent ancestor of it", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: "node -e 'process.exit(0)'" }));
  fs.mkdirSync(path.join(root, "node_modules"));
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "A");
  const a = headSha(root);
  fs.writeFileSync(path.join(root, "b.txt"), "b");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "B");
  const b = headSha(root);
  noteGreenBaseline(b);
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: "node -e 'process.exit(1)'" }));
  sh(root, "git", "commit", "-aqm", "C");
  const c = headSha(root);
  const deps = redeployDeps(root, { sha: a, builtAt: 1, root }, () => {}, async () => null);
  assert.equal(await deps.mainGreen(c), false);
  assert.equal(await redeployTarget(root, c, "f".repeat(40)), c, "an unknown build is no bound for a fallback");
});

test("redeployTarget un-watched re-verifies a red another worktree observed instead of falling back on it", async () => {
  // The un-watched red fallback is pinned above only for a red the redeployer's OWN mirror
  // observed (red.redFrom contains mirrorWorktreePath). The sibling case — a red the gate or the
  // main watch observed in its own worktree, so red.redFrom names that OTHER path, not the mirror
  // — was never exercised: this is the one redeployTarget branch all existing tests miss. The
  // doc contract says such a red "may be another worktree's environmental one", so the un-watched
  // branch keeps the tip as the target and the redeployer re-verifies it in its own mirror, never
  // falling back to an older green on the strength of a foreign worktree's red.
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: "node -e 'process.exit(0)'" }));
  fs.mkdirSync(path.join(root, "node_modules"));
  pinnedCommit(root, "re-verify build, no verdict");
  const a = headSha(root);

  // A sibling directory (outside `root`) so root's own `git add -A` never treats the nested
  // worktree as an embedded repo; and never the mirror's `_main`. Both matter: the foreign
  // redFrom must be a path mirrorWorktreePath(root) does not equal.
  const other = path.join(path.dirname(root), "other-rv");
  sh(root, "git", "worktree", "add", "-q", "-b", "tumwater/reverify-other", other, "main");
  fs.mkdirSync(path.join(other, "node_modules"));
  fs.writeFileSync(path.join(root, "b.txt"), "b");
  pinnedCommit(root, "re-verify green above the build");
  const b = headSha(root);
  noteGreenBaseline(b);
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: "node -e 'process.exit(1)'" }));
  pinnedCommit(root, "re-verify red tip");
  const c = headSha(root);
  sh(other, "git", "reset", "--hard", "main"); // the other worktree now sees the red tip

  // Observe (not author) the red from `other`: the cached verdict's redFrom names `other`, never
  // the redeployer's `_main` mirror.
  const result = await checkMainBaseline(other, defaultConfig());
  assert.equal(result.baseline?.status, "red", "the check in the other worktree records a red");

  // Running build A on main A -> B (green) -> C (red from another worktree): a fallback on the
  // strength of that foreign red would return B (newest green above the build). The non-mirror
  // branch instead re-verifies the tip in its own mirror, so the correct target is C itself —
  // this assertion is what fails if the branch ever starts trusting another worktree's red.
  assert.notEqual(b, c);
  assert.equal(await redeployTarget(root, c, a), c, "another worktree's red is re-verified, never a fallback anchor");
});

test("redeployTarget in watch mode targets the newest cached green and never an unchecked tip", async () => {
  const root = makeRepo();
  // A manifest whose test script fails, so any check that actually ran on the unchecked tip
  // would turn up red — a watched target must never run it.
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: "node -e 'process.exit(1)'" }));
  fs.mkdirSync(path.join(root, "node_modules"));
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "A");
  const a = headSha(root);
  fs.writeFileSync(path.join(root, "b.txt"), "b");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "B");
  const b = headSha(root);
  noteGreenBaseline(b);
  fs.writeFileSync(path.join(root, "c.txt"), "c");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "C");
  const c = headSha(root);
  const deps = redeployDeps(root, { sha: a, builtAt: 1, root }, () => {}, async () => null);

  // Running A, main A -> B (cached green) -> C (no verdict): watched targets B, never the
  // unchecked tip — the failing manifest would have turned any run red.
  assert.equal(await redeployTarget(root, c, a, true), b, "the newest cached green is the target");

  // With C cached red, watched still targets B — a cached red is walked past, never targeted.
  assert.equal(await deps.mainGreen(c), false);
  assert.equal(await redeployTarget(root, c, a, true), b, "a cached red is walked past, never targeted");
});

test("redeployTarget in watch mode targets the build itself when nothing newer is green", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: "node -e 'process.exit(1)'" }));
  fs.mkdirSync(path.join(root, "node_modules"));
  // Pinned commits: the sibling "newest cached green" test above commits an identical A + b.txt B
  // in the same wall-clock second, so git gives the two B's the SAME sha and its noteGreenBaseline
  // leaks here — redeployTarget sees B green and returns it instead of the build. Pinning this
  // test's committer date keeps its shas out of that second (repo-fixtures pinnedCommit).
  pinnedCommit(root, "A");
  const a = headSha(root);
  fs.writeFileSync(path.join(root, "b.txt"), "b");
  pinnedCommit(root, "B");
  const b = headSha(root);

  // Running A, main A -> B (no verdict): nothing newer than the build is green, so the build
  // itself is the target — buildStaleness(a, a) then reads it as not stale and nothing starts.
  assert.equal(await redeployTarget(root, b, a, true), a, "the build itself is the target");
});

/** Chain `count` empty commits onto main in one `git fast-import` spawn (a commit spawn each would
 * put that many forks into the gate suite) and return their shas, newest first. `tag` keeps the
 * subjects, and so the shas, apart from every sibling test's: the baseline cache is shared
 * process-wide. */
function fillerCommits(root: string, count: number, tag: string): string[] {
  const base = headSha(root);
  let stream = "";
  for (let i = 1; i <= count; i++) {
    const subject = `${tag} ${i}`;
    stream +=
      `commit refs/heads/main\ncommitter test <test@example.com> 0 +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\n` +
      (i === 1 ? `from ${base}\n` : "");
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: root, input: stream });
  return sh(root, "git", "rev-list", "--first-parent", `--max-count=${count}`, "main").split("\n");
}

test("redeployTarget in watch mode never targets the tip when the build sits deeper than the walk", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "build.txt"), "deep below main");
  pinnedCommit(root, "A (the running build, deep below main)");
  const a = headSha(root);
  // 70 commits above the build, past the 64 the walk reads: on 2026-10-30 main stayed red ~90
  // commits past the running build, and the tip fallback had the redeployer run a full check of
  // every new tip itself.
  const above = fillerCommits(root, 70, "deep-walk filler");
  const tip = above[0]!;

  assert.equal(await redeployTarget(root, tip, a, true), a, "no green on the walk: the build, never the unchecked tip");
  assert.equal(await redeployTarget(root, tip, a), tip, "un-watched, the redeployer still checks the tip itself");
  noteGreenBaseline(above[10]!);
  assert.equal(await redeployTarget(root, tip, a, true), above[10], "a green the watch recorded on the walk is the target");
  assert.equal(
    await redeployTarget(root, tip, "f".repeat(40), true),
    above[10],
    "a build off main's history targets the watch's green too",
  );
});

test("redeployTarget in watch mode holds on the build while git cannot walk main, and walks again next poll", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "build.txt"), "git briefly unreadable");
  pinnedCommit(root, "A (the running build, git briefly unreadable)");
  const a = headSha(root);
  const [tip] = fillerCommits(root, 3, "unreadable-walk filler");
  noteGreenBaseline(tip!);
  const away = `${root}-away`;
  fs.renameSync(root, away);
  try {
    assert.equal(await redeployTarget(root, tip!, a, true), a, "a failed walk holds on the build and starts no check");
  } finally {
    fs.renameSync(away, root);
  }
  assert.equal(await redeployTarget(root, tip!, a, true), tip, "the failed walk was not cached: the green tip is the target");
});

test("watchVerifiesMain is true only with a declared check and a merge command in effect", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ test: "node -e 'process.exit(0)'" }));
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "project");

  // No declared check (no check.command and no install to walk up to): the watch cannot verify
  // main, whatever the gate/merge keys say.
  assert.equal(
    watchVerifiesMain(root, {}),
    false,
    "no declared check: the watch cannot verify main",
  );
  // A declared check with a merge command in effect (here by the gate-command fallback).
  assert.equal(
    watchVerifiesMain(root, { check: { command: "npm test", gateCommand: "npm test" } }),
    true,
    "a declared check with a merge command in effect: the watch verifies main",
  );
  // A blank mergeCommand keeps the full check in the merge lock.
  assert.equal(
    watchVerifiesMain(root, { check: { command: "npm test", gateCommand: "npm test", mergeCommand: "" } }),
    false,
    "a blank mergeCommand keeps the full check in the merge lock",
  );
});
