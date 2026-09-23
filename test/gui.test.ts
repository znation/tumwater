import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";
import { lanAddresses, startGui } from "../src/ui/gui.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { initProject } from "../src/init.js";
import { dequeuePrompt, inboxSize, submitPrompt } from "../src/inbox.js";
import { orchestratorStatePath, pausedPath, piLogPath } from "../src/paths.js";
import { freshLoopState, saveLoopState } from "../src/state.js";
import { todayStamp } from "../src/budget.js";
import { assistantLine, makeRepo, startLocalGui } from "./util.js";

const SESSION = JSON.stringify({ type: "session", version: 3, id: "x" });

// The dashboard tests read JSON responses the way gui-client's own getJson guard does; this
// keeps each call site to one line instead of the double-await fetch idiom.
async function getJson<T>(base: string, path: string): Promise<T> {
  return (await (await fetch(base + path)).json()) as T;
}

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
  const { server, base } = await startLocalGui(repo);
  try {
    const page = await (await fetch(base + "/")).text();
    assert.match(page, /<title>tumwater<\/title>/);

    const status = await getJson<
      ReturnType<typeof statusPayload> & {
        running: boolean;
        loops: Array<{ role: string; phase: string }>;
      }
    >(base, "/api/status");
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
  const { server, base } = await startLocalGui(repo);
  try {
    // No log yet: friendly empty state.
    const empty = await getJson<{ lines: string[] }>(base, "/api/transcript?role=feature");
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
    const ok = await getJson<{ lines: string[] }>(base, "/api/transcript?role=feature&n=10");
    assert.ok(ok.lines.some((l) => l.startsWith("── run @ ")));
    assert.ok(ok.lines.includes("  did the thing"));
    assert.ok(ok.lines.includes("→ read PLANS.md"));

    // Validation: unknown role, missing role, and bad n all → 400. Each 400 names the
    // offending value (or says it is required) so a client can tell which input was bad.
    for (const url of ["/api/transcript?role=nosuch", "/api/transcript", "/api/transcript?role=feature&n=abc", "/api/transcript?role=feature&n=0"]) {
      const res = await fetch(base + url);
      assert.equal(res.status, 400, url);
    }
    const unknownRole = await getJson<{ error: string }>(base, "/api/transcript?role=nosuch");
    assert.match(unknownRole.error, /unknown role "nosuch"/);
    const missingRole = await getJson<{ error: string }>(base, "/api/transcript");
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
  const { server, base } = await startLocalGui(repo);
  try {
    // The custom id is accepted and serves its transcript like any built-in's…
    const ok = await getJson<{ lines: string[] }>(base, "/api/transcript?role=nightly");
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
  assert.match(GUI_PAGE, /await postJson\("\/api\/prompt", \{ text \}\)/);
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

  const { server, base } = await startLocalGui(repo);
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
    const unknownFile = await getJson<{ error: string }>(base, "/api/backlog?file=notes&index=0");
    assert.match(unknownFile.error, /unknown file "notes"/);
    const missingFile = await getJson<{ error: string }>(base, "/api/backlog?index=0");
    assert.match(missingFile.error, /file required/);
    const outOfRange = await getJson<{ error: string }>(base, "/api/backlog?file=plans&index=2");
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
    const status = await getJson<{ plans: string[] }>(base, "/api/status");
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
  assert.match(GUI_PAGE, /await postJson\("\/api\/budget", \{ maxDailyCostUsd: value \}\)/);
  assert.match(GUI_PAGE, /await postJson\("\/api\/pause", \{ paused: target \}\)/);
  // The report panel surfaces the same message instead of a bare "unavailable".
  assert.match(GUI_PAGE, /report unavailable" \+ \(e && e\.message/);
});

test("apiError renders the operator-facing message for every error-body shape", async () => {
  // The guard above is pinned by source shape; this pins its BEHAVIOR — endpoint, HTTP
  // status, and the server's error text joined by the same separator — for every body shape
  // the server sends: JSON {error}, plain text (the 404's "not found"), and an empty body.
  // Extracted like the esc test: the client script's header region up to fmtTokens holds
  // esc/apiError/apiFetch/getJson/postJson, whose only external dependency is fetch.
  const { GUI_PAGE } = await import("../src/ui/gui-page.js");
  const script = GUI_PAGE.slice(GUI_PAGE.indexOf("<script>\n") + "<script>\n".length);
  const head = script.slice(0, script.indexOf("const fmtTokens"));
  let respond: (path: string, init?: unknown) => unknown = () => ({ ok: true, status: 200 });
  const fetchStub = (path: string, init: unknown) => respond(path, init);
  const { apiError, apiFetch, getJson } = new Function(
    "fetch",
    `${head}\nreturn { apiError, apiFetch, getJson };`,
  )(fetchStub) as {
    apiError: (path: string, r: { status: number; text: () => Promise<string> }) => Promise<Error>;
    apiFetch: (path: string, init?: unknown) => Promise<{ json: () => Promise<unknown> }>;
    getJson: (path: string) => Promise<unknown>;
  };

  // JSON {error} body — the common failure: the error text joins the endpoint and status.
  let err = await apiError("/api/budget", {
    status: 400,
    text: async () => '{"error":"maxDailyCostUsd must be a number of 0 or more"}',
  });
  assert.ok(err instanceof Error);
  assert.equal(err.message, "/api/budget failed: HTTP 400 — maxDailyCostUsd must be a number of 0 or more");

  // Plain text (the 404's "not found", or a proxy's HTML error page): the raw body surfaces
  // verbatim instead of being swallowed by the JSON parse.
  err = await apiError("/api/nope", { status: 404, text: async () => "not found" });
  assert.equal(err.message, "/api/nope failed: HTTP 404 — not found");
  err = await apiError("/api/status", { status: 502, text: async () => "<html>bad gateway</html>" });
  assert.equal(err.message, "/api/status failed: HTTP 502 — <html>bad gateway</html>");

  // Empty body: the status alone names the failure, with no dangling separator.
  err = await apiError("/api/status", { status: 500, text: async () => "   ", });
  assert.equal(err.message, "/api/status failed: HTTP 500");

  // apiFetch throws that message on a non-2xx and hands a 2xx response through — so
  // getJson never parses an error body as data.
  respond = () => ({ ok: false, status: 404, text: async () => "not found" });
  await assert.rejects(apiFetch("/api/backlog"), /\/api\/backlog failed: HTTP 404 — not found/);
  await assert.rejects(getJson("/api/backlog"), /HTTP 404/);
  const payload = { paused: false };
  respond = () => ({ ok: true, status: 200, json: async () => payload });
  assert.equal(await getJson("/api/status"), payload, "a 2xx response flows through to the caller");
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
  const { server, base } = await startLocalGui(repo);
  try {
    const res = await fetch(base + "/api/backlog?file=bugs&index=0");
    assert.equal(res.status, 200);
    const d = (await res.json()) as { title: string; body: string };
    assert.equal(d.body, "<img src=x onerror=alert(1)>", "the API serves the raw markdown body");
  } finally {
    server.close();
  }
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
