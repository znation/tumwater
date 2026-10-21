import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { HarnessEvent } from "../src/events/events.js";
import { initProject } from "../src/init/init.js";
import { runRows, readRunRowsSince } from "../src/history/history-data.js";
import { SPARSE_WINDOW_NOTE } from "../src/events/event-window.js";
import { writeEvents, writeLogLines } from "./fixtures/log-fixtures.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { enqueueRolePrompt, inboxSize, queuedRolePromptRecords, queuedRolePrompts } from "../src/inbox/inbox.js";
import { readEvents } from "../src/events/event-read.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { MAX_BODY_BYTES } from "../src/gui/http-body.js";
import { postJson, startLocalGui } from "./fixtures/gui-fixtures.js";
import { piLogPath } from "../src/paths.js";
import { makeRepo, sh } from "./fixtures/repo-fixtures.js";

// The dashboard transport's JSON read/write routes under live use: /api/status, the
// prompt-cancel POST, and the read endpoints (history, run) that serve the collectors'
// own payloads. Extracted from the former gui-server.test.ts (2026-10-12), whose
// transport file covers hostile
// input and whose lifecycle file covers reload and post-listen errors.

test("/api/status exposes each role's nextRunAt and backoffSeconds", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui schedule test");
  const state = freshRunnerState("clean");
  state.nextRunAt = 1_758_800_000_000;
  state.backoffSeconds = 90;
  saveRunnerState(repo, state);
  const { server, base } = await startLocalGui(repo);
  try {
    const status = (await (await fetch(base + "/api/status")).json()) as {
      roles: Array<{ role: string; nextRunAt: number; backoffSeconds: number }>;
    };
    const clean = status.roles.find((l) => l.role === "clean");
    assert.ok(clean, "the role has a payload row");
    assert.equal(clean.nextRunAt, 1_758_800_000_000, "raw epoch ms — the GUI formats it client-side");
    assert.equal(clean.backoffSeconds, 90);
  } finally {
    server.close();
  }
});

// The per-role prompt endpoint sits behind the same body cap as /api/prompt: an oversized
// body is the client's 413, and the server stays healthy and accepts normal prompts after.
test("gui rejects oversized prompt-role bodies with 413 and stays healthy", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui prompt-role body limit test");
  const { server, base } = await startLocalGui(repo);
  try {
    const huge = JSON.stringify({ role: "clean", text: "x".repeat(MAX_BODY_BYTES) });
    const res = await fetch(base + "/api/prompt-role", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: huge,
    });
    assert.equal(res.status, 413);
    assert.match(await res.text(), /body too large/);

    const ok = await postJson(base, "/api/prompt-role", { role: "clean", text: "still alive" });
    assert.equal(ok.status, 200);
    assert.deepEqual(queuedRolePrompts(repo, "clean"), ["still alive"]);
  } finally {
    server.close();
  }
});

