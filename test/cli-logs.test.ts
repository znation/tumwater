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

// The `logs` command family through the real CLI entry point: argument validation, the
// rendered per-role pi transcript, --prompt, and the -f follow mode (spawned with a live
// handle so the test can observe the initial window and newly appended entries). Split
// out of test/cli.test.ts, which grew past 1500 lines mixing every command family.

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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
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
    ].join("\n") + "\n",
  );

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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "PROMPT ONE\nsecond line" }], timestamp: TS1 } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "turn one" }] } }),
      JSON.stringify({ type: "agent_start" }),
      // The newest run has no assistant turn yet: with --prompt the newest entry is its prompt.
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "PROMPT TWO" }], timestamp: TS2 } }),
    ].join("\n") + "\n",
  );
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [JSON.stringify({ type: "agent_start" }), assistantLine("readable anyway")].join("\n") + "\n");

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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [JSON.stringify({ type: "session", version: 3, id: "x" }), assistantLine("first turn text")].join("\n") + "\n",
  );

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

// --- logs --since (a bounded past window of the event log) ---

// Seed events.jsonl directly with events at fixed ages before `now` (the pattern this file
// uses for the transcript view): each line a HarnessEvent-shaped tick_start, distinguishable
// by its tick number in the rendered line.
function seedEvents(repo: string, agesMs: number[], now = Date.now()): void {
  const file = eventsLogPath(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    agesMs.map((age, i) => JSON.stringify({ ts: now - age, loop: "clean", type: "tick_start", tick: i + 1 })).join("\n") + "\n",
  );
}

test("logs --since prints only the events of the window, oldest-first", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs since window");
  seedEvents(repo, [2 * 86_400_000, 90 * 60_000, 45 * 60_000, 10 * 60_000]);

  const r = await cli(repo, "logs", "--since", "1h");
  assert.equal(r.code, 0);
  // tick #3 (45m) and #4 (10m) sit inside the 1h window, oldest-first; #1 (2d) is outside on
  // both the day key and ts, #2 (90m) only on ts — the day-keyed read over-reads the cutoff's
  // own day, and the ts filter must remove it.
  const three = r.stdout.indexOf("tick #3 started");
  const four = r.stdout.indexOf("tick #4 started");
  assert.ok(three > -1 && four > three, r.stdout);
  assert.ok(!r.stdout.includes("tick #1 started"), r.stdout);
  assert.ok(!r.stdout.includes("tick #2 started"), r.stdout);
  // The 2-day-old line proves the retained log reaches back before the window's first day,
  // so the window is known complete: no rotation note.
  assert.ok(!r.stdout.includes("note:"), r.stdout);
});

test("logs --since proves same-day coverage by timestamp, not day key", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs since same-day");
  // Every event is today, so no line can carry a day key older than the window's first day —
  // the day-keyed proof is structurally unavailable. But the log's oldest retained event (90m)
  // predates the 1h cutoff, which is itself proof the retained log covers the whole window:
  // the log is append-only and chronological, so everything after that event is present.
  seedEvents(repo, [90 * 60_000, 45 * 60_000, 10 * 60_000]);

  const r = await cli(repo, "logs", "--since", "1h");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("tick #2 started") && r.stdout.includes("tick #3 started"), r.stdout);
  assert.ok(!r.stdout.includes("note:"), `no note when the log provably covers the window:\n${r.stdout}`);
});

test("logs --since refuses the rival shapes, naming both flags", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs since exclusions");

  let r = await cli(repo, "logs", "--since", "30m", "-f");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--since .*-f/);

  r = await cli(repo, "logs", "--since", "30m", "--follow");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--since .*--follow/);

  r = await cli(repo, "logs", "--since", "30m", "-n", "5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--since .*-n/);

  r = await cli(repo, "logs", "--since", "30m", "--role", "clean");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--since .*--role/);

  // --prompt requires --role, so it is excluded with it.
  r = await cli(repo, "logs", "--since", "30m", "--prompt");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--since .*--prompt/);
});

