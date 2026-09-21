import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type os from "node:os";
import net from "node:net";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";
import { collectReport, type ReportData, type ReportDay } from "../src/ui/report.js";
import { lanAddresses, startGui } from "../src/ui/gui.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { initProject } from "../src/init.js";
import { collectFailureReport, renderFailureMarkdown } from "../src/failure-report.js";
import { dequeuePrompt, inboxSize, submitPrompt } from "../src/inbox.js";
import { eventsLogPath, landingStatePath, orchestratorStatePath, pausedPath, piLogPath } from "../src/paths.js";
import { freshLoopState, saveLoopState } from "../src/state.js";
import { todayStamp } from "../src/budget.js";
import { enqueueLanding } from "../src/land-queue.js";
import { assistantLine, makeRepo } from "./util.js";
import { compactTokens } from "../src/text.js";

const SESSION = JSON.stringify({ type: "session", version: 3, id: "x" });

// The --all-interfaces URL filter decides which addresses the dashboard advertises as
// reachable for an UNAUTHENTICATED server, so its inclusions/exclusions are pinned here
// against a synthetic interface table: the e2e test can only observe what this machine has,
// and on boxes without an external IPv4 (CI, containers) it passes vacuously.
// Full interface infos with the boilerplate fields (netmask/mac/cidr) filled in, so the
// tables below read as address/family/internal — the only fields the filter looks at.
const v4 = (address: string, internal: boolean): os.NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  mac: "aa:bb:cc:dd:ee:ff",
  cidr: null,
  family: "IPv4",
  internal,
});
const v6 = (address: string, internal: boolean): os.NetworkInterfaceInfo => ({
  address,
  netmask: "ffff:ffff:ffff:ffff::",
  mac: "aa:bb:cc:dd:ee:ff",
  cidr: null,
  scopeid: 7,
  family: "IPv6",
  internal,
});

test("lanAddresses keeps external IPv4 only — skips loopback, IPv6, and empty interfaces", () => {
  const table = {
    lo0: [v4("127.0.0.1", true)],
    en0: [
      v6("fe80::a%en0", false), // link-local IPv6
      v4("192.168.1.50", false),
    ],
    utun3: undefined, // an interface with no addresses — the live table's real shape
  };
  assert.deepEqual(lanAddresses(table), ["192.168.1.50"]);

  // Every external IPv4 counts (multiple interfaces), in table order; an IPv4-mapped
  // address is still family "IPv6", so it stays excluded.
  const multi = {
    eth0: [v4("10.0.0.2", false)],
    en0: [
      v6("::ffff:192.168.1.50", false),
      v4("192.168.1.50", false),
    ],
  };
  assert.deepEqual(lanAddresses(multi), ["10.0.0.2", "192.168.1.50"]);

  assert.deepEqual(lanAddresses({}), []);

  // The default (live) table: whatever it returns, every entry is a non-loopback IPv4 —
  // the property that makes printing them safe.
  for (const addr of lanAddresses()) {
    assert.match(addr, /^\d{1,3}(\.\d{1,3}){3}$/, `IPv4 dotted quad: ${addr}`);
    assert.notEqual(addr, "127.0.0.1", "loopback is never advertised");
  }
});

test("gui binds localhost by default and all interfaces on request", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui bind test");

  const local = await startGui(repo, 0);
  const localAddr = local.address();
  assert.ok(localAddr && typeof localAddr === "object");
  assert.equal(localAddr.address, "127.0.0.1", "default stays loopback-only");
  await new Promise((r) => local.close(r));

  const open = await startGui(repo, 0, true);
  const openAddr = open.address();
  assert.ok(openAddr && typeof openAddr === "object");
  // The unspecified address ("::" dual-stack, or "0.0.0.0" on IPv4-only hosts) means
  // every interface — the whole point of --all-interfaces.
  assert.ok(["::", "0.0.0.0"].includes(openAddr.address), `bound ${openAddr.address}`);
  try {
    const page = await (await fetch(`http://127.0.0.1:${openAddr.port}/`)).text();
    assert.match(page, /<title>tumwater<\/title>/, "still serves over loopback too");
  } finally {
    await new Promise((r) => open.close(r));
  }
});

test("gui serves the dashboard, status JSON, and accepts prompts", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui test project");
  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const page = await (await fetch(base + "/")).text();
    assert.match(page, /<title>tumwater<\/title>/);

    const status = (await (await fetch(base + "/api/status")).json()) as ReturnType<typeof statusPayload> & {
      running: boolean;
      loops: Array<{ role: string; phase: string }>;
    };
    assert.equal(status.running, false);
    assert.ok(status.loops.some((l) => l.role === "director"));

    // The served document is exactly the CLI's (`statusPayload`) plus one field only the server
    // can know — the serving process's own `serverBuildSha`, the page's cue to notice a newer
    // build and reload. Pin the relation so the two surfaces cannot silently drift, and the
    // README/help's "the GUI's payload minus serverBuildSha" promise stays true. Both sides go
    // through a JSON round-trip (the served side already has): that is exactly what the endpoint
    // and `status --json` emit, and `pid: undefined` must vanish from both.
    const { serverBuildSha, ...servedRest } = status as Record<string, unknown>;
    assert.ok("serverBuildSha" in status, "the served payload names the serving build");
    assert.ok(
      serverBuildSha === null || typeof serverBuildSha === "string",
      "serverBuildSha is the build sha or null",
    );
    assert.deepEqual(
      servedRest,
      JSON.parse(JSON.stringify(statusPayload(repo))),
      "served payload is the CLI's plus serverBuildSha",
    );

    const post = await fetch(base + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello from the browser" }),
    });
    assert.equal(post.status, 200);
    assert.equal(inboxSize(repo), 1);

    const bad = await fetch(base + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "  " }),
    });
    assert.equal(bad.status, 400);

    // Malformed or non-object bodies are client errors too: 400 with an actionable message,
    // not a 500 carrying Node's raw SyntaxError/TypeError.
    const malformed = await fetch(base + "/api/prompt", { method: "POST", body: "not json" });
    assert.equal(malformed.status, 400);
    assert.match(((await malformed.json()) as { error: string }).error, /JSON/);
    for (const body of ["null", "[1]", '"just a string"']) {
      const res = await fetch(base + "/api/prompt", { method: "POST", body });
      assert.equal(res.status, 400, body);
      // Valid JSON that is not an object names the fix (send the object shape) — not
      // "text required", which would point at a field of a body that has none.
      assert.match(((await res.json()) as { error: string }).error, /JSON object/);
    }
    // A present-but-wrong-typed text names the offending value.
    const nonStringText = await fetch(base + "/api/prompt", { method: "POST", body: '{"text": 42}' });
    assert.equal(nonStringText.status, 400);
    assert.match(((await nonStringText.json()) as { error: string }).error, /must be a string \(got 42\)/);
    assert.equal(inboxSize(repo), 1, "rejected bodies queue nothing");

    assert.equal((await fetch(base + "/nope")).status, 404);
  } finally {
    server.close();
  }
});

test("gui /api/transcript serves rendered lines and validates role/n", async () => {
  const repo = makeRepo();
  await initProject(repo, "transcript gui test");
  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    // No log yet: friendly empty state.
    const empty = (await (await fetch(base + "/api/transcript?role=feature")).json()) as { lines: string[] };
    assert.deepEqual(empty, { lines: [] });

    // With a log: same rendered lines as the CLI transcript.
    const file = piLogPath(repo, "feature");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "agent_start" }),
        JSON.stringify({
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: "tick prompt" }], timestamp: 1787222691956 },
        }),
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "did the thing" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "/a/PLANS.md" } }],
          },
        }),
      ].join("\n") + "\n",
    );
    const ok = (await (await fetch(base + "/api/transcript?role=feature&n=10")).json()) as { lines: string[] };
    assert.ok(ok.lines.some((l) => l.startsWith("── run @ ")));
    assert.ok(ok.lines.includes("  did the thing"));
    assert.ok(ok.lines.includes("→ read PLANS.md"));

    // Validation: unknown role, missing role, and bad n all → 400. Each 400 names the
    // offending value (or says it is required) so a client can tell which input was bad.
    for (const url of ["/api/transcript?role=nosuch", "/api/transcript", "/api/transcript?role=feature&n=abc", "/api/transcript?role=feature&n=0"]) {
      const res = await fetch(base + url);
      assert.equal(res.status, 400, url);
    }
    const unknownRole = (await (await fetch(base + "/api/transcript?role=nosuch")).json()) as { error: string };
    assert.match(unknownRole.error, /unknown role "nosuch"/);
    const missingRole = (await (await fetch(base + "/api/transcript")).json()) as { error: string };
    assert.match(missingRole.error, /role required/);

    // Routing is by exact path: a path merely prefixing /api/transcript is not that route —
    // the old startsWith on the raw URL answered these with 200 transcript data.
    for (const url of ["/api/transcripts?role=feature", "/api/transcriptx"]) {
      const res = await fetch(base + url);
      assert.equal(res.status, 404, url);
    }
  } finally {
    server.close();
  }
});

