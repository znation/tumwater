/** The rendered status table suite: renderStatus's table-level behavior (totals, clipping,
 * work items, pauses, ordering). The per-cell suites (lastTickCell, today, last result,
 * next run) live beside it in status-render-cells.test.ts, the status-model suite
 * (loopPhase, workingDetail) in status-model.test.ts, the header badges' in
 * status-header.test.ts, and the badges' in badges.test.ts; the fixtures both assemble
 * snapshots from are in status-fixtures.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { renderStatus } from "../src/ui/status-render.js";
import { displayWidth } from "../src/text/text-width.js";
import { loopPhase } from "../src/ui/status-model.js";
import { snapshot, type StatusSnapshot } from "../src/status/status-data.js";
import { freshLoopState, saveLoopState } from "../src/loop/loop-state.js";
import { initProject } from "../src/init/init.js";
import { orchestratorStatePath } from "../src/paths.js";
import { tmpdir, makeRepo } from "./repo-fixtures.js";
import { writeOrchestratorMarker } from "./log-fixtures.js";
import { assistantLine } from "./pi-events.js";
import {
  DEFAULT_BUDGET,
  headerOf,
  SESSION,
  snapshotWith,
  tableCells,
  toolStart,
  writePiLog,
} from "./status-fixtures.js";

test("status table ends with a totals row summing tokens and cost", () => {
  const snap = snapshotWith([
    { role: "clean", generatedTokens: 900_000, peakContextTokens: 120_000, totalCostUsd: 1.25 },
    { role: "dry", generatedTokens: 350_000, peakContextTokens: 80_000, totalCostUsd: 0.5 },
  ]);
  const lines = renderStatus(tmpdir(), snap).split("\n");
  const totals = lines[lines.length - 1] ?? "";
  const separator = lines[lines.length - 2] ?? "";
  assert.match(totals, /^total\b/);
  // 900,000 + 350,000 = 1,250,000: the row must use the same k/M magnitude rule as the rest
  // of the surface (regression 2026-09-20 — it used to print "1250.0k").
  assert.match(totals, /1\.3M/, "generated sum is compact-formatted with M past a million");
  assert.match(totals, /120\.0k/, "peak ctx totals cell is the max across loops");
  assert.match(totals, /\$1\.75/);
  assert.match(separator, /^-+( +-+)+\s*$/, "totals row sits below a separator");
});

test("totals row shows zeros without breaking alignment", () => {
  const snap = snapshotWith([{ role: "clean" }, { role: "dry" }]);
  const lines = renderStatus(tmpdir(), snap).split("\n");
  const totals = lines[lines.length - 1] ?? "";
  assert.match(totals, /^total\b/);
  assert.match(totals, /\b0\b/);
  assert.match(totals, /\$0\.00/);
});

// User-defined loops (tumwater.json's customLoops) are marked with an asterisk beside their
// name plus one footnote line under the table — and a fleet without any of them renders the
// exact same table as before the marker existed.

test("status table marks user-defined loops with an asterisk and a footnote", () => {
  const snap = snapshotWith([{ role: "clean" }, { role: "nightly", custom: true }]);
  const text = renderStatus(tmpdir(), snap);
  assert.match(text, /nightly\*/);
  assert.doesNotMatch(text, /clean\*/, "built-ins stay unmarked");
  // The footnote is the line under the table — one per fleet, not per loop.
  const lines = text.split("\n");
  assert.equal(lines[lines.length - 1], "* user-defined loop");
  assert.equal(text.match(/user-defined loop/g)?.length, 1);

  // No customs: no asterisk anywhere and the table still ends at its totals row.
  const plain = renderStatus(tmpdir(), snapshotWith([{ role: "clean" }, { role: "dry" }]));
  assert.doesNotMatch(plain, /\*/);
  assert.match((plain.split("\n") as string[]).at(-1) ?? "", /^total\b/);
});

test("narrow-width clipping still holds when a custom loop is marked", () => {
  const snap = snapshotWith([
    { role: "nightly", custom: true, lastResult: "changed", lastSummary: "x".repeat(120), ticks: 7 },
    { role: "clean" },
  ]);
  for (const width of [40, 60]) {
    for (const line of renderStatus(tmpdir(), snap, width).split("\n")) {
      assert.ok(line.length <= width, `line exceeds ${width} cols: ${JSON.stringify(line)} (${line.length})`);
    }
  }
});

