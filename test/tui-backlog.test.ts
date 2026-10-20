import test from "node:test";
import assert from "node:assert/strict";
import {
  backlogLines,
  browsableBacklogEntries,
  entryBodyWindow,
  labeledBacklogEntries,
  moveEntrySelection,
  planListLines,
  stepEntryScroll,
  visibleBacklogIndexes,
} from "../src/ui/tui/tui-backlog.js";
import { saveRunnerState } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { backlogMarks, holdMark } from "../src/backlog/backlog-eligibility.js";
import { paneBody } from "../src/ui/tui/tui-pane.js";
import { tmpdir, writeBacklogFile } from "./fixtures/repo-fixtures.js";

test("backlogLines renders subheaders with counts, entries in order", () => {
  assert.deepEqual(backlogLines(["plan A"], ["bug B"], []), [
    "plans (1):",
    "plan A",
    "open bugs (1):",
    "bug B",
    "open questions (0):",
    "(none)",
  ]);
  assert.deepEqual(backlogLines(["plan A"], ["bug B"], ["question Q"]), [
    "plans (1):",
    "plan A",
    "open bugs (1):",
    "bug B",
    "open questions (1):",
    "question Q",
  ]);
});

test("backlogLines renders (none) under an empty section's subheader", () => {
  assert.deepEqual(backlogLines([], ["bug B"], []), [
    "plans (0):",
    "(none)",
    "open bugs (1):",
    "bug B",
    "open questions (0):",
    "(none)",
  ]);
  assert.deepEqual(backlogLines(["plan A"], [], []), [
    "plans (1):",
    "plan A",
    "open bugs (0):",
    "(none)",
    "open questions (0):",
    "(none)",
  ]);
});

test("backlogLines with nothing at all is a single self-explanatory line", () => {
  assert.deepEqual(backlogLines([], [], []), ["(no planned features, open bugs, or open questions)"]);
});

// Entry browsing in the project-status pane: the
// cursor math and body rendering are pure, so they are pinned here without a TTY.

test("moveEntrySelection opens the first entry on down and the last on up from list mode", () => {
  assert.equal(moveEntrySelection(3, null, "down"), 0);
  assert.equal(moveEntrySelection(3, null, "up"), 2);
});

test("moveEntrySelection wraps at both ends across the flat entry list", () => {
  // Three entries: plans (indices 0-1) then bugs (index 2). Down from a plan's last index
  // crosses into the next section; up from the first wraps to the last.
  assert.equal(moveEntrySelection(3, 1, "down"), 2); // plans → bugs boundary
  assert.equal(moveEntrySelection(3, 2, "down"), 0); // wraps back to the first plan
  assert.equal(moveEntrySelection(3, 0, "up"), 2); // wraps from the front to the end
  assert.equal(moveEntrySelection(3, 2, "up"), 1);
});

test("moveEntrySelection clamps a stale selection before wrapping", () => {
  // The backlog the flat index came from can shrink between renders (a role fixes a bug
  // while the pane holds a selection): a stale index past the new count must clamp to the
  // last entry first, so the next step moves from where the pane actually shows the
  // selection — not from an arbitrary offset that mod-count happens to name.
  assert.equal(moveEntrySelection(3, 10, "down"), 0); // clamp 10 → 2, then wrap down to 0
  assert.equal(moveEntrySelection(3, 10, "up"), 1); // clamp 10 → 2, then step up to 1
  assert.equal(moveEntrySelection(3, 4, "down"), 0); // same clamp, the stayed-put repro
});

test("moveEntrySelection with no entries stays in list mode", () => {
  assert.equal(moveEntrySelection(0, null, "down"), null);
  assert.equal(moveEntrySelection(0, null, "up"), null);
  assert.equal(moveEntrySelection(0, 5, "down"), null); // a stale selection also clears
});

