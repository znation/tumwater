/** Unit coverage for src/landing-slot.ts's bookkeeping — the usage accounting that charges a
 * landing's own pi runs (reviewer + conflict resolution) to the AUTHORING role's live state and
 * records them on the landed/land_failed event, the write-back, and the 4/5 marker's per-change
 * records. The full landing flow is pinned end-to-end through the pipeline (test/util.ts's
 * landHead) in the loop and orchestrator tests, but those drive a fake pi that reports no
 * usage, so the nonzero-usage branches were never exercised: a landing whose reviewer burns
 * tokens and cost is exactly what feeds `tumwater report` and the daily budget cap, and a broken
 * fold there would silently lose that spend. These pin the accounting branches directly. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  addLandingChange,
  landingChanges,
  landingUsage,
  readLandingMarker,
  removeLandingChange,
  setLandingChangeStatus,
  setLandingStage,
  writeLandingMarker,
  writeLandingOutcome,
} from "../src/landing-slot.js";
import { landingRefName, landingStatePath } from "../src/paths.js";
import { refSha, setRef } from "../src/git.js";
import { defaultConfig } from "../src/config.js";
import { applyTickOutcome, freshLoopState, loadLoopState, saveLoopState } from "../src/state.js";
import { enqueueLanding, headLanding, queueDepth } from "../src/land-queue.js";
import { readEvents } from "../src/events.js";
import { LoopRunner } from "../src/loop.js";
import type { LandingEntry, PiRunResult } from "../src/types.js";
import { assistantLine, fakePi, landHead, makeRepo, sh, tmpdir } from "./util.js";

/** A minimal successful pi run carrying the given usage — only the fields the fold reads matter,
 * but PiRunResult is fully required, so the rest are neutral defaults. */
function piRun(outputTokens: number, costUsd: number): PiRunResult {
  return {
    ok: true,
    finalText: "",
    nothingToDo: false,
    refused: false,
    outputTokens,
    peakContextTokens: 0,
    turns: 1,
    costUsd,
    timedOut: false,
    aborted: false,
    quietKilled: false,
    contextExceeded: false,
    transientServerTimeout: false,
    transientRateLimit: false,
    transientPiCrash: false,
    finalMessageContentless: false,
    compacted: false,
  };
}

/** Queue one landing in a fresh repo and return its entry plus the file a drop removes. */
function queued(root: string, role = "improve"): { entry: LandingEntry; file: string } {
  const entry: LandingEntry = { role, sha: "a".repeat(40), tick: 3, summary: "add a thing", enqueuedAt: Date.now() };
  enqueueLanding(root, entry);
  const head = headLanding(root);
  assert.ok(head, "fixture sanity: the landing is queued");
  return head;
}

test("landingUsage charges each run to both the authoring role and the landing's own accumulator", () => {
  const folded: PiRunResult[] = [];
  const author = { foldLandingUsage: (run: PiRunResult) => folded.push(run) } as unknown as LoopRunner;
  const { usage, foldUsage } = landingUsage(author);

  foldUsage(piRun(120, 0.5));
  foldUsage(piRun(80, 0.5));

  assert.deepEqual(
    folded.map((r) => r.outputTokens),
    [120, 80],
    "every landing pi run reaches the authoring role's fold",
  );
  assert.equal(usage.tokens, 200, "and the landing's own accumulator sums its tokens");
  assert.equal(usage.cost, 1, "…and its cost");
});

test("a landing's nonzero usage rides its landed event and the entry is dropped", () => {
  const root = makeRepo();
  const { entry, file } = queued(root);
  const state = freshLoopState("improve");
  state.phase = "review"; // an in-flight landing marker from the tick lifecycle
  state.ticks = entry.tick;

  writeLandingOutcome(root, entry, state, "changed", 1234, { tokens: 320, cost: 0.42 }, file);

  const landed = readEvents(root, 10).find((e) => e.type === "landed");
  assert.ok(landed, "the landing logged a landed event");
  assert.equal(landed.loop, "improve");
  assert.equal(landed.commit, entry.sha);
  assert.equal(landed.result, "changed");
  assert.equal(landed.durationMs, 1234);
  assert.equal(landed.tokens, 320, "the landing's own tokens are on the event");
  assert.equal(landed.costUsd, 0.42, "…and its own cost");
  assert.equal(state.lastResult, "changed");
  assert.equal(state.commits, 1, "a landed change counts a commit");
  assert.equal(state.phase, undefined, "a non-aborted outcome ends the in-flight phase");
  assert.equal(loadLoopState(root, "improve").commits, 1, "the folded state is persisted");
  assert.equal(queueDepth(root), 0, "the entry drops after its outcome");
});