// User-defined loops (tumwater.json's customLoops) are first-class transcript targets: the
// GUI marks them with an asterisk, so clicking one must open its panel — /api/transcript
// validates against catalog + customLoops when the config parses.
test("gui /api/transcript accepts user-defined loop roles listed in tumwater.json", async () => {
  const repo = makeRepo();
  await initProject(repo, "custom transcript test");
  const cfg = loadConfig(repo);
  cfg.customLoops.push({ name: "nightly", task: "do the nightly thing" });
  saveConfig(repo, cfg);
  // A log for the custom loop — same shape as a built-in's.
  fs.mkdirSync(path.dirname(piLogPath(repo, "nightly")), { recursive: true });
  fs.writeFileSync(
    piLogPath(repo, "nightly"),
    [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "did the nightly thing" }],
        },
      }),
    ].join("\n") + "\n",
  );
  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    // The custom id is accepted and serves its transcript like any built-in's…
    const ok = (await (await fetch(base + "/api/transcript?role=nightly")).json()) as { lines: string[] };
    assert.ok(ok.lines.some((l) => l.includes("did the nightly thing")));

    // …and an unknown id still 400s — listing customs among the valid ids it accepts.
    const bad = await fetch(base + "/api/transcript?role=nosuch");
    assert.equal(bad.status, 400);
    const body = (await bad.json()) as { error: string };
    assert.match(body.error, /nightly/, "the 400 message lists the custom ids it accepts");
  } finally {
    server.close();
  }
});

test("status payload marks user-defined loops with the custom flag", async () => {
  const repo = makeRepo();
  await initProject(repo, "payload custom test");
  const cfg = loadConfig(repo);
  cfg.customLoops.push({ name: "nightly", task: "do the nightly thing" });
  saveConfig(repo, cfg);
  // The payload's structural fixture type tolerates the extra field — assert on it directly.
  const payload = statusPayload(repo) as { loops: Array<{ role: string; custom?: boolean }> };
  assert.ok(payload.loops.some((l) => l.role === "nightly" && l.custom === true), "listed custom is marked");
  assert.equal(
    payload.loops.filter((l) => l.custom).length,
    1,
    "only the custom carries the flag",
  );
});

test("the dashboard page's inline script is syntactically valid JavaScript", async () => {
  // Regression: the page is authored inside a TS template literal, where a bare \n becomes a
  // REAL newline in the served page — splitting the page's own string literals and killing the
  // whole script with a syntax error ("Unexpected EOF"). Parse every <script> body for real.
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  const scripts = [...GUI_PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
  assert.ok(scripts.length >= 1, "page has an inline script");
  for (const body of scripts) {
    assert.doesNotThrow(() => new Function(body), "inline script must parse");
  }
});

test("the prompt form checks its response before clearing the box and claiming queued", async () => {
  // Regression: the submit handler ignored the response entirely — a network failure or a
  // 4xx/5xx still cleared the input and flashed "queued", silently losing the operator's
  // prompt. It must guard r.ok like saveBudget and the poll fetches, and keep the text on
  // failure. Asserted against the served page, where the handler actually lives.
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  assert.match(GUI_PAGE, /await apiFetch\("\/api\/prompt", \{ method: "POST"/);
  const handler = GUI_PAGE.match(/promptform"\)\.addEventListener\("submit"[\s\S]*?\n {2}\}\);/)?.[0] ?? "";
  assert.ok(handler, "prompt submit handler found");
  assert.ok(handler.includes("showFlash(\"error: \" + e.message)"), "failure flashes the error");
  assert.ok(handler.includes('showFlash("queued")'), "success path flashes queued");
  assert.ok(!handler.includes('flash.textContent = "queued"'), "no unconditional queued flash");
});

test("status payload combines persisted + live token metrics for running loops only", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui metrics test");
  // Persisted totals from completed ticks...
  const s = freshLoopState("feature");
  s.generatedTokens = 1_000;
  s.peakContextTokens = 6_000;
  s.running = true; // a tick is in flight
  saveLoopState(repo, s);
  // ...and the in-flight tick's log tail (800 output so far, peak context 12k).
  const file = piLogPath(repo, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [SESSION, assistantLine("turn one", { tokens: 8_000, output: 300 }), assistantLine("turn two", { tokens: 12_000, output: 500 })].join("\n") + "\n",
  );
  const payload = statusPayload(repo) as {
    loops: Array<{ role: string; generated: number; peakCtx: number }>;
  };
  const feature = payload.loops.find((l) => l.role === "feature");
  assert.ok(feature, "feature loop present in payload");
  assert.equal(feature.generated, 1_800, "running loop gen = persisted + live output (1000+300+500)");
  assert.equal(feature.peakCtx, 12_000, "running loop peak ctx = max(persisted, live)");
});

test("status payload carries the current work item for running loops only", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui work item test");
  // A running loop whose in-flight tick has spoken its work item...
  const s = freshLoopState("feature");
  s.running = true;
  saveLoopState(repo, s);
  const file = piLogPath(repo, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [SESSION, assistantLine('implement plan "Linear history on main"')].join("\n") + "\n",
  );
  // ...and an idle loop whose log tail is a finished tick (must not leak its item).
  saveLoopState(repo, freshLoopState("clean"));
  const file2 = piLogPath(repo, "clean");
  fs.mkdirSync(path.dirname(file2), { recursive: true });
  fs.writeFileSync(file2, [SESSION, assistantLine("old finished work")].join("\n") + "\n");

  const payload = statusPayload(repo) as {
    loops: Array<{ role: string; currentWork: string | null }>;
  };
  assert.equal(
    payload.loops.find((l) => l.role === "feature")?.currentWork,
    'implement plan "Linear history on main"',
    "running loop shows its in-flight work item",
  );
  assert.equal(payload.loops.find((l) => l.role === "clean")?.currentWork, null, "idle loop never shows a stale item");
});

test("the dashboard page has a current column after state", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  assert.match(GUI_PAGE, /<th>state<\/th><th>current<\/th>/);
});

test("the dashboard page has a last tick column between cost and last result", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  // The per-loop today-spend column (PLANS.md "Per-loop today spend") landed between cost and
  // last tick, so the header order now pins all four cells at once.
  assert.match(GUI_PAGE, /<th>cost<\/th><th>today<\/th><th>last tick<\/th><th>last result<\/th>/);
  // The cell renders client-side from the payload's existing lastTickEndedAt field.
  assert.match(GUI_PAGE, /fmtLastTick\(l\.lastTickEndedAt\)/);
});

test("the GUI last tick cell shows absolute time plus relative age, mirroring the TUI", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  const { lastTickCell } = await import("../src/ui/status-render.js");

  // Extract the marked region — same regex-extract + new Function pattern as the esc test and
  // sortLoops. fmtLastTick is pure (no DOM), so nothing is injected.
  const m = GUI_PAGE.match(/\/\/ last-tick-fmt:start\n([\s\S]*?)\n  \/\/ last-tick-fmt:end/);
  assert.ok(m, "last-tick-fmt region found in the page");
  const fmtLastTick = new Function(`${m[1]}\nreturn fmtLastTick;`)() as (ts: number | null) => string;

  // The cell renders client-side from the payload's existing lastTickEndedAt field.
  assert.match(GUI_PAGE, /fmtLastTick\(l\.lastTickEndedAt\)/);

  const now = Date.now();
  const p2 = (n: number) => String(n).padStart(2, "0");
  // The absolute part derives from the fixed ts, so it is stable across the test's own clock
  // drift; only the relative age reads Date.now() at call time.
  const abs = (ts: number) => {
    const d = new Date(ts);
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };

  // Never ticked.
  assert.equal(fmtLastTick(null), "-");
  assert.equal(fmtLastTick(0), "-");

  // Timestamps sit well inside each bucket so Date.now() drift between the call and the
  // assertion cannot flip a result: 45 s (not near 60); 190 s → 3m (far from the 2.5/3.5 m
  // rounding edges); 7500 s → 2h; ~3 d + 2 h → 74h with the MM-DD prefix.
  const t45 = now - 45_000;
  assert.equal(fmtLastTick(t45), `${abs(t45)} · 45s ago`);

  const t190 = now - 190_000;
  assert.equal(fmtLastTick(t190), `${abs(t190)} · 3m ago`);

  const t2h = now - 7_500_000;
  assert.equal(fmtLastTick(t2h), `${abs(t2h)} · 2h ago`);

  const t3d = now - (3 * 86_400_000 + 7_200_000);
  const d3 = new Date(t3d);
  assert.equal(fmtLastTick(t3d), `${p2(d3.getMonth() + 1)}-${p2(d3.getDate())} ${abs(t3d)} · 74h ago`);

  // The whole cell — absolute stamp and age bucketing — must stay byte-identical to the TUI's
  // lastTickCell, so a drift in either surface fails here.
  for (const ts of [t45, t190, t2h, t3d]) assert.equal(fmtLastTick(ts), lastTickCell(ts));
});