test("moveEntrySelection with a visible list steps only through the matches and wraps at their ends", () => {
  // Visible = the `/` search's matching indexes [1, 3] over a 5-entry flat list.
  assert.equal(moveEntrySelection(5, null, "down", [1, 3]), 1, "down from list mode opens the first match");
  assert.equal(moveEntrySelection(5, null, "up", [1, 3]), 3, "up from list mode opens the last match");
  assert.equal(moveEntrySelection(5, 1, "down", [1, 3]), 3);
  assert.equal(moveEntrySelection(5, 3, "down", [1, 3]), 1, "wraps past the last match");
  assert.equal(moveEntrySelection(5, 3, "up", [1, 3]), 1);
  assert.equal(moveEntrySelection(5, 1, "up", [1, 3]), 3, "wraps past the first match");
  assert.equal(moveEntrySelection(5, 0, "down", [1, 3]), 1, "a stale selection outside restarts at the first match");
  assert.equal(moveEntrySelection(5, 4, "up", [1, 3]), 3, "a stale selection outside on up restarts at the last match");
  assert.equal(moveEntrySelection(5, 1, "down", []), null, "an empty visible list selects nothing");
  assert.equal(moveEntrySelection(0, 1, "down", [1]), null, "no entries at all stays in list mode");
});

test("visibleBacklogIndexes returns only open entries, matching heading or body case-insensitively", () => {
  const entries = [
    { label: "plan", title: "Volume slider", body: "Body A" },
    { label: "plan", title: "Widget", body: "second" },
    { label: "bug", title: "zoom", body: "a widget in the body" },
    { label: "question", title: "Which shape?", body: "" },
    { label: "done", title: "Done thing", body: "widget done" },
    { label: "fixed", title: "Fixed bug", body: "widget" },
    { label: "answered", title: "Q done", body: "" },
  ] as Array<{ label: string; title: string; body: string }>;
  assert.deepEqual(visibleBacklogIndexes(entries, null), [0, 1, 2, 3], "no pattern keeps every open entry");
  assert.deepEqual(visibleBacklogIndexes(entries, "widget"), [1, 2], "matches open entries by heading or body, never a finished index");
  assert.deepEqual(visibleBacklogIndexes(entries, "WiDgEt"), [1, 2], "matching is case-insensitive");
  assert.deepEqual(visibleBacklogIndexes(entries, "gizmo"), [], "a term matching nothing returns none");
});

test("entryBodyWindow at offset zero clips each line and keeps the head within budget", () => {
  const body = "a very long first line that will not fit\nsecond line\nthird line";
  assert.deepEqual(entryBodyWindow(body, 0, 2, 10), { lines: ["a very lo…", "second li…"], total: 3 });
  // Lines that fit are untouched; the head window is unchanged from today's entryBodyLines.
  assert.deepEqual(entryBodyWindow("short\nalso short", 0, 5, 80), { lines: ["short", "also short"], total: 2 });
  // A bare heading has an empty body: one self-explanatory placeholder line, zero total
  // (so the scroll affordance never appears for it).
  assert.deepEqual(entryBodyWindow("", 0, 3, 100), { lines: ["(no details for this entry)"], total: 0 });
});

test("entryBodyWindow pages through the middle and tail of a long body", () => {
  const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  // Middle window: lines 3-5 (offset 2, budget 3).
  assert.deepEqual(entryBodyWindow(body, 2, 3, 80), { lines: ["line 3", "line 4", "line 5"], total: 10 });
  // Tail window: the last three lines.
  assert.deepEqual(entryBodyWindow(body, 7, 3, 80), { lines: ["line 8", "line 9", "line 10"], total: 10 });
});

test("entryBodyWindow clamps an offset past either end (a resize or budget shrink cannot strand it)", () => {
  const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  // An offset far beyond the tail clamps to the last possible window.
  assert.deepEqual(entryBodyWindow(body, 99, 3, 80), { lines: ["line 8", "line 9", "line 10"], total: 10 });
  // A negative offset clamps to the head.
  assert.deepEqual(entryBodyWindow(body, -5, 3, 80), { lines: ["line 1", "line 2", "line 3"], total: 10 });
});