// The queued-prompts rows' cancel affordance: POST /api/prompt-cancel removes exactly the
// prompt its queue file names — the file-addressed twin of the CLI's position-based
// `prompt --cancel`, so a 1 s-stale poll can never cancel the wrong entry.
test("gui /api/prompt-cancel removes one queued prompt by file, answers gone on a race", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui prompt-cancel test");
  const { server, base } = await startLocalGui(repo);
  try {
    const first = enqueueRolePrompt(repo, DIRECTOR_ROLE, "first prompt");
    const second = enqueueRolePrompt(repo, DIRECTOR_ROLE, "second prompt");
    const clean = enqueueRolePrompt(repo, "clean", "clean prompt");
    const post = (payload: unknown) => postJson(base, "/api/prompt-cancel", payload);

    // Cancelling by file removes exactly that file, logs one prompt_cancelled event under
    // the director, and answers the preview for the flash line.
    let res = await post({ file: path.basename(first) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, status: "cancelled", preview: "first prompt" });
    assert.equal(inboxSize(repo), 1);
    assert.deepEqual(queuedRolePrompts(repo, DIRECTOR_ROLE), ["second prompt"]);
    assert.deepEqual(queuedRolePrompts(repo, "clean"), ["clean prompt"], "other queues untouched");
    const cancelled = readEvents(repo).filter((e) => e.type === "prompt_cancelled");
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0]!.source, DIRECTOR_ROLE);
    assert.equal(cancelled[0]!.preview, "first prompt");

    // Re-cancelling the same file — or one the role already dequeued — is "gone" (200),
    // data for the flash line, not a 500; and it logs no second event, removes nothing else.
    res = await post({ file: path.basename(first) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, status: "gone" });
    assert.equal(inboxSize(repo), 1);
    assert.equal(readEvents(repo).filter((e) => e.type === "prompt_cancelled").length, 1);

    // A role-scoped cancel targets that role's own queue (role given explicitly).
    res = await post({ role: "clean", file: path.basename(clean) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, status: "cancelled", preview: "clean prompt" });
    assert.deepEqual(queuedRolePrompts(repo, "clean"), []);
    assert.equal(readEvents(repo).filter((e) => e.type === "prompt_cancelled").length, 2);
    assert.equal(readEvents(repo).filter((e) => e.type === "prompt_cancelled" && e.source === "clean").length, 1);

    // A hostile or malformed file name is a user-input error: 400, nothing touched on disk.
    // "a\u0000.md" is the shape that once reached the fs layer and answered a 500: a NUL
    // byte is no character a filename can hold, so the fs call throws a non-ENOENT error
    // instead of the "gone" path — the guard must reject it before anything touches disk.
    for (const file of ["../escape.md", "a/b.md", "a\\b.md", "..", "a\u0000.md", "not-a-prompt.txt", "", undefined]) {
      res = await post({ file });
      assert.equal(res.status, 400, `file ${JSON.stringify(file)} rejected`);
      assert.match(await res.text(), /file/);
    }
    assert.equal(inboxSize(repo), 1, "the second director prompt survived every rejection");

    // An unknown role is the shared rejectBadRole 400, like /api/transcript.
    res = await post({ role: "nope", file: path.basename(second) });
    assert.equal(res.status, 400);
    // The error is a JSON body, so the id's quotes come back escaped.
    assert.match(await res.text(), /unknown role \\"nope\\"/);
    assert.equal(inboxSize(repo), 1);

    // A non-object body rides the shared readJsonObject 400.
    res = await fetch(base + "/api/prompt-cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[1,2]",
    });
    assert.equal(res.status, 400);
    assert.equal(inboxSize(repo), 1);
  } finally {
    server.close();
  }
});

// The queued-prompts rows' Move to top affordance: POST /api/prompt-top reorders exactly the
// prompt its queue file names to the head of its role's queue — the file-addressed twin of the
// CLI's position-based `prompt --top <n>`, so a 1 s-stale poll can never reorder the wrong
// entry. The head answers already_first, and a hostile name is the guard's 400.
test("gui /api/prompt-top moves one queued prompt to its role's queue head", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui prompt-top test");
  const { server, base } = await startLocalGui(repo);
  try {
    const first = enqueueRolePrompt(repo, DIRECTOR_ROLE, "first prompt");
    const second = enqueueRolePrompt(repo, DIRECTOR_ROLE, "second prompt");
    const clean = enqueueRolePrompt(repo, "clean", "clean prompt");
    const post = (payload: unknown) => postJson(base, "/api/prompt-top", payload);

    // Moving the second director prompt to the head answers topped, and a status read shows
    // it first in its role's queue while the other queues are untouched.
    let res = await post({ file: path.basename(second) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, status: "topped", preview: "second prompt" });
    assert.deepEqual(queuedRolePrompts(repo, DIRECTOR_ROLE), ["second prompt", "first prompt"]);
    assert.deepEqual(queuedRolePrompts(repo, "clean"), ["clean prompt"], "other queues untouched");

    // The queue head answers already_first with no write.
    res = await post({ file: path.basename(queuedRolePromptRecords(repo, DIRECTOR_ROLE)[0]!.file) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, status: "already_first" });
    assert.deepEqual(queuedRolePrompts(repo, DIRECTOR_ROLE), ["second prompt", "first prompt"]);

    // A hostile or malformed name, and an unknown role, are 400s leaving the queue unchanged.
    for (const file of ["../escape.md", "a/b.md", "not-a-prompt.txt", "", undefined]) {
      res = await post({ file });
      assert.equal(res.status, 400, `file ${JSON.stringify(file)} rejected`);
      assert.match(await res.text(), /file/);
    }
    res = await post({ role: "nope", file: path.basename(first) });
    assert.equal(res.status, 400);
    assert.equal(queuedRolePrompts(repo, DIRECTOR_ROLE).length, 2, "the queue survived every rejection");

    // An absent role targets the director (matching /api/prompt-cancel).
    res = await post({ role: "clean", file: path.basename(clean) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, status: "already_first" });
  } finally {
    server.close();
  }
});

