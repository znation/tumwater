import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { refSha } from "../src/git/git.js";
import { mergeRefName, rejectedRefName, reviewSessionDir, roleInboxDir, roleNotesPath, sessionDir, statePath } from "../src/paths.js";
import { readJsonFile, writeJsonFile } from "../src/files/json-files.js";
import { migrateLegacyRoleIds } from "../src/roles/legacy-role-migration.js";
import { makeRepo, sh } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

const MAP = { oldy: "newy" };

function put(file: string, text: string): void {
  writeFileDeep(file, text);
}

function oldRole(root: string): { sha: string; log: string } {
  const sha = sh(root, "git", "rev-parse", "HEAD");
  sh(root, "git", "branch", "tumwater/oldy");
  sh(root, "git", "update-ref", mergeRefName("oldy"), sha);
  sh(root, "git", "update-ref", rejectedRefName("oldy"), sha);
  put(statePath(root, "oldy"), "state");
  put(roleNotesPath(root, "oldy"), "notes");
  put(path.join(roleInboxDir(root, "oldy"), "x.md"), "inbox");
  put(path.join(sessionDir(root, "oldy"), "s.jsonl"), "session");
  put(path.join(reviewSessionDir(root, "oldy"), "r.jsonl"), "review");
  const log = path.join(root, ".tumwater", "logs", "pi-oldy.log");
  put(log, "history");
  return { sha, log };
}

test("migrating a state file rewrites its role field to the new id", async () => {
  const root = makeRepo();
  put(statePath(root, "oldy"), JSON.stringify({ role: "oldy", runs: 5, lastRunEndedAt: 123 }));
  await migrateLegacyRoleIds(root, MAP);
  const parsed = JSON.parse(fs.readFileSync(statePath(root, "newy"), "utf8"));
  assert.equal(parsed.role, "newy", "the moved file's role is rewritten to the new id");
  assert.equal(parsed.runs, 5, "the moved file's other data is preserved");
  assert.equal(fs.existsSync(statePath(root, "oldy")), false);
});

test("when both state files exist, the newer by lastRunEndedAt wins under the new id", async () => {
  const root = makeRepo();
  put(statePath(root, "oldy"), JSON.stringify({ role: "oldy", runs: 9, lastRunEndedAt: 2000 }));
  put(statePath(root, "newy"), JSON.stringify({ role: "newy", runs: 1, lastRunEndedAt: 1000 }));
  await migrateLegacyRoleIds(root, MAP);
  const parsed = JSON.parse(fs.readFileSync(statePath(root, "newy"), "utf8"));
  assert.equal(parsed.runs, 9, "the newer old-id file's data replaced the stale new-id copy");
  assert.equal(parsed.role, "newy", "the healed file's role is rewritten to the new id");
  assert.equal(fs.existsSync(statePath(root, "oldy")), false);
});

test("when both state files exist and the new-id file is newer, it is kept unchanged", async () => {
  const root = makeRepo();
  put(statePath(root, "oldy"), JSON.stringify({ role: "oldy", runs: 1, lastRunEndedAt: 1000 }));
  put(statePath(root, "newy"), JSON.stringify({ role: "newy", runs: 7, lastRunEndedAt: 3000 }));
  await migrateLegacyRoleIds(root, MAP);
  const parsed = JSON.parse(fs.readFileSync(statePath(root, "newy"), "utf8"));
  assert.equal(parsed.runs, 7, "the newer new-id copy is not overwritten by an older old-id one");
  assert.equal(fs.existsSync(statePath(root, "oldy")), true, "the old-id file is left in place (kept both exist)");
});

test("the rewritten state file is committed atomically, never written in place", async () => {
  const root = makeRepo();
  put(statePath(root, "oldy"), JSON.stringify({ role: "oldy", runs: 5, lastRunEndedAt: 123 }));
  const target = statePath(root, "newy");
  const wroteInPlace: string[] = [];
  const original = fs.writeFileSync;
  // Inject the fault: record (and let through) every write, flagging any that targets the
  // state file itself. A plain writeFileSync truncates the target then fills it, so a crash
  // mid-write leaves the state torn; committing via writeJsonAtomic's tmp+rename only ever
  // calls writeFileSync on a `.tmp-` path and swaps the target with rename, so the target is
  // never observed in a partial state.
  fs.writeFileSync = ((file: unknown, ...rest: unknown[]): void => {
    const p = String(file);
    if (p === target) wroteInPlace.push(p);
    (original as (f: unknown, ...r: unknown[]) => void)(file, ...rest);
  }) as typeof fs.writeFileSync;
  try {
    await migrateLegacyRoleIds(root, MAP);
  } finally {
    fs.writeFileSync = original;
  }
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).role, "newy", "the migration still rewrites the role");
  assert.equal(fs.existsSync(statePath(root, "oldy")), false);
  assert.deepEqual(wroteInPlace, [], "the state target is never written in place, only via atomic rename");
});