test("stepEntryScroll pages down to the tail and back up to the head, clamped at both ends", () => {
  // Ten lines, budget three → maxOffset 7. From the head each PgDn advances one page…
  assert.equal(stepEntryScroll(0, 10, 3, "down"), 3);
  assert.equal(stepEntryScroll(3, 10, 3, "down"), 6);
  // …until it clamps at the tail (offset 7 shows lines 8-10) and stays put.
  assert.equal(stepEntryScroll(6, 10, 3, "down"), 7);
  assert.equal(stepEntryScroll(7, 10, 3, "down"), 7);
  // PgUp mirrors: back up one page per press, clamped at the head.
  assert.equal(stepEntryScroll(7, 10, 3, "up"), 4);
  assert.equal(stepEntryScroll(4, 10, 3, "up"), 1);
  assert.equal(stepEntryScroll(1, 10, 3, "up"), 0);
  assert.equal(stepEntryScroll(0, 10, 3, "up"), 0);
});

test("stepEntryScroll is a no-op when the body fits its budget", () => {
  // A single window: every step lands on (and stays at) the head.
  assert.equal(stepEntryScroll(0, 3, 5, "down"), 0);
  assert.equal(stepEntryScroll(2, 3, 5, "up"), 0); // even a stale offset resets to the head
  assert.equal(stepEntryScroll(9, 0, 4, "down"), 0); // an empty body has no window at all
});

// Eligibility holds beside the backlog title (PLANS.md "Show backlog entry eligibility holds in
// the GUI and TUI backlog lists"): the list and entry modes show the same mark `tumwater
// backlog` prints, and an eligible entry stays unmarked.

test("backlogMarks carries each plan's and bug's hold parallel to its entry, empty when eligible", () => {
  const dir = tmpdir();
  writeBacklogFile(dir, "PLANS.md", [
    {
      heading: "## Planned",
      body: [
        "### Base, part 1/2: x (planned 2026-10-01)",
        "",
        "Body.",
        "",
        "### Later, part 2/2: y (planned 2026-10-02; requires Base 1/2 landed)",
        "",
        "Body.",
        "",
        "### Refused one (planned 2026-10-03)",
        "",
        "**Refused 2026-10-04 by feature: not worth it**",
      ].join("\n"),
    },
    { heading: "## Done" },
  ]);
  writeBacklogFile(dir, "BUGS.md", [
    { heading: "## Open", body: "### Live bug (reported 2026-10-01)\n\nRepro." },
    { heading: "## Fixed" },
  ]);
  assert.deepEqual(backlogMarks(dir), {
    plans: ["", " [blocked: requires Base 1/2]", " [blocked: refused]"],
    bugs: [""],
  });
});

test("backlogMarks and labeledBacklogEntries append the working-on-it mark after the hold", () => {
  const dir = tmpdir();
  writeBacklogFile(dir, "PLANS.md", [
    {
      heading: "## Planned",
      body: "### Volume slider (planned 2026-10-01)\n\nBody.\n\n### Refused one (planned 2026-10-03)\n\n**Refused 2026-10-04 by feature: not worth it**",
    },
    { heading: "## Done" },
  ]);
  writeBacklogFile(dir, "BUGS.md", [
    { heading: "## Open", body: "### Live bug (reported 2026-10-01)\n\nRepro." },
    { heading: "## Fixed" },
  ]);
  const claim = (file: "PLANS.md" | "BUGS.md", key: string, title: string) =>
    ({ file, key, title, at: 1, source: "assigned" }) as const;
  saveRunnerState(dir, { ...loadRunnerState(dir, "feature-2"), claim: claim("PLANS.md", "volume slider", "Volume slider") });
  saveRunnerState(dir, { ...loadRunnerState(dir, "feature"), claim: claim("PLANS.md", "refused one", "Refused one") });
  saveRunnerState(dir, { ...loadRunnerState(dir, "bugfix"), claim: claim("BUGS.md", "live bug", "Live bug") });
  const expected = {
    plans: [" [working on it: feature #2]", " [blocked: refused] [working on it: feature]"],
    bugs: [" [working on it: bugfix]"],
  };
  assert.deepEqual(backlogMarks(dir), expected);
  assert.deepEqual(
    labeledBacklogEntries(dir).filter((e) => e.label !== "question").map((e) => e.mark),
    [...expected.plans, ...expected.bugs],
  );
});

