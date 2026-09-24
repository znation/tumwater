import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  abortableLandings,
  drainLandings,
  landingTasks,
  newLandingPipeline,
  settleAbortedVetted,
  type InFlightLanding,
  type LandingPipeline,
  type LandingPipelineContext,
} from "../src/landing-drain.js";
import { consumeAbortRequests } from "../src/operator-requests.js";
import { LoopRunner } from "../src/loop.js";
import { enqueueLanding, queueDepth, queuedLandingFiles } from "../src/land-queue.js";
import { abortRequestPath, landQueueDir, landingRefName, landingStatePath, orchestratorStatePath } from "../src/paths.js";
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
import type { TumwaterConfig } from "../src/config-schema.js";
import type { LandingEntry } from "../src/types.js";

// Unit coverage for src/landing-drain.ts — the scheduler seam between the durable land queue and
// the landing pipeline (land-queue speed 2c): the dedupe against main and torn-head recovery,
// the vetting stage (one vet per queued change, each on a shared maxConcurrent permit), and the
// merge slot (every vetted change, stacked), with the abort and shutdown rules and the marker
// records the observers read. The review gate's pi runs are real subprocesses behind the fake
// shim, exactly as lander.test.ts drives vetRequest and landVetted directly.

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
function runnersFor(root: string, roles: string[], signal?: AbortSignal, config = defaultConfig()): LoopRunner[] {
  return roles.map((role) => new LoopRunner(root, role, config, "main", signal));
}

/** A pipeline context over a fresh repo — `cap` shared permits (the maxConcurrent semaphore
 * role ticks would share) and a start gate the test can close — plus a fresh pipeline: the
 * scheduler's pair, driven here by pump/pumpUntil like its poll loop. */
function makePipeline(
  root: string,
  runners: LoopRunner[],
  opts: { cap?: number; signal?: AbortSignal; config?: TumwaterConfig; held?: () => boolean } = {},
): { ctx: LandingPipelineContext; pipeline: LandingPipeline } {
  const config = opts.config ?? defaultConfig();
  return {
    ctx: {
      root,
      mainBranch: "main",
      signal: opts.signal ?? new AbortController().signal,
      semaphore: new Semaphore(opts.cap ?? 3),
      runners,
      liveConfig: config,
      roleConfig: config,
      startHeld: opts.held ?? (() => false),
    },
    pipeline: newLandingPipeline(),
  };
}

/** Poll the pipeline every 50 ms, as the scheduler does every poll, until `done` holds right
 * after a drain. */
async function pumpUntil(
  ctx: LandingPipelineContext,
  p: LandingPipeline,
  done: () => boolean,
  what: string,
  ms = 60_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    await drainLandings(ctx, p);
    if (done()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Keep polling in the background (for mid-flight assertions); `stop` ends the loop. */
function pump(ctx: LandingPipelineContext, p: LandingPipeline): { stop: () => Promise<void> } {
  let running = true;
  const loop = (async () => {
    while (running) {
      await drainLandings(ctx, p);
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
    },
  };
}

/** The queue is empty and no vet or merge is running. */
const drained = (root: string, p: LandingPipeline) => () => queueDepth(root) === 0 && landingTasks(p).length === 0;

/** Every task still settling — parked vets included — for a test's cleanup. */
const allTasks = (p: LandingPipeline) => [...p.vetting.values(), ...(p.merge ? [p.merge] : [])].map((t) => t.promise);

/** Pin and enqueue one change per role, every pin before any enqueue (a pin's `git add -A`
 * would sweep an already-written queue file into the next pin). */
async function queueChanges(root: string, roles: string[]): Promise<Record<string, string>> {
  const shas = Object.fromEntries(roles.map((role) => [role, pinnedCommit(root, role)]));
  for (const role of roles) {
    await setRef(root, landingRefName(role), shas[role]!);
    enqueueLanding(root, entry(role, shas[role]!));
  }
  return shas;
}

/** A fake reviewer that tells the roles apart by their lander worktree: each touches
 * `<role>-reviewing`, a `held` role then waits (bounded, ~60 s) for `<role>-release`, and each
 * replies with its own verdict (approve by default). */
function reviewers(flags: string, roles: string[], verdicts: Record<string, string> = {}, held: string[] = []): string {
  return [
    `case "$PWD" in`,
    ...roles.map(
      (role) =>
        `*_land-${role}) touch '${path.join(flags, `${role}-reviewing`)}'; ` +
        (held.includes(role)
          ? `i=0; while [ ! -f '${path.join(flags, `${role}-release`)}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done; `
          : "") +
        `printf '%s\\n' '${assistantLine(verdicts[role] ?? "VERDICT: approve")}'; exit 0;;`,
    ),
    `esac`,
  ].join("\n");
}

/** A stand-in for a merge already holding the slot, so an approved change has to wait for it. */
function busySlot(): InFlightLanding {
  return { promise: new Promise<void>(() => {}), controller: new AbortController(), roles: [], userAborted: false };
}

/** A role's row as the observers render it (snapshot → landingForRole → loopPhase). The
 * observers show a landing only for a live orchestrator, so this stands the test process in
 * for one. */
function rowReader(root: string, roles: string[]): (role: string) => string {
  writeJsonFile(orchestratorStatePath(root), { pid: process.pid, startedAt: Date.now(), roles });
  const noModels = path.join(tmpdir(), "no-models.json");
  return (role) => {
    const snap = snapshot(root, noModels);
    return loopPhase(freshLoopState(role), snap.running, undefined, false, undefined, false, landingForRole(snap.landQueue, role));
  };
}

const REVIEWING = /^landing \d+s · reviewing$/;

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

test("an empty queue drains nothing", async () => {
  const root = makeRepo();
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));
  await drainLandings(ctx, pipeline);
  assert.equal(landingTasks(pipeline).length, 0, "no vet and no merge started");
  assert.equal(pipeline.vetting.size, 0);
});

test("a queued entry whose sha main already holds is dropped without a vet", async () => {
  const root = makeRepo();
  const sha = sh(root, "git", "rev-parse", "main").trim();
  enqueueLanding(root, entry("improve", sha));
  // A crash between the fast-forward and the entry drop leaves a marker naming a change main
  // already holds; the dedupe clears its record alongside the entry.
  writeLandingMarker(root, { role: "improve", sha, summary: "the work", startedAt: Date.now(), stage: "merging" });
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));

  await drainLandings(ctx, pipeline);
  assert.equal(pipeline.vetting.size, 0, "nothing to vet — main already holds the sha");
  assert.equal(queueDepth(root), 0, "the stale entry was dropped");
  assert.equal(readLandingMarker(root), null, "the stale marker was cleared");
  assert.equal(readEvents(root).some((e) => e.type === "landed" || e.type === "land_failed"), false, "no outcome was written");
});

