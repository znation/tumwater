import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type http from "node:http";
import { readEventsTailWithEnd } from "../src/events/event-read.js";
import { eventFeedItem, eventMatchesGrep } from "../src/events/event-format.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { handleConfig, handleDiff, handleReport, handleFailures, handleLogs, handlePromptText, handleTick, handleRole } from "../src/gui/gui-endpoints.js";
import { EDITABLE_CONFIG_KEYS } from "../src/config/config-editable-keys.js";
import { handleBudget, handleConfigSet, handleConfigUnset, handleBacklogFile, handleBacklogCancel, handleBacklogEdit, handlePromptEdit, handleQuestionAnswer, handleReclaim, handleRestart } from "../src/gui/gui-endpoint-commands.js";
import { renderTickDetail } from "../src/tick/tick-detail.js";
import { readTickDetail, type TickDetail } from "../src/tick/tick-detail-data.js";
import { consumeRestartRequest } from "../src/operator/operator-requests.js";
import { writeJsonFile } from "../src/files/json-files.js";
import { configPath, roleInboxDir, roleNotesPath } from "../src/paths.js";
import { orchestratorStatePath, reclaimRequestPath, restartRequestPath } from "../src/paths.js";
import { DIRECTOR_PROMPT_MAX_CHARS } from "../src/inbox/inbox-submit.js";
import { WINDOW_DAY_CASES } from "./fixtures/window-days.js";
import { atLocalTs as at, dayKey } from "./helpers/oracles.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { tmpdir, commitIn, makeRepo, writeBacklogFile } from "./fixtures/repo-fixtures.js";
import { startLocalGui } from "./fixtures/gui-fixtures.js";
import { collectFleetChanges, collectRoleChange } from "../src/change/change-data.js";
import { initProject } from "../src/init/init.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { captureJson } from "./fakes/fake-res.js";
import { readJson } from "./helpers/json-read.js";
import { rolePayload } from "../src/roles/role-view.js";
import { bugWakeText, planWakeText } from "../src/backlog/backlog-write.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";

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
  // windowDays's documented rule, shared as WINDOW_DAY_CASES: a URL typo degrades to the
  // default window, never an error.
  for (const [query, expectedDays] of WINDOW_DAY_CASES) {
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

// ---- ?sinceMs= on both report endpoints: the CLI's trailing-window shape ----
// The dashboard's Usage and Failures tabs read through the same collectors and renders as
// `tumwater report --since` / `report --failures --since`, so the browser and terminal cannot
// disagree about a window. Timestamps are wall-clock offsets, not day keys: a sub-day window is
// the whole point.
test("handleReport serves the trailing-window totals as { markdown } when ?sinceMs is set", async () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [
    // 30 min old — inside a 1 h window; counts.
    JSON.stringify({ ts: now - 30 * 60 * 1000, loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 1234 }),
    // 3 h old — outside a 1 h window; must not count.
    JSON.stringify({ ts: now - 3 * 60 * 60 * 1000, loop: "feature", type: "tick_end", tick: 2, result: "changed", tokens: 9999 }),
  ]);

  const { captured, data } = await serveReport(root, "?sinceMs=3600000");
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  const payload = data as { markdown: string; series?: unknown; days?: unknown };
  assert.equal("series" in payload, false, "the since shape is markdown, not the day series");
  assert.equal("days" in payload, false);
  assert.match(payload.markdown, /window: last 1h/);
  assert.match(payload.markdown, /1234 output tokens/, "the 30-minute-old tick counts");
  assert.doesNotMatch(payload.markdown, /9999/, "the 3-hour-old tick is outside the window");
});

test("handleReport's ?sinceMs is bounded, rival to ?days, and scoped by ?role", async () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [
    JSON.stringify({ ts: now - 10 * 60 * 1000, loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 10 }),
    JSON.stringify({ ts: now - 10 * 60 * 1000, loop: "bugfix", type: "tick_end", tick: 2, result: "changed", tokens: 20 }),
  ]);

  assert.equal((await serveReport(root, "?sinceMs=604800001")).captured.status, 400, "above the 7d cap is a 400, not a clamp");
  assert.equal((await serveReport(root, "?sinceMs=3600000&days=7")).captured.status, 400, "?days and ?sinceMs are rival shapes");

  const scoped = (await serveReport(root, "?sinceMs=3600000&role=feature")).data as { markdown: string };
  assert.match(scoped.markdown, /^role: feature$/m, "?role scopes the since collector");
  assert.match(scoped.markdown, /10 output tokens/, "only the feature tick's usage counts");
  assert.doesNotMatch(scoped.markdown, /bugfix/);
});

