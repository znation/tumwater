import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { submitPrompt } from "../src/inbox.js";
import { eventsLogPath, piLogPath } from "../src/paths.js";
import { expectedTimestamp } from "./oracles.js";
import { makeRepo } from "./repo-fixtures.js";
import { cli, spawnCli } from "./cli-harness.js";
import { assistantLine } from "./pi-events.js";
import { writeLogLines } from "./log-fixtures.js";

// The `logs` command family through the real CLI entry point: argument validation, the
// rendered per-role pi transcript, --prompt, and the -f follow mode (spawned with a live
// handle so the test can observe the initial window and newly appended entries). The
// --since/--grep half lives in cli-logs-filtering.test.ts. Split out of test/cli.test.ts,
// which grew past 1500 lines mixing every command family.

test("logs -n validates its value instead of misbehaving", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs validation");

  // Unvalidated, these made readEvents' slice(-limit) dump the whole log (NaN/0)
  // or drop leading lines (negative).
  for (const bad of ["abc", "0", "-5", "2.5"]) {
    const r = await cli(repo, "logs", "-n", bad);
    assert.equal(r.code, 1, `-n ${bad} should fail`);
    assert.match(r.stderr, /-n needs a positive integer/);
  }

  // A bare -n used to silently fall back to the default of 50.
  const noValue = await cli(repo, "logs", "-n");
  assert.equal(noValue.code, 1);
  assert.match(noValue.stderr, /-n needs a value/);

  // A valid -n still works.
  const ok = await cli(repo, "logs", "-n", "3");
  assert.equal(ok.code, 0);
});

// --- logs --json (the event feed as machine-readable NDJSON) ---

// Seed a chronological run of tick_start events directly (the -n view is newest-first).
function seedTickEvents(repo: string, count: number): void {
  const now = Date.now();
  const file = eventsLogPath(repo);
  const events = Array.from({ length: count }, (_, i) => ({
    ts: now - (count - i) * 1000,
    loop: "clean",
    type: "tick_start",
    tick: i + 1,
  }));
  writeLogLines(file, events);
}

test("logs -n --json prints exactly the raw stored events, in the text view's order, one JSON object per line", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs json dump");
  seedTickEvents(repo, 25);

  const r = await cli(repo, "logs", "-n", "20", "--json");
  assert.equal(r.code, 0);
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 20, r.stdout);
  // Each line parses as a JSON object with a type id and numeric ts — the canonical schema,
  // not a paraphrase — and the objects are byte-for-byte the ones stored in the log.
  const stored = fs.readFileSync(eventsLogPath(repo), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const [i, line] of lines.entries()) {
    const e = JSON.parse(line);
    assert.equal(e.type, "tick_start", line);
    assert.equal(typeof e.ts, "number", line);
    assert.ok(stored.some((s) => JSON.stringify(s) === JSON.stringify(e)), `line ${i} matches a stored event`);
  }
  // Log order — the last 20 of 25 events, chronological — exactly the order the text view
  // prints (readEvents returns the tail in file order, not reversed).
  const ticks = lines.map((l) => JSON.parse(l).tick);
  assert.deepEqual(ticks, Array.from({ length: 20 }, (_, i) => 6 + i));
  // No rendered prose may leak into the JSON stream.
  assert.ok(!r.stdout.includes("tick #"), r.stdout);
});

test("logs -f --json streams each newly landed event as a JSON line", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs json follow");
  seedTickEvents(repo, 2);

  const s = spawnCli(repo, ["logs", "-f", "--json"]);
  try {
    await s.waitFor((out) => out.includes('"tick":2'), "the initial window");

    // An event appended while following must stream as JSON, not rendered prose (500ms poll).
    const live = { ts: Date.now(), loop: "clean", type: "tick_start", tick: 99 };
    fs.appendFileSync(eventsLogPath(repo), JSON.stringify(live) + "\n");
    await s.waitFor((out) => out.includes('"tick":99'), "the live event as JSON");
    assert.ok(!s.out().includes("tick #99"), `rendered prose in JSON follow:\n${s.out()}`);
  } finally {
    s.kill();
  }
});

// --- logs --role (per-role pi transcript) ---

test("logs --role validates the role id and reports a missing transcript", async () => {
  const repo = makeRepo();
  await initProject(repo, "transcript cli test");

  let r = await cli(repo, "logs", "--role");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--role needs a role id/);

  r = await cli(repo, "logs", "--role", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus \(valid ids: feature, bugfix/);

  // A valid id whose loop never ran: friendly message, exit 0.
  r = await cli(repo, "logs", "--role", "clean");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no transcript yet for clean/);
});

// User-defined loops are valid --role targets for logs/reset-counters/abort once tumwater.json

