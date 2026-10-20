import test from "node:test";
import { readJson, readScheduledWakes } from "./helpers/json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { MAX_BODY_BYTES } from "../src/gui/http-body.js";
import { initProject } from "../src/init/init.js";
import { PAUSE_REASON_MAX } from "../src/team/team-state.js";
import { mergeStatePath, pausedPath, abortRequestPath, wakeRequestPath, pausedRolesPath, scheduledWakeDir } from "../src/paths.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { todayStamp } from "../src/budget/budget.js";
import { enqueueRolePrompt, queuedRolePromptEntries, queuedRolePrompts } from "../src/inbox/inbox.js";
import { DIRECTOR_PROMPT_MAX_CHARS } from "../src/inbox/inbox-submit.js";
import { enqueueMerge } from "../src/merge/merge-queue.js";
import { requestResetCounters } from "../src/operator/operator-intent.js";
import { postJson, withGui } from "./fixtures/gui-fixtures.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";

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
// page renders as its header badge, and a paused team's idle roles read `waiting: budget spent`
// in their phase payload.

test("status payload carries the daily budget while enabled and null when disabled", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui budget test"); // defaultConfig: maxDailyCostUsd 50 (enabled)
  // The spend and every read below are pinned to local noon through the payload's clock seam:
  // elapsed-since-midnight enters the burn-rate projection's rate, so a real-clock read could
  // legitimately attach a `~cap at HH:MM` fragment here in the early morning hours — the same
  // wall-clock race the status-data suite avoids. At noon this $12.34-vs-$50 burn always
  // projects past midnight, so the badge stays fragment-free, deterministically.
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const atNoon = () => statusPayload(repo, now.getTime()) as typeof payload;
  let payload = atNoon() as { budget: { spentUsd: number; capUsd: number; capHitAt: number | null; free: boolean; fallback: { provider?: string; model?: string } | null } | null; budgetBadge: string };
  // No provider/model configured (pi's own default) — the team cannot be verified as free.
  assert.deepEqual(payload.budget, { spentUsd: 0, capUsd: 50, capHitAt: null, free: false, backend: "pi", fallback: null, tiers: null }, "enabled by default with no spend yet");
  assert.equal(payload.budgetBadge, " · budget: $0.00/$50 today", "the preformatted badge matches the TUI header string");

  // Today's spend is summed from the roles' persisted daily windows (a stale stamp reads $0).
  const s = freshRunnerState("clean");
  s.dayStamp = todayStamp(now.getTime());
  s.dayCostUsd = 12.34;
  saveRunnerState(repo, s);
  payload = atNoon() as typeof payload;
  assert.equal(payload.budget?.spentUsd, 12.34, "today's spend shows in the badge data");
  assert.equal(payload.budgetBadge, " · budget: $12.34/$50 today", "today's spend shows in the badge text");

  // 0 disables: the raw data stays (spend is still reported; capUsd 0 says disabled) and
  // the preformatted badge switches to the standing `· no cap` form — it never disappears,
  // because the badge is also the affordance for setting a cap from a disabled team.
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsd = 0;
  saveConfig(repo, cfg);
  payload = atNoon() as typeof payload;
  assert.deepEqual(payload.budget, { spentUsd: 12.34, capUsd: 0, capHitAt: null, free: false, backend: "pi", fallback: null, tiers: null }, "cap 0 disables the gate but keeps the data");
  assert.equal(payload.budgetBadge, " · budget: $12.34 today · no cap", "disabled: standing badge with spend and no cap");
});

