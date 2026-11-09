/** Direct unit tests for src/merge/merge-questions.ts logNewQuestions — the capture-and-diff
 * that emits one `question_posted` per QUESTIONS.md `## Open` heading gained since `before`.
 *
 * This is the half of the questions-outbox feature (plans/questions-outbox.md) the e2e runner
 * suite (test/runner-4.test.ts) reaches only through the full merge path. There the pre-merge
 * capture is always the seeded empty `_None yet._` list, so the e2e pins only "one new heading →
 * one event" and "no new heading → none". The branches this file drives directly — a heading
 * already in `before` being skipped, and the `position`/`open` numbering of the WHOLE current
 * Open list, not of the new headings alone — are untested by any merge that runs. A plausible
 * bug they would catch: number the new headings 1..k instead of their real 1-based place in the
 * (combined) list. `open` is `titles.length` (the list after the merge, the number the answer
 * command reads against), and `position` is `index + 1` of the same list — the event-format
 * reader (src/events/event-format.ts) renders `question N in \`tumwater questions\`` from them,
 * and a wrong `position` points an operator at the wrong entry.
 *
 * Each case seeds a temp project root (a distinct inode per test, so the stat-keyed caches in
 * openQuestions and readEvents read the freshly written file) and calls logNewQuestions in
 * process — it writes only the event log (events.jsonl under .tumwater/log), no git, no pi.
 * Expected values come from the module's doc comment and event-format's contract, never from
 * running the code: one event per heading absent from `before`, each carrying that heading's
 * 1-based index in the current Open list and the list's length.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { logNewQuestions } from "../src/merge/merge-questions.js";
import { writeTextAtomic } from "../src/files/files.js";
import { readEvents } from "../src/events/event-read.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** Write a QUESTIONS.md whose ## Open section holds exactly the given heading titles, then run
 * logNewQuestions with the given `before`. Returns the question_posted events the fresh event
 * log holds — there are none but these, since no other event is logged. */
function posted(root: string, openHeadings: string[], before: string[]): Array<Record<string, unknown>> {
  const lines = [
    "# Questions",
    "",
    "## Open",
    "",
    ...(openHeadings.length === 0 ? ["_None yet._"] : openHeadings.map((t) => `### ${t}`)),
    "",
    "## Answered",
    "",
  ];
  writeTextAtomic(path.join(root, "QUESTIONS.md"), lines.join("\n"));
  logNewQuestions(root, before, "improve");
  return readEvents(root).filter((e) => e.type === "question_posted") as Array<Record<string, unknown>>;
}

test("a heading already in before is not re-posted; a new one is, at its real position", () => {
  const root = tmpdir();
  // The Open list holds two entries; `before` already knew the first, so only the second is new.
  const events = posted(root, ["Q1: which database?", "Q2: which language?"], ["Q1: which database?"]);
  assert.equal(events.length, 1, "one event, for the one heading not in before");
  assert.equal(events[0]!.question, "Q2: which language?");
  // position is the heading's 1-based place in the whole Open list (index 1 → 2), and open is
  // the list's length (2) — the number the answer command reads against.
  assert.equal(events[0]!.position, 2);
  assert.equal(events[0]!.open, 2);
});

test("a heading is skipped on an exact title match only, not a partial one", () => {
  const root = tmpdir();
  // before holds "Q1: which database?" and the Open list gains "Q1: which database??" (a
  // different title, extra "?"): the substring overlap must not count as the same entry.
  const events = posted(
    root,
    ["Q1: which database?", "Q1: which database??", "Q2: which storage?"],
    ["Q1: which database?"],
  );
  assert.equal(events.length, 2, "both titles not exactly in before are posted");
  const byQuestion = new Map(events.map((e) => [e.question, e]));
  // The re-posted "Q1: which database??" sits at index 1 → position 2 of a 3-entry list.
  assert.equal(byQuestion.get("Q1: which database??")!.position, 2);
  // "Q2: which storage?" sits at index 2 → position 3; open is the 3-entry list length.
  assert.equal(byQuestion.get("Q2: which storage?")!.open, 3);
});

test("every new heading is posted, each numbered by its place in the list", () => {
  const root = tmpdir();
  // before is empty (the seeded QUESTIONS.md's `_None yet._`), so the whole list is new.
  const events = posted(root, ["Q1: one?", "Q2: two?", "Q3: three?"], []);
  assert.equal(events.length, 3);
  // They carry their 1-based positions in file order and the list length.
  assert.deepEqual(
    events.map((e) => e.question),
    ["Q1: one?", "Q2: two?", "Q3: three?"],
  );
  assert.deepEqual(
    events.map((e) => e.position),
    [1, 2, 3],
  );
  for (const e of events) assert.equal(e.open, 3);
});

test("no headings gained since before logs no question_posted event", () => {
  const root = tmpdir();
  // The Open list is exactly what `before` captured: nothing is new, so nothing is emitted.
  const events = posted(root, ["Q1: which database?"], ["Q1: which database?"]);
  assert.equal(events.length, 0);
});

test("a merge that posts into an already-nonempty Open list numbers from the combined list", () => {
  const root = tmpdir();
  // The realistic merge shape the e2e cannot reach: Open already held "Q1" before the merge
  // (position 1, open 1); the diff adds "Q2" and "Q3". Q1 is skipped; Q2/Q3 take positions 2
  // and 3 of the 3-entry list, not 1 and 2 of the new headings.
  const events = posted(
    root,
    ["Q1: pre-existing?", "Q2: added in merge?", "Q3: also added in merge?"],
    ["Q1: pre-existing?"],
  );
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => [e.question, e.position, e.open]),
    [
      ["Q2: added in merge?", 2, 3],
      ["Q3: also added in merge?", 3, 3],
    ],
  );
  // The skipped entry is absent, so the events are exactly the two new headings — the event
  // log holds nothing else, so this also pins that a pre-existing entry is not re-posted.
  assert.ok(!events.some((e) => e.question === "Q1: pre-existing?"));
});

test("the event lands in the project's event log with the caller as source", () => {
  const root = tmpdir();
  const events = posted(root, ["Q1: which database?"], []);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.source, "improve");
  // A logged event is a complete line in the jsonl log.
  const raw = fs.readFileSync(path.join(root, ".tumwater", "log", "events.jsonl"), "utf8");
  const parsed = JSON.parse(raw.split("\n").find((line) => line.length > 0)!);
  assert.equal(parsed.type, "question_posted");
  assert.equal(parsed.source, "improve");
});
