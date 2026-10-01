import test from "node:test";
import { readJson } from "./json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { MAX_BODY_BYTES } from "../src/ui/http-body.js";
import { initProject } from "../src/init.js";
import { landingStatePath, pausedPath, abortRequestPath, wakeRequestPath, pausedRolesPath } from "../src/paths.js";
import { freshLoopState, loadLoopState, saveLoopState } from "../src/loop-state.js";
import { todayStamp } from "../src/budget.js";
import { enqueueRolePrompt, queuedRolePrompts } from "../src/inbox.js";
import { DIRECTOR_PROMPT_MAX_CHARS } from "../src/inbox-submit.js";
import { enqueueLanding } from "../src/landing-queue.js";
import { postJson, withGui } from "./gui-fixtures.js";
import { writeOrchestratorMarker } from "./log-fixtures.js";
import { makeRepo } from "./repo-fixtures.js";

// The GUI's operator controls, split out of gui.test.ts: the daily budget cap
// (plans/daily-cost-budget.md) — its /api/status field, preformatted header badge,
// click-to-edit client, and POST /api/budget — and POST /api/pause, the dashboard's
// pause/resume toggle backed by the same shared state writers the CLI uses, so the
// dashboard and `tumwater pause`/`resume` cannot drift.

// The dashboard tests read JSON responses the way gui-client's own postJson guard does;
// this keeps each call site to one line instead of the double-await fetch idiom. Bodies
// arrive as raw string bytes (the 400 probes), so this bypasses fixtures' postJson.

async function postRaw<T>(base: string, path: string, body: string): Promise<T> {
  return (await (await fetch(base + path, { method: "POST", body })).json()) as T;
}
// The daily cost budget on the GUI surface (plans/daily-cost-budget.md): /api/status carries
// raw `budget` while enabled and null when disabled plus the preformatted `budgetBadge` the
// page renders as its header badge, and a paused fleet's idle role loops read `budget paused`
// in their phase payload.

test("status payload carries the daily budget while enabled and null when disabled", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui budget test"); // defaultConfig: maxDailyCostUsd 50 (enabled)
  let payload = statusPayload(repo) as { budget: { spentUsd: number; capUsd: number; free: boolean } | null; budgetBadge: string };
  // No provider/model configured (pi's own default) — the fleet cannot be verified as free.
  assert.deepEqual(payload.budget, { spentUsd: 0, capUsd: 50, free: false, fallback: null }, "enabled by default with no spend yet");
  assert.equal(payload.budgetBadge, " · budget: $0.00/$50 today", "the preformatted badge matches the TUI header string");

  // Today's spend is summed from the loops' persisted daily windows (a stale stamp reads $0).
  const s = freshLoopState("clean");
  s.dayStamp = todayStamp();
  s.dayCostUsd = 12.34;
  saveLoopState(repo, s);
  payload = statusPayload(repo) as typeof payload;
  assert.equal(payload.budget?.spentUsd, 12.34, "today's spend shows in the badge data");
  assert.equal(payload.budgetBadge, " · budget: $12.34/$50 today", "today's spend shows in the badge text");

  // 0 disables: the raw data stays (spend is still reported; capUsd 0 says disabled) and
  // the preformatted badge switches to the standing `· no cap` form — it never disappears,
  // because the badge is also the affordance for setting a cap from a disabled fleet.
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsd = 0;
  saveConfig(repo, cfg);
  payload = statusPayload(repo) as typeof payload;
  assert.deepEqual(payload.budget, { spentUsd: 12.34, capUsd: 0, free: false, fallback: null }, "cap 0 disables the gate but keeps the data");
  assert.equal(payload.budgetBadge, " · budget: $12.34 today · no cap", "disabled: standing badge with spend and no cap");
});

