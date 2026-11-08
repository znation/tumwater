// liveMergeMarker's cross-check against the queue, called directly with in-memory markers: the
// per-change record filtering the CLI and snapshot tests only reach through a single-change marker.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ciParityForPoll, configForStatus, configStateForStatus, liveMergeMarker, mainCheckForPoll, remoteCiForPoll } from "../src/status/status-polls.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { recordParity } from "../src/observer/ci-parity.js";
import { recordRemoteCi } from "../src/observer/remote-ci.js";
import { configPath, remoteCiPath } from "../src/paths.js";
import { commitIn, makeRepo, mainSha, writeConfig, writeMalformedJson } from "./fixtures/repo-fixtures.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import type { MergeChange, MergeInFlight } from "../src/merge/merge-slot.js";

const sha = (c: string): string => c.repeat(40);

function record(role: string, c: string, status: MergeChange["status"]): MergeChange {
  return { role, sha: sha(c), summary: `${role} change`, status };
}

function marker(changes?: unknown[]): MergeInFlight {
  return {
    role: "feature",
    sha: sha("a"),
    summary: "top",
    startedAt: 1_000,
    ...(changes ? { changes: changes as MergeChange[] } : {}),
  };
}

test("liveMergeMarker shows a single-change marker only while its sha is queued", () => {
  const single = marker();
  assert.equal(liveMergeMarker(single, new Set([sha("a")])), single);
  assert.equal(liveMergeMarker(single, new Set([sha("b")])), undefined);
});

test("liveMergeMarker keeps only the queued records and hides a marker whose queued records are all done", () => {
  const merging = record("feature", "a", "merging");
  const done = record("fixer", "b", "done");
  const approved = record("review", "c", "approved");
  const m = marker([merging, done, approved]);
  const live = liveMergeMarker(m, new Set([sha("a"), sha("b")]));
  assert.deepEqual(live?.changes, [merging, done]);
  assert.equal(liveMergeMarker(m, new Set([sha("b")])), undefined);
});

test("liveMergeMarker drops a null or malformed record instead of throwing", () => {
  const valid = record("feature", "a", "merging");
  const m = marker([null, 7, { role: "x" }, valid]);
  const live = liveMergeMarker(m, new Set([sha("a")]));
  assert.deepEqual(live?.changes, [valid]);
});

test("ciParityForPoll reads current, stale, failed and none", () => {
  const root = makeRepo();
  const cfg = configForStatus(root);
  // No ledger yet: no badge at all.
  assert.equal(ciParityForPoll(root, cfg), undefined, "a repo with no parity record reads as none");

  // A passing record at main's current head is current.
  const tip = mainSha(root);
  recordParity(root, tip, "passed", 1_000);
  assert.deepEqual(ciParityForPoll(root, cfg), { state: "current", covered: tip, lastRunAt: 1_000 });

  // Once main moves, the same record is stale.
  commitIn(root, "move main");
  const stale = ciParityForPoll(root, cfg);
  assert.equal(stale?.state, "stale");
  assert.equal(stale?.covered, tip, "the covered tip is the recorded one, before the move");

  // A failed last run is failed regardless of the tip.
  recordParity(root, mainSha(root), "failed", 2_000);
  assert.deepEqual(ciParityForPoll(root, cfg), { state: "failed", covered: mainSha(root), lastRunAt: 2_000 });
});