const read = (f: string) => fs.readFileSync(f, "utf8");

test("a legacy role id's branch, refs and files move to the new id; logs stay", async () => {
  const root = makeRepo();
  const { sha, log } = oldRole(root);
  const notes = await migrateLegacyRoleIds(root, MAP);
  assert.equal(notes.moved.length, 8);
  assert.deepEqual([notes.kept, notes.failed], [[], []]);
  assert.equal(await refSha(root, "refs/heads/tumwater/newy"), sha);
  assert.equal(await refSha(root, "refs/heads/tumwater/oldy"), null);
  for (const ref of [mergeRefName, rejectedRefName]) {
    assert.equal(await refSha(root, ref("newy")), sha);
    assert.equal(await refSha(root, ref("oldy")), null);
  }
  assert.equal(read(statePath(root, "newy")), "state");
  assert.equal(read(roleNotesPath(root, "newy")), "notes");
  assert.equal(read(path.join(roleInboxDir(root, "newy"), "x.md")), "inbox");
  assert.equal(read(path.join(sessionDir(root, "newy"), "s.jsonl")), "session");
  assert.equal(read(path.join(reviewSessionDir(root, "newy"), "r.jsonl")), "review");
  for (const f of [statePath, roleNotesPath, roleInboxDir, sessionDir, reviewSessionDir]) assert.equal(fs.existsSync(f(root, "oldy")), false);
  assert.equal(read(log), "history");
  assert.deepEqual(await migrateLegacyRoleIds(root, MAP), { moved: [], kept: [], failed: [] });
});

test("an artifact already under the new id is kept and reported", async () => {
  const root = makeRepo();
  oldRole(root);
  sh(root, "git", "branch", "tumwater/newy");
  put(statePath(root, "newy"), "fresh");
  const notes = await migrateLegacyRoleIds(root, MAP);
  assert.ok(notes.kept.some((n) => n.startsWith("kept branch tumwater/oldy")));
  assert.ok(!notes.moved.some((n) => n.startsWith("kept")));
  assert.notEqual(await refSha(root, "refs/heads/tumwater/oldy"), null);
  assert.equal(fs.readFileSync(statePath(root, "newy"), "utf8"), "fresh");
  assert.equal(fs.readFileSync(statePath(root, "oldy"), "utf8"), "state");
  assert.equal(fs.readFileSync(roleNotesPath(root, "newy"), "utf8"), "notes");
});

test("the real id table moves dry's state file and branch to dedupe", async () => {
  const root = makeRepo();
  const sha = sh(root, "git", "rev-parse", "HEAD");
  sh(root, "git", "branch", "tumwater/dry");
  put(statePath(root, "dry"), "state");
  await migrateLegacyRoleIds(root);
  assert.equal(await refSha(root, "refs/heads/tumwater/dedupe"), sha);
  assert.equal(await refSha(root, "refs/heads/tumwater/dry"), null);
  assert.equal(fs.readFileSync(statePath(root, "dedupe"), "utf8"), "state");
  assert.equal(fs.existsSync(statePath(root, "dry")), false);
});

// The split BUGS.md 2026-10-23 describes: the new-id file holds the frozen copy (a state the
// earlier migration renamed without rewriting `role`, so the runner kept saving under the old-id
// name) while the old-id file holds the live runner's newer state. The frozen copy is exactly the
// stranded shape the real selfcheck.json/dedupe.json carry — the pre-rename ticks/lastTickEndedAt
// fields and no lastRunEndedAt — while the live copy is the modern shape. The migration heals
// the pair into one file by keeping the copy with the newer end-of-run stamp under the new name;
// the newer copy lives under the old-id name, so it must win (the load-side fix then reads it
// under the new id and saves back to the new name).
test("the state heal folds both id-named files into the newer copy under the new name", async () => {
  const root = makeRepo();
  sh(root, "git", "branch", "tumwater/newy");
  // Frozen copy under the new id name: pre-rename shape (ticks/lastTickEndedAt, no lastRunEndedAt).
  writeJsonFile(statePath(root, "newy"), { role: "newy", ticks: 9, lastTickEndedAt: 100 });
  // Live copy under the old id name: the modern shape the live runner actually writes.
  writeJsonFile(statePath(root, "oldy"), { role: "oldy", runs: 9, lastRunEndedAt: 1000 });
  const notes = await migrateLegacyRoleIds(root, MAP);
  assert.ok(notes.moved.some((n) => n.startsWith("healed ")), "the split is healed, not left kept");
  const healed = readJsonFile(statePath(root, "newy")) as { lastRunEndedAt: number };
  assert.equal(healed.lastRunEndedAt, 1000, "the newer (old-id) copy wins under the new name");
  assert.equal(fs.existsSync(statePath(root, "oldy")), false, "the stale old-id copy is dropped");
  assert.deepEqual(notes.failed, []);
});
