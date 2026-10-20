// The team-health facet of the status-data suite: snapshot()'s pause markers, mainCheck
// badge, published disk state, and its tolerance of a foreign orchestrator.json shape. Split by
// facet from one status-data test file; the core contract and poll cache live in
// status-data.test.ts.

import fs from "node:fs";
import path from "node:path";
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
import { pauseTeam, pauseRole, resumeTeam } from "../src/team/team-state.js";

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

test("pausedUntil carries only a standing team timed-pause deadline", async () => {
  const repo = tmpdir();
  await initProject(repo, "paused until");
  assert.equal(snapshot(repo).pausedUntil, undefined, "no marker: absent");

  pauseTeam(repo);
  assert.equal(snapshot(repo).pausedUntil, undefined, "an indefinite team pause exposes no deadline");
  assert.equal((statusPayload(repo) as { pausedUntil?: number }).pausedUntil, undefined);

  const until = Date.now() + 30 * 60_000;
  pauseTeam(repo, until);
  assert.equal(snapshot(repo).pausedUntil, until);
  assert.equal((statusPayload(repo) as { pausedUntil?: number }).pausedUntil, until);

  // Role-only timed pauses are not team pauses: the team-scoped field stays absent.
  pauseRole(repo, "clean", until);
  assert.equal(snapshot(repo).pausedUntil, until, "the team marker still stands beside a role pause");

  fs.writeFileSync(pausedPath(repo), JSON.stringify({ at: Date.now() - 60_000, until: Date.now() - 30_000 }));
  assert.equal(snapshot(repo).pausedUntil, undefined, "an expired deadline reads as unpaused");
  // JSON.stringify drops the undefined field, so `status --json` carries it only while a
  // timed team pause stands.
  assert.ok(!("pausedUntil" in JSON.parse(JSON.stringify(statusPayload(repo)))));
});

// --- pauseReason: the standing team pause's operator reason (`pause --reason <text>`) ---

