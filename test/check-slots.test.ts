import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  acquireCheckSlot,
  checkSlotDir,
  findTeamRoot,
  releaseCheckSlot,
} from "../src/concurrency/check-slots.js";
import { tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { sleep } from "./helpers/wait.js";

// The slot ledger is files under a temp root's `.tumwater/state`, so every case drives a fresh
// fake root offline. A team root needs the `.tumwater/state` dir before findTeamRoot claims it.
function teamRoot(): string {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, ".tumwater", "state"), { recursive: true });
  return root;
}

test("findTeamRoot finds the ancestor holding .tumwater/state", () => {
  const root = teamRoot();
  const nested = path.join(root, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findTeamRoot(nested), root);
  assert.equal(findTeamRoot(tmpdir()), null, "a dir with no .tumwater/state ancestor has no team root");
});

test("at cap 1 a second acquire waits until the first slot is released", async () => {
  const root = teamRoot();
  const first = await acquireCheckSlot(root, 1, 2_000);
  assert.ok(first !== null, "the first acquire claims the only slot");
  let granted = false;
  const pending = acquireCheckSlot(root, 1, 2_000).then((s) => {
    granted = s !== null;
    return s;
  });
  await sleep(150);
  assert.equal(granted, false, "the second acquire is still waiting while the first holds the only slot");
  releaseCheckSlot(first);
  const second = await pending;
  assert.equal(second, first, "the freed slot is claimed by the waiter");
  releaseCheckSlot(second);
});

test("a slot dir whose pid file names a dead pid is reclaimed", async () => {
  const root = teamRoot();
  const dir = checkSlotDir(root, 0);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "pid"), "99999999");
  const slot = await acquireCheckSlot(root, 1, 2_000);
  assert.equal(slot, dir, "the ledger claimed the dead holder's own slot dir");
  releaseCheckSlot(slot);
});

test("releaseCheckSlot leaves a slot dir another pid now owns", async () => {
  const root = teamRoot();
  const slot = await acquireCheckSlot(root, 1, 1_000);
  assert.ok(slot !== null);
  // Simulate the slot being stolen from under us (a successor's claim or a hand-written dir).
  fs.writeFileSync(path.join(slot, "pid"), "12345");
  releaseCheckSlot(slot);
  assert.ok(fs.existsSync(slot), "a robbed holder must not delete its successor's slot dir");
  fs.rmSync(slot, { recursive: true, force: true });
});

test("an all-held ledger returns null once the wait budget is spent", async () => {
  const root = teamRoot();
  const cap = 2;
  assert.ok(await acquireCheckSlot(root, cap, 200));
  assert.ok(await acquireCheckSlot(root, cap, 200));
  const startedAt = Date.now();
  assert.equal(await acquireCheckSlot(root, cap, 150), null, "no slot frees within the budget");
  assert.ok(Date.now() - startedAt >= 100, "the caller actually waited, not a spuriously-null first pass");
});

test("two check-permit.mjs suite runs under a cap of 1 do not overlap on the host", { timeout: 30_000 }, async () => {
  const root = teamRoot();
  writeConfig(root, { maxConcurrentChecks: 1 });
  const startFile = path.join(root, "starts");
  const endFile = path.join(root, "ends");
  // The wrapped suite: record its start, hold ~300 ms so an overlapping run would overlap it, then
  // record its end. It runs AFTER its slot is claimed, so at a cap of 1 the two runs' intervals
  // literally cannot overlap regardless of host load.
  const suite = `const fs=require('fs');const s=Date.now();fs.appendFileSync(process.argv[1],s+'\\n');setTimeout(()=>fs.appendFileSync(process.argv[2],s+'\\n'),300);`;
  const script = path.resolve("scripts/check-permit.mjs");
  const run = () =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, [script, process.execPath, "-e", suite, startFile, endFile], {
        cwd: root,
        stdio: ["ignore", "inherit", "inherit"],
      });
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`check-permit.mjs exited ${code}`))));
      p.on("error", reject);
    });
  await Promise.all([run(), run()]);
  const starts = fs.readFileSync(startFile, "utf8").trim().split("\n").map(Number).sort((a, b) => a - b);
  const ends = fs.readFileSync(endFile, "utf8").trim().split("\n").map(Number).sort((a, b) => a - b);
  assert.equal(starts.length, 2, "both suites ran");
  assert.equal(ends.length, 2);
  assert.ok(
    ends[0]! <= starts[1]!,
    `the two suites overlapped (first ended ${ends[0]} after second started ${starts[1]})`,
  );
});
