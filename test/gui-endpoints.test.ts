import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type http from "node:http";
import { handleConfig, handleDiff, handleReport, handleFailures, handleTick } from "../src/gui/gui-endpoints.js";
import { EDITABLE_CONFIG_KEYS } from "../src/config/config-editable-keys.js";
import { handleBudget, handleConfigSet, handleRestart } from "../src/gui/gui-endpoint-commands.js";
import { renderTickDetail } from "../src/tick/tick-detail.js";
import { readTickDetail, type TickDetail } from "../src/tick/tick-detail-data.js";
import { consumeRestartRequest } from "../src/operator/operator-requests.js";
import { writeJsonFile } from "../src/files/json-files.js";
import { configPath } from "../src/paths.js";
import { orchestratorStatePath, restartRequestPath } from "../src/paths.js";
import { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS } from "../src/events/event-window.js";
import { atLocalTs as at, dayKey } from "./helpers/oracles.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { tmpdir, commitIn, makeRepo, writeBacklogFile } from "./fixtures/repo-fixtures.js";
import { startLocalGui } from "./fixtures/gui-fixtures.js";
import { collectFleetChanges, collectRoleChange } from "../src/change/change-data.js";
import { initProject } from "../src/init/init.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { captureJson } from "./fakes/fake-res.js";
import { readJson } from "./helpers/json-read.js";

// The GET data endpoints of the dashboard (src/gui/gui-endpoints.ts), exercised at the unit
// level: handleReport and handleFailures have no other direct coverage — gui.test.ts drives
// /api/prompt, /api/transcript, and /api/backlog through the live server but never these two.
// Both handlers only read the parsed query (the server threads it down from the one
// parseRequestTarget call) and write one JSON response, so a fake res that captures
// writeHead/end is enough; the domain work runs for real against a seeded repo.

function serveReport(root: string, query = "") {
  return captureJson((res) => handleReport(new URLSearchParams(query), res, root));
}

test("handleReport serves seeded usage as JSON: status, content-type, and real totals", async () => {
  const root = tmpdir();
  writeEvents(root, [
    // Out of the 5-day window — must not count in any total.
    JSON.stringify({ ts: at(6), loop: "feature", type: "tick_end", tick: 1, result: "no_change", tokens: 999 }),
    JSON.stringify({ ts: at(4), loop: "feature", type: "tick_end", tick: 2, result: "changed", tokens: 500, costUsd: 0.5 }),
    JSON.stringify({ ts: at(3), loop: "feature", type: "merged", commit: "abc1234", summary: "x" }),
    JSON.stringify({ ts: at(0), loop: "steward", type: "merged", commit: "def5678", summary: "y" }),
  ]);
  // A PLANS.md Done entry dated today counts as one feature done in the window.
  writeBacklogFile(root, "PLANS.md", [
    { heading: "## Done", body: `### Something (planned 2026-09-20, done ${dayKey(at(0))}; commit abc1234)` },
  ]);

  const { captured, data } = await serveReport(root, "?days=5");
  const report = data as { days: number; series: { date: string; tokensOut: number; commits: number; featuresDone: number; costByRole: Record<string, number> }[]; totals: { tokensOut: number; ticks: number; commits: number; featuresDone: number; costUsd: number } };

  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.equal(report.days, 5);
  assert.equal(report.series.length, 5);
  assert.equal(report.series[report.series.length - 1]?.date, dayKey(at(0)));
  assert.equal(report.totals.tokensOut, 500); // the out-of-window 999 is excluded
  assert.equal(report.totals.ticks, 1);
  assert.equal(report.totals.commits, 2);
  assert.equal(report.totals.featuresDone, 1);
  assert.deepEqual(report.series[0]?.costByRole, { feature: 0.5 });
});

test("handleReport degrades a bad days value to the default and clamps the range", async () => {
  const root = tmpdir();
  // windowDays's documented rule: the default (14) on any non-plain-digit spelling — hex,
  // scientific, signed — and a clamp into [1, REPORT_MAX_DAYS] for real counts. A URL typo
  // must degrade to the default window, never error.
  const cases: [string, number][] = [
    ["", REPORT_DEFAULT_DAYS],
    ["?days=abc", REPORT_DEFAULT_DAYS],
    ["?days=1e3", REPORT_DEFAULT_DAYS], // raw parseInt would read this as 1
    ["?days=0x10", REPORT_DEFAULT_DAYS],
    ["?days=-5", REPORT_DEFAULT_DAYS],
    ["?days=0", 1],
    ["?days=1", 1],
    [`?days=${REPORT_MAX_DAYS + 1}`, REPORT_MAX_DAYS],
  ];
  for (const [query, expectedDays] of cases) {
    const { captured, data } = await serveReport(root, query);
    const report = data as { days: number; series: unknown[] };
    assert.equal(captured.status, 200, query);
    assert.equal(report.days, expectedDays, query);
    assert.equal(report.series.length, expectedDays, query);
  }
});

