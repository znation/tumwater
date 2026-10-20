import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initProject } from "../src/init/init.js";
import { eventsLogPath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli, spawnCli } from "./helpers/cli-harness.js";
import { writeLogLines } from "./fixtures/log-fixtures.js";

// The `logs` command's window-and-filter CLI tests — --since, --grep, and the docs pin —
// split from cli-logs.test.ts so node --test runs them in parallel processes. That file
// keeps argument validation, the per-role transcript views, and the -f follow mode.

// Seed events.jsonl directly with events at fixed ages before `now` (the pattern that file
// uses for the transcript view): each line a HarnessEvent-shaped run_start, distinguishable
// by its tick number in the rendered line.
function seedEvents(repo: string, agesMs: number[], now = Date.now()): void {
  const file = eventsLogPath(repo);
  writeLogLines(file, agesMs.map((age, i) => ({ ts: now - age, loop: "clean", type: "run_start", run: i + 1 })));
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

// A mixed log of several event types, seeded directly (the pattern this file uses): the
// events are distinguishable by their rendered lines, and review_rejected's rendering
// ("review rejected") paraphrases its type id, which is what makes type-id matching worth
// testing separately.
const COMMIT_A = "abc1234567890ef";
const COMMIT_B = "def4567890abcdef";

function seedMixedLog(repo: string): void {
  const now = Date.now();
  const file = eventsLogPath(repo);
  const events = [
    { ts: now - 6000, loop: "feature", type: "merge_failed", commit: COMMIT_A, result: "review_rejected", durationMs: 800 },
    { ts: now - 5000, loop: "feature", type: "run_start", run: 1 },
    { ts: now - 4000, loop: "feature", type: "review_rejected", head: COMMIT_A, reasons: ["sloppy error handling"], durationMs: 1200 },
    { ts: now - 3000, loop: "bugfix", type: "run_start", run: 2 },
    { ts: now - 2000, loop: "bugfix", type: "run_end", run: 2, result: "refused", summary: "nothing to do" },
    { ts: now - 1000, loop: "bugfix", type: "merge_failed", commit: COMMIT_B, result: "build_check", durationMs: 900 },
  ];
  writeLogLines(file, events);
}

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

test("logs --grep refuses the rival shapes, naming both flags", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs grep exclusions");

  let r = await cli(repo, "logs", "--grep", "x", "--transcript", "clean");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--grep .*--transcript/);

  // --prompt requires --transcript, so it is excluded with it.
  r = await cli(repo, "logs", "--grep", "x", "--prompt");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--grep .*--prompt/);

  // --since is a filter of its own, not a window to filter.
  r = await cli(repo, "logs", "--grep", "x", "--since", "1h");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--grep .*--since/);
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
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), loop: "feature", type: "run_start", run: 7 }) + "\n");
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), loop: "feature", type: "merge_failed", commit: COMMIT_A, result: "conflict", durationMs: 100 }) + "\n");
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

// --- logs --type (the exact event-type filter) ---

test("logs --type prints only events of exactly that type, where --grep substrings", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs type exact");
  const now = Date.now();
  const file = eventsLogPath(repo);
  writeLogLines(file, [
    { ts: now - 6000, loop: "feature", type: "merge_failed", commit: COMMIT_A, result: "review_rejected", durationMs: 800 },
    { ts: now - 5000, loop: "feature", type: "run_start", run: 1 },
    // A wake event whose rendered line quotes the word "merge_failed" as its reason text:
    // the exact-vs-substring case — --grep matches the quoted text, --type (an event id,
    // not free text) must not.
    { ts: now - 4000, loop: "clean", type: "wake", reason: "merge_failed" },
  ]);

  const r = await cli(repo, "logs", "--type", "merge_failed", "-n", "200");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("failed (review rejected)"), r.stdout);
  assert.ok(!r.stdout.includes("run #"), r.stdout);
  assert.ok(!r.stdout.includes("woke (merge_failed)"), `--type is an exact id, not a substring:\n${r.stdout}`);

  // The same log under --grep DOES match the quoted reason text (where --type refused it).
  const g = await cli(repo, "logs", "--grep", "merge_failed", "-n", "200");
  assert.equal(g.code, 0);
  assert.ok(g.stdout.includes("woke (merge_failed)"), g.stdout);
});

