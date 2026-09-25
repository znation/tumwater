import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { initProject } from "../src/init.js";
import { landingStatePath, orchestratorStatePath, pausedPath, abortRequestPath, wakeRequestPath, pausedRolesPath } from "../src/paths.js";
import { freshLoopState, loadLoopState, saveLoopState } from "../src/state.js";
import { todayStamp } from "../src/budget.js";
import { DIRECTOR_PROMPT_MAX_CHARS, enqueueRolePrompt, queuedRolePrompts } from "../src/inbox.js";import { enqueueLanding } from "../src/land-queue.js";
import { startLocalGui } from "./util.js";
import { makeRepo } from "./repo-fixtures.js";

// The GUI's operator controls, split out of gui.test.ts: the daily budget cap
// (plans/daily-cost-budget.md) — its /api/status field, preformatted header badge,
// click-to-edit client, and POST /api/budget — and POST /api/pause, the dashboard's
// pause/resume toggle backed by the same shared state writers the CLI uses, so the
// dashboard and `tumwater pause`/`resume` cannot drift.

// The dashboard tests read JSON responses the way gui-client's own postJson guard does;
// this keeps each call site to one line instead of the double-await fetch idiom.

async function postJson<T>(base: string, path: string, body: string): Promise<T> {
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
  const infoFile = orchestratorStatePath(repo);
  fs.mkdirSync(path.dirname(infoFile), { recursive: true });
  fs.writeFileSync(infoFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["clean"] }));
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
  const infoFile = orchestratorStatePath(repo);
  fs.mkdirSync(path.dirname(infoFile), { recursive: true });
  fs.writeFileSync(infoFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["clean"] }));
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

test("the dashboard page renders the preformatted budget badge from the payload", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  // The badge arrives display-ready (status-render's budgetBadge — standing while enabled,
  // n/a for an all-free fleet, empty when disabled), so the page just appends it: one string
  // with a single home, no client-side money formatting left to drift from the TUI header.
  assert.match(GUI_PAGE, /\(d\.budgetBadge \|\| ""\)/);
  assert.doesNotMatch(GUI_PAGE, /fmtUsdCap/, "the old client-side cap mirror is gone");
});

// Merge queue 4/5 — the GUI header renders the preformatted land-queue badge in the same
// order as renderStatus's header (after the running/pid+build part, before the inbox
// badge) — the buildBadge pattern: plain text inside the #header span, NOT the interactive
// #budgetwrap fragment, which owns the click-to-edit budget editor.
test("the dashboard page renders the preformatted land-queue badge from the payload", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  assert.match(GUI_PAGE, /\(d\.landingBadge \|\| ""\)/);
  // The badge joins the #header textContent (before the inbox badge), never the budgetwrap
  // fragment: landingBadge has no affordance to edit, and budgetwrap's innerHTML would
  // clobber it.
  const headerLine = GUI_PAGE.match(/document\.getElementById\("header"\)\.textContent =\n?\s*\(d\.running[\s\S]*?qn : ""\);/);
  assert.ok(headerLine, "the #header textContent assignment exists");
  assert.ok(
    (headerLine[0] ?? "").indexOf("d.landingBadge") < (headerLine[0] ?? "").indexOf("d.inbox"),
    "the landing badge precedes the inbox badge, mirroring renderStatus's header order",
  );
});

// Free-state regression (BUGS.md, 2026-09-14): an all-free fleet's badge must be plain,
// unclickable text — no <a id=budgetbadge>, so the page's delegated click handler cannot
// open a cap editor that could never bind. The budget-edit block runs in the page's script
// scope, where esc() is defined; the test extracts the marker-delimited block and evals it
// against a minimal DOM stub, so the free branch is tested behaviorally, not by source shape.
test("the budget badge is plain text on an all-free fleet and a link otherwise", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  const block = GUI_PAGE.split("// budget-edit:start")[1]!.split("// budget-edit:end")[0]!;
  const wrap = { innerHTML: "" };
  const empty = { innerHTML: "", textContent: "", focus() {}, select() {} };
  const document = {
    getElementById: (id: string) => (id === "budgetwrap" ? wrap : empty),
    addEventListener: () => {},
  };
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const { renderBudgetBadge } = new Function(
    "document",
    "esc",
    block + "\nreturn { renderBudgetBadge };",
  )(document, esc) as { renderBudgetBadge: (d: object) => void };

  renderBudgetBadge({ budget: { spentUsd: 0, capUsd: 50, free: true, fallback: null }, budgetBadge: " · budget: n/a" });
  assert.doesNotMatch(wrap.innerHTML, /<a[^>]*id='budgetbadge'/, "free fleet: no clickable badge");
  assert.doesNotMatch(wrap.innerHTML, /<input/, "free fleet: no editor in sight");
  assert.match(wrap.innerHTML, /· budget: n\/a/, "free fleet: the n/a text still shows");

  renderBudgetBadge({ budget: { spentUsd: 1.5, capUsd: 50, free: false, fallback: null }, budgetBadge: " · budget: $1.50/$50 today" });
  assert.match(wrap.innerHTML, /<a href='#' id='budgetbadge'>/, "priced fleet: the badge stays a link");

  renderBudgetBadge({ budget: { spentUsd: 2, capUsd: 0, free: false, fallback: null }, budgetBadge: " · budget: $2.00 today · no cap" });
  assert.match(wrap.innerHTML, /<a href='#' id='budgetbadge'>/, "disabled fleet: the badge is still the edit affordance");
});