test("a torn head is dropped with a warning and the healthy entry behind it lands", async () => {
  const root = makeRepo();
  const sha = pinnedCommit(root, "improve");
  await setRef(root, landingRefName("improve"), sha);
  // A hard crash mid enqueueLanding write: a file that sorts FIRST but parses to no entry.
  fs.mkdirSync(landQueueDir(root), { recursive: true });
  fs.writeFileSync(path.join(landQueueDir(root), "1-000000-0.json"), '{"role":"improve"');
  enqueueLanding(root, entry("improve", sha));
  const restore = fakePi(APPROVE());
  try {
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));
    await drainLandings(ctx, pipeline);
    assert.deepEqual([...pipeline.vetting.keys()], ["improve"], "the healthy entry behind the torn head is vetted");
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the healthy entry to land");

    const torn = path.join(landQueueDir(root), "1-000000-0.json");
    assert.equal(fs.existsSync(torn), false, "the torn head was dropped");
    assert.ok(
      readEvents(root).some(
        (e) => e.type === "warning" && /land queue head 1-000000-0\.json is unreadable/.test(String(e.message)),
      ),
      "the drop carried one warning event",
    );
    assert.ok(await isMergedInto(root, sha, "main"), "the healthy entry landed");
  } finally {
    restore();
  }
});

test("a single queued pinned entry lands through the pipeline: main advances, ref and entry and marker clear", async () => {
  const root = makeRepo();
  const sha = pinnedCommit(root, "improve");
  await setRef(root, landingRefName("improve"), sha);
  enqueueLanding(root, entry("improve", sha));
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const restore = fakePi(APPROVE());
  try {
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["improve"]));
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the entry to land");

    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "1", "the change landed on main");
    assert.ok(await isMergedInto(root, sha, "main"), "the pinned commit is contained in main");
    assert.equal(await refSha(root, landingRefName("improve")), null, "the ff deleted the landing ref");
    assert.equal(readLandingMarker(root), null, "the in-flight marker was cleared");
    const landed = readEvents(root).filter((e) => e.type === "landed");
    assert.equal(landed.length, 1, "one landed event for the queue's bookkeeping");
    assert.equal(landed[0]!.loop, "improve");
    assert.equal(landed[0]!.result, "changed");
    assert.equal(loadLoopState(root, "improve").lastResult, "changed", "the outcome folded into the author's state");
  } finally {
    restore();
  }
});