test("the GUI loop table sorts active first, then by last tick most-recent-first", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");

  // Extract the marked region — same regex-extract + new Function pattern as the esc test and
  // the report-chart builders. sortLoops is pure (no DOM, no esc), so nothing is injected.
  const m = GUI_PAGE.match(/\/\/ loop-sort:start\n([\s\S]*?)\n  \/\/ loop-sort:end/);
  assert.ok(m, "loop-sort region found in the page");
  type LoopRow = { role: string; phase: string; lastTickEndedAt: number | null };
  const sortLoops = new Function(`${m[1]}\nreturn sortLoops;`)() as unknown as (loops: LoopRow[]) => LoopRow[];

  // refresh() renders the sorted copy, not payload order — pin the call site so the function
  // cannot become dead code.
  assert.match(GUI_PAGE, /sortLoops\(d\.loops\)\.map\(\(l\) =>/);

  const t = (min: number) => Date.parse("2026-09-11T00:00:00Z") + min * 60000;
  const loops: LoopRow[] = [
    { role: "sleepy", phase: "sleeping (for 5m)", lastTickEndedAt: t(3) },
    { role: "working-b", phase: "working 2m", lastTickEndedAt: t(1) },
    { role: "reviewing-a", phase: "reviewing @ …", lastTickEndedAt: null },
    { role: "queued-z", phase: "queued", lastTickEndedAt: t(5) },
    { role: "working-a", phase: "working 1m", lastTickEndedAt: t(2) },
    { role: "landing-x", phase: "landing 2m", lastTickEndedAt: t(0) },
    { role: "never-ticked", phase: "stopped", lastTickEndedAt: null },
    { role: "main-red", phase: "main red", lastTickEndedAt: t(0) },
  ];
  // In-flight phases (working/reviewing/landing) before inactive; within each group, last tick
  // most-recent-first; a null (never completed a tick) sorts after any timestamp in its own
  // category. landing-x's tick is older than queued-z's and sleepy's, yet it still groups with
  // the actives — the regression this fixture pins.
  assert.deepEqual(sortLoops(loops).map((l) => l.role), [
    "working-a",     // active, t(2) — newest among actives
    "working-b",     // active, t(1)
    "landing-x",     // active (landing), t(0) — groups with in-flight work despite the old tick
    "reviewing-a",   // active, null — last of the active group
    "queued-z",      // inactive, t(5) — newest among inactives, below every active
    "sleepy",        // inactive, t(3)
    "main-red",      // inactive, t(0) — tie with landing-x, role name breaks it
    "never-ticked",  // inactive, null — last of all
  ]);

  // Equal timestamps break on role name ascending, so an identical payload always renders in
  // the same order regardless of payload order.
  const tied: LoopRow[] = [
    { role: "zeta", phase: "sleeping (for 1m)", lastTickEndedAt: t(4) },
    { role: "alpha", phase: "queued", lastTickEndedAt: t(4) },
    { role: "mid", phase: "main red", lastTickEndedAt: t(4) },
  ];
  assert.deepEqual(sortLoops(tied).map((l) => l.role), ["alpha", "mid", "zeta"]);

  // Lockstep with the TUI/status comparator (status-model.ts `sortLoopsByState`): the page
  // cannot import TS, so the shared ordering rule is pinned by cross-checking the two copies
  // over the same fixtures — every branch (active/inactive, timestamp, null, role tie) must
  // agree, or a drift in either surface fails here.
  const { sortLoopsByState } = await import("../src/ui/status-model.js");
  const order = (rows: LoopRow[]) => sortLoopsByState(rows).map((l) => l.role);
  assert.deepEqual(order(loops), sortLoops(loops).map((l) => l.role));
  assert.deepEqual(order(tied), sortLoops(tied).map((l) => l.role));

  // The input array is not reordered in place — the payload stays untouched for other consumers.
  const before = loops.map((l) => l.role);
  sortLoops(loops);
  assert.deepEqual(loops.map((l) => l.role), before, "sortLoops returns a new array");
});

// The per-loop today spend on the GUI surface (PLANS.md "Per-loop today spend"): /api/status
// carries todayUsd per loop — the daily budget window, 0 while its stamp is stale or missing,
// same helper and semantics as the TUI's `today` column — and the page renders its cell
// client-side from that field.

test("status payload carries todayUsd per loop from its daily window", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui today spend test");
  // A state file with today's stamp rides the payload...
  const fresh = freshLoopState("clean");
  fresh.dayStamp = todayStamp();
  fresh.dayCostUsd = 12.34;
  saveLoopState(repo, fresh);
  // ...a stale-stamp file with positive spend reads zero (dailyCost's rule)...
  const stale = freshLoopState("dry");
  stale.dayStamp = todayStamp(Date.now() - 86_400_000);
  stale.dayCostUsd = 5.67;
  saveLoopState(repo, stale);

  let payload = statusPayload(repo) as { loops: Array<{ role: string; todayUsd: number }> };
  assert.equal(payload.loops.find((l) => l.role === "clean")?.todayUsd, 12.34, "fresh window rides the payload");
  assert.equal(payload.loops.find((l) => l.role === "dry")?.todayUsd, 0, "stale stamp reads zero");

  // A loop that never ticked (default state file) also carries an explicit zero field.
  saveLoopState(repo, freshLoopState("organize"));
  payload = statusPayload(repo) as typeof payload;
  assert.equal(payload.loops.find((l) => l.role === "organize")?.todayUsd, 0, "missing window reads zero");
});

test("the dashboard page renders the today cell from the payload's todayUsd", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  // The header cell sits between cost and last tick (pinned by the regex above)...
  assert.match(GUI_PAGE, /<th>cost<\/th><th>today<\/th><th>last tick<\/th>/);
  // ...and the cell renders client-side from todayUsd, beside its existing cost formatting.
  assert.match(GUI_PAGE, /l\.costUsd\.toFixed\(2\)/);
  assert.match(GUI_PAGE, /l\.todayUsd\.toFixed\(2\)/);
});

// Project status: planned features and open bugs from PLANS.md/BUGS.md.

test("status payload carries planned plans and open bugs, fresh per poll", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui backlog test"); // seeds placeholder files with no entries
  let payload = statusPayload(repo) as { plans: string[]; bugs: string[] };
  assert.deepEqual(payload.plans, [], "seeded _None yet._ placeholders are not entries");
  assert.deepEqual(payload.bugs, []);

  // A later edit to the tracked markdown is visible on the next payload (no caching).
  // Entries must land inside their sections — appending would file them under Done/Fixed.
  fs.writeFileSync(
    path.join(repo, "PLANS.md"),
    "# Plans\n\n## Planned\n\n### Show open bugs and planned features in the TUI/GUI (planned 2026-08-24)\n\n**Goal:** The dashboard surfaces project status.\n\n## Done\n\n_None yet._\n",
  );
  fs.writeFileSync(
    path.join(repo, "BUGS.md"),
    "# Bugs\n\n## Open\n\n### A routine merge conflict logs a warning (reported 2026-08-25)\n\n**Symptom:** The main log is full of warnings.\n\n## Fixed\n\n_None yet._\n",
  );
  payload = statusPayload(repo) as { plans: string[]; bugs: string[] };
  assert.deepEqual(payload.plans, ["Show open bugs and planned features in the TUI/GUI (planned 2026-08-24)"]);
  assert.deepEqual(payload.bugs, ["A routine merge conflict logs a warning (reported 2026-08-25)"]);
});

test("the dashboard page has a project status panel", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  assert.match(GUI_PAGE, /<div id="backlog"><\/div>/);
  // The panel renders from the payload's plans/bugs fields.
  assert.match(GUI_PAGE, /d\.plans \|\| \[\]/);
  assert.match(GUI_PAGE, /d\.bugs \|\| \[\]/);
});

// Open questions (QUESTIONS.md) drive the dashboard's `questions: N` header badge and its
// open-questions panel section — both derived client-side from the payload's list.

test("status payload carries open questions, fresh per poll", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui questions test"); // seeds a placeholder QUESTIONS.md with no entries
  let payload = statusPayload(repo) as { questions: string[] };
  assert.deepEqual(payload.questions, [], "seeded _None yet._ placeholders are not entries");

  // A question posted under ## Open shows on the next poll; an entry in ## Answered must
  // never leak into the open list — the header badge count is this list's length.
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    [
      "# Questions",
      "",
      "## Open",
      "",
      "### Q1: which database?",
      "",
      "**Context:** the storage layer is undecided.",
      "",
      "## Answered",
      "",
      "### Q0: earlier question (answered 2026-08-27)",
    ].join("\n") + "\n",
  );
  payload = statusPayload(repo) as { questions: string[] };
  assert.deepEqual(payload.questions, ["Q1: which database?"], "only the Open section counts");

  // Answering it (moving the entry to ## Answered) drops it on the next poll — a stale
  // cache would keep the badge showing `questions: 1` long after the decision was made.
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    [
      "# Questions",
      "",
      "## Open",
      "",
      "_None yet._",
      "",
      "## Answered",
      "",
      "### Q1: which database? (answered 2026-08-29)",
      "",
      "**Decision:** SQLite.",
    ].join("\n") + "\n",
  );
  payload = statusPayload(repo) as { questions: string[] };
  assert.deepEqual(payload.questions, [], "an answered question is no longer open");
});

