import test from "node:test";
import assert from "node:assert/strict";
import type { HarnessEvent } from "../src/events/events.js";
import { readTickRowsSince, summarizeTickRows, tickRowGrepHaystack, tickRows, type HistorySummaryRow, type TickRow } from "../src/history/history-data.js";
import { renderSummary } from "../src/history/history-render.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { writeEvents } from "./fixtures/log-fixtures.js";

// The `src/history/history-data.ts` unit tests: the pure tickRows collector's pairing,
// filtering, bounding, and usage/detail rendering, plus the `history --since` collector.
// readTickRowsSince reuses the pure tickRows over a day-keyed window read (event-window.ts),
// filters the window's events to the cutoff, and reports coverage with the same predicate
// cmdLogs consults. These tests pin the window's composition — what crosses the cutoff, what
// pairs across it, and what `covered` claims — against a log seeded relative to the reader's
// own clock. Cutoff-sensitive fixtures sit minutes away from the cutoff so a few ms of clock
// drift between seeding and the read cannot flip an assertion.

const TWO_HOURS = 7_200_000;
const MIN = 60_000;
// The since-window the spanning-pin tests read through: one hour back from the reader's
// own clock, so the cutoff sits mid-window and a few ms of drift between seeding and the
// read cannot move an event across it.
const SINCE = 60 * MIN;

function endEvent(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "feature", type: "run_end", run: 1, result: "changed", ...over } as HarnessEvent;
}

function startEvent(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "feature", type: "run_start", run: 1, ...over } as HarnessEvent;
}

test("tickRowGrepHaystack is the canonical unpadded row line, run_end-prefixed", () => {
  // The shared haystack `tumwater history --grep` and the dashboard's /api/history?grep both
  // filter through: the row exactly as renderRow prints it when it is the widest row in each
  // column (padToWidth is the identity), with the raw event type in front so `run_end` is
  // greppable the way logs --grep's haystack carries e.type.
  const row: TickRow = {
    ts: 1,
    time: "2026-10-10 12:00:00",
    role: "feature",
    run: 7,
    result: "changed",
    durationMs: 45_000,
    tokens: 1234,
    costUsd: 0.5,
    usage: "1234 tok · $0.50",
    detail: "added a widget",
  };
  assert.equal(
    tickRowGrepHaystack(row),
    "run_end 2026-10-10 12:00:00  feature  #7  merged  45s  1234 tok · $0.50  added a widget feature changed",
  );
  // A row whose run_end lost its start keeps the em dash the renderer shows — not a
  // fabricated duration; the trailing empty cells trim away exactly as renderRow's trimEnd does.
  const unpaired: TickRow = { ...row, durationMs: null, usage: "", detail: "" };
  assert.equal(tickRowGrepHaystack(unpaired), "run_end 2026-10-10 12:00:00  feature  #7  merged  — feature changed");
});

test("a corrupt event's loop renders as ? like the reports", () => {
  // eventRole's "?" rule (the usage report and failure digest already apply it); the row
  // used to carry String(undefined)'s literal "undefined", which the history table and the
  // GUI's /api/history rows printed.
  const rows = tickRows([{ ts: 1, type: "run_end", run: 1, result: "changed" } as never], 10, null);
  assert.equal(rows[0]!.role, "?");
});

test("a corrupt event's tick reads as 0, never NaN", () => {
  // The row's tick used to be Number(e.tick) raw: a torn or hand-edited run_end rendered
  // "#NaN" in the table and shipped JSON null (JSON.stringify(NaN)) in /api/history.
  for (const tick of [undefined, NaN, Infinity, "oops"] as const) {
    const rows = tickRows([endEvent({ run: tick } as never)], 10, null);
    assert.equal(rows[0]!.run, 0);
  }
});

test("a corrupt run_end outcome renders as ?, never undefined", () => {
  // The result cell used String(e.result) raw: a torn or hand-edited run_end rendered the
  // literal "undefined" in the history table and /api/history rows. It now rides the shared
  // outcomeText, matching the loop's and tick's corrupt-field rule.
  for (const result of [undefined, 7, null] as const) {
    const rows = tickRows([endEvent({ result } as never)], 10, null);
    assert.equal(rows[0]!.result, "?");
  }
});

