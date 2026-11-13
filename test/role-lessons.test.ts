/** The typed role-lessons store (plans/typed-role-notes.md part 1/3): parse, render, and the
 * add/replace/retire mutation helpers in src/roles/role-notes-write.ts. These are pure apart
 * from the atomic file write, so they are tested against a temp path, never a real model.
 * Expected values are worked out from the file format contract, not by calling the code:
 *   <!-- next: L<n> -->          (first line; n = next unused id)
 *   - L<n> (YYYY-MM-DD): <text>  (one lesson per line, ids increasing)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import {
  ROLE_LESSON_MAX_BYTES,
  ROLE_LESSONS_MAX_BYTES,
  ROLE_LESSONS_MAX_COUNT,
  addRoleLesson,
  parseRoleLessons,
  readRoleLessons,
  replaceRoleLesson,
  renderRoleLessons,
  retireRoleLesson,
  validateRoleLesson,
  writeRoleLessons,
} from "../src/roles/role-notes-write.js";

/** A lessons file path under a fresh temp dir. */
function lessonsFile(): string {
  return path.join(tmpdir(), "state", "notes", "lessons", "feature.md");
}

test("parseRoleLessons of the empty string is the empty store (next id L1, no lessons)", () => {
  assert.deepEqual(parseRoleLessons(""), { nextId: 1, lessons: [] });
});

test("parseRoleLessons of a marker-only file is the empty store", () => {
  assert.deepEqual(parseRoleLessons("<!-- next: L1 -->\n"), { nextId: 1, lessons: [] });
});

test("parseRoleLessons reads the next-id marker and the lessons in file order", () => {
  const text = ["<!-- next: L3 -->", "- L1 (2026-11-12): first lesson", "- L2 (2026-11-13): second lesson"].join("\n") + "\n";
  assert.deepEqual(parseRoleLessons(text), {
    nextId: 3,
    lessons: [
      { id: "L1", date: "2026-11-12", text: "first lesson" },
      { id: "L2", date: "2026-11-13", text: "second lesson" },
    ],
  });
});

test("renderRoleLessons is the inverse of parseRoleLessons (round trip)", () => {
  const lessons = [
    { id: "L1", date: "2026-11-12", text: "keep the test runner out of the repo root" },
    { id: "L2", date: "2026-11-13", text: "the since-last-run block is synchronous" },
  ];
  const text = renderRoleLessons(3, lessons);
  assert.equal(text, `<!-- next: L3 -->\n- L1 (2026-11-12): keep the test runner out of the repo root\n- L2 (2026-11-13): the since-last-run block is synchronous\n`);
  assert.deepEqual(parseRoleLessons(text), { nextId: 3, lessons });
});

test("parseRoleLessons refuses a file whose first line is not the next-id marker", () => {
  assert.throws(() => parseRoleLessons("- L1 (2026-11-12): a lesson\n"), /next-id marker/);
});

