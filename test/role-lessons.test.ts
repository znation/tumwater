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
  roleLessonLine,
  roleLessonsText,
  retireRoleLesson,
  validateRoleLesson,
  writeRoleLessons,
  clearRoleLessons,
  roleLessonUsage,
} from "../src/roles/role-notes-write.js";

test("roleLessonUsage reports the count the add cap refuses at, and counts the marker line", () => {
  const file = lessonsFile();
  for (let n = 1; n <= ROLE_LESSONS_MAX_COUNT; n++) addRoleLesson(file, `lesson ${n}`, "2026-11-12");
  const store = readRoleLessons(file);
  // The 12-lesson store the "a 13th lesson is refused with the count cap" case builds: the count
  // is the figure `addRoleLesson` compares against ROLE_LESSONS_MAX_COUNT, so 12 is the figure a
  // refusal names. The byte figure is the writer's own — the file it just wrote, marker line
  // included — and so exceeds roleLessonsText's length, which drops the marker and the newline.
  assert.equal(roleLessonUsage(store.lessons, store.nextId).lessons, ROLE_LESSONS_MAX_COUNT);
  assert.equal(roleLessonUsage(store.lessons, store.nextId).bytes, fs.statSync(file).size);
  assert.ok(
    roleLessonUsage(store.lessons, store.nextId).bytes > Buffer.byteLength(roleLessonsText(store.lessons), "utf8"),
    "the figure counts the marker line roleLessonsText drops",
  );
});

test("roleLessonUsage reports the whole-file figure the byte cap refuses at", () => {
  const file = lessonsFile();
  // The store the whole-file byte-cap case builds: six lessons of 290 bytes of text each, under
  // the 2 KB cap, so the seventh of the same size is what the writer refuses. Worked out from the
  // file format contract: the next-id marker, one lesson line each, a trailing newline.
  for (let n = 1; n <= 6; n++) addRoleLesson(file, "a".repeat(290), "2026-11-12");
  const store = readRoleLessons(file);
  const line = (n: number): string => `- L${n} (2026-11-12): ${"a".repeat(290)}`;
  const under = `<!-- next: L7 -->\n${[1, 2, 3, 4, 5, 6].map(line).join("\n")}\n`;
  assert.equal(roleLessonUsage(store.lessons, store.nextId).bytes, Buffer.byteLength(under, "utf8"));
  assert.ok(roleLessonUsage(store.lessons, store.nextId).bytes < ROLE_LESSONS_MAX_BYTES, "six lessons fit");
  // The store the refused seventh add would have produced: the same figure writeRoleLessons
  // enforced when it threw, above the cap. A count read off the next-id marker instead of the
  // stored lessons would fail this assertion.
  const after = [...store.lessons, { id: "L7", date: "2026-11-12", text: "a".repeat(290) }];
  const over = `<!-- next: L8 -->\n${[1, 2, 3, 4, 5, 6, 7].map(line).join("\n")}\n`;
  assert.equal(roleLessonUsage(after, 8).bytes, Buffer.byteLength(over, "utf8"));
  assert.ok(roleLessonUsage(after, 8).bytes > ROLE_LESSONS_MAX_BYTES, "seven lessons pass the cap");
  assert.equal(roleLessonUsage(after, 8).lessons, 7);
});

test("roleLessonUsage of the empty store counts no lesson and names the marker-only file", () => {
  const file = lessonsFile();
  // The empty store on disk is the marker line alone (writeRoleLessons with no lessons); its byte
  // figure is that file's size — the room the whole-file cap leaves for the first add.
  assert.deepEqual(roleLessonUsage(readRoleLessons(file).lessons, readRoleLessons(file).nextId), {
    lessons: 0,
    bytes: Buffer.byteLength("<!-- next: L1 -->\n", "utf8"),
  });
});

test("roleLessonUsage counts a retired lesson as gone, the way the add cap counts it", () => {
  const file = lessonsFile();
  addRoleLesson(file, "first", "2026-11-12"); // L1
  addRoleLesson(file, "second", "2026-11-13"); // L2
  retireRoleLesson(file, "L1");
  const store = readRoleLessons(file);
  // The count is the lessons the store holds — the figure `addRoleLesson` compares against the
  // 12-lesson cap — so retiring one frees room; the id is still never reused (the marker keeps
  // L3). The byte figure is the rendered file, marker line included. If the count came from the
  // marker instead of the lessons, this assertion would fail.
  assert.equal(roleLessonUsage(store.lessons, store.nextId).lessons, 1);
  assert.equal(
    roleLessonUsage(store.lessons, store.nextId).bytes,
    Buffer.byteLength("<!-- next: L3 -->\n- L2 (2026-11-13): second\n", "utf8"),
  );
});