test("renderStatus with maxWidth clips every line and truncates wide cells", () => {
  const snap = snapshotWith([
    {
      role: "improve",
      lastResult: "changed",
      lastSummary: "an extremely long tick summary that would normally blow the table out past eighty columns easily",
      ticks: 3,
      commits: 1,
    },
    { role: "clean" },
  ]);
  const capped = renderStatus(tmpdir(), snap, 80);
  for (const line of capped.split("\n")) {
    assert.ok(line.length <= 80, `line exceeds 80 cols: ${JSON.stringify(line)} (${line.length})`);
  }
  assert.match(capped, /…/, "over-wide cells are ellipsis-truncated");
  // Uncapped output keeps the full summary.
  assert.match(renderStatus(tmpdir(), snap), /eighty columns easily/);
});

test("narrow terminals never receive a wrapping line even below column minimums", () => {
  const snap = snapshotWith([
    { role: "organize", lastResult: "changed", lastSummary: "x".repeat(120), ticks: 12, commits: 9 },
  ]);
  for (const width of [40, 60]) {
    for (const line of renderStatus(tmpdir(), snap, width).split("\n")) {
      assert.ok(line.length <= width, `width ${width} violated: ${line.length}`);
    }
  }
});

test("gen/peak ctx combine persisted totals with live in-tick progress for running loops only", () => {
  const root = tmpdir();
  // In-flight tick: this run's session plus two completed turns (800 output, peak 12k).
  writePiLog(root, "clean", [
    SESSION,
    assistantLine("turn one", { tokens: 8_000, output: 300 }),
    assistantLine("turn two", { tokens: 12_000, output: 500 }),
  ]);
  // Idle loop whose log tail is its last COMPLETED tick (already in the persisted totals).
  writePiLog(root, "dry", [SESSION, assistantLine("done tick", { tokens: 5_000, output: 500 })]);
  const snap = snapshotWith([
    { role: "clean", generatedTokens: 1_000, peakContextTokens: 6_000, running: true },
    { role: "dry", generatedTokens: 2_000, peakContextTokens: 4_000 },
  ]);
  const out = renderStatus(root, snap);
  const cleanRow = out.split("\n").find((l) => l.startsWith("clean")) ?? "";
  assert.match(cleanRow, /\b1800\b/, "running loop gen = persisted + live output (1000+300+500)");
  assert.match(cleanRow, /12\.0k/, "running loop peak ctx = max(persisted, live) = 12000");
  const dryRow = out.split("\n").find((l) => l.startsWith("dry")) ?? "";
  assert.match(dryRow, /\b2000\b/, "idle loop gen stays persisted — its log tail is not double-counted");
  assert.match(dryRow, /\b4000\b/);
  const totals = out.split("\n").at(-1) ?? "";
  assert.match(totals, /\b3800\b/, "totals row sums the displayed (combined) values");
});

// Current work item in the table's state cell (renderStatus row level).

test("renderStatus prepends the current work item to a working loop's state cell", () => {
  const root = tmpdir();
  writePiLog(root, "feature", [
    SESSION,
    assistantLine('implement plan "Linear history on main"'),
    toolStart("bash", { command: "npm test" }),
  ]);
  // Orchestrator running (snap.running) so the in-flight tick renders as working.
  const snap = { ...snapshotWith([{ role: "feature", running: true, lastTickStartedAt: Date.now() - 5_000 }]), running: true };
  const out = renderStatus(root, snap);
  assert.match(out, /implement plan "Linear history on main" · working \ds · turn 2/);
});

test("renderStatus does not leak a finished tick's work item into an idle loop's state cell", () => {
  const root = tmpdir();
  writePiLog(root, "feature", [SESSION, assistantLine("old finished work")]);
  // Orchestrator running but the loop itself is idle (queued/sleeping).
  const snap = { ...snapshotWith([{ role: "feature" }]), running: true };
  const out = renderStatus(root, snap);
  assert.doesNotMatch(out, /old finished work/);
});

test("renderStatus leaves the state cell unchanged while working but before any text", () => {
  const root = tmpdir();
  writePiLog(root, "feature", [SESSION, toolStart("bash", { command: "npm test" })]); // no assistant text yet
  const snap = { ...snapshotWith([{ role: "feature", running: true, lastTickStartedAt: Date.now() - 5_000 }]), running: true };
  assert.match(renderStatus(root, snap), /working \ds · turn 1/);
});