// Merge queue 4/5 — the payload's mergeQueue field: depth always present, inFlight only
// while a merge is actually running (marker + matching entry + live orchestrator), and
// the preformatted mergeBadge the page renders in its header.
test("status payload carries the merge queue depth and the in-flight merge", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui merge queue test");
  const payload = statusPayload(repo) as {
    mergeQueue: { depth: number; inFlight?: { role: string; sha: string; summary: string; startedAt: number; stage?: string } };
    mergeBadge: string;
    roles: Array<{ role: string; phase: string; inFlight: boolean }>;
  };
  // Idle: depth 0 (the field is never null/absent — one stable shape for JSON consumers)
  // and the preformatted badge is empty, so the page appends nothing.
  assert.equal(payload.mergeQueue.depth, 0);
  assert.equal(payload.mergeBadge, "");

  // One queued entry lifts the depth — but a merely queued merge is not in flight.
  enqueueMerge(repo, { role: "clean", sha: "abc1234", run: 1, summary: "tidy something", enqueuedAt: Date.now() });
  let p = statusPayload(repo) as typeof payload;
  assert.equal(p.mergeQueue.depth, 1);
  assert.equal(p.mergeBadge, " · merge queue: 1");
  assert.equal(p.mergeQueue.inFlight, undefined, "queued, not merge: no inFlight yet");

  // A live orchestrator plus the 4/5 marker with a matching entry → in flight, and the
  // merge role's row phase reads `merge <elapsed> · <stage>` while every other row is
  // untouched.
  writeOrchestratorMarker(repo, ["clean"]);
  const startedAt = Date.now();
  fs.writeFileSync(
    mergeStatePath(repo),
    JSON.stringify({ role: "clean", sha: "abc1234", summary: "tidy something", startedAt, stage: "build-check" }),
  );
  p = statusPayload(repo) as typeof payload;
  assert.equal(p.mergeQueue.inFlight?.role, "clean");
  assert.equal(p.mergeQueue.inFlight?.sha, "abc1234");
  assert.match(
    p.roles.find((l) => l.role === "clean")!.phase,
    /^merging \d+s · checking$/,
    "the merge role's phase is marker-driven, stage included",
  );
  assert.equal(p.mergeQueue.inFlight?.stage, "build-check", "the raw record carries the stage for `status --json`");
  assert.equal(p.roles.find((l) => l.role === "bugfix")!.phase, "due", "other roles keep their normal phase");
  // The row-level inFlight flag (isActivePhase over the rendered phase) is the permit-holder
  // cap set the payload exports: the merge role is in flight, every other row is not. (The
  // GUI's row actions read their own live flag from the phase, which also includes the exempt
  // running director — BUGS.md 2026-10-06.)
  assert.equal(p.roles.find((l) => l.role === "clean")!.inFlight, true, "the merge row is in flight");
  assert.equal(p.roles.find((l) => l.role === "bugfix")!.inFlight, false, "idle rows are not");
});

// Regression (review of the editable-budget feature): the payload's budget object is now
// unconditional, so a DISABLED cap must not read as reached — with a running orchestrator,
// spend ≥ 0 = cap would otherwise export every idle role as `waiting: budget spent`.
test("a disabled cap never pauses the team in the phase payload", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui no-cap test");
  // A live orchestrator (this process) so rolePhase doesn't short-circuit to "stopped"…
  writeOrchestratorMarker(repo, ["clean"]);
  // …cap disabled with today's spend far above zero.
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsd = 0;
  saveConfig(repo, cfg);
  const s = freshRunnerState("clean");
  s.dayStamp = todayStamp();
  s.dayCostUsd = 500; // would be "reached" against any positive cap
  saveRunnerState(repo, s);

  const payload = statusPayload(repo) as {
    budget: { spentUsd: number; capUsd: number; free: boolean };
    budgetBadge: string;
    roles: Array<{ role: string; phase: string }>;
  };
  assert.deepEqual(payload.budget, { spentUsd: 500, capUsd: 0, capHitAt: null, free: false, backend: "pi", fallback: null, tiers: null });
  assert.equal(payload.budgetBadge, " · budget: $500.00 today · no cap");
  // No role reads waiting: budget spent — the gate is off by definition while the cap is 0.
  for (const l of payload.roles) {
    assert.notEqual(l.phase, "waiting: budget spent", `${l.role} must not read waiting: budget spent with the cap disabled`);
  }
  assert.match(payload.roles.find((l) => l.role === "clean")?.phase ?? "", /^(due|sleeping)/);
  // The director is exempt as always.
  assert.equal(payload.roles.find((l) => l.role === "director")?.phase, "ready for messages");
});

// The operator module is served through string interpolation into GUI_CLIENT_JS, so a
// stray newline or lost indent at either splice boundary would ship a silently different
// dashboard script while the module and its region tests all still pass. Pin the splice:
// the assembled script must contain the module's constant verbatim, end to end.
test("GUI_CLIENT_JS carries the operator module as a byte-exact contiguous splice", async () => {
  const { GUI_CLIENT_JS } = await import("../src/ui/gui/gui-client.js");
  const { GUI_CLIENT_OPERATOR_JS } = await import("../src/ui/gui/gui-client-operator.js");
  assert.ok(
    GUI_CLIENT_JS.includes(GUI_CLIENT_OPERATOR_JS),
    "the operator module's constant must appear verbatim in the assembled script " +
      "(a mismatch means the interpolation gained or lost bytes at a splice boundary)",
  );
});