// The interleaved event seed /api/history and /api/run both read: one run with a paired
// start (its duration comes from the pair), one end-only skipped run (no start, so no
// fabricated duration), and a merged event that runRows must ignore.
function historySeedEvents(): HarnessEvent[] {
  return [
    { ts: 1_000, source: "feature", type: "run_start", run: 1 } as HarnessEvent,
    { ts: 46_000, source: "feature", type: "run_end", run: 1, result: "changed", summary: "tidy up", tokens: 500, costUsd: 0.25 } as HarnessEvent,
    { ts: 47_000, source: "steward", type: "merged", commit: "abc", summary: "unrelated" } as HarnessEvent,
    { ts: 48_000, source: "clean", type: "run_end", run: 7, result: "no_change" } as HarnessEvent,
    { ts: 49_000, source: "feature", type: "run_end", run: 2, result: "skipped" } as HarnessEvent,
    { ts: 50_000, source: "clean", type: "run_start", run: 9 } as HarnessEvent,
    { ts: 96_000, source: "clean", type: "run_end", run: 9, result: "changed", summary: "sorted imports" } as HarnessEvent,
  ];
}

test("gui /api/history serves runRows' JSON with role filtering and n clamped, not errored", async () => {
  const repo = makeRepo();
  await initProject(repo, "history api test");
  const events = historySeedEvents();
  writeEvents(repo, events);

  const { server, base } = await startLocalGui(repo);
  try {
    // Default window: the JSON equals what `tumwater history` derives for the same window —
    // runRows over the same seed, newest first, durations from run_start pairs, null when
    // the start is outside the window.
    const res = await fetch(base + "/api/history");
    assert.equal(res.status, 200);
    const d = (await res.json()) as { rows: ReturnType<typeof runRows> };
    assert.deepEqual(d, { rows: runRows(events, 20, null) });
    assert.deepEqual(d.rows.map((r) => [r.role, r.run]), [["clean", 9], ["feature", 2], ["clean", 7], ["feature", 1]], "newest first");
    assert.equal(d.rows[0]!.durationMs, 46_000, "duration pairs the run's own run_start");
    assert.equal(d.rows[1]!.durationMs, null, "a skipped run's end claims no duration");

    // role filters to that role's rows (a filter is not a target: an id with no runs is a
    // legitimate empty result, not an error — no config validation).
    const scoped = await (await fetch(base + "/api/history?role=clean")).json();
    assert.deepEqual(scoped, { rows: runRows(events, 20, "clean") });
    const none = await fetch(base + "/api/history?role=nosuchloop");
    assert.equal(none.status, 200);
    assert.deepEqual(await none.json(), { rows: [] });

    // n: absent → 20; present but not a plain non-negative integer → 400 (the handleBacklog
    // index discipline); present and parseable → clamped to [1, 200], never errored.
    assert.deepEqual(await (await fetch(base + "/api/history?n=500")).json(), { rows: runRows(events, 200, null) });
    const one = await (await fetch(base + "/api/history?n=0")).json();
    assert.deepEqual(one, { rows: runRows(events, 1, null) }, "n=0 clamps up to 1");
    for (const bad of ["abc", "-5", "1e3", "0x10", "%207", ""]) {
      const r = await fetch(base + "/api/history?n=" + bad);
      assert.equal(r.status, 400, `n=${bad} → 400 (a non-count is a client error, unlike days)`);
      const body = (await r.json()) as { error: string };
      assert.match(body.error, /n must be a non-negative integer/);
    }

    // sinceMs: the trailing-window shape. Its seed (1970) sits entirely before any trailing
    // window, so the rows are empty over a covered window and the note is absent.
    assert.deepEqual(await (await fetch(base + "/api/history?sinceMs=604800000")).json(), { rows: [], covered: true, note: "" });
    assert.deepEqual(await (await fetch(base + "/api/history?sinceMs=1")).json(), { rows: [], covered: true, note: "" });
    assert.deepEqual(await (await fetch(base + "/api/history?sinceMs=604800000&role=clean")).json(), { rows: [], covered: true, note: "" }, "role composes with the window");
    // A count and a window are rival shapes (the CLI's rule), sinceMs must parse positive, and
    // it is capped at the shared `history --since` bound.
    const rival = await fetch(base + "/api/history?sinceMs=3600000&n=20");
    assert.equal(rival.status, 400, "sinceMs and n are rivals");
    assert.match(((await rival.json()) as { error: string }).error, /sinceMs cannot be combined with n/);
    const badSince = await fetch(base + "/api/history?sinceMs=abc");
    assert.equal(badSince.status, 400);
    assert.match(((await badSince.json()) as { error: string }).error, /sinceMs must be a positive integer/);
    const overCap = await fetch(base + "/api/history?sinceMs=604800001");
    assert.equal(overCap.status, 400, "above LOGS_SINCE_MAX_MS → 400");
    assert.match(((await overCap.json()) as { error: string }).error, /sinceMs is capped at 7d/);
  } finally {
    server.close();
  }
});