test("work items survive narrow-terminal clipping at the head of the state cell", () => {
  const root = tmpdir();
  writePiLog(
    root,
    "feature",
    [SESSION, assistantLine(`implement plan "${"x".repeat(50)}"`), toolStart("bash", { command: "npm test" })],
  );
  const snap = { ...snapshotWith([{ role: "feature", running: true, lastTickStartedAt: Date.now() - 5_000 }]), running: true };
  for (const width of [80, 60]) {
    for (const line of renderStatus(root, snap, width).split("\n")) {
      assert.ok(line.length <= width, `width ${width} violated: ${line.length}`);
    }
  }
  // The item is prepended, so its head survives even when the cell shrinks to its minimum
  // and gets clipped hard (an appended item would be invisible at this width).
  const narrow = renderStatus(root, snap, 60).split("\n").find((l) => l.startsWith("feature")) ?? "";
  assert.match(narrow, /^feature\s+implement p…/);
});

test("loopPhase shows failing for idle loops stuck on an error streak, not sleeping", () => {
  // BUGS.md 2026-09-15: a fleet whose every loop is failing must read as failing, not as
  // an ordinary quiet/sleeping fleet.
  const s = freshLoopState("feature");
  s.lastResult = "error";
  s.consecutiveErrors = 3;
  s.nextRunAt = Date.now() + 1_800_000;
  assert.equal(loopPhase(s, true), "failing", "the streak at the threshold outranks sleep");

  // Below the threshold the loop keeps its ordinary label — a few failed ticks are
  // retryable transients, not a health state.
  const shallow = freshLoopState("feature");
  shallow.lastResult = "error";
  shallow.consecutiveErrors = 2;
  shallow.nextRunAt = Date.now() + 1_800_000;
  assert.match(loopPhase(shallow, true), /^sleeping/);

  // A deeper streak stays failing, even queued.
  const deep = freshLoopState("feature");
  deep.lastResult = "error";
  deep.consecutiveErrors = 4;
  assert.equal(loopPhase(deep, true), "failing");

  // A streak fed by leftover-recovery landing failures reads failing even though the tick's
  // own result is healthy (BUGS.md 2026-09-21): the landing failure, not `lastResult`, is the
  // tell. Before the fix this cell showed "sleeping" while a dead reviewer backend wedged the
  // pin forever.
  const recovered = freshLoopState("feature");
  recovered.lastResult = "no_change";
  recovered.consecutiveErrors = 3;
  recovered.nextRunAt = Date.now() + 1_800_000;
  assert.equal(loopPhase(recovered, true), "failing", "a recovery-failure streak outranks sleep");

  // In-flight ticks are untouched (the label describes the finished tick only).
  const running = freshLoopState("feature");
  running.running = true;
  running.lastResult = "error";
  running.consecutiveErrors = 3;
  assert.equal(loopPhase(running, true), "working");

  // The table's state cell carries the label through to status output.
  const snap = snapshotWith([{ role: "feature", lastResult: "error", consecutiveErrors: 3 }]);
  const out = renderStatus(tmpdir(), { ...snap, running: true });
  assert.match(out, /feature\s+failing/);
});

test("renderStatus shows the main-red blockage in a blocked loop's state cell and last-result line", () => {
  const snap = snapshotWith([
    { role: "feature", lastResult: "main_red", lastSummary: "code merges blocked until main is green" },
    { role: "bugfix" }, // exempt roles keep their ordinary phase
  ]);
  const out = renderStatus(tmpdir(), { ...snap, running: true });
  assert.match(out, /feature\s+main red/);
  assert.match(out, /main_red — code merges blocked until main is green/);
  assert.match(out, /bugfix\s+queued/);
});


test("renderStatus shows budget paused in idle role loops' state cells while the cap is reached", () => {
  const root = tmpdir();
  // Spend below the cap: ordinary labels.
  const under = renderStatus(
    root,
    { ...snapshotWith([{ role: "feature" }, { role: "director" }], { spentUsd: 10, capUsd: 50, capHitAt: null, free: false, fallback: null }), running: true },
  );
  assert.match(under, /feature\s+queued/);
  assert.doesNotMatch(under, /budget paused/);

  // Spend at the cap: idle role loops whose tier resolved to pause read `budget paused`;
  // the director keeps its own phase.
  const reached = renderStatus(
    root,
    { ...snapshotWith([{ role: "feature" }, { role: "director" }], { spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: null }), budgetPausedRoles: ["feature"], running: true },
  );
  assert.match(reached, /feature\s+budget paused/);
  assert.match(reached, /director\s+waiting for prompts/);

  // The header badge shows the reached budget on the same render.
  assert.match(headerOf(reached), /· budget: \$50\.00\/\$50 today$/);
});