test("logs --since validates its duration against the 7-day cap", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs since validation");

  let r = await cli(repo, "logs", "--since", "8d");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /capped at 7d/);

  r = await cli(repo, "logs", "--since");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--since needs a value/);

  r = await cli(repo, "logs", "--since", "45x");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--since needs a duration like 45s, 90m, 2h, or 1d/);

  r = await cli(repo, "logs", "--since", "0s");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--since needs a duration/);
});

test("logs --since reports an empty window gently, with no rotation claim", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs since empty");

  // No log file at all (fresh install): friendly empty line, exit 0, and no note — there is
  // no evidence any event ever rotated away, so claiming rotation would be false outright.
  let r = await cli(repo, "logs", "--since", "5m");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^no events in 5m\n$/);
  assert.ok(!r.stdout.includes("note:"), r.stdout);

  // An empty window over a log that demonstrably reaches back before it: same gentle shape.
  seedEvents(repo, [9 * 86_400_000]);
  r = await cli(repo, "logs", "--since", "7d");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^no events in 7d\n$/);
  assert.ok(!r.stdout.includes("note:"), r.stdout);
});

test("logs --since notes only an unproven window that has rows", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs since rotation");

  // The sole retained event (10m) lies inside the 2h window, and the read reached the file
  // start without finding anything older — the window cannot be proven complete (the cause
  // may be rotation or a young log), so the rows are followed by the hedged note.
  seedEvents(repo, [10 * 60_000]);
  const r = await cli(repo, "logs", "--since", "2h");
  assert.equal(r.code, 0);
  const rows = r.stdout.indexOf("tick #1 started");
  const note = r.stdout.indexOf("note: the log's oldest retained event lies inside this window");
  assert.ok(rows > -1 && note > rows, r.stdout);
});

test("tumwater help logs documents --since", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs since help");
  const r = await cli(repo, "help", "logs");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--since <duration>/);
});

// --- logs --grep (filter the event feed by type id or rendered line) ---

// A mixed log of several event types, seeded directly (the pattern this file uses): the
// events are distinguishable by their rendered lines, and review_rejected's rendering
// ("review rejected") paraphrases its type id, which is what makes type-id matching worth
// testing separately.
const COMMIT_A = "abc1234567890ef";
const COMMIT_B = "def4567890abcdef";

function seedMixedLog(repo: string): void {
  const now = Date.now();
  const file = eventsLogPath(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const events = [
    { ts: now - 6000, loop: "feature", type: "land_failed", commit: COMMIT_A, result: "review_rejected", durationMs: 800 },
    { ts: now - 5000, loop: "feature", type: "tick_start", tick: 1 },
    { ts: now - 4000, loop: "feature", type: "review_rejected", head: COMMIT_A, reasons: ["sloppy error handling"], durationMs: 1200 },
    { ts: now - 3000, loop: "bugfix", type: "tick_start", tick: 2 },
    { ts: now - 2000, loop: "bugfix", type: "tick_end", tick: 2, result: "refused", summary: "nothing to do" },
    { ts: now - 1000, loop: "bugfix", type: "land_failed", commit: COMMIT_B, result: "build_check", durationMs: 900 },
  ];
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

test("logs --grep matches the event type id even where the rendering paraphrases it", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep type");
  seedMixedLog(repo);

  const r = await cli(repo, "logs", "--grep", "review_rejected");
  assert.equal(r.code, 0);
  // The type id prefix matches both review events: the review_rejected whose rendered line
  // says "review rejected", and the land_failed whose result names the type. Everything else
  // (the tick lines, the other land_failed) is filtered out.
  assert.ok(r.stdout.includes("review rejected abc1234"), r.stdout);
  assert.ok(r.stdout.includes("did not land (review_rejected)"), r.stdout);
  assert.ok(!r.stdout.includes("tick #"), r.stdout);
  assert.ok(!r.stdout.includes("build_check"), r.stdout);
  // Oldest-first, in the normal line format.
  assert.ok(r.stdout.indexOf("did not land") < r.stdout.indexOf("review rejected"), r.stdout);
});

test("logs --grep matches the rendered line, case-insensitively", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep text");
  seedMixedLog(repo);

  let r = await cli(repo, "logs", "--grep", "did not land");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("did not land (build_check)"), r.stdout);
  assert.ok(r.stdout.includes("did not land (review_rejected)"), r.stdout);
  assert.ok(!r.stdout.includes("review rejected abc1234"), r.stdout);

  // Case-insensitive over both the type id and the rendered line.
  r = await cli(repo, "logs", "--grep", "REVIEW_REJECTED");
  assert.ok(r.stdout.includes("review rejected abc1234"), r.stdout);
  r = await cli(repo, "logs", "--grep", "Did Not Land");
  assert.ok(r.stdout.includes("did not land (build_check)"), r.stdout);
});