test("labeledBacklogEntries labels every row with its section and its eligibility mark", () => {
  const dir = tmpdir();
  writeBacklogFile(dir, "PLANS.md", [
    {
      heading: "## Planned",
      body: "### Base, part 1/2: x (planned 2026-10-01)\n\nBody.\n\n### Later, part 2/2: y (planned 2026-10-02; requires Base 1/2 landed)\n\nBody.",
    },
    { heading: "## Done" },
  ]);
  writeBacklogFile(dir, "BUGS.md", [
    { heading: "## Open", body: "### Live bug (reported 2026-10-01)\n\nRepro." },
    { heading: "## Fixed" },
  ]);
  writeBacklogFile(dir, "QUESTIONS.md", [
    { heading: "## Open", body: "### Q1: which?" },
    { heading: "## Answered" },
  ]);
  assert.deepEqual(
    labeledBacklogEntries(dir).map((e) => ({ label: e.label, mark: e.mark, title: e.title })),
    [
      { label: "plan", mark: "", title: "Base, part 1/2: x (planned 2026-10-01)" },
      { label: "plan", mark: " [blocked: requires Base 1/2]", title: "Later, part 2/2: y (planned 2026-10-02; requires Base 1/2 landed)" },
      { label: "bug", mark: "", title: "Live bug (reported 2026-10-01)" },
      { label: "question", mark: "", title: "Q1: which?" },
    ],
  );
});

test("paneBody's backlog list and entry mode show the same eligibility mark beside the title", () => {
  const dir = tmpdir();
  writeBacklogFile(dir, "PLANS.md", [
    {
      heading: "## Planned",
      body: "### Base, part 1/2: x (planned 2026-10-01)\n\nBody.\n\n### Later, part 2/2: y (planned 2026-10-02; requires Base 1/2 landed)\n\nBody.",
    },
    { heading: "## Done" },
  ]);
  const state = { selectedEntry: null, entryScroll: 0, selectedQueued: null, queuedRows: [], paneCache: null, noteCache: null, changeCache: null, trailCache: null, paneScroll: 0, activityScroll: null };
  const opts = { root: dir, width: 300, eventBudget: 20, entryBudget: 5 };
  const listText = paneBody({ kind: "backlog" }, { ...opts, state }).body.map((l) => l.map((s) => s.text).join(""));
  assert.ok(
    listText.includes("Later, part 2/2: y (planned 2026-10-02; requires Base 1/2 landed) [blocked: requires Base 1/2]"),
    "the list row carries the mark beside the title",
  );
  assert.ok(listText.includes("Base, part 1/2: x (planned 2026-10-01)"), "the eligible row is unmarked");

  const header = paneBody({ kind: "backlog" }, { ...opts, state: { ...state, selectedEntry: 1 } }).body[0]!;
  assert.equal(
    header.map((s) => s.text).join(""),
    "plan: Later, part 2/2: y (planned 2026-10-02; requires Base 1/2 landed) [blocked: requires Base 1/2]",
  );
});

const blockedHold = { blockedBy: ["S 1/3"] };
const planRow = (title: string, hold: { blockedBy: string[] } | null, claimer?: string) => ({
  title,
  hold,
  claimer,
  mark: holdMark(hold),
});

test("planListLines collapses a series' blocked parts to one line at its first part", () => {
  const rows = [
    planRow("Ready", null),
    planRow("S, part 1/3: a", null),
    planRow("S, part 2/3: b", blockedHold),
    planRow("S, part 3/3: c", blockedHold),
    planRow("Lone, part 2/2: d", blockedHold),
  ];
  assert.deepEqual(planListLines(rows), [
    "Ready",
    "S, part 1/3: a",
    "S, 2 blocked parts (2/3–3/3) [blocked: each waits on an earlier part]",
    "Lone, part 2/2: d" + holdMark(blockedHold),
  ]);
  const claimed = [
    planRow("S, part 1/3: a", null),
    planRow("S, part 2/3: b", blockedHold, "feature"),
    planRow("S, part 3/3: c", blockedHold),
  ];
  assert.deepEqual(
    planListLines(claimed),
    claimed.map((r) => r.title + r.mark),
  );
});

test("backlogLines counts planCount, not lines, in the plans subheader", () => {
  assert.equal(backlogLines(["x"], [], [], 3)[0], "plans (3):");
});