// Per-role pause (`tumwater pause --role <id>`): the snapshot's pausedRoles set gates the same
// `paused` cell as the fleet flag, but only for the named role — every other idle row keeps
// its ordinary label, and the director keeps its own phase (its cell branch precedes the
// pause checks, like under the fleet pause).
test("renderStatus shows paused only for the individually paused idle role", () => {
  const root = tmpdir();
  const out = renderStatus(
    root,
    {
      ...snapshotWith([{ role: "docs" }, { role: "feature" }, { role: "director" }], DEFAULT_BUDGET, false, ["docs"]),
      running: true,
    },
  );
  assert.match(out, /docs\s+paused/);
  assert.match(out, /feature\s+queued/);
  assert.doesNotMatch(out, /feature\s+paused/);
  assert.match(out, /director\s+waiting for prompts/);

  // An empty set changes nothing — the fleet-wide flag alone drives the cell, as before.
  const none = renderStatus(
    root,
    { ...snapshotWith([{ role: "docs" }], DEFAULT_BUDGET, false, []), running: true },
  );
  assert.doesNotMatch(none, /\bpaused\b/);
});

// Regression (review of the editable-budget feature): the snapshot's budget object is now
// unconditional, so a DISABLED cap (capUsd 0) must not read as reached — spend ≥ 0 would
// otherwise flag every idle loop `budget paused` on a fleet with no cap at all.
test("renderStatus never reads budget paused while the cap is disabled, even past any spend", () => {
  const root = tmpdir();
  // Cap disabled (0) with today's spend far above zero: the gate is off by definition.
  const out = renderStatus(
    root,
    { ...snapshotWith([{ role: "feature" }, { role: "director" }], { spentUsd: 999, capUsd: 0, capHitAt: null, free: false, fallback: null }), running: true },
  );
  assert.doesNotMatch(out, /budget paused/, "no loop reads budget paused with the cap disabled");
  assert.match(out, /feature\s+queued/);
  assert.match(out, /director\s+waiting for prompts/);
  // The badge stays standing and says no cap.
  assert.match(headerOf(out), /· budget: \$999\.00 today · no cap$/);
});

test("renderStatus shows paused in idle role loops' state cells ahead of budget paused and main red", () => {
  const root = tmpdir();
  // No pause: ordinary labels.
  const unpaused = renderStatus(
    root,
    { ...snapshotWith([{ role: "feature" }, { role: "director" }]), running: true },
  );
  assert.match(unpaused, /feature\s+queued/);
  assert.doesNotMatch(unpaused, /\bpaused\b/);

  // Marker present with the cap also reached and main red: idle role loops read `paused`
  // ahead of both; the director keeps its own phase. (The last-result column still carries
  // the raw main_red string — only the state cell is overridden.)
  const paused = renderStatus(
    root,
    {
      ...snapshotWith(
        [{ role: "feature", lastResult: "main_red" }, { role: "director" }],
        { spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: null },
        true,
      ),
      running: true,
    },
  );
  assert.match(paused, /feature\s+paused/);
  assert.doesNotMatch(paused, /budget paused/);
  assert.doesNotMatch(paused, /main red/);
  assert.match(paused, /director\s+waiting for prompts/);
});

test("renderStatus keeps role loops working under the fallback and pauses them without one", () => {
  const root = tmpdir();
  const loops = [{ role: "feature" }, { role: "director" }];
  // At the cap WITH a usable free fallback: the loops keep ticking on it, so no row reads
  // `budget paused` — the header badge is where the operator learns the cap is spent.
  const degraded = renderStatus(root, {
    ...snapshotWith(loops, { spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: { provider: "omlx", model: "local-free" } }),
    running: true,
  });
  assert.doesNotMatch(degraded, /budget paused/, "a fallback fleet is not a stopped fleet");
  assert.match(degraded, /feature\s+queued/);
  assert.match(headerOf(degraded), /· budget: \$50\.00\/\$50 today · fallback: local-free \(cost n\/a\)$/);

  // The same spend with no usable fallback pauses the role loops, exactly as before — per
  // role now (part 5c/8): the snapshot's budgetPausedRoles set, not a fleet-wide verdict.
  const stopped = renderStatus(root, {
    ...snapshotWith(loops, { spentUsd: 50, capUsd: 50, capHitAt: null, free: false, fallback: null }),
    budgetPausedRoles: ["feature"],
    running: true,
  });
  assert.match(stopped, /feature\s+budget paused/);
});

