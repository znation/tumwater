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