test("changes vetted while the merge slot is busy merge as one stack: one shared check, one fast-forward", async () => {
  const root = makeRepo();
  await queueChanges(root, ["alpha", "beta"]);
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const config = { ...defaultConfig(), check: { command: "true" } };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha", "beta"], undefined, config), { config });
  pipeline.merge = busySlot();
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.vetted.size === 2, "both changes to be vetted");
    pipeline.merge = null; // the busy slot frees
    await drainLandings(ctx, pipeline);
    assert.deepEqual(
      landingTasks(pipeline).flatMap((t) => t.roles),
      ["alpha", "beta"],
      "one merge, whose record names every stacked role, in queue order",
    );
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the stack to land");

    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "2", "both changes landed on main");
    for (const role of ["alpha", "beta"]) {
      assert.ok(sh(root, "git", "show", `main:${role}.txt`).includes(`work by ${role}`), `${role}'s work is on main`);
      assert.equal(await refSha(root, landingRefName(role)), null, `${role}'s ref was deleted`);
    }
    assert.equal(readLandingMarker(root), null, "the marker was cleared");
    const checks = readEvents(root).filter((e) => e.type === "build_check");
    assert.equal(checks.filter((e) => e.scope === "batch").length, 1, "ONE shared check over the stacked tree");
    assert.equal(checks.filter((e) => e.scope === "landing").length, 0, "and no per-change in-lock re-check");
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "merged").map((e) => e.loop),
      ["alpha", "beta"],
      "one merged event per change, in queue order",
    );
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("landBatchMax caps each merge's stack, read from the live config at each drain", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  await queueChanges(root, roles);
  const config = { ...defaultConfig(), check: { command: "true" } };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { config });
  pipeline.merge = busySlot();
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.vetted.size === 3, "all three to be vetted");
    ctx.liveConfig = { ...config, landBatchMax: 2 }; // a live edit, as the scheduler hands it over
    pipeline.merge = null;
    await drainLandings(ctx, pipeline);
    assert.deepEqual(landingTasks(pipeline).flatMap((t) => t.roles), ["alpha", "beta"], "the first merge stacks two, in queue order");
    assert.deepEqual([...pipeline.vetted.keys()], ["gamma"], "the third waits for the next merge");
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to drain");

    const checks = readEvents(root).filter((e) => e.type === "build_check" && e.scope !== "gate");
    assert.deepEqual(
      checks.map((e) => [e.loop, e.scope]),
      [
        ["alpha", "batch"],
        ["gamma", "landing"],
      ],
      "one shared check for the stack of two, then gamma's own in-lock re-check on the main they moved",
    );
    assert.deepEqual(readEvents(root).filter((e) => e.type === "merged").map((e) => e.loop), roles);
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("the merge's conflict resolver takes a shared permit, ahead of a vet parked for one", async () => {
  // Landings count as active work: the one model run a merge makes, mergeToMain's conflict
  // resolver, holds a shared maxConcurrent permit for its length — outside the merge lock, so a
  // tick waiting on that lock can never be what the resolver waits for — at MERGE_TIER, ahead
  // of any vet parked for a permit, since every queued change waits on the merge.
  const root = makeRepo();
  const alpha = pinnedCommit(root, "alpha");
  const beta = pinnedCommit(root, "beta");
  // main rewrites alpha's file after the pin: alpha's rebase conflicts, at its vet (which then
  // reviews the bare pin) and again at its merge, which needs the resolver.
  fs.writeFileSync(path.join(root, "alpha.txt"), "main's alpha\n");
  sh(root, "git", "add", "alpha.txt");
  sh(root, "git", "commit", "-m", "main edits alpha.txt");
  await setRef(root, landingRefName("alpha"), alpha);
  await setRef(root, landingRefName("beta"), beta);
  enqueueLanding(root, entry("alpha", alpha));
  const flags = tmpdir("resolver-permit-");
  const order = path.join(flags, "order");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in`,
      `tumwater-*-conflict) echo resolved > alpha.txt; echo resolver >> '${order}'; printf '%s\\n' '${assistantLine("resolved")}'; exit 0;;`,
      `*"VERDICT:"*) case "$PWD" in *_land-beta) echo beta-review >> '${order}';; esac; printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;;`,
      `esac; done`,
    ].join("\n"),
  );
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, ["alpha", "beta"]), { cap: 1 });
  pipeline.merge = busySlot();
  let held = false;
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.vetted.has("alpha"), "alpha to be vetted");
    // A role tick takes the only permit, and beta's change queues behind it: its vet parks.
    await ctx.semaphore.acquire(0);
    held = true;
    enqueueLanding(root, entry("beta", beta));
    await drainLandings(ctx, pipeline);
    assert.equal(pipeline.vetting.get("beta")?.parked, true, "beta's vet parks for the permit");
    pipeline.merge = null;
    await drainLandings(ctx, pipeline);
    assert.deepEqual(landingTasks(pipeline).flatMap((t) => t.roles), ["alpha"], "alpha's merge is running");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(fs.existsSync(order), false, "the resolver waits for a permit like any pi run");

    ctx.semaphore.release(); // the tick ends: the merge's resolver is first in line
    held = false;
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "both to land");
    assert.deepEqual(fs.readFileSync(order, "utf8").trim().split("\n"), ["resolver", "beta-review"], "the resolver ran before the parked vet");
    assert.equal(sh(root, "git", "show", "main:alpha.txt"), "resolved", "the resolution landed");
    assert.ok(sh(root, "git", "show", "main:beta.txt").includes("work by beta"));
  } finally {
    if (held) ctx.semaphore.release();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a red stack lands its passing prefix, rejects the change red alone, and merges the one behind it next", async () => {
  // PLANS.md land-queue 3d through the pipeline: beta breaks the suite only on top of alpha (its
  // own vet passed — an interaction the stack check exists to catch). The bisect lands alpha on
  // its own green check, attributes beta's red through main's baseline (a cache hit: alpha's
  // prefix seeded it) and rejects it with no pi run, and leaves gamma unattempted — back to
  // vetted, so the next merge lands it, re-checked on the main alpha moved.
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  const shas = await queueChanges(root, roles);
  const mainBefore = sh(root, "git", "rev-parse", "main");
  const config = {
    ...defaultConfig(),
    check: { command: `if [ -f alpha.txt ] && [ -f beta.txt ]; then echo "planted failure: beta breaks the suite"; exit 1; fi` },
  };
  const restore = fakePi(APPROVE());
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { config });
  pipeline.merge = busySlot();
  try {
    await pumpUntil(ctx, pipeline, () => pipeline.vetted.size === 3, "all three to be vetted");
    pipeline.merge = null;
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to drain");

    assert.deepEqual(
      sh(root, "git", "log", "--reverse", "--format=%s", `${mainBefore}..main`).split("\n"),
      ["work by alpha", "work by gamma"],
      "alpha's prefix, then gamma on the next merge",
    );
    const checks = readEvents(root).filter((e) => e.type === "build_check" && e.scope !== "gate");
    assert.deepEqual(
      checks.map((e) => [e.scope, e.status]),
      [
        ["batch", "failed"],
        ["batch", "passed"],
        ["batch", "failed"],
        ["landing", "passed"],
      ],
      "the whole stack, alpha's prefix, beta alone on top of it, then gamma's in-lock re-check",
    );
    const beta = loadLoopState(root, "beta");
    assert.equal(beta.lastResult, "rejected");
    assert.match(beta.lastReview!.reasons[0]!, /: planted failure: beta breaks the suite$/);
    assert.deepEqual(readEvents(root).filter((e) => e.type === "review_rejected").map((e) => e.loop), ["beta"]);
    assert.equal(readEvents(root).filter((e) => e.type === "review_start").length, 3, "one review per change, all in the vets");
    assert.equal(await refSha(root, landingRefName("beta")), null, "the rejection deleted beta's pin");
    assert.equal(await isMergedInto(root, shas.beta!, "main"), false);
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "landed" || e.type === "land_failed").map((e) => `${e.loop}:${String(e.result)}`),
      ["alpha:changed", "beta:rejected", "gamma:changed"],
      "each outcome written once, gamma's only after its own merge",
    );
    assert.equal(readLandingMarker(root), null);
  } finally {
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("every vet holds a shared permit: at cap 1 one reviews while the other parks, showing nothing, and no permit leaks", async () => {
  // A landing's pi runs take the same permit role ticks do (BUGS.md 2026-09-18), and landings
  // count as active work: at cap 2 both reviews run at once; at cap 1 the second vet parks
  // for the permit — no marker record, its row plainly queued, out of reach of abort --role and
  // of the shutdown wait — until the first vet frees it. Each review records how many reviews
  // were in flight as it started.
  for (const cap of [2, 1]) {
    const root = makeRepo();
    const roles = ["alpha", "beta"];
    await queueChanges(root, roles);
    const rowOf = rowReader(root, roles);
    const flags = tmpdir("vet-permits-");
    const restore = fakePi(
      [
        `d='${flags}/runs'; mkdir -p "$d"; f=$(mktemp "$d/run.XXXXXX")`,
        `n=0; for x in "$d"/run.*; do n=$((n+1)); done; echo "$n" >> '${flags}/samples.log'`,
        `case "$PWD" in *_land-alpha) touch '${flags}/alpha-reviewing'; i=0; while [ ! -f '${flags}/alpha-release' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done;; esac`,
        `rm -f "$f"`,
        APPROVE(),
      ].join("\n"),
    );
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles), { cap });
    const bg = pump(ctx, pipeline);
    try {
      await waitForFile(path.join(flags, "alpha-reviewing"));
      if (cap === 1) {
        await waitFor(() => pipeline.vetting.get("beta")?.parked === true, "beta's vet to park for the permit", 30_000);
        assert.match(rowOf("alpha"), REVIEWING, "cap 1: the vet holding the permit shows its stage");
        assert.equal(rowOf("beta"), "queued", "cap 1: the parked vet's role reads plainly queued");
        assert.deepEqual(readLandingMarker(root)?.changes?.map((c) => c.role), ["alpha"], "cap 1: no record for the parked vet");
        assert.deepEqual(landingTasks(pipeline).flatMap((t) => t.roles), ["alpha"], "cap 1: the parked vet is not in flight");
        assert.deepEqual(abortableLandings(pipeline).flatMap((t) => t.roles), ["alpha"], "cap 1: nor abortable");
      } else {
        await waitFor(() => readEvents(root).some((e) => e.type === "review_verdict" && e.loop === "beta"), "beta's review beside alpha's", 30_000);
      }
      fs.writeFileSync(path.join(flags, "alpha-release"), "");
      await waitFor(drained(root, pipeline), `cap ${cap}: both changes to land`, 60_000);

      const samples = fs.readFileSync(path.join(flags, "samples.log"), "utf8").trim().split("\n").map(Number);
      assert.equal(samples.length, 2, `cap ${cap}: one review per change`);
      assert.equal(Math.max(...samples), cap, `cap ${cap}: reviews in flight at each start never exceed the cap (${samples})`);
      await bg.stop();
      // Every permit came back: the full cap is acquirable again.
      for (let k = 0; k < cap; k++) {
        assert.ok(await within(ctx.semaphore.acquire(0), 5_000), `cap ${cap}: permit ${k + 1} was never released`);
      }
    } finally {
      fs.writeFileSync(path.join(flags, "alpha-release"), "");
      await bg.stop();
      await Promise.allSettled(allTasks(pipeline));
      restore();
    }
  }
});

test("a parked vet starts nothing when a shutdown or a closed start gate meets it: entry and pin stay queued", async () => {
  // A vet parked for its permit has started nothing, so it must end like a parked role tick —
  // no outcome, no review, no marker record — whether the harness stops (its controller) or a
  // restart / 429 hold closes the start gate before its permit comes (the gate at its grant).
  for (const stop of ["gate", "shutdown"] as const) {
    const root = makeRepo();
    const roles = ["alpha", "beta"];
    const shas = await queueChanges(root, roles);
    const flags = tmpdir("vet-parked-");
    const restore = fakePi(reviewers(flags, roles, {}, ["alpha"]));
    const shutdown = new AbortController();
    let held = false;
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, shutdown.signal), {
      cap: 1,
      signal: shutdown.signal,
      held: () => held,
    });
    try {
      await drainLandings(ctx, pipeline);
      await waitForFile(path.join(flags, "alpha-reviewing"));
      const beta = pipeline.vetting.get("beta");
      assert.equal(beta?.parked, true, `${stop}: beta's vet is parked behind alpha's`);
      if (stop === "gate") {
        held = true; // a restart hold, say: the scheduler stops draining, and parked vets meet it
        fs.writeFileSync(path.join(flags, "alpha-release"), "");
      } else {
        shutdown.abort();
      }
      assert.ok(await within(beta!.promise, 30_000), `${stop}: the parked vet settled`);
      await Promise.allSettled(allTasks(pipeline));

      assert.equal(pipeline.vetting.has("beta"), false, `${stop}: beta holds no vet any more`);
      assert.ok(queuedLandingFiles(root).some((q) => q.entry.role === "beta"), `${stop}: beta's entry is still queued`);
      assert.equal(await refSha(root, landingRefName("beta")), shas.beta, `${stop}: with its pin`);
      assert.equal(readEvents(root).some((e) => e.loop === "beta" && (e.type === "land_failed" || e.type === "review_start")), false, `${stop}: nothing ran for beta`);
      assert.ok(!readLandingMarker(root)?.changes?.some((c) => c.role === "beta"), `${stop}: beta never had a record`);
      if (stop === "shutdown") {
        const failed = readEvents(root).filter((e) => e.type === "land_failed" && e.loop === "alpha");
        assert.deepEqual(failed.map((e) => e.result), ["aborted"], "the vet under review ended aborted");
        assert.equal(await refSha(root, landingRefName("alpha")), shas.alpha, "its pin survives the shutdown");
      } else {
        held = false; // the hold lifts: the next drain vets beta afresh
        await pumpUntil(ctx, pipeline, drained(root, pipeline), "both to land once the gate reopens");
        assert.ok(sh(root, "git", "show", "main:beta.txt").includes("work by beta"), "beta landed once the gate reopened");
      }
      assert.ok(await within(ctx.semaphore.acquire(0), 5_000), `${stop}: the handed-back permit is free again`);
    } finally {
      fs.writeFileSync(path.join(flags, "alpha-release"), "");
      shutdown.abort();
      await Promise.allSettled(allTasks(pipeline));
      restore();
    }
  }
});