test("a review-exempt landing (zero usage) omits the usage fields instead of logging zeros", () => {
  const root = makeRepo();
  const { entry, file } = queued(root, "organize");
  const state = freshLoopState("organize");

  writeLandingOutcome(root, entry, state, "changed", 5, { tokens: 0, cost: 0 }, file);

  const landed = readEvents(root, 10).find((e) => e.type === "landed");
  assert.ok(landed, "the landing logged a landed event");
  assert.ok(!("tokens" in landed), `no tokens key on a zero-usage event: ${JSON.stringify(landed)}`);
  assert.ok(!("costUsd" in landed), `no costUsd key on a zero-usage event: ${JSON.stringify(landed)}`);
});

test("an unexpected throw inside the landing degrades to an error outcome — the queue drains", async () => {
  const root = makeRepo();
  queued(root);
  // A poisoned entry: the sha names no commit anywhere in the repo (a lost pin, a corrupt
  // queue file), so the vet's ensureDetachedWorktree throws before any ref work — exactly the
  // "unexpected throw" the vet degrades (the pipeline's contract: a landing never rejects;
  // every outcome drops the entry; the change's marker record always goes).
  const author = new LoopRunner(root, "improve", defaultConfig(), "main");
  const { state } = author;
  state.phase = "review"; // the tick lifecycle's in-flight landing marker on the author's state
  assert.ok(await refSha(root, landingRefName("improve")) === null, "fixture sanity: no pin exists");

  const result = await landHead(root, author, defaultConfig(), "improve");

  assert.equal(result, "error", "the throw surfaces as an outcome, never a rejection");
  assert.equal(state.lastResult, "error");
  assert.ok(state.lastError && state.lastError.length > 0, "the error's message lands on the author's state");
  const failed = readEvents(root, 10).find((e) => e.type === "land_failed");
  assert.ok(failed, "even a throw logs land_failed");
  assert.equal(failed.result, "error");
  assert.equal(queueDepth(root), 0, "every outcome drops the entry — a poison entry must not wedge the drain");
  assert.equal(await refSha(root, landingRefName("improve")), null, "no pin existed and the error path fabricates none");
  assert.equal(readLandingMarker(root), null, "the in-flight marker is removed even on the error path");
  assert.equal(loadLoopState(root, "improve").lastResult, "error", "the outcome is persisted, not just folded in memory");
});

test("the write-back pairs the landing's result with the queued tick's summary, across a reload", () => {
  // BUGS.md 2026-09-23: the queued tick left the prior last-result pair in place and stashed
  // its own summary; the landing — here resolving in a later process on a disk-loaded state,
  // as a durable queue entry can — records its result beside THAT summary and consumes it.
  const root = makeRepo();
  const { entry, file } = queued(root);
  const tick = freshLoopState("improve");
  applyTickOutcome(tick, defaultConfig(), "improve", { result: "no_change", summary: "found nothing" });
  applyTickOutcome(tick, defaultConfig(), "improve", {
    result: "queued",
    summary: `${entry.summary} (high friction: 90 turns / 45m)`,
    commit: entry.sha,
  });
  saveLoopState(root, tick);
  const pending = loadLoopState(root, "improve");
  assert.equal(pending.lastResult, "no_change", "fixture sanity: the prior pair is what persisted");

  writeLandingOutcome(root, entry, pending, "rejected", 10, { tokens: 0, cost: 0 }, file);

  const saved = loadLoopState(root, "improve");
  assert.equal(saved.lastResult, "rejected");
  assert.equal(saved.lastSummary, "add a thing (high friction: 90 turns / 45m)");
  assert.equal(saved.queuedSummary, undefined, "the persisted stash is consumed");
});