test("a queued tick's torn landing outcome reads as its type default, never [object Object]", () => {
  // resolveQueuedResult read the landing outcome's result through String(), so a torn or
  // hand-edited `landed` event whose result parsed to an object rendered the literal
  // "[object Object]" in the history table and /api/history. The shared textOr read falls
  // back to the landed type's own default instead.
  const events = [
    { ts: 40, loop: "feature", type: "land_queued", commit: "sha1", summary: "work" },
    { ts: 42, loop: "feature", type: "run_end", run: 1, result: "queued", summary: "work" },
    { ts: 50, loop: "feature", type: "landed", commit: "sha1", result: { torn: true } },
  ] as never;
  const rows = tickRows(events, 10, null);
  assert.equal(rows[0]!.result, "changed");
});

test("a torn summary falls back to the tick's error, never [object Object]", () => {
  // The detail cell read String(e.summary ?? e.error): a summary that parsed to an object is
  // not nullish, so the real error was hidden behind "[object Object]". textOr reads the
  // summary as no text and falls through to the error.
  const rows = tickRows(
    [endEvent({ summary: { torn: true }, error: "disk full" } as never)],
    10,
    null,
  );
  assert.equal(rows[0]!.detail, "disk full");
});

test("tickRows pairs each run_end with its run_start for the duration", () => {
  const rows = tickRows(
    [
      startEvent({ ts: 1000, loop: "feature", run: 1 }),
      endEvent({ ts: 46_000, loop: "feature", run: 1, summary: "tidy up" }),
    ],
    20,
    null,
  );
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.role, "feature");
  assert.equal(row.run, 1);
  assert.equal(row.result, "changed");
  assert.equal(row.durationMs, 45_000); // 45s, not 46s: measured from the start event.
  assert.equal(row.detail, "tidy up");
});

test("tickRows renders no duration when the tick's start is outside the scanned window", () => {
  // A skipped tick never logs run_start; log rotation can drop an older start too. Neither
  // may claim a duration.
  const rows = tickRows([endEvent({ ts: 5000, run: 2, result: "skipped" })], 20, null);
  assert.equal(rows[0]!.durationMs, null);
  assert.equal(rows[0]!.result, "skipped");
});

test("tickRows returns the newest limit rows, newest first, and filters by role", () => {
  const events = [
    startEvent({ ts: 1000, loop: "feature", run: 1 }),
    endEvent({ ts: 2000, loop: "feature", run: 1 }),
    endEvent({ ts: 3000, loop: "clean", run: 1, result: "no_change" }),
    endEvent({ ts: 4000, loop: "feature", run: 2, result: "error", error: "boom" }),
    endEvent({ ts: 5000, loop: "feature", run: 3, result: "no_change" }),
  ];
  assert.deepEqual(
    tickRows(events, 2, null).map((r) => [r.role, r.run, r.result]),
    [
      ["feature", 3, "no_change"],
      ["feature", 2, "error"],
    ],
  );
  // The error row's detail is the error; the summary-less no_change row has none.
  const all = tickRows(events, 20, null);
  assert.equal(all[1]!.detail, "boom");
  assert.equal(all[0]!.detail, "");
  // --role narrows to one loop, ends and starts alike: the clean tick vanishes, and feature's
  // durations still pair.
  const scoped = tickRows(events, 20, "clean");
  assert.deepEqual(scoped.map((r) => [r.role, r.run]), [["clean", 1]]);
  const feature = tickRows(events, 20, "feature");
  assert.equal(feature.length, 3);
  assert.equal(feature[2]!.durationMs, 1000); // tick 1 still paired within the scoped window.
});

test("tickRows shows tokens and cost only when the event carries them", () => {
  const withUsage = tickRows(
    [endEvent({ ts: 1000, run: 1, tokens: 1234, costUsd: 0.5 })],
    20,
    null,
  )[0]!;
  assert.equal(withUsage.usage, "1234 tok · $0.50");
  const bare = tickRows([endEvent({ ts: 1000, run: 1 })], 20, null)[0]!;
  assert.equal(bare.usage, "");
  const zero = tickRows([endEvent({ ts: 1000, run: 1, tokens: 0, costUsd: 0 })], 20, null)[0]!;
  assert.equal(zero.usage, "");
});

