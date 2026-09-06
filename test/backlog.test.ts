import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  openBugEntries,
  openQuestions,
  openQuestionEntries,
  parseEntries,
  parseEntryDetails,
  plannedPlanEntries,
  plannedPlans,
} from "../src/backlog.js";
import { tmpdir } from "./util.js";

const PLANS_MD = `# Plans

Planned features, written by the plan loop and implemented by the feature loop.

## Planned

### Show open bugs and planned features in the TUI/GUI (planned 2026-08-24)

**Goal:** The dashboard surfaces project status.
Body text that must not leak into titles — **bold**, \`code\`, lists, everything.

### Timestamp of last result (planned 2026-08-21, refined 2026-08-25)

## Done

### An old finished plan (done 2026-08-20)

Done entries must never appear in the planned list.
`;

const BUGS_MD = `# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.

## Open

### gen / peak ctx columns should show the current or last run (reported 2026-08-25)

**Symptom:** The columns accumulate across a loop's whole lifetime.

### Merge conflicts logged as warnings although they are normal operation (reported 2026-08-25)

## Fixed

### A fixed bug (fixed 2026-08-24)

_None else yet._
`;

test("parseEntries returns only the requested section's ### headings, full text kept", () => {
  assert.deepEqual(parseEntries(PLANS_MD, "Planned"), [
    "Show open bugs and planned features in the TUI/GUI (planned 2026-08-24)",
    "Timestamp of last result (planned 2026-08-21, refined 2026-08-25)",
  ]);
  assert.deepEqual(parseEntries(PLANS_MD, "Done"), ["An old finished plan (done 2026-08-20)"]);
});

test("parseEntries stops at the next ## section and ignores body text", () => {
  // The Done entry sits after a second ## line — it must not leak into Planned.
  assert.ok(!parseEntries(PLANS_MD, "Planned").some((t) => t.includes("old finished")));
  // Body lines under an entry (bold, code, prose) never become titles.
  const entries = parseEntries(BUGS_MD, "Open");
  assert.equal(entries.length, 2);
  for (const e of entries) {
    assert.ok(!e.startsWith("**") && !e.includes("Symptom"));
  }
});

test("parseEntries handles a missing section and placeholder lines", () => {
  assert.deepEqual(parseEntries(PLANS_MD, "Backlog"), []);
  // _None yet._ placeholders are not headings — an empty seeded file yields no entries.
  const seeded = `# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n_None yet._\n`;
  assert.deepEqual(parseEntries(seeded, "Planned"), []);
});

test("plannedPlans reads PLANS.md fresh; missing file yields []", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "PLANS.md"), PLANS_MD);
  assert.equal(plannedPlans(root).length, 2);
  // A later edit is visible on the next read: the write changes size and mtime, so the
  // stat-keyed cache misses. The entry must land inside Planned — appending to the file end
  // would file it under Done.
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    PLANS_MD.replace("## Done", "### A brand new plan (planned 2026-08-25)\n\n## Done"),
  );
  assert.equal(plannedPlans(root)[2], "A brand new plan (planned 2026-08-25)");
  assert.deepEqual(plannedPlans(tmpdir()), []);
});

test("openBugs reads BUGS.md's Open section only; missing file yields []", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "BUGS.md"), BUGS_MD);
  assert.deepEqual(openBugs(root), [
    "gen / peak ctx columns should show the current or last run (reported 2026-08-25)",
    "Merge conflicts logged as warnings although they are normal operation (reported 2026-08-25)",
  ]);
  assert.deepEqual(openBugs(tmpdir()), []);
});

const QUESTIONS_MD = `# Questions

Open questions loops have posted for a human decision — each with context, the options, and the
loop's recommendation. Answer by moving an entry to ## Answered with your decision (or tell the
director). Loops never block on their own questions; they check here at the start of each tick.

## Open

### Which provider should the qa role use for its real runs? (asked 2026-08-27 by qa)

**Context:** The README documents two providers with different costs.
**Options:** A) cheap model, B) default model. **Recommendation:** A until proven insufficient.

### Should reset-counters also clear the event log? (asked 2026-08-27 by improve)

## Answered

### Where should harness state live? (asked 2026-08-21, answered 2026-08-21)

Decision: under .tumwater/, gitignored. This entry must never appear in the open list.
`;

test("openQuestions reads QUESTIONS.md's Open section only; missing file yields []", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "QUESTIONS.md"), QUESTIONS_MD);
  assert.deepEqual(openQuestions(root), [
    "Which provider should the qa role use for its real runs? (asked 2026-08-27 by qa)",
    "Should reset-counters also clear the event log? (asked 2026-08-27 by improve)",
  ]);
  // An answered question must not leak into the open count — the header badge is
  // openQuestions(root).length, so a stale entry would keep showing `questions: N`.
  assert.ok(!openQuestions(root).some((t) => t.includes("Where should harness state")));
  // Body lines under an entry (context/options/recommendation prose) never become titles.
  for (const e of openQuestions(root)) {
    assert.ok(!e.startsWith("**") && !e.includes("Context"));
  }
  assert.deepEqual(openQuestions(tmpdir()), []);
});