test("three T-long reviews run at once at cap 3, so all three merge in about T, not 3T", async () => {
  // Acceptance for land-queue speed 2c. Each review holds T and records how many reviews were in
  // flight as it started. As in lander.test.ts's timing tests, the span is read off the
  // harness's own timeline — first review_start to last `merged` — and held against the reviews'
  // own summed durations (the floor of any one-after-another schedule), so a loaded host's git
  // plumbing cannot swamp the bound.
  const T = 4;
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  const mainBefore = sh(root, "git", "rev-parse", "main");
  await queueChanges(root, roles);
  const runDir = tmpdir();
  const restore = fakePi(
    [
      `d='${runDir}/runs'; mkdir -p "$d"; f=$(mktemp "$d/run.XXXXXX")`,
      `n=0; for x in "$d"/run.*; do n=$((n+1)); done; echo "$n" >> '${runDir}/samples.log'`,
      `sleep ${T}; rm -f "$f"`,
      APPROVE(),
    ].join("\n"),
  );
  try {
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles), { cap: 3 });
    await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to land");

    assert.equal(sh(root, "git", "rev-list", "--count", `${mainBefore}..main`), "3", "all three landed");
    const samples = fs.readFileSync(path.join(runDir, "samples.log"), "utf8").trim().split("\n").map(Number);
    assert.equal(samples.length, 3, "one review per change");
    assert.equal(Math.max(...samples), 3, `all three reviews overlapped (in flight at each start: ${samples})`);
    const events = readEvents(root);
    const firstStart = Math.min(...events.filter((e) => e.type === "review_start").map((e) => e.ts));
    const lastMerged = Math.max(...events.filter((e) => e.type === "merged").map((e) => e.ts));
    const serialFloorMs = events
      .filter((e) => e.type === "review_verdict")
      .reduce((sum, e) => sum + Number(e.durationMs), 0);
    assert.ok(
      lastMerged - firstStart < serialFloorMs,
      `review to last merge took ${lastMerged - firstStart} ms, no less than the reviews' ${serialFloorMs} ms sum — they ran one after another`,
    );
    assert.equal(events.filter((e) => e.type === "landed").length, 3, "each change's outcome written once");
    assert.equal(readLandingMarker(root), null, "the marker is gone once nothing is in flight");
  } finally {
    restore();
  }
});