test("logs --type takes a comma list matching any of its types", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs type list");
  const now = Date.now();
  writeLogLines(eventsLogPath(repo), [
    { ts: now - 40 * 60_000, loop: "feature", type: "merge_failed", commit: COMMIT_A, result: "conflict", durationMs: 800 },
    { ts: now - 30 * 60_000, loop: "feature", type: "run_start", run: 7 },
    { ts: now - 20 * 60_000, loop: "feature", type: "review_rejected", head: COMMIT_A, reasons: ["sloppy"], durationMs: 400 },
  ]);

  for (const value of ["merge_failed,review_rejected", " merge_failed , review_rejected "]) {
    const r = await cli(repo, "logs", "--type", value, "-n", "50");
    assert.equal(r.code, 0);
    const a = r.stdout.indexOf("failed");
    const b = r.stdout.indexOf("review rejected");
    assert.ok(a > -1 && b > a, r.stdout);
    assert.ok(!r.stdout.includes("run #7"), r.stdout);
  }

  let r = await cli(repo, "logs", "--since", "1h", "--type", "merge_failed,review_rejected");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("review rejected") && !r.stdout.includes("run #7"), r.stdout);

  r = await cli(repo, "logs", "--count", "--type", "merge_failed,review_rejected", "-n", "50");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("merge_failed") && r.stdout.includes("review_rejected"), r.stdout);
  assert.ok(!r.stdout.includes("run_start"), r.stdout);

  r = await cli(repo, "logs", "--type", "merge_faild,wake", "-n", "50");
  assert.ok(r.stdout.includes('no events matching "merge_faild,wake"'), r.stdout);
  assert.ok(r.stdout.includes("merge_failed"), r.stdout);

  r = await cli(repo, "logs", "--type", "wake,run_end", "-n", "50");
  assert.ok(r.stdout.includes('no events matching "wake,run_end"'), r.stdout);
  assert.ok(!r.stdout.includes("did you mean"), r.stdout);

  r = await cli(repo, "logs", "--type", ",");
  assert.notEqual(r.code, 0);
  assert.ok((r.stderr + r.stdout).includes("logs --type needs an event type"), r.stderr);
});

test("logs --since --type filters the window, and an empty match is gentle prose", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs type since");
  const now = Date.now();
  const file = eventsLogPath(repo);
  writeLogLines(file, [
    { ts: now - 40 * 60_000, loop: "feature", type: "merge_failed", commit: COMMIT_A, result: "review_rejected", durationMs: 800 },
    { ts: now - 30 * 60_000, loop: "feature", type: "review_rejected", head: COMMIT_A, reasons: ["sloppy error handling"], durationMs: 400 },
    { ts: now - 20 * 60_000, loop: "feature", type: "merge_failed", commit: COMMIT_B, result: "conflict", durationMs: 100 },
  ]);

  // --type composes with the window: only the window's review_rejected prints, oldest-first.
  let r = await cli(repo, "logs", "--since", "1h", "--type", "review_rejected");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("review rejected"), r.stdout);
  assert.ok(!r.stdout.includes("failed ("), r.stdout);

  // An all-filtered window answers with the type's own no-match line (prose only).
  r = await cli(repo, "logs", "--since", "1h", "--type", "nosuchthing");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no events matching "nosuchthing"/);

  // In JSON mode an all-filtered window prints nothing (the empty output is the answer).
  const j = await cli(repo, "logs", "--since", "1h", "--type", "nosuchthing", "--json");
  assert.equal(j.code, 0);
  assert.equal(j.stdout, "", j.stdout);
});

test("logs --type hints at a typo, but a valid-but-empty type stays hint-free", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs type hint");
  const now = Date.now();
  const file = eventsLogPath(repo);
  writeLogLines(file, [
    { ts: now - 10 * 60_000, loop: "feature", type: "merge_failed", commit: COMMIT_A, result: "conflict", durationMs: 100 },
  ]);

  // A near-miss of a real code gets the did-you-mean, so a typo isn't a silent empty result.
  let r = await cli(repo, "logs", "--since", "1h", "--type", "merge_faild");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no events matching "merge_faild".*did you mean `merge_failed`\?/);

  // The same hint rides the -n view's type-empty prose.
  r = await cli(repo, "logs", "--type", "merge_faild", "-n", "200");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /did you mean `merge_failed`\?/);

  // A VALID type with no matching events is a legitimate empty result, not a typo: no hint.
  r = await cli(repo, "logs", "--since", "1h", "--type", "run_end");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no events matching "run_end"/);
  assert.ok(!r.stdout.includes("did you mean"), r.stdout);
});