test("the dashboard page renders the open-questions section and header badge from the payload", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  // The #backlog panel gets an open questions section alongside plans/bugs… (its third
  // argument names the /api/backlog file so each entry line links into the detail panel)
  assert.match(GUI_PAGE, /backlogList\("open questions", d\.questions \|\| \[\], "questions"\)/);
  // …and the header badge derives its count from that same list, shown only when N > 0.
  assert.match(GUI_PAGE, /const qn = \(d\.questions \|\| \[\]\)\.length/);
  assert.match(GUI_PAGE, /\(qn \? " · questions: " \+ qn : ""\)/);
});

// Queued director prompts ride /api/status as truncated previews in execution order; the
// project status panel lists them like its other sections — (none) while the inbox is empty.

test("status payload carries queued prompt previews, fresh per poll", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui inbox test"); // no inbox dir yet
  let payload = statusPayload(repo) as { inbox: number; inboxPrompts: string[] };
  assert.equal(payload.inbox, 0);
  assert.deepEqual(payload.inboxPrompts, []);

  submitPrompt(repo, "fix the login bug");
  submitPrompt(repo, "y".repeat(120)); // overlong → truncated preview in the payload
  payload = statusPayload(repo) as { inbox: number; inboxPrompts: string[] };
  assert.equal(payload.inbox, 2);
  assert.deepEqual(payload.inboxPrompts[0], "fix the login bug");
  const preview = payload.inboxPrompts[1]!;
  assert.ok(preview.length <= 80 && preview.endsWith("…"), `preview truncated: ${JSON.stringify(preview)}`);

  // Fresh per poll: the director consuming one drops it from the next payload.
  dequeuePrompt(repo);
  payload = statusPayload(repo) as { inbox: number; inboxPrompts: string[] };
  assert.equal(payload.inbox, 1);
  assert.deepEqual(payload.inboxPrompts, [preview]);
});

test("the dashboard page lists queued prompts in its project status panel", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  // The #backlog panel gets a queued-prompts section alongside plans/bugs/questions.
  assert.match(GUI_PAGE, /backlogList\("queued prompts", d\.inboxPrompts \|\| \[\]\)/);
});

// Full backlog entries (PLANS.md "Read backlog entries in full from the TUI/GUI dashboards"):
// /api/backlog serves one entry's title + body on demand, so multi-KB bodies never ride the
// 1-second /api/status poll — and statusPayload keeps carrying titles only.

test("gui /api/backlog serves an entry's title and body and validates file/index", async () => {
  const repo = makeRepo();
  await initProject(repo, "backlog gui test");
  fs.writeFileSync(
    path.join(repo, "PLANS.md"),
    [
      "# Plans",
      "",
      "## Planned",
      "",
      "### First plan (planned 2026-09-05)",
      "",
      "**Goal.** The first goal.",
      "",
      "A second body line, kept verbatim.",
      "",
      "### Second plan (planned 2026-09-04)", // bare heading: empty body
      "",
      "## Done",
      "",
      "_None yet._",
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(repo, "BUGS.md"),
    ["# Bugs", "", "## Open", "", "### One bug (reported 2026-09-05)", "", "**Symptom.** It breaks.", "", "## Fixed", "", "_None yet._"].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    ["# Questions", "", "## Open", "", "### Q1: which database?", "", "**Context:** the storage layer is undecided.", "", "## Answered", "", "_None yet._"].join("\n") + "\n",
  );

  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    // index 0 of plans: the first entry's title and full body — interior blank lines kept,
    // leading/trailing blanks trimmed, Done entries never leaking in.
    let res = await fetch(base + "/api/backlog?file=plans&index=0");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      title: "First plan (planned 2026-09-05)",
      body: "**Goal.** The first goal.\n\nA second body line, kept verbatim.",
    });

    // index 1: a bare heading has an empty body — and it is the LAST planned entry (the Done
    // placeholder never counts), so index 2 is already out of range.
    res = await fetch(base + "/api/backlog?file=plans&index=1");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { title: "Second plan (planned 2026-09-04)", body: "" });

    // The other files address their own open sections in the same payload order.
    res = await fetch(base + "/api/backlog?file=bugs&index=0");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { title: "One bug (reported 2026-09-05)", body: "**Symptom.** It breaks." });
    res = await fetch(base + "/api/backlog?file=questions&index=0");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { title: "Q1: which database?", body: "**Context:** the storage layer is undecided." });

    // Validation: unknown/missing file, missing or bad index, and out-of-range → 400 with a
    // JSON error body (the page's fetch treats any non-2xx as a failed poll).
    for (const url of [
      "/api/backlog?file=notes&index=0",
      "/api/backlog?index=0",
      "/api/backlog?file=plans",
      "/api/backlog?file=plans&index=-1",
      "/api/backlog?file=plans&index=abc",
      "/api/backlog?file=plans&index=2", // only two planned entries
    ]) {
      const r = await fetch(base + url);
      assert.equal(r.status, 400, url);
      assert.match(((await r.json()) as { error: string }).error, /\S/, `${url} carries an error message`);
    }
    // The 400s name the offending value (or say the input is required), so a client can tell
    // a missing file from an unknown one and see which index was out of range.
    const unknownFile = (await (await fetch(base + "/api/backlog?file=notes&index=0")).json()) as { error: string };
    assert.match(unknownFile.error, /unknown file "notes"/);
    const missingFile = (await (await fetch(base + "/api/backlog?index=0")).json()) as { error: string };
    assert.match(missingFile.error, /file required/);
    const outOfRange = (await (await fetch(base + "/api/backlog?file=plans&index=2")).json()) as { error: string };
    assert.match(outOfRange.error, /index 2 out of range/);

    // Routing is by exact path: a path merely prefixing /api/backlog is not that route.
    for (const url of ["/api/backlogs?file=plans&index=0", "/api/backlogx"]) {
      const r = await fetch(base + url);
      assert.equal(r.status, 404, url);
    }

    // An empty section is out of range at index 0 (seeded placeholders are not entries).
    fs.writeFileSync(path.join(repo, "BUGS.md"), ["# Bugs", "", "## Open", "", "_None yet._", "", "## Fixed", "", "_None yet._"].join("\n") + "\n");
    res = await fetch(base + "/api/backlog?file=bugs&index=0");
    assert.equal(res.status, 400);

    // The status payload is unchanged by this endpoint: titles only, no bodies.
    const status = (await (await fetch(base + "/api/status")).json()) as { plans: string[] };
    assert.deepEqual(status.plans, ["First plan (planned 2026-09-05)", "Second plan (planned 2026-09-04)"]);
  } finally {
    server.close();
  }
});

