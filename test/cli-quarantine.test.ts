import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { initProject } from "../src/init/init.js";
import { quarantinePath } from "../src/paths.js";
import { loadQuarantine } from "../src/review/known-flakes.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import type { QuarantineRow } from "../src/review/quarantine-render.js";

// The `quarantine` command: the read-only list of the flake quarantine, via the CLI the way
// the cli-queue tests `queue` — an initialized repo, child-process runs, output assertions.

function writeQuarantine(repo: string, tests: unknown[]): void {
  writeFileDeep(quarantinePath(repo), JSON.stringify({ tests }));
}

test("quarantine prints the empty line and exits 0 with no quarantine file", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine empty test");
  const r = await cli(repo, "quarantine");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "flake quarantine is empty");
});

test("quarantine lists every entry oldest first with age, flake count and filed bug", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine list test");
  const now = Date.now();
  writeQuarantine(repo, [
    { test: "test/new.test.ts", firstSeen: now - 3_600_000, lastSeen: now, count: 1, bug: "" },
    { test: "test/old.test.ts", firstSeen: now - 2 * 24 * 3_600_000, lastSeen: now - 24 * 3_600_000, count: 3, bug: "A filed flake" },
  ]);
  const r = await cli(repo, "quarantine");
  assert.equal(r.code, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines[0], "flake quarantine: 2 tests");
  assert.equal(lines.length, 3, "header plus one line per row; no warning for a quiet list");
  assert.match(lines[1]!, /^1\. test\/old\.test\.ts .*3 flakes — filed: A filed flake$/);
  assert.match(lines[2]!, /^2\. test\/new\.test\.ts .*1 flake — not filed$/);
});

test("quarantine --json serves the positioned rows in oldest-first order", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine json test");
  const now = Date.now();
  writeQuarantine(repo, [
    { test: "test/new.test.ts", firstSeen: now - 3_600_000, lastSeen: now, count: 1, bug: "" },
    { test: "test/old.test.ts", firstSeen: now - 4 * 24 * 3_600_000, lastSeen: now - 24 * 3_600_000, count: 3, bug: "A filed flake" },
  ]);
  const r = await cli(repo, "quarantine", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { tests: QuarantineRow[] };
  assert.equal(payload.tests.length, 2);
  const [first, second] = payload.tests;
  assert.equal(first!.position, 1);
  assert.equal(first!.test, "test/old.test.ts");
  assert.equal(first!.count, 3);
  assert.equal(first!.bug, "A filed flake");
  assert.equal(second!.position, 2);
  assert.equal(second!.test, "test/new.test.ts");
  assert.equal(second!.bug, "");
  assert.ok(typeof first!.firstSeen === "number" && typeof first!.lastSeen === "number");
});

test("quarantine rejects an unknown flag, naming it", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine flag test");
  const r = await cli(repo, "quarantine", "--bogus");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("--bogus"));
});

test("quarantine is read-only — the list is unchanged after the command", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine read-only test");
  const now = Date.now();
  const tests = [
    { test: "test/a.test.ts", firstSeen: now - 24 * 3_600_000, lastSeen: now, count: 2, bug: "flaky" },
  ];
  writeQuarantine(repo, tests);
  const before = loadQuarantine(repo);
  await cli(repo, "quarantine");
  await cli(repo, "quarantine", "--json");
  assert.deepEqual(JSON.parse(fs.readFileSync(quarantinePath(repo), "utf8")), { tests });
  assert.deepEqual(loadQuarantine(repo), before);
});

test("quarantine --release <n> removes the Nth entry and names it", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine release test");
  const now = Date.now();
  writeQuarantine(repo, [
    { test: "test/new.test.ts", firstSeen: now - 3_600_000, lastSeen: now, count: 1, bug: "" },
    { test: "test/old.test.ts", firstSeen: now - 2 * 24 * 3_600_000, lastSeen: now - 24 * 3_600_000, count: 3, bug: "A filed flake" },
  ]);
  const r = await cli(repo, "quarantine", "--release", "1");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "released quarantined test 1: test/old.test.ts — the gate no longer excuses it");
  assert.deepEqual(loadQuarantine(repo).map((e) => e.test), ["test/new.test.ts"]);
  const again = await cli(repo, "quarantine");
  assert.equal(again.code, 0);
  assert.ok(!again.stdout.includes("old.test.ts"), "the released line is gone from the list");
});

