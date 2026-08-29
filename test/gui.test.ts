import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { statusPayload, startGui } from "../src/gui.js";
import { initProject } from "../src/init.js";
import { inboxSize } from "../src/inbox.js";
import { piLogPath } from "../src/paths.js";
import { freshLoopState, saveLoopState } from "../src/state.js";
import { assistantLine, makeRepo } from "./util.js";

const SESSION = JSON.stringify({ type: "session", version: 3, id: "x" });

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
  assert.match(GUI_PAGE, /<th>cost<\/th><th>last tick<\/th><th>last result<\/th>/);
  // The cell renders client-side from the payload's existing lastTickEndedAt field.
  assert.match(GUI_PAGE, /fmtLastTick\(l\.lastTickEndedAt\)/);
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
  // The #backlog panel gets an open questions section alongside plans/bugs…
  assert.match(GUI_PAGE, /backlogList\("open questions", d\.questions \|\| \[\]\)/);
  // …and the header badge derives its count from that same list, shown only when N > 0.
  assert.match(GUI_PAGE, /const qn = \(d\.questions \|\| \[\]\)\.length/);
  assert.match(GUI_PAGE, /\(qn \? " · questions: " \+ qn : ""\)/);
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