test("handleFailures serves the digest as JSON markdown, empty and after an error tick", async () => {
  // Empty log: the digest still answers 200 with its header, not an error.
  const empty = tmpdir();
  const { captured, data } = await serveFailures(empty);
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.match((data as { markdown: string }).markdown, /^# tumwater failure digest/);

  // A seeded error tick surfaces as a real outcome row in the same digest.
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "bugfix", type: "tick_end", tick: 1, result: "error" }),
  ]);
  const seeded = await serveFailures(root);
  const markdown = (seeded.data as { markdown: string }).markdown;
  assert.match(markdown, /^# tumwater failure digest/);
  assert.match(markdown, /bugfix/);
  assert.match(markdown, /error/);
});

function serveFailures(root: string, query = "") {
  return captureJson((res) => handleFailures(new URLSearchParams(query), res, root));
}

// ---- POST /api/restart: the build-stale alert's refresh button ----
// handleRestart reads a request body (the shared readJsonObject front half), so a fake req is
// an EventEmitter that emits the body then ends — the same shape readBody's callbacks expect.
function fakeReq(body: string): http.IncomingMessage {
  const req = new EventEmitter() as unknown as http.IncomingMessage;
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function serveRestart(root: string, body = "{}") {
  return captureJson((res) => handleRestart(fakeReq(body), res, root));
}

/** Seed an orchestrator info file whose pid is this test process (alive, by definition) with
 * the given published build — the staleness requestRestart consults. */
function seedFleet(root: string, build: Record<string, unknown> | null): void {
  fs.mkdirSync(path.dirname(orchestratorStatePath(root)), { recursive: true });
  fs.writeFileSync(orchestratorStatePath(root), JSON.stringify({ pid: process.pid, ...(build ? { build } : {}) }));
}

test("handleRestart writes the marker and replies ok while the running build is stale", async () => {
  const root = tmpdir();
  seedFleet(root, { sha: "a".repeat(40), builtAt: 1, stale: true, aheadCommits: 3 });
  const { captured, data } = await serveRestart(root);
  assert.equal(captured.status, 200);
  assert.equal((data as { ok: boolean }).ok, true);
  assert.match((data as { message: string }).message, /restart requested/);
  assert.match((data as { message: string }).message, /cooldown is waived/);
  assert.match((data as { message: string }).message, /blocked restart still blocks/);
  assert.equal(fs.existsSync(restartRequestPath(root)), true, "the marker a live fleet consumes is on disk");
});

test("handleRestart refuses with nothing written when the running build is not stale", async () => {
  const root = tmpdir();
  seedFleet(root, { sha: "a".repeat(40), builtAt: 1, stale: false });
  const { captured, data } = await serveRestart(root);
  assert.equal(captured.status, 409);
  assert.match((data as { error: string }).error, /no restart is pending/);
  assert.equal(fs.existsSync(restartRequestPath(root)), false, "a fresh build's press writes nothing");
});

test("handleRestart with no fleet running writes the marker harmlessly and says so", async () => {
  const root = tmpdir();
  const { captured, data } = await serveRestart(root);
  assert.equal(captured.status, 200);
  assert.equal((data as { ok: boolean }).ok, true);
  assert.match((data as { message: string }).message, /no harness is running/);
  assert.equal(fs.existsSync(restartRequestPath(root)), true, "the marker waits for the next run's first poll");
});

// The live server's dispatch arm for POST /api/restart. The tests above drive handleRestart
// directly with a fake req, so the routing branch in gui-server.ts's request dispatcher — the
// method+path match that turns the build-stale alert's refresh button into a handler call —
// had no coverage: a renamed path or a dropped else-if would leave every endpoint test green
// while the button 404s. This pins the wiring through a real listening server.
test("the live server routes POST /api/restart to the handler and refuses other methods", async () => {
  const root = tmpdir();
  seedFleet(root, { sha: "a".repeat(40), builtAt: 1, stale: true, aheadCommits: 3 });
  const { server, base } = await startLocalGui(root);
  try {
    const res = await fetch(base + "/api/restart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean; message: string };
    assert.equal(data.ok, true);
    assert.match(data.message, /restart requested/);
    assert.equal(
      fs.existsSync(restartRequestPath(root)),
      true,
      "the handler the router reached wrote the marker",
    );

    // The method gate: a GET on the same path falls through the dispatcher's POST-only arm
    // to the 404 else — it must never reach the handler, so a stray GET writes no marker.
    const get = await fetch(base + "/api/restart");
    assert.equal(get.status, 404);
    assert.equal(fs.existsSync(restartRequestPath(root)), true, "the earlier POST's marker stands");
  } finally {
    server.close();
  }
});

function serveTick(root: string, query: string) {
  return captureJson((res) => handleTick(new URLSearchParams(query), res, root));
}

test("handleTick serves one tick's collector payload plus its pre-rendered text", async () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: 1_000, loop: "clean", type: "tick_start", tick: 3 }),
    JSON.stringify({ ts: 2_000, loop: "clean", type: "review_verdict", verdict: "approve" }),
    JSON.stringify({ ts: 47_000, loop: "clean", type: "tick_end", tick: 3, result: "changed", summary: "tidy up", tokens: 500, costUsd: 0.25 }),
    // Another loop's same-numbered tick must not leak into clean's block.
    JSON.stringify({ ts: 48_000, loop: "feature", type: "tick_end", tick: 3, result: "no_change" }),
  ]);
  const { captured, data } = await serveTick(root, "?role=clean&tick=3");
  const detail = readTickDetail(root, "clean", 3);
  assert.ok(detail);
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  // The payload is the collector's own — the same object `tumwater tick --json` prints — plus
  // `text`, the renderTickDetail rendering the browser shows instead of re-formatting events.
  assert.deepEqual(data, { ...detail, text: renderTickDetail(detail!) });
  const d = data as TickDetail & { text: string };
  assert.equal(d.durationMs, 46_000, "duration pairs the tick's own tick_start");
  assert.deepEqual(d.events.map((e) => e.type), ["tick_start", "review_verdict", "tick_end"]);
  assert.match(d.text, /^clean tick #3 — changed · 46s/);
  assert.match(d.text, /tidy up/);
});