test("quarantine --release <n> refuses an out-of-range position naming the depth", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine release range test");
  const now = Date.now();
  const tests = [
    { test: "test/a.test.ts", firstSeen: now - 24 * 3_600_000, lastSeen: now, count: 1, bug: "" },
  ];
  writeQuarantine(repo, tests);
  const before = fs.readFileSync(quarantinePath(repo), "utf8");
  const r = await cli(repo, "quarantine", "--release", "2");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("no quarantined test at position 2 (flake quarantine holds 1 tests)"));
  assert.equal(fs.readFileSync(quarantinePath(repo), "utf8"), before, "the file is byte-unchanged");
});

test("quarantine --release --json prints the released row", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine release json test");
  const now = Date.now();
  writeQuarantine(repo, [
    { test: "test/new.test.ts", firstSeen: now - 3_600_000, lastSeen: now, count: 1, bug: "" },
    { test: "test/old.test.ts", firstSeen: now - 2 * 24 * 3_600_000, lastSeen: now - 24 * 3_600_000, count: 3, bug: "A filed flake" },
  ]);
  const r = await cli(repo, "quarantine", "--release", "1", "--json");
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), { released: { position: 1, test: "test/old.test.ts" } });
});

test("quarantine --release with no value fails", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine release novalue test");
  const r = await cli(repo, "quarantine", "--release");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("--release needs a position"));
});

test("quarantine --release refuses an unknown flag beside it by name", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine release flag test");
  const r = await cli(repo, "quarantine", "--release", "1", "--bogus");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("--bogus"));
});

test("quarantine --release <n> -f is refused — the destructive branch keeps its own flag gate", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine release follow test");
  const now = Date.now();
  writeQuarantine(repo, [{ test: "test/a.test.ts", firstSeen: now - 24 * 3_600_000, lastSeen: now, count: 1, bug: "" }]);
  const before = loadQuarantine(repo);
  const r = await cli(repo, "quarantine", "--release", "1", "-f");
  assert.equal(r.code, 1, "-f beside --release is refused, not followed");
  assert.ok(r.stderr.includes("-f"), "the refusal names the -f flag");
  assert.deepEqual(loadQuarantine(repo), before, "the destructive branch was not run");
});

test("quarantine --show <n> prints the Nth entry in full, unsquashed, and leaves the file unchanged", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine show test");
  const now = Date.now();
  const long = `test/${"a".repeat(120)}.test.ts`;
  const bug = `BUGS.md ${"b".repeat(100)} flake heading ${"c".repeat(40)}`;
  writeQuarantine(repo, [
    { test: "test/shorter.test.ts", firstSeen: now - 2 * 24 * 3_600_000, lastSeen: now - 24 * 3_600_000, count: 2, bug: "" },
    { test: long, firstSeen: now - 24 * 3_600_000, lastSeen: now - 3_600_000, count: 3, bug, tail: "line1\nline2\nline3" },
    { test: "test/plain.test.ts", firstSeen: now - 3_600_000, lastSeen: now, count: 1, bug: "", recurred: true },
  ]);
  const before = fs.readFileSync(quarantinePath(repo), "utf8");
  const list = await cli(repo, "quarantine");
  assert.equal(list.code, 0);
  assert.ok(!list.stdout.includes(long), "the plain list squashes the long path");
  assert.ok(!list.stdout.includes(bug), "the plain list squashes the long bug heading");
  const r = await cli(repo, "quarantine", "--show", "2");
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes(`quarantined test 2: ${long}`), "detail prints the whole test path");
  assert.ok(r.stdout.includes(`filed: ${bug}`), "detail prints the whole bug heading");
  assert.ok(r.stdout.includes("failing output:\nline1\nline2\nline3"), "the tail prints verbatim");
  assert.ok(!r.stdout.includes("recurred since its bug last heard of it"), "a non-recurred entry carries no recurrence line");
  const rec = await cli(repo, "quarantine", "--show", "3");
  assert.equal(rec.code, 0);
  assert.ok(rec.stdout.includes("quarantined test 3: test/plain.test.ts"));
  assert.ok(rec.stdout.includes("recurred since its bug last heard of it"));
  assert.ok(!rec.stdout.includes("failing output:"), "an entry without a tail prints no failing-output line");
  assert.equal(fs.readFileSync(quarantinePath(repo), "utf8"), before, "the quarantine file is byte-unchanged after a shown entry");
});