test("a vetting rejection drops its entry at once — its role may tick next poll — while the other vet runs on", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta"];
  const shas = await queueChanges(root, roles);
  const flags = tmpdir("vet-reject-");
  const restore = fakePi(reviewers(flags, roles, { alpha: "VERDICT: reject\n1. no" }, ["beta"]));
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles), { cap: 2 });
  const bg = pump(ctx, pipeline);
  try {
    await waitForFile(path.join(flags, "beta-reviewing"));
    await waitFor(() => queuedLandingFiles(root).length === 1, "alpha's entry to drop at its verdict", 30_000);

    assert.deepEqual(
      queuedLandingFiles(root).map((q) => q.entry.role),
      ["beta"],
      "alpha's entry is gone: the scheduler's interlock no longer holds alpha",
    );
    assert.equal(loadLoopState(root, "alpha").lastResult, "rejected", "the outcome is saved before the drop");
    assert.equal(readEvents(root).filter((e) => e.type === "land_failed" && e.loop === "alpha").length, 1);
    assert.equal(await refSha(root, landingRefName("alpha")), null, "a rejection deletes the pin");
    assert.deepEqual([...pipeline.vetting.keys()], ["beta"], "beta's vet is still running");
    const marker = readLandingMarker(root);
    assert.deepEqual(
      marker?.changes?.map((c) => [c.role, c.status, c.stage]),
      [["beta", "landing", "reviewing"]],
      "the marker holds only the change still in flight, at its own stage",
    );
    assert.equal(marker?.role, "beta", "the top level follows the change still in flight, for older observers");
    assert.equal(marker?.stage, "reviewing", "at its own stage");

    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await waitFor(drained(root, pipeline), "beta to land", 30_000);
    assert.ok(await isMergedInto(root, shas.beta!, "main"), "beta landed");
  } finally {
    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a vetted change merges while an earlier queue entry is still in review", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta"];
  const shas = await queueChanges(root, roles);
  const rowOf = rowReader(root, roles);
  const flags = tmpdir("vet-ahead-");
  const restore = fakePi(reviewers(flags, roles, {}, ["alpha"]));
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles), { cap: 2 });
  const bg = pump(ctx, pipeline);
  try {
    await waitForFile(path.join(flags, "alpha-reviewing"));
    await waitFor(() => readEvents(root).some((e) => e.type === "landed" && e.loop === "beta"), "beta to land", 30_000);

    assert.ok(await isMergedInto(root, shas.beta!, "main"), "beta merged ahead of the queue head");
    assert.equal(await isMergedInto(root, shas.alpha!, "main"), false);
    assert.deepEqual([...pipeline.vetting.keys()], ["alpha"], "the head is still in review");
    assert.match(rowOf("alpha"), REVIEWING, "the head's row shows its own vet");
    assert.equal(rowOf("beta"), "queued", "beta's row is back to its own state");

    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    await waitFor(drained(root, pipeline), "alpha to land", 30_000);
    assert.deepEqual(
      readEvents(root).filter((e) => e.type === "merged").map((e) => e.loop),
      ["beta", "alpha"],
      "each merged as soon as it was vetted",
    );
  } finally {
    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

test("a shutdown reaches every vet and keeps their pins; a vetted change waits out a busy merge slot", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  const shas = await queueChanges(root, roles);
  const rowOf = rowReader(root, roles);
  const flags = tmpdir("vet-shutdown-");
  const restore = fakePi(reviewers(flags, roles, {}, ["alpha", "beta"]));
  const shutdown = new AbortController();
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, shutdown.signal), { cap: 3, signal: shutdown.signal });
  pipeline.merge = busySlot();
  const bg = pump(ctx, pipeline);
  try {
    await waitForFile(path.join(flags, "alpha-reviewing"));
    await waitForFile(path.join(flags, "beta-reviewing"));
    await waitFor(() => pipeline.vetted.has("gamma"), "gamma to be vetted", 30_000);
    assert.equal(rowOf("gamma"), "vetted, awaiting merge");

    await bg.stop();
    shutdown.abort();
    await Promise.allSettled([...pipeline.vetting.values()].map((t) => t.promise));

    for (const role of ["alpha", "beta"]) {
      const failed = readEvents(root).filter((e) => e.type === "land_failed" && e.loop === role);
      assert.deepEqual(failed.map((e) => e.result), ["aborted"], `${role}'s vet ended aborted`);
      assert.equal(await refSha(root, landingRefName(role)), shas[role], `${role}'s pin survives the shutdown`);
    }
    assert.deepEqual(
      queuedLandingFiles(root).map((q) => q.entry.role),
      ["gamma"],
      "the vetted change stays queued for the next start",
    );
    assert.ok(await refSha(root, landingRefName("gamma")), "with its pin");
  } finally {
    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await bg.stop();
    shutdown.abort();
    await Promise.allSettled([...pipeline.vetting.values()].map((t) => t.promise));
    restore();
  }
});