test("tickRows collapses and truncates the detail to keep the row one line", () => {
  const rows = tickRows(
    [endEvent({ ts: 1000, run: 1, summary: "wrapped  across\nmany   lines" })],
    20,
    null,
  );
  assert.equal(rows[0]!.detail, "wrapped across many lines");
  const long = tickRows([endEvent({ ts: 1000, run: 1, summary: "x".repeat(200) })], 20, null);
  assert.ok(long[0]!.detail.length < 200);
  assert.ok(long[0]!.detail.endsWith("…"));
});

test("a missing or empty log reads as no rows over a covered window", () => {
  const missing = tmpdir();
  assert.deepEqual(readTickRowsSince(missing, TWO_HOURS, null), { rows: [], covered: true });

  const empty = tmpdir();
  writeEvents(empty, []);
  assert.deepEqual(readTickRowsSince(empty, TWO_HOURS, null), { rows: [], covered: true });
});

test("rows keep the in-window ticks, newest first, and drop everything before the cutoff", () => {
  const root = tmpdir();
  const cutoff = Date.now() - TWO_HOURS;
  // The log is append-only chronological: the pre-cutoff tick rides first.
  writeEvents(root, [
    endEvent({ ts: cutoff - MIN, run: 1, result: "no_change" }),
    endEvent({ ts: Date.now() - 30 * MIN, run: 2 }),
    endEvent({ ts: Date.now() - 10 * MIN, run: 3, summary: "latest work" }),
  ]);
  const { rows } = readTickRowsSince(root, TWO_HOURS, null);
  assert.deepEqual(
    rows.map((r) => [r.run, r.result, r.detail]),
    [
      [3, "changed", "latest work"],
      [2, "changed", ""],
    ],
  );
});

test("a tick spanning the cutoff renders a dash: the ts filter removes its start too", () => {
  const root = tmpdir();
  // One clock read per test, every ts derived from it (the BUGS.md 2026-09-30 strictEqual
  // flake in the --role test below was exactly this shape: a durationMs asserted at an exact
  // value while its two ts reads were independent Date.now() calls, so a clock slew between
  // them jitters the span). A span is now exact arithmetic on one base.
  const base = Date.now();
  const t = (mins: number) => base - mins * MIN;
  const cutoff = base - TWO_HOURS;
  writeEvents(root, [
    // Started before the cutoff, ended inside it: the window's ts filter drops the start,
    // so the row must show the dash, not a duration spanning the cutoff.
    startEvent({ ts: cutoff - MIN, run: 1 }),
    endEvent({ ts: t(10), run: 1 }),
    // Fully inside the window: still paired, still timed.
    startEvent({ ts: t(30), run: 2 }),
    endEvent({ ts: t(20), run: 2 }),
  ]);
  const { rows } = readTickRowsSince(root, TWO_HOURS, null);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.run, 2);
  assert.equal(rows[0]!.durationMs, 10 * MIN);
  assert.equal(rows[1]!.run, 1);
  assert.equal(rows[1]!.durationMs, null);
});

test("a run_end with a corrupt ts renders the em dash time, never NaN", () => {
  // The history table renders row.time unguarded; a corrupt ts reached it as
  // `NaN-NaN-NaN NaN:NaN:NaN`. formatTimestamp now owns that guard, so the row time is safe
  // for both a non-finite number and a non-numeric JSON field.
  const rows = tickRows(
    [endEvent({ ts: NaN, run: 1 }), endEvent({ ts: "oops" as never, run: 2 })],
    10,
    null,
  );
  assert.deepEqual(
    rows.map((r) => [r.run, r.time]),
    [
      [2, "—"],
      [1, "—"],
    ],
  );
});