test("a failed landing logs land_failed with its usage and counts no commit", () => {
  const root = makeRepo();
  const { entry, file } = queued(root);
  const state = freshLoopState("improve");

  writeLandingOutcome(root, entry, state, "merge_conflict", 900, { tokens: 12, cost: 0.01 }, file);

  const failed = readEvents(root, 10).find((e) => e.type === "land_failed");
  assert.ok(failed, "a non-changed outcome logs land_failed, not landed");
  assert.equal(failed.result, "merge_conflict");
  assert.equal(failed.tokens, 12, "spend on a failed landing is still recorded");
  assert.equal(state.lastResult, "merge_conflict");
  assert.equal(state.commits, 0, "a non-changed outcome is not a commit");
  assert.equal(queueDepth(root), 0, "every outcome drops the entry — retry rides the pin, not the queue");
});

// The landing cell's stage (BUGS.md 2026-09-22, re-opened 2026-09-23): the landing path
// advances the marker's stage and the dashboards render it.
test("setLandingStage advances only its own role's record, and only its stage", () => {
  const root = makeRepo();
  // No marker — the shared gate running inside a tick (leftover recovery): a no-op that
  // creates nothing; the gate must never invent landing state.
  setLandingStage(root, "clean", "reviewing");
  assert.equal(readLandingMarker(root), null);
  addLandingChange(root, { role: "bugfix", sha: "a".repeat(40), tick: 1, summary: "s", enqueuedAt: 1 }, new Set());
  const before = readLandingMarker(root)!;
  // Another role's gate (one with no record of its own) must not restage it.
  setLandingStage(root, "clean", "reviewing");
  assert.deepEqual(readLandingMarker(root), before, "a gate with no record changes nothing");
  // The matching role's stage advances; identity (the snapshot cross-check's sha) and the
  // landing's startedAt (the cell's elapsed) are preserved.
  setLandingStage(root, "bugfix", "build-check");
  const after = readLandingMarker(root)!;
  assert.deepEqual(after.changes, [{ ...before.changes![0]!, stage: "build-check" }]);
  assert.deepEqual([after.role, after.sha, after.startedAt, after.stage], [before.role, before.sha, before.startedAt, "build-check"]);
  // An older generation's one-change marker carries no records: no pipeline change is staged on it.
  const single = { role: "bugfix", sha: "b", summary: "s", startedAt: 2, stage: "merging" } as const;
  writeLandingMarker(root, single);
  setLandingStage(root, "bugfix", "reviewing");
  assert.deepEqual(readLandingMarker(root), single);
});

// The marker (BUGS.md 2026-09-23) carries one record per change the pipeline holds: each vet
// adds its own, the gates and the merge advance only their change's record, each outcome
// removes it, and the top level follows the first change in flight for observers that read
// only it.
test("the marker's records come and go per change, and its top level follows the first change in flight", () => {
  const root = makeRepo();
  const entries = Object.fromEntries(
    ["alpha", "beta", "gamma"].map((role) => [role, { role, sha: `${role}-sha`, tick: 1, summary: `${role} work`, enqueuedAt: 1 }]),
  ) as Record<string, LandingEntry>;
  const records = () => readLandingMarker(root)!.changes!.map((c) => `${c.role}=${c.status}/${c.stage ?? "-"}`);

  // Two vets at once: each opens its own record, with its own start, at the git steps.
  const before = Date.now();
  addLandingChange(root, entries.alpha!, new Set(["alpha"]));
  addLandingChange(root, entries.beta!, new Set(["alpha", "beta"]));
  setLandingStage(root, "beta", "reviewing");
  setLandingStage(root, "delta", "reviewing"); // no record: a no-op
  assert.deepEqual(records(), ["alpha=landing/merging", "beta=landing/reviewing"]);
  assert.ok(readLandingMarker(root)!.changes![0]!.startedAt! >= before, "the change's own start");
  assert.equal(readLandingMarker(root)!.role, "alpha", "the top level names the first change in flight");
  assert.equal(readLandingMarker(root)!.stage, "merging", "at that change's own stage");

  // alpha's vet approves it: it waits for the merge, and beta, still under review, becomes the
  // top level — with its own start and its own stage.
  setLandingStage(root, "alpha", "merging");
  setLandingChangeStatus(root, "alpha", "vetted");
  const marker = readLandingMarker(root)!;
  assert.deepEqual(
    [marker.role, marker.sha, marker.stage, marker.startedAt],
    ["beta", "beta-sha", "reviewing", marker.changes![1]!.startedAt],
  );

  // A record the pipeline no longer holds (a crashed generation's) never rides along.
  addLandingChange(root, entries.gamma!, new Set(["beta", "gamma"]));
  assert.deepEqual(records(), ["beta=landing/reviewing", "gamma=landing/merging"]);
  addLandingChange(root, entries.alpha!, new Set(["alpha", "beta", "gamma"]));

  // The merge reaches alpha: re-entering `landing` keeps its first start and restarts at the
  // git steps.
  const alphaStart = readLandingMarker(root)!.changes!.find((c) => c.role === "alpha")!.startedAt;
  setLandingChangeStatus(root, "alpha", "vetted");
  setLandingChangeStatus(root, "alpha", "landing");
  const alpha = readLandingMarker(root)!.changes!.find((c) => c.role === "alpha")!;
  assert.equal(alpha.stage, "merging");
  assert.equal(alpha.startedAt, alphaStart, "the elapsed keeps counting from the vet's start");

  // Each outcome removes its record; the last one takes the marker with it.
  removeLandingChange(root, "beta");
  removeLandingChange(root, "delta"); // no record: a no-op
  assert.deepEqual(landingChanges(readLandingMarker(root)!).map((c) => c.role), ["gamma", "alpha"]);
  removeLandingChange(root, "gamma");
  removeLandingChange(root, "alpha");
  assert.equal(readLandingMarker(root), null, "the marker goes with its last record");
});