test("gui /api/history serves a trailing window from readRunRowsSince with its coverage note", async () => {
  const repo = makeRepo();
  await initProject(repo, "history since api test");
  const base = Date.now();
  const t = (mins: number) => base - mins * 60_000;
  const events: HarnessEvent[] = [
    { ts: t(30), source: "clean", type: "run_start", run: 9 } as HarnessEvent,
    { ts: t(10), source: "clean", type: "run_end", run: 9, result: "changed", summary: "sorted imports" } as HarnessEvent,
    { ts: t(5), source: "feature", type: "run_end", run: 1, result: "changed", summary: "later work" } as HarnessEvent,
  ];
  writeEvents(repo, events);
  const { server, base: url } = await startLocalGui(repo);
  try {
    // The window's rows come from the same collector as `tumwater history --since`.
    const all = (await (await fetch(url + "/api/history?sinceMs=7200000")).json()) as { rows: { role: string; run: number }[]; covered: boolean; note: string };
    assert.deepEqual(all.rows, readRunRowsSince(repo, 7_200_000, null).rows);
    assert.deepEqual(all.rows.map((r) => [r.role, r.run]), [["feature", 1], ["clean", 9]], "newest first");
    // The log starts inside the window, so coverage cannot be proven and the shared note rides.
    assert.equal(all.covered, false);
    assert.equal(all.note, SPARSE_WINDOW_NOTE);
    // role composes with the window; a window narrower than every event holds none.
    const clean = (await (await fetch(url + "/api/history?sinceMs=7200000&role=clean")).json()) as { rows: { role: string }[] };
    assert.deepEqual(clean.rows, readRunRowsSince(repo, 7_200_000, "clean").rows);
    assert.deepEqual(clean.rows.map((r) => r.role), ["clean"]);
    const tiny = await (await fetch(url + "/api/history?sinceMs=1")).json();
    assert.deepEqual((tiny as { rows: unknown[] }).rows, []);
  } finally {
    server.close();
  }
});

test("gui /api/history?grep filters through the CLI's shared haystack rule after the scan", async () => {
  const repo = makeRepo();
  await initProject(repo, "history grep api test");
  const events = historySeedEvents();
  writeEvents(repo, events);

  const { server, base } = await startLocalGui(repo);
  try {
    // A pattern matching one seeded row returns only it, case-insensitively, through the same
    // canonical row line `tumwater history --grep` filters.
    const one = (await (await fetch(base + "/api/history?grep=" + encodeURIComponent("SORTED IMPORTS"))).json()) as { rows: { role: string; run: number }[] };
    assert.deepEqual(one.rows.map((r) => [r.role, r.run]), [["clean", 9]]);
    // A pattern matching none is an empty row set, never prose or an error.
    assert.deepEqual(await (await fetch(base + "/api/history?grep=" + encodeURIComponent("no such text"))).json(), { rows: [] });
    // An empty pattern filters nothing.
    assert.deepEqual(await (await fetch(base + "/api/history?grep=")).json(), { rows: runRows(events, 20, null) });
    // role and grep compose.
    const scoped = (await (await fetch(base + "/api/history?role=feature&grep=" + encodeURIComponent("sorted"))).json()) as { rows: unknown[] };
    assert.deepEqual(scoped.rows, []);
    // n bounds the scanned window first: the newest row is clean#9, so feature#1's detail is
    // outside the scan even though the retained log holds it — the CLI's -n rule.
    assert.deepEqual(await (await fetch(base + "/api/history?n=1&grep=" + encodeURIComponent("tidy up"))).json(), { rows: [] });
    const wide = (await (await fetch(base + "/api/history?grep=" + encodeURIComponent("tidy up"))).json()) as { rows: { role: string; run: number }[] };
    assert.deepEqual(wide.rows.map((r) => [r.role, r.run]), [["feature", 1]]);
  } finally {
    server.close();
  }
});