// A browser-rejected <input type=number> (the operator typed "$25" or "5,000") reports value
// "" exactly like a deliberately cleared field — and "" means "no cap" (post 0), so without a
// guard a typo silently DISABLES the spend cap. The budget-edit block runs in the page's script
// scope; evaling it against a minimal DOM stub pins the guard behaviorally.
test("the budget editor refuses browser-rejected number text instead of silently disabling the cap", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  const block = GUI_PAGE.split("// budget-edit:start")[1]!.split("// budget-edit:end")[0]!;
  const input = { value: "", validity: { badInput: true }, focus() {}, select() {} };
  const flash = { textContent: "" };
  const document = {
    getElementById: (id: string) =>
      id === "budgetinput" ? input : id === "flash" ? flash : { innerHTML: "", textContent: "" },
    addEventListener: () => {},
  };
  const posts: unknown[] = [];
  // The block's save path posts through the page's shared postJson (which itself guards via
  // apiFetch); the stub records the payload object directly.
  const postJson = async (_path: string, payload: unknown) => {
    posts.push(payload);
    return { ok: true };
  };
  const { saveBudget } = new Function(
    "document",
    "esc",
    "postJson",
    "setTimeout",
    block + "\nreturn { saveBudget };",
  )(document, (s: string) => s, postJson, () => {}) as { saveBudget: () => Promise<void> };

  await saveBudget();
  assert.equal(posts.length, 0, "rejected text must not POST a cap change");
  assert.match(flash.textContent, /budget must be a number of 0 or more/, "the operator sees why nothing saved");

  // A genuinely cleared field still means "no cap" (0), unchanged by the guard.
  input.validity.badInput = false;
  input.value = "";
  await saveBudget();
  assert.deepEqual(posts, [{ maxDailyCostUsd: 0 }], "clear field still disables the cap");
});

test("a paused fleet's idle role loops read budget paused in the phase payload", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui budget pause test");
  // A live orchestrator (this process) so loopPhase doesn't short-circuit to "stopped"…
  const infoFile = orchestratorStatePath(repo);
  fs.mkdirSync(path.dirname(infoFile), { recursive: true });
  fs.writeFileSync(infoFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["clean"] }));
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
  const { server, base } = await startLocalGui(repo);
  const configFile = path.join(repo, "tumwater.json");
  try {
    // Whole dollars persist and come back in the response.
    let res = await fetch(base + "/api/budget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxDailyCostUsd: 25 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, maxDailyCostUsd: 25 });
    let onDisk = JSON.parse(fs.readFileSync(configFile, "utf8")) as { maxDailyCostUsd: number };
    assert.equal(onDisk.maxDailyCostUsd, 25);

    // Fractional dollars keep their cents (the badge renders them).
    res = await fetch(base + "/api/budget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxDailyCostUsd: 12.34 }),
    });
    assert.equal(res.status, 200);
    onDisk = JSON.parse(fs.readFileSync(configFile, "utf8")) as { maxDailyCostUsd: number };
    assert.equal(onDisk.maxDailyCostUsd, 12.34);

    // Zero disables the cap — a valid value, not an error.
    res = await fetch(base + "/api/budget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxDailyCostUsd: 0 }),
    });
    assert.equal(res.status, 200);
    onDisk = JSON.parse(fs.readFileSync(configFile, "utf8")) as { maxDailyCostUsd: number };
    assert.equal(onDisk.maxDailyCostUsd, 0);

    // The save preserved every other key: diff the file minus that one key against a fresh
    // load of the same config (initProject's defaults plus nothing else changed).
    const raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
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
    assert.match((await postJson<{ error: string }>(base, "/api/budget", '{"maxDailyCostUsd": -1}')).error, /-1/);
    assert.equal(fs.readFileSync(configFile, "utf8"), before, "rejected bodies change nothing");

    // No tmp remnant from any of the writes above.
    const leftovers = fs.readdirSync(repo).filter((f) => f.startsWith("tumwater.json.tmp-"));
    assert.deepEqual(leftovers, [], "no tmp file left behind");
  } finally {
    server.close();
  }
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
  const { server, base } = await startLocalGui(repo);
  try {
    const res = await fetch(base + "/api/budget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxDailyCostUsd: 25 }), // valid value — the failure is server-side
    });
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
  } finally {
    server.close();
  }
});

