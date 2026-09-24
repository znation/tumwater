import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { drainLandingQueue, type LandingDrainContext } from "../src/landing-drain.js";
import { LoopRunner } from "../src/loop.js";
import { enqueueLanding, queueDepth } from "../src/land-queue.js";
import { landQueueDir, landingRefName } from "../src/paths.js";
import { isMergedInto, refSha, setRef } from "../src/git.js";
import { readEvents } from "../src/events.js";
import { readLandingMarker, writeLandingMarker } from "../src/landing-slot.js";
import { Semaphore } from "../src/semaphore.js";
import { defaultConfig } from "../src/config.js";
import { assistantLine, fakePi, makeRepo, sh } from "./util.js";
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
  writeLandingMarker(root, { role: "improve", sha, summary: "the work", startedAt: Date.now() });
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
  // a terminal "error" and stops, and gamma is never attempted.
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
  const restore = fakePi(APPROVE());
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
