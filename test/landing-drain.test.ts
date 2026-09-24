import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { drainLandingQueue, type InFlightLanding, type LandingDrainContext } from "../src/landing-drain.js";
import { LoopRunner } from "../src/loop.js";
import { enqueueLanding, queueDepth, queuedLandingFiles } from "../src/land-queue.js";
import { landQueueDir, landingRefName, orchestratorStatePath } from "../src/paths.js";
import { isMergedInto, refSha, setRef } from "../src/git.js";
import { readEvents } from "../src/events.js";
import { readLandingMarker, writeLandingMarker } from "../src/landing-slot.js";
import { Semaphore } from "../src/semaphore.js";
import { defaultConfig } from "../src/config.js";
import { freshLoopState, loadLoopState } from "../src/state.js";
import { writeJsonFile } from "../src/json-files.js";
import { snapshot } from "../src/ui/status.js";
import { landingForRole, loopPhase } from "../src/ui/status-model.js";
import { assistantLine, fakePi, makeRepo, sh, tmpdir, waitFor, waitForFile } from "./util.js";
import type { LandingEntry } from "../src/types.js";

// Unit coverage for src/landing-drain.ts's drainLandingQueue — the scheduler seam between the
// durable land queue and the single landing slot: queue-head dedupe against main, torn-head
// recovery, the single-landing path, the coalesced batch, and the abort-ref rules. The review
// gate's pi runs are real subprocesses behind the fake shim, exactly as lander.test.ts drives
// landChange and landBatch directly.

const APPROVE = (reply = "the work looks right") => `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '${assistantLine(`VERDICT: approve\n${reply}`)}'; exit 0;; esac; done`;

/** One pinned commit NOT contained in main, standing alone on main's tip — the queue shape
 * a changed tick leaves behind. Detach first: the commit must not land on main itself. */
function pinnedCommit(root: string, role: string): string {
  sh(root, "git", "checkout", "--detach");
  sh(root, "git", "reset", "--hard", "main");
  fs.appendFileSync(path.join(root, `${role}.txt`), `work by ${role}\n`);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", `work by ${role}`);
  const sha = sh(root, "git", "rev-parse", "HEAD").trim();
  sh(root, "git", "checkout", "main");
  return sha;
}

function entry(role: string, sha: string, enqueuedAt = Date.now()): LandingEntry {
  return { role, sha, tick: 7, summary: "the work", enqueuedAt };
}

/** A runner per role — a real LoopRunner (cheap constructor: state loaded from disk, no
 * subprocess) so the drain resolves its author wiring the way orchestrator.ts supplies it. */
function runnersFor(root: string, roles: string[], signal?: AbortSignal): LoopRunner[] {
  return roles.map((role) => new LoopRunner(root, role, defaultConfig(), "main", signal));
}

/** A drain context over a fresh repo, with the slot-cleared tick counted. */
function makeCtx(
  root: string,
  runners: LoopRunner[],
  signal: AbortSignal = new AbortController().signal,
): { ctx: LandingDrainContext; cleared: { n: number } } {
  const cleared = { n: 0 };
  const config = defaultConfig();
  const ctx: LandingDrainContext = {
    root,
    mainBranch: "main",
    signal,
    semaphore: new Semaphore(2),
    runners,
    liveConfig: config,
    roleConfig: config,
    onSlotCleared: () => {
      cleared.n += 1;
    },
  };
  return { ctx, cleared };
}

test("an empty queue drains nothing", async () => {
  const root = makeRepo();
  const { ctx, cleared } = makeCtx(root, runnersFor(root, ["improve"]));
  assert.equal(await drainLandingQueue(ctx), null);
  assert.equal(cleared.n, 0, "no landing started, so the slot was never used");
});