// POST /api/pause — the dashboard header's pause/resume toggle: the same shared state.ts
// writers the CLI uses, so the GUI and `tumwater pause`/`resume` cannot drift.

test("POST /api/pause writes and removes the fleet pause marker and rejects bad bodies", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui pause route test");
  const { server, base } = await startLocalGui(repo);
  try {
    // Pausing writes the persistent marker and reports the new state; a repeat is idempotent.
    let res = await fetch(base + "/api/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, paused: true });
    assert.ok(fs.existsSync(pausedPath(repo)), "the pause marker exists");
    res = await fetch(base + "/api/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    assert.equal(res.status, 200);
    assert.ok(fs.existsSync(pausedPath(repo)), "a repeat pause leaves the marker in place");

    // Resuming removes it.
    res = await fetch(base + "/api/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });
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
    assert.match((await postJson<{ error: string }>(base, "/api/pause", '{"paused": "true"}')).error, /boolean/);

    // An oversized body gets 413 (readJsonObject's shared guard), still touching nothing.
    res = await fetch(base + "/api/pause", {
      method: "POST",
      body: JSON.stringify({ paused: true, pad: "x".repeat(70000) }),
    });
    assert.equal(res.status, 413);
    assert.equal(fs.existsSync(pausedPath(repo)), false, "an oversized body leaves the marker untouched");
  } finally {
    server.close();
  }
});

// The pause badge runs in the page's script scope; its marker-delimited block is evaled
// against a minimal DOM stub, so the render + click behavior is pinned behaviorally, like the
// budget-editor tests above.
test("the pause badge reflects the payload and its click POSTs the opposite state", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  const block = GUI_PAGE.split("// pause-control:start")[1]!.split("// pause-control:end")[0]!;
  const wrap = { innerHTML: "" };
  const flash = { textContent: "" };
  const document = {
    getElementById: (id: string) => (id === "pausewrap" ? wrap : flash),
    addEventListener: () => {},
  };
  const lastStatus: { paused?: boolean } = { paused: false };
  const posts: unknown[] = [];
  // togglePause posts through the page's shared postJson; the stub records the payload object.
  const postJson = async (_path: string, payload: unknown) => {
    posts.push(payload);
    return { ok: true };
  };
  const { renderPauseBadge, togglePause } = new Function(
    "document",
    "postJson",
    "showFlash",
    "lastStatus",
    block + "\nreturn { renderPauseBadge, togglePause };",
  )(document, postJson, () => {}, lastStatus) as {
    renderPauseBadge: (d: { paused: boolean }) => void;
    togglePause: () => Promise<void>;
  };

  renderPauseBadge({ paused: false });
  assert.match(wrap.innerHTML, /<a href='#' id='pausebadge'> · pause</, "unpaused: the pause affordance");
  await togglePause();
  assert.deepEqual(posts, [{ paused: true }], "clicking pause asks the server to pause");

  lastStatus.paused = true; // the next poll's payload
  renderPauseBadge({ paused: true });
  assert.match(wrap.innerHTML, /paused — resume/, "paused: the resume affordance");
  await togglePause();
  assert.deepEqual(posts, [{ paused: true }, { paused: false }], "clicking resume asks the server to resume");
});

// --- POST /api/wake and POST /api/abort — the dashboard's per-row controls, backed by the
// same marker-writing cores (requestWake/requestAbort in operator-commands.ts) the CLI
// commands call, so the two surfaces cannot drift on the state they write or the text they
// report. The fleet-side marker consumption is pinned in test/orchestrator.e2e.test.ts;
// here we pin the HTTP layer: the markers it writes, its validation, and its status codes.

test("POST /api/wake writes the same state as `tumwater wake` and rejects bad bodies", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui wake test");
  const s = freshLoopState("feature");
  s.backoffSeconds = 15;
  saveLoopState(repo, s);
  const { server, base } = await startLocalGui(repo);
  try {
    // One named role: the row's wake link. The message is the CLI's own confirmation text
    // (no harness here, so the not-live form), and the marker + state-file edits match.
    let res = await fetch(base + "/api/wake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "feature" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      message: "wake requested for feature — takes effect on the next `tumwater run` (no harness is running)",
    });
    const marker = JSON.parse(fs.readFileSync(wakeRequestPath(repo), "utf8")) as { roles: string[] };
    assert.deepEqual(marker.roles, ["feature"]);
    assert.equal(loadLoopState(repo, "feature").backoffSeconds, 0, "the row's backoff cleared");

    // `{}` — the empty/missing-role body targets every configured role, like the CLI's
    // all-roles default.
    fs.rmSync(wakeRequestPath(repo));
    res = await fetch(base + "/api/wake", { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
    const fleetMarker = JSON.parse(fs.readFileSync(wakeRequestPath(repo), "utf8")) as { roles: string[] };
    assert.deepEqual([...fleetMarker.roles].sort(), Object.keys(loadConfig(repo).roles).sort());

    // Unknown / non-string roles get the transcript endpoint's 400 wording, and change nothing.
    for (const body of ['{"role": "bogus"}', '{"role": 7}']) {
      const bad = await fetch(base + "/api/wake", { method: "POST", body });
      assert.equal(bad.status, 400, body);
      assert.match(((await bad.json()) as { error: string }).error, /valid ids: feature, bugfix/);
    }
    fs.rmSync(wakeRequestPath(repo));
    // Malformed / non-object bodies get readJsonObject's shared 400, and an oversized body 413.
    for (const body of ["not json", "null", "[true]", JSON.stringify({ role: "feature", pad: "x".repeat(70000) })]) {
      const bad = await fetch(base + "/api/wake", { method: "POST", body });
      assert.equal(bad.status, body.includes("pad") ? 413 : 400, body.slice(0, 40));
    }
    assert.equal(fs.existsSync(wakeRequestPath(repo)), false, "rejected bodies leave the marker untouched");
  } finally {
    server.close();
  }
});

test("POST /api/abort writes the marker for a live fleet, answers 409 when not, 400 for bad roles", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui abort test");
  const { server, base } = await startLocalGui(repo);
  try {
    // No harness running: the marker is valid but nothing can consume it — a conflict, not a
    // client error, so the CLI's not-live error rides out as 409 and nothing is written.
    let res = await fetch(base + "/api/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "feature" }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "no harness is running — start it with `tumwater run` first" });
    assert.ok(!fs.existsSync(abortRequestPath(repo, "feature")), "not-live writes no marker");

    // Record this test process as the running orchestrator (it is alive): now the request
    // drops the marker and reports the CLI's confirmation text verbatim.
    const infoFile = orchestratorStatePath(repo);
    fs.mkdirSync(path.dirname(infoFile), { recursive: true });
    fs.writeFileSync(infoFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["feature"] }));
    res = await fetch(base + "/api/abort", {
      method: "POST",
      body: JSON.stringify({ role: "feature" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      message: "abort requested for feature — a running fleet applies it within ~2s",
    });
    const marker = JSON.parse(fs.readFileSync(abortRequestPath(repo, "feature"), "utf8")) as { at: number };
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
  } finally {
    server.close();
  }
});

// POST /api/pause-role — the dashboard's per-row pause/resume toggle, backed by the same
// marker functions (`tumwater pause --role` / `resume --role` use) so the two surfaces cannot
// drift. The scheduler-side consumption is pinned in test/orchestrator.e2e.test.ts; here we
// pin the HTTP layer: the marker it writes, its validation, its idempotence, and its codes.
test("POST /api/pause-role writes the per-role marker, is idempotent, and rejects bad bodies", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui pause-role test");
  const { server, base } = await startLocalGui(repo);
  try {
    // Pause one named role: the marker records it, and a repeat is idempotent (changed false).
    const post = (payload: unknown) =>
      fetch(base + "/api/pause-role", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    let res = await post({ role: "feature", paused: true });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, changed: true, paused: true });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(pausedRolesPath(repo), "utf8")).roles,
      ["feature"],
    );
    res = await post({ role: "feature", paused: true });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, changed: false, paused: true }, "re-pausing is idempotent");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(pausedRolesPath(repo), "utf8")).roles,
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
    for (const body of ["not json", "null", "[true]", JSON.stringify({ role: "feature", paused: true, pad: "x".repeat(70000) })]) {
      const bad = await fetch(base + "/api/pause-role", { method: "POST", body });
      assert.equal(bad.status, body.includes("pad") ? 413 : 400, body.slice(0, 40));
    }
    assert.equal(fs.existsSync(pausedRolesPath(repo)), false, "rejected bodies leave the marker untouched");
  } finally {
    server.close();
  }
});