// Merge queue 4/5 — the payload's landQueue field: depth always present, inFlight only
// while a landing is actually running (marker + matching entry + live orchestrator), and
// the preformatted landingBadge the page renders in its header.
test("status payload carries the land queue depth and the in-flight landing", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui land queue test");
  const payload = statusPayload(repo) as {
    landQueue: { depth: number; inFlight?: { role: string; sha: string; summary: string; startedAt: number; stage?: string } };
    landingBadge: string;
    loops: Array<{ role: string; phase: string; inFlight: boolean }>;
  };
  // Idle: depth 0 (the field is never null/absent — one stable shape for JSON consumers)
  // and the preformatted badge is empty, so the page appends nothing.
  assert.equal(payload.landQueue.depth, 0);
  assert.equal(payload.landingBadge, "");

  // One queued entry lifts the depth — but a merely queued landing is not in flight.
  enqueueLanding(repo, { role: "clean", sha: "abc1234", tick: 1, summary: "tidy something", enqueuedAt: Date.now() });
  let p = statusPayload(repo) as typeof payload;
  assert.equal(p.landQueue.depth, 1);
  assert.equal(p.landingBadge, " · land queue: 1");
  assert.equal(p.landQueue.inFlight, undefined, "queued, not landing: no inFlight yet");

  // A live orchestrator plus the 4/5 marker with a matching entry → in flight, and the
  // landing role's row phase reads `landing <elapsed> · <stage>` while every other row is
  // untouched.
  writeOrchestratorMarker(repo, ["clean"]);
  const startedAt = Date.now();
  fs.writeFileSync(
    landingStatePath(repo),
    JSON.stringify({ role: "clean", sha: "abc1234", summary: "tidy something", startedAt, stage: "build-check" }),
  );
  p = statusPayload(repo) as typeof payload;
  assert.equal(p.landQueue.inFlight?.role, "clean");
  assert.equal(p.landQueue.inFlight?.sha, "abc1234");
  assert.match(
    p.loops.find((l) => l.role === "clean")!.phase,
    /^landing \d+s · build check$/,
    "the landing role's phase is marker-driven, stage included",
  );
  assert.equal(p.landQueue.inFlight?.stage, "build-check", "the raw record carries the stage for `status --json`");
  assert.equal(p.loops.find((l) => l.role === "bugfix")!.phase, "queued", "other roles keep their normal phase");
  // The row-level inFlight flag (isActivePhase over the rendered phase) is what the GUI's
  // row actions key off: the landing role is in flight, every other row is not.
  assert.equal(p.loops.find((l) => l.role === "clean")!.inFlight, true, "the landing row is in flight");
  assert.equal(p.loops.find((l) => l.role === "bugfix")!.inFlight, false, "idle rows are not");
});

// Regression (review of the editable-budget feature): the payload's budget object is now
// unconditional, so a DISABLED cap must not read as reached — with a running orchestrator,
// spend ≥ 0 = cap would otherwise export every idle role loop as `budget paused`.
test("a disabled cap never pauses the fleet in the phase payload", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui no-cap test");
  // A live orchestrator (this process) so loopPhase doesn't short-circuit to "stopped"…
  writeOrchestratorMarker(repo, ["clean"]);
  // …cap disabled with today's spend far above zero.
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsd = 0;
  saveConfig(repo, cfg);
  const s = freshLoopState("clean");
  s.dayStamp = todayStamp();
  s.dayCostUsd = 500; // would be "reached" against any positive cap
  saveLoopState(repo, s);

  const payload = statusPayload(repo) as {
    budget: { spentUsd: number; capUsd: number; free: boolean };
    budgetBadge: string;
    loops: Array<{ role: string; phase: string }>;
  };
  assert.deepEqual(payload.budget, { spentUsd: 500, capUsd: 0, free: false, fallback: null });
  assert.equal(payload.budgetBadge, " · budget: $500.00 today · no cap");
  // No loop reads budget paused — the gate is off by definition while the cap is 0.
  for (const l of payload.loops) {
    assert.notEqual(l.phase, "budget paused", `${l.role} must not read budget paused with the cap disabled`);
  }
  assert.match(payload.loops.find((l) => l.role === "clean")?.phase ?? "", /^(queued|sleeping)/);
  // The director is exempt as always.
  assert.equal(payload.loops.find((l) => l.role === "director")?.phase, "waiting for prompts");
});

