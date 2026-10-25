// Core status-data suite: snapshot()'s own contract and per-poll cache — the config it
// resolves against (quiet hours, custom roles), the role rows it builds, and the stat-keyed
// reads that serve them. Split by facet from one status-data test file; the
// budget/cap fields live in status-data-budget.test.ts, the team/pause/health fields in
// status-data-team.test.ts, the queue fields in status-data-inbox.test.ts, and the model
// selector/fallback/seam rows in status-data-models.test.ts.

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { snapshot } from "../src/status/status-data.js";
import { runnerStateForPoll } from "../src/status/status-polls.js";
import { quietHoursStatus } from "../src/scheduling/quiet-hours.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { quietBadge } from "../src/ui/badges.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, writeConfig } from "./fixtures/repo-fixtures.js";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { allRoleIds } from "../src/roles/roles.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { withCountedReads } from "./helpers/fs-faults.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { backdate } from "./helpers/backdate.js";

// Quiet hours 2/2 (plans: "Quiet hours … part 2/2, observability"): the snapshot carries the
// configured window and the in-window flag — present only while the value parses to a real
// window, so a schedule the gate is not holding is never advertised — and the payload ships
// the same fields with the header badge preformatted.
test("snapshot carries the quiet-hours window when configured and nothing when not", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");

  const unset = snapshot(repo);
  assert.equal(unset.quietHours, undefined);
  assert.equal(unset.inQuietHours, false);

  writeConfig(repo, { quietHours: "23:00-07:00" });
  const set = snapshot(repo);
  assert.equal(set.quietHours, "23:00-07:00");
  // The flag is the gate's own predicate (inQuietHours), evaluated for the poll's clock.
  assert.equal(set.inQuietHours, quietHoursStatus("23:00-07:00", new Date()).inWindow);
  // The payload's badge is the snapshot's fields through quietBadge — agreeing with the
  // header whatever the wall clock reads (this suite can run inside or outside the window).
  assert.equal(
    (statusPayload(repo) as { quietBadge: string }).quietBadge,
    quietBadge(set.quietHours, set.inQuietHours),
  );

  // A malformed value degrades with the whole config — status/status-polls.ts's configForStatus
  // serves the last-known-good one, so the badge never flashes off on a single broken write.
  writeConfig(repo, { quietHours: "23:00" });
  const broken = snapshot(repo);
  assert.equal(broken.quietHours, "23:00-07:00", "a broken config serves the last-known-good window");

  // From a cold start (no last-known-good), a broken config means the defaults: nothing.
  const cold = makeRepo();
  await initProject(cold, "test project");
  writeConfig(cold, { quietHours: "23:00" });
  const fromDefaults = snapshot(cold);
  assert.equal(fromDefaults.quietHours, undefined);
  assert.equal(fromDefaults.inQuietHours, false);
});

test("snapshot lists one row per role id for a multi-instance role (part 5b/7)", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  const config = loadConfig(repo);
  config.roles.feature = { ...(config.roles.feature ?? { enabled: true }), instances: 2 };
  saveConfig(repo, config);
  const ids = snapshot(repo).roles.map((l) => l.role);
  assert.equal(ids.includes("feature"), true);
  assert.equal(ids.includes("feature-2"), true);
});

// Per-role quiet hours key config by BASE role (gate-polls.ts's roleQuietHeld resolves an
// instance through baseRoleOf), so the snapshot must resolve the window the same way while
// keying the map by the role id rolePhase looks up — otherwise feature-2 reads queued while
// the scheduler holds it.
test("snapshot resolves a per-role quiet window through the base role for instances", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  // A window that holds right now wherever the suite runs: start at the current minute and
  // end one minute earlier (wrapping midnight), so `now` is always inside the half-open range.
  const now = new Date();
  const at = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const window = `${at(now)}-${at(new Date(now.getTime() - 60_000))}`;
  const config = loadConfig(repo);
  config.roles.feature = { ...(config.roles.feature ?? { enabled: true }), instances: 2 };
  config.quietHoursPerRole = { feature: window };
  saveConfig(repo, config);

  const paused = snapshot(repo).roleQuietPaused;
  assert.equal(paused.feature, window);
  assert.equal(paused["feature-2"], window, "the instance inherits its base role's window");
});

