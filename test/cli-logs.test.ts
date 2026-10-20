import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { submitPrompt } from "../src/inbox/inbox-submit.js";
import { eventsLogPath, piLogPath } from "../src/paths.js";
import { expectedTimestamp } from "./helpers/oracles.js";
import { makeRepo, writeMalformedJson } from "./fixtures/repo-fixtures.js";
import { cli, spawnCli } from "./helpers/cli-harness.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { writeLogLines } from "./fixtures/log-fixtures.js";
import { flushImmediate } from "./helpers/wait.js";
import { fakeClock } from "./fakes/time.js";

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

// Seed a chronological run of run_start events directly (the -n view is newest-first).
function seedRunEvents(repo: string, count: number): void {
  const now = Date.now();
  const file = eventsLogPath(repo);
  const events = Array.from({ length: count }, (_, i) => ({
    ts: now - (count - i) * 1000,
    source: "clean",
    type: "run_start",
    run: i + 1,
  }));
  writeLogLines(file, events);
}

test("logs -n --json prints exactly the raw stored events, in the text view's order, one JSON object per line", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs json dump");
  seedRunEvents(repo, 25);

  const r = await cli(repo, "logs", "-n", "20", "--json");
  assert.equal(r.code, 0);
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 20, r.stdout);
  // Each line parses as a JSON object with a type id and numeric ts — the canonical schema,
  // not a paraphrase — and the objects are byte-for-byte the ones stored in the log.
  const stored = fs.readFileSync(eventsLogPath(repo), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const [i, line] of lines.entries()) {
    const e = JSON.parse(line);
    assert.equal(e.type, "run_start", line);
    assert.equal(typeof e.ts, "number", line);
    assert.ok(stored.some((s) => JSON.stringify(s) === JSON.stringify(e)), `line ${i} matches a stored event`);
  }
  // Log order — the last 20 of 25 events, chronological — exactly the order the text view
  // prints (readEvents returns the tail in file order, not reversed).
  const runs = lines.map((l) => JSON.parse(l).run);
  assert.deepEqual(runs, Array.from({ length: 20 }, (_, i) => 6 + i));
  // No rendered prose may leak into the JSON stream.
  assert.ok(!r.stdout.includes("tick #"), r.stdout);
});

test("logs -f --json streams each newly landed event as a JSON line", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs json follow");
  seedRunEvents(repo, 2);

  const s = spawnCli(repo, ["logs", "-f", "--json"]);
  try {
    await s.waitFor((out) => out.includes('"run":2'), "the initial window");

    // An event appended while following must stream as JSON, not rendered prose: the child's
    // own 500 ms followFile poll is the product under test, and this wait only has to observe
    // its output. Give the wait a logical deadline (a frozen fake clock no host load can spend)
    // and a sleep that resolves on the child's next stdout chunk, so the live event is observed
    // the moment it streams instead of after a real poll interval. The fallback crosses that
    // frozen deadline only if the child never streams, so a regression fails the wait
    // deterministically rather than hanging it.
    const live = { ts: Date.now(), source: "clean", type: "run_start", run: 99 };
    const clock = fakeClock();
    let injectedSleeps = 0;
    const liveWait = s.waitFor((out) => out.includes('"run":99'), "the live event as JSON", 30_000, {
      now: clock.now,
      sleep: () =>
        new Promise<void>((resolve) => {
          injectedSleeps++;
          const onData = (): void => {
            clearTimeout(fallback);
            resolve();
          };
          const fallback = setTimeout(() => {
            s.child.stdout?.off("data", onData);
            clock.advance(30_001);
            resolve();
          }, 60_000);
          s.child.stdout?.once("data", onData);
        }),
    });
    // The event has not landed yet, so the wait's synchronous first poll must have parked on the
    // injected sleep: a wait that fell back to the live clock would leave this at 0 and observe
    // the event through a real timer, not the seam under test.
    assert.equal(injectedSleeps, 1, "the follow wait must poll through the injected sleep");
    fs.appendFileSync(eventsLogPath(repo), JSON.stringify(live) + "\n");
    await liveWait;
    assert.ok(!s.out().includes("tick #99"), `rendered prose in JSON follow:\n${s.out()}`);
  } finally {
    s.kill();
  }
});

test("logs -f's wait expires on the injected clock, not a real deadline", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs json follow deadline");
  seedRunEvents(repo, 2);

  const s = spawnCli(repo, ["logs", "-f", "--json"]);
  try {
    await s.waitFor((out) => out.includes('"run":2'), "the initial window");
    // A clock this test drives by hand: `sleep` parks until the test releases it, so advancing
    // the clock is the only thing that can move the wait past its budget. A wait that ignored the
    // seam and slept on the real host clock would leave `parked` at 0 (the assertion below fails
    // deterministically) and would settle only after the real budget, not because of the advance.
    let nowMs = 0;
    let release: (() => void) | undefined;
    let parked = 0;
    const wait = s.waitFor((out) => out.includes('"run":99'), "the never-arriving event", 1_000, {
      now: () => nowMs,
      sleep: () =>
        new Promise<void>((resolve) => {
          parked++;
          release = resolve;
        }),
    });
    assert.equal(parked, 1, "the wait must park on the injected sleep");
    let settled = false;
    void wait.then(
      () => (settled = true),
      () => (settled = true),
    );
    await flushImmediate();
    assert.equal(settled, false, "the wait must not settle before the clock advances");
    nowMs = 1_001;
    release?.();
    await assert.rejects(wait, /timed out waiting for the never-arriving event/);
  } finally {
    s.kill();
  }
});