// The operator module is served through string interpolation into GUI_CLIENT_JS, so a
// stray newline or lost indent at either splice boundary would ship a silently different
// dashboard script while the module and its region tests all still pass. Pin the splice:
// the assembled script must contain the module's constant verbatim, end to end.
test("GUI_CLIENT_JS carries the operator module as a byte-exact contiguous splice", async () => {
  const { GUI_CLIENT_JS } = await import("../src/ui/gui-client.js");
  const { GUI_CLIENT_OPERATOR_JS } = await import("../src/ui/gui-client-operator.js");
  assert.ok(
    GUI_CLIENT_JS.includes(GUI_CLIENT_OPERATOR_JS),
    "the operator module's constant must appear verbatim in the assembled script " +
      "(a mismatch means the interpolation gained or lost bytes at a splice boundary)",
  );
});

test("a paused fleet's idle role loops read budget paused in the phase payload", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui budget pause test");
  // A live orchestrator (this process) so loopPhase doesn't short-circuit to "stopped"…
  writeOrchestratorMarker(repo, ["clean"]);
  // …and spend at the cap so the fleet-wide pause flag is set.
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsd = 10;
  saveConfig(repo, cfg);
  const s = freshLoopState("clean");
  s.dayStamp = todayStamp();
  s.dayCostUsd = 12.5; // >= cap → paused
  saveLoopState(repo, s);

  let payload = statusPayload(repo) as { loops: Array<{ role: string; phase: string }> };
  assert.equal(payload.loops.find((l) => l.role === "clean")?.phase, "budget paused");
  // The director is exempt from the cap — its phase keeps its own label.
  assert.equal(payload.loops.find((l) => l.role === "director")?.phase, "waiting for prompts");

  // Under the cap again: the idle loop goes back to its sleep/queue state.
  const under = freshLoopState("clean");
  under.dayStamp = todayStamp();
  under.dayCostUsd = 1;
  saveLoopState(repo, under);
  payload = statusPayload(repo) as typeof payload;
  assert.notEqual(payload.loops.find((l) => l.role === "clean")?.phase, "budget paused");
});

// POST /api/budget — the dashboard badge editor's save path: one shared setter with the
// TUI's Ctrl+B, so both surfaces write tumwater.json identically and the running orchestrator
// picks the change up on its next ~2 s poll.

test("POST /api/budget persists a valid cap and rejects invalid bodies without touching the file", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui budget edit test"); // defaultConfig: maxDailyCostUsd 50
  await withGui(repo, async ({ base }) => {
  const configFile = path.join(repo, "tumwater.json");
  // Whole dollars persist and come back in the response.
  let res = await postJson(base, "/api/budget", { maxDailyCostUsd: 25 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, maxDailyCostUsd: 25 });
  let onDisk = readJson(configFile) as { maxDailyCostUsd: number };
  assert.equal(onDisk.maxDailyCostUsd, 25);

  // Fractional dollars keep their cents (the badge renders them).
  res = await postJson(base, "/api/budget", { maxDailyCostUsd: 12.34 });
  assert.equal(res.status, 200);
  onDisk = readJson(configFile) as { maxDailyCostUsd: number };
  assert.equal(onDisk.maxDailyCostUsd, 12.34);

  // Zero disables the cap — a valid value, not an error.
  res = await postJson(base, "/api/budget", { maxDailyCostUsd: 0 });
  assert.equal(res.status, 200);
  onDisk = readJson(configFile) as { maxDailyCostUsd: number };
  assert.equal(onDisk.maxDailyCostUsd, 0);

  // The save preserved every other key: diff the file minus that one key against a fresh
  // load of the same config (initProject's defaults plus nothing else changed).
  const raw = readJson(configFile) as Record<string, unknown>;
  delete raw.maxDailyCostUsd;
  const { maxDailyCostUsd: _ignored, ...rest } = loadConfig(repo) as unknown as Record<string, unknown> & {
    maxDailyCostUsd: number;
  };
  assert.deepEqual(raw, rest, "only maxDailyCostUsd differs from the loaded config");

  // Invalid bodies get 400 with an actionable message and leave the file untouched.
  const before = fs.readFileSync(configFile, "utf8");
  for (const body of ["{}", '{"maxDailyCostUsd": -1}', '{"maxDailyCostUsd": NaN}', '{"maxDailyCostUsd": "25"}', 'not json', "null", "[0]"]) {
    res = await fetch(base + "/api/budget", { method: "POST", body });
    assert.equal(res.status, 400, body);
    const err = (await res.json()) as { error: string };
    assert.ok(err.error.length > 0, `actionable message for ${body}`);
  }
  assert.match((await postRaw<{ error: string }>(base, "/api/budget", '{"maxDailyCostUsd": -1}')).error, /-1/);
  assert.equal(fs.readFileSync(configFile, "utf8"), before, "rejected bodies change nothing");

  // No tmp remnant from any of the writes above.
  const leftovers = fs.readdirSync(repo).filter((f) => f.startsWith("tumwater.json.tmp-"));
  assert.deepEqual(leftovers, [], "no tmp file left behind");
  });
});

