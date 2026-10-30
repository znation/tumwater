import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initProject } from "../src/init/init.js";
import { eventsLogPath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli, spawnCli } from "./helpers/cli-harness.js";
import { COMMIT_A, COMMIT_B, seedMixedLog, writeLogLines } from "./fixtures/log-fixtures.js";

// The `logs` command's window-and-filter CLI tests — --since, --grep, --json and --until, and
// their docs pins — split from cli-logs.test.ts so node --test runs them in parallel processes.
// That file keeps argument validation, the per-role transcript views, and the -f follow mode;
// cli-logs-type.test.ts holds the --type, --count and --role filters, split off so each file
// fits the gate's 30 s budget.

// Seed events.jsonl directly with events at fixed ages before `now` (the pattern that file
// uses for the transcript view): each line a HarnessEvent-shaped run_start, distinguishable
// by its run number in the rendered line.
function seedEvents(repo: string, agesMs: number[], now = Date.now()): void {
  const file = eventsLogPath(repo);
  writeLogLines(file, agesMs.map((age, i) => ({ ts: now - age, loop: "clean", type: "run_start", run: i + 1 }))); // retired-name-ok: legacy event field in a fixture
}

test("logs --since prints only the events of the window, oldest-first", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs since window");
  seedEvents(repo, [2 * 86_400_000, 90 * 60_000, 45 * 60_000, 10 * 60_000]);

  const r = await cli(repo, "logs", "--since", "1h");
  assert.equal(r.code, 0);
  // run #3 (45m) and #4 (10m) sit inside the 1h window, oldest-first; #1 (2d) is outside on
  // both the day key and ts, #2 (90m) only on ts — the day-keyed read over-reads the cutoff's
  // own day, and the ts filter must remove it.
  const three = r.stdout.indexOf("run #3 started");
  const four = r.stdout.indexOf("run #4 started");
  assert.ok(three > -1 && four > three, r.stdout);
  assert.ok(!r.stdout.includes("run #1 started"), r.stdout);
  assert.ok(!r.stdout.includes("run #2 started"), r.stdout);
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
  assert.ok(r.stdout.includes("run #2 started") && r.stdout.includes("run #3 started"), r.stdout);
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

  r = await cli(repo, "logs", "--since", "30m", "--transcript", "clean");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--since .*--transcript/);

  // --prompt requires --transcript, so it is excluded with it.
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
  assert.match(r.stderr, /logs --since needs a value/);

  r = await cli(repo, "logs", "--since", "45x");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /logs --since needs a duration like 45s, 90m, 1h30m, or 2d/);

  r = await cli(repo, "logs", "--since", "0s");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /logs --since needs a duration/);
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
  const rows = r.stdout.indexOf("run #1 started");
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

test("logs --grep matches the event type id even where the rendering paraphrases it", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep type");
  seedMixedLog(repo);

  const r = await cli(repo, "logs", "--grep", "review_rejected");
  assert.equal(r.code, 0);
  // The type id matches the review_rejected event; the merge_failed whose result names the code
  // renders the result's label ("review rejected"), so the raw code no longer matches its line.
  // Everything else (the run lines, the other merge_failed) is filtered out.
  assert.ok(r.stdout.includes("review rejected abc1234"), r.stdout);
  assert.ok(!r.stdout.includes("failed (review rejected)"), r.stdout);
  assert.ok(!r.stdout.includes("run #"), r.stdout);
  assert.ok(!r.stdout.includes("check ran"), r.stdout);
});

test("logs --grep matches the rendered line, case-insensitively", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep text");
  seedMixedLog(repo);

  let r = await cli(repo, "logs", "--grep", "failed (");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("failed (check ran)"), r.stdout);
  assert.ok(r.stdout.includes("failed (review rejected)"), r.stdout);
  assert.ok(!r.stdout.includes("review rejected abc1234"), r.stdout);

  // Case-insensitive over both the type id and the rendered line.
  r = await cli(repo, "logs", "--grep", "REVIEW_REJECTED");
  assert.ok(r.stdout.includes("review rejected abc1234"), r.stdout);
  r = await cli(repo, "logs", "--grep", "FAILED (");
  assert.ok(r.stdout.includes("failed (check ran)"), r.stdout);
});