test("paneBody's backlog list collapses a blocked series while entry mode still reaches each part", () => {
  const dir = tmpdir();
  writeBacklogFile(dir, "PLANS.md", [
    {
      heading: "## Planned",
      body: "### Base, part 1/3: x (planned 2026-10-01)\n\nBody.\n\n### Base, part 2/3: y (planned 2026-10-02; requires Base 1/3 landed)\n\nBody.\n\n### Base, part 3/3: z (planned 2026-10-03; requires Base 2/3 landed)\n\nBody.",
    },
    { heading: "## Done" },
  ]);
  writeBacklogFile(dir, "BUGS.md", [
    { heading: "## Open", body: "### Live bug (reported 2026-10-01)\n\nRepro." },
    { heading: "## Fixed" },
  ]);
  const state = { selectedEntry: null, entryScroll: 0, selectedQueued: null, queuedRows: [], paneCache: null, noteCache: null, changeCache: null, trailCache: null, paneScroll: 0, activityScroll: null };
  const opts = { root: dir, width: 300, eventBudget: 20, entryBudget: 5 };
  const text = (selectedEntry: number | null) =>
    paneBody({ kind: "backlog" }, { ...opts, state: { ...state, selectedEntry } }).body.map((l) => l.map((x) => x.text).join(""));
  const list = text(null);
  assert.equal(list[0], "plans (3):");
  assert.equal(list[1], "Base, part 1/3: x (planned 2026-10-01)");
  assert.equal(list[2], "Base, 2 blocked parts (2/3–3/3) [blocked: each waits on an earlier part]");
  assert.ok(list.includes("Live bug (reported 2026-10-01)"));
  const third = labeledBacklogEntries(dir)[2]!;
  assert.equal(text(2)[0], `plan: ${third.title}${third.mark}`);
});

test("backlogLines appends an answered recently section only when there are answered rows", () => {
  assert.deepEqual(backlogLines(["plan A"], [], [], 1, ["Q — yes"]).slice(-2), ["answered recently (1):", "Q — yes"]);
  assert.deepEqual(backlogLines([], [], [], 0, ["Q — yes"]), [
    "plans (0):",
    "(none)",
    "open bugs (0):",
    "(none)",
    "open questions (0):",
    "(none)",
    "answered recently (1):",
    "Q — yes",
  ]);
});

test("paneBody's backlog list shows the newest answered questions", () => {
  const dir = tmpdir();
  const answered = [1, 2, 3, 4, 5, 6]
    .map((n) => `### A${n}\n\nBody.\n\n**Answered 2026-10-0${n} by operator:** pick ${n}`)
    .join("\n\n");
  writeBacklogFile(dir, "QUESTIONS.md", [
    { heading: "## Open", body: "### Open one\n\nWhich?" },
    { heading: "## Answered", body: answered },
  ]);
  const state = { selectedEntry: null, entryScroll: 0, selectedQueued: null, queuedRows: [], paneCache: null, noteCache: null, changeCache: null, trailCache: null, paneScroll: 0, activityScroll: null };
  const opts = { root: dir, width: 300, eventBudget: 30, entryBudget: 5 };
  const rows = paneBody({ kind: "backlog" }, { ...opts, state }).body;
  const text = rows.map((l) => l.map((s) => s.text).join(""));
  const at = text.indexOf("answered recently (5):");
  assert.ok(at > text.indexOf("Open one"), "the section follows the open question");
  assert.ok(text[at + 1]!.startsWith("A6") && text[at + 1]!.includes("pick 6"));
  assert.ok(!text.some((l) => l.includes("A1")));
  assert.ok(rows[at]!.every((s) => s.tone === "bold"), "the subheader is bold");
  const line = (selectedEntry: number) =>
    paneBody({ kind: "backlog" }, { ...opts, state: { ...state, selectedEntry } }).body.map((l) => l.map((s) => s.text).join(""));
  assert.equal(line(0)[0], "question: Open one");
  assert.ok(!line(0).some((l) => l.includes("A6")));
  assert.equal(line(1)[0], "answered: A6");
  assert.ok(line(1).includes("**Answered 2026-10-06 by operator:** pick 6"));
  assert.equal(line(5)[0], "answered: A2");
  assert.equal(line(99)[0], "answered: A2");

  const none = tmpdir();
  writeBacklogFile(none, "QUESTIONS.md", [{ heading: "## Open", body: "### Q\n\nx" }, { heading: "## Answered" }]);
  const t = paneBody({ kind: "backlog" }, { ...opts, root: none, state }).body.map((l) => l.map((s) => s.text).join(""));
  assert.ok(!t.some((l) => l.includes("answered recently")));
});