// The 500 half of /api/budget: a VALID value that fails server-side (broken tumwater.json)
// is not the client's fault — it must come back as 500 with the setter's error, never as 200
// (the badge would claim a cap that was never persisted) or 400 (blaming the request).
test("POST /api/budget answers 500 when a valid value fails server-side", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui budget 500 test");
  const configFile = path.join(repo, "tumwater.json");
  // Corrupt the config after init: loadConfig throws on it, so setDailyBudgetUsd — which
  // deliberately reads fresh and never overwrites a broken file with defaults — reports an error.
  fs.writeFileSync(configFile, "{ still editing");
  await withGui(repo, async ({ base }) => {
  const res = await postJson(base, "/api/budget", { maxDailyCostUsd: 25 }); // valid value — the failure is server-side
  assert.equal(res.status, 500);
  const err = (await res.json()) as { error: string };
  assert.match(err.error, /not valid JSON/);
  // The broken file survives untouched — a failed save must not clobber it with defaults + cap.
  assert.equal(fs.readFileSync(configFile, "utf8"), "{ still editing");
  // And the atomic write's tmp half left no remnant behind.
  assert.deepEqual(
    fs.readdirSync(repo).filter((f) => f.startsWith("tumwater.json.tmp-")),
    [],
    "no tmp file left behind",
  );
  });
});

// POST /api/pause — the dashboard header's pause/resume toggle: the same shared fleet-state.ts
// writers the CLI uses, so the GUI and `tumwater pause`/`resume` cannot drift.

test("POST /api/pause writes and removes the fleet pause marker and rejects bad bodies", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui pause route test");
  await withGui(repo, async ({ base }) => {
  // Pausing writes the persistent marker and reports the new state; a repeat is idempotent.
  let res = await postJson(base, "/api/pause", { paused: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, paused: true });
  assert.ok(fs.existsSync(pausedPath(repo)), "the pause marker exists");
  res = await postJson(base, "/api/pause", { paused: true });
  assert.equal(res.status, 200);
  assert.ok(fs.existsSync(pausedPath(repo)), "a repeat pause leaves the marker in place");

  // Resuming removes it.
  res = await postJson(base, "/api/pause", { paused: false });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, paused: false });
  assert.equal(fs.existsSync(pausedPath(repo)), false, "the pause marker is gone");

  // Missing / non-boolean / malformed / non-object bodies all get 400 and change nothing.
  for (const body of ["{}", '{"paused": "true"}', '{"paused": 1}', '{"paused": null}', "not json", "null", "[true]"]) {
    res = await fetch(base + "/api/pause", { method: "POST", body });
    assert.equal(res.status, 400, body);
    const err = (await res.json()) as { error: string };
    assert.ok(err.error.length > 0, `actionable message for ${body}`);
  }
  assert.equal(fs.existsSync(pausedPath(repo)), false, "rejected bodies leave the marker untouched");
  assert.match((await postRaw<{ error: string }>(base, "/api/pause", '{"paused": "true"}')).error, /boolean/);

  // An oversized body gets 413 (readJsonObject's shared guard), still touching nothing.
  res = await fetch(base + "/api/pause", {
    method: "POST",
    body: JSON.stringify({ paused: true, pad: "x".repeat(MAX_BODY_BYTES) }),
  });
  assert.equal(res.status, 413);
  assert.equal(fs.existsSync(pausedPath(repo)), false, "an oversized body leaves the marker untouched");
  });
});