test("handleFailures serves the windowed digest as { markdown } when ?sinceMs is set", async () => {
  const root = tmpdir();
  const now = Date.now();
  writeEvents(root, [
    JSON.stringify({ ts: now - 10 * 60 * 1000, loop: "bugfix", type: "tick_end", tick: 1, result: "error", error: "pi exited 1" }),
  ]);

  const { captured, data } = await serveFailures(root, "?sinceMs=3600000");
  assert.equal(captured.status, 200);
  const payload = data as { markdown: string };
  assert.match(payload.markdown, /^# tumwater failure digest/);
  assert.match(payload.markdown, /window: last 1h/);
  assert.match(payload.markdown, /bugfix/);

  assert.equal((await serveFailures(root, "?sinceMs=604800001")).captured.status, 400);
  assert.equal((await serveFailures(root, "?sinceMs=3600000&days=7")).captured.status, 400);

  const scoped = (await serveFailures(root, "?sinceMs=3600000&role=feature")).data as { markdown: string };
  assert.match(scoped.markdown, /^role: feature$/m, "?role scopes the windowed digest");
});

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

test("handleReclaim with no worktrees answers nothing to reclaim", async () => {
  const root = makeRepo();
  const { captured, data } = await captureJson((res) => handleReclaim(fakeReq("{}"), res, root));
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, message: "nothing to reclaim" });
});

test("handleReclaim with a live fleet drops the reclaim marker", async () => {
  const root = makeRepo();
  seedFleet(root, null);
  const { captured, data } = await captureJson((res) => handleReclaim(fakeReq("{}"), res, root));
  assert.equal(captured.status, 200);
  assert.match((data as { message: string }).message, /reclaim requested/);
  assert.equal(fs.existsSync(reclaimRequestPath(root)), true);
});

test("handleReclaim rejects a malformed body with 400 and writes no marker", async () => {
  const root = makeRepo();
  seedFleet(root, null);
  const { captured } = await captureJson((res) => handleReclaim(fakeReq("{nope"), res, root));
  assert.equal(captured.status, 400);
  assert.equal(fs.existsSync(reclaimRequestPath(root)), false);
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

function serveLogs(root: string, query = "") {
  return captureJson((res) => handleLogs(new URLSearchParams(query), res, root));
}

test("handleLogs serves the matched tail oldest-first as feed items, composing grep and role", async () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: 1000, loop: "feature", type: "tick_end", tick: 1, result: "changed", summary: "added a thing" },
    { ts: 2000, loop: "bugfix", type: "land_failed", commit: "abc1234", status: "rejected" },
    { ts: 3000, loop: "feature", type: "tick_end", tick: 2, result: "no_change", summary: "nothing here" },
  ]);
  const { captured, data } = await serveLogs(root, "?grep=added");
  const events = (data as { events: { ts: number; loop: string; type: string; result?: string; message: string }[] }).events;
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.deepEqual(events.map((e) => e.ts), [1000]);
  assert.deepEqual(events[0], {
    ts: 1000, loop: "feature", type: "tick_end", result: "changed",
    message: "tick #1 changed — added a thing",
  });
  // The answer is exactly the shared computation: the scanned tail through eventMatchesGrep and
  // eventFeedItem — the one home each the CLI and the status payload also read (INV-A3).
  const tail = readEventsTailWithEnd(root, 500).events;
  assert.deepEqual(events, tail.filter((e) => eventMatchesGrep(e, "added")).map(eventFeedItem));
  assert.deepEqual(
    (statusPayload(root, 4000) as { eventItems: unknown[] }).eventItems,
    tail.map(eventFeedItem),
    "statusPayload's eventItems come from the same eventFeedItem projection",
  );
  // role is a filter and composes with grep: the landed failure is bugfix, so role=feature drops it.
  const composed = await serveLogs(root, "?grep=land&role=feature");
  assert.deepEqual((composed.data as { events: unknown[] }).events, []);
  // An id with no events is a legitimate empty answer, not a 400 (the handleHistory rule).
  const none = await serveLogs(root, "?role=ghost");
  assert.equal(none.captured.status, 200);
  assert.deepEqual((none.data as { events: unknown[] }).events, []);
});