test("quarantine --show <n> --json prints the entry's fields, omitting absent tail and recurred", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine show json test");
  const now = Date.now();
  const long = `test/${"a".repeat(120)}.test.ts`;
  writeQuarantine(repo, [
    { test: long, firstSeen: now - 24 * 3_600_000, lastSeen: now - 3_600_000, count: 3, bug: "", tail: "line1\nline2" },
    { test: "test/plain.test.ts", firstSeen: now - 3_600_000, lastSeen: now, count: 1, bug: "A filed flake", recurred: true },
  ]);
  const r = await cli(repo, "quarantine", "--show", "1", "--json");
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    position: 1, test: long, firstSeen: now - 24 * 3_600_000, lastSeen: now - 3_600_000, count: 3, bug: "", tail: "line1\nline2",
  });
  assert.ok(!("recurred" in JSON.parse(r.stdout)), "recurred is absent for an entry that lacks it");
  const r2 = await cli(repo, "quarantine", "--show", "2", "--json");
  assert.equal(r2.code, 0);
  assert.ok(!r2.stdout.includes("quarantined test"), "--json prints no header text");
  const obj = JSON.parse(r2.stdout) as Record<string, unknown>;
  assert.deepEqual(obj, { position: 2, test: "test/plain.test.ts", firstSeen: now - 3_600_000, lastSeen: now, count: 1, bug: "A filed flake", recurred: true });
});

test("quarantine --show <n> fails past the depth naming it, and on an empty list reports position 1 with a depth of 0", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine show range test");
  const now = Date.now();
  writeQuarantine(repo, [{ test: "test/a.test.ts", firstSeen: now - 3_600_000, lastSeen: now, count: 1, bug: "" }]);
  const before = fs.readFileSync(quarantinePath(repo), "utf8");
  const r = await cli(repo, "quarantine", "--show", "2");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("no quarantined test at position 2 (flake quarantine holds 1 tests)"));
  assert.equal(fs.readFileSync(quarantinePath(repo), "utf8"), before, "the file is byte-unchanged");
  const empty = makeRepo();
  await initProject(empty, "quarantine show empty test");
  const e = await cli(empty, "quarantine", "--show", "1");
  assert.equal(e.code, 1, "no quarantine file degrades to an empty list, so position 1 is past the end");
  assert.ok(e.stderr.includes("no quarantined test at position 1 (flake quarantine holds 0 tests)"));
});

test("quarantine --show refuses --release, -f and a missing, zero or non-integer position", async () => {
  const repo = makeRepo();
  await initProject(repo, "quarantine show flag test");
  const now = Date.now();
  writeQuarantine(repo, [{ test: "test/a.test.ts", firstSeen: now - 3_600_000, lastSeen: now, count: 1, bug: "" }]);
  let r = await cli(repo, "quarantine", "--show", "1", "--release");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("--release"), "the refusal names --release");
  r = await cli(repo, "quarantine", "--show", "1", "-f");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("-f"), "the refusal names -f");
  r = await cli(repo, "quarantine", "--show");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("--show needs a position"), "missing position fails with the --show 2 usage wording");
  r = await cli(repo, "quarantine", "--show", "0");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("positive integer"));
  r = await cli(repo, "quarantine", "--show", "abc");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("positive integer"));
});