test("handleTick's error cases: role and tick 400s, a missed tick 404", async () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: 1_000, loop: "clean", type: "tick_start", tick: 3 }),
    JSON.stringify({ ts: 2_000, loop: "clean", type: "tick_end", tick: 3, result: "no_change" }),
  ]);
  // The role is a target here, not a filter: missing and unknown are 400s naming the valid ids.
  assert.equal((await serveTick(root, "?tick=3")).captured.status, 400);
  const unknown = await serveTick(root, "?role=nope&tick=3");
  assert.equal(unknown.captured.status, 400);
  assert.match((unknown.data as { error: string }).error, /unknown role "nope"/);
  // The tick is an explicit count: required, and a positive integer through intQuery.
  assert.equal((await serveTick(root, "?role=clean")).captured.status, 400);
  for (const bad of ["abc", "0", "-5", "1e3"]) {
    const r = await serveTick(root, `?role=clean&tick=${bad}`);
    assert.equal(r.captured.status, 400, `tick=${bad} → 400`);
    assert.match((r.data as { error: string }).error, /tick must be a positive integer/);
  }
  // A tick the scanned window does not hold — never ran, or rotation ate it — is a not-found
  // status with the CLI's wording, not a crash.
  const missing = await serveTick(root, "?role=clean&tick=9");
  assert.equal(missing.captured.status, 404);
  assert.match((missing.data as { error: string }).error, /no tick #9 for clean in the scanned window/);
});

test("consumeRestartRequest forces the redeployer once and removes the marker", () => {
  const root = tmpdir();
  let forced = 0;
  writeJsonFile(restartRequestPath(root), { at: Date.now() });
  consumeRestartRequest(root, { forceRestart: () => void forced++ });
  assert.equal(forced, 1);
  assert.equal(fs.existsSync(restartRequestPath(root)), false, "consumed");
  consumeRestartRequest(root, { forceRestart: () => void forced++ });
  assert.equal(forced, 1, "no marker, no force");
  consumeRestartRequest(root, null);
  assert.equal(forced, 1, "no redeployer (a non-self-hosting fleet): the marker is still cleaned up");
  assert.equal(fs.existsSync(restartRequestPath(root)), false);
});