test("abort --role stops that role's vet, or discards its vetted change, pin and all, while another vet runs on", async () => {
  const root = makeRepo();
  const roles = ["alpha", "beta", "gamma"];
  const shas = await queueChanges(root, roles);
  const flags = tmpdir("vet-abort-");
  const restore = fakePi(reviewers(flags, roles, {}, ["alpha", "beta"]));
  const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles), { cap: 3 });
  pipeline.merge = busySlot();
  const bg = pump(ctx, pipeline);
  try {
    await waitForFile(path.join(flags, "alpha-reviewing"));
    await waitForFile(path.join(flags, "beta-reviewing"));
    await waitFor(() => pipeline.vetted.has("gamma"), "gamma to be vetted", 30_000);

    for (const role of ["alpha", "gamma"]) writeJsonFile(abortRequestPath(root, role), { at: Date.now() });
    consumeAbortRequests(root, [], abortableLandings(pipeline));
    await settleAbortedVetted(root, pipeline); // the scheduler settles right after, every poll
    await waitFor(() => queuedLandingFiles(root).length === 1, "both aborted entries to drop", 30_000);

    for (const role of ["alpha", "gamma"]) {
      const failed = readEvents(root).filter((e) => e.type === "land_failed" && e.loop === role);
      assert.deepEqual(failed.map((e) => e.result), ["aborted"], `${role} ended aborted`);
      assert.equal(await refSha(root, landingRefName(role)), null, `${role}'s pin was discarded`);
    }
    assert.deepEqual([...pipeline.vetting.keys()], ["beta"], "beta's vet runs on");

    pipeline.merge = null; // the busy slot frees
    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await waitFor(drained(root, pipeline), "beta to land", 30_000);
    assert.ok(await isMergedInto(root, shas.beta!, "main"), "beta landed");
    assert.equal(await isMergedInto(root, shas.gamma!, "main"), false, "the discarded change never landed");
  } finally {
    fs.writeFileSync(path.join(flags, "alpha-release"), "");
    fs.writeFileSync(path.join(flags, "beta-release"), "");
    await bg.stop();
    await Promise.allSettled(allTasks(pipeline));
    restore();
  }
});