// The loop rows' wake/abort controls run in the page's script scope; their marker-delimited
// block is evaled against a minimal DOM stub, like the budget/pause badge tests above: a click
// on a rowaction anchor POSTs the row's role to the matching endpoint and flashes the server's
// confirmation, and a failed POST flashes the error instead.
test("the loop rows' controls post the row's role and flash the server's message", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  const block = GUI_PAGE.split("// row-actions:start")[1]!.split("// row-actions:end")[0]!;
  const listeners: Array<(ev: unknown) => Promise<void> | void> = [];
  const loopsEl = {
    addEventListener: (_: string, fn: (ev: unknown) => void) => listeners.push(fn),
  };
  // The per-role prompt bar's elements (gui-page's #rolepromptwrap): the prompt rowaction
  // opens the bar instead of posting, and the form's submit/cancel listeners are captured
  // here like the loops listener above.
  const barListeners: Record<string, Array<(ev: unknown) => Promise<void> | void>> = {};
  const promptWrap = { hidden: true };
  const promptLabel = { textContent: "" };
  const promptInput = { value: "", focus: () => {} };
  const barEl = (id: string) => ({
    addEventListener: (_: string, fn: (ev: unknown) => void) => (barListeners[id] ??= []).push(fn),
  });
  const document = {
    getElementById: (id: string) =>
      id === "loops" ? loopsEl
      : id === "rolepromptwrap" ? promptWrap
      : id === "rolepromptlabel" ? promptLabel
      : id === "roleprompt" ? promptInput
      : id === "rolepromptform" ? barEl(id)
      : id === "rolepromptcancel" ? barEl(id)
      : null,
    addEventListener: () => {},
  };
  const flashes: string[] = [];
  const posts: Array<{ path: string; payload: unknown }> = [];
  const postJson = async (path: string, payload: unknown) => {
    posts.push({ path, payload });
    if (path === "/api/abort") throw new Error("/api/abort failed: HTTP 409 — no harness is running");
    if (path === "/api/prompt-role" && (payload as { text?: string }).text === "boom")
      throw new Error("/api/prompt-role failed: HTTP 400");
    if (path === "/api/pause-role") return { ok: true, changed: true, paused: true };
    return { ok: true, message: "wake requested for feature — a running fleet applies it within ~2s" };
  };
  new Function("document", "postJson", "showFlash", "refresh", block)(document, postJson, (msg: string) => flashes.push(msg), () => {});
  assert.equal(listeners.length, 1, "the block registers its delegated listener");
  const handler = listeners[0]!;

  // A wake anchor: the row's role rides the POST, the confirmation flashes.
  const wakeAnchor = { dataset: { action: "wake", role: "feature" } };
  await handler({ target: { closest: (sel: string) => (sel === "a.rowaction" ? wakeAnchor : null) }, preventDefault: () => {} });
  assert.deepEqual(posts, [{ path: "/api/wake", payload: { role: "feature" } }]);
  assert.match(flashes[0]!, /wake requested for feature/);

  // An abort anchor posts to /api/abort; the failure surfaces in the flash.
  const abortAnchor = { dataset: { action: "abort", role: "bugfix" } };
  await handler({ target: { closest: (sel: string) => (sel === "a.rowaction" ? abortAnchor : null) }, preventDefault: () => {} });
  assert.deepEqual(posts[1], { path: "/api/abort", payload: { role: "bugfix" } });
  assert.match(flashes[1]!, /^error: \/api\/abort failed: HTTP 409/);

  // A pause anchor posts to /api/pause-role; the flash is composed from the endpoint's
  // changed/paused flags, which carry no server message.
  const pauseAnchor = { dataset: { action: "pause", role: "docs" } };
  await handler({ target: { closest: (sel: string) => (sel === "a.rowaction" ? pauseAnchor : null) }, preventDefault: () => {} });
  assert.deepEqual(posts[2], { path: "/api/pause-role", payload: { role: "docs" } });
  assert.equal(flashes[2], "docs paused");
  const resumeAnchor = { dataset: { action: "resume", role: "docs" } };
  await handler({ target: { closest: (sel: string) => (sel === "a.rowaction" ? resumeAnchor : null) }, preventDefault: () => {} });
  assert.deepEqual(posts[3], { path: "/api/pause-role", payload: { role: "docs" } });
  assert.equal(flashes[3], "docs resumed");

  // A click on a plain loop link (the closest match fails) is left to the other listener.
  await handler({ target: { closest: () => null }, preventDefault: () => {} });
  assert.equal(posts.length, 4, "a non-rowaction click posts nothing");

  // A prompt anchor opens the shared bar addressed to the row's loop instead of posting;
  // the form's send then POSTs /api/prompt-role with the trimmed text and closes the bar.
  const promptAnchor = { dataset: { action: "prompt", role: "feature" } };
  await handler({ target: { closest: (sel: string) => (sel === "a.rowaction" ? promptAnchor : null) }, preventDefault: () => {} });
  assert.equal(posts.length, 4, "opening the bar posts nothing");
  assert.equal(promptWrap.hidden, false, "the bar is visible while addressed");
  assert.equal(promptLabel.textContent, "prompt for feature:");
  promptInput.value = "  tighten the docs loop  ";
  await barListeners["rolepromptform"]![0]!({ preventDefault: () => {} });
  assert.deepEqual(posts[4], { path: "/api/prompt-role", payload: { role: "feature", text: "tighten the docs loop" } });
  assert.match(flashes[4]!, /wake requested for feature/);
  assert.equal(promptWrap.hidden, true, "a successful send closes the bar");
  assert.equal(promptInput.value, "", "a successful send clears the input");

  // An empty send queues nothing; a failed POST flashes the error and keeps both the bar and
  // the text for resubmission; cancel closes the bar without posting.
  promptInput.value = "   ";
  await barListeners["rolepromptform"]![0]!({ preventDefault: () => {} });
  assert.equal(posts.length, 5, "an empty send posts nothing");
  promptInput.value = "boom";
  await handler({ target: { closest: (sel: string) => (sel === "a.rowaction" ? promptAnchor : null) }, preventDefault: () => {} });
  await barListeners["rolepromptform"]![0]!({ preventDefault: () => {} });
  assert.match(flashes[5]!, /^error: \/api\/prompt-role failed/);
  assert.equal(promptWrap.hidden, false, "a failed send keeps the bar open");
  assert.equal(promptInput.value, "boom", "a failed send keeps the text");
  await barListeners["rolepromptcancel"]![0]!({ preventDefault: () => {} });
  assert.equal(promptWrap.hidden, true, "cancel closes the bar");
  assert.equal(posts.length, 6, "cancel posts nothing");
});