test("logs --grep: -n bounds the scanned window, not the printed rows", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep scan window");
  seedMixedLog(repo);

  // The last 4 events exclude the oldest merge_failed (commit A): 4 scanned, 1 printed.
  let r = await cli(repo, "logs", "-n", "4", "--grep", "merge_failed");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("def4567"), r.stdout);
  assert.ok(!r.stdout.includes("abc1234"), r.stdout);

  // The default window covers the whole log: both merge_faileds print.
  r = await cli(repo, "logs", "--grep", "merge_failed");
  assert.ok(r.stdout.includes("abc1234") && r.stdout.includes("def4567"), r.stdout);
});

test("logs --grep composes with --transcript and --prompt still needs it", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep exclusions");

  let r = await cli(repo, "logs", "--grep", "x", "--transcript", "clean");
  assert.equal(r.code, 0);

  // --prompt requires --transcript.
  r = await cli(repo, "logs", "--grep", "x", "--prompt");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /logs --prompt needs --transcript/);
});

test("logs --grep treats a flag-shaped pattern as text, not as the flag it spells", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep flag-shaped pattern");

  // A rival flag's name at the PATTERN's position is the grep text: the command must exit 0
  // with the gentle no-match note, not the combine rejection (which used to fire on the
  // pattern itself, since every rival scan looked at the raw argument list).
  let r = await cli(repo, "logs", "--grep", "--since");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no events matching "--since"/);

  // --prompt misfired the same way, with the --transcript combine message.
  r = await cli(repo, "logs", "--grep", "--prompt");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no events matching "--prompt"/);
});

test("logs --grep -f does not enter follow mode over its own pattern", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep dash-f pattern");
  // The pattern "-f" used to be read as the follow flag itself: the command hung following
  // an empty log instead of printing the no-match note and exiting. cli() bounds the run at
  // 20s, so a plain exit-0 with the note IS the assertion — pre-fix this test times out.
  const r = await cli(repo, "logs", "--grep", "-f");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no events matching "-f"/);
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

  const s = spawnCli(repo, ["logs", "--grep", "merge_failed", "-f"]);
  try {
    await s.waitFor((out) => out.includes("failed (check ran)"), "the seeded match");

    // A new event appended while following: the matching one appears, the non-matching one
    // does not (the filter holds across rotation, on every event the callback sees).
    const file = eventsLogPath(repo);
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), loop: "feature", type: "run_start", run: 7 }) + "\n"); // retired-name-ok: legacy event field in a fixture
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), loop: "feature", type: "merge_failed", commit: COMMIT_A, result: "conflict", durationMs: 100 }) + "\n"); // retired-name-ok: legacy event field in a fixture
    await s.waitFor((out) => out.includes("failed (conflict)"), "the live match");

    const out = s.out();
    assert.ok(!out.includes("run #7"), `followed events must be filtered too:\n${out}`);
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

test("logs --since --grep filters the window, and an empty match is gentle prose", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep since");
  const now = Date.now();
  writeLogLines(eventsLogPath(repo), [
    { ts: now - 3 * 3_600_000, loop: "feature", type: "review_rejected", head: COMMIT_B, reasons: ["sloppy old handling"], durationMs: 400 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 40 * 60_000, loop: "feature", type: "merge_failed", commit: COMMIT_A, result: "review_rejected", durationMs: 800 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 30 * 60_000, loop: "feature", type: "review_rejected", head: COMMIT_A, reasons: ["sloppy error handling"], durationMs: 400 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 20 * 60_000, loop: "feature", type: "merge_failed", commit: COMMIT_B, result: "conflict", durationMs: 100 }, // retired-name-ok: legacy event field in a fixture
  ]);

  let r = await cli(repo, "logs", "--since", "1h", "--grep", "sloppy");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("sloppy error handling"), r.stdout);
  assert.ok(!r.stdout.includes("sloppy old handling"), r.stdout);

  r = await cli(repo, "logs", "--since", "1h", "--grep", "sloppy", "--type", "merge_failed");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no events matching "sloppy" or no events matching "merge_failed"/);

  r = await cli(repo, "logs", "--since", "1h", "--grep", "nosuchtext");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no events matching "nosuchtext" in/);

  r = await cli(repo, "logs", "--since", "1h", "--grep", "nosuchtext", "--json");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "", r.stdout);

  r = await cli(repo, "logs", "--since", "1h", "--grep", "sloppy", "--json");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines.length > 0 && lines.every((l) => JSON.parse(l).type === "review_rejected"), r.stdout);
});