test("logs --role prints the rendered pi transcript and -n limits entries", async () => {
  const repo = makeRepo();
  await initProject(repo, "transcript cli render test");
  const TS1 = 1787222691956;
  const TS2 = TS1 + 3_600_000;
  const file = piLogPath(repo, "clean");
  writeLogLines(file, [
      JSON.stringify({ type: "session", version: 3, id: "x" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "tick prompt one (must not appear)" }], timestamp: TS1 } }),
      JSON.stringify({ type: "message_update", delta: { type: "text_delta", textDelta: "streaming noise" } }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "look at the files first" },
            { type: "text", text: "Reading PLANS.md." },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "/repo/PLANS.md" } },
          ],
          stopReason: "stop",
        },
      }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "tick prompt two (must not appear)" }], timestamp: TS2 } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second run done" }], stopReason: "stop" } }),
    ]);

  let r = await cli(repo, "logs", "--role", "clean");
  assert.equal(r.code, 0);
  // Both runs render in order: separator stamped from the user message, then the turn.
  assert.ok(r.stdout.includes(`── run @ ${expectedTimestamp(TS1)} ──`), r.stdout);
  assert.ok(r.stdout.includes("· look at the files first"), r.stdout);
  assert.ok(r.stdout.includes("  Reading PLANS.md."), r.stdout);
  assert.ok(r.stdout.includes("→ read PLANS.md"), r.stdout);
  assert.ok(r.stdout.includes(`── run @ ${expectedTimestamp(TS2)} ──`), r.stdout);
  assert.ok(r.stdout.includes("  second run done"), r.stdout);
  // User prompts and streaming deltas never leak into the transcript.
  assert.ok(!r.stdout.includes("must not appear"));
  assert.ok(!r.stdout.includes("streaming noise"));

  // -n limits to the last N entries: only the second run's turn remains.
  r = await cli(repo, "logs", "--role", "clean", "-n", "1");
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes("Reading PLANS.md."), r.stdout);
  assert.ok(r.stdout.includes("  second run done"), r.stdout);
});

test("logs --role --prompt shows each run's exact prompt and -n limits to the newest", async () => {
  const repo = makeRepo();
  await initProject(repo, "transcript prompt test");
  const TS1 = 1787222691956;
  const TS2 = TS1 + 3_600_000;
  const file = piLogPath(repo, "clean");
  writeLogLines(file, [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "PROMPT ONE\nsecond line" }], timestamp: TS1 } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "turn one" }] } }),
      JSON.stringify({ type: "agent_start" }),
      // The newest run has no assistant turn yet: with --prompt the newest entry is its prompt.
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "PROMPT TWO" }], timestamp: TS2 } }),
    ]);
  let r = await cli(repo, "logs", "--role", "clean", "--prompt");
  assert.equal(r.code, 0);
  // Each prompt lands under its run separator and before that run's assistant turn, verbatim.
  const one = r.stdout.indexOf("PROMPT ONE\nsecond line");
  assert.ok(one > -1, r.stdout);
  assert.ok(r.stdout.indexOf(`── run @ ${expectedTimestamp(TS1)} ──`) < one, r.stdout);
  assert.ok(one < r.stdout.indexOf("  turn one"), r.stdout);
  assert.ok(r.stdout.includes(`── run @ ${expectedTimestamp(TS2)} ──`), r.stdout);
  assert.ok(r.stdout.includes("PROMPT TWO"), r.stdout);

  // -n counts a prompt as one entry: only the newest run's prompt remains.
  r = await cli(repo, "logs", "--role", "clean", "--prompt", "-n", "1");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("PROMPT TWO"), r.stdout);
  assert.ok(!r.stdout.includes("PROMPT ONE"), r.stdout);
  assert.ok(!r.stdout.includes("  turn one"), r.stdout);

  // --prompt is meaningless without --role.
  r = await cli(repo, "logs", "--prompt");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /logs --prompt needs --role <id>/);
});

test("logs --role still reads a transcript when tumwater.json is broken", async () => {
  // The read-only transcript view needs the config only to accept user-defined loop ids, so a
  // torn/mid-edit tumwater.json must not take it down: it falls back to the built-in catalog,
  // the same policy the GUI's transcript handler applies. Before that fallback, loadConfig threw
  // and the whole command exited 1 with the config error.
  const repo = makeRepo();
  await initProject(repo, "broken config transcript test");
  fs.writeFileSync(path.join(repo, "tumwater.json"), "{ not json");
  const file = piLogPath(repo, "clean");
  writeLogLines(file, [JSON.stringify({ type: "agent_start" }), assistantLine("readable anyway")]);

  const r = await cli(repo, "logs", "--role", "clean");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("readable anyway"), r.stdout);

  // The fallback relaxes the config READ, not the id validation: an unknown id is still refused.
  const bad = await cli(repo, "logs", "--role", "nope");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown role/);
});

// --- logs -f: the follow half of both log commands is only reachable with a live child ---

test("logs -f prints the current window and follows newly appended events", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs follow");

  // Seed one real event through the same path the TUI/GUI/CLI use.
  submitPrompt(repo, "first prompt");

  const s = spawnCli(repo, ["logs", "-f"]);
  try {
    await s.waitFor((out) => out.includes("user prompt queued: first prompt"), "the seeded event");

    // A new event appended while following must appear without a restart (500ms poll).
    submitPrompt(repo, "second prompt");
    await s.waitFor((out) => out.includes("user prompt queued: second prompt"), "the live event");
  } finally {
    s.kill();
  }
});

test("logs --role -f prints each turn exactly once across the initial window and follow", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli transcript follow");

  // One completed run on disk; a second is appended while following.
  const file = piLogPath(repo, "clean");
  writeLogLines(file, [JSON.stringify({ type: "session", version: 3, id: "x" }), assistantLine("first turn text")]);

  const s = spawnCli(repo, ["logs", "--role", "clean", "-f"]);
  try {
    await s.waitFor((out) => out.includes("first turn text"), "the initial window");

    fs.appendFileSync(file, assistantLine("second turn text") + "\n");
    await s.waitFor((out) => out.includes("second turn text"), "the live turn");

    // The follow renderer starts fresh at the window's end: a regression that re-fed the
    // initial lines would print the first turn twice.
    const out = s.out();
    assert.equal(out.split("first turn text").length - 1, 1, `first turn printed once:\n${out}`);
    assert.equal(out.split("second turn text").length - 1, 1, `second turn printed once:\n${out}`);
  } finally {
    s.kill();
  }
});