test("a queue head whose sha main already holds is dropped without a landing run", async () => {
  const root = makeRepo();
  const sha = sh(root, "git", "rev-parse", "main").trim();
  enqueueLanding(root, entry("improve", sha));
  // A crash between the marker write and its removal leaves a marker with no live landing;
  // the dedupe clears the stale marker alongside the entry.
  writeLandingMarker(root, { role: "improve", sha, summary: "the work", startedAt: Date.now(), stage: "merging" });
  const { ctx, cleared } = makeCtx(root, runnersFor(root, ["improve"]));

  assert.equal(await drainLandingQueue(ctx), null, "nothing to land — main already holds the sha");
  assert.equal(queueDepth(root), 0, "the stale entry was dropped");
  assert.equal(readLandingMarker(root), null, "the stale marker was cleared");
  assert.equal(cleared.n, 0, "no landing ran");
  assert.equal(readEvents(root).some((e) => e.type === "landed"), false, "no landing event fired");
});

test("a torn head is dropped with a warning and the healthy entry behind it drains", async () => {
  const root = makeRepo();
  const sha = pinnedCommit(root, "improve");
  await setRef(root, landingRefName("improve"), sha);
  // A hard crash mid enqueueLanding write: a file that sorts FIRST but parses to no entry.
  fs.mkdirSync(landQueueDir(root), { recursive: true });
  fs.writeFileSync(path.join(landQueueDir(root), "1-000000-0.json"), '{"role":"improve"');
  enqueueLanding(root, entry("improve", sha));
  const restore = fakePi(APPROVE());
  try {
    const { ctx, cleared } = makeCtx(root, runnersFor(root, ["improve"]));
    const landing = await drainLandingQueue(ctx);
    assert.ok(landing, "the healthy entry behind the torn head starts a landing");
    assert.deepEqual(landing!.roles, ["improve"]);
    await landing!.promise;

    const torn = path.join(landQueueDir(root), "1-000000-0.json");
    assert.equal(fs.existsSync(torn), false, "the torn head was dropped");
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && /land queue head 1-000000-0\.json is unreadable/.test(String(e.message)),
      ),
      "the drop carried one warning event",
    );
    assert.equal(queueDepth(root), 0, "the healthy entry landed and was dropped too");
    assert.equal(cleared.n, 1, "the slot cleared exactly once");
  } finally {
    restore();
  }
});

test("a single queued pinned entry lands through the slot: main advances, ref and entry and marker clear", async () => {
  const root = makeRepo();
  const sha = pinnedCommit(root, "improve");
  await setRef(root, landingRefName("improve"), sha);
  enqueueLanding(root, entry("improve", sha));
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const restore = fakePi(APPROVE());
  try {
    const { ctx, cleared } = makeCtx(root, runnersFor(root, ["improve"]));
    const landing = await drainLandingQueue(ctx);
    assert.ok(landing, "the queue head started a landing");
    assert.deepEqual(landing!.roles, ["improve"]);
    await landing!.promise;

    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "1", "the change landed on main");
    assert.ok(await isMergedInto(root, sha, "main"), "the pinned commit is contained in main");
    assert.equal(await refSha(root, landingRefName("improve")), null, "the ff deleted the landing ref");
    assert.equal(queueDepth(root), 0, "the entry was dropped after the outcome");
    assert.equal(readLandingMarker(root), null, "the in-flight marker was cleared");
    assert.equal(cleared.n, 1, "the slot cleared exactly once");
    const landed = readEvents(root).filter((e) => e.type === "landed");
    assert.equal(landed.length, 1, "one landed event for the queue's bookkeeping");
    assert.equal(landed[0]!.loop, "improve");
    assert.equal(landed[0]!.result, "changed");
  } finally {
    restore();
  }
});