test("roleLessonUsage measures UTF-8 bytes, not characters", () => {
  const file = lessonsFile();
  addRoleLesson(file, "a é in the text", "2026-11-12"); // é is 2 UTF-8 bytes
  const store = readRoleLessons(file);
  const rendered = "<!-- next: L2 -->\n- L1 (2026-11-12): a é in the text\n";
  assert.equal(roleLessonUsage(store.lessons, store.nextId).bytes, Buffer.byteLength(rendered, "utf8"));
  assert.ok(
    roleLessonUsage(store.lessons, store.nextId).bytes > rendered.length,
    "the byte figure exceeds the character count",
  );
});

test("roleLessonUsage of a hand-edited file reports the writer's re-render, not the raw bytes", () => {
  const file = lessonsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A hand edit that drops the store's trailing newline still parses (parseRoleLessons drops at
  // most one trailing empty line), but the figure is what the next write re-renders — the
  // writer's text, which always ends in a newline. So the prompt's figure and `tumwater doctor`'s
  // `role notes` row, which reports the raw file's bytes (src/status/status-role-notes.ts), can
  // differ on a hand-edited store. A count read off the next-id marker would fail this too.
  const handEdited = "<!-- next: L3 -->\n- L1 (2026-11-12): first\n- L2 (2026-11-13): second";
  fs.writeFileSync(file, handEdited);
  const store = readRoleLessons(file);
  const rendered = `${handEdited}\n`;
  assert.equal(roleLessonUsage(store.lessons, store.nextId).bytes, Buffer.byteLength(rendered, "utf8"));
  assert.equal(roleLessonUsage(store.lessons, store.nextId).bytes, fs.statSync(file).size + 1);
  assert.equal(roleLessonUsage(store.lessons, store.nextId).lessons, 2);
});

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

test("roleLessonLine renders one lesson as its display line, exactly the shape parseRoleLessons reads back", () => {
  const line = roleLessonLine({ id: "L2", date: "2026-11-13", text: "a durable lesson" });
  assert.equal(line, "- L2 (2026-11-13): a durable lesson");
  // The display line and the stored line are the same string, so a hand-written line the
  // operator sees is one parseRoleLessons accepts (and vice versa): the two cannot drift.
  assert.deepEqual(parseRoleLessons(`<!-- next: L3 -->\n${line}\n`), {
    nextId: 3,
    lessons: [{ id: "L2", date: "2026-11-13", text: "a durable lesson" }],
  });
});

test("roleLessonsText joins a store's display lines, one per lesson, and is the round-trip twin of renderRoleLessons", () => {
  const lessons = [
    { id: "L1", date: "2026-11-12", text: "first lesson" },
    { id: "L2", date: "2026-11-13", text: "second lesson" },
  ];
  // Worked out from the format, not the code: the two display lines joined by a newline.
  assert.equal(roleLessonsText(lessons), "- L1 (2026-11-12): first lesson\n- L2 (2026-11-13): second lesson");
  // It is exactly renderRoleLessons' body with the internal next-id marker dropped, so the
  // store file and every display surface cannot disagree on what a lesson looks like.
  assert.equal(renderRoleLessons(3, lessons).replace(/^<!-- next: L3 -->\n/, ""), roleLessonsText(lessons) + "\n");
  assert.equal(roleLessonsText([]), "");
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

test("clearRoleLessons empties the store but keeps the next-id counter (a later add takes a fresh id)", () => {
  const file = lessonsFile();
  addRoleLesson(file, "first", "2026-11-12"); // L1
  addRoleLesson(file, "second", "2026-11-13"); // L2
  clearRoleLessons(file);
  assert.equal(fs.readFileSync(file, "utf8"), "<!-- next: L3 -->\n", "all lessons dropped, counter kept");
  assert.equal(addRoleLesson(file, "third", "2026-11-13"), "L3", "a later add never reuses a cleared id");
  assert.deepEqual(readRoleLessons(file).lessons.map((l) => l.id), ["L3"]);
});

test("clearRoleLessons of a missing file writes the empty store (a no-op that leaves an empty file)", () => {
  const file = lessonsFile();
  clearRoleLessons(file);
  assert.equal(fs.readFileSync(file, "utf8"), "<!-- next: L1 -->\n");
  assert.deepEqual(readRoleLessons(file), { nextId: 1, lessons: [] });
});

test("clearRoleLessons of a corrupted store throws, like every read of it", () => {
  const file = lessonsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "- L1 (2026-11-12): no marker\n");
  assert.throws(() => clearRoleLessons(file), /next-id marker/);
});

test("readRoleLessons never follows a symlink at the path (reads the empty store, INV-G3)", () => {
  const file = lessonsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const outside = path.join(path.dirname(file), "..", "outside-store.md");
  fs.writeFileSync(outside, "<!-- next: L2 -->\n- L1 (2026-11-13): outside store lesson\n");
  fs.symlinkSync(outside, file);

  // The store rides into every run's model prompt, so a symlink to an outside file must read
  // as the empty store — never the target's parsed lessons (which the model would act on).
  assert.deepEqual(readRoleLessons(file), { nextId: 1, lessons: [] });
  // And the store is left untouched: the symlink still names the outside file, which is intact.
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true, "the symlink is left in place");
  assert.match(fs.readFileSync(outside, "utf8"), /outside store lesson/);
});