test("backlogLines adds done and fixed sections after the answered one", () => {
  const lines = backlogLines(["p"], [], [], 1, [], { done: ["P — done 2026-10-15"], fixed: ["B — fixed 2026-10-14"] });
  assert.deepEqual(lines.slice(-4), ["done recently (1):", "P — done 2026-10-15", "fixed recently (1):", "B — fixed 2026-10-14"]);
  const onlyFixed = backlogLines(["p"], [], [], 1, [], { fixed: ["B"] });
  assert.ok(!onlyFixed.some((l) => l.startsWith("done recently")));
  assert.deepEqual(onlyFixed.slice(-2), ["fixed recently (1):", "B"]);
  const onlyDone = backlogLines([], [], [], 0, [], { done: ["P"] });
  assert.deepEqual(onlyDone, ["plans (0):", "(none)", "open bugs (0):", "(none)", "open questions (0):", "(none)", "done recently (1):", "P"]);
});

test("paneBody's backlog list shows the newest done plans and fixed bugs, read-only", () => {
  const dir = tmpdir();
  const done = [1, 2, 3, 4, 5, 6].map((n) => `### D${n} (planned 2026-09-01, done 2026-10-0${n})\n\nBody.`).reverse().join("\n\n");
  writeBacklogFile(dir, "PLANS.md", [{ heading: "## Planned", body: "### Open plan\n\nGoal." }, { heading: "## Done", body: done }]);
  writeBacklogFile(dir, "BUGS.md", [{ heading: "## Open" }, { heading: "## Fixed", body: "### Old bug (fixed 2026-10-02)\n\nx" }]);
  const state = { selectedEntry: null, entryScroll: 0, selectedQueued: null, queuedRows: [], paneCache: null, noteCache: null, changeCache: null, trailCache: null, paneScroll: 0, activityScroll: null };
  const opts = { root: dir, width: 300, eventBudget: 30, entryBudget: 5 };
  const rows = paneBody({ kind: "backlog" }, { ...opts, state }).body;
  const text = rows.map((l) => l.map((s) => s.text).join(""));
  const at = text.indexOf("done recently (5):");
  assert.ok(at >= 0);
  assert.ok(text[at + 1]!.startsWith("D6") && text[at + 1]!.endsWith("done 2026-10-06"));
  assert.ok(!text.some((l) => l.startsWith("D1")));
  const fx = text.indexOf("fixed recently (1):");
  assert.ok(fx > at && text[fx + 1]!.startsWith("Old bug") && text[fx + 1]!.endsWith("fixed 2026-10-02"));
  assert.ok(rows[at]!.every((s) => s.tone === "bold") && rows[fx]!.every((s) => s.tone === "bold"));
  const sel = paneBody({ kind: "backlog" }, { ...opts, state: { ...state, selectedEntry: 0 } }).body;
  assert.equal(sel[0]!.map((s) => s.text).join(""), "plan: Open plan");
  assert.ok(!sel.some((l) => l.some((s) => s.text.includes("D6") || s.text.includes("Old bug"))));
  const line = (selectedEntry: number) =>
    paneBody({ kind: "backlog" }, { ...opts, state: { ...state, selectedEntry } }).body.map((l) => l.map((s) => s.text).join(""));
  assert.deepEqual(line(1).slice(0, 2), ["done: D6 (planned 2026-09-01, done 2026-10-06)", "Body."]);
  assert.equal(line(6)[0], "fixed: Old bug (fixed 2026-10-02)");
  assert.equal(line(99)[0], "fixed: Old bug (fixed 2026-10-02)");
});

