import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type os from "node:os";
import net from "node:net";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config.js";
import { lanAddresses, statusPayload, startGui } from "../src/gui.js";
import { initProject } from "../src/init.js";
import { dequeuePrompt, inboxSize, submitPrompt } from "../src/inbox.js";
import { orchestratorStatePath, piLogPath } from "../src/paths.js";
import { freshLoopState, saveLoopState, todayStamp } from "../src/state.js";
import { assistantLine, makeRepo } from "./util.js";

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
    }
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

    // Validation: unknown role, missing role, and bad n all → 400.
    for (const url of ["/api/transcript?role=nosuch", "/api/transcript", "/api/transcript?role=feature&n=abc", "/api/transcript?role=feature&n=0"]) {
      const res = await fetch(base + url);
      assert.equal(res.status, 400, url);
    }
  } finally {
    server.close();
  }
});

test("the dashboard page's inline script is syntactically valid JavaScript", async () => {
  // Regression: the page is authored inside a TS template literal, where a bare \n becomes a
  // REAL newline in the served page — splitting the page's own string literals and killing the
  // whole script with a syntax error ("Unexpected EOF"). Parse every <script> body for real.
  const { GUI_PAGE } = await import("../src/gui-page.js");
  const scripts = [...GUI_PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
  assert.ok(scripts.length >= 1, "page has an inline script");
  for (const body of scripts) {
    assert.doesNotThrow(() => new Function(body), "inline script must parse");
  }
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
    [
      SESSION,
      assistantLine("turn one", { tokens: 8_000, output: 300 }),
      assistantLine("turn two", { tokens: 12_000, output: 500 }),
    ].join("\n") + "\n",
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
  const { GUI_PAGE } = await import("../src/gui-page.js");
  assert.match(GUI_PAGE, /<th>state<\/th><th>current<\/th>/);
});

test("the dashboard page has a last tick column between cost and last result", async () => {
  const { GUI_PAGE } = await import("../src/gui-page.js");
  // The per-loop today-spend column (PLANS.md "Per-loop today spend") landed between cost and
  // last tick, so the header order now pins all four cells at once.
  assert.match(GUI_PAGE, /<th>cost<\/th><th>today<\/th><th>last tick<\/th><th>last result<\/th>/);
  // The cell renders client-side from the payload's existing lastTickEndedAt field.
  assert.match(GUI_PAGE, /fmtLastTick\(l\.lastTickEndedAt\)/);
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
  const { GUI_PAGE } = await import("../src/gui-page.js");
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
  const { GUI_PAGE } = await import("../src/gui-page.js");
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
  const { GUI_PAGE } = await import("../src/gui-page.js");
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
  const { GUI_PAGE } = await import("../src/gui-page.js");
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
  const { GUI_PAGE } = await import("../src/gui-page.js");
  // Each entry line is an <a> carrying its file and zero-based index…
  assert.match(GUI_PAGE, /class='backloglink/);
  assert.match(GUI_PAGE, /data-file='/);
  assert.match(GUI_PAGE, /data-index='/);
  // …clicking one fetches the on-demand endpoint into the detail panel (the same #transcript
  // panel loop transcripts use — mutual exclusion is pinned by the click handlers below).
  assert.match(GUI_PAGE, /\/api\/backlog\?file=/);
  assert.match(GUI_PAGE, /a\.backloglink/);
  // The `?` must stay escaped: unescaped it is a quantifier on the preceding space and
  // the pattern can never match the page's literal "key ? null" text.
  assert.match(GUI_PAGE, /backlogKey = backlogKey === key \? null : key/);
});

// The daily cost budget on the GUI surface (plans/daily-cost-budget.md): /api/status carries
// `budget` while enabled and null when disabled, the page derives its header badge from it,
// and a paused fleet's idle role loops read `budget paused` in their phase payload.

test("status payload carries the daily budget while enabled and null when disabled", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui budget test"); // defaultConfig: maxDailyCostUsd 50 (enabled)
  let payload = statusPayload(repo) as { budget: { spentUsd: number; capUsd: number } | null };
  assert.deepEqual(payload.budget, { spentUsd: 0, capUsd: 50 }, "enabled by default with no spend yet");

  // Today's spend is summed from the loops' persisted daily windows (a stale stamp reads $0).
  const s = freshLoopState("clean");
  s.dayStamp = todayStamp();
  s.dayCostUsd = 12.34;
  saveLoopState(repo, s);
  payload = statusPayload(repo) as typeof payload;
  assert.equal(payload.budget?.spentUsd, 12.34, "today's spend shows in the badge data");

  // 0 disables: the badge data disappears entirely (the page renders no badge for null).
  const cfg = loadConfig(repo);
  cfg.maxDailyCostUsd = 0;
  saveConfig(repo, cfg);
  payload = statusPayload(repo) as typeof payload;
  assert.equal(payload.budget, null, "cap 0 disables the budget");
});

test("the dashboard page derives its header badge from the payload's budget", async () => {
  const { GUI_PAGE } = await import("../src/gui-page.js");
  // Standing while enabled (payload sends an object), absent when disabled (null).
  assert.match(
    GUI_PAGE,
    /d\.budget \? " · budget: \$" \+ d\.budget\.spentUsd\.toFixed\(2\) \+ "\/\$" \+ fmtUsdCap\(d\.budget\.capUsd\) \+ " today"/,
  );
  // The cap uses the same whole-dollars-bare rule as the TUI's usdCap ($50, not $50.00), so
  // both dashboards read identically for one config.
  assert.match(GUI_PAGE, /const fmtUsdCap = \(n\) => n\.toFixed\(2\)\.replace\(\/\\\.00\$\/, ""\);/);
  // Exercise the rule itself, not just its presence: pull the helper out of the page and run
  // it — whole dollars stay bare, fractional caps keep their cents.
  const m = GUI_PAGE.match(/const fmtUsdCap = \((\w+)\) => ([^;]+);/);
  assert.ok(m, "fmtUsdCap definition found in the page");
  const fmtUsdCap = new Function(m[1]!, `return (${m[2]});`) as (n: number) => string;
  assert.equal(fmtUsdCap(50), "50", "whole dollars stay bare");
  assert.equal(fmtUsdCap(12.34), "12.34", "fractional caps keep their cents");
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
