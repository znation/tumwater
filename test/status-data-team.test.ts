// The fleet-health facet of the status-data suite: snapshot()'s pause markers, mainCheck
// badge, published disk state, and its tolerance of a foreign orchestrator.json shape. Split by
// facet from one status-data test file; the core contract and poll cache live in
// status-data.test.ts.

import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "../src/status/status-data.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { initProject } from "../src/init/init.js";
import { mainSha, makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { LOCAL_FREE_MODELS_JSON, writeModelsFile } from "./fixtures/models-fixtures.js";
import { ensureParentDir } from "../src/files/files.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { orchestratorStatePath, pausedPath, pausedRolesPath } from "../src/paths.js";
import { writeJsonFile } from "../src/files/json-files.js";
import { pauseFleet, pauseRole, resumeFleet } from "../src/team/team-state.js";

test("pausedRolesUntil carries a timed role pause's shared deadline only while the set is non-empty", async () => {
  const repo = tmpdir();
  await initProject(repo, "paused roles until");
  assert.equal(snapshot(repo).pausedRolesUntil, undefined);
  pauseRole(repo, "clean");
  assert.equal(snapshot(repo).pausedRolesUntil, undefined, "a standing role pause has no deadline");
  const until = Date.now() + 30 * 60_000;
  pauseRole(repo, "clean", until);
  assert.equal(snapshot(repo).pausedRolesUntil, until);
  assert.equal((statusPayload(repo) as { pausedRolesUntil?: number }).pausedRolesUntil, until);
  fs.writeFileSync(pausedRolesPath(repo), JSON.stringify({ roles: ["clean"], at: Date.now() - 60_000, until: Date.now() - 1 }));
  assert.equal(snapshot(repo).pausedRolesUntil, undefined, "an expired deadline is absent");
  fs.writeFileSync(pausedRolesPath(repo), JSON.stringify({ roles: [], at: Date.now(), until }));
  assert.equal(snapshot(repo).pausedRolesUntil, undefined, "an empty set advertises no deadline");
});

test("pausedUntil carries only a standing fleet timed-pause deadline", async () => {
  const repo = tmpdir();
  await initProject(repo, "paused until");
  assert.equal(snapshot(repo).pausedUntil, undefined, "no marker: absent");

  pauseFleet(repo);
  assert.equal(snapshot(repo).pausedUntil, undefined, "an indefinite fleet pause exposes no deadline");
  assert.equal((statusPayload(repo) as { pausedUntil?: number }).pausedUntil, undefined);

  const until = Date.now() + 30 * 60_000;
  pauseFleet(repo, until);
  assert.equal(snapshot(repo).pausedUntil, until);
  assert.equal((statusPayload(repo) as { pausedUntil?: number }).pausedUntil, until);

  // Role-only timed pauses are not fleet pauses: the fleet-scoped field stays absent.
  pauseRole(repo, "clean", until);
  assert.equal(snapshot(repo).pausedUntil, until, "the fleet marker still stands beside a role pause");

  fs.writeFileSync(pausedPath(repo), JSON.stringify({ at: Date.now() - 60_000, until: Date.now() - 30_000 }));
  assert.equal(snapshot(repo).pausedUntil, undefined, "an expired deadline reads as unpaused");
  // JSON.stringify drops the undefined field, so `status --json` carries it only while a
  // timed fleet pause stands.
  assert.ok(!("pausedUntil" in JSON.parse(JSON.stringify(statusPayload(repo)))));
});

// --- pauseReason: the standing fleet pause's operator reason (`pause --reason <text>`) ---

test("pauseReason carries only a standing fleet pause's operator reason", async () => {
  const repo = tmpdir();
  await initProject(repo, "pause reason");
  assert.equal(snapshot(repo).pauseReason, undefined, "no marker: absent");

  pauseFleet(repo);
  assert.equal(snapshot(repo).pauseReason, undefined, "an anonymous pause exposes no reason");
  assert.ok(!("pauseReason" in JSON.parse(JSON.stringify(statusPayload(repo)))), "the payload omits the key entirely");

  // A reason applies only on a fresh pause write: resume the anonymous pause first.
  resumeFleet(repo);
  pauseFleet(repo, undefined, "deploying to prod");
  assert.equal(snapshot(repo).pauseReason, "deploying to prod");
  assert.equal((statusPayload(repo) as { pauseReason?: string }).pauseReason, "deploying to prod");

  // A role-only pause is not a fleet pause: no fleet marker, no fleet reason.
  fs.rmSync(pausedPath(repo));
  pauseRole(repo, "clean");
  assert.equal(snapshot(repo).pauseReason, undefined);

  // An expired marker reads as unpaused — the reason cannot outlive its pause.
  fs.writeFileSync(pausedPath(repo), JSON.stringify({ at: Date.now() - 60_000, until: Date.now() - 30_000, reason: "stale why" }));
  assert.equal(snapshot(repo).pauseReason, undefined, "an expired pause's reason is absent");
});

test("snapshot carries mainCheck from the newest merge-scope build_check event", () => {
  const repo = makeRepo();
  // Absent before any merge-scope check has run (and with no events at all) — the JSON
  // payload omits the key entirely (no null placeholder, matching pausedUntil's idiom).
  assert.equal(snapshot(repo).mainCheck, undefined);
  assert.equal("mainCheck" in (statusPayload(repo) as object), false);

  const base = 1_700_000_000_000;
  // A landing check + the landed event after it: the check ran pre-merge, so the sha it
  // verified is the landing's own — the
  // landed event's `commit` field, exactly as writeLandingOutcome logs it. A gate-scope
  // check verifies a role worktree, not main — it never qualifies.
  writeEvents(repo, [
    { ts: base, loop: "lander", type: "build_check", scope: "gate", status: "passed" },
    {
      ts: base + 1000,
      loop: "lander",
      type: "build_check",
      scope: "merge",
      status: "passed",
      counts: { tests: 10, pass: 9, fail: 0, skipped: 1 },
    },
    { ts: base + 2000, loop: "lander", type: "merge_done", commit: "a".repeat(40) },
  ]);
  const landed = snapshot(repo).mainCheck;
  assert.ok(landed, "mainCheck present after a landing check");
  assert.equal(landed!.sha, "a".repeat(40));
  assert.equal(landed!.status, "passed");
  assert.deepEqual(landed!.counts, { tests: 10, pass: 9, fail: 0, skipped: 1 });
  assert.equal(landed!.at, base + 1000);
  // The JSON payload carries the raw block plus its preformatted badge (GUI parity with the
  // TUI header — the badge is built once in status-model, both surfaces render it).
  const payload = statusPayload(repo) as { mainCheck: unknown; mainCheckBadge: string; mainCounts: string };
  assert.deepEqual(payload.mainCheck, landed);
  assert.match(payload.mainCheckBadge, / · main a{8}: green · 9\/10 \(1 skipped\)/);
  // The sidebar's counts fragment ships preformatted too (badges.ts's mainCountsFragment) —
  // the GUI must not re-derive pass/tests from the raw counts and drift (BUGS.md 2026-09-30).
  assert.equal(payload.mainCounts, "9/10 (1 skipped)");

  // A newer baseline check with no landed event after it: the check ran ON main's tip, so the
  // sha is main's current head. A gate-scope check never displaces a merge-scope one.
  writeEvents(repo, [
    { ts: base, loop: "lander", type: "build_check", scope: "merge", status: "passed" },
    { ts: base + 2000, loop: "lander", type: "merge_done", commit: "a".repeat(40) },
    { ts: base + 5000, loop: "bugfix", type: "build_check", scope: "baseline", status: "failed" },
  ]);
  const baseline = snapshot(repo).mainCheck;
  assert.ok(baseline, "mainCheck present after a baseline check");
  assert.equal(baseline!.sha, mainSha(repo));
  assert.equal(baseline!.status, "failed");
  assert.equal(baseline!.counts, undefined);

  // A merge-scope check older than the default 200-event tail still badges the header: a
  // burst of quiet ticks logs hundreds of events without moving main, and a tail that ends
  // before the last check would make the badge vanish and reappear as ticks tick by. The
  // tail grows (MAIN_CHECK_SCAN_MAX_EVENTS, src/status/status-polls.ts) until the check is
  // inside it — every event after the check is newer, so one window holds the whole derivation.
  const busy = makeRepo();
  writeEvents(busy, [
    { ts: base, loop: "lander", type: "build_check", scope: "merge", status: "passed" },
    { ts: base + 1000, loop: "lander", type: "merge_done", commit: "b".repeat(40) },
    ...Array.from({ length: 300 }, (_, i) => ({
      ts: base + 2000 + i,
      loop: "feature",
      type: "wake",
      reason: "quiet tick filler",
    })),
  ]);
  const deep = snapshot(busy).mainCheck;
  assert.ok(deep, "mainCheck survives a tail deeper than the default 200");
  assert.equal(deep!.sha, "b".repeat(40));
  assert.equal(deep!.status, "passed");

  // The growth cap holds: past MAIN_CHECK_SCAN_MAX_EVENTS the badge drops (the same graceful
  // loss log rotation imposes) instead of scanning without end on every poll.
  const capped = makeRepo();
  writeEvents(capped, [
    { ts: base, loop: "lander", type: "build_check", scope: "merge", status: "passed" },
    { ts: base + 1000, loop: "lander", type: "merge_done", commit: "c".repeat(40) },
    ...Array.from({ length: 6_000 }, (_, i) => ({
      ts: base + 2000 + i,
      loop: "feature",
      type: "wake",
      reason: "over-cap filler",
    })),
  ]);
  assert.equal(snapshot(capped).mainCheck, undefined, "past the scan cap the badge drops");
});

// Part 4/4: the snapshot carries the running orchestrator's published disk state, and only
// while it runs — a stale block beside a dead pid speaks for no fleet.
test("snapshot carries the running orchestrator's published disk state", async () => {
  const repo = makeRepo();
  await initProject(repo, "published disk test");
  const disk = { freeGB: 8.2, holdGB: 10, reclaimGB: 40, held: true };
  writeJsonFile(orchestratorStatePath(repo), { pid: process.pid, startedAt: Date.now(), roles: [], disk });
  assert.deepEqual(snapshot(repo).disk, disk);
  writeJsonFile(orchestratorStatePath(repo), { pid: 2_000_000_000, startedAt: Date.now(), roles: [], disk });
  assert.equal(snapshot(repo).running, false, "a dead pid is not a running orchestrator");
  assert.equal(snapshot(repo).disk, undefined);
});

// The orchestrator info file's nested fields sit behind a hand-editable boundary: a foreign
// `fallbackDemotions` (a scalar, not the pair-keyed record) must read as "no demotions" rather
// than throw out of the every-second snapshot — `modelPairName(p) in publishedDemotions` throws
// `Cannot use 'in' operator` on a string/number — which the TUI, GUI and `tumwater status` all
// poll.
test("snapshot tolerates a foreign fallbackDemotions shape in orchestrator.json", async () => {
  const repo = makeRepo();
  await initProject(repo, "foreign orchestrator info test");
  const modelsFile = writeModelsFile(tmpdir("status-foreign-info-"), LOCAL_FREE_MODELS_JSON);
  const cfg = loadConfig(repo);
  cfg.provider = "paid";
  cfg.model = "gpt-x";
  cfg.fallbackModel = { provider: "local", model: "local-free" };
  saveConfig(repo, cfg);
  ensureParentDir(orchestratorStatePath(repo));
  writeJsonFile(orchestratorStatePath(repo), {
    pid: process.pid,
    startedAt: Date.now(),
    roles: [],
    fallbackDemotions: "oops",
  });
  let snap: ReturnType<typeof snapshot> | undefined;
  assert.doesNotThrow(() => {
    snap = snapshot(repo, modelsFile);
  }, "a foreign fallbackDemotions must not crash the poll");
  assert.equal(snap!.running, true, "the running orchestrator still reads as running");
});