test("the dashboard page renders backlog entries as links into /api/backlog", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  // Each entry line is an <a> carrying its file and zero-based index…
  assert.match(GUI_PAGE, /class='backloglink/);
  assert.match(GUI_PAGE, /data-file='/);
  assert.match(GUI_PAGE, /data-index='/);
  // …clicking one fetches the on-demand endpoint into the detail panel (the same #transcript
  // panel loop transcripts use — mutual exclusion is pinned by the click handlers below).
  assert.match(GUI_PAGE, /\/api\/backlog\?file=/);
  assert.match(GUI_PAGE, /a\.backloglink/);
  // The `?` must stay escaped: unescaped it is a quantifier on the preceding space and can
  // never match the page's literal ternary (`key ? null`) text.
  assert.match(GUI_PAGE, /backlogKey = backlogKey === key \? null : key/);
});

test("the dashboard page checks r.ok before parsing both on-demand panel fetches", async () => {
  // Regression: the transcript branch parsed its response without an ok check. Every error
  // body /api/transcript sends is JSON ({error}) with no lines, so a failed poll (400 for a
  // role outside the catalog once custom loops exist, 500 when the log read throws) rendered
  // "(no transcript yet for this loop)" — claiming an empty log instead of keeping the last
  // good content. Both on-demand fetches must fail identically into the catch that keeps the
  // previous panel content.
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  // Both on-demand fetches route through the shared getJson, whose r.ok guard throws
  // apiError before any parse — so a JSON error body is never read as panel content.
  assert.match(
    GUI_PAGE,
    /getJson\("\/api\/transcript\?role=" \+ encodeURIComponent\(transcriptRole\) \+ "&n=50"\)/,
    "the transcript poll goes through the guarded getJson",
  );
  assert.match(
    GUI_PAGE,
    /getJson\("\/api\/backlog\?file=" \+ encodeURIComponent\(file\) \+ "&index=" \+ encodeURIComponent\(index\)\)/,
    "the backlog poll goes through the guarded getJson",
  );
  // The single guard every endpoint call shares, and the error helper it throws: apiError
  // names the endpoint, the HTTP status, and the server's error text (parsed leniently:
  // JSON {error} or plain text) — the fix a failed budget save used to flash as a bare
  // "bad response".
  assert.match(GUI_PAGE, /if \(!r\.ok\) throw await apiError\(path, r\);/);
  assert.match(GUI_PAGE, /async function apiError\(path, r\)/);
  assert.match(GUI_PAGE, /await apiFetch\("\/api\/budget", \{ method: "POST"/);
  assert.match(GUI_PAGE, /await apiFetch\("\/api\/pause", \{ method: "POST"/);
  // The report panel surfaces the same message instead of a bare "unavailable".
  assert.match(GUI_PAGE, /report unavailable" \+ \(e && e\.message/);
});

test("the dashboard status poll checks r.ok before parsing", async () => {
  // Regression: refresh() parsed /api/status without an ok check. The server's 500 catch
  // sends a JSON {error} body, so on a failed poll that object was assigned to lastStatus
  // and the frame rendered from it ("orchestrator not running", no loops) before the render
  // throw landed in the catch — and the budget editor prefilled from the error object.
  // Throwing before the assignment keeps the last good payload and reports "connection lost".
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  assert.match(
    GUI_PAGE,
    /const d = await getJson\("\/api\/status"\);/,
    "the status poll goes through the guarded getJson (a JSON {error} body is not fleet state)",
  );
});

test("the dashboard page escapes backlog entry bodies before innerHTML", async () => {
  // Regression: the detail panel used to splice d.body — model-written markdown from
  // PLANS/BUGS/QUESTIONS.md, edited by loops — straight into innerHTML while every other
  // dynamic value on the page (the same entry's title included) went through esc(). HTML in a
  // plan/bug/question entry would then execute in the operator's browser; with
  // --all-interfaces the dashboard is reachable network-wide without auth.
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");

  // The detail panel line routes d.body through esc (esc("") is "", so empty bodies still
  // fall back to the placeholder).
  assert.match(
    GUI_PAGE,
    /" — click the entry again to close<\/span>\\n" \+ \(esc\(d\.body\) \|\| "\(no details for this entry\)"\)/,
  );

  // Exercise the page's own esc: one pass neutralizes tags and ampersands alike. The body
  // capture anchors at the statement's terminating semicolon (end of line), not the first `;`
  // — the replacement map contains one inside its "&amp;" string literal.
  const m = GUI_PAGE.match(/const esc = \((\w+)\) => (.+);$/m);
  assert.ok(m, "esc definition found in the page");
  const esc = new Function(m[1]!, `return (${m[2]});`) as (s: string) => string;
  assert.equal(esc("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;", "tags are neutralized");
  assert.equal(esc("a & b < c > d"), "a &amp; b &lt; c &gt; d", "ampersands and angle brackets escape");

  // The server contract is unchanged: /api/backlog still serves the raw markdown body —
  // escaping is the page's job, like every other field it renders.
  const repo = makeRepo();
  await initProject(repo, "backlog esc test");
  fs.writeFileSync(
    path.join(repo, "BUGS.md"),
    ["# Bugs", "", "## Open", "", "### A bug with HTML in its body (reported 2026-09-06)", "", "<img src=x onerror=alert(1)>", "", "## Fixed", "", "_None yet._"].join("\n") + "\n",
  );
  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/backlog?file=bugs&index=0`);
    assert.equal(res.status, 200);
    const d = (await res.json()) as { title: string; body: string };
    assert.equal(d.body, "<img src=x onerror=alert(1)>", "the API serves the raw markdown body");
  } finally {
    server.close();
  }
});

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
    landQueue: { depth: number; inFlight?: { role: string; sha: string; summary: string; startedAt: number } };
    landingBadge: string;
    loops: Array<{ role: string; phase: string }>;
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
  // landing role's row phase reads `landing <elapsed>` while every other row is untouched.
  const infoFile = orchestratorStatePath(repo);
  fs.mkdirSync(path.dirname(infoFile), { recursive: true });
  fs.writeFileSync(infoFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["clean"] }));
  const startedAt = Date.now();
  fs.writeFileSync(landingStatePath(repo), JSON.stringify({ role: "clean", sha: "abc1234", summary: "tidy something", startedAt }));
  p = statusPayload(repo) as typeof payload;
  assert.equal(p.landQueue.inFlight?.role, "clean");
  assert.equal(p.landQueue.inFlight?.sha, "abc1234");
  assert.match(p.loops.find((l) => l.role === "clean")!.phase, /^landing \d+s$/, "the landing role's phase is marker-driven");
  assert.equal(p.loops.find((l) => l.role === "bugfix")!.phase, "queued", "other roles keep their normal phase");
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
  const fetch = async (_url: string, opts: { body: string }) => {
    posts.push(JSON.parse(opts.body));
    return { ok: true };
  };
  const { saveBudget } = new Function(
    "document",
    "esc",
    "fetch",
    // The block's save path now routes through the page's shared apiFetch guard; the stub
    // mirrors it over the fake fetch above (its success path never touches apiError).
    "apiFetch",
    "setTimeout",
    block + "\nreturn { saveBudget };",
  )(document, (s: string) => s, fetch, (path: string, init: { body: string }) => fetch(path, init), () => {}) as { saveBudget: () => Promise<void> };

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
  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
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
    assert.match(((await (await fetch(base + "/api/budget", { method: "POST", body: '{"maxDailyCostUsd": -1}' })).json()) as { error: string }).error, /-1/);
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
  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/budget`, {
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
  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
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
    assert.match(
      ((await (await fetch(base + "/api/pause", { method: "POST", body: '{"paused": "true"}' })).json()) as { error: string }).error,
      /boolean/,
    );

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
  const apiFetch = async (_url: string, opts: { body: string }) => {
    posts.push(JSON.parse(opts.body));
    return { ok: true };
  };
  const { renderPauseBadge, togglePause } = new Function(
    "document",
    "apiFetch",
    "showFlash",
    "lastStatus",
    block + "\nreturn { renderPauseBadge, togglePause };",
  )(document, apiFetch, () => {}, lastStatus) as {
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

// The build badge on the GUI surface: /api/status carries it pre-formatted through
// status-render's buildBadge — the same string the TUI header renders — so the page cannot
// re-derive (and drift from) the multi-branch text client-side.

test("status payload carries the build badge pre-formatted by buildBadge", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui build badge test");
  // No harness running: no stamp, empty badge (the page renders nothing for it).
  let payload = statusPayload(repo) as { build: unknown; buildBadge: string };
  assert.equal(payload.build, null);
  assert.equal(payload.buildBadge, "", "no running harness: empty badge");

  // A live orchestrator (this process) publishing a stale stamp with a blocked restart:
  // the payload's badge is exactly what status-model's buildBadge renders for that BuildStatus.
  const { buildBadge } = await import("../src/ui/status-model.js");
  const stamp = {
    sha: "a".repeat(40), builtAt: 1, stale: true, aheadCommits: 7,
    checkedHead: "b".repeat(40), restartBlocked: "main cccccccc is red",
  };
  const infoFile = orchestratorStatePath(repo);
  fs.mkdirSync(path.dirname(infoFile), { recursive: true });
  fs.writeFileSync(infoFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["clean"], build: stamp }));
  payload = statusPayload(repo) as typeof payload;
  assert.equal(payload.buildBadge, buildBadge(stamp), "one home for the badge text");
  assert.match(payload.buildBadge, /build aaaaaaaa — STALE: main \+7 commit\(s\) since; restart BLOCKED: main cccccccc is red$/);
});

test("the dashboard header takes its build badge pre-formatted from the payload", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  assert.match(GUI_PAGE, /d\.buildBadge \|\| ""/);
  // The old client-side reconstruction (sha slice + STALE/restart fragments) is gone — the
  // badge text has exactly one home: status-render's buildBadge.
  assert.doesNotMatch(GUI_PAGE, /STALE: main \+/);
  assert.doesNotMatch(GUI_PAGE, /restart BLOCKED/);
});

test("the dashboard page reloads itself when the serving build sha changes", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  // The serving process's own startup sha is remembered beside lastStatus (first non-null wins).
  assert.match(GUI_PAGE, /let lastStatus = null;[\s\S]{0,200}let serverBuildSha = null;/);
  // A later successful poll whose sha differs reloads before any render; the failed-poll catch
  // never touches the variable, so it survives the gap while the server restarts.
  assert.match(
    GUI_PAGE,
    /lastStatus = d;[\s\S]{0,500}d\.serverBuildSha !== serverBuildSha[\s\S]{0,60}location\.reload\(\)/,
  );
});

// The operator pause on the GUI surface (PLANS.md, fleet-pause plan): /api/status — and
// therefore `status --json`, same payload — carries `paused` while the marker exists, and a
// paused fleet's idle role loops read `paused` in their phase payload ahead of budget paused.

test("the status payload carries the operator pause flag; its phase outranks budget paused", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui fleet pause test");
  // A live orchestrator (this process) so loopPhase doesn't short-circuit to "stopped"…
  const infoFile = orchestratorStatePath(repo);
  fs.mkdirSync(path.dirname(infoFile), { recursive: true });
  fs.writeFileSync(infoFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), roles: ["clean"] }));

  // No marker: not paused.
  let payload = statusPayload(repo) as {
    paused: boolean;
    loops: Array<{ role: string; phase: string }>;
  };
  assert.equal(payload.paused, false);
  assert.notEqual(payload.loops.find((l) => l.role === "clean")?.phase, "paused");

  // Drop the marker (what `tumwater pause` does) with spend at the cap: the flag flips and
  // the idle loop's phase reads `paused`, ahead of budget paused.
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsd = 10;
  saveConfig(repo, cfg);
  const s = freshLoopState("clean");
  s.dayStamp = todayStamp();
  s.dayCostUsd = 12.5; // >= cap → budget paused too
  saveLoopState(repo, s);
  const marker = pausedPath(repo);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ at: Date.now() }));

  payload = statusPayload(repo) as typeof payload;
  assert.equal(payload.paused, true, "the flag rides the payload top level");
  assert.equal(
    payload.loops.find((l) => l.role === "clean")?.phase,
    "paused",
    "user pause outranks budget paused in the phase payload",
  );
  // The director is exempt — its phase keeps its own label.
  assert.equal(payload.loops.find((l) => l.role === "director")?.phase, "waiting for prompts");

  // Removing the marker (what `tumwater resume` does) reverts both: flag false, and with the
  // spend still at the cap the loop falls back to budget paused.
  fs.rmSync(marker);
  payload = statusPayload(repo) as typeof payload;
  assert.equal(payload.paused, false);
  assert.equal(payload.loops.find((l) => l.role === "clean")?.phase, "budget paused");

  fs.rmSync(infoFile, { force: true });
});