test("logs --grep: -n bounds the scanned window, not the printed rows", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep scan window");
  seedMixedLog(repo);

  // The last 4 events exclude the oldest land_failed (commit A): 4 scanned, 1 printed.
  let r = await cli(repo, "logs", "-n", "4", "--grep", "land_failed");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("def4567"), r.stdout);
  assert.ok(!r.stdout.includes("abc1234"), r.stdout);

  // The default window covers the whole log: both land_faileds print.
  r = await cli(repo, "logs", "--grep", "land_failed");
  assert.ok(r.stdout.includes("abc1234") && r.stdout.includes("def4567"), r.stdout);
});

test("logs --grep refuses the rival shapes, naming both flags", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep exclusions");

  let r = await cli(repo, "logs", "--grep", "x", "--role", "clean");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--grep .*--role/);

  // --prompt requires --role, so it is excluded with it.
  r = await cli(repo, "logs", "--grep", "x", "--prompt");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--grep .*--prompt/);

  // --since is a filter of its own, not a window to filter.
  r = await cli(repo, "logs", "--grep", "x", "--since", "1h");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--grep .*--since/);
});

test("logs --grep reports a missing pattern and an empty result gently", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep empties");
  seedMixedLog(repo);

  const missing = await cli(repo, "logs", "--grep");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /logs --grep needs a pattern/);

  const none = await cli(repo, "logs", "--grep", "zzzz-no-such-event");
  assert.equal(none.code, 0);
  assert.equal(none.stdout.trim(), 'no events matching "zzzz-no-such-event"');
});

test("logs --grep -f applies the filter to the seeded window and every followed event", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep follow");
  seedMixedLog(repo);

  const s = spawnCli(repo, ["logs", "--grep", "land_failed", "-f"]);
  try {
    await s.waitFor((out) => out.includes("did not land (build_check)"), "the seeded match");

    // A new event appended while following: the matching one appears, the non-matching one
    // does not (the filter holds across rotation, on every event the callback sees).
    const file = eventsLogPath(repo);
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), loop: "feature", type: "tick_start", tick: 7 }) + "\n");
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), loop: "feature", type: "land_failed", commit: COMMIT_A, result: "conflict", durationMs: 100 }) + "\n");
    await s.waitFor((out) => out.includes("did not land (conflict)"), "the live match");

    const out = s.out();
    assert.ok(!out.includes("tick #7"), `followed events must be filtered too:\n${out}`);
    assert.ok(!out.includes("review rejected abc1234"), `the seeded window must be filtered too:\n${out}`);
  } finally {
    s.kill();
  }
});

test("tumwater help logs documents --grep and the scan-window note", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep help");
  const r = await cli(repo, "help", "logs");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--grep <text>/);
  assert.match(r.stdout, /case-insensitively/);
  assert.match(r.stdout, /-n bounds the scanned window/);
});