test("status table groups a landing role above queued/sleeping rows with newer last ticks", () => {
  const root = tmpdir();
  const t = (min: number) => Date.parse("2026-09-11T00:00:00Z") + min * 60000;
  // A sleeping role and a queued role, both with a NEWER last tick than the landing role —
  // grouping must still put the landing role first, the same active-first rule as the GUI
  // table. Before the fix renderStatus emitted payload order, so landing sank with the idles.
  const sleeping = freshLoopState("sleepy");
  sleeping.nextRunAt = Date.now() + 5 * 60_000;
  sleeping.lastTickEndedAt = t(5);
  const queued = freshLoopState("queued-z");
  queued.lastTickEndedAt = t(4);
  const landing = freshLoopState("landing-r");
  landing.lastTickEndedAt = t(0);
  const snap: StatusSnapshot = {
    ...snapshotWith([sleeping, queued, landing]),
    running: true,
    landQueue: {
      depth: 1,
      inFlight: { role: "landing-r", sha: "abc1234", summary: "tidy", startedAt: Date.now() - 90_000 },
    } as StatusSnapshot["landQueue"],
  };
  const lines = renderStatus(root, snap).split("\n");
  const rowOf = (role: string) => lines.findIndex((l) => l.startsWith(role));
  assert.ok(rowOf("landing-r") >= 0, "the landing role has a row");
  assert.ok(rowOf("landing-r") < rowOf("sleepy"), "landing sorts above a sleeping row with a newer last tick");
  assert.ok(rowOf("landing-r") < rowOf("queued-z"), "landing sorts above a queued row with a newer last tick");
  assert.match(lines[rowOf("landing-r")]!, /landing \dm\d+s/);
});

/** `line` expanded to one entry per terminal display column — a wide character fills both of
 * its columns. The alignment probe's substrate: misalignment is invisible to character-index
 * arithmetic but obvious column-by-column. */
function columns(line: string): string[] {
  const out: string[] = [];
  for (const ch of line) for (let k = 0; k < displayWidth(ch); k++) out.push(ch);
  return out;
}

test("status table keeps every column boundary aligned when a cell holds a wide character", () => {
  // A custom loop's summary carries CJK text (two terminal columns per code point): widths
  // derived from UTF-16 code units under-measure it, and code-unit padding leaves that row's
  // later columns shifted left against the header and every ASCII row.
  const snap = snapshotWith([
    { role: "clean" },
    { role: "dry", lastResult: "changed", lastSummary: "翻译了三个文件" },
  ]);
  const lines = renderStatus(tmpdir(), snap).split("\n");
  // The separator line (index 3) names each column's boundary in display columns: the
  // cumulative width of its dash runs plus the two-space gaps.
  const boundaries: number[] = [];
  let w = 0;
  for (const seg of (lines[3] ?? "").split("  ")) {
    w += displayWidth(seg);
    boundaries.push(w);
    w += 2;
  }
  // Every fully-populated table line (the column header, the two data rows) must place each
  // cell exactly between its neighbors: at every interior boundary the two gap columns are
  // blank and the next cell's content starts right after them. A row whose wide-character
  // cell was measured and padded by UTF-16 code units renders wider than its column, and its
  // later cells drift right — the drift shows up as blank padding where content belongs.
  // (The totals row is exempt: several of its cells are legitimately empty.)
  const sep2 = lines.findIndex((l, i) => i > 3 && l.startsWith("---"));
  const table = [lines[2] ?? "", ...lines.slice(4, sep2 < 0 ? lines.length : sep2)];
  assert.equal(table.length, 3, "column header plus two data rows render");
  for (const line of table) {
    const c = columns(line);
    for (const b of boundaries.slice(0, -1)) {
      assert.ok(c.length > b + 2, `line reaches past boundary ${b}: ${line}`);
      assert.equal(c[b], " ", `gap before boundary ${b} is not blank in: ${line}`);
      assert.equal(c[b + 1], " ", `gap after boundary ${b} is not blank in: ${line}`);
      assert.notEqual(c[b + 2], " ", `next cell does not start at boundary ${b}+2 in: ${line}`);
    }
  }
});