test("two queued entries coalesce into one batch landing for the slot", async () => {
  const root = makeRepo();
  const alpha = pinnedCommit(root, "alpha");
  const beta = pinnedCommit(root, "beta");
  await setRef(root, landingRefName("alpha"), alpha);
  await setRef(root, landingRefName("beta"), beta);
  enqueueLanding(root, entry("alpha", alpha));
  enqueueLanding(root, entry("beta", beta));
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const restore = fakePi(APPROVE());
  try {
    const { ctx, cleared } = makeCtx(root, runnersFor(root, ["alpha", "beta"]));
    const landing = await drainLandingQueue(ctx);
    assert.ok(landing, "the batch started");
    assert.deepEqual(landing!.roles, ["alpha", "beta"], "the slot's record names every batched role");
    await landing!.promise;

    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2", "both changes landed on main");
    assert.equal(await refSha(root, landingRefName("alpha")), null, "the head's ref was deleted");
    assert.equal(await refSha(root, landingRefName("beta")), null, "the stacked change's ref too");
    assert.equal(queueDepth(root), 0, "every batched entry was dropped");
    assert.equal(readLandingMarker(root), null, "the batch's marker was cleared");
    assert.equal(cleared.n, 1, "the whole batch used the slot once");
    const merged = readEvents(root).filter((e) => e.type === "merged");
    assert.equal(merged.length, 2, "one merged event per change");
    assert.deepEqual(
      merged.map((e) => e.loop),
      ["alpha", "beta"],
      "the events carry their own roles, in queue order",
    );
  } finally {
    restore();
  }
});

test("a deliberate user abort discards the pinned refs; a shutdown abort keeps them for recovery", async () => {
  const root = makeRepo();
  const sha = pinnedCommit(root, "improve");
  await setRef(root, landingRefName("improve"), sha);
  enqueueLanding(root, entry("improve", sha));
  const restore = fakePi(`exit 0`); // the reviewer (if it spawns) exits at once: abort rules only
  try {
    // A deliberate `tumwater abort --role`: the landing is flagged userAborted mid-flight,
    // and the finally block throws the pin away — aborted work must not resurrect.
    const { ctx } = makeCtx(root, runnersFor(root, ["improve"]));
    const landing = await drainLandingQueue(ctx);
    assert.ok(landing);
    landing!.userAborted = true;
    landing!.controller.abort();
    await landing!.promise;
    assert.equal(await refSha(root, landingRefName("improve")), null, "a user abort discarded the pin");

    // A harness shutdown abort (no userAborted flag): the pin survives so next tick's
    // leftover recovery can re-land the committed work.
    const sha2 = pinnedCommit(root, "improve");
    await setRef(root, landingRefName("improve"), sha2);
    enqueueLanding(root, entry("improve", sha2));
    const controller = new AbortController();
    const second = makeCtx(root, runnersFor(root, ["improve"], controller.signal), controller.signal);
    controller.abort(); // a shutdown that lands before the reviewer starts
    const landing2 = await drainLandingQueue(second.ctx);
    assert.ok(landing2, "the entry still starts a landing slot run");
    await landing2!.promise;
    assert.equal(await refSha(root, landingRefName("improve")), sha2, "a shutdown abort kept the pin for recovery");
  } finally {
    restore();
  }
});

test("a batch's unattempted change keeps its entry queued for re-drain", async () => {
  // The write-back writes only DEFINED results: a change landBatch never attempted (a Phase-A
  // stop leaves it undefined) keeps its queue entry and its pin — the next drain re-runs it.
  // Drive it deterministically: alpha's gate approves, beta's pin names a commit that no
  // longer exists (the land queue outlives its ref by design) so the gate degrades beta to
  // a terminal "error" and stops Phase A launching, and gamma is never attempted. alpha's
  // gate runs beside beta's (Phase A is concurrent), so its review holds a few seconds to
  // outlast beta's failed checkout — otherwise its lane could pull gamma first.
  const root = makeRepo();
  const alpha = pinnedCommit(root, "alpha");
  const gamma = pinnedCommit(root, "gamma");
  await setRef(root, landingRefName("alpha"), alpha);
  await setRef(root, landingRefName("beta"), "0123456789abcdef0123456789abcdef01234567");
  await setRef(root, landingRefName("gamma"), gamma);
  enqueueLanding(root, entry("alpha", alpha));
  enqueueLanding(root, entry("beta", "0123456789abcdef0123456789abcdef01234567"));
  enqueueLanding(root, entry("gamma", gamma));
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const restore = fakePi(`sleep 3\n${APPROVE()}`);
  try {
    const { ctx, cleared } = makeCtx(root, runnersFor(root, ["alpha", "beta", "gamma"]));
    const landing = await drainLandingQueue(ctx);
    assert.ok(landing);
    assert.deepEqual(landing!.roles, ["alpha", "beta", "gamma"]);
    await landing!.promise;

    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "1", "alpha alone landed");
    assert.equal(await refSha(root, landingRefName("alpha")), null, "alpha's landing deleted its ref");
    assert.equal(queueDepth(root), 1, "only the unattempted change's entry remains");
    assert.equal(await refSha(root, landingRefName("gamma")), gamma, "the unattempted change keeps its pin");
    assert.equal(cleared.n, 1, "the slot cleared exactly once");
  } finally {
    restore();
  }
});

