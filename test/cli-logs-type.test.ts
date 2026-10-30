import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initProject } from "../src/init/init.js";
import { eventsLogPath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli, spawnCli } from "./helpers/cli-harness.js";
import { COMMIT_A, COMMIT_B, seedMixedLog, writeLogLines } from "./fixtures/log-fixtures.js";

// The `logs` command's event-type and role filters — --type, --count and --role — split from
// cli-logs-filtering.test.ts (see there for the split) so each file fits the gate's 30 s budget.

// --- logs --type (the exact event-type filter) ---

test("logs --type prints only events of exactly that type, where --grep substrings", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli logs type exact");
  const now = Date.now();
  const file = eventsLogPath(repo);
  writeLogLines(file, [
    { ts: now - 6000, loop: "feature", type: "merge_failed", commit: COMMIT_A, result: "review_rejected", durationMs: 800 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 5000, loop: "feature", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    // A wake event whose rendered line quotes the word "merge_failed" as its reason text:
    // the exact-vs-substring case — --grep matches the quoted text, --type (an event id,
    // not free text) must not.
    { ts: now - 4000, loop: "clean", type: "wake", reason: "merge_failed" }, // retired-name-ok: legacy event field in a fixture
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
    { ts: now - 40 * 60_000, loop: "feature", type: "merge_failed", commit: COMMIT_A, result: "conflict", durationMs: 800 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 30 * 60_000, loop: "feature", type: "run_start", run: 7 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 20 * 60_000, loop: "feature", type: "review_rejected", head: COMMIT_A, reasons: ["sloppy"], durationMs: 400 }, // retired-name-ok: legacy event field in a fixture
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
    { ts: now - 40 * 60_000, loop: "feature", type: "merge_failed", commit: COMMIT_A, result: "review_rejected", durationMs: 800 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 30 * 60_000, loop: "feature", type: "review_rejected", head: COMMIT_A, reasons: ["sloppy error handling"], durationMs: 400 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 20 * 60_000, loop: "feature", type: "merge_failed", commit: COMMIT_B, result: "conflict", durationMs: 100 }, // retired-name-ok: legacy event field in a fixture
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
    { ts: now - 10 * 60_000, loop: "feature", type: "merge_failed", commit: COMMIT_A, result: "conflict", durationMs: 100 }, // retired-name-ok: legacy event field in a fixture
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
  seedMixedLog(repo); // two merge_failed (review_rejected / build_check), a review_rejected, runs.

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