test("handleLogs bounds the scanned tail by n, defaults it, and rejects a bad n", async () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: 1000, loop: "feature", type: "tick_end", tick: 1, result: "changed", summary: "match me" },
    { ts: 2000, loop: "feature", type: "tick_end", tick: 2, result: "changed", summary: "later one" },
    { ts: 3000, loop: "feature", type: "tick_end", tick: 3, result: "changed", summary: "latest one" },
  ]);
  const scan = await serveLogs(root, "?grep=match&n=2");
  assert.deepEqual((scan.data as { events: unknown[] }).events, [], "the match is older than the last 2 events");
  const zero = await serveLogs(root, "?grep=match&n=0");
  assert.deepEqual((zero.data as { events: unknown[] }).events, [], "n=0 clamps to scanning one event");
  const defaulted = await serveLogs(root, "?grep=match");
  assert.equal((defaulted.data as { events: { ts: number }[] }).events.length, 1, "absent n scans the default 500");
  const bad = await serveLogs(root, "?n=-1");
  assert.equal(bad.captured.status, 400);
});

test("the live server routes GET /api/logs to the slice handler", async () => {
  const root = tmpdir();
  writeEvents(root, [{ ts: 1000, loop: "feature", type: "tick_end", tick: 1, result: "changed", summary: "routed" }]);
  const { server, base } = await startLocalGui(root);
  try {
    const res = await fetch(base + "/api/logs?n=10&role=feature");
    assert.equal(res.status, 200);
    const data = (await res.json()) as { events: { loop: string; message: string }[] };
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0]?.loop, "feature");
    assert.match(data.events[0]?.message ?? "", /routed/);
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

function serveRole(root: string, query: string) {
  return captureJson((res) => handleRole(new URLSearchParams(query), res, root));
}

test("handleRole serves a loop's notebook and next prompt, refusing a missing or unknown role", async () => {
  const root = tmpdir();
  // A notebook written by the loop's own earlier tick — the text the drawer's Notebook
  // section must show verbatim.
  const notes = roleNotesPath(root, "feature");
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.writeFileSync(notes, "the scheduler lives in fleet.ts\n");

  const { captured, data } = await serveRole(root, "?role=feature");
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  // The body is rolePayload's own collection — the note and the assembled next prompt
  // `tumwater role <id>` renders — so the dashboard and the CLI cannot drift.
  const payload = rolePayload(root, "feature");
  const d = data as { note: string | null; nextPrompt: string | null };
  assert.equal(d.note, payload.note);
  assert.equal(d.note, "the scheduler lives in fleet.ts\n");
  assert.equal(d.nextPrompt, payload.nextPrompt);
  assert.match(d.nextPrompt ?? "", /Implement the SINGLE most valuable planned feature in PLANS\.md/);

  // The role is a target, not a filter: a missing or unknown id is rejectBadRole's 400.
  const missing = await serveRole(root, "");
  assert.equal(missing.captured.status, 400);
  assert.match((missing.data as { error: string }).error, /^role required \(valid ids: /);
  const unknown = await serveRole(root, "?role=nope");
  assert.equal(unknown.captured.status, 400);
  assert.match((unknown.data as { error: string }).error, /^unknown role "nope"/);
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

function serveConfigUnset(root: string, body: unknown) {
  return captureJson((res) => handleConfigUnset(fakeReq(JSON.stringify(body)), res, root));
}

test("handleConfig returns exactly the curated keys, resolved values with null for unset", async () => {
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
  // agents resolves to the default empty map when the file names none.
  assert.deepEqual(cfg.agents, {});
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
  // A body with no key at all names no value — the shared gotSuffix convention appends
  // nothing for an absent field rather than echoing back a literal `null` it never carried.
  const missing = await serveConfigSet(root, { value: "gpt-5" });
  assert.equal(missing.captured.status, 400);
  assert.match((missing.data as { error: string }).error, /key must be one of/);
  assert.doesNotMatch((missing.data as { error: string }).error, /got null/);
});

test("handleConfigUnset removes one curated key and leaves its siblings", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { model: "gpt-5", quietHours: "23:00-07:00" });
  const { captured, data } = await serveConfigUnset(root, { key: "model" });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, key: "model", oldValue: "gpt-5" });
  // The file on disk is what the running fleet polls — the removal went through unsetConfigKey.
  const onDisk = readJson(configPath(root)) as Record<string, unknown>;
  assert.equal("model" in onDisk, false);
  assert.equal(onDisk.quietHours, "23:00-07:00");
  // The GET surface now shows the reverted resolved value, not the removed one.
  const after = await serveConfig(root);
  assert.equal((after.data as Record<string, unknown>).model, null);
});

