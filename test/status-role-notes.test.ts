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
import { readRoleNotesOverCap, readRoleLessonsOverCap, collectRoleNotesOverCap } from "../src/status/status-role-notes.js";

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

// The lessons over-cap walk the doctor's `role notes` row reads (readRoleLessonsOverCap):
// every role whose lessons file grew past the 12-lesson or 2 KB store caps, in descending-byte
// order — a hand edit or old build the role's own `add` will now refuse, surfaced rather than
// left silent. Pinned per the part 3/3 acceptance criterion "the doctor surfaces over-cap on the
// lessons file."

function lessonsTree(role: string, text: string): string {
  const root = tmpdir();
  const lessonsDir = path.join(root, ".tumwater", "state", "notes", "lessons");
  fs.mkdirSync(lessonsDir, { recursive: true });
  fs.writeFileSync(path.join(lessonsDir, `${role}.md`), text);
  return root;
}

test("readRoleLessonsOverCap names a lessons file over the byte cap, with its lesson count", () => {
  // 12 lessons of 200 bytes each = 2400 bytes of text, over the 2 KB whole-file cap.
  const lines = Array.from({ length: 12 }, (_, i) => `- L${i + 1} (2026-11-12): ${"a".repeat(180)}`);
  const root = lessonsTree("feature", "<!-- next: L13 -->\n" + lines.join("\n") + "\n");
  const over = readRoleLessonsOverCap(root);
  assert.equal(over.length, 1);
  const first = over[0]!;
  assert.equal(first.role, "feature");
  assert.equal(first.lessons, 12);
  assert.ok(first.bytes > 2048);
});

test("readRoleLessonsOverCap names a lessons file over the 12-lesson count cap (under the byte cap)", () => {
  // 13 short lessons: under 2 KB but over the 12-lesson cap.
  const lines = Array.from({ length: 13 }, (_, i) => `- L${i + 1} (2026-11-12): x`);
  const root = lessonsTree("bugfix", "<!-- next: L14 -->\n" + lines.join("\n") + "\n");
  const over = readRoleLessonsOverCap(root);
  assert.equal(over.length, 1);
  assert.equal(over[0]!.lessons, 13);
  assert.ok(over[0]!.bytes < 2048, "under the byte cap, so the count cap is what fires");
});

test("readRoleLessonsOverCap does not count the next-id marker line, and leaves a healthy store out", () => {
  // A healthy store (2 lessons, tiny): not named. The next-id marker line is not a lesson.
  const root = lessonsTree("planner", "<!-- next: L3 -->\n- L1 (2026-11-12): keep this\n- L2 (2026-11-13): keep that\n");
  assert.deepEqual(readRoleLessonsOverCap(root), []);
});

test("readRoleLessonsOverCap of a missing or unreadable lessons dir is empty, and sorts over-cap roles by byte count", () => {
  assert.deepEqual(readRoleLessonsOverCap(tmpdir()), [], "no lessons dir reads []");
  // Two over-cap roles by byte count: the larger is first. Each is one lesson whose text
  // alone pushes the file over the 2 KB cap.
  const root = tmpdir();
  const dir = path.join(root, ".tumwater", "state", "notes", "lessons");
  fs.mkdirSync(dir, { recursive: true });
  const a = "<!-- next: L2 -->\n" + `- L1 (2026-11-12): ${"a".repeat(2100)}` + "\n";
  const b = "<!-- next: L2 -->\n" + `- L1 (2026-11-12): ${"b".repeat(2300)}` + "\n";
  fs.writeFileSync(path.join(dir, "aa.md"), a);
  fs.writeFileSync(path.join(dir, "bb.md"), b);
  const over = readRoleLessonsOverCap(root);
  assert.equal(over.length, 2);
  assert.equal(over[0]!.role, "bb", "the byte-heavier file is first");
  assert.equal(over[1]!.role, "aa");
});