test("snapshot survives a broken tumwater.json and recovers when it is fixed", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  // Baseline: every catalog role but the opt-in selfcheck and feedback enabled by default.
  assert.equal(snapshot(repo).roles.length, allRoleIds().length - 2);

  // A valid config that disables one role becomes the last known-good one.
  const cfg = loadConfig(repo);
  cfg.roles.dedupe!.enabled = false;
  saveConfig(repo, cfg);
  let snap = snapshot(repo);
  assert.ok(!snap.roles.some((l) => l.role === "dedupe"));

  // The file breaks mid-edit (invalid JSON): observers must not throw.
  fs.writeFileSync(path.join(repo, "tumwater.json"), "{ still editing");
  snap = snapshot(repo);
  // The last known-good role set is kept: dedupe stays hidden and nothing crashes.
  assert.ok(!snap.roles.some((l) => l.role === "dedupe"));

  // A validation error (valid JSON, invalid value) is equally survivable.
  writeConfig(repo, { maxConcurrent: "six" });
  assert.ok(snapshot(repo).roles.length > 0);

  // Repair with a different valid config: the fresh load takes effect again.
  cfg.roles.dedupe!.enabled = true;
  cfg.roles.clean!.enabled = false;
  saveConfig(repo, cfg);
  snap = snapshot(repo);
  assert.ok(snap.roles.some((l) => l.role === "dedupe"));
  assert.ok(!snap.roles.some((l) => l.role === "clean"));
});

test("snapshot serves unchanged runner state from the stat-keyed cache without re-reading", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  const state = freshRunnerState("clean");
  state.runs = 3;
  saveRunnerState(repo, state);
  assert.equal(snapshot(repo).roles.find((l) => l.role === "clean")!.runs, 3); // populates the cache

  withCountedReads(
    (reads) => {
      const snap = snapshot(repo);
      assert.equal(snap.roles.find((l) => l.role === "clean")!.runs, 3); // unchanged — served from cache
      assert.equal(reads(), 0); // no re-read of the state file at all
      // Each poll still gets its own objects: mutating one snapshot must not poison later ones.
      snap.roles.find((l) => l.role === "clean")!.runs = 99;
      assert.equal(snapshot(repo).roles.find((l) => l.role === "clean")!.runs, 3);
    },
    (file) => typeof file === "string" && file.endsWith(`${path.sep}state${path.sep}clean.json`),
  );

  // A same-size edit is picked up via mtime, not just size: runs 3 → 4 keeps the file's byte
  // length identical, so utimes forces a distinct mtime regardless of filesystem timestamp
  // granularity (two fast writes could otherwise share one on coarse-grained filesystems).
  const bumped = freshRunnerState("clean");
  bumped.runs = 4;
  saveRunnerState(repo, bumped);
  backdate(path.join(repo, ".tumwater", "state", "clean.json"), -5000);
  assert.equal(snapshot(repo).roles.find((l) => l.role === "clean")!.runs, 4);
});

test("runnerStateForPoll yields a fresh state for a role with no state file", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  // No state file was ever saved for the role: the stat-keyed cache misses and the missing
  // file yields a fresh state rather than throwing at the stat boundary.
  assert.deepEqual(runnerStateForPoll(repo, "clean"), freshRunnerState("clean"));
});

test("snapshot reads the orchestrator info file once per poll", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  // A live orchestrator's info file: both consumers (the pid column and the running flag)
  // have data to work with.
  writeOrchestratorMarker(repo, ["feature"]);
  assert.equal(snapshot(repo).running, true); // first read

  const reads = withCountedReads(
    () => {
      const snap = snapshot(repo);
      assert.equal(snap.pid, process.pid); // the info was read and used for the pid…
      assert.equal(snap.running, true); // …and for the liveness check from that same read
    },
    (file) =>
      typeof file === "string" && file.endsWith(`${path.sep}state${path.sep}orchestrator.json`),
  );
  assert.equal(reads, 1); // one read serves both — not two
});

// The `custom` flag marks user-defined roles (tumwater.json's customRoles) for the
// dashboards' asterisk. It is computed in snapshot from the same last-known-good config that
// produced the role list — so a transiently broken file keeps marking its customs rather than
// flipping them unmarked mid-poll.
test("snapshot rows carry the custom flag matching the config", async () => {
  const repo = makeRepo();
  await initProject(repo, "custom flag test");
  assert.ok(snapshot(repo).roles.every((l) => !l.custom), "built-ins unmarked by default");

  const cfg = loadConfig(repo);
  cfg.customRoles.push({ name: "nightly", task: "do the nightly thing" });
  saveConfig(repo, cfg);
  let snap = snapshot(repo);
  assert.ok(snap.roles.some((l) => l.role === "nightly" && l.custom), "listed custom is marked");
  assert.ok(
    snap.roles.filter((l) => !l.custom).length >= allRoleIds().length - 2,
    "every enabled built-in stays unmarked",
  );

  // The file breaks mid-edit: the last known-good config keeps marking the custom.
  fs.writeFileSync(path.join(repo, "tumwater.json"), "{ still editing");
  snap = snapshot(repo);
  assert.ok(snap.roles.some((l) => l.role === "nightly" && l.custom), "broken file keeps last-known-good customs");
});