// POST /api/prompt-role — the dashboard's per-row prompt control, backed by the same submit
// path `tumwater prompt --role <id>` uses (submitRolePrompt + a single-role wake), so the
// surfaces cannot drift on queue format or wording. Here: the queue landing, the role
// validation shared with /api/transcript, and the body discipline shared with /api/prompt.
test("POST /api/prompt-role queues for the named loop and rejects bad bodies like its peers", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui prompt-role test");
  const { server, base } = await startLocalGui(repo);
  try {
    const post = (payload: unknown) =>
      fetch(base + "/api/prompt-role", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    const res = await post({ role: "feature", text: "  tighten the docs  " });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; message: string };
    assert.equal(body.ok, true);
    assert.match(body.message, /wake requested for feature/);
    // The queue holds the trimmed text — the same files `tumwater prompt --list --role` reads.
    assert.deepEqual(queuedRolePrompts(repo, "feature"), ["tighten the docs"]);
    // The wake marker names just that loop.
    assert.deepEqual(JSON.parse(fs.readFileSync(wakeRequestPath(repo), "utf8")).roles, ["feature"]);

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
    for (const body of ["not json", "null", "[true]", JSON.stringify({ role: "feature", text: "x", pad: "y".repeat(70000) })]) {
      const bad = await fetch(base + "/api/prompt-role", { method: "POST", body });
      assert.equal(bad.status, body.includes("pad") ? 413 : 400, body.slice(0, 40));
    }
  } finally {
    server.close();
  }
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