test("gui /api/run serves one run's detail over the live route, 404 when the scan misses", async () => {
  const repo = makeRepo();
  await initProject(repo, "run api test");
  // The same seed the /api/history test uses: clean#9 is paired, feature#2 is end-only.
  const events = historySeedEvents();
  writeEvents(repo, events);

  const { server, base } = await startLocalGui(repo);
  try {
    // The paired run answers the collector's payload plus the pre-rendered text.
    const res = await fetch(base + "/api/run?role=clean&run=9");
    assert.equal(res.status, 200);
    const d = (await res.json()) as { role: string; run: number; durationMs: number | null; events: { type: string }[]; text: string };
    assert.equal(d.role, "clean");
    assert.equal(d.run, 9);
    assert.equal(d.durationMs, 46_000);
    assert.deepEqual(d.events.map((e) => e.type), ["run_start", "run_end"]);
    assert.match(d.text, /^clean run #9 — merged · 46s/);

    // A run the scan does not hold → 404 (never a crash); a bad role and a non-count run →
    // the shared 400s.
    const missing = await fetch(base + "/api/run?role=clean&run=42");
    assert.equal(missing.status, 404);
    assert.match(((await missing.json()) as { error: string }).error, /no run #42 for clean/);
    assert.equal((await fetch(base + "/api/run?role=nope&run=9")).status, 400);
    assert.equal((await fetch(base + "/api/run?role=clean&run=0")).status, 400);
    assert.equal((await fetch(base + "/api/run")).status, 400, "no role and no run → 400");
  } finally {
    server.close();
  }
});

test("gui /api/run carries revertSha only for a run whose commit is on main", async () => {
  const repo = makeRepo();
  await initProject(repo, "revert sha api test");
  const onMain = sh(repo, "git", "rev-parse", "HEAD");
  writeEvents(repo, [
    { ts: 1000, source: "clean", type: "run_start", run: 1 },
    { ts: 1100, source: "clean", type: "merge_done", run: 1, commit: onMain },
    { ts: 1200, source: "clean", type: "run_end", run: 1, result: "merged" },
    { ts: 2000, source: "clean", type: "run_start", run: 2 },
    { ts: 2100, source: "clean", type: "merge_done", run: 2, commit: "0".repeat(40) },
    { ts: 2200, source: "clean", type: "run_end", run: 2, result: "merged" },
  ]);
  const { server, base } = await startLocalGui(repo);
  try {
    const on = (await (await fetch(base + "/api/run?role=clean&run=1")).json()) as { revertSha: string | null };
    assert.equal(on.revertSha, onMain);
    const off = (await (await fetch(base + "/api/run?role=clean&run=2")).json()) as { revertSha: string | null };
    assert.equal(off.revertSha, null);
  } finally {
    server.close();
  }
});

test("gui /api/run carries hasCommit, and the patch only on request", async () => {
  const repo = makeRepo();
  await initProject(repo, "patch api test");
  const onMain = sh(repo, "git", "rev-parse", "HEAD");
  writeEvents(repo, [
    { ts: 1000, source: "clean", type: "run_start", run: 1 },
    { ts: 1100, source: "clean", type: "merge_done", run: 1, commit: onMain },
    { ts: 1200, source: "clean", type: "run_end", run: 1, result: "merged" },
    { ts: 2000, source: "clean", type: "run_start", run: 2 },
    { ts: 2200, source: "clean", type: "run_end", run: 2, result: "no_change" },
  ]);
  const { server, base } = await startLocalGui(repo);
  try {
    const get = async (u: string) => (await (await fetch(base + u)).json()) as { hasCommit: boolean; patch?: string };
    const plain = await get("/api/run?role=clean&run=1");
    assert.equal(plain.hasCommit, true);
    assert.equal("patch" in plain, false);
    assert.match((await get("/api/run?role=clean&run=1&patch=1")).patch ?? "", /diff --git/);
    const none = await get("/api/run?role=clean&run=2");
    assert.equal(none.hasCommit, false);
    assert.equal((await get("/api/run?role=clean&run=2&patch=1")).patch, "(no commit: this run sent nothing to merge)");
  } finally {
    server.close();
  }
});

test("gui /api/run carries the run's transcript only on request", async () => {
  const repo = makeRepo();
  await initProject(repo, "transcript api test");
  writeEvents(repo, [
    { ts: 1000, source: "clean", type: "run_start", run: 1 },
    { ts: 2000, source: "clean", type: "run_end", run: 1, result: "no_change" },
    { ts: 3000, source: "clean", type: "run_start", run: 2 },
    { ts: 4000, source: "clean", type: "run_end", run: 2, result: "no_change" },
  ]);
  writeLogLines(piLogPath(repo, "clean"), [
    { type: "tumwater_run", kind: "author", agent: "pi", ts: 1500 },
    { type: "agent_start" },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "asked-one" }], timestamp: 1500 } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "said-one" }], timestamp: 1500 } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "other-one" }], timestamp: 1500 } },
  ]);
  const { server, base } = await startLocalGui(repo);
  try {
    const get = async (u: string) => (await (await fetch(base + u)).json()) as { transcript?: string };
    assert.equal("transcript" in (await get("/api/run?role=clean&run=1")), false);
    const plain = (await get("/api/run?role=clean&run=1&transcript=1")).transcript ?? "";
    assert.match(plain, /said-one/);
    assert.doesNotMatch(plain, /asked-one/);
    const withPrompt = (await get("/api/run?role=clean&run=1&transcript=1&prompt=1")).transcript ?? "";
    assert.match(withPrompt, /asked-one[\s\S]*said-one/);
    assert.equal("transcript" in (await get("/api/run?role=clean&run=1&prompt=1")), false);
    const hit = (await get("/api/run?role=clean&run=1&transcript=1&grep=SAID")).transcript ?? "";
    assert.match(hit, /said-one/);
    assert.doesNotMatch(hit, /other-one/);
    assert.equal((await get("/api/run?role=clean&run=1&transcript=1&grep=nomatch")).transcript, '(no transcript entries matching "nomatch" in clean run 1)');
    const blank = (await get("/api/run?role=clean&run=1&transcript=1&grep=%20%20")).transcript ?? "";
    assert.match(blank, /said-one/);
    assert.match(blank, /other-one/);
    assert.equal("transcript" in (await get("/api/run?role=clean&run=1&grep=said")), false);
    assert.ok((await get("/api/run?role=clean&run=2&transcript=1")).transcript?.startsWith("(no transcript for clean run 2: "));
  } finally {
    server.close();
  }
});