test("a paused team's idle roles read waiting: budget spent in the phase payload", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui budget pause test");
  // A live orchestrator (this process) so rolePhase doesn't short-circuit to "stopped"…
  writeOrchestratorMarker(repo, ["clean"]);
  // …and spend at the cap so the team-wide pause flag is set.
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsd = 10;
  saveConfig(repo, cfg);
  const s = freshRunnerState("clean");
  s.dayStamp = todayStamp();
  s.dayCostUsd = 12.5; // >= cap → paused
  saveRunnerState(repo, s);

  let payload = statusPayload(repo) as { roles: Array<{ role: string; phase: string }> };
  assert.equal(payload.roles.find((l) => l.role === "clean")?.phase, "waiting: budget spent");
  // The director is exempt from the cap — its phase keeps its own label.
  assert.equal(payload.roles.find((l) => l.role === "director")?.phase, "ready for messages");

  // Under the cap again: the idle role goes back to its sleep/queue state.
  const under = freshRunnerState("clean");
  under.dayStamp = todayStamp();
  under.dayCostUsd = 1;
  saveRunnerState(repo, under);
  payload = statusPayload(repo) as typeof payload;
  assert.notEqual(payload.roles.find((l) => l.role === "clean")?.phase, "waiting: budget spent");
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
  // The same cap again writes nothing and says so.
  const bytes = fs.readFileSync(configFile, "utf8");
  res = await postJson(base, "/api/budget", { maxDailyCostUsd: 25 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, maxDailyCostUsd: 25, unchanged: true });
  assert.equal(fs.readFileSync(configFile, "utf8"), bytes);

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

// POST /api/pause — the dashboard header's pause/resume toggle: the same shared
// team/team-state.ts
// writers the CLI uses, so the GUI and `tumwater pause`/`resume` cannot drift.

test("POST /api/pause writes and removes the team pause marker and rejects bad bodies", async () => {
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

// The pause menu's optional reason rides the same route and lands in the marker as the CLI's
// `pause --reason` does (pauseTeam folds and caps it).
test("POST /api/pause with a reason stores it folded and capped and rejects bad reasons", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui pause reason test");
  await withGui(repo, async ({ base }) => {
  const marker = () => readJson(pausedPath(repo)) as { until?: number; reason?: string };
  let res = await postJson(base, "/api/pause", { paused: true, reason: "  deploying\n v2 " });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, paused: true, reason: "deploying v2" });
  assert.equal(marker().reason, "deploying v2");

  await postJson(base, "/api/pause", { paused: false });
  res = await postJson(base, "/api/pause", { paused: true, forSeconds: 3600, reason: "x" });
  assert.equal(res.status, 200);
  assert.equal(marker().reason, "x");
  assert.ok(typeof marker().until === "number", "the deadline is written too");

  await postJson(base, "/api/pause", { paused: false }); // a repeat pause keeps the first marker
  res = await postJson(base, "/api/pause", { paused: true, reason: "   " });
  assert.equal(res.status, 200);
  assert.equal(marker().reason, undefined, "a blank reason is a plain pause");

  await postJson(base, "/api/pause", { paused: false });
  res = await postJson(base, "/api/pause", { paused: true, reason: "y".repeat(300) });
  assert.equal(res.status, 200);
  assert.ok((marker().reason ?? "").length <= PAUSE_REASON_MAX);
  assert.ok((marker().reason ?? "").length > 0);

  res = await postJson(base, "/api/pause", { paused: false, reason: "x" });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /only applies when pausing/);
  res = await postJson(base, "/api/pause", { paused: true, reason: 5 });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /must be a string/);
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
  // The over-cap refusal names both the cap and the offending value, like every sibling
  // value-shape error in the handler and the CLI's shared duration-cap message, so the
  // operator sees how far past the cap they are.
  res = await fetch(base + "/api/pause", { method: "POST", body: JSON.stringify({ paused: true, forSeconds: 91 * 86_400 }) });
  assert.equal(res.status, 400);
  assert.match(
    ((await res.json()) as { error: string }).error,
    /capped at 7776000 seconds \(90 days\) \(got 7862400\)/,
  );
  assert.equal((readJson(pausedPath(repo)) as { until: number }).until, marker.until, "rejected bodies leave the deadline");

  // A pause without forSeconds is a standing one, as before.
  res = await fetch(base + "/api/pause", { method: "POST", body: JSON.stringify({ paused: true }) });
  assert.deepEqual(await res.json(), { ok: true, paused: true });
  });
});

