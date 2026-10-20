import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  pauseRole,
  pausedRoles,
  pausedRolesUntil,
  resumeRole,
  standingRolePause,
} from "../src/team/team-state.js";
import { pausedRolesPath } from "../src/paths.js";
import { ensureParentDir } from "../src/files/files.js";
import { readJson } from "./helpers/json-read.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

function writeMarker(root: string, marker: object): string {
  const file = pausedRolesPath(root);
  ensureParentDir(file);
  fs.writeFileSync(file, JSON.stringify(marker));
  return file;
}

test("a paused-roles marker naming a legacy id pauses and resumes the canonical role", () => {
  const root = tmpdir();
  const file = writeMarker(root, { roles: ["dry", "docs"], at: Date.now() });
  assert.deepEqual(pausedRoles(root), ["dedupe", "docs"]);
  assert.equal(pauseRole(root, "dedupe"), false);
  assert.equal(resumeRole(root, "docs"), true);
  assert.deepEqual((readJson(file) as { roles: string[] }).roles, ["dedupe"]);
  assert.equal(resumeRole(root, "dedupe"), true);
  assert.equal(fs.existsSync(file), false);
});

test("an empty paused-roles set carries no deadline, and a non-empty one carries its future deadline", () => {
  const root = tmpdir();
  const until = Date.now() + 3_600_000;
  writeMarker(root, { roles: [], at: Date.now(), until });
  assert.deepEqual(standingRolePause(root), { roles: [] });
  assert.equal(pausedRolesUntil(root), undefined);
  pauseRole(root, "clean");
  assert.deepEqual(standingRolePause(root), { roles: ["clean"], until });
  assert.equal(pausedRolesUntil(root), until);
});