test("--role narrows the window to one loop", () => {
  const root = tmpdir();
  // One clock read (see the span test above): the durationMs assertion at the bottom is
  // exact arithmetic on this base, not a difference of two independent Date.now() calls.
  const base = Date.now();
  const t = (mins: number) => base - mins * MIN;
  writeEvents(root, [
    startEvent({ ts: t(30), loop: "feature", run: 1 }),
    endEvent({ ts: t(20), loop: "feature", run: 1 }),
    endEvent({ ts: t(15), loop: "clean", run: 1, result: "no_change" }),
    endEvent({ ts: t(5), loop: "clean", run: 2, result: "changed" }),
  ]);
  const all = readTickRowsSince(root, TWO_HOURS, null);
  assert.deepEqual(all.rows.map((r) => [r.role, r.run]), [
    ["clean", 2],
    ["clean", 1],
    ["feature", 1],
  ]);
  const clean = readTickRowsSince(root, TWO_HOURS, "clean");
  assert.deepEqual(clean.rows.map((r) => [r.role, r.run]), [
    ["clean", 2],
    ["clean", 1],
  ]);
  // The role filter scoping starts as well: the feature tick still pairs within its rows.
  const feature = readTickRowsSince(root, TWO_HOURS, "feature");
  assert.equal(feature.rows[0]!.durationMs, 10 * MIN);
});

test("a queued tick resolves to its change's landing outcome — landed or land_failed (BUGS.md 2026-09-30)", () => {
  const root = tmpdir();
  const t = (mins: number) => Date.now() - mins * MIN;
  // The real order: land_queued is logged DURING the tick (before its run_end); the landing
  // slot logs landed/land_failed with the same commit sha later.
  writeEvents(root, [
    { ts: t(50), loop: "feature", type: "run_start", run: 1 },
    { ts: t(49), loop: "feature", type: "land_queued", commit: "sha1", summary: "work one" },
    { ts: t(48), loop: "feature", type: "run_end", run: 1, result: "queued", summary: "work one" },
    { ts: t(40), loop: "feature", type: "landed", commit: "sha1", result: "changed" },
    { ts: t(30), loop: "feature", type: "run_start", run: 2 },
    { ts: t(29), loop: "feature", type: "land_queued", commit: "sha2", summary: "work two" },
    { ts: t(28), loop: "feature", type: "run_end", run: 2, result: "queued", summary: "work two" },
    { ts: t(20), loop: "feature", type: "land_failed", commit: "sha2", result: "merge_conflict" },
  ]);
  const { rows } = readTickRowsSince(root, TWO_HOURS, null);
  // Each queued row joins its OWN change: the newest land_queued at or before its run_end,
  // then the FINAL same-sha landing outcome after that pin — never the other tick's.
  assert.deepEqual(
    rows.map((r) => [r.run, r.result, r.detail]),
    [
      [2, "merge_conflict", "work two"],
      [1, "changed", "work one"],
    ],
  );
});

test("a queued tick resolves past a rebased retriable failure to the recovery's landed verdict (BUGS.md 2026-10-10)", () => {
  const root = tmpdir();
  const t = (mins: number) => Date.now() - mins * MIN;
  // A retriable landing failure (merge_blocked) keeps the pin. When main moved first, the
  // vet's syncPinToMain rebased the ref before the gate, so recovery re-enqueues the REBASED
  // sha (sha2) while the failed attempt logged its authored sha (sha1), and the recovery's
  // `landed` logs sha2. The authoring tick's row must read the FINAL outcome ("changed"),
  // not latch sha1's first, non-terminal failure.
  writeEvents(root, [
    { ts: t(50), loop: "feature", type: "run_start", run: 1 },
    { ts: t(49), loop: "feature", type: "land_queued", commit: "sha1", summary: "work one" },
    { ts: t(48), loop: "feature", type: "run_end", run: 1, result: "queued", summary: "work one" },
    { ts: t(40), loop: "feature", type: "land_failed", commit: "sha1", result: "merge_blocked" },
    { ts: t(30), loop: "feature", type: "run_start", run: 2 },
    { ts: t(29), loop: "feature", type: "land_queued", commit: "sha2", summary: "recovered leftover work from feature: work one" },
    { ts: t(28), loop: "feature", type: "run_end", run: 2, result: "queued", summary: "recovered leftover work from feature: work one" },
    { ts: t(20), loop: "feature", type: "landed", commit: "sha2", result: "changed" },
  ]);
  const { rows } = readTickRowsSince(root, TWO_HOURS, null);
  assert.deepEqual(
    rows.map((r) => [r.run, r.result]),
    [
      [2, "changed"],
      [1, "changed"],
    ],
  );
});