test("openQuestions skips placeholders in a freshly seeded file", () => {
  // The exact template init.ts seeds: both sections hold only the _None yet._ placeholder.
  const root = tmpdir();
  fs.writeFileSync(
    path.join(root, "QUESTIONS.md"),
    `# Questions\n\n## Open\n\n_None yet._\n\n## Answered\n\n_None yet._\n`,
  );
  assert.deepEqual(openQuestions(root), []);
});

test("parseEntryDetails carries each entry's body between its heading and the next heading", () => {
  const md = [
    "# Plans",
    "",
    "## Planned",
    "",
    "### A plan with a body (planned 2026-09-05)",
    "",
    "**Goal.** First line of the goal.",
    "",
    "A second paragraph, kept verbatim — **bold**, `code`, everything.",
    "",
    "### A bare heading (planned 2026-09-04)",
    "",
    "## Done",
    "",
    "### An old finished plan (done 2026-08-20)",
    "",
    "Done bodies must never leak into the planned list.",
  ].join("\n");
  assert.deepEqual(parseEntryDetails(md, "Planned"), [
    {
      title: "A plan with a body (planned 2026-09-05)",
      // Interior blank lines are preserved; leading/trailing blanks around the body are trimmed.
      body: "**Goal.** First line of the goal.\n\nA second paragraph, kept verbatim — **bold**, `code`, everything.",
    },
    { title: "A bare heading (planned 2026-09-04)", body: "" }, // a bare heading has an empty body
  ]);
});

test("parseEntryDetails ends the last entry's body at the next ## section and at EOF", () => {
  const md = [
    "# Plans",
    "",
    "## Planned",
    "",
    "### Last in its section (planned 2026-09-05)",
    "",
    "Body line one.",
    "Body line two.",
    "",
    "## Done",
    "",
    "### Ends at EOF (done 2026-08-20)",
    "",
    "Its body runs to the end of file.",
  ].join("\n");
  // The Planned entry's body stops at `## Done` — the Done heading and its text never leak in.
  assert.deepEqual(parseEntryDetails(md, "Planned"), [
    { title: "Last in its section (planned 2026-09-05)", body: "Body line one.\nBody line two." },
  ]);
  // An entry at the end of file ends with EOF, not a heading.
  assert.deepEqual(parseEntryDetails(md, "Done"), [
    { title: "Ends at EOF (done 2026-08-20)", body: "Its body runs to the end of file." },
  ]);
});

test("parseEntryDetails skips placeholders and prose before the first heading", () => {
  // The exact template init.ts seeds: both sections hold only the _None yet._ placeholder.
  const seeded = `# Plans\n\n## Planned\n\n_None yet._\n\n## Done\n\n_None yet._\n`;
  assert.deepEqual(parseEntryDetails(seeded, "Planned"), []);
  // Prose between the section heading and the first entry is not any entry's body.
  const md = `# Plans\n\n## Planned\n
Intro prose that belongs to no entry.\n\n### First (planned 2026-09-05)\n\nReal body.\n`;
  assert.deepEqual(parseEntryDetails(md, "Planned"), [{ title: "First (planned 2026-09-05)", body: "Real body." }]);
});

test("parseEntries keeps returning titles only — the richer parse is its source", () => {
  assert.deepEqual(parseEntryDetails(PLANS_MD, "Planned").map((e) => e.title), parseEntries(PLANS_MD, "Planned"));
  // The fixture's first entry has a body; the second is bare — titles are unchanged either way.
  assert.deepEqual(parseEntries(PLANS_MD, "Planned"), [
    "Show open bugs and planned features in the TUI/GUI (planned 2026-08-24)",
    "Timestamp of last result (planned 2026-08-21, refined 2026-08-25)",
  ]);
});

test("the entry readers return title + body pairs in file order; missing file yields []", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "PLANS.md"), PLANS_MD);
  assert.deepEqual(plannedPlanEntries(root), [
    {
      title: "Show open bugs and planned features in the TUI/GUI (planned 2026-08-24)",
      body: "**Goal:** The dashboard surfaces project status.\nBody text that must not leak into titles — **bold**, `code`, lists, everything.",
    },
    { title: "Timestamp of last result (planned 2026-08-21, refined 2026-08-25)", body: "" },
  ]);
  // The titles-only reader and the entry reader agree on order and titles — one parse feeds both.
  assert.deepEqual(plannedPlanEntries(root).map((e) => e.title), plannedPlans(root));

  fs.writeFileSync(path.join(root, "BUGS.md"), BUGS_MD);
  assert.deepEqual(openBugEntries(root)[0], {
    title: "gen / peak ctx columns should show the current or last run (reported 2026-08-25)",
    body: "**Symptom:** The columns accumulate across a loop's whole lifetime.",
  });

  fs.writeFileSync(path.join(root, "QUESTIONS.md"), QUESTIONS_MD);
  assert.deepEqual(openQuestionEntries(root)[1], {
    title: "Should reset-counters also clear the event log? (asked 2026-08-27 by improve)",
    body: "",
  });

  // Missing files yield [] from every entry reader, like their titles-only siblings.
  const empty = tmpdir();
  assert.deepEqual(plannedPlanEntries(empty), []);
  assert.deepEqual(openBugEntries(empty), []);
  assert.deepEqual(openQuestionEntries(empty), []);
});

