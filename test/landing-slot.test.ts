/** Unit coverage for src/landing-slot.ts's usage accounting — the seam that charges a landing's
 * own pi runs (reviewer + conflict resolution) to the AUTHORING role's live state and records
 * them on the landed/land_failed event. The full landing flow is pinned end-to-end through
 * landQueuedEntry in the loop and orchestrator tests, but those drive a fake pi that reports no
 * usage, so the nonzero-usage branches were never exercised: a landing whose reviewer burns
 * tokens and cost is exactly what feeds `tumwater report` and the daily budget cap, and a broken
 * fold there would silently lose that spend. These pin the accounting branches directly. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  landingChanges,
  landingUsage,
  landQueuedEntry,
  readLandingMarker,
  setLandingChangeStatus,
  setLandingStage,
  writeBatchLandingMarker,
  writeLandingMarker,
  writeLandingOutcome,
} from "../src/landing-slot.js";
import { landingRefName, landingStatePath } from "../src/paths.js";
import { refSha, setRef } from "../src/git.js";
import { defaultConfig } from "../src/config.js";
import { applyTickOutcome, freshLoopState, loadLoopState, saveLoopState } from "../src/state.js";
import { enqueueLanding, headLanding, queueDepth } from "../src/land-queue.js";
import { readEvents } from "../src/events.js";
import type { LoopRunner } from "../src/loop.js";
import type { LandingEntry, PiRunResult } from "../src/types.js";
import { assistantLine, fakePi, makeRepo, sh, tmpdir } from "./util.js";

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
  const { entry, file } = queued(root);
  // A poisoned entry: the sha names no commit anywhere in the repo (a lost pin, a corrupt
  // queue file), so ensureDetachedWorktree throws before any ref work — exactly the
  // "unexpected throw" the catch-all exists for (the module contract: landQueuedEntry never
  // rejects; every outcome drops the entry; the 4/5 marker removal always runs).
  const state = freshLoopState("improve");
  state.phase = "review"; // the tick lifecycle's in-flight landing marker on the author's state
  const author = {
    state,
    runLandingPi: () => {
      throw new Error("reviewer must not be reached");
    },
    foldLandingUsage: () => {},
  } as unknown as LoopRunner;
  assert.ok(await refSha(root, landingRefName("improve")) === null, "fixture sanity: no pin exists");

  const result = await landQueuedEntry(
    root, entry, file, author, defaultConfig(), "main", new AbortController().signal,
  );

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
test("setLandingStage advances only a live marker naming its own role, and only its stage", () => {
  const root = makeRepo();
  // No marker — the shared gate running inside a tick (leftover recovery): a no-op that
  // creates nothing; the gate must never invent landing state.
  setLandingStage(root, "clean", "reviewing");
  assert.equal(readLandingMarker(root), null);
  // Another role's single-landing marker is untouched: a gate running for any other role (a
  // leftover-recovery gate inside that role's own tick) must not restage it.
  const marker = { role: "bugfix", sha: "a".repeat(40), summary: "s", startedAt: 1, stage: "merging" } as const;
  writeLandingMarker(root, marker);
  setLandingStage(root, "clean", "reviewing");
  assert.deepEqual(readLandingMarker(root), marker, "another role's marker keeps every field");
  // The matching role's stage advances; identity (the snapshot cross-check's sha) and the
  // landing's startedAt (the cell's elapsed) are preserved.
  setLandingStage(root, "bugfix", "build-check");
  assert.deepEqual(readLandingMarker(root), { ...marker, stage: "build-check" });
  // An older writer's stage-less marker gains one.
  fs.writeFileSync(landingStatePath(root), JSON.stringify({ role: "bugfix", sha: "b", summary: "s", startedAt: 2 }));
  setLandingStage(root, "bugfix", "reviewing");
  assert.deepEqual(readLandingMarker(root), { role: "bugfix", sha: "b", summary: "s", startedAt: 2, stage: "reviewing" });
});

// A batch marker (BUGS.md 2026-09-23) carries one record per batched change: the status hook
// and each change's own gate advance only that change's record, and the top level follows the
// first change in flight for observers that read only it.
test("a batch marker's records advance per change, and its top level follows the first change in flight", () => {
  const root = makeRepo();
  const entries: LandingEntry[] = ["alpha", "beta", "gamma"].map((role) => ({
    role,
    sha: `${role}-sha`,
    tick: 1,
    summary: `${role} work`,
    enqueuedAt: 1,
  }));
  writeBatchLandingMarker(root, entries, 1000);
  const records = () => readLandingMarker(root)!.changes!.map((c) => `${c.role}=${c.status}/${c.stage ?? "-"}`);
  assert.deepEqual(records(), ["alpha=waiting/-", "beta=waiting/-", "gamma=waiting/-"]);
  assert.equal(readLandingMarker(root)!.stage, "merging", "the marker opens naming a stage, like every writer");

  // Two gates at once: each is stamped with its own start and staged on its own record.
  const before = Date.now();
  setLandingChangeStatus(root, "alpha", "landing");
  setLandingChangeStatus(root, "beta", "landing");
  setLandingStage(root, "beta", "reviewing");
  setLandingStage(root, "delta", "reviewing"); // no record: a no-op
  assert.deepEqual(records(), ["alpha=landing/merging", "beta=landing/reviewing", "gamma=waiting/-"]);
  const alphaStart = readLandingMarker(root)!.changes![0]!.startedAt!;
  assert.ok(alphaStart >= before, "the change's own start, not the batch's");
  assert.equal(readLandingMarker(root)!.role, "alpha", "the top level names the first change in flight");

  // alpha's gate returns and rejects: beta, still under review, becomes the top level — with
  // its own start and its own stage.
  setLandingStage(root, "alpha", "merging");
  setLandingChangeStatus(root, "alpha", "done");
  const marker = readLandingMarker(root)!;
  assert.deepEqual(
    [marker.role, marker.sha, marker.stage, marker.startedAt],
    ["beta", "beta-sha", "reviewing", marker.changes![1]!.startedAt],
  );

  // Re-entering `landing` (the stack) keeps the first start and restarts at the git steps.
  setLandingChangeStatus(root, "beta", "approved");
  setLandingChangeStatus(root, "beta", "landing");
  const beta = readLandingMarker(root)!.changes![1]!;
  assert.equal(beta.stage, "merging");
  assert.equal(beta.startedAt, marker.changes![1]!.startedAt, "the elapsed keeps counting from the gate start");
  assert.deepEqual(landingChanges(readLandingMarker(root)!).map((c) => c.role), ["alpha", "beta", "gamma"]);
});

// landingChanges reads the shapes every generation wrote: a single landing's marker (and an
// older generation's head-only batch marker) is one `landing` record at the marker's stage.
test("landingChanges reads a single-landing marker as one landing record", () => {
  const single = { role: "clean", sha: "c", summary: "s", startedAt: 5, stage: "reviewing" } as const;
  assert.deepEqual(landingChanges(single), [{ ...single, status: "landing" }]);
});

test("a queued landing's marker walks build-check → reviewing → merging while each phase runs", async () => {
  const root = makeRepo();
  // A pinned change ahead of main, exactly what a tick leaves behind for the slot.
  sh(root, "git", "checkout", "--detach");
  fs.appendFileSync(path.join(root, "seed.txt"), "the work\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "the work");
  const sha = sh(root, "git", "rev-parse", "HEAD");
  sh(root, "git", "checkout", "main");
  await setRef(root, landingRefName("improve"), sha);
  const entry: LandingEntry = { role: "improve", sha, tick: 3, summary: "the work", enqueuedAt: Date.now() };
  enqueueLanding(root, entry);
  const head = headLanding(root);
  assert.ok(head, "fixture sanity: the landing is queued");

  // Every observation point appends the marker's stage as the observers would read it: the
  // project's declared check (the gate's pre-check, then the in-lock landing re-check), and
  // the reviewer run. The reviewer also moves main, so the in-lock re-check has a rebased
  // tree to verify — the merge step's own long phase.
  const rec = path.join(tmpdir(), "stages");
  const stageOf = `sed -n 's/.*"stage": *"\\([a-z-]*\\)".*/\\1/p' '${landingStatePath(root)}'`;
  const config = { ...defaultConfig(), check: { command: `echo "check:$(${stageOf})" >> '${rec}'` } };
  const restore = fakePi(
    [
      `echo "review:$(${stageOf})" >> '${rec}'`,
      `git -C '${root}' commit -q --allow-empty -m 'main moves under the landing'`,
      `printf '%s\\n' '${assistantLine("VERDICT: approve")}'`,
    ].join("\n"),
  );
  try {
    const state = freshLoopState("improve");
    const author = {
      state,
      runLandingPi: () => {
        throw new Error("no conflict resolution in this landing");
      },
      foldLandingUsage: () => {},
    } as unknown as LoopRunner;

    const result = await landQueuedEntry(root, head.entry, head.file, author, config, "main", new AbortController().signal);

    assert.equal(result, "changed", `the landing lands: ${state.lastError ?? ""}`);
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