test("a retriable failure keeps its verdict while its recovery pin is still pending (BUGS.md 2026-10-10)", () => {
  const root = tmpdir();
  const t = (mins: number) => Date.now() - mins * MIN;
  // The rebased recovery pin is enqueued but has no outcome yet, so the last verdict visible
  // for the authoring change is still its retriable failure — the row keeps it (the behavior
  // before the chain fix), not the recovery's raw "queued".
  writeEvents(root, [
    { ts: t(50), loop: "feature", type: "run_start", run: 1 },
    { ts: t(49), loop: "feature", type: "land_queued", commit: "sha1", summary: "work one" },
    { ts: t(48), loop: "feature", type: "run_end", run: 1, result: "queued", summary: "work one" },
    { ts: t(40), loop: "feature", type: "land_failed", commit: "sha1", result: "merge_blocked" },
    { ts: t(30), loop: "feature", type: "run_start", run: 2 },
    { ts: t(29), loop: "feature", type: "land_queued", commit: "sha2", summary: "recovered leftover work from feature: work one" },
    { ts: t(28), loop: "feature", type: "run_end", run: 2, result: "queued", summary: "recovered leftover work from feature: work one" },
  ]);
  const { rows } = readTickRowsSince(root, TWO_HOURS, null);
  assert.deepEqual(
    rows.map((r) => [r.run, r.result]),
    [
      [2, "queued"],
      [1, "merge_blocked"],
    ],
  );
});

test("a queued tick whose pin sits before the --since cutoff still resolves (BUGS.md 2026-09-30)", () => {
  const root = tmpdir();
  // Tick 1 SPANS the cutoff: its run_start and land_queued pin sit before it, its run_end
  // and landing outcome after it. The row set (ts-filtered at the cutoff) keeps the run_end
  // and the outcome but cuts the pin — so the join reads wider evidence (TICK_ROW_JOIN_BACK
  // SLACK_MS) for the pins and claims them only while the row's tick block is whole there.
  // Tick 2 sits fully inside the window; both changes land, so both rows must resolve.
  const cutoff = Date.now() - SINCE;
  const before = (mins: number) => cutoff - mins * MIN;
  const after = (mins: number) => cutoff + mins * MIN;
  writeEvents(root, [
    { ts: before(6), loop: "feature", type: "run_start", run: 1 },
    { ts: before(5), loop: "feature", type: "land_queued", commit: "sha1", summary: "work one" },
    { ts: after(1), loop: "feature", type: "run_end", run: 1, result: "queued", summary: "work one" },
    { ts: after(2), loop: "feature", type: "landed", commit: "sha1", result: "changed" },
    { ts: after(3), loop: "feature", type: "run_start", run: 2 },
    { ts: after(4), loop: "feature", type: "land_queued", commit: "sha2", summary: "work two" },
    { ts: after(5), loop: "feature", type: "run_end", run: 2, result: "queued", summary: "work two" },
    { ts: after(10), loop: "feature", type: "landed", commit: "sha2", result: "changed" },
  ]);
  const { rows } = readTickRowsSince(root, SINCE, null);
  assert.deepEqual(
    rows.map((r) => [r.run, r.result, r.detail]),
    [
      [2, "changed", "work two"],
      [1, "changed", "work one"],
    ],
  );
});

