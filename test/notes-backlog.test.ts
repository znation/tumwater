import assert from "node:assert/strict";
import test from "node:test";
import { notesBacklogBlock, type NotesBacklog } from "../src/prompt/notes-backlog.js";
import type { BacklogEntry } from "../src/backlog/backlog-md.js";

/** Unit coverage for src/prompt/notes-backlog.ts — the live backlog block a role's notes are
 * checked against, so a note cannot keep a hold the backlog has lifted. The functions are pure
 * over BacklogEntry arrays, so every case above renders without touching the filesystem. */

const series = (part: string, of: number, title: string, body = "", requires = ""): BacklogEntry => ({
  title: `Codex backend, part ${part}/${of}: ${title} (planned 2026-10-01${requires ? `; requires ${requires} landed` : ""})`,
  body,
});

function empty(overrides: Partial<NotesBacklog> = {}): NotesBacklog {
  return { planned: [], openBugs: [], donePlanTitles: [], ...overrides };
}

test("notes claiming Refused still read the live hold when the backlog has lifted it", () => {
  // The 2026-10-21 plan run's lines against a PLANS.md where 2b/9 and 6/9 now carry Needs-replan
  // notes (parts 2a–8/9). 2b and 6 read needs-replan; the other seven wait on an earlier planned
  // part. The notes' "Refused" claims lose to the live state.
  const planned = [
    series("2a", 9, "a", "", "Codex backend 2b/9"),
    series("2b", 9, "b", "**Needs replan 2026-10-21 by plan: rewrite**"),
    series("2c", 9, "c", "", "Codex backend 2a/9"),
    series("3", 9, "d", "", "Codex backend 2a/9"),
    series("4", 9, "e", "", "Codex backend 2a/9"),
    series("5", 9, "f", "", "Codex backend 2a/9"),
    series("6", 9, "g", "**Needs replan 2026-10-21 by plan: rewrite**"),
    series("7", 9, "h", "", "Codex backend 2a/9"),
    series("8", 9, "i", "", "Codex backend 2a/9"),
  ];
  const notes = [
    "Codex 2b/9 carry Refused — never re-add or re-author them",
    "Codex 6/9 carry Refused — never re-add or re-author them",
    "the Codex theme is dead",
  ].join("\n");
  const block = notesBacklogBlock(notes, empty({ planned }));
  assert.ok(block);
  assert.match(block, /- Codex backend — 9 parts planned: 2 need a replan, 7 wait on an earlier part, none refused/);
  assert.match(block, /- Codex backend, part 2b\/9 — needs replan \(the plan role rewrites it\)/);
  assert.match(block, /- Codex backend, part 6\/9 — needs replan \(the plan role rewrites it\)/);
  assert.ok(block.indexOf("- Codex backend — ") < block.indexOf("- Codex backend, part 2b/9"), "series line comes first");
  assert.ok(!block.includes("refused (only the operator clears it)"), "the Refused wording is not the live state");
});

test("a Needs-review part reads 'needs review', not 'needs a replan'", () => {
  // A Needs-review hold is a distinct blocker (the review role owns it), so it must not be
  // folded into the needs-replan count or worded as a replan.
  const planned = [
    series("1", 4, "a", "**Needs review 2026-10-21 by feature: too large for one run**"),
    series("2", 4, "b", "**Needs replan 2026-10-21 by plan: rewrite**"),
    series("3", 4, "c", "", "Codex backend 1/4"),
    series("4", 4, "d", "", "Codex backend 1/4"),
  ];
  const block = notesBacklogBlock("Codex\nCodex 1/4 2/4", empty({ planned }));
  assert.ok(block);
  assert.match(block, /- Codex backend — 4 parts planned: 1 needs a replan, 1 needs review, 2 wait on an earlier part, none refused/);
  assert.match(block, /- Codex backend, part 1\/4 — needs review\b/);
  assert.match(block, /- Codex backend, part 2\/4 — needs replan \(the plan role rewrites it\)/);
});

test("the bare first word names a series only while no other live series shares it", () => {
  const planned = [series("1", 9, "a")];
  const block = notesBacklogBlock("Codex", empty({ planned }));
  assert.ok(block);
  assert.match(block, /- Codex backend — 1 part planned: none refused/);

  const two = [
    ...planned,
    { title: "Codex database, part 1/9: db (planned 2026-10-01)", body: "" },
  ];
  const bare = notesBacklogBlock("Codex", empty({ planned: two }));
  assert.equal(bare, undefined, "a shared first word names neither series");

  const full = notesBacklogBlock("Codex backend", empty({ planned: two }));
  assert.ok(full);
  assert.match(full, /- Codex backend — 1 part planned: none refused/);
  assert.ok(!full.includes("Codex database"), "the other series is not named");
});

test("a part in PLANS-DONE reads done, and a refused entry reads refused", () => {
  const planned = [{ title: "Alpha, part 2/3: second (planned 2026-10-01)", body: "" }];
  const done = ["Alpha, part 1/3: seed (done 2026-10-20)"];
  const block = notesBacklogBlock("Alpha 1/3 is shipped", empty({ planned, donePlanTitles: done }));
  assert.ok(block);
  assert.match(block, /- Alpha, part 1\/3 — done/);

  const refusedEntry: BacklogEntry = {
    title: "Refactor all the things now quickly please (planned 2026-10-01)",
    body: "**Refused 2026-10-20 by feature: too big for one run**",
  };
  const refused = notesBacklogBlock("Refactor all the things now quickly", empty({ planned: [refusedEntry] }));
  assert.ok(refused);
  assert.match(refused, /- Refactor all the things now quickly please \(planned 2026-10-01\) — refused \(only the operator clears it\)/);
});

test("notes naming no live entry or series give undefined", () => {
  assert.equal(notesBacklogBlock("the scheduler lives in team.ts", empty()), undefined);
  assert.equal(notesBacklogBlock("Codex 2b/9", empty()), undefined, "no series means no tokens");
  const text = "where things live, what was ruled out, what to look at next";
  assert.equal(notesBacklogBlock(text, empty({ openBugs: [{ title: "unrelated bug", body: "" }] })), undefined);
});

test("forty named parts render at most 12 lines", () => {
  const planned = Array.from({ length: 40 }, (_, i) => ({ title: `Big, part ${i + 1}/40: x (planned 2026-10-01)`, body: "" }));
  const lines = Array.from({ length: 40 }, (_, i) => `Big ${i + 1}/40`);
  const block = notesBacklogBlock([...lines, "Big series"].join("\n"), empty({ planned }));
  assert.ok(block);
  const count = block.split("\n").length;
  assert.ok(count <= 12, `expected at most 12 lines, got ${count}: ${block}`);
  assert.equal(count, 12, "forty parts and the series line fill the cap");
});

test("an entry named by a bug matches through its Open title's first six words", () => {
  const bug = { title: "Dashboard newest failure renders wrong counts (reported 2026-10-01)", body: "**Waiting for the next failure …**" };
  const block = notesBacklogBlock("Dashboard newest failure renders wrong counts", empty({ openBugs: [bug] }));
  assert.ok(block);
  assert.match(block, /- Dashboard newest failure renders wrong counts \(reported 2026-10-01\) — waiting for the next failure/);
});