test("gui rejects oversized prompt bodies with 413 instead of buffering them unboundedly", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui body limit test");
  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    // Just over the 64KB cap: a client error (413 Payload Too Large), not a server failure.
    const huge = JSON.stringify({ text: "x".repeat(70 * 1024) });
    const res = await fetch(base + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: huge,
    });
    assert.equal(res.status, 413);
    assert.match(await res.text(), /body too large/);

    // The server stays healthy afterwards and still accepts normal prompts.
    const ok = await fetch(base + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "still alive" }),
    });
    assert.equal(ok.status, 200);
    assert.equal(inboxSize(repo), 1);
  } finally {
    server.close();
  }
});

test("gui answers JSON 500 when a handler throws unexpectedly and keeps serving", async () => {
  // Skip under root, where chmod cannot stop the write and submitPrompt would succeed.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;

  const repo = makeRepo();
  await initProject(repo, "gui handler error test");
  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  const inbox = path.join(repo, ".tumwater", "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  try {
    // An unwritable inbox makes submitPrompt throw (EACCES) — an unexpected error inside a
    // request handler. Without the catch-all it would surface as an unhandled rejection and
    // kill the dashboard process over one bad request; with it, the client gets a JSON 500
    // naming the failure and every later request still works.
    fs.chmodSync(inbox, 0o555);

    const res = await fetch(base + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "this write will fail" }),
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /EACCES|permission denied/);
    assert.equal(inboxSize(repo), 0, "the failed prompt queued nothing");

    // The server survived the bad request and still serves.
    const status = await fetch(base + "/api/status");
    assert.equal(status.status, 200);
  } finally {
    fs.chmodSync(inbox, 0o755);
    server.close();
  }
});

test("multi-byte UTF-8 characters straddling chunk boundaries arrive intact", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui utf8 test");
  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try {
    // A prompt containing a CJK character (3 bytes in UTF-8). The chunked upload is framed
    // so that character straddles two chunks — socket/chunk boundaries are arbitrary TCP
    // framing, and decoding each chunk independently would replace the split character with
    // U+FFFD, silently corrupting what the director receives.
    const text = "fix the 数据库 bug";
    const body = Buffer.from(JSON.stringify({ text }), "utf8");
    const charStart = body.indexOf(Buffer.from("数", "utf8"));
    assert.ok(charStart > 0 && charStart + 3 <= body.length, "test body contains the CJK character");
    const splitAt = charStart + 1; // inside the 3-byte sequence

    const socket = net.connect(addr.port, "127.0.0.1");
    let response = "";
    socket.on("data", (d: Buffer) => {
      response += d.toString("ascii");
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.write(
        "POST /api/prompt HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n",
        () => resolve(),
      );
    });
    const frame = (b: Buffer): Buffer =>
      Buffer.concat([Buffer.from(`${b.length.toString(16)}\r\n`, "ascii"), b, Buffer.from("\r\n", "ascii")]);
    // Send the two halves as separate frames with a pause between them so the server reads
    // (and decodes) each chunk on its own — the condition that corrupts per-chunk decoding.
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.write(frame(body.subarray(0, splitAt)), () => setTimeout(resolve, 50));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.write(Buffer.concat([frame(body.subarray(splitAt)), Buffer.from("0\r\n\r\n", "ascii")]), () => resolve());
    });
    // Wait for the response to land.
    await new Promise((r) => setTimeout(r, 200));

    assert.match(response, /^HTTP\/1\.1 200/, `expected 200, got: ${response.split("\r\n")[0]}`);
    const queued = dequeuePrompt(repo);
    assert.equal(queued, text, "the prompt arrives byte-for-byte intact");
    socket.destroy();
  } finally {
    server.close();
  }
});

test("gui answers 404, not 500, for a request target the URL parser rejects", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui malformed target test");
  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    // An absolute-form target whose host is malformed (`http://[`) is accepted by Node's HTTP
    // parser and handed to the handler as req.url, but `new URL(req.url, base)` throws on it.
    // requestPathname must swallow that and read as "no route" — a 404 — instead of letting
    // the throw reach the handler's 500 catch, which would report a server fault for what is
    // plainly a bad request. A raw socket is required: fetch/undici reject the malformed URL
    // client-side before it ever reaches the server.
    const socket = net.connect(addr.port, "127.0.0.1");
    let response = "";
    socket.on("data", (d: Buffer) => {
      response += d.toString("ascii");
    });
    const ended = new Promise<void>((resolve) => socket.on("end", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.write("GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n", () => resolve());
    });
    await ended;

    assert.match(response, /^HTTP\/1\.1 404/, `expected 404, got: ${response.split("\r\n")[0]}`);
    assert.match(response, /not found/);
    socket.destroy();

    // The rejection is confined to the bad request: the server keeps routing well-formed ones.
    assert.equal((await fetch(base + "/nope")).status, 404);
    const status = await fetch(base + "/api/status");
    assert.equal(status.status, 200);
  } finally {
    server.close();
  }
});

test("oversized prompt bodies stop buffering at the cap (no unbounded growth)", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui body bound test");
  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try {
    // A raw chunked upload of ~4MB in 16KB frames. The 413 lands after the first ~64KB, but
    // this client keeps sending every frame to completion (a well-behaved HTTP client would
    // stop). The server must reject at the cap and then DRAIN without buffering — before the
    // fix each late chunk was still appended to the body string, growing it to the full upload
    // size. Keep-alive (no Connection: close) keeps the server-side request alive so a buggy
    // buffer would still be retained when we measure.
    const socket = net.connect(addr.port, "127.0.0.1");
    let response = "";
    socket.on("data", (d: Buffer) => {
      response += d.toString("ascii");
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.write(
        "POST /api/prompt HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n",
        () => resolve(),
      );
    });
    const frame = Buffer.alloc(16 * 1024, 0x78); // 'x'
    const framed = Buffer.concat([Buffer.from(`${frame.length.toString(16)}\r\n`, "ascii"), frame, Buffer.from("\r\n", "ascii")]);
    (globalThis as { gc?: () => void }).gc?.();
    const before = process.memoryUsage().heapUsed;
    await new Promise<void>((resolve, reject) => {
      let i = 0;
      socket.once("error", reject);
      const next = (): void => {
        if (i >= 256) return resolve();
        i++;
        socket.write(framed, next);
      };
      next();
    });
    // Give the server a moment to finish draining what is still in flight.
    await new Promise((r) => setTimeout(r, 300));
    (globalThis as { gc?: () => void }).gc?.();
    const growth = process.memoryUsage().heapUsed - before;
    assert.ok(growth < 1_048_576, `server retained ~${(growth / 1024 / 1024).toFixed(1)}MB of a rejected body`);
    assert.match(response, /^HTTP\/1\.1 413/, "the oversized upload still gets the 413");
    socket.destroy();
  } finally {
    server.close();
  }
});

test("gui survives a client that disconnects mid-upload and keeps serving", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui aborted upload test");
  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try {
    // A client that vanishes mid-upload (browser closed, flaky LAN): the body is cut off
    // short of Content-Length, so Node fires 'error' (ECONNRESET) on the request stream.
    // readBody must settle via that error — a handler left awaiting a never-settling promise
    // would leak one per aborted upload, and an uncaught error from the dead connection could
    // kill the dashboard over one dropped client. The partial body is not valid JSON, so even
    // a regression that resolved it early could only 400 — nothing may be queued.
    const socket = net.connect(addr.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.write(
        "POST /api/prompt HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 4096\r\nConnection: close\r\n\r\n" +
          '{"text": "cut off mid', // partial body — far short of Content-Length
        () => resolve(),
      );
    });
    await new Promise((r) => setTimeout(r, 50)); // let the server start reading the body
    socket.destroy(); // client gone before the body completes

    // Give the error path a moment to settle (req 'error' → readBody reject → handler catch).
    await new Promise((r) => setTimeout(r, 200));

    // The aborted upload queued nothing — a partial body must never become a prompt.
    assert.equal(inboxSize(repo), 0, "the aborted upload queued no prompt");

    // The dashboard survived the dropped connection and still serves: status answers and a
    // fresh, complete prompt is accepted end to end.
    const base = `http://127.0.0.1:${addr.port}`;
    assert.equal((await fetch(base + "/api/status")).status, 200);
    const res = await fetch(base + "/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "sent after the abort" }),
    });
    assert.equal(res.status, 200);
    assert.equal(dequeuePrompt(repo), "sent after the abort");
  } finally {
    server.close();
  }
});