// The Settings view's endpoints (the curated keys, 2026-10-02): GET /api/config
// reads through the same load path `tumwater config get` uses; POST /api/config-set writes
// through setConfigKey, so the browser cannot drift from the CLI's rules.

function serveConfig(root: string) {
  return captureJson((res) => handleConfig(res, root));
}

function serveConfigSet(root: string, body: unknown) {
  return captureJson((res) => handleConfigSet(fakeReq(JSON.stringify(body)), res, root));
}

test("handleConfig returns exactly the six curated keys, resolved values with null for unset", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { model: "gpt-5", quietHours: "23:00-07:00", customLoops: [{ name: "watch", task: "watch" }] });
  const { captured, data } = await serveConfig(root);
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.deepEqual(Object.keys(data as Record<string, unknown>).sort(), [...EDITABLE_CONFIG_KEYS].sort());
  const cfg = data as Record<string, unknown>;
  assert.equal(cfg.model, "gpt-5");
  assert.equal(cfg.quietHours, "23:00-07:00");
  assert.equal(cfg.provider, null);
  assert.equal(cfg.fallback, null);
  // maxDailyCostUsd resolves to loadConfig's default cap (50) when the file does not set it.
  assert.equal(cfg.maxDailyCostUsd, 50);
  assert.equal(cfg.notify, null);
  // customLoops is deliberately not served: the panel's reach is the curated set.
  assert.equal("customLoops" in cfg, false);
});

test("handleConfig answers 500 with validateConfig's message on a broken tumwater.json", async () => {
  const root = tmpdir();
  fs.writeFileSync(configPath(root), "{ not json");
  const { captured, data } = await serveConfig(root);
  assert.equal(captured.status, 500);
  assert.match((data as { error: string }).error, /./); // an actionable message, not an empty body
});

test("handleConfigSet round-trips: set, then GET shows the new value and the file holds it", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { maxDailyCostUsd: 25 });
  const { captured, data } = await serveConfigSet(root, { key: "maxDailyCostUsd", value: 30 });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, key: "maxDailyCostUsd", value: 30, oldValue: 25 });
  const after = await serveConfig(root);
  assert.equal((after.data as Record<string, unknown>).maxDailyCostUsd, 30);
  // The file on disk is what the running fleet polls — the write went through setConfigKey.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal(onDisk.maxDailyCostUsd, 30);
});

test("handleBudget refuses a finite-but-unrepresentable cap with the shared screen's message", async () => {
  // BUGS.md 2026-10-02: /api/budget is the browser surface for the same one-zero typo the
  // TUI's parseBudgetInput guards — 1e24 is finite, so the old checkDailyBudgetUsd admitted
  // it and the write made the daily spend cap effectively uncapped.
  const root = tmpdir();
  const { captured } = await captureJson((res) => handleBudget(fakeReq(JSON.stringify({ maxDailyCostUsd: 1e24 })), res, root));
  assert.equal(captured.status, 400);
  assert.match(captured.body, /at most 9007199254740991/);
  assert.match(captured.body, /got 1e\+24/);
  // The config file was never created by the refused write.
  assert.equal(fs.existsSync(configPath(root)), false);
});

test("handleConfigSet refuses a key outside the curated set, naming it", async () => {
  const root = tmpdir();
  const unknownKey = await serveConfigSet(root, { key: "modle", value: "gpt-5" });
  assert.equal(unknownKey.captured.status, 400);
  assert.match((unknownKey.data as { error: string }).error, /modle/);
  // A known-but-not-curated key is refused too — curation, not validity, is the gate.
  const curated = await serveConfigSet(root, { key: "customLoops", value: [] });
  assert.equal(curated.captured.status, 400);
  assert.match((curated.data as { error: string }).error, /customLoops/);
});

test("handleConfigSet refuses a bad value through setConfigKey's validator, naming the key", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { quietHours: "23:00-07:00" });
  const bad = await serveConfigSet(root, { key: "quietHours", value: "25:00-07:00" });
  assert.equal(bad.captured.status, 400);
  assert.match((bad.data as { error: string }).error, /quietHours/);
  // A failed edit leaves the file untouched.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal(onDisk.quietHours, "23:00-07:00");
  assert.equal(onDisk.model, undefined);
});

