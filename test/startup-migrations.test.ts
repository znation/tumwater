import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readLandingQueue } from "../src/landing/landing-queue.js";
import { readEvents } from "../src/events/event-read.js";
import { writeOrchestratorInfo } from "../src/fleet/orchestrator-info.js";
import { landQueueDir, legacyLandQueueDir, orchestratorStatePath } from "../src/paths.js";
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
  const view = readLandingQueue(root);
  assert.deepEqual(view.entries.map((e) => [e.role, e.run]), [["a", 4], ["b", 5]]);
  assert.equal(view.unreadable, 1);
});

test("runStartupMigrations moves the land queue once and logs one state_migrated", async () => {
  const root = makeRepo();
  oldLayout(root);
  await runStartupMigrations(root);
  assert.ok(!fs.existsSync(legacyLandQueueDir(root)));
  assert.equal(fs.readdirSync(landQueueDir(root)).length, 3);
  const view = readLandingQueue(root);
  assert.deepEqual(view.entries.map((e) => [e.role, e.run]), [["a", 4], ["b", 5]]);
  assert.equal(view.unreadable, 1);
  assert.equal(migrated(root).length, 1);
  await runStartupMigrations(root);
  assert.equal(migrated(root).length, 1, "a second call logs nothing");
  assert.equal(fs.readdirSync(landQueueDir(root)).length, 3);
});

test("a basename already in the new directory is left in the old one", async () => {
  const root = makeRepo();
  oldLayout(root);
  fs.mkdirSync(landQueueDir(root), { recursive: true });
  fs.writeFileSync(path.join(landQueueDir(root), "1000000000001-000000-1.json"), "{}");
  await runStartupMigrations(root);
  assert.ok(fs.existsSync(path.join(legacyLandQueueDir(root), "1000000000001-000000-1.json")));
  assert.equal(fs.readdirSync(landQueueDir(root)).length, 3);
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
  assert.throws(() => registerStartupMigration({ name: "mergeQueueDir", run: async () => [] }), /already registered/);
});