// The GUI report tab (PLANS.md "report 2/3"): /api/report serves collectReport's ReportData
// as JSON with days clamped rather than errored, the page carries the tab nav + #report
// container, and its pure SVG chart builders are extracted from a marked region and tested.

/** Local calendar-day timestamp `daysAgo` days back at noon — same local-date-part rule as
 * test/report.test.ts's fixtures (the report buckets by LOCAL day). */
function atNoon(daysAgo: number): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("gui /api/report serves collectReport's JSON and clamps days instead of erroring", async () => {
  const repo = makeRepo();
  await initProject(repo, "report api test");
  // Seed events with explicit ts values across two roles (the role field is `loop`, as
  // collectReport reads it — a line using `role` would bucket under "?") plus one merged;
  // features/bugs come from dated headings in PLANS.md/BUGS.md, not from events.
  const evFile = eventsLogPath(repo);
  fs.mkdirSync(path.dirname(evFile), { recursive: true });
  fs.writeFileSync(
    evFile,
    [
      JSON.stringify({ ts: atNoon(3), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 500, costUsd: 0.25 }),
      JSON.stringify({ ts: atNoon(3), loop: "bugfix", type: "tick_end", tick: 2, result: "no_change" }),
      JSON.stringify({ ts: atNoon(1), loop: "feature", type: "merged", commit: "abc", summary: "x" }),
      JSON.stringify({ ts: atNoon(0), loop: "steward", type: "tick_end", tick: 3, result: "no_change", tokens: 250, costUsd: 1.5 }),
    ].join("\n") + "\n",
  );
  const today = localDayKey(Date.now());
  fs.writeFileSync(
    path.join(repo, "PLANS.md"),
    `# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n### A done plan (planned ${today}, done ${today})\n`,
  );
  fs.writeFileSync(
    path.join(repo, "BUGS.md"),
    `# Bugs\n\n## Open\n\n_None yet._\n\n## Fixed\n\n### A fixed bug (found by qa loop ${today}, fixed ${today})\n`,
  );

  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    // Default window: the JSON equals collectReport's output for the same root/days.
    const res = await fetch(base + "/api/report");
    assert.equal(res.status, 200);
    const d = (await res.json()) as ReturnType<typeof collectReport>;
    assert.deepEqual(d, collectReport(repo, 14), "the endpoint serves collectReport's ReportData");
    assert.equal(d.totals.featuresDone, 1, "a dated Done heading counts as a feature done");
    assert.equal(d.totals.bugsFixed, 1, "a dated Fixed heading counts as a bug fixed");

    // days: missing or non-decimal → default 14; out-of-range clamped to 1..90 — never an
    // error. Non-decimal follows the shared plain-digit rule (text.parseNonNegativeInt):
    // hex/scientific/signed/padded spellings are not counts, so they get the default instead
    // of a coerced value (raw Number.parseInt read "1e3" as 1 and "0x10" as 0).
    const cases: Array<[string, number]> = [
      ["days=14", 14],
      ["days=", 14],
      ["days=abc", 14],
      ["days=-5", 14], // signed spelling is not a count — default, not clamped coercion
      ["days=1e3", 14], // scientific spelling likewise
      ["days=0x10", 14], // hex prefix: raw parseInt stopped at "x" and coerced to 0 → 1 day
      ["days=%207", 14], // whitespace-padded spelling is not a count
      ["days=0", 1],
      ["days=91", 90],
      ["days=900", 90],
    ];
    for (const [q, expected] of cases) {
      const r = await fetch(base + "/api/report?" + q);
      assert.equal(r.status, 200, `${q} → 200 (a URL typo degrades to a window, not an error)`);
      const dd = (await r.json()) as { days: number; series: unknown[] };
      assert.equal(dd.days, expected, `${q} → ${expected}`);
      assert.equal(dd.series.length, expected, `series length follows the clamped window`);
    }
  } finally {
    server.close();
  }
});

test("gui /api/failures serves the rendered digest and clamps days instead of erroring", async () => {
  const repo = makeRepo();
  await initProject(repo, "failures api test");
  // Seed events with explicit ts values across roles, including one error so the digest has a
  // cluster to render — the endpoint's whole job is to hand back renderFailureMarkdown's text.
  const evFile = eventsLogPath(repo);
  fs.mkdirSync(path.dirname(evFile), { recursive: true });
  fs.writeFileSync(
    evFile,
    [
      JSON.stringify({ ts: atNoon(3), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 500, costUsd: 0.25 }),
      JSON.stringify({ ts: atNoon(3), loop: "bugfix", type: "tick_end", tick: 2, result: "error", error: "pi exited 1" }),
      JSON.stringify({ ts: atNoon(1), loop: "feature", type: "merged", commit: "abc", summary: "x" }),
      JSON.stringify({ ts: atNoon(0), loop: "steward", type: "tick_end", tick: 3, result: "no_change" }),
    ].join("\n") + "\n",
  );

  const server = await startGui(repo, 0);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    // Default window: the markdown equals the pure renderer's output for the same root/days.
    const res = await fetch(base + "/api/failures");
    assert.equal(res.status, 200);
    const d = (await res.json()) as { markdown: string };
    assert.equal(d.markdown, renderFailureMarkdown(collectFailureReport(repo, 14)));
    assert.match(d.markdown, /^# tumwater failure digest/, "the tab renders the digest's heading first");

    // days follows /api/report's exact rule: missing/non-decimal → 14; out-of-range clamped to
    // 1..90 — never an error. Compare each against the digest rendered for the clamped count.
    const cases: Array<[string, number]> = [
      ["days=14", 14],
      ["days=", 14],
      ["days=abc", 14],
      ["days=-5", 14], // signed spelling is not a count — default, not clamped coercion
      ["days=1e3", 14], // scientific spelling likewise
      ["days=0x10", 14], // hex prefix: raw parseInt stopped at "x" and coerced to 0 → 1 day
      ["days=%207", 14], // whitespace-padded spelling is not a count
      ["days=0", 1],
      ["days=91", 90],
      ["days=900", 90],
    ];
    for (const [q, expected] of cases) {
      const r = await fetch(base + "/api/failures?" + q);
      assert.equal(r.status, 200, `${q} → 200 (a URL typo degrades to a window, not an error)`);
      const dd = (await r.json()) as { markdown: string };
      assert.equal(dd.markdown, renderFailureMarkdown(collectFailureReport(repo, expected)), `${q} → ${expected}`);
    }
  } finally {
    server.close();
  }
});