// The landing cell's stage (BUGS.md 2026-09-22, re-opened 2026-09-23) through the pipeline: each
// change's own record carries its stage, so a change's stage must leave `reviewing` the moment
// its gate returns — otherwise its finished reviewer's last turns sit in the cell, accruing a
// false `no pi output` flag, for as long as it waits for its merge — and one change's vet must
// advance only its own record. The stage sequence below is a single timeline: one permit, so the
// second vet parks (no record) until the first frees it, and a busy merge slot until both are
// done vetting.
for (const headVerdict of ["reject", "approve"] as const) {
  test(`a head ${headVerdict === "reject" ? "rejected" : "approved"} in its vet leaves reviewing when its gate returns; the stack check names itself`, async () => {
    const root = makeRepo();
    const roles = ["alpha", "beta"];
    await queueChanges(root, roles);
    const rec = path.join(tmpdir(), "stages");
    // Every record as `role=status/stage`, read from the live marker by whichever run records it.
    const script = path.join(tmpdir(), "stages.mjs");
    fs.writeFileSync(
      script,
      `import fs from "node:fs";\n` +
        `let m = {};\ntry { m = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); } catch {}\n` +
        `process.stdout.write((m.changes ?? []).map((c) => c.role + "=" + c.status + "/" + (c.stage ?? "-")).join(","));\n`,
    );
    const stagesOf = `'${process.execPath}' '${script}' '${landingStatePath(root)}'`;
    const config = { ...defaultConfig(), check: { command: `echo "check:$(${stagesOf})" >> '${rec}'` } };
    const headReply = headVerdict === "reject" ? "VERDICT: reject\n1. no" : "VERDICT: approve";
    const restore = fakePi(
      [
        // Tell the two reviewer runs apart by the session name pi is handed.
        `r=none; for a in "$@"; do case "$a" in tumwater-review-alpha-*) r=alpha ;; tumwater-review-beta-*) r=beta ;; esac; done`,
        `echo "$r:$(${stagesOf})" >> '${rec}'`,
        `if [ "$r" = alpha ]; then printf '%s\\n' '${assistantLine(headReply)}'; else printf '%s\\n' '${assistantLine("VERDICT: approve")}'; fi`,
      ].join("\n"),
    );
    const { ctx, pipeline } = makePipeline(root, runnersFor(root, roles, undefined, config), { cap: 1, config });
    pipeline.merge = busySlot();
    try {
      await pumpUntil(ctx, pipeline, () => pipeline.vetted.has("beta"), "beta to be vetted");
      pipeline.merge = null;
      await pumpUntil(ctx, pipeline, drained(root, pipeline), "the queue to drain");

      const seen = fs.readFileSync(rec, "utf8").trim().split("\n");
      // The head's own vet: pre-check, then its reviewer, with beta parked and showing nothing.
      // Then beta's vet runs with the head's record already off the gate's stages (vetted, or
      // gone with its rejection) — beta's transitions advance only beta's own record.
      const alphaAfter = headVerdict === "reject" ? "" : "alpha=vetted/merging,";
      const vets = [
        "check:alpha=landing/build-check",
        "alpha:alpha=landing/reviewing",
        `check:${alphaAfter}beta=landing/build-check`,
        `beta:${alphaAfter}beta=landing/reviewing`,
      ];
      if (headVerdict === "reject") {
        assert.deepEqual(seen, vets, "a one-change merge lands on its own: no stack check, no re-check on an unmoved main");
        assert.equal(loadLoopState(root, "alpha").lastResult, "rejected");
      } else {
        assert.deepEqual(
          seen,
          [...vets, "check:alpha=landing/build-check,beta=landing/build-check"],
          "the shared stack check runs under build-check on every stacked change",
        );
        assert.equal(loadLoopState(root, "alpha").lastResult, "changed");
      }
      assert.equal(loadLoopState(root, "beta").lastResult, "changed");
      assert.equal(readLandingMarker(root), null, "the marker is gone once the merge is done");
    } finally {
      await Promise.allSettled(allTasks(pipeline));
      restore();
    }
  });
}