test("a queued row whose run_start predates the join read's floor keeps the raw label", () => {
  // The guard, unit-pinned on the pure collector: a row whose tick block is not whole in the
  // join set (here the floor sits between the run_start and the pin) cannot prove its own
  // pin survived the read, and a pre-cutoff tick's pin IS in the join set — claiming it would
  // join another change's landing. Conservative fallback: the raw label.
  const events: HarnessEvent[] = [
    { ts: 1_000, loop: "feature", type: "run_start", run: 1 },
    { ts: 1_100, loop: "feature", type: "land_queued", commit: "shaOld", summary: "old work" },
    { ts: 1_200, loop: "feature", type: "run_end", run: 1, result: "no_change", summary: "old work" },
    { ts: 2_000, loop: "feature", type: "run_start", run: 2 },
    { ts: 2_100, loop: "feature", type: "land_queued", commit: "sha1", summary: "work one" },
    { ts: 2_200, loop: "feature", type: "run_end", run: 2, result: "queued", summary: "work one" },
    { ts: 2_500, loop: "feature", type: "landed", commit: "sha1", result: "changed" },
  ];
  // The row set is the ts-filtered tail the since scan would keep (tick 1 dropped as
  // pre-cutoff); the join set is the unfiltered read, floor between tick 2's start and pin.
  const rowEvents = events.filter((e) => e.ts >= 1_500);
  const rows = tickRows(rowEvents, rowEvents.length, null, { events, floorTs: 2_050 });
  assert.deepEqual(rows.map((r) => [r.run, r.result]), [[2, "queued"]]);
  // The same rows with a floor BELOW tick 2's start resolve normally: the guard only bites
  // when the join read may have cut the tick's own block.
  const resolved = tickRows(rowEvents, rowEvents.length, null, { events, floorTs: 1_500 });
  assert.deepEqual(resolved.map((r) => [r.run, r.result]), [[2, "changed"]]);
});

test("a queued tick whose landing is still in the pipeline keeps the raw label", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: Date.now() - 10 * MIN, loop: "feature", type: "run_start", run: 1 },
    { ts: Date.now() - 9 * MIN, loop: "feature", type: "land_queued", commit: "sha1", summary: "pending work" },
    { ts: Date.now() - 8 * MIN, loop: "feature", type: "run_end", run: 1, result: "queued", summary: "pending work" },
  ]);
  assert.deepEqual(
    readTickRowsSince(root, TWO_HOURS, null).rows.map((r) => [r.run, r.result]),
    [[1, "queued"]],
  );
});

test("a queued tick stays raw when no landing outcome matches its pinned sha", () => {
  const root = tmpdir();
  // The only landing outcome in the log resolved a DIFFERENT change (an older retry's sha):
  // joining by loop alone would steal it, so the sha must match and the unmatched row keeps
  // the raw label (its verdict is genuinely not in the log — still in the pipeline).
  writeEvents(root, [
    { ts: Date.now() - 40 * MIN, loop: "feature", type: "landed", commit: "sha0", result: "changed" },
    { ts: Date.now() - 10 * MIN, loop: "feature", type: "run_start", run: 1 },
    { ts: Date.now() - 9 * MIN, loop: "feature", type: "land_queued", commit: "sha1", summary: "unresolved work" },
    { ts: Date.now() - 8 * MIN, loop: "feature", type: "run_end", run: 1, result: "queued", summary: "unresolved work" },
  ]);
  assert.deepEqual(
    readTickRowsSince(root, TWO_HOURS, null).rows.map((r) => [r.run, r.result]),
    [[1, "queued"]],
  );
});

test("the resolution survives the --role filter and never crosses loops", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: Date.now() - 30 * MIN, loop: "feature", type: "land_queued", commit: "shaF", summary: "feature work" },
    { ts: Date.now() - 29 * MIN, loop: "feature", type: "run_end", run: 1, result: "queued", summary: "feature work" },
    { ts: Date.now() - 25 * MIN, loop: "clean", type: "land_queued", commit: "shaC", summary: "clean work" },
    { ts: Date.now() - 24 * MIN, loop: "clean", type: "run_end", run: 1, result: "queued", summary: "clean work" },
    { ts: Date.now() - 20 * MIN, loop: "feature", type: "landed", commit: "shaF", result: "changed" },
    { ts: Date.now() - 15 * MIN, loop: "clean", type: "land_failed", commit: "shaC", result: "rejected" },
  ]);
  const all = readTickRowsSince(root, TWO_HOURS, null);
  assert.deepEqual(
    all.rows.map((r) => [r.role, r.run, r.result]),
    [
      ["clean", 1, "rejected"],
      ["feature", 1, "changed"],
    ],
  );
  // The role-filtered scope carries each loop's own landing events, so the join holds there too.
  const clean = readTickRowsSince(root, TWO_HOURS, "clean");
  assert.deepEqual(clean.rows.map((r) => [r.role, r.result]), [["clean", "rejected"]]);
});