test("the dashboard page carries the report tab nav and its view containers", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");

  // Nav row under the h1 with all three tabs; fleet is active by default.
  assert.match(
    GUI_PAGE,
    /<nav id="viewnav"><a href="#" id="tab-fleet" class="active">fleet<\/a>[\s\S]*?<a href="#" id="tab-report">report<\/a>[\s\S]*?<a href="#" id="tab-failures">failures<\/a><\/nav>/,
  );

  // The fleet view wraps exactly the four fleet elements; #report and #failures are hidden
  // siblings shown when active (the page's existing hidden-attribute pattern).
  assert.match(
    GUI_PAGE,
    /<div id="fleet-view">\n<table>[\s\S]*?<\/table>\n<div id="transcript" hidden><\/div>\n<div id="backlog"><\/div>\n<div id="feed"><\/div>\n<\/div>/,
  );
  assert.match(GUI_PAGE, /<\/div>\n<div id="report" hidden><\/div>\n<div id="failures" hidden><\/div>\n<script>/);
  // #failures reuses #transcript's box, so the digest keeps its newlines and scrolls.
  assert.match(GUI_PAGE, /#transcript, #failures \{[\s\S]*?white-space:pre-wrap/);

  // The director prompt form sits outside the fleet view — visible on every tab.
  const formIdx = GUI_PAGE.indexOf('<form id="promptform">');
  const viewIdx = GUI_PAGE.indexOf('<div id="fleet-view">');
  assert.ok(formIdx !== -1 && viewIdx !== -1 && formIdx < viewIdx, "the prompt form stays outside the fleet view");

  // Report and failures are fetched on tab activation only — no per-second polls of them.
  assert.match(GUI_PAGE, /getJson\("\/api\/report\?days=14"\)/);
  assert.match(GUI_PAGE, /if \(v === "report"\) fetchReport\(\)/);
  assert.match(GUI_PAGE, /getJson\("\/api\/failures\?days=14"\)/);
  assert.match(GUI_PAGE, /if \(v === "failures"\) fetchFailures\(\)/);
  assert.equal(GUI_PAGE.match(/setInterval\(/g)?.length ?? 0, 1, "the only poll is the existing 1s status refresh");
});

test("the report charts carry a cursor-following hover label", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");

  // The shared chip: fixed in viewport coordinates, inert to the pointer (so it cannot
  // flicker away the instant the cursor reaches it), hidden until a segment shows it.
  assert.match(GUI_PAGE, /#report-tip \{[^}]*position:fixed[^}]*pointer-events:none[^}]*display:none[^}]*\}/);
  // The only hover affordance on the charts is the dimmed segment; legend/stats/axis text
  // stay untouched.
  assert.match(GUI_PAGE, /#report svg rect:hover \{[^}]*opacity:\.8/);

  // The label is read from each segment's existing <title> — the abbreviated value the
  // chart-builder test pins byte-for-byte — never re-derived, so the tooltip cannot drift
  // from the builders' label strings.
  assert.match(GUI_PAGE, /ev\.target instanceof Element \? ev\.target\.closest\("rect"\) : null/);
  assert.match(GUI_PAGE, /target\.querySelector\("title"\)\?\.textContent/);

  // The listeners delegate off the #report container itself — which fetchReport re-renders
  // by innerHTML but never replaces — so one attach at init survives every re-render;
  // pointerleave hides the chip when the pointer leaves the panel.
  assert.match(GUI_PAGE, /attachReportTip\(\) \{\n    const panel = document\.getElementById\("report"\);[\s\S]*?panel\.addEventListener\("pointermove", /);
  assert.match(GUI_PAGE, /panel\.addEventListener\("pointerleave", /);

  // The tooltip JS is a marked region (the page's loop-sort / last-tick-fmt convention)
  // wired in once at init, immediately before the final refresh + 1 s poll.
  assert.match(GUI_PAGE, /\/\/ report-tip:start\n[\s\S]*?\n  \/\/ report-tip:end/);
  assert.match(GUI_PAGE, /attachReportTip\(\);\n  refresh\(\);\n  setInterval\(refresh, 1000\);/);
});

test("the report tab's SVG chart builders render bars, stacks, and thinned labels", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");

  // Extract the marked region — same regex-extract + new Function pattern as the esc test.
  // The page's own esc is injected so role names escape exactly like every other dynamic value;
  // the page's own fmtTokens is extracted the same way (the esc test's single-line-const seam)
  // and injected so the chart labels rule cannot drift from the stat blocks above them.
  const m = GUI_PAGE.match(/\/\/ report-chart:start\n([\s\S]*?)\n  \/\/ report-chart:end/);
  assert.ok(m, "report-chart region found in the page");
  const fm = GUI_PAGE.match(/const fmtTokens = \((\w+)\) => (.+);$/m);
  assert.ok(fm, "fmtTokens definition found in the page");
  const fmtTokens = new Function(fm[1]!, `return (${fm[2]});`) as (n: number) => string;
  type ChartBuilders = {
    chartTokens(d: ReportData): string;
    chartTicksByRole(d: ReportData): string;
    chartCommits(d: ReportData): string;
  };
  const escImpl = (s: string) => String(s).replace(/[&<>]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c] as string));
  const builders = new Function("esc", "fmtTokens", `${m[1]}\nreturn { chartTokens, chartTicksByRole, chartCommits };`) as unknown as (
    esc: (s: string) => string,
    fmtTokens: (n: number) => string,
  ) => ChartBuilders;
  const { chartTokens, chartTicksByRole, chartCommits } = builders(escImpl, fmtTokens);

  // Fixture: 14 days — tokens rising to a max on the last day, two roles with distinct window
  // totals (feature > bugfix), one zero day in the middle.
  const mkDay = (date: string, tokensOut: number, ticksByRole: Record<string, number>, commits: number): ReportDay => ({
    date,
    tokensOut,
    ticksByRole,
    commits,
    costUsd: 0.5,
    featuresDone: 0,
    bugsFixed: 0,
  });
  const series: ReportDay[] = [];
  for (let i = 0; i < 14; i++) {
    const date = `2026-09-${String(i + 1).padStart(2, "0")}`;
    if (i === 7) series.push({ ...mkDay(date, 0, {}, 0), costUsd: 0 }); // the zero day
    else series.push(mkDay(date, (i + 1) * 1000, i % 2 === 0 ? { feature: 3, bugfix: 1 } : { feature: 2 }, i % 3 === 0 ? 2 : 1));
  }
  const data: ReportData = {
    days: 14,
    from: series[0]!.date,
    to: series[13]!.date,
    series,
    totals: { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
  };

  const parseRects = (svg: string) =>
    [...svg.matchAll(/<rect x='([\d.]+)' y='([\d.]+)' width='([\d.]+)' height='([\d.]+)' fill='([^']*)'><title>([^<]*)<\/title><\/rect>/g)].map(
      (r) => ({ x: +r[1]!, y: +r[2]!, w: +r[3]!, h: +r[4]!, fill: r[5]!, title: r[6]! }),
    );

  // "Output tokens per day": one bar per non-zero day; the window-max day's bar is the tallest.
  const tokenRects = parseRects(chartTokens(data));
  assert.equal(tokenRects.length, 13, "one bar per non-zero day (the zero day leaves an empty slot)");
  const maxBar = tokenRects.find((r) => r.title === "2026-09-14: 14.0k");
  assert.ok(maxBar, "tokens ≥ 10k are abbreviated like the stat blocks");
  for (const r of tokenRects) {
    assert.ok(r.h <= maxBar!.h + 1e-9, "no bar exceeds the window-max bar");
    assert.ok(Math.abs(r.y + r.h - (maxBar!.y + maxBar!.h)) < 1e-9, "every bar sits on the same baseline");
  }

  // X-axis labels: MM-DD like the Markdown table, thinned to at most seven.
  const labels = [...chartTokens(data).matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((t) => t[1]!);
  assert.ok(labels.length <= 7, "labels thinned to at most seven");
  assert.equal(labels[0], "09-01", "the first day is always labeled (MM-DD)");

  // "Commits per day": one bar per non-zero day with the abbreviated value in its tooltip
  // (counts below 10k pass through unchanged).
  const commitRects = parseRects(chartCommits(data));
  assert.equal(commitRects.length, 13);
  assert.ok(commitRects.some((r) => r.title === "2026-09-04: 2"), "small commit tooltips are unchanged");

  // "Ticks per day by role": one segment per (day, role) with ticks; the highest-count role
  // sits at the bottom of each stack and first in the legend, colored from the fixed palette.
  const stacked = parseRects(chartTicksByRole(data));
  assert.equal(stacked.length, 7 * 2 + 6 * 1, "one segment per (day, role) with ticks");
  const day0 = stacked.filter((r) => r.title.startsWith("2026-09-01 "));
  assert.equal(day0.length, 2);
  const feat = day0.find((r) => r.title.includes("feature"))!;
  const bug = day0.find((r) => r.title.includes("bugfix"))!;
  assert.ok(feat.y > bug.y, "the highest-count role (feature) sits at the bottom of the stack");
  assert.ok(Math.abs(feat.h - 3 * bug.h) < 0.05, "segment heights are proportional to their values");
  const legend = chartTicksByRole(data);
  assert.match(legend, /style='background:#7ec8ff'><\/span>feature<\/span>/, "first role gets palette[0]");
  assert.match(legend, /style='background:#7fd88f'><\/span>bugfix<\/span>/, "second role gets palette[1]");

  // Role names are dynamic strings (custom loops): escaped in legend and tooltips like every
  // other dynamic value — raw HTML in a role name must not render.
  const hostile: ReportData = {
    ...data,
    series: [mkDay("2026-09-01", 0, { "<b>x</b>": 2 }, 0)],
  };
  const hostileSvg = chartTicksByRole(hostile);
  assert.ok(!hostileSvg.includes("<b>x</b>"), "raw HTML in a role name is not rendered");
  assert.match(hostileSvg, /&lt;b&gt;x&lt;\/b&gt;/, "role names are escaped in legend and tooltips");
});

test("the dashboard page abbreviates millions with M, in lockstep with compactTokens", async () => {
  // Regression (2026-09-20): the page's own fmtTokens copy stopped at `k`, so the loop
  // table's generated/peak-ctx cells and the report summary's output-tokens block rendered
  // 13,820,300 as "13820.3k" while `tumwater report` printed "13.8M". The page cannot import
  // TypeScript (a separate browser runtime), so its copy is pinned here from the page's own
  // source — same regex-extract + new Function pattern as the esc test — and every value is
  // cross-checked against the shared compactTokens so the deliberate duplicate cannot drift.
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  const m = GUI_PAGE.match(/const fmtTokens = \((\w+)\) => (.+);$/m);
  assert.ok(m, "fmtTokens definition found in the page");
  const fmtTokens = new Function(m[1]!, `return (${m[2]});`) as (n: number) => string;

  assert.equal(fmtTokens(9_999), "9999", "bare below the k threshold");
  assert.equal(fmtTokens(14_000), "14.0k", "one-decimal k unchanged");
  assert.equal(fmtTokens(1_000_000), "1.0M", "boundary: swaps k for M");
  assert.equal(fmtTokens(13_820_300), "13.8M", "13.8M, not 13820.3k");
  assert.equal(fmtTokens(undefined as unknown as number), "0", "a missing payload field renders as 0");
  for (const n of [0, 500, 9_999, 10_000, 12_345, 999_999, 1_000_000, 13_820_300]) {
    assert.equal(fmtTokens(n), compactTokens(n), `page and compactTokens agree on ${n}`);
  }
});