test("handleConfigUnset refuses a key outside the curated set, naming it", async () => {
  const root = tmpdir();
  const curated = await serveConfigUnset(root, { key: "customLoops" });
  assert.equal(curated.captured.status, 400);
  assert.match((curated.data as { error: string }).error, /customLoops/);
  // A body with no key at all names no value — the shared gotSuffix convention appends
  // nothing for an absent field rather than echoing back a literal `null` it never carried.
  const missing = await serveConfigUnset(root, {});
  assert.equal(missing.captured.status, 400);
  assert.match((missing.data as { error: string }).error, /key must be one of/);
  assert.doesNotMatch((missing.data as { error: string }).error, /got null/);
});

test("handleConfigUnset on a key the file never held is a 200 no-op with no oldValue", async () => {
  const root = tmpdir();
  writeJsonFile(configPath(root), { quietHours: "23:00-07:00" });
  const before = fs.readFileSync(configPath(root), "utf8");
  const { captured, data } = await serveConfigUnset(root, { key: "model" });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, key: "model" });
  assert.equal("oldValue" in (data as Record<string, unknown>), false, "JSON omits the undefined oldValue");
  assert.equal(fs.readFileSync(configPath(root), "utf8"), before, "the no-op write leaves the file byte-identical");
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

// ---- GET /api/prompt-text and POST /api/prompt-edit: the Queued tab's file-addressed edit
// seam (PLANS.md 2026-10-11, part 1/2). Both address one prompt by its queue-file basename,
// the /api/prompt-cancel address, and share inbox-edit.ts's core with the CLI's
// `prompt --edit` so the browser cannot drift from it.

/** Seed a queue file at an exact basename, so these endpoints can be driven without depending
 * on enqueueRolePrompt's stamp (the browser names whichever file a poll showed). */