test("logs --type -n composes with --grep (type AND text) and with --json", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs type compose");
  seedMixedLog(repo); // two merge_failed (review_rejected / build_check), a review_rejected, ticks.

  // Both rules hold: merge_failed events whose text ALSO mentions "review rejected" (only the
  // one with result review_rejected, not the build_check one, and not the review_rejected
  // event itself).
  const g = await cli(repo, "logs", "--type", "merge_failed", "--grep", "review rejected", "-n", "200");
  assert.equal(g.code, 0);
  assert.ok(g.stdout.includes("failed (review rejected)"), g.stdout);
  assert.ok(!g.stdout.includes("failed (check ran)"), g.stdout);
  assert.ok(!g.stdout.includes("review rejected abc1234"), g.stdout);

  // --json filters before serialization: every emitted line is a merge_failed event.
  const j = await cli(repo, "logs", "--json", "--type", "merge_failed");
  assert.equal(j.code, 0);
  const lines = j.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 2, j.stdout);
  for (const line of lines) assert.equal(JSON.parse(line).type, "merge_failed", line);
});

test("logs --type refuses the transcript-view rivals and a valueless flag", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs type rivals");
  seedMixedLog(repo);

  let r = await cli(repo, "logs", "--type", "x", "--transcript", "clean");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--type .*--transcript/);

  // --prompt requires --transcript, so it is excluded with it.
  r = await cli(repo, "logs", "--type", "x", "--prompt");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--type .*--prompt/);

  // A valueless --type fails with the shared wording (the gate's missingValue).
  r = await cli(repo, "logs", "--type");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /logs --type needs an event type/);
});

test("logs --type treats a flag-shaped value as text, not as the flag it spells", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs type flag-shaped value");
  seedMixedLog(repo);

  // A rival flag's name at the VALUE's position is the type text: exit 0 with the gentle
  // no-match note, not a --since combine rejection (the value must leave rest for the scans).
  const r = await cli(repo, "logs", "--type", "--since");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no events matching "--since"/);
});

test("logs --type -f holds the filter across the seeded window and rotation", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs type follow");
  seedMixedLog(repo);

  const s = spawnCli(repo, ["logs", "--type", "merge_failed", "-f"]);
  try {
    await s.waitFor((out) => out.includes("failed (check ran)"), "the seeded match");

    const file = eventsLogPath(repo);
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), loop: "feature", type: "run_start", run: 7 }) + "\n");
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), loop: "feature", type: "merge_failed", commit: COMMIT_A, result: "conflict", durationMs: 100 }) + "\n");
    await s.waitFor((out) => out.includes("failed (conflict)"), "the live match");

    const out = s.out();
    assert.ok(!out.includes("run #7"), `followed events must be filtered too:\n${out}`);
    assert.ok(!out.includes("review rejected abc1234"), `the seeded window must be filtered too:\n${out}`);
  } finally {
    s.kill();
  }
});

test("tumwater help logs documents --type", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs type help");
  const r = await cli(repo, "help", "logs");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--type <event type>/);
});

// --- logs --count (tally the window's event types instead of printing rows) ---

test("logs --count prints one N × <type> line per present type, most-frequent-first", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs count");
  seedMixedLog(repo);

  const r = await cli(repo, "logs", "--count");
  assert.equal(r.code, 0);
  // seedMixedLog: merge_failed x2, run_start x2, review_rejected x1, run_end x1.
  assert.match(r.stdout, /2 × merge failed \(merge_failed\)/);
  assert.match(r.stdout, /2 × run started \(run_start\)/);
  assert.match(r.stdout, /1 × review rejected \(review_rejected\)/);
  assert.match(r.stdout, /1 × run finished \(run_end\)/);
});

test("logs --count composes with --type, --grep, --since, and -n", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs count filters");
  seedMixedLog(repo);

  const typed = await cli(repo, "logs", "--count", "--type", "run_end");
  assert.equal(typed.code, 0);
  assert.match(typed.stdout, /1 × run finished \(run_end\)/);
  assert.ok(!typed.stdout.includes("merge_failed"), "a --type subset counts only that type");

  const grepped = await cli(repo, "logs", "--count", "--grep", "merge_failed");
  assert.equal(grepped.code, 0);
  assert.match(grepped.stdout, /2 × merge failed \(merge_failed\)/);

  const windowed = await cli(repo, "logs", "--count", "--since", "30m");
  assert.equal(windowed.code, 0);
  assert.match(windowed.stdout, /2 × merge failed \(merge_failed\)/);

  const tailed = await cli(repo, "logs", "--count", "-n", "2");
  assert.equal(tailed.code, 0);
  assert.match(tailed.stdout, /1 × merge failed \(merge_failed\)/);
  assert.match(tailed.stdout, /1 × run finished \(run_end\)/);
});