// ---- GET /api/diff: the Pending view's collector surface ----
// The handler only adapts HTTP onto change-data.ts's collectors, so these tests pin that the
// fleet document matches collectFleetChanges (same mainBranch/roles, no per-role patch fields)
// and the role document matches collectRoleChange — the documents `tumwater diff --json` and
// `tumwater diff --role <id> --json` print. The role is a target, so an unknown id is a 400.
function serveDiff(root: string, query = "") {
  return captureJson((res) => handleDiff(new URLSearchParams(query), res, root));
}

test("handleDiff serves the fleet roster with no patch fields, matching collectFleetChanges", async () => {
  const root = makeRepo();
  await initProject(root, "gui diff fleet");
  fs.writeFileSync(path.join(root, "notes.txt"), "seeded\n");
  commitIn(root, "seed notes.txt");
  const wt = await ensureWorktree(root, "feature", "main");
  fs.writeFileSync(path.join(wt, "feature.md"), "work\n");
  commitIn(wt, "feature work");
  fs.appendFileSync(path.join(wt, "notes.txt"), "uncommitted\n");

  const { captured, data } = await serveDiff(root);
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.deepEqual(data, await collectFleetChanges(root), "the endpoint serves the collector document unchanged");
  const feature = (data as unknown as { roles: Array<Record<string, unknown>> }).roles.find((r) => r.role === "feature")!;
  assert.equal(feature.ahead, 1);
  const commits = feature.commits as Array<{ sha: string; subject: string }>;
  assert.equal(commits.length, 1);
  assert.match(commits[0]!.sha, /^[0-9a-f]+$/);
  assert.equal(commits[0]!.subject, "feature work");
  assert.deepEqual(feature.dirtyFiles, ["notes.txt"]);
  assert.ok(!("diff" in feature) && !("uncommittedDiff" in feature), "the fleet roster drops both patch halves");
});

test("handleDiff with ?role serves the full per-role view, matching collectRoleChange", async () => {
  const root = makeRepo();
  await initProject(root, "gui diff role");
  fs.writeFileSync(path.join(root, "notes.txt"), "seeded\n");
  commitIn(root, "seed notes.txt");
  const wt = await ensureWorktree(root, "feature", "main");
  fs.writeFileSync(path.join(wt, "feature.md"), "work\n");
  commitIn(wt, "feature work");

  const { captured, data } = await serveDiff(root, "?role=feature");
  assert.equal(captured.status, 200);
  assert.deepEqual(data, await collectRoleChange(root, "feature"));
  const view = data as { state: string; branch: string; diff: string };
  assert.equal(view.state, "ready");
  assert.match(view.branch, /feature/);
  assert.match(view.diff, /feature\.md/);
});

test("handleDiff degrades an absent worktree and a fresh repo without throwing", async () => {
  const root = makeRepo();
  await initProject(root, "gui diff absent");
  // qa is a valid id (rejectBadRole accepts it) whose worktree has never been created.
  const absent = await serveDiff(root, "?role=qa");
  assert.equal(absent.captured.status, 200);
  assert.equal((absent.data as { state: string }).state, "absent");

  // A directory that was never initialized has no git repo and no config: every role's entry
  // is no-base, and the fleet query still answers 200 rather than throwing.
  const fresh = tmpdir();
  const fleet = await serveDiff(fresh);
  assert.equal(fleet.captured.status, 200);
  const doc = fleet.data as { mainBranch: string; roles: Array<{ state: string }> };
  assert.ok(doc.roles.length > 0);
  assert.ok(doc.roles.every((r) => r.state === "no-base"));
});

test("handleDiff refuses an unknown role through rejectBadRole's 400", async () => {
  const root = makeRepo();
  await initProject(root, "gui diff badrole");
  const bad = await serveDiff(root, "?role=ghost");
  assert.equal(bad.captured.status, 400);
  assert.match((bad.data as { error: string }).error, /unknown role "ghost"/);
  // The 400 names the valid ids, and no traversal-shaped string reaches the collector.
  assert.match((bad.data as { error: string }).error, /valid ids:/);
  const traversal = await serveDiff(root, "?role=" + encodeURIComponent("../../../etc"));
  assert.equal(traversal.captured.status, 400);
});