// --- logs --transcript (per-role pi transcript) ---

test("logs --transcript validates the role id and reports a missing transcript", async () => {
  const repo = makeRepo();
  await initProject(repo, "transcript cli test");

  let r = await cli(repo, "logs", "--transcript");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--transcript needs a role id/);

  r = await cli(repo, "logs", "--transcript", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus \(valid ids: feature, bugfix/);

  // A valid id whose role never ran: friendly message, exit 0.
  r = await cli(repo, "logs", "--transcript", "clean");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no transcript yet for clean/);
});

test("logs --role rejects an unknown id and the --transcript view", async () => {
  const repo = makeRepo();
  await initProject(repo, "logs role filter cli test");
  const bad = await cli(repo, "logs", "--role", "bogus");
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /unknown role: bogus/);
  const missing = await cli(repo, "logs", "--role");
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /--role needs a role id/);
  const rival = await cli(repo, "logs", "--role", "clean", "--transcript", "clean");
  assert.notEqual(rival.code, 0);
  assert.match(rival.stderr, /--transcript/);
});

// User-defined roles are valid --transcript (logs) and --role (reset-counters, abort) targets.

test("logs --transcript prints the rendered pi transcript and -n limits entries", async () => {
  const repo = makeRepo();
  await initProject(repo, "transcript cli render test");
  const TS1 = 1787222691956;
  const TS2 = TS1 + 3_600_000;
  const file = piLogPath(repo, "clean");
  writeLogLines(file, [
      JSON.stringify({ type: "session", version: 3, id: "x" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "run prompt one (must not appear)" }], timestamp: TS1 } }),
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
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "run prompt two (must not appear)" }], timestamp: TS2 } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second run done" }], stopReason: "stop" } }),
    ]);

  let r = await cli(repo, "logs", "--transcript", "clean");
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
  r = await cli(repo, "logs", "--transcript", "clean", "-n", "1");
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes("Reading PLANS.md."), r.stdout);
  assert.ok(r.stdout.includes("  second run done"), r.stdout);
});

test("logs --transcript --prompt shows each run's exact prompt and -n limits to the newest", async () => {
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
  let r = await cli(repo, "logs", "--transcript", "clean", "--prompt");
  assert.equal(r.code, 0);
  // Each prompt lands under its run separator and before that run's assistant turn, verbatim.
  const one = r.stdout.indexOf("PROMPT ONE\nsecond line");
  assert.ok(one > -1, r.stdout);
  assert.ok(r.stdout.indexOf(`── run @ ${expectedTimestamp(TS1)} ──`) < one, r.stdout);
  assert.ok(one < r.stdout.indexOf("  turn one"), r.stdout);
  assert.ok(r.stdout.includes(`── run @ ${expectedTimestamp(TS2)} ──`), r.stdout);
  assert.ok(r.stdout.includes("PROMPT TWO"), r.stdout);

  // -n counts a prompt as one entry: only the newest run's prompt remains.
  r = await cli(repo, "logs", "--transcript", "clean", "--prompt", "-n", "1");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("PROMPT TWO"), r.stdout);
  assert.ok(!r.stdout.includes("PROMPT ONE"), r.stdout);
  assert.ok(!r.stdout.includes("  turn one"), r.stdout);

  // --prompt is meaningless without --transcript.
  r = await cli(repo, "logs", "--prompt");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /logs --prompt needs --transcript <id>/);
});

test("logs --transcript still reads a transcript when tumwater.json is broken", async () => {
  // The read-only transcript view needs the config only to accept user-defined role ids, so a
  // torn/mid-edit tumwater.json must not take it down: it falls back to the built-in catalog,
  // the same policy the GUI's transcript handler applies. Before that fallback, loadConfig threw
  // and the whole command exited 1 with the config error.
  const repo = makeRepo();
  await initProject(repo, "broken config transcript test");
  writeMalformedJson(path.join(repo, "tumwater.json"));
  const file = piLogPath(repo, "clean");
  writeLogLines(file, [JSON.stringify({ type: "agent_start" }), assistantLine("readable anyway")]);

  const r = await cli(repo, "logs", "--transcript", "clean");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("readable anyway"), r.stdout);

  // The fallback relaxes the config READ, not the id validation: an unknown id is still refused.
  const bad = await cli(repo, "logs", "--transcript", "nope");
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
    // Wide deadlines: under full-suite load the spawned child's startup alone can eat
    // most of the harness default, and this test only needs to prove the follow works.
    await s.waitFor((out) => out.includes("message added to the inbox: first prompt"), "the seeded event", 30_000);

    // A new event appended while following must appear without a restart (500ms poll).
    submitPrompt(repo, "second prompt");
    await s.waitFor((out) => out.includes("message added to the inbox: second prompt"), "the live event", 30_000);
  } finally {
    s.kill();
  }
});

test("logs --transcript -f prints each turn exactly once across the initial window and follow", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli transcript follow");

  // One completed run on disk; a second is appended while following.
  const file = piLogPath(repo, "clean");
  writeLogLines(file, [JSON.stringify({ type: "session", version: 3, id: "x" }), assistantLine("first turn text")]);

  const s = spawnCli(repo, ["logs", "--transcript", "clean", "-f"]);
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