test("remoteCiForPoll reads each result, reads none without a record, and serves an unchanged ledger from the stat cache", (t) => {
  const root = makeRepo();
  assert.equal(remoteCiForPoll(root), undefined, "no record: no badge data");

  // Each result shape reads through, sha riding only the results that name one.
  recordRemoteCi(root, "znation/tumwater", "passed", 1_000, "3e450b0c4d9e8f7a6b");
  assert.deepEqual(remoteCiForPoll(root), { result: "passed", sha: "3e450b0c4d9e8f7a6b", checkedAt: 1_000 });
  recordRemoteCi(root, "znation/tumwater", "failed", 2_000, "3e450b0c4d9e8f7a6b");
  assert.deepEqual(remoteCiForPoll(root), { result: "failed", sha: "3e450b0c4d9e8f7a6b", checkedAt: 2_000 });
  recordRemoteCi(root, "znation/tumwater", "pending", 3_000, "3e450b0c4d9e8f7a6b");
  assert.deepEqual(remoteCiForPoll(root), { result: "pending", sha: "3e450b0c4d9e8f7a6b", checkedAt: 3_000 });
  recordRemoteCi(root, "znation/tumwater", "unavailable", 4_000, undefined, "gh: logged out");
  assert.deepEqual(remoteCiForPoll(root), { result: "unavailable", checkedAt: 4_000 }, "unavailable carries no sha");

  // The stat-keyed cache (the acceptance criterion: one stat per poll while unchanged, a
  // re-read after a write). Observable two halves: while the ledger's file is untouched the
  // poll keeps serving the same record, and a write invalidates the identity so the next poll
  // re-reads the new record.
  recordRemoteCi(root, "znation/tumwater", "passed", 5_000, "aabbccddeeff00112233");
  const first = remoteCiForPoll(root);
  // A cache hit must not re-read the ledger at all. Counting the file's reads (not just
  // comparing values) is what pins the cache: a poll that bypassed it would still return the
  // same record and pass a bare equality assertion.
  const ledger = remoteCiPath(root);
  const originalReadFileSync = fs.readFileSync.bind(fs);
  let reads = 0;
  t.mock.method(fs, "readFileSync", ((...args: unknown[]) => {
    if (args[0] === ledger) reads++;
    return originalReadFileSync(...(args as [string | URL, "utf8"]));
  }) as typeof fs.readFileSync);
  try {
    const again = remoteCiForPoll(root);
    assert.deepEqual(again, first, "an unchanged ledger serves the cached record");
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(reads, 0, "an unchanged ledger must not be re-read on the next poll");
  // The write changes the file's size (a longer checkedAt), so the invalidation is
  // deterministic regardless of the filesystem's mtime granularity.
  recordRemoteCi(root, "znation/tumwater", "failed", 6_000_000, "aabbccddeeff00112233");
  const afterWrite = remoteCiForPoll(root);
  assert.notDeepEqual(afterWrite, first, "a write invalidates the cache and the next poll re-reads");
  assert.equal(afterWrite?.result, "failed");
});

test("mainCheckForPoll carries red detail from the main_culprit verdict matching the checked tip", () => {
  const root = makeRepo();
  const tip = mainSha(root);
  // A real-shaped build_check (no failingTests) plus a main_culprit verdict naming the tip it
  // checked — the writer's two real shapes — drive the red detail.
  writeEvents(root, [
    { source: "merge", type: "build_check", scope: "merge", status: "failed", script: "npm test", durationMs: 1, ts: 1_000 },
    { source: "tumwater", type: "main_culprit", commit: tip, runner: "feature", failingTests: ["a", "b"], ts: 2_000 },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.status, "failed");
  assert.deepEqual(result?.red, { failingTests: ["a", "b"], culprit: { commit: tip, runner: "feature" } });
});

test("a main_culprit naming the open spell's opener carries red detail even when it is not the newest tip", () => {
  const root = makeRepo();
  // The watch names the opener of the red, not the newest tip: a doc-exempt tip landed after
  // the red opened, so the derived tip sha differs from the blamed commit. The blame still
  // publishes — the red is ongoing and the opener caused it.
  writeEvents(root, [
    { source: "merge", type: "build_check", scope: "merge", status: "failed", script: "npm test", durationMs: 1, ts: 1_000 },
    { source: "tumwater", type: "main_culprit", commit: sha("c"), runner: "feature", failingTests: ["a"], ts: 2_000 },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.status, "failed");
  assert.deepEqual(result?.red, { failingTests: ["a"], culprit: { commit: sha("c"), runner: "feature" } });
});

test("a poll whose tip re-checked the open red carries red detail blaming the spell's opener", () => {
  // The tip this poll derives (main's head) is the doc-exempt re-check of the open red; the
  // watch's one culprit names the OPENER (INV-AZ4). The poll's sha is the re-check, so the
  // detail is attributed through the spell's opener — never through a verdict the watch wrote
  // for a different head.
  const root = makeRepo();
  const opener = mainSha(root); // the spell's opener, named by the watch's main_culprit
  fs.writeFileSync(path.join(root, "doc.md"), "doc re-check\n");
  commitIn(root, "doc re-check");
  const tip = mainSha(root); // the re-checked tip — the sha this poll derives
  assert.notEqual(tip, opener);
  writeEvents(root, [
    { source: "merge", type: "build_check", scope: "merge", status: "failed", script: "npm test", durationMs: 1, ts: 1_000 },
    { source: "tumwater", type: "main_culprit", commit: opener, runner: "feature", failingTests: ["a", "b"], ts: 2_000 },
    // A newer merge-scope failure for the re-checked tip, after the opener's verdict:
    { source: "merge", type: "build_check", scope: "merge", status: "failed", script: "npm test", durationMs: 1, ts: 3_000 },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.status, "failed");
  assert.equal(result?.sha, tip);
  assert.deepEqual(result?.red, { failingTests: ["a", "b"], culprit: { commit: opener, runner: "feature" } });
});

test("a main_culprit whose spell a later passing check closed carries no red detail", () => {
  const root = makeRepo();
  // The blame's spell was closed by a passing full main_check after it: the derived tip is a
  // different head and the opener is gone, so the stale blame is not borrowed onto the red.
  writeEvents(root, [
    { source: "merge", type: "build_check", scope: "merge", status: "failed", script: "npm test", durationMs: 1, ts: 1_000 },
    { source: "tumwater", type: "main_culprit", commit: sha("c"), runner: "feature", failingTests: ["a"], ts: 2_000 },
    { source: "tumwater", type: "main_check", sha: sha("d"), status: "passed", durationMs: 120_000, ts: 3_000 },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.status, "failed");
  assert.equal(result?.red, undefined);
});

test("a passing check carries no red detail", () => {
  const root = makeRepo();
  writeEvents(root, [
    { source: "merge", type: "build_check", scope: "merge", status: "passed", script: "npm test", durationMs: 1, ts: 1_000 },
    { source: "tumwater", type: "main_culprit", commit: mainSha(root), runner: "feature", failingTests: ["a"], ts: 2_000 },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.status, "passed");
  assert.equal(result?.red, undefined);
});

test("mainCheckForPoll derives nextDueAt from the verdict's checked time and the interval (part 4/4)", () => {
  const root = makeRepo();
  const tip = mainSha(root);
  const checkedAt = Date.now() - 23 * 60_000; // a full green 23 min old
  writeEvents(root, [
    { source: "merge", type: "build_check", scope: "merge", status: "passed", script: "npm test", ts: checkedAt },
    { source: "lander", type: "merge_done", commit: tip, ts: checkedAt + 1 },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.status, "passed");
  assert.equal(result?.checkedAt, checkedAt, "no settledAt on the event: the checked time falls back to the log stamp");
  assert.equal(result?.nextDueAt, checkedAt + 60 * 60_000, "next due is the verdict's checked time plus the default 60-minute interval");
});

test("a red verdict carries checkedAt but no interval nextDueAt (a red is rechecked on each new head)", () => {
  const root = makeRepo();
  const tip = mainSha(root);
  const ts = Date.now() - 5 * 60_000;
  writeEvents(root, [
    { source: "merge", type: "build_check", scope: "merge", status: "failed", script: "npm test", ts },
    { source: "lander", type: "merge_done", commit: tip, ts: ts + 1 },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.status, "failed");
  assert.equal(result?.checkedAt, ts, "the red's age still reads from its run");
  assert.equal(result?.nextDueAt, undefined, "a red has no interval due: the watch rechecks it on the next head");
});

test("a baseline check names the head it covered, not a merge that landed after it (part 4/4)", () => {
  const root = makeRepo();
  const checkedHead = "a".repeat(40);
  const laterHead = "b".repeat(40);
  const ts = Date.now() - 30 * 60_000;
  writeEvents(root, [
    { source: "lander", type: "merge_done", commit: checkedHead, ts: ts - 1_000 },
    { source: "tumwater", type: "build_check", scope: "baseline", status: "passed", script: "npm test", settledAt: ts, ts },
    // Main moved on before the next hourly run: the verdict still covers the older head.
    { source: "lander", type: "merge_done", commit: laterHead, ts: ts + 60_000 },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.sha, checkedHead, "the hour-old full verdict stays attributed to the head it ran on");
  assert.equal(result?.checkedAt, ts);
  assert.equal(result?.nextDueAt, ts + 60 * 60_000, "the due clock still runs from that covered verdict");
});

test("a baseline check names the head it ran on when a merge lands during its run", () => {
  const root = makeRepo();
  const coveredHead = "a".repeat(40);
  const laterHead = "b".repeat(40);
  const spawnedAt = Date.now() - 30 * 60_000;
  writeEvents(root, [
    { source: "lander", type: "merge_done", commit: coveredHead, ts: spawnedAt - 1_000 },
    // Main moves while the baseline check is in flight: the check never saw this merge.
    { source: "lander", type: "merge_done", commit: laterHead, ts: spawnedAt + 5_000 },
    {
      source: "tumwater",
      type: "build_check",
      scope: "baseline",
      status: "passed",
      script: "npm test",
      spawnedAt,
      settledAt: spawnedAt + 60_000,
      ts: spawnedAt + 60_000,
    },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.sha, coveredHead, "the verdict covers the head main held when the run spawned");
  assert.equal(result?.checkedAt, spawnedAt + 60_000);
});

test("mainCheckForPoll prefers the run's settle time as checkedAt when the event carries it", () => {
  const root = makeRepo();
  const tip = mainSha(root);
  const ts = Date.now() - 20 * 60_000;
  writeEvents(root, [
    { source: "merge", type: "build_check", scope: "merge", status: "passed", script: "npm test", settledAt: ts + 2_000, ts },
    { source: "lander", type: "merge_done", commit: tip, ts: ts + 1 },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.checkedAt, ts + 2_000, "the run's settle stamp names when the check finished");
  assert.equal(result?.nextDueAt, ts + 2_000 + 60 * 60_000);
});

test("an interval of 0 (one full run per new head) leaves nextDueAt absent", () => {
  const root = makeRepo();
  const tip = mainSha(root);
  const ts = Date.now() - 5 * 60_000;
  writeEvents(root, [
    { source: "merge", type: "build_check", scope: "merge", status: "passed", script: "npm test", ts },
    { source: "lander", type: "merge_done", commit: tip, ts: ts + 1 },
  ]);
  writeConfig(root, { provider: "p", model: "m", check: { fullIntervalMinutes: 0 } });
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.checkedAt, ts);
  assert.equal(result?.nextDueAt, undefined, "interval 0: every new head is checked, nothing is due");
});

test("a cleared red whose confirming full run has not settled reads cleared (part 4/4)", () => {
  const root = makeRepo();
  const tip = mainSha(root);
  writeEvents(root, [
    { source: "merge", type: "build_check", scope: "merge", status: "failed", script: "npm test", ts: 1_000 },
    { source: "tumwater", type: "main_culprit", commit: tip, runner: "feature", failingTests: ["a"], ts: 2_000 },
    // The red cleared: every open failure passed on this head, and the one confirming full run
    // started at once — it has not settled yet (no newer build_check or main_check follows).
    { source: "tumwater", type: "main_check", sha: tip, status: "passed", cleared: true, durationMs: 0, covered: 2, ts: 3_000 },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.cleared, true);
  assert.equal(result?.sha, tip);
  assert.equal(result?.status, "passed");
  assert.equal(result?.at, 3_000);
  assert.equal(result?.checkedAt, undefined, "no full verdict: no checked time, no next due");
  assert.equal(result?.red, undefined, "the pre-clearing red is not re-asserted once the spell cleared");
});

test("a cleared red ends when its confirming full run settles", () => {
  const root = makeRepo();
  const tip = mainSha(root);
  writeEvents(root, [
    { source: "merge", type: "build_check", scope: "merge", status: "failed", script: "npm test", ts: 1_000 },
    { source: "tumwater", type: "main_check", sha: tip, status: "passed", cleared: true, durationMs: 0, covered: 2, ts: 2_000 },
    // The confirming full run settled green on the same head: a settled main_check and a
    // newer baseline build_check both follow the cleared event, so cleared is no longer the
    // newest state — the badge reads the confirming verdict, not "full check running".
    { source: "tumwater", type: "main_check", sha: tip, status: "passed", durationMs: 120_000, covered: 2, ts: 3_000 },
    { source: "tumwater", type: "build_check", scope: "baseline", status: "passed", script: "npm test", ts: 4_000 },
  ]);
  const result = mainCheckForPoll(root, configForStatus(root));
  assert.equal(result?.cleared, undefined);
  assert.equal(result?.status, "passed");
  assert.equal(result?.checkedAt, 4_000);
  assert.equal(result?.at, 4_000);
});

test("configStateForStatus reports why the live config is not fresh while configForStatus keeps the last known-good one", () => {
  const root = makeRepo();
  // A valid config loads with no problem and becomes the last known-good one.
  const cfg = loadConfig(root);
  cfg.maxConcurrent = 4;
  saveConfig(root, cfg);
  assert.equal(configForStatus(root).maxConcurrent, 4);
  assert.equal(configStateForStatus(root).problem, undefined);

  // A malformed file keeps the last known-good config and reports the parse error.
  writeMalformedJson(configPath(root));
  const broken = configStateForStatus(root);
  assert.equal(broken.config.maxConcurrent, 4, "last known-good config is kept");
  assert.match(broken.problem ?? "", /is not valid JSON/);

  // A validation error (valid JSON, invalid value) reports the error and keeps last-good.
  writeConfig(root, { maxConcurrent: "six" });
  const invalid = configStateForStatus(root);
  assert.equal(invalid.config.maxConcurrent, 4, "a validation error also keeps the last good config");
  assert.ok(invalid.problem, "a validation error is surfaced as the problem");

  // A deleted file keeps the last known-good config and names the missing file.
  fs.rmSync(path.join(root, "tumwater.json"));
  const gone = configStateForStatus(root);
  assert.equal(gone.config.maxConcurrent, 4, "a missing file keeps the last known-good config");
  assert.match(gone.problem ?? "", /tumwater\.json is missing — the team is running on its last known-good config/);
  assert.equal(configForStatus(root).maxConcurrent, 4, "configForStatus delegates to the same read");
});
