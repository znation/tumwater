import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cmdStop } from "../src/operator/operator-commands.js";
import { armScheduledStopWatch } from "../src/cli/cli-start.js";
import { cancelScheduledStop, scheduleStop, scheduledStopAt } from "../src/team/team-state.js";
import { scheduledStopPath } from "../src/paths.js";
import { orchestratorStatePath } from "../src/paths.js";
import { writeJsonFile } from "../src/files/json-files.js";
import { snapshot } from "../src/status/status-data.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { expectFailAsync, expectOkAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";

test("stop --in schedules a marker with a live pid, sends no signal, and fails without a harness", async () => {
  const root = tmpdir();
  assert.match(await expectFailAsync(() => cmdStop(root, ["--in", "2h"])), /tumwater is not running/);
  assert.ok(!fs.existsSync(scheduledStopPath(root)), "nothing was written");
  writeOrchestratorMarker(root, [], { pid: process.pid });
  const before = Date.now();
  const { stdout } = await expectOkAsync(() => cmdStop(root, ["--in", "2h"]));
  assert.match(stdout.toString(), /stop scheduled in 2h/);
  const until = scheduledStopAt(root)!;
  assert.ok(until >= before + 2 * 3600_000 && until <= Date.now() + 2 * 3600_000);
});

test("stop --cancel drops the marker, reports twice-over, and rejects --in", async () => {
  const root = tmpdir();
  scheduleStop(root, Date.now() + 60_000);
  assert.match(await expectFailAsync(() => cmdStop(root, ["--cancel", "--in", "1h"])), /cannot be combined/);
  assert.ok(scheduledStopAt(root) !== undefined, "the failed call wrote and removed nothing");
  assert.match((await expectOkAsync(() => cmdStop(root, ["--cancel"]))).stdout.toString(), /scheduled stop cancelled/);
  assert.match((await expectOkAsync(() => cmdStop(root, ["--cancel"]))).stdout.toString(), /no stop scheduled/);
  assert.equal(cancelScheduledStop(root), false);
});

test("scheduledStopAt reads a torn or non-finite marker as undefined", () => {
  const root = tmpdir();
  fs.mkdirSync(scheduledStopPath(root).replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  fs.writeFileSync(scheduledStopPath(root), "{ torn");
  assert.equal(scheduledStopAt(root), undefined);
  fs.writeFileSync(scheduledStopPath(root), JSON.stringify({ until: "soon" }));
  assert.equal(scheduledStopAt(root), undefined);
});

test("armScheduledStopWatch fires once for a passed marker and consumes it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const root = tmpdir();
  let calls = 0;
  const watch = armScheduledStopWatch(root, () => calls++);
  scheduleStop(root, Date.now() + 10_000);
  t.mock.timers.tick(5_000);
  assert.equal(calls, 0, "a future marker does not fire");
  t.mock.timers.tick(10_000);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 1);
  assert.equal(scheduledStopAt(root), undefined, "the marker was consumed");
  watch.clear();
  await sleep(0);
});

test("status runStopsAt is the earlier of the run --for deadline and a scheduled stop", async () => {
  const repo = makeRepo();
  await initProject(repo, "scheduled stop status");
  const now = Date.now();
  const write = (extra: object) =>
    writeJsonFile(orchestratorStatePath(repo), { pid: process.pid, startedAt: now, roles: [], ...extra });
  write({});
  assert.equal(snapshot(repo).runStopsAt, undefined);
  scheduleStop(repo, now + 30 * 60_000);
  assert.equal(snapshot(repo).runStopsAt, now + 30 * 60_000);
  write({ stopsAt: now + 3600_000 });
  assert.equal(snapshot(repo).runStopsAt, now + 30 * 60_000);
  write({ stopsAt: now + 600_000 });
  assert.equal(snapshot(repo).runStopsAt, now + 600_000);
  fs.rmSync(orchestratorStatePath(repo));
  assert.equal(snapshot(repo).runStopsAt, undefined);
});