// landingChanges reads the shapes every generation wrote: an older generation's one-change
// marker is one `landing` record at the marker's stage.
test("landingChanges reads a one-change marker as one landing record", () => {
  const single = { role: "clean", sha: "c", summary: "s", startedAt: 5, stage: "reviewing" } as const;
  assert.deepEqual(landingChanges(single), [{ ...single, status: "landing" }]);
});

test("a queued landing's record walks build-check → reviewing → merging while each phase runs", async () => {
  const root = makeRepo();
  // A pinned change ahead of main, exactly what a tick leaves behind for the pipeline.
  sh(root, "git", "checkout", "--detach");
  fs.appendFileSync(path.join(root, "seed.txt"), "the work\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "the work");
  const sha = sh(root, "git", "rev-parse", "HEAD");
  sh(root, "git", "checkout", "main");
  await setRef(root, landingRefName("improve"), sha);
  const entry: LandingEntry = { role: "improve", sha, tick: 3, summary: "the work", enqueuedAt: Date.now() };
  enqueueLanding(root, entry);

  // Every observation point appends the marker's stage as the observers would read it: the
  // project's declared check (the vet's gate pre-check, then the merge's in-lock re-check), and
  // the reviewer run. The reviewer also moves main, so the in-lock re-check has a rebased
  // tree to verify — the merge step's own long phase.
  const rec = path.join(tmpdir(), "stages");
  const stageOf = `sed -n 's/.*"stage": *"\\([a-z-]*\\)".*/\\1/p' '${landingStatePath(root)}' | head -n 1`;
  const config = { ...defaultConfig(), check: { command: `echo "check:$(${stageOf})" >> '${rec}'` } };
  const restore = fakePi(
    [
      `echo "review:$(${stageOf})" >> '${rec}'`,
      `git -C '${root}' commit -q --allow-empty -m 'main moves under the landing'`,
      `printf '%s\\n' '${assistantLine("VERDICT: approve")}'`,
    ].join("\n"),
  );
  try {
    const author = new LoopRunner(root, "improve", config, "main");

    const result = await landHead(root, author, config, "improve");

    assert.equal(result, "changed", `the landing lands: ${author.state.lastError ?? ""}`);
    assert.deepEqual(
      fs.readFileSync(rec, "utf8").trim().split("\n"),
      ["check:build-check", "review:reviewing", "check:merging"],
      "each phase ran under its own stage",
    );
    assert.equal(readLandingMarker(root), null, "the marker is removed after the outcome");
  } finally {
    restore();
  }
});