test("covered is false while the log starts inside the window, true once an event predates the cutoff", () => {
  const inside = tmpdir();
  writeEvents(inside, [
    endEvent({ ts: Date.now() - 30 * MIN, run: 1 }),
    endEvent({ ts: Date.now() - 10 * MIN, run: 2 }),
  ]);
  assert.equal(readTickRowsSince(inside, TWO_HOURS, null).covered, false);

  // The same log plus one older run: the window's oldest event predates the cutoff, so
  // the read covers it — exactly the predicate cmdLogs' coverage note consults.
  const spanning = tmpdir();
  const cutoff = Date.now() - TWO_HOURS;
  writeEvents(spanning, [
    endEvent({ ts: cutoff - MIN, run: 1, result: "no_change" }),
    endEvent({ ts: Date.now() - 30 * MIN, run: 2 }),
  ]);
  assert.equal(readTickRowsSince(spanning, TWO_HOURS, null).covered, true);
});

test("summarizeTickRows tallies each loop's outcome classes in name order with a total", () => {
  const row = (role: string, result: string, ts = 0): TickRow => ({
    ts, time: "", role, run: 1, result, durationMs: null, tokens: 0, costUsd: 0, usage: "", detail: "",
  });
  const summary = summarizeTickRows([
    row("feature", "changed", 100),
    row("bugfix", "queued", 300),
    row("feature", "no_change", 900),
    row("bugfix", "skipped", 800),
    row("feature", "error", 700),
    row("bugfix", "rejected", 600),
  ]);
  assert.deepEqual(summary.roles, [
    { role: "bugfix", runs: 3, changes: 1, none: 1, problems: 1, tokens: 0, costUsd: 0, lastChangeTs: 300 },
    { role: "feature", runs: 3, changes: 1, none: 1, problems: 1, tokens: 0, costUsd: 0, lastChangeTs: 100 },
  ]);
  assert.deepEqual(summary.total, { role: "total", runs: 6, changes: 2, none: 2, problems: 2, tokens: 0, costUsd: 0, lastChangeTs: 300 });
  assert.deepEqual(summarizeTickRows([]), { roles: [], total: { role: "total", runs: 0, changes: 0, none: 0, problems: 0, tokens: 0, costUsd: 0, lastChangeTs: null } });
  const newest = summarizeTickRows([row("a", "changed", 5), row("a", "changed", 9), row("a", "changed", 7)]);
  assert.equal(newest.roles[0]?.lastChangeTs, 9);
});

test("summarizeTickRows sums tokens and cost per loop and into the total", () => {
  const row = (role: string, tokens: number, costUsd: number): TickRow => ({
    ts: 0, time: "", role, run: 1, result: "changed", durationMs: null, tokens, costUsd, usage: "", detail: "",
  });
  const summary = summarizeTickRows([
    row("feature", 1000, 0.1),
    row("bugfix", 200, 0.02),
    row("feature", 14000, 1.4),
    row("bugfix", 0, 0),
  ]);
  assert.deepEqual(summary.roles, [
    { role: "bugfix", runs: 2, changes: 2, none: 0, problems: 0, tokens: 200, costUsd: 0.02, lastChangeTs: 0 },
    { role: "feature", runs: 2, changes: 2, none: 0, problems: 0, tokens: 15000, costUsd: 1.5, lastChangeTs: 0 },
  ]);
  assert.deepEqual(summary.total, { role: "total", runs: 4, changes: 4, none: 0, problems: 0, tokens: 15200, costUsd: 1.52, lastChangeTs: 0 });
});

test("renderSummary shows tokens and cost columns formatted via compactTokens and usd", () => {
  const row = (role: string, tokens: number, costUsd: number): HistorySummaryRow => ({
    role, runs: 1, changes: 1, none: 0, problems: 0, tokens, costUsd, lastChangeTs: null,
  });
  const out = renderSummary({ roles: [row("feature", 14000, 0.5)], total: row("total", 14000, 0.5) });
  const lines = out.split("\n");
  assert.match(lines[0]!, /tokens\s+cost/);
  // Each data row's tokens/cost cells are right-aligned under their headers and formatted.
  for (const l of lines.slice(1)) {
    assert.match(l, /\b14\.0k\b/);
    assert.match(l, /\$0\.50/);
  }
});