test("a loop with queued prompts carries a p:N marker on its state cell", () => {
  const snap = snapshotWith([{ role: "clean" }, { role: "dry" }], DEFAULT_BUDGET, false, [], { clean: 2 });
  const lines = renderStatus(tmpdir(), snap).split("\n");
  const cleanRow = lines.find((l) => l.startsWith("clean")) ?? "";
  assert.match(cleanRow, /p:2/, "the queued count rides the state cell");
  const dryRow = lines.find((l) => l.startsWith("dry")) ?? "";
  assert.doesNotMatch(dryRow, /p:/, "an empty queue renders no marker");
  assert.doesNotMatch(lines[lines.length - 1] ?? "", /p:/, "the totals row stays marker-free");
});


test("snapshot and renderStatus cover all enabled loops", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  const state = freshLoopState("clean");
  state.ticks = 3;
  state.commits = 2;
  state.lastResult = "changed";
  state.lastSummary = "tidy something";
  saveLoopState(repo, state);

  const snap = snapshot(repo);
  assert.equal(snap.running, false);
  assert.ok(snap.loops.some((l) => l.role === "clean" && l.ticks === 3));
  const text = renderStatus(repo, snap);
  assert.match(text, /not running/);
  assert.match(text, /tidy something/);
  for (const role of ["organize", "coverage", "clean", "dry", "feature", "bugfix", "plan", "readme", "improve", "director"]) {
    assert.match(text, new RegExp(role));
  }
});


test("no rendered line carries trailing padding, blank trailing cells included", () => {
  // The totals row ends in three blank cells; before the span-wise trim popped blank-cell
  // spans it broke on the first empty span ("".trimEnd() === "") and the row rendered with
  // its padding — 26 trailing spaces on the fixture's totals row — intact.
  const snap = snapshotWith([{ role: "clean" }], DEFAULT_BUDGET);
  // A width sweep too: clipped lines re-pad and must trim just the same.
  for (const maxWidth of [undefined, 200, 120, 100, 80, 60]) {
    for (const line of renderStatus(tmpdir(), snap, maxWidth).split("\n")) {
      assert.equal(line, line.trimEnd(), `maxWidth ${maxWidth ?? "default"}: trailing padding survived`);
    }
  }
  // Trimming is line-final only: the aligned cells inside the table are untouched.
  const t = tableCells(renderStatus(tmpdir(), snap));
  assert.equal(t.cellAt(t.lines[t.lines.length - 1] ?? "", 7), "$0.00");
});


test("a rendered fleet shows active rows equal to permit holders: parked waiters read `awaiting slot`", async () => {
  const repo = makeRepo();
  await initProject(repo, "test project");
  // A live-looking orchestrator (this process's pid) so loopPhase renders in-flight states.
  writeOrchestratorMarker(repo, []);
  // One permit-holding tick (running, no parkedSince) and two parked waiters.
  const holder = freshLoopState("feature");
  holder.running = true;
  holder.lastTickStartedAt = Date.now() - 5_000; // renders the elapsed working detail
  saveLoopState(repo, holder);
  for (const role of ["clean", "organize"]) {
    const parked = freshLoopState(role);
    parked.running = true;
    parked.parkedSince = Date.now() - 5_000;
    saveLoopState(repo, parked);
  }
  const text = renderStatus(repo, snapshot(repo));
  // The waiters show their true state, not `working`.
  assert.equal(text.split("\n").filter((l) => l.includes("awaiting slot")).length, 2);
  // Exactly one active working row: the only real permit holder.
  assert.equal(text.split("\n").filter((l) => /\bworking \d/.test(l)).length, 1);
  fs.rmSync(orchestratorStatePath(repo), { force: true });
});

test("the loop name cell appends the seam tier and selector when a tier map is declared", () => {
  const snap = snapshotWith([
    { role: "plan", modelTier: "strong", model: "prov-s/model-s:high" } as never,
    { role: "clean" },
  ]);
  const text = renderStatus(tmpdir(), snap);
  assert.match(text, /plan \(strong · prov-s\/model-s:high\)/);
  // No tier fields: the name cell stays `clean` — today's bytes.
  assert.doesNotMatch(text, /clean \(/);
});