// --- POST /api/wake and POST /api/abort — the dashboard's per-row controls, backed by the
// same marker-writing cores (requestWake/requestAbort in operator/operator-intent.ts) the CLI
// commands call, so the two surfaces cannot drift on the state they write or the text they
// report. The team-side marker consumption is pinned in test/orchestrator.e2e.test.ts;
// here we pin the HTTP layer: the markers it writes, its validation, and its status codes.

test("POST /api/wake writes the same state as `tumwater wake` and rejects bad bodies", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui wake test");
  const s = freshRunnerState("feature");
  s.backoffSeconds = 15;
  saveRunnerState(repo, s);
  await withGui(repo, async ({ base }) => {
  // One named role: the row's wake link. The message is the CLI's own confirmation text
  // (no harness here, so the not-live form), and the marker + state-file edits match.
  let res = await postJson(base, "/api/wake", { role: "feature" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    message: "wake requested for feature — takes effect on the next `tumwater start` (tumwater is not running)",
  });
  const marker = readJson(wakeRequestPath(repo)) as { roles: string[] };
  assert.deepEqual(marker.roles, ["feature"]);
  assert.equal(loadRunnerState(repo, "feature").backoffSeconds, 0, "the row's backoff cleared");

  // `{}` — the empty/missing-role body targets every configured role, like the CLI's
  // all-roles default.
  fs.rmSync(wakeRequestPath(repo));
  res = await fetch(base + "/api/wake", { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  const teamMarker = readJson(wakeRequestPath(repo)) as { roles: string[] };
  assert.deepEqual([...teamMarker.roles].sort(), Object.keys(loadConfig(repo).roles).sort());

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

test("POST /api/wake with inSeconds schedules the wake like `tumwater wake --in`", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui wake in test");
  await withGui(repo, async ({ base }) => {
    let res = await postJson(base, "/api/wake", { inSeconds: 1800 });
    assert.equal(res.status, 200);
    assert.match(((await res.json()) as { message: string }).message, /wakes in 30m/);
    let [marker] = readScheduledWakes(repo);
    assert.ok(marker, "the scheduled marker is written");
    assert.equal(marker.notBeforeMs - marker.at, 1800000);
    assert.deepEqual([...marker.roles].sort(), Object.keys(loadConfig(repo).roles).sort());

    res = await postJson(base, "/api/wake", { role: "feature", inSeconds: 60 });
    assert.equal(res.status, 200);
    assert.equal(readScheduledWakes(repo).length, 2, "the second request leaves the first standing");
    // The helper orders by notBeforeMs (the 30m request's deadline is later than the feature
    // request's 60s one), so find the feature wake by role rather than by position.
    marker = readScheduledWakes(repo).find((m) => m.roles.includes("feature"));
    assert.deepEqual(marker?.roles, ["feature"]);

    fs.rmSync(scheduledWakeDir(repo), { recursive: true });
    for (const inSeconds of [0, -5, "30", 7776001]) {
      const bad = await postJson(base, "/api/wake", { inSeconds });
      assert.equal(bad.status, 400, String(inSeconds));
      assert.match(((await bad.json()) as { error: string }).error, /inSeconds/);
    }
    assert.equal(fs.existsSync(wakeRequestPath(repo)), false, "rejected bodies leave no marker");
  });
});

test("POST /api/reset-counters zeroes counters like `tumwater reset-counters` and rejects bad bodies", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui reset test");
  const seed = () => {
    const s = freshRunnerState("feature");
    s.runs = 7;
    saveRunnerState(repo, s);
  };
  seed();
  await withGui(repo, async ({ base }) => {
    let res = await postJson(base, "/api/reset-counters", { role: "feature" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, message: requestResetCounters(repo, ["feature"]) });
    assert.equal(loadRunnerState(repo, "feature").runs, 0);

    seed();
    res = await fetch(base + "/api/reset-counters", { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(loadRunnerState(repo, "feature").runs, 0, "{} targets every configured role");

    seed();
    const bad = await fetch(base + "/api/reset-counters", { method: "POST", body: '{"role": "bogus"}' });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /valid ids:/);
    const malformed = await fetch(base + "/api/reset-counters", { method: "POST", body: "not json" });
    assert.equal(malformed.status, 400);
    assert.equal(loadRunnerState(repo, "feature").runs, 7, "rejected bodies leave the counters untouched");
  });
});

test("POST /api/abort writes the marker for a live team, answers 409 when not, 400 for bad roles", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui abort test");
  await withGui(repo, async ({ base }) => {
  // No harness running: the marker is valid but nothing can consume it — a conflict, not a
  // client error, so the CLI's not-live error rides out as 409 and nothing is written.
  let res = await postJson(base, "/api/abort", { role: "feature" });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "tumwater is not running — start it with `tumwater start` first" });
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
    message: "abort requested for feature — the running team applies it within ~2s",
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
  const configFile = path.join(repo, "tumwater.json");
  const cfg = readJson<{ roles: Record<string, { instances?: number }> }>(configFile);
  cfg.roles.feature!.instances = 2; // makes `feature-2` a valid row id
  fs.writeFileSync(configFile, JSON.stringify(cfg));
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

  // Resume: the role leaves the marker, and a fully-resumed team leaves no file behind.
  res = await post({ role: "feature", paused: false });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, changed: true, paused: false });
  assert.equal(fs.existsSync(pausedRolesPath(repo)), false, "the last removal deletes the marker");
  res = await post({ role: "feature", paused: false });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, changed: false, paused: false }, "resuming an unpaused role is idempotent");

  // Instance 1's row (bare `feature`) paused under the `feature-1` key shows Resume; the click
  // names the row's id and must lift that key.
  fs.mkdirSync(path.dirname(pausedRolesPath(repo)), { recursive: true });
  // Instance 2's row (`feature-2`) paused by the whole-role `feature` marker likewise lifts it.
  for (const [row, key] of [["feature", "feature-1"], ["feature-2", "feature"]] as const) {
    fs.writeFileSync(pausedRolesPath(repo), JSON.stringify({ roles: [key] }));
    res = await post({ role: row, paused: false });
    assert.deepEqual(await res.json(), { ok: true, changed: true, paused: false }, `${row} resumes ${key}`);
    assert.equal(fs.existsSync(pausedRolesPath(repo)), false, `${key} left the marker`);
  }

  // A timed pause writes the CLI's shared `until`; a later one overwrites it; bad forSeconds 400s.
  const t0 = Date.now();
  res = await post({ role: "feature", paused: true, forSeconds: 3600 });
  assert.equal(res.status, 200);
  const timed = (await res.json()) as { until: number };
  assert.ok(Math.abs(timed.until - (t0 + 3_600_000)) < 2000);
  assert.equal(readJson<{ until: number }>(pausedRolesPath(repo)).until, timed.until);
  res = await post({ role: "feature", paused: true, forSeconds: 60 });
  assert.ok(Math.abs(((await res.json()) as { until: number }).until - (Date.now() + 60_000)) < 2000);
  for (const [body, re] of [
    [{ role: "feature", paused: false, forSeconds: 60 }, /only applies when pausing/],
    [{ role: "feature", paused: true, forSeconds: 0 }, /positive number/],
    [{ role: "feature", paused: true, forSeconds: -5 }, /positive number/],
    [{ role: "feature", paused: true, forSeconds: "9" }, /positive number/],
    [{ role: "feature", paused: true, forSeconds: 1e9 }, /capped at/],
  ] as const) {
    const bad = await post(body);
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.match(((await bad.json()) as { error: string }).error, re);
  }
  res = await post({ role: "feature", paused: false });
  assert.equal(res.status, 200);
  assert.equal(fs.existsSync(pausedRolesPath(repo)), false);

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
// surfaces cannot drift on queue format or wording. Here: the queue merge, the role
// validation shared with /api/transcript, and the body discipline shared with /api/prompt.
test("POST /api/prompt-role queues for the named role and rejects bad bodies like its peers", async () => {
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
  // The wake marker names just that role.
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

// POST /api/prompt and /api/prompt-role defer: the composer's defer field rides into the
// same submit path `tumwater prompt --at <duration>` uses, so a deferred prompt queues the
// CLI's not-before marker and a bad defer is a 400 before anything is written.
test("the prompt endpoints defer a prompt by duration and reject bad defer fields", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui prompt defer test");
  await withGui(repo, async ({ base }) => {
  const beforeMs = Date.now();
  const res = await postJson(base, "/api/prompt", { text: "later, please", defer: "90m" });
  assert.equal(res.status, 200);
  const director = queuedRolePromptEntries(repo, "director");
  assert.equal(director.length, 1);
  const at = director[0]?.notBeforeMs;
  assert.ok(at !== null && at !== undefined, "the queued director prompt carries a not-before marker");
  assert.ok(
    at! >= beforeMs + 90 * 60_000 - 1_000 && at! <= Date.now() + 90 * 60_000 + 1_000,
    `defer 90m queues roughly now + 90m (got ${at! - beforeMs}ms)`,
  );
  assert.deepEqual(queuedRolePrompts(repo, "director"), [], "a future prompt is not deliverable yet");

  // The role endpoint shares the field and still reports its wake.
  const roleRes = await postJson(base, "/api/prompt-role", { role: "feature", text: "tighten docs", defer: "1h30m" });
  assert.equal(roleRes.status, 200);
  assert.match(((await roleRes.json()) as { message: string }).message, /wake requested for feature/);
  const feature = queuedRolePromptEntries(repo, "feature");
  assert.equal(feature.length, 1);
  const roleAt = feature[0]?.notBeforeMs;
  assert.ok(roleAt !== null && roleAt !== undefined);
  assert.ok(roleAt! >= beforeMs + 90 * 60_000 - 1_000 && roleAt! <= Date.now() + 90 * 60_000 + 1_000);

  // A bad duration or a non-string names the grammar and queues nothing; over 90d is its own
  // 400. An absent defer queues the same marker-less prompt as before.
  const queuedBefore = queuedRolePromptEntries(repo, "director").length;
  for (const defer of ["soon", "30m1h", 30]) {
    const bad = await postJson(base, "/api/prompt", { text: "bad defer", defer });
    assert.equal(bad.status, 400, JSON.stringify(defer));
    assert.match(((await bad.json()) as { error: string }).error, /duration like 45s, 90m, 1h30m, or 2d/);
  }
  const capped = await postJson(base, "/api/prompt", { text: "far future", defer: "91d" });
  assert.equal(capped.status, 400);
  assert.match(((await capped.json()) as { error: string }).error, /capped at 90d/);
  assert.equal(queuedRolePromptEntries(repo, "director").length, queuedBefore, "bad defers queue nothing");

  const plain = await postJson(base, "/api/prompt", { text: "now please" });
  assert.equal(plain.status, 200);
  assert.equal(queuedRolePromptEntries(repo, "director").at(-1)?.notBeforeMs, null, "an absent defer writes no not-before marker");
  });
});

// The payload's roleInbox: per-role queue counts for every enabled role except the director
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

test("POST /api/wake-cancel drops scheduled wakes like `tumwater wake --cancel`", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui wake cancel test");
  await withGui(repo, async ({ base }) => {
    assert.equal((await postJson(base, "/api/wake", { role: "feature", inSeconds: 3600 })).status, 200);
    assert.equal((await postJson(base, "/api/wake", { inSeconds: 7200 })).status, 200);
    assert.equal(readScheduledWakes(repo).length, 2);

    let res = await postJson(base, "/api/wake-cancel", { role: "nope" });
    assert.equal(res.status, 400);
    assert.equal(readScheduledWakes(repo).length, 2);

    res = await postJson(base, "/api/wake-cancel", { role: "feature" });
    assert.equal(res.status, 200);
    const left = readScheduledWakes(repo);
    assert.equal(left.length, 1);
    assert.ok(!left[0]!.roles.includes("feature"));

    res = await postJson(base, "/api/wake-cancel", {});
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, message: "cancelled 1 scheduled wake" });
    assert.deepEqual(readScheduledWakes(repo), []);
    assert.equal(fs.existsSync(wakeRequestPath(repo)), false, "no immediate marker was written");
  });
});