test("pauseReason carries only a standing team pause's operator reason", async () => {
  const repo = tmpdir();
  await initProject(repo, "pause reason");
  assert.equal(snapshot(repo).pauseReason, undefined, "no marker: absent");

  pauseTeam(repo);
  assert.equal(snapshot(repo).pauseReason, undefined, "an anonymous pause exposes no reason");
  assert.ok(!("pauseReason" in JSON.parse(JSON.stringify(statusPayload(repo)))), "the payload omits the key entirely");

  // A reason applies only on a fresh pause write: resume the anonymous pause first.
  resumeTeam(repo);
  pauseTeam(repo, undefined, "deploying to prod");
  assert.equal(snapshot(repo).pauseReason, "deploying to prod");
  assert.equal((statusPayload(repo) as { pauseReason?: string }).pauseReason, "deploying to prod");

  // A role-only pause is not a team pause: no team marker, no team reason.
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
  // A merge check + the merged event after it: the check ran pre-merge, so the sha it
  // verified is the merge's own — the
  // merged event's `commit` field, exactly as writeMergeOutcome logs it. A gate-scope
  // check verifies a role worktree, not main — it never qualifies.
  writeEvents(repo, [
    { ts: base, loop: "lander", type: "build_check", scope: "gate", status: "passed" }, // retired-name-ok: legacy event field in a fixture
    {
      ts: base + 1000,
      loop: "lander", // retired-name-ok: legacy event field in a fixture
      type: "build_check",
      scope: "merge",
      status: "passed",
      counts: { tests: 10, pass: 9, fail: 0, skipped: 1 },
    },
    { ts: base + 2000, loop: "lander", type: "merge_done", commit: "a".repeat(40) }, // retired-name-ok: legacy event field in a fixture
  ]);
  const mergeDone = snapshot(repo).mainCheck;
  assert.ok(mergeDone, "mainCheck present after a merge check");
  assert.equal(mergeDone!.sha, "a".repeat(40));
  assert.equal(mergeDone!.status, "passed");
  assert.deepEqual(mergeDone!.counts, { tests: 10, pass: 9, fail: 0, skipped: 1 });
  assert.equal(mergeDone!.at, base + 1000);
  // The JSON payload carries the raw block plus its preformatted badge (GUI parity with the
  // TUI header — the badge is built once in status-model, both surfaces render it).
  const payload = statusPayload(repo) as { mainCheck: unknown; mainCheckBadge: string; mainCounts: string };
  assert.deepEqual(payload.mainCheck, mergeDone);
  assert.match(payload.mainCheckBadge, / · main a{8}: green · 9\/10 \(1 skipped\)/);
  // The sidebar's counts fragment ships preformatted too (badges.ts's mainCountsFragment) —
  // the GUI must not re-derive pass/tests from the raw counts and drift (BUGS.md 2026-09-30).
  assert.equal(payload.mainCounts, "9/10 (1 skipped)");

  // A newer baseline check with no merged event after it: the check ran ON main's tip, so the
  // sha is main's current head. A gate-scope check never displaces a merge-scope one.
  writeEvents(repo, [
    { ts: base, loop: "lander", type: "build_check", scope: "merge", status: "passed" }, // retired-name-ok: legacy event field in a fixture
    { ts: base + 2000, loop: "lander", type: "merge_done", commit: "a".repeat(40) }, // retired-name-ok: legacy event field in a fixture
    { ts: base + 5000, loop: "bugfix", type: "build_check", scope: "baseline", status: "failed" }, // retired-name-ok: legacy event field in a fixture
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
    { ts: base, loop: "lander", type: "build_check", scope: "merge", status: "passed" }, // retired-name-ok: legacy event field in a fixture
    { ts: base + 1000, loop: "lander", type: "merge_done", commit: "b".repeat(40) }, // retired-name-ok: legacy event field in a fixture
    ...Array.from({ length: 300 }, (_, i) => ({
      ts: base + 2000 + i,
      loop: "feature", // retired-name-ok: legacy event field in a fixture
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
    { ts: base, loop: "lander", type: "build_check", scope: "merge", status: "passed" }, // retired-name-ok: legacy event field in a fixture
    { ts: base + 1000, loop: "lander", type: "merge_done", commit: "c".repeat(40) }, // retired-name-ok: legacy event field in a fixture
    ...Array.from({ length: 6_000 }, (_, i) => ({
      ts: base + 2000 + i,
      loop: "feature", // retired-name-ok: legacy event field in a fixture
      type: "wake",
      reason: "over-cap filler",
    })),
  ]);
  assert.equal(snapshot(capped).mainCheck, undefined, "past the scan cap the badge drops");
});

// The event log is loose-typed by design: a merge-scope check whose status is not one of the
// three MainCheckStatus values (a hand-edited or future-format block) is malformed and reads
// as no check — never a narrowed status that would leak a mystery word to the header badge
// and GUI payload (mainCheckVerdict renders an unmatched status verbatim).
test("a merge-scope check with a foreign status reads as no mainCheck", () => {
  const repo = makeRepo();
  const base = Date.now();
  writeEvents(repo, [
    { ts: base, loop: "lander", type: "build_check", scope: "merge", status: "running" }, // retired-name-ok: legacy event field in a fixture
  ]);
  assert.equal(snapshot(repo).mainCheck, undefined, "a malformed status is dropped, not narrowed");
  const payload = statusPayload(repo) as { mainCheckBadge: string };
  assert.equal(payload.mainCheckBadge, "", "no badge for a malformed check");
});

// Part 4/4: the snapshot carries the running orchestrator's published disk state, and only
// while it runs — a stale block beside a dead pid speaks for no team.
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

// The standing provider-failure hold rides the info file like disk: only while a live
// orchestrator publishes one, and only while at least one hold stands.
test("snapshot carries the running orchestrator's published providerHolds", async () => {
  const repo = makeRepo();
  await initProject(repo, "published provider holds test");
  const providerHolds = [{ provider: "deepinfra", until: Date.now() + 120_000, kind: "rate-limit" }];
  writeJsonFile(orchestratorStatePath(repo), { pid: process.pid, startedAt: Date.now(), roles: [], providerHolds });
  assert.deepEqual(snapshot(repo).providerHolds, providerHolds);
  // An empty list is the same as none: absent from the snapshot.
  writeJsonFile(orchestratorStatePath(repo), { pid: process.pid, startedAt: Date.now(), roles: [], providerHolds: [] });
  assert.equal(snapshot(repo).providerHolds, undefined);
  // A stale block beside a dead pid speaks for no team.
  writeJsonFile(orchestratorStatePath(repo), { pid: 2_000_000_000, startedAt: Date.now(), roles: [], providerHolds });
  assert.equal(snapshot(repo).running, false, "a dead pid is not a running orchestrator");
  assert.equal(snapshot(repo).providerHolds, undefined);
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

test("pausedRunners holds the role ids the scheduler treats as paused by the marker", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  const config = loadConfig(repo);
  config.roles.feature = { ...(config.roles.feature ?? { enabled: true }), instances: 2 };
  saveConfig(repo, config);
  fs.mkdirSync(path.dirname(pausedRolesPath(repo)), { recursive: true });
  fs.writeFileSync(pausedRolesPath(repo), JSON.stringify({ roles: ["feature"], at: Date.now() }));
  const whole = snapshot(repo).pausedRunners;
  assert.ok(whole.includes("feature") && whole.includes("feature-2"), "a whole-role pause holds every instance");
  fs.writeFileSync(pausedRolesPath(repo), JSON.stringify({ roles: ["feature-1"], at: Date.now() }));
  const snap = snapshot(repo);
  assert.deepEqual(snap.pausedRoles, ["feature-1"]);
  assert.deepEqual(snap.pausedRunners, ["feature"]);
});