test("paneBody's backlog list filters active entries under a / search and hides the finished sections", () => {
  const dir = tmpdir();
  writeBacklogFile(dir, "PLANS.md", [
    { heading: "## Planned", body: "### Volume slider (planned 2026-10-01)\n\nBody.\n\n### Widget (planned 2026-10-02)\n\nBody." },
    { heading: "## Done", body: "### Volume done (planned 2026-09-01, done 2026-10-01)\n\nBody." },
  ]);
  writeBacklogFile(dir, "BUGS.md", [
    { heading: "## Open", body: "### zoom bug (reported 2026-10-01)\n\nBody." },
    { heading: "## Fixed", body: "### Old fixed (fixed 2026-10-02)\n\nx" },
  ]);
  writeBacklogFile(dir, "QUESTIONS.md", [{ heading: "## Open" }, { heading: "## Answered" }]);
  const state = { selectedEntry: null, entryScroll: 0, selectedQueued: null, queuedRows: [], paneCache: null, noteCache: null, changeCache: null, trailCache: null, paneScroll: 0, activityScroll: null };
  const opts = { root: dir, width: 300, eventBudget: 30, entryBudget: 5 };
  const text = (grep: string | null, selectedEntry: number | null = null) =>
    paneBody({ kind: "backlog" }, { ...opts, state: { ...state, backlogGrep: grep, selectedEntry } }).body.map((l) => l.map((s) => s.text).join(""));

  const filtered = text("volume");
  assert.equal(filtered[0], 'search: "volume"', "the search opens under a search header");
  assert.ok(filtered.includes("Volume slider (planned 2026-10-01)"), "the matching open entry is kept");
  assert.ok(!filtered.some((l) => l.includes("Widget")), "a non-matching open entry is hidden");
  assert.ok(!filtered.some((l) => l.startsWith("done recently") || l.startsWith("fixed recently")), "the finished sections are hidden while searching");

  const none = text("gizmo");
  assert.equal(none[0], 'search: "gizmo"');
  assert.ok(none.includes('(no entries match "gizmo")'), "nothing matching paints a self-explanatory line");

  // Entry mode still opens the unfiltered flat index: Volume slider is the first open entry.
  const entry = paneBody({ kind: "backlog" }, { ...opts, state: { ...state, backlogGrep: "volume", selectedEntry: 0 } }).body;
  assert.equal(entry[0]!.map((s) => s.text).join(""), "plan: Volume slider (planned 2026-10-01)");
});

test("browsableBacklogEntries appends the newest answered questions, then done plans, then fixed bugs, after the open entries", () => {
  const dir = tmpdir();
  const done = [1, 2, 3, 4, 5, 6].map((n) => `### D${n} (planned 2026-09-01, done 2026-10-0${n})\n\nBody ${n}.`).reverse().join("\n\n");
  writeBacklogFile(dir, "PLANS.md", [{ heading: "## Planned", body: "### Open plan\n\nGoal." }, { heading: "## Done", body: done }]);
  writeBacklogFile(dir, "BUGS.md", [{ heading: "## Open", body: "### Open bug\n\nx" }, { heading: "## Fixed", body: "### Old bug (fixed 2026-10-02)\n\ny" }]);
  const answered = [1, 2, 3, 4, 5, 6]
    .map((n) => `### A${n}\n\nBody a${n}.\n\n**Answered 2026-10-0${n} by operator:** pick ${n}`)
    .join("\n\n");
  writeBacklogFile(dir, "QUESTIONS.md", [{ heading: "## Open", body: "### Q one\n\nz" }, { heading: "## Answered", body: answered }]);
  const rows = browsableBacklogEntries(dir);
  assert.equal(rows.length, 14);
  assert.deepEqual(rows.slice(0, 3), labeledBacklogEntries(dir));
  assert.deepEqual(
    rows.slice(3, 8).map((r) => [r.label, r.title, r.body, r.mark, r.hold]),
    [6, 5, 4, 3, 2].map((n) => ["answered", `A${n}`, `Body a${n}.\n\n**Answered 2026-10-0${n} by operator:** pick ${n}`, "", null]),
  );
  assert.deepEqual(rows.slice(8, 13).map((r) => [r.label, r.title, r.body, r.mark, r.hold]), [6, 5, 4, 3, 2].map((n) => ["done", `D${n} (planned 2026-09-01, done 2026-10-0${n})`, `Body ${n}.`, "", null]));
  assert.deepEqual([rows[13]!.label, rows[13]!.title, rows[13]!.body], ["fixed", "Old bug (fixed 2026-10-02)", "y"]);
});