test("gui /api/history grows its role-filtered scan window until it reaches the role's runs", async () => {
  // The dilution case the CLI's `history --role` fix pinned: the first window (n*2+50 events)
  // fills with a busy sibling role's run_ends, so the filtered rows fall short while the
  // role's older runs sit just past it. The endpoint must grow the scan like cmdHistory,
  // not return fewer rows (or an empty set) for a role the retained log covers.
  const repo = makeRepo();
  await initProject(repo, "history api dilution");
  const events: HarnessEvent[] = [];
  for (let i = 0; i < 5; i++) events.push({ ts: 1000 + i, source: "qa", type: "run_end", run: i + 1, result: "changed", summary: `qa fix ${i}` });
  for (let i = 0; i < 60; i++) events.push({ ts: 2000 + i, source: "clean", type: "run_end", run: i + 1, result: "no_change" });
  writeEvents(repo, events);
  const { server, base } = await startLocalGui(repo);
  try {
    const d = (await (await fetch(base + "/api/history?role=qa&n=5")).json()) as { rows: { role: string; run: number }[] };
    assert.deepEqual(d.rows.map((r) => [r.role, r.run]), [["qa", 5], ["qa", 4], ["qa", 3], ["qa", 2], ["qa", 1]], "all 5 qa rows despite the diluting sibling");
    // The honest shortfall: the log holds fewer qa runs than asked and the scan reached the
    // log's start — what exists is returned, not an error or a hang.
    const short = (await (await fetch(base + "/api/history?role=qa&n=10")).json()) as { rows: unknown[] };
    assert.equal(short.rows.length, 5);
  } finally {
    server.close();
  }
});

test("gui /api/history serves an empty row set when the event log is missing, and the page carries the history tab", async () => {
  const repo = makeRepo();
  await initProject(repo, "history empty test");
  // No events.jsonl seeded — the endpoint reads files directly, so it serves with no team
  // running and no log at all: an empty row set, never a 500.
  const { server, base } = await startLocalGui(repo);
  try {
    const res = await fetch(base + "/api/history");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { rows: [] });

    // The page carries the History view's sidebar link and its hidden view container.
    const page = await (await fetch(base + "/")).text();
    assert.match(page, /href="#history" id="tab-history"/);
    assert.match(page, /<section id="history" class="view"[^>]*hidden>/);
  } finally {
    server.close();
  }
});