test("a batched change rejected early drops its entry at its verdict, while the rest of the batch is still in review", async () => {
  // BUGS.md 2026-09-23: a final Phase-A verdict used to wait for the whole batch's
  // write-back, so the rejected author stayed interlocked through every later review, the
  // stack check, and the ff. Alpha's reviewer rejects at once; beta's parks until released,
  // so everything asserted before the release is the mid-batch state. The two gates run
  // concurrently, and alpha's reviewer rejects only once beta's is parked: beta announced
  // `reviewing` on its own record while alpha's was still the first in flight, so once alpha is
  // done the top level (what an older observer reads) must follow beta at beta's own stage, not
  // the `merging` alpha's finished gate left behind.
  const root = makeRepo();
  const alpha = pinnedCommit(root, "alpha");
  const beta = pinnedCommit(root, "beta");
  await setRef(root, landingRefName("alpha"), alpha);
  await setRef(root, landingRefName("beta"), beta);
  enqueueLanding(root, entry("alpha", alpha));
  enqueueLanding(root, entry("beta", beta));
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const dir = tmpdir("early-drop-");
  const held = path.join(dir, "beta-reviewing");
  const release = path.join(dir, "release");
  // The reviewer tells the two apart by the diff each prompt carries (`+work by alpha`);
  // beta's park is bounded (~60 s) so a failed assert can never leave it spinning.
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*)`,
      `case "$a" in *"work by alpha"*)`,
      `i=0; until [ -e '${held}' ] || [ $i -ge 600 ]; do sleep 0.05; i=$((i+1)); done`,
      `printf '%s\\n' '${assistantLine("VERDICT: reject\n1. breaks the zero-dep rule")}'; exit 0;; esac`,
      `touch '${held}'; i=0; while [ ! -e '${release}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done`,
      `printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;;`,
      `esac; done`,
    ].join("\n"),
  );
  let landing: InFlightLanding | null = null;
  try {
    const { ctx, cleared } = makeCtx(root, runnersFor(root, ["alpha", "beta"]));
    landing = await drainLandingQueue(ctx);
    assert.ok(landing, "the batch started");
    await waitForFile(held);
    await waitFor(() => queuedLandingFiles(root).length === 1, "alpha's entry to drop at its verdict", 30_000);

    // Mid-batch: beta's review is still running, yet alpha's landing is already complete.
    assert.deepEqual(
      queuedLandingFiles(root).map((q) => q.entry.role),
      ["beta"],
      "alpha's entry dropped at its verdict — the interlock's queued-roles set no longer holds alpha",
    );
    assert.equal(loadLoopState(root, "alpha").lastResult, "rejected", "the outcome is saved before the drop");
    const alphaFailed = () => readEvents(root).filter((e) => e.type === "land_failed" && e.loop === "alpha");
    assert.equal(alphaFailed().length, 1, "and logged");
    assert.equal(alphaFailed()[0]!.result, "rejected");
    assert.deepEqual(landing!.roles, ["beta"], "alpha left the slot's record: an abort for its next tick spares the batch");
    const marker = readLandingMarker(root);
    assert.deepEqual(
      marker?.changes?.map((c) => [c.role, c.status, c.stage]),
      [
        ["alpha", "done", "merging"],
        ["beta", "landing", "reviewing"],
      ],
      "each change's own record: alpha finished, beta at its own gate's stage",
    );
    assert.equal(marker?.role, "beta", "the top level moved off the dropped head to the change still in flight");
    assert.equal(marker?.sha, beta, "so an older observer's cross-check still finds a queued entry with its sha");
    assert.equal(marker?.stage, "reviewing", "and it carries beta's own stage");

    fs.writeFileSync(release, "");
    await landing!.promise;

    assert.ok(await isMergedInto(root, beta, "main"), "the rest of the batch still landed");
    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "1", "beta alone");
    assert.equal(queueDepth(root), 0, "beta's entry dropped at batch end");
    assert.equal(alphaFailed().length, 1, "the end-of-batch write-back did not write alpha's outcome twice");
    assert.equal(readEvents(root).filter((e) => e.type === "landed" && e.loop === "beta").length, 1);
    assert.equal(readLandingMarker(root), null, "the batch's marker was cleared");
    assert.equal(cleared.n, 1, "the whole batch used the slot once");
  } finally {
    // Release the parked reviewer and let the batch settle even when an assert failed.
    fs.writeFileSync(release, "");
    await landing?.promise;
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Resolve true when `p` settles within `ms`, false otherwise — an unref'd timer, so a
 * resolved race leaves nothing keeping the test process alive. */
function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref();
    void p.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

test("a batch's concurrent gates each hold a maxConcurrent permit: two reviews at cap 2, one at a time at cap 1, none leaked", async () => {
  // A landing's pi runs take the same permit role ticks do (BUGS.md 2026-09-18). The slot's
  // permit covers ONE Phase-A gate and every gate beside it must win a permit of its own —
  // so at cap 1, where the slot holds the only one, the gates run one after another on it
  // (never deadlocking on the lane that waits), and that lane's late grant goes straight back.
  // Each review records how many reviews were in flight as it started.
  for (const cap of [2, 1]) {
    const root = makeRepo();
    // Pin both before enqueueing either: a pin's `git add -A` would swallow a queue file.
    const shas = ["alpha", "beta"].map((role) => [role, pinnedCommit(root, role)] as const);
    for (const [role, sha] of shas) {
      await setRef(root, landingRefName(role), sha);
      enqueueLanding(root, entry(role, sha));
    }
    const mainBefore = sh(root, "git", "rev-parse", "main");
    const runDir = tmpdir();
    const restore = fakePi(
      [
        `d='${runDir}/runs'; mkdir -p "$d"; f=$(mktemp "$d/run.XXXXXX")`,
        `n=0; for x in "$d"/run.*; do n=$((n+1)); done; echo "$n" >> '${runDir}/samples.log'`,
        `sleep 2; rm -f "$f"`,
        APPROVE(),
      ].join("\n"),
    );
    try {
      const { ctx } = makeCtx(root, runnersFor(root, ["alpha", "beta"]));
      const semaphore = new Semaphore(cap);
      ctx.semaphore = semaphore;
      const landing = await drainLandingQueue(ctx);
      assert.ok(landing, `cap ${cap}: the batch started`);
      await landing!.promise;

      assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2", `cap ${cap}: both changes landed`);
      const samples = fs.readFileSync(path.join(runDir, "samples.log"), "utf8").trim().split("\n").map(Number);
      assert.equal(samples.length, 2, `cap ${cap}: one review per change`);
      assert.equal(Math.max(...samples), cap, `cap ${cap}: reviews in flight at each start never exceed the cap (${samples})`);
      // Every permit came back — the slot's, the concurrent gate's, and at cap 1 the waiting
      // lane's late grant: the full cap is acquirable again.
      for (let k = 0; k < cap; k++) {
        assert.ok(await within(semaphore.acquire(0), 5_000), `cap ${cap}: permit ${k + 1} was never released`);
      }
    } finally {
      restore();
    }
  }
});

test("a batched row shows its own change's state: a rejected change stops reading landing, the changes under review do", async () => {
  // BUGS.md 2026-09-23: the batch marker named only one change, so a rejected head's row read
  // `landing <batch elapsed>` long after its verdict while the change actually under review
  // showed nothing. Hold each reviewer until the test releases it and read every batched row
  // through the observers' own path (snapshot → landingForRole → loopPhase) at each step. Two
  // gates run at once (the context's cap 2 grants the concurrent gate its permit), so the
  // marker has to name several changes in flight, each with its own start and stage.
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  // Pin every commit before enqueueing any: pinnedCommit's `git add -A` would sweep an
  // already-written (untracked) queue file into the next pin.
  const shas = Object.fromEntries(roles.map((role) => [role, pinnedCommit(root, role)]));
  for (const role of roles) {
    await setRef(root, landingRefName(role), shas[role]!);
    enqueueLanding(root, entry(role, shas[role]!));
  }
  // The observers show a landing only for a live orchestrator: this process stands in for it.
  writeJsonFile(orchestratorStatePath(root), { pid: process.pid, startedAt: Date.now(), roles });
  const flags = tmpdir("batch-rows-");
  const flag = (name: string) => path.join(flags, name);
  const verdicts: Record<string, string> = { alpha: "VERDICT: reject\n1. no", beta: "VERDICT: approve", gamma: "VERDICT: approve" };
  const restore = fakePi(
    [
      `case "$PWD" in`,
      ...roles.map(
        (role) =>
          `*_land-${role}) touch '${flag(`${role}-reviewing`)}'; i=0; ` +
          `while [ ! -f '${flag(`${role}-release`)}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done; ` +
          `printf '%s\\n' '${assistantLine(verdicts[role]!)}'; exit 0;;`,
      ),
      `esac`,
    ].join("\n"),
  );
  const noModels = path.join(flags, "no-models.json");
  const rowOf = (role: string): string => {
    const snap = snapshot(root, noModels);
    return loopPhase(freshLoopState(role), snap.running, undefined, false, undefined, false, landingForRole(snap.landQueue, role));
  };
  const REVIEWING = /^landing \d+s · reviewing$/;
  let landing: InFlightLanding | null = null;
  try {
    const { ctx } = makeCtx(root, runnersFor(root, roles));
    landing = await drainLandingQueue(ctx);
    assert.deepEqual(landing?.roles, roles, "the three entries coalesced into one batch");

    // alpha and beta under review at once: both read landing at their own stage; gamma is
    // still queued in the batch.
    await waitForFile(flag("alpha-reviewing"));
    await waitForFile(flag("beta-reviewing"));
    assert.match(rowOf("alpha"), REVIEWING);
    assert.match(rowOf("beta"), REVIEWING);
    assert.equal(rowOf("gamma"), "queued in batch");

    // alpha rejected: its change is finished, so its row reads its own state again while beta
    // is still under review; gamma's gate takes alpha's lane and reads landing with ITS OWN
    // start, not the batch's.
    const releasedAt = Date.now();
    fs.writeFileSync(flag("alpha-release"), "");
    await waitForFile(flag("gamma-reviewing"));
    assert.equal(rowOf("alpha"), "queued", "a rejected change keeps no live landing label");
    assert.match(rowOf("beta"), REVIEWING);
    assert.match(rowOf("gamma"), REVIEWING);
    const gamma = landingForRole(snapshot(root, noModels).landQueue, "gamma");
    assert.ok(gamma?.startedAt !== undefined && gamma.startedAt >= releasedAt, "gamma's elapsed runs from its own gate start");
    assert.equal(readLandingMarker(root)?.role, "beta", "the top level follows the first change in flight, for older observers");

    // beta approved: it waits for the stack while gamma is still under review.
    fs.writeFileSync(flag("beta-release"), "");
    await waitFor(() => rowOf("beta") === "approved, awaiting batch", "beta's approval to show", 30_000);
    assert.equal(rowOf("alpha"), "queued");
    assert.match(rowOf("gamma"), REVIEWING);

    fs.writeFileSync(flag("gamma-release"), "");
    await landing!.promise;
    assert.equal(readLandingMarker(root), null, "the batch's marker was cleared");
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "merged").map((e) => e.loop),
      ["beta", "gamma"],
      "the approved changes landed as the stack",
    );
    for (const role of roles) assert.equal(rowOf(role), "queued", `${role}'s row is back to its own state`);
  } finally {
    // Release any reviewer still held (a failed assertion above) and let the batch settle, so
    // no fake pi outlives the test.
    for (const role of roles) fs.writeFileSync(flag(`${role}-release`), "");
    await landing?.promise;
    restore();
  }
});