// The dashboard's pause menu offers timed pauses: /api/pause takes an optional forSeconds and
// writes the same `until` deadline `tumwater pause --for` does, under the same 90-day cap.
test("POST /api/pause with forSeconds writes a timed pause and rejects bad durations", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui timed pause test");
  await withGui(repo, async ({ base }) => {
  const before = Date.now();
  let res = await postJson(base, "/api/pause", { paused: true, forSeconds: 1800 });
  assert.equal(res.status, 200);
  const answer = (await res.json()) as { ok: boolean; paused: boolean; until: number };
  assert.equal(answer.paused, true);
  const marker = readJson(pausedPath(repo)) as { until: number };
  assert.equal(marker.until, answer.until, "the answer names the deadline the marker holds");
  assert.ok(marker.until >= before + 1_800_000 && marker.until <= Date.now() + 1_800_000, "30 minutes from now");
  assert.equal((statusPayload(repo) as { pausedUntil?: number }).pausedUntil, marker.until, "the payload's countdown reads it");

  // A deadline only makes sense when pausing; a non-positive, non-numeric, or over-cap one is a
  // client error that leaves the marker alone.
  for (const body of [
    { paused: false, forSeconds: 60 },
    { paused: true, forSeconds: 0 },
    { paused: true, forSeconds: -5 },
    { paused: true, forSeconds: "3600" },
    { paused: true, forSeconds: 91 * 86_400 },
  ]) {
    res = await fetch(base + "/api/pause", { method: "POST", body: JSON.stringify(body) });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(((await res.json()) as { error: string }).error, /forSeconds/);
  }
  assert.equal((readJson(pausedPath(repo)) as { until: number }).until, marker.until, "rejected bodies leave the deadline");

  // A pause without forSeconds is a standing one, as before.
  res = await fetch(base + "/api/pause", { method: "POST", body: JSON.stringify({ paused: true }) });
  assert.deepEqual(await res.json(), { ok: true, paused: true });
  });
});

// --- POST /api/wake and POST /api/abort — the dashboard's per-row controls, backed by the
// same marker-writing cores (requestWake/requestAbort in operator-intent.ts) the CLI
// commands call, so the two surfaces cannot drift on the state they write or the text they
// report. The fleet-side marker consumption is pinned in test/orchestrator.e2e.test.ts;
// here we pin the HTTP layer: the markers it writes, its validation, and its status codes.