test("logs --count --json emits a sorted type→count object", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs count json");
  seedMixedLog(repo);

  const r = await cli(repo, "logs", "--count", "--json");
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout.trim()), {
    merge_failed: 2,
    review_rejected: 1,
    run_end: 1,
    run_start: 2,
  });
});

test("logs --count rejects -f and --transcript, naming both flags", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs count exclusions");

  let r = await cli(repo, "logs", "--count", "-f");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--count cannot be combined with -f\/--follow/);

  r = await cli(repo, "logs", "--count", "--follow");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--count cannot be combined with -f\/--follow/);

  r = await cli(repo, "logs", "--count", "--transcript", "clean");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--count cannot be combined with --transcript/);
});

test("logs --count reports an empty window and empty match with the plain view's prose", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs count empty");

  const emptySince = await cli(repo, "logs", "--count", "--since", "1h");
  assert.equal(emptySince.code, 0);
  assert.match(emptySince.stdout, /no events in 1h/);
  assert.ok(!emptySince.stdout.includes("rotated out"), "a count never prints the sparse-window note");

  seedMixedLog(repo);
  const emptyType = await cli(repo, "logs", "--count", "--type", "zzz");
  assert.equal(emptyType.code, 0);
  assert.match(emptyType.stdout, /no events matching "zzz"/);
});

test("tumwater help logs documents --count", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs count help");
  const r = await cli(repo, "help", "logs");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--count/);
});

function seedRoleEvents(repo: string, now = Date.now()): void {
  const rows: Array<[string, string, number]> = [
    ["clean", "run_start", 1],
    ["dedupe", "run_start", 2],
    ["feature", "run_start", 3],
    ["feature-2", "run_start", 4],
    ["clean", "run_end", 1],
  ];
  writeLogLines(
    eventsLogPath(repo),
    rows.map(([source, type, run], i) => ({ ts: now - (rows.length - i) * 60_000, source, type, run })),
  );
}

test("logs --role keeps only the listed roles' events", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs role filter");
  seedRoleEvents(repo);

  const clean = await cli(repo, "logs", "--role", "clean");
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stdout, /run #1 started/);
  assert.doesNotMatch(clean.stdout, /run #2 started|run #3 started|run #4 started/);

  const both = await cli(repo, "logs", "--role", "clean,dedupe");
  assert.match(both.stdout, /run #1 started/);
  assert.match(both.stdout, /run #2 started/);
  assert.doesNotMatch(both.stdout, /run #3 started/);

  const feature = await cli(repo, "logs", "--role", "feature");
  assert.match(feature.stdout, /run #3 started/);
  assert.match(feature.stdout, /run #4 started/);
  assert.doesNotMatch(feature.stdout, /run #1 started/);

  const since = await cli(repo, "logs", "--role", "clean", "--since", "1h");
  assert.match(since.stdout, /run #1 started/);
  assert.doesNotMatch(since.stdout, /run #2 started/);

  const typed = await cli(repo, "logs", "--role", "clean", "--type", "run_end", "--json");
  const lines = typed.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "run_end");
  assert.equal(lines[0].source, "clean");

  const grep = await cli(repo, "logs", "--role", "dedupe", "--grep", "#2");
  assert.match(grep.stdout, /run #2 started/);
  assert.doesNotMatch(grep.stdout, /run #1 started/);

  const count = await cli(repo, "logs", "--role", "clean", "--count", "--json");
  assert.deepEqual(JSON.parse(count.stdout), { run_end: 1, run_start: 1 });
});

test("logs --role with no match names the roles", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs role empty");
  seedRoleEvents(repo);

  const plain = await cli(repo, "logs", "--role", "qa");
  assert.match(plain.stdout, /no events from qa/);
  const count = await cli(repo, "logs", "--role", "qa", "--count");
  assert.match(count.stdout, /no events from qa/);
  const since = await cli(repo, "logs", "--since", "1h", "--role", "qa");
  assert.match(since.stdout, /no events from qa in 1h/);
  const json = await cli(repo, "logs", "--json", "--role", "qa");
  assert.equal(json.stdout.trim(), "");
});