function seedPromptFile(root: string, role: string, name: string, text: string): string {
  const dir = roleInboxDir(root, role);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

function servePromptText(root: string, query: string) {
  return captureJson((res) => handlePromptText(new URLSearchParams(query), res, root));
}

function servePromptEdit(root: string, body: unknown) {
  return captureJson((res) => handlePromptEdit(fakeReq(JSON.stringify(body)), res, root));
}

test("handlePromptText serves a queue file's editable body, with gone and the guards", async () => {
  const root = tmpdir();
  seedPromptFile(root, "qa", "q.md", "the queued body");

  const { captured, data } = await servePromptText(root, "?role=qa&file=q.md");
  assert.equal(captured.status, 200);
  assert.equal(captured.contentType, "application/json");
  assert.deepEqual(data, { ok: true, text: "the queued body" });

  // A vanished file is data for the UI, not a server fault.
  const gone = await servePromptText(root, "?role=qa&file=missing.md");
  assert.equal(gone.captured.status, 200);
  assert.deepEqual(gone.data, { ok: true, status: "gone" });

  // A missing or hostile file name is the shared basename guard's 400.
  const missing = await servePromptText(root, "?role=qa");
  assert.equal(missing.captured.status, 400);
  assert.match((missing.data as { error: string }).error, /file required/);
  const bad = await servePromptText(root, "?role=qa&file=../escape.md");
  assert.equal(bad.captured.status, 400);
  assert.match((bad.data as { error: string }).error, /plain queue-file basename/);

  // The role is a target, not a filter: an unknown id is rejectBadRole's 400.
  const unknown = await servePromptText(root, "?role=ghost&file=q.md");
  assert.equal(unknown.captured.status, 400);
  assert.match((unknown.data as { error: string }).error, /unknown role "ghost"/);
});

test("handlePromptEdit rewrites the named file, leaving a sibling intact, with gone and the guards", async () => {
  const root = tmpdir();
  seedPromptFile(root, "qa", "q.md", "old body");
  seedPromptFile(root, "qa", "sibling.md", "sibling body");

  const { captured, data } = await servePromptEdit(root, { role: "qa", file: "q.md", text: "new body" });
  assert.equal(captured.status, 200);
  assert.deepEqual(data, { ok: true, status: "edited", oldText: "old body", newText: "new body" });
  assert.equal(fs.readFileSync(path.join(roleInboxDir(root, "qa"), "q.md"), "utf8"), "new body");
  assert.equal(
    fs.readFileSync(path.join(roleInboxDir(root, "qa"), "sibling.md"), "utf8"),
    "sibling body",
    "a sibling queue file is untouched",
  );

  // A bad file name and an over-cap body are user-input 400s, the file left as it was.
  const bad = await servePromptEdit(root, { role: "qa", file: "q.txt", text: "x" });
  assert.equal(bad.captured.status, 400);
  assert.match((bad.data as { error: string }).error, /\.md/);
  const overCap = await servePromptEdit(root, {
    role: "qa",
    file: "q.md",
    text: "x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 1),
  });
  assert.equal(overCap.captured.status, 400);
  assert.match((overCap.data as { error: string }).error, /shorten it to at most/);
  assert.equal(fs.readFileSync(path.join(roleInboxDir(root, "qa"), "q.md"), "utf8"), "new body");

  // A vanished file answers gone; a missing file field is the guard's 400.
  const gone = await servePromptEdit(root, { role: "qa", file: "missing.md", text: "new" });
  assert.equal(gone.captured.status, 200);
  assert.deepEqual(gone.data, { ok: true, status: "gone" });
  const missing = await servePromptEdit(root, { role: "qa", text: "new" });
  assert.equal(missing.captured.status, 400);
  assert.match((missing.data as { error: string }).error, /file required/);

  // The role is optional and validates exactly like /api/prompt-cancel.
  seedPromptFile(root, DIRECTOR_ROLE, "director.md", "director body");
  const asDirector = await servePromptEdit(root, { file: "director.md", text: "edited" });
  assert.equal(asDirector.captured.status, 200);
  const unknown = await servePromptEdit(root, { role: "ghost", file: "q.md", text: "x" });
  assert.equal(unknown.captured.status, 400);
  assert.match((unknown.data as { error: string }).error, /unknown role "ghost"/);
});

test("handleQuestionAnswer answers, goes gone on stale input, and guards bad bodies and fences", async () => {
  const root = tmpdir();
  const file = path.join(root, "QUESTIONS.md");
  const T1 = "First: which renderer?";
  const T2 = "Second: which backend?";
  fs.writeFileSync(file, `# Questions\n\n## Open\n\n### ${T1}\n\nbody one\n\n### ${T2}\n\nbody two\n\n## Answered\n`);
  const serve = (body: unknown) => captureJson((res) => handleQuestionAnswer(fakeReq(JSON.stringify(body)), res, root));

  const ok = await serve({ position: 1, title: T1, decision: "use\nink" });
  assert.equal(ok.captured.status, 200);
  assert.deepEqual(ok.data, { ok: true, status: "answered", question: T1, decision: "use ink" });
  const md = fs.readFileSync(file, "utf8");
  assert.match(md, new RegExp(`## Answered[\\s\\S]*### ${T1}[\\s\\S]*\\*\\*Answered \\d{4}-\\d{2}-\\d{2} by operator:\\*\\* use ink`));

  // The first title is stale now (the second entry is position 1), and position 5 is out of range.
  const stale = await serve({ position: 1, title: T1, decision: "x" });
  assert.deepEqual([stale.captured.status, stale.data], [200, { ok: true, status: "gone" }]);
  const range = await serve({ position: 5, title: T2, decision: "x" });
  assert.deepEqual([range.captured.status, range.data], [200, { ok: true, status: "gone" }]);
  assert.equal(fs.readFileSync(file, "utf8"), md);

  assert.equal((await serve({ position: 1, title: T2, decision: "  " })).captured.status, 400);
  assert.equal((await serve({ position: 1.5, title: T2, decision: "x" })).captured.status, 400);
  assert.equal((await serve({ position: 1, decision: "x" })).captured.status, 400);
  assert.equal(fs.readFileSync(file, "utf8"), md);

  const fenced = "# Questions\n\n## Open\n\n### Q\n\n```\nunclosed\n\n## Answered\n";
  fs.writeFileSync(file, fenced);
  const f = await serve({ position: 1, title: "Q", decision: "x" });
  assert.equal(f.captured.status, 409);
  assert.match((f.data as { error: string }).error, /unclosed code fence/);
  assert.equal(fs.readFileSync(file, "utf8"), fenced);
});

// ---- POST /api/backlog-file: the Plans/Bugs tabs' New control ----
function serveBacklogFile(root: string, body: unknown) {
  return captureJson((res) => handleBacklogFile(fakeReq(JSON.stringify(body)), res, root));
}

function queuedTexts(root: string, role: string): string[] {
  const dir = roleInboxDir(root, role);
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")) : [];
}

test("handleBacklogFile files a bug or plan and wakes its loop, and 400s bad input untouched", async () => {
  const root = tmpdir();
  writeBacklogFile(root, "BUGS.md", [{ heading: "## Open" }, { heading: "## Fixed" }]);
  writeBacklogFile(root, "PLANS.md", [{ heading: "## Planned" }, { heading: "## Done" }]);
  const today = new Date().getFullYear().toString();

  const bug = await serveBacklogFile(root, { kind: "bug", title: "  x  y " });
  assert.equal(bug.captured.status, 200);
  assert.deepEqual(bug.data, { ok: true, file: "BUGS.md", title: "x y" });
  assert.match(fs.readFileSync(path.join(root, "BUGS.md"), "utf8"), new RegExp(`### x y \\(reported by the operator ${today}`));
  assert.deepEqual(queuedTexts(root, "bugfix"), [bugWakeText("x y")]);

  const plan = await serveBacklogFile(root, { kind: "plan", title: "add z" });
  assert.equal(plan.captured.status, 200);
  assert.deepEqual(plan.data, { ok: true, file: "PLANS.md", title: "add z" });
  assert.match(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), /### add z \(reported by the operator/);
  assert.deepEqual(queuedTexts(root, "feature"), [planWakeText("add z")]);

  const bugsBefore = fs.readFileSync(path.join(root, "BUGS.md"), "utf8");
  const plansBefore = fs.readFileSync(path.join(root, "PLANS.md"), "utf8");
  for (const body of [
    { kind: "todo", title: "x" },
    { kind: "bug", title: "   " },
    { kind: "plan" },
    { kind: "bug", title: "a".repeat(DIRECTOR_PROMPT_MAX_CHARS + 10) },
  ]) {
    const bad = await serveBacklogFile(root, body);
    assert.equal(bad.captured.status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal(fs.readFileSync(path.join(root, "BUGS.md"), "utf8"), bugsBefore);
  assert.equal(fs.readFileSync(path.join(root, "PLANS.md"), "utf8"), plansBefore);
  assert.equal(queuedTexts(root, "bugfix").length, 1);
  assert.equal(queuedTexts(root, "feature").length, 1);
});

// ---- POST /api/backlog-cancel: the entry drawer's cancel ----
test("handleBacklogCancel removes the entry, answers gone for a stale title, 400s bad input, wakes nobody", async () => {
  const root = tmpdir();
  writeBacklogFile(root, "BUGS.md", [{ heading: "## Open", body: "### one\n\nbody\n\n### two (found by x 2026-10-01)\n\nbody" }, { heading: "## Fixed" }]);
  writeBacklogFile(root, "PLANS.md", [{ heading: "## Planned", body: "### p1\n\nbody" }, { heading: "## Done" }]);
  const serve = (body: unknown) => captureJson((res) => handleBacklogCancel(fakeReq(JSON.stringify(body)), res, root));
  const bugsPath = path.join(root, "BUGS.md");

  const stale = await serve({ kind: "bug", position: 1, title: "two (found by x 2026-10-01)" });
  assert.equal(stale.captured.status, 200);
  assert.deepEqual(stale.data, { ok: true, status: "gone" });
  const before = fs.readFileSync(bugsPath, "utf8");
  assert.ok(before.includes("### one"));

  const done = await serve({ kind: "bug", position: 2, title: "two (found by x 2026-10-01)" });
  assert.equal(done.captured.status, 200);
  assert.deepEqual(done.data, { ok: true, status: "cancelled", file: "BUGS.md", title: "two (found by x 2026-10-01)" });
  assert.ok(!fs.readFileSync(bugsPath, "utf8").includes("### two"));
  assert.ok(fs.readFileSync(bugsPath, "utf8").includes("### one"));

  const plan = await serve({ kind: "plan", position: 1, title: "p1" });
  assert.deepEqual(plan.data, { ok: true, status: "cancelled", file: "PLANS.md", title: "p1" });
  assert.ok(!fs.readFileSync(path.join(root, "PLANS.md"), "utf8").includes("### p1"));

  const bugsNow = fs.readFileSync(bugsPath, "utf8");
  for (const body of [
    { kind: "todo", position: 1, title: "x" },
    { kind: "bug", position: 0, title: "one" },
    { kind: "bug", position: 1 },
    { kind: "bug", position: 1, title: "" },
  ]) {
    assert.equal((await serve(body)).captured.status, 400, JSON.stringify(body));
  }
  assert.equal(fs.readFileSync(bugsPath, "utf8"), bugsNow);
  for (const role of ["bugfix", "feature", "director"]) assert.deepEqual(queuedTexts(root, role), []);
});

// ---- POST /api/backlog-edit: the entry drawer's edit ----
test("handleBacklogEdit rewrites the entry, answers gone for a stale title, 400s bad input, wakes nobody", async () => {
  const root = tmpdir();
  writeBacklogFile(root, "PLANS.md", [{ heading: "## Planned", body: "### p1 (planned 2026-10-01 by plan)\n\nold" }, { heading: "## Done" }]);
  const serve = (body: unknown) => captureJson((res) => handleBacklogEdit(fakeReq(JSON.stringify(body)), res, root));
  const plansPath = path.join(root, "PLANS.md");

  const stale = await serve({ kind: "plan", position: 1, title: "other", newTitle: "n", newBody: "b" });
  assert.deepEqual(stale.data, { ok: true, status: "gone" });
  assert.ok(fs.readFileSync(plansPath, "utf8").includes("old"));

  const before = fs.readFileSync(plansPath, "utf8");
  for (const body of [
    { kind: "todo", position: 1, title: "x", newTitle: "n", newBody: "" },
    { kind: "plan", position: 0, title: "x", newTitle: "n", newBody: "" },
    { kind: "plan", position: 1, title: "", newTitle: "n", newBody: "" },
    { kind: "plan", position: 1, title: "p1 (planned 2026-10-01 by plan)", newTitle: "  ", newBody: "" },
    { kind: "plan", position: 1, title: "p1 (planned 2026-10-01 by plan)", newTitle: "n", newBody: 5 },
    { kind: "plan", position: 1, title: "p1 (planned 2026-10-01 by plan)", newTitle: "n", newBody: "a\n### H" },
  ]) {
    assert.equal((await serve(body)).captured.status, 400, JSON.stringify(body));
  }
  assert.equal(fs.readFileSync(plansPath, "utf8"), before);

  const done = await serve({ kind: "plan", position: 1, title: "p1 (planned 2026-10-01 by plan)", newTitle: "p2", newBody: "l1\n\nl2" });
  assert.equal(done.captured.status, 200);
  assert.deepEqual(done.data, { ok: true, status: "edited", file: "PLANS.md", title: "p2" });
  assert.ok(fs.readFileSync(plansPath, "utf8").includes("### p2 (planned 2026-10-01 by plan)\n\nl1\n\nl2"));
  for (const role of ["bugfix", "feature", "director"]) assert.deepEqual(queuedTexts(root, role), []);
});