test("POST /api/wake writes the same state as `tumwater wake` and rejects bad bodies", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui wake test");
  const s = freshLoopState("feature");
  s.backoffSeconds = 15;
  saveLoopState(repo, s);
  await withGui(repo, async ({ base }) => {
  // One named role: the row's wake link. The message is the CLI's own confirmation text
  // (no harness here, so the not-live form), and the marker + state-file edits match.
  let res = await postJson(base, "/api/wake", { role: "feature" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    message: "wake requested for feature — takes effect on the next `tumwater run` (no harness is running)",
  });
  const marker = readJson(wakeRequestPath(repo)) as { roles: string[] };
  assert.deepEqual(marker.roles, ["feature"]);
  assert.equal(loadLoopState(repo, "feature").backoffSeconds, 0, "the row's backoff cleared");

  // `{}` — the empty/missing-role body targets every configured role, like the CLI's
  // all-roles default.
  fs.rmSync(wakeRequestPath(repo));
  res = await fetch(base + "/api/wake", { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  const fleetMarker = readJson(wakeRequestPath(repo)) as { roles: string[] };
  assert.deepEqual([...fleetMarker.roles].sort(), Object.keys(loadConfig(repo).roles).sort());

  // Unknown / non-string roles get the transcript endpoint's 400 wording, and change nothing.
  for (const body of ['{"role": "bogus"}', '{"role": 7}']) {
    const bad = await fetch(base + "/api/wake", { method: "POST", body });
    assert.equal(bad.status, 400, body);
    assert.match(((await bad.json()) as { error: string }).error, /valid ids: feature, bugfix/);
  }
  fs.rmSync(wakeRequestPath(repo));
  // Malformed / non-object bodies get readJsonObject's shared 400, and an oversized body 413.
  for (const body of ["not json", "null", "[true]", JSON.stringify({ role: "feature", pad: "x".repeat(MAX_BODY_BYTES) })]) {
    const bad = await fetch(base + "/api/wake", { method: "POST", body });
    assert.equal(bad.status, body.includes("pad") ? 413 : 400, body.slice(0, 40));
  }
  assert.equal(fs.existsSync(wakeRequestPath(repo)), false, "rejected bodies leave the marker untouched");
  });
});

test("POST /api/abort writes the marker for a live fleet, answers 409 when not, 400 for bad roles", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui abort test");
  await withGui(repo, async ({ base }) => {
  // No harness running: the marker is valid but nothing can consume it — a conflict, not a
  // client error, so the CLI's not-live error rides out as 409 and nothing is written.
  let res = await postJson(base, "/api/abort", { role: "feature" });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "no harness is running — start it with `tumwater run` first" });
  assert.ok(!fs.existsSync(abortRequestPath(repo, "feature")), "not-live writes no marker");

  // Record this test process as the running orchestrator (it is alive): now the request
  // drops the marker and reports the CLI's confirmation text verbatim.
  writeOrchestratorMarker(repo, ["feature"]);
  res = await fetch(base + "/api/abort", {
    method: "POST",
    body: JSON.stringify({ role: "feature" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    message: "abort requested for feature — a running fleet applies it within ~2s",
  });
  const marker = readJson(abortRequestPath(repo, "feature")) as { at: number };
  assert.ok(marker.at > 0);

  // The director variant's message names the discarded prompt, like the CLI's does.
  res = await fetch(base + "/api/abort", { method: "POST", body: JSON.stringify({ role: "director" }) });
  assert.equal(res.status, 200);
  assert.match(((await res.json()) as { message: string }).message, /prompt will be discarded/);

  // Missing / unknown / non-string roles get 400 naming the accepted ids; malformed
  // bodies get readJsonObject's shape 400 instead (both touch nothing).
  for (const body of ["{}", '{"role": "bogus"}', '{"role": null}', '{"role": 1}']) {
    const bad = await fetch(base + "/api/abort", { method: "POST", body });
    assert.equal(bad.status, 400, body);
    assert.match(((await bad.json()) as { error: string }).error, /valid ids: feature, bugfix/);
  }
  const malformed = await fetch(base + "/api/abort", { method: "POST", body: "not json" });
  assert.equal(malformed.status, 400);
  assert.match(((await malformed.json()) as { error: string }).error, /JSON object/);
  });
});

// POST /api/pause-role — the dashboard's per-row pause/resume toggle, backed by the same
// marker functions (`tumwater pause --role` / `resume --role` use) so the two surfaces cannot
// drift. The scheduler-side consumption is pinned in test/orchestrator.e2e.test.ts; here we
// pin the HTTP layer: the marker it writes, its validation, its idempotence, and its codes.
test("POST /api/pause-role writes the per-role marker, is idempotent, and rejects bad bodies", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui pause-role test");
  await withGui(repo, async ({ base }) => {
  // Pause one named role: the marker records it, and a repeat is idempotent (changed false).
  const post = (payload: unknown) => postJson(base, "/api/pause-role", payload);
  let res = await post({ role: "feature", paused: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, changed: true, paused: true });
  assert.deepEqual(
    readJson<{ roles: string[] }>(pausedRolesPath(repo)).roles,
    ["feature"],
  );
  res = await post({ role: "feature", paused: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, changed: false, paused: true }, "re-pausing is idempotent");
  assert.deepEqual(
    readJson<{ roles: string[] }>(pausedRolesPath(repo)).roles,
    ["feature"],
    "the idempotent repeat leaves one marker entry",
  );

  // Resume: the role leaves the marker, and a fully-resumed fleet leaves no file behind.
  res = await post({ role: "feature", paused: false });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, changed: true, paused: false });
  assert.equal(fs.existsSync(pausedRolesPath(repo)), false, "the last removal deletes the marker");
  res = await post({ role: "feature", paused: false });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, changed: false, paused: false }, "resuming an unpaused role is idempotent");

  // Unknown / missing / non-string roles get the shared rejectBadRole 400 wording, and a
  // non-boolean paused gets the /api/pause wording — none of them writes a marker.
  for (const body of [
    { role: "bogus", paused: true },
    { role: 7, paused: true },
    { paused: true },
    { role: "feature" },
    { role: "feature", paused: "true" },
  ]) {
    const bad = await post(body);
    assert.equal(bad.status, 400, JSON.stringify(body));
    const err = ((await bad.json()) as { error: string }).error;
    if ("role" in body && body.role !== "feature") assert.match(err, /valid ids: feature, bugfix/);
    else if (!("role" in body)) assert.match(err, /role required/);
    else assert.match(err, /paused must be a boolean/);
  }
  // Malformed / non-object bodies get readJsonObject's shared 400, an oversized body 413.
  for (const body of ["not json", "null", "[true]", JSON.stringify({ role: "feature", paused: true, pad: "x".repeat(MAX_BODY_BYTES) })]) {
    const bad = await fetch(base + "/api/pause-role", { method: "POST", body });
    assert.equal(bad.status, body.includes("pad") ? 413 : 400, body.slice(0, 40));
  }
  assert.equal(fs.existsSync(pausedRolesPath(repo)), false, "rejected bodies leave the marker untouched");
  });
});