// --- logs --json (the event feed as machine-readable NDJSON) ---

test("logs --grep --json filters before serialization", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs json grep");
  seedMixedLog(repo);

  const r = await cli(repo, "logs", "--json", "--grep", "merge_failed");
  assert.equal(r.code, 0);
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 2, r.stdout); // The two merge_failed events, nothing else.
  for (const line of lines) {
    const e = JSON.parse(line);
    assert.equal(e.type, "merge_failed", line);
    assert.equal(typeof e.ts, "number", line);
  }
  // Rendered prose never leaks into the JSON stream — the paraphrase "review rejected" is
  // exactly what a text-scraping script would have to match, and must not appear here.
  assert.ok(!r.stdout.includes("failed ("), r.stdout);
});

test("logs --json --grep with no matches prints nothing", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs json empty");
  seedMixedLog(repo);

  // In JSON mode the empty output IS the machine-readable answer: no "no events matching"
  // prose line to corrupt a consumer's NDJSON stream.
  const r = await cli(repo, "logs", "--json", "--grep", "nosuchthing");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "", r.stdout);
});

test("logs --since --json prints the window as oldest-first NDJSON", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs json since");
  seedEvents(repo, [2 * 86_400_000, 90 * 60_000, 45 * 60_000, 10 * 60_000]);

  const r = await cli(repo, "logs", "--since", "1h", "--json");
  assert.equal(r.code, 0);
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.deepEqual(lines.map((l) => JSON.parse(l).run), [3, 4], r.stdout);
  // No rotation-note prose, and no rendered lines, in the JSON stream.
  assert.ok(!r.stdout.includes("note:"), r.stdout);
  assert.ok(!r.stdout.includes("run #"), r.stdout);
});

test("logs --since --json over an empty window prints nothing", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs json since empty");

  const r = await cli(repo, "logs", "--since", "5m", "--json");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "", r.stdout); // No "no events in 5m" prose.
});

test("logs --transcript --json fails, naming both flags", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs json role");

  let r = await cli(repo, "logs", "--transcript", "clean", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json .*--transcript/);

  // --prompt requires --transcript, so it is excluded with it.
  r = await cli(repo, "logs", "--json", "--prompt");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json .*--prompt/);
});

test("tumwater help logs documents --json", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs json help");
  const r = await cli(repo, "help", "logs");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--json/);
  assert.match(r.stdout, /NDJSON/);
});

test("logs --since --until prints only the events between the two edges, oldest-first", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs until window");
  seedEvents(repo, [3 * 86_400_000, 2 * 86_400_000 - 3_600_000, 30 * 3_600_000, 2 * 3_600_000]);

  const r = await cli(repo, "logs", "--since", "2d", "--until", "1d");
  assert.equal(r.code, 0);
  const two = r.stdout.indexOf("run #2 started");
  const three = r.stdout.indexOf("run #3 started");
  assert.ok(two > -1 && three > two, r.stdout);
  assert.ok(!r.stdout.includes("run #1 started"), r.stdout);
  assert.ok(!r.stdout.includes("run #4 started"), r.stdout);

  const c = await cli(repo, "logs", "--since", "2d", "--until", "1d", "--count", "--json");
  assert.deepEqual(JSON.parse(c.stdout), { run_start: 2 });
});

test("logs --until with an empty window names both edges", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs until empty");
  seedEvents(repo, [10 * 60_000]);

  const r = await cli(repo, "logs", "--since", "2h", "--until", "1h");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no events between 2h and 1h ago/);
});

test("logs --until is refused without --since or when not shorter", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs until refused");

  const bare = await cli(repo, "logs", "--until", "1h");
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /logs --until requires --since/);
  const follow = await cli(repo, "logs", "-f", "--until", "1h");
  assert.equal(follow.code, 1);
  assert.match(follow.stderr, /logs --until requires --since/);
  for (const until of ["2h", "1h"]) {
    const r = await cli(repo, "logs", "--since", "1h", "--until", until);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /logs --until \(.*\) must be shorter than --since/);
  }
  const missing = await cli(repo, "logs", "--since", "1h", "--until");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /logs --until needs a value/);
});
