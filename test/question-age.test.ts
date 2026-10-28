import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { questionFilingDate, questionAgeSuffix } from "../src/backlog/backlog-question-answer.js";

// The open-question age (`tumwater questions --list` names how long each open question has
// waited since its `(asked by <who> YYYY-MM-DD)` clause): the two pure helpers (questionFilingDate,
// questionAgeSuffix) and the two list surfaces (prose line, --json payload) wired end to end
// through a temp root holding one dated and one undated open question.

const DAY = 86400000;

test("questionFilingDate reads the heading's own asked-by stamp, and only that", () => {
  // The stamp clause is the entry's own: `(asked by director 2026-10-10)`.
  assert.equal(questionFilingDate("Cap the spend? (asked by director 2026-10-10)"), "2026-10-10");
  // A heading with no asked-by date clause has no filing date.
  assert.equal(questionFilingDate("Cap the spend?"), null);
  // The first YYYY-MM-DD after an `asked by` word wins, even when an earlier bare date or a
  // different date sits elsewhere in the heading.
  assert.equal(questionFilingDate("Plan for 2026-01-01 (asked by plan 2026-10-12)"), "2026-10-12");
  // Spelling of the who/date is flexible, but there must be an `asked by` word.
  assert.equal(questionFilingDate("Plan (asked by 2026-10-10)"), "2026-10-10");
  assert.equal(questionFilingDate("Plan (filed 2026-10-10)"), null);
});

test("questionAgeSuffix words the age with days, and today when zero", () => {
  // Four days after the stamp: ` · since 2026-10-10 (4d)`.
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(questionAgeSuffix("Cap the spend? (asked by director 2026-10-10)", now), " · since 2026-10-10 (4d)");
  // The same day reads `(today)`.
  assert.equal(questionAgeSuffix("Cap the spend? (asked by director 2026-10-14)", now), " · since 2026-10-14 (today)");
  // An undated heading gets no suffix.
  assert.equal(questionAgeSuffix("Cap the spend?", now), "");
  // n floors at 0 for a future stamp — the same `(today)` wording, never a negative age.
  assert.equal(questionAgeSuffix("Cap the spend? (asked by director 2026-10-20)", now), " · since 2026-10-20 (today)");
  // A boundary just under one day reads `(today)`; a full day reads `(1d)`.
  assert.equal(questionAgeSuffix("Cap? (asked by day 2026-10-13)", now), " · since 2026-10-13 (1d)");
});

test("tumwater questions names the age for a dated question and omits it for an undated one", async () => {
  const repo = makeRepo();
  await initProject(repo, "question age cli");
  // A dated stamp four days back, written with local date parts. The feature reads the
  // `YYYY-MM-DD` stamp as a Date.parse UTC-midnight value, so the exact whole-day age from
  // Date.now() drifts with the local time of day and timezone. Rather than hard-assert a fixed
  // count, compute the expected age the same way the feature does so the assertion tracks the
  // clock; the undated entry's line keeps only title + body preview.
  const ago = new Date(Date.now() - 4 * DAY);
  const fourDaysAgo = `${ago.getFullYear()}-${String(ago.getMonth() + 1).padStart(2, "0")}-${String(ago.getDate()).padStart(2, "0")}`;
  const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(fourDaysAgo)) / DAY));
  const ageWord = ageDays === 0 ? "today" : `${ageDays}d`;
  fs.writeFileSync(
    path.join(repo, "QUESTIONS.md"),
    [
      "# Questions",
      "",
      "## Open",
      "",
      `### Why is this slow? (asked by director ${fourDaysAgo})`,
      "",
      "first body line",
      "",
      "### Undated question",
      "",
      "undated body",
      "",
      "## Answered",
      "",
      "_None._",
      "",
    ].join("\n"),
  );
  const r = await cli(repo, "questions");
  assert.equal(r.code, 0);
  assert.match(
    r.stdout,
    new RegExp(`1\\. Why is this slow\\? \\(asked by director ${fourDaysAgo}\\) · since ${fourDaysAgo} \\(${ageWord}\\) — first body line`),
  );
  // The undated entry appears with no ` · since` suffix, its body preview still trailing.
  assert.match(r.stdout, /2\. Undated question — undated body/);
  assert.doesNotMatch(r.stdout, /2\. Undated question · since/);

  // --json carries since/ageDays for the dated entry and neither field for the undated one.
  const j = await cli(repo, "questions", "--json");
  assert.equal(j.code, 0);
  const payload = JSON.parse(j.stdout) as {
    questions: { position: number; title: string; body: string; since?: string; ageDays?: number }[];
  };
  assert.deepEqual(payload.questions, [
    {
      position: 1,
      title: `Why is this slow? (asked by director ${fourDaysAgo})`,
      body: "first body line",
      since: fourDaysAgo,
      ageDays,
    },
    { position: 2, title: "Undated question", body: "undated body" },
  ]);
});
