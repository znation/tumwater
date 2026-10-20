import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { refSha } from "../src/git/git.js";
import { mergeRefName, rejectedRefName, reviewSessionDir, roleInboxDir, roleNotesPath, sessionDir, statePath } from "../src/paths.js";
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
  const read = (f: string) => fs.readFileSync(f, "utf8");
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