test("parseRoleLessons refuses a lesson line that is not in the stored form", () => {
  assert.throws(() => parseRoleLessons("<!-- next: L1 -->\nnot a lesson line\n"), /must be "- L<n>/);
});

test("parseRoleLessons refuses an id that is reused or out of order", () => {
  // L2 then L1: the second is not after the first.
  assert.throws(() => parseRoleLessons("<!-- next: L3 -->\n- L2 (2026-11-12): a\n- L1 (2026-11-13): b\n"), /reused or out of order/);
});

test("parseRoleLessons refuses a next-id counter that is not past the highest stored id", () => {
  assert.throws(() => parseRoleLessons("<!-- next: L1 -->\n- L2 (2026-11-12): a\n"), /not past its highest id/);
});

test("validateRoleLesson accepts a single short paragraph and rejects empty, multi-line, and over-cap text", () => {
  assert.equal(validateRoleLesson("a real lesson"), null, "a short paragraph is valid");
  assert.match(validateRoleLesson("") ?? "", /must not be empty/);
  assert.match(validateRoleLesson("  \n ") ?? "", /must not be empty/);
  assert.match(validateRoleLesson("line one\nline two") ?? "", /single paragraph/);
  assert.equal(validateRoleLesson("a".repeat(ROLE_LESSON_MAX_BYTES)), null, "exactly at the per-lesson limit");
  assert.match(validateRoleLesson("a".repeat(ROLE_LESSON_MAX_BYTES + 1)) ?? "", /shorten it to at most 300 bytes/);
});

test("addRoleLesson assigns the store's next id and writes the file atomically", () => {
  const file = lessonsFile();
  assert.equal(addRoleLesson(file, "first lesson", "2026-11-12"), "L1");
  assert.equal(addRoleLesson(file, "second lesson", "2026-11-13"), "L2");
  assert.equal(fs.readFileSync(file, "utf8"), `<!-- next: L3 -->\n- L1 (2026-11-12): first lesson\n- L2 (2026-11-13): second lesson\n`);
});

test("a retired id is never reused: retire L1 then add gives L3, not L1", () => {
  const file = lessonsFile();
  addRoleLesson(file, "first", "2026-11-12"); // L1
  addRoleLesson(file, "second", "2026-11-12"); // L2
  retireRoleLesson(file, "L1");
  assert.equal(addRoleLesson(file, "third", "2026-11-12"), "L3", "the next id advances past the retired one");
  assert.deepEqual(readRoleLessons(file).lessons.map((l) => l.id), ["L2", "L3"]);
});

test("replaceRoleLesson keeps the id, takes the new date, and updates the text", () => {
  const file = lessonsFile();
  addRoleLesson(file, "original text", "2026-11-12"); // L1
  replaceRoleLesson(file, "L1", "amended text", "2026-11-13");
  const { nextId, lessons } = readRoleLessons(file);
  assert.equal(nextId, 2, "replace does not advance the next id");
  assert.deepEqual(lessons, [{ id: "L1", date: "2026-11-13", text: "amended text" }]);
});

test("replaceRoleLesson and retireRoleLesson refuse an unknown id without writing", () => {
  const file = lessonsFile();
  addRoleLesson(file, "only", "2026-11-12"); // L1
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => replaceRoleLesson(file, "L9", "nope", "2026-11-13"), /no lesson L9 to replace/);
  assert.throws(() => retireRoleLesson(file, "L9"), /no lesson L9 to retire/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "a refused mutation leaves the file untouched");
});

test("a 13th lesson is refused with the count cap, and the file is left unchanged", () => {
  const file = lessonsFile();
  for (let n = 1; n <= ROLE_LESSONS_MAX_COUNT; n++) addRoleLesson(file, `lesson ${n}`, "2026-11-12");
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => addRoleLesson(file, "one more", "2026-11-12"), /lessons full \(12\/12\)/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("a lesson that would push the whole file past the byte cap is refused and the file is unchanged", () => {
  const file = lessonsFile();
  // Six lessons of 290 bytes of text each sit just under the 2 KB cap; a seventh of the same
  // size pushes the rendered file over it. 290 < the 300 per-lesson cap, so the whole-file cap
  // — not the per-lesson cap — is what fires.
  for (let n = 1; n <= 6; n++) addRoleLesson(file, "a".repeat(290), "2026-11-12");
  const before = fs.readFileSync(file, "utf8");
  assert.ok(Buffer.byteLength(before, "utf8") < ROLE_LESSONS_MAX_BYTES, "six lessons fit under the cap");
  assert.throws(() => addRoleLesson(file, "a".repeat(290), "2026-11-12"), /shorten it to at most 2048 bytes/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("writeRoleLessons writes through the atomic path and leaves no temp remnant in the lessons dir", () => {
  const file = lessonsFile();
  writeRoleLessons(file, 1, []); // a marker-only file
  assert.equal(fs.readFileSync(file, "utf8"), "<!-- next: L1 -->\n");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp-")), [], "no temp remnant");
});
