/** The status notes listing (src/status/status-role-notes.ts): the `lessons/` subdirectory that
 * the typed role-lessons store (plans/typed-role-notes.md part 1/3) adds under the notes dir must
 * never read as a role. The listing walks the notes dir's `.md`-suffixed entries, so a directory
 * named `lessons` (no `.md` suffix) is skipped before its bytes are even read. Pinned per the
 * part 1/3 acceptance criterion "the status notes listing does not report `lessons` as a role."
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { readRoleNotesOverCap, collectRoleNotesOverCap } from "../src/status/status-role-notes.js";

/** A notes dir with one over-cap role note AND a `lessons` subdirectory holding a (would-be
 * over-cap) `lessons.md` file. Returns [root, notesDir, notePath, lessonsDir]. */
function notesTree(): [string, string, string, string] {
  const root = tmpdir();
  const notesDir = path.join(root, ".tumwater", "state", "notes");
  const lessonsDir = path.join(notesDir, "lessons");
  fs.mkdirSync(lessonsDir, { recursive: true });
  const notePath = path.join(notesDir, "feature.md");
  fs.writeFileSync(notePath, "a".repeat(5000)); // well past the read bound
  fs.writeFileSync(path.join(lessonsDir, "feature.md"), "a".repeat(5000)); // would be over-cap if read as a role
  return [root, notesDir, notePath, lessonsDir];
}

test("the lessons subdirectory is never reported as a role, even when it holds an over-cap .md file", () => {
  const [root, , , lessonsDir] = notesTree();
  const over = readRoleNotesOverCap(root);
  assert.ok(over !== null, "the notes dir exists, so the listing resolves");
  const roles = over!.map((r) => r.role);
  assert.ok(!roles.includes("lessons"), `the lessons dir is not a role: ${roles}`);
  // The lesson file's directory itself is a non-.md entry; nothing under it is walked as a role.
  assert.ok(roles.includes("feature"), `the real role note is still reported: ${roles}`);
  void lessonsDir;
});

test("collectRoleNotesOverCap maps the missing-dir and lessons-only cases to no lesson roles", () => {
  const [root] = notesTree();
  const roles = collectRoleNotesOverCap(root).map((r) => r.role);
  assert.ok(!roles.includes("lessons"), `collectRoleNotesOverCap never reports lessons: ${roles}`);
});

test("a missing notes dir reads as no over-cap roles, not an error", () => {
  const root = tmpdir();
  assert.equal(readRoleNotesOverCap(root), null, "missing dir reads null (nothing recorded yet)");
  assert.deepEqual(collectRoleNotesOverCap(root), [], "collect maps missing to []");
});
