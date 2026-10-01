import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type http from "node:http";
import { handleReport, handleFailures, handleRestart, handleTick } from "../src/ui/gui-endpoints.js";
import { renderTickDetail } from "../src/ui/tick-detail.js";
import { readTickDetail, type TickDetail } from "../src/tick-detail-data.js";
import { consumeRestartRequest } from "../src/operator-requests.js";
import { writeJsonFile } from "../src/json-files.js";
import { orchestratorStatePath, restartRequestPath } from "../src/paths.js";
import { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS } from "../src/event-window.js";
import { atLocalTs as at, dayKey } from "./oracles.js";
import { writeEvents } from "./log-fixtures.js";
import { tmpdir, writeBacklogFile } from "./repo-fixtures.js";
import { startLocalGui } from "./gui-fixtures.js";
import { fakeRes, type Captured } from "./fake-res.js";

// The GET data endpoints of the dashboard (src/ui/gui-endpoints.ts), exercised at the unit
// level: handleReport and handleFailures have no other direct coverage — gui.test.ts drives
// /api/prompt, /api/transcript, and /api/backlog through the live server but never these two.
// Both handlers only read the parsed query (the server threads it down from the one
// parseRequestTarget call) and write one JSON response, so a fake res that captures
// writeHead/end is enough; the domain work runs for real against a seeded repo.

function serveReport(root: string, query = ""): { captured: Captured; data: unknown } {
  const { res, captured } = fakeRes();
  handleReport(new URLSearchParams(query), res, root);
  return { captured, data: JSON.parse(captured.body) };
}

test("handleReport serves seeded usage as JSON: status, content-type, and real totals", () => {
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

  const { captured, data } = serveReport(root, "?days=5");
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

test("handleReport degrades a bad days value to the default and clamps the range", () => {
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
    const { captured, data } = serveReport(root, query);
    const report = data as { days: number; series: unknown[] };
    assert.equal(captured.status, 200, query);
    assert.equal(report.days, expectedDays, query);
    assert.equal(report.series.length, expectedDays, query);
  }
});

test("handleFailures serves the digest as JSON markdown, empty and after an error tick", () => {
  // Empty log: the digest still answers 200 with its header, not an error.
  const empty = tmpdir();
  const { captured, data } = serveFailures(empty);
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.match((data as { markdown: string }).markdown, /^# tumwater failure digest/);

  // A seeded error tick surfaces as a real outcome row in the same digest.
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "bugfix", type: "tick_end", tick: 1, result: "error" }),
  ]);
  const seeded = serveFailures(root);
  const markdown = (seeded.data as { markdown: string }).markdown;
  assert.match(markdown, /^# tumwater failure digest/);
  assert.match(markdown, /bugfix/);
  assert.match(markdown, /error/);
});

function serveFailures(root: string, query = ""): { captured: Captured; data: unknown } {
  const { res, captured } = fakeRes();
  handleFailures(new URLSearchParams(query), res, root);
  return { captured, data: JSON.parse(captured.body) };
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

async function serveRestart(root: string, body = "{}"): Promise<{ captured: Captured; data: unknown }> {
  const { res, captured } = fakeRes();
  await handleRestart(fakeReq(body), res, root);
  return { captured, data: JSON.parse(captured.body) };
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
// directly with a fake req, so the routing branch in gui.ts's request dispatcher — the
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

function serveTick(root: string, query: string): { captured: Captured; data: unknown } {
  const { res, captured } = fakeRes();
  handleTick(new URLSearchParams(query), res, root);
  return { captured, data: JSON.parse(captured.body) };
}

test("handleTick serves one tick's collector payload plus its pre-rendered text", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: 1_000, loop: "clean", type: "tick_start", tick: 3 }),
    JSON.stringify({ ts: 2_000, loop: "clean", type: "review_verdict", verdict: "approve" }),
    JSON.stringify({ ts: 47_000, loop: "clean", type: "tick_end", tick: 3, result: "changed", summary: "tidy up", tokens: 500, costUsd: 0.25 }),
    // Another loop's same-numbered tick must not leak into clean's block.
    JSON.stringify({ ts: 48_000, loop: "feature", type: "tick_end", tick: 3, result: "no_change" }),
  ]);
  const { captured, data } = serveTick(root, "?role=clean&tick=3");
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

test("handleTick's error cases: role and tick 400s, a missed tick 404", () => {
  const root = tmpdir();
  writeEvents(root, [
    JSON.stringify({ ts: 1_000, loop: "clean", type: "tick_start", tick: 3 }),
    JSON.stringify({ ts: 2_000, loop: "clean", type: "tick_end", tick: 3, result: "no_change" }),
  ]);
  // The role is a target here, not a filter: missing and unknown are 400s naming the valid ids.
  assert.equal(serveTick(root, "?tick=3").captured.status, 400);
  const unknown = serveTick(root, "?role=nope&tick=3");
  assert.equal(unknown.captured.status, 400);
  assert.match((unknown.data as { error: string }).error, /unknown role "nope"/);
  // The tick is an explicit count: required, and a positive integer through intQuery.
  assert.equal(serveTick(root, "?role=clean").captured.status, 400);
  for (const bad of ["abc", "0", "-5", "1e3"]) {
    const r = serveTick(root, `?role=clean&tick=${bad}`);
    assert.equal(r.captured.status, 400, `tick=${bad} → 400`);
    assert.match((r.data as { error: string }).error, /tick must be a positive integer/);
  }
  // A tick the scanned window does not hold — never ran, or rotation ate it — is a not-found
  // status with the CLI's wording, not a crash.
  const missing = serveTick(root, "?role=clean&tick=9");
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