// POST /api/prompt-role — the dashboard's per-row prompt control, backed by the same submit
// path `tumwater prompt --role <id>` uses (submitRolePrompt + a single-role wake), so the
// surfaces cannot drift on queue format or wording. Here: the queue landing, the role
// validation shared with /api/transcript, and the body discipline shared with /api/prompt.
test("POST /api/prompt-role queues for the named loop and rejects bad bodies like its peers", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui prompt-role test");
  await withGui(repo, async ({ base }) => {
  const post = (payload: unknown) => postJson(base, "/api/prompt-role", payload);
  const res = await post({ role: "feature", text: "  tighten the docs  " });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; message: string };
  assert.equal(body.ok, true);
  assert.match(body.message, /wake requested for feature/);
  // The queue holds the trimmed text — the same files `tumwater prompt --list --role` reads.
  assert.deepEqual(queuedRolePrompts(repo, "feature"), ["tighten the docs"]);
  // The wake marker names just that loop.
  assert.deepEqual(readJson<{ roles: string[] }>(wakeRequestPath(repo)).roles, ["feature"]);

  // An unknown role reads the same error text /api/transcript answers with (the shared
  // rejectBadRole wording), and the text rules match /api/prompt's.
  const transcriptRes = await fetch(base + "/api/transcript?role=bogus&n=5");
  const transcriptErr = ((await transcriptRes.json()) as { error: string }).error;
  const unknown = await post({ role: "bogus", text: "hi" });
  assert.equal(unknown.status, 400);
  assert.equal(((await unknown.json()) as { error: string }).error, transcriptErr);
  for (const payload of [
    { role: "feature" },
    { role: "feature", text: 7 },
    { role: "feature", text: "   " },
    { role: "feature", text: "x".repeat(DIRECTOR_PROMPT_MAX_CHARS + 1) },
  ]) {
    const bad = await post(payload);
    assert.equal(bad.status, 400, JSON.stringify(payload).slice(0, 60));
    assert.equal(queuedRolePrompts(repo, "feature").length, 1, "the rejected body queued nothing");
  }
  // Malformed / non-object bodies get readJsonObject's shared 400, an oversized body 413.
  for (const body of ["not json", "null", "[true]", JSON.stringify({ role: "feature", text: "x", pad: "y".repeat(MAX_BODY_BYTES) })]) {
    const bad = await fetch(base + "/api/prompt-role", { method: "POST", body });
    assert.equal(bad.status, body.includes("pad") ? 413 : 400, body.slice(0, 40));
  }
  });
});

// The payload's roleInbox: per-role queue counts for every enabled loop except the director
// (its queue IS the shared inbox), matching the on-disk queues the CLI's --list reads.
test("the status payload carries per-role queue counts (roleInbox)", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui roleInbox test");
  enqueueRolePrompt(repo, "feature", "one");
  enqueueRolePrompt(repo, "bugfix", "two");
  enqueueRolePrompt(repo, "bugfix", "three");
  const payload = statusPayload(repo) as { roleInbox: Record<string, number>; inbox: number };
  assert.equal(payload.roleInbox.feature, 1);
  assert.equal(payload.roleInbox.bugfix, 2);
  assert.ok(!("director" in payload.roleInbox), "the director's queue is the shared inbox, not roleInbox");
  assert.equal(payload.inbox, 0);
});