test("an unchanged file is served from the stat-keyed cache without re-reading", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "PLANS.md"), PLANS_MD);
  assert.equal(plannedPlans(root).length, 2); // populates the cache
  let reads = 0;
  const originalReadFileSync = fs.readFileSync.bind(fs);
  try {
    (fs as unknown as { readFileSync: unknown }).readFileSync = (...args: unknown[]) => {
      reads += 1;
      return (originalReadFileSync as (...a: unknown[]) => string)(...args);
    };
    assert.deepEqual(plannedPlans(root), [
      "Show open bugs and planned features in the TUI/GUI (planned 2026-08-24)",
      "Timestamp of last result (planned 2026-08-21, refined 2026-08-25)",
    ]);
    assert.equal(reads, 0); // unchanged since the first read — no file I/O at all
    // Each call still gets its own array: mutating one result must not poison the cache.
    const a = plannedPlans(root);
    a.push("mutated by caller");
    assert.equal(plannedPlans(root).length, 2);
  } finally {
    (fs as unknown as { readFileSync: unknown }).readFileSync = originalReadFileSync;
  }
});

test("repeated entry reads of an unchanged file re-parse nothing (stat-keyed cache hit)", () => {
  // The GUI's /api/backlog endpoint and the TUI's browse both go through these readers; while
  // a panel is open they are called every second, so an unchanged file must cost one stat per
  // call — never a re-read or re-parse of markdown that grows without bound.
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "PLANS.md"), PLANS_MD);
  assert.equal(plannedPlanEntries(root).length, 2); // populates the cache
  let reads = 0;
  const originalReadFileSync = fs.readFileSync.bind(fs);
  try {
    (fs as unknown as { readFileSync: unknown }).readFileSync = (...args: unknown[]) => {
      reads += 1;
      return (originalReadFileSync as (...a: unknown[]) => string)(...args);
    };
    assert.equal(plannedPlanEntries(root).length, 2);
    assert.equal(openBugEntries(root).length, 0); // a different file/section key misses once…
    fs.writeFileSync(path.join(root, "BUGS.md"), BUGS_MD); // …and the write invalidates it
    assert.equal(openBugEntries(root).length, 2);
    assert.equal(reads, 1, "only the new BUGS.md was read; PLANS.md came from cache");
    // Each call still gets its own objects: mutating one result must not poison the cache.
    const before = plannedPlanEntries(root)[0]!.body;
    const a = plannedPlanEntries(root);
    a[0]!.body = "mutated by caller";
    assert.equal(plannedPlanEntries(root)[0]!.body, before); // original body restored
  } finally {
    (fs as unknown as { readFileSync: unknown }).readFileSync = originalReadFileSync;
  }
});

test("a same-size edit is picked up via mtime, not just size", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "PLANS.md"), PLANS_MD);
  assert.equal(plannedPlans(root)[1], "Timestamp of last result (planned 2026-08-21, refined 2026-08-25)");
  // Replace one heading with different text of the EXACT same length: size alone cannot
  // detect the change, so mtime must be part of the cache key. utimes forces a distinct
  // mtime regardless of filesystem timestamp granularity (two fast writes could otherwise
  // share one on coarse-grained filesystems).
  const edited = PLANS_MD.replace("Timestamp of last result", "Renamed plan entry, same");
  assert.equal(edited.length, PLANS_MD.length);
  fs.writeFileSync(path.join(root, "PLANS.md"), edited);
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, "PLANS.md"), t, t);
  assert.equal(plannedPlans(root)[1], "Renamed plan entry, same (planned 2026-08-21, refined 2026-08-25)");
});

test("openQuestions reads fresh: answering a question drops it from the list", () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, "QUESTIONS.md"), QUESTIONS_MD);
  assert.equal(openQuestions(root).length, 2);
  // The answer flow moves an entry (heading + body) under ## Answered — the write changes
  // size and mtime, so the next read must reflect it, or the badge would overcount.
  const answeredEntry =
    "### Which provider should the qa role use for its real runs? (asked 2026-08-27 by qa, answered 2026-08-28)\n\nDecision: cheap model.\n";
  const openEntry =
    "### Which provider should the qa role use for its real runs? (asked 2026-08-27 by qa)\n\n**Context:** The README documents two providers with different costs.\n**Options:** A) cheap model, B) default model. **Recommendation:** A until proven insufficient.\n";
  fs.writeFileSync(
    path.join(root, "QUESTIONS.md"),
    QUESTIONS_MD.replace(openEntry, "").replace("## Answered\n", `## Answered\n\n${answeredEntry}`),
  );
  assert.deepEqual(openQuestions(root), [
    "Should reset-counters also clear the event log? (asked 2026-08-27 by improve)",
  ]);
});
