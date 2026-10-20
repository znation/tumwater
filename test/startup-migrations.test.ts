import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readMergeQueue } from "../src/merge/merge-queue.js";
import { readEvents } from "../src/events/event-read.js";
import { writeOrchestratorInfo } from "../src/team/orchestrator-info.js";
import { headOf, refSha, setRef } from "../src/git/git.js";
import { mergeRefName, legacyLandingRefName, mergeQueueDir, legacyLandingStatePath, legacyLandQueueDir, orchestratorStatePath } from "../src/paths.js";
import { registerStartupMigration } from "../src/orchestrator/startup-migrations.js";
import { runStartupMigrations, runStartupMigrationsIfIdle } from "../src/orchestrator/startup-migration-steps.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";

function oldLayout(root: string): void {
  const dir = legacyLandQueueDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const e = (role: string, tick: number) => JSON.stringify({ role, sha: "abc", tick, summary: `s ${role}`, enqueuedAt: 1 });
  fs.writeFileSync(path.join(dir, "1000000000001-000000-1.json"), e("a", 4));
  fs.writeFileSync(path.join(dir, "1000000000002-000000-1.json"), e("b", 5));
  fs.writeFileSync(path.join(dir, "1000000000003-000000-1.json"), '{"role":"c"');
}

const migrated = (root: string) => readEvents(root).filter((e) => e.type === "state_migrated");

test("observers read the old layout before any migration, mapping tick to run", () => {
  const root = makeRepo();
  oldLayout(root);
  const view = readMergeQueue(root);
  assert.deepEqual(view.entries.map((e) => [e.role, e.run]), [["a", 4], ["b", 5]]);
  assert.equal(view.unreadable, 1);
});

test("runStartupMigrations migrates the legacy land queue into the merge queue once and logs one state_migrated", async () => {
  const root = makeRepo();
  oldLayout(root);
  await runStartupMigrations(root);
  assert.ok(!fs.existsSync(legacyLandQueueDir(root)));
  assert.equal(fs.readdirSync(mergeQueueDir(root)).length, 3);
  const view = readMergeQueue(root);
  assert.deepEqual(view.entries.map((e) => [e.role, e.run]), [["a", 4], ["b", 5]]);
  assert.equal(view.unreadable, 1);
  assert.equal(migrated(root).length, 1);
  await runStartupMigrations(root);
  assert.equal(migrated(root).length, 1, "a second call logs nothing");
  assert.equal(fs.readdirSync(mergeQueueDir(root)).length, 3);
});

test("a basename already in the new directory is left in the old one", async () => {
  const root = makeRepo();
  oldLayout(root);
  fs.mkdirSync(mergeQueueDir(root), { recursive: true });
  fs.writeFileSync(path.join(mergeQueueDir(root), "1000000000001-000000-1.json"), "{}");
  await runStartupMigrations(root);
  assert.ok(fs.existsSync(path.join(legacyLandQueueDir(root), "1000000000001-000000-1.json")));
  assert.equal(fs.readdirSync(mergeQueueDir(root)).length, 3);
  const ev = migrated(root).filter((e) => e.step === "mergeQueueDir");
  assert.equal(ev.length, 1);
  assert.equal(ev[0]?.moved, 2);
});

test("runStartupMigrationsIfIdle moves nothing while an orchestrator is alive", async () => {
  const root = makeRepo();
  oldLayout(root);
  writeOrchestratorInfo(root, { pid: process.pid, startedAt: Date.now(), roles: ["feature"] });
  await runStartupMigrationsIfIdle(root);
  assert.ok(fs.existsSync(legacyLandQueueDir(root)));
  fs.rmSync(orchestratorStatePath(root));
  await runStartupMigrationsIfIdle(root);
  assert.ok(!fs.existsSync(legacyLandQueueDir(root)));
});

test("registering a duplicate step name throws", () => {
  assert.throws(() => registerStartupMigration({ name: "mergeQueueDir", run: async () => ({ moved: [], kept: [], failed: [] }) }), /already registered/);
});

test("mergingMarker removes a leftover landing.json once", async () => {
  const root = makeRepo();
  const old = legacyLandingStatePath(root);
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, "{}");
  await runStartupMigrations(root);
  assert.ok(!fs.existsSync(old));
  assert.equal(migrated(root).filter((e) => e.step === "mergingMarker").length, 1);
  await runStartupMigrations(root);
  assert.equal(migrated(root).filter((e) => e.step === "mergingMarker").length, 1, "a second start logs nothing");
});

test("mergeRefs moves a legacy pin once, keeps a differing pair, and retire sees a legacy-only pin", async () => {
  const root = makeRepo();
  const sha = await headOf(root, "HEAD");
  const legacy = legacyLandingRefName("improve");
  await setRef(root, legacy, sha);
  await runStartupMigrations(root);
  assert.equal(await refSha(root, mergeRefName("improve")), sha);
  assert.equal(await refSha(root, legacy), null);
  await runStartupMigrations(root);
  assert.equal(await refSha(root, mergeRefName("improve")), sha);

  const other = execFileSync("git", ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "other"], { cwd: root, encoding: "utf8" }).trim();
  await setRef(root, legacyLandingRefName("same"), sha);
  await setRef(root, mergeRefName("same"), sha);
  await setRef(root, legacyLandingRefName("diff"), other);
  await setRef(root, mergeRefName("diff"), sha);
  const diffNew = sha;
  const before = migrated(root).filter((e) => e.step === "mergeRefs").length;
  await runStartupMigrations(root);
  assert.equal(await refSha(root, legacyLandingRefName("same")), null);
  assert.equal(await refSha(root, legacyLandingRefName("diff")), other);
  assert.equal(await refSha(root, mergeRefName("diff")), diffNew);
  const ev = migrated(root).filter((e) => e.step === "mergeRefs");
  assert.equal(ev.length, before + 1);
  assert.equal(ev[ev.length - 1]?.moved, 1);
  assert.match(String(ev[ev.length - 1]?.detail), /kept/);
  await runStartupMigrations(root);
  assert.equal(migrated(root).filter((e) => e.step === "mergeRefs").length, before + 1);
  assert.equal(await refSha(root, legacyLandingRefName("diff")), other);
});

test("a kept-only mergeRefs collision logs no state_migrated event", async () => {
  const root = makeRepo();
  const sha = await headOf(root, "HEAD");
  const other = execFileSync("git", ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "other"], { cwd: root, encoding: "utf8" }).trim();
  await setRef(root, legacyLandingRefName("diff"), other);
  await setRef(root, mergeRefName("diff"), sha);
  await runStartupMigrations(root);
  await runStartupMigrations(root);
  assert.equal(migrated(root).filter((e) => e.step === "mergeRefs").length, 0);
  assert.equal(await refSha(root, legacyLandingRefName("diff")), other);
  assert.equal(await refSha(root, mergeRefName("diff")), sha);
});
