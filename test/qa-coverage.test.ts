import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  QA_FLOWS,
  coverageRows,
  readQaCoverage,
  recordFlow,
  renderCoverageBlock,
} from "../src/run/qa-coverage.js";
import type { QaCoverage, QaFlowResult } from "../src/run/qa-coverage.js";
import { qaCoveragePath } from "../src/paths.js";
import { tmpdir, writeMalformedJson } from "./fixtures/repo-fixtures.js";
import { readJson } from "./helpers/json-read.js";

/** Unit coverage for src/run/qa-coverage.ts — the `qa` observer's flow-coverage ledger
 * (plans/observer-roles.md 2/2). Every run is a fresh session and a passing cheap check
 * leaves nothing in the repo, so this runtime file is the only memory that rotates the flow
 * menu; its read path must degrade to "no data" rather than fail a run, and its render order
 * is load-bearing (never-exercised first, then oldest-first) because the prompt tells the
 * model to exercise the top row. */

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("QA_FLOWS mirrors the qa menu, cheapest-first, with the expensive real run last", () => {
  assert.deepEqual(QA_FLOWS, [
    "init",
    "status",
    "logs",
    "prompt",
    "reset-counters",
    "gui",
    "tui",
    "run",
    "run (real)",
  ]);
});

test("recordFlow writes an entry that readQaCoverage round-trips", () => {
  const root = tmpdir();
  recordFlow(root, "status", "passed", undefined, NOW);
  assert.deepEqual(readQaCoverage(root), {
    status: { lastRunAt: NOW, result: "passed" },
  });
  recordFlow(root, "run (real)", "bug", "status --json omits the fallback badge", NOW + 1);
  assert.deepEqual(readQaCoverage(root), {
    status: { lastRunAt: NOW, result: "passed" },
    "run (real)": {
      lastRunAt: NOW + 1,
      result: "bug",
      summary: "status --json omits the fallback badge",
    },
  });
  // The ledger lives under .tumwater/state and is never tracked — the path builder is the guard.
  assert.equal(qaCoveragePath(root), `${root}/.tumwater/state/qa-coverage.json`);
});

test("recordFlow replaces a flow's previous entry rather than appending", () => {
  const root = tmpdir();
  recordFlow(root, "logs", "passed", undefined, NOW);
  recordFlow(root, "logs", "bug", "logs -f drops the last line", NOW + 5 * MIN);
  assert.deepEqual(readQaCoverage(root).logs, {
    lastRunAt: NOW + 5 * MIN,
    result: "bug",
    summary: "logs -f drops the last line",
  });
});

test("recordFlow and readQaCoverage keep a flow named __proto__", () => {
  const root = tmpdir();
  // A qa model's FLOW line names the flow, so the name crosses an external boundary. A plain
  // `coverage[flow] = entry` (or `out[name] = entry`) with the key `__proto__` hits
  // Object.prototype's setter and rewrites the map's prototype instead of adding an own entry,
  // losing the flow from every reader and from the persisted JSON.
  recordFlow(root, "__proto__", "passed", undefined, NOW);
  const coverage = readQaCoverage(root);
  assert.ok(Object.hasOwn(coverage, "__proto__"), "the flow is an own entry, not the map's prototype");
  assert.deepEqual(Object.getOwnPropertyDescriptor(coverage, "__proto__")?.value, {
    lastRunAt: NOW,
    result: "passed",
  });
  const file = readJson(qaCoveragePath(root)) as { flows: unknown };
  assert.ok(Object.hasOwn(file.flows as object, "__proto__"), "the persisted file keeps the flow");
});

test("readQaCoverage reads a persisted flow named __proto__", () => {
  const root = tmpdir();
  fs.mkdirSync(`${root}/.tumwater/state`, { recursive: true });
  fs.writeFileSync(
    qaCoveragePath(root),
    JSON.stringify({ flows: { ["__proto__"]: { lastRunAt: NOW, result: "bug", summary: "boom" } } }),
  );
  const coverage = readQaCoverage(root);
  assert.ok(Object.hasOwn(coverage, "__proto__"), "the flow is an own entry");
  assert.deepEqual(Object.getOwnPropertyDescriptor(coverage, "__proto__")?.value, {
    lastRunAt: NOW,
    result: "bug",
    summary: "boom",
  });
});

test("readQaCoverage treats missing, torn, and wrong-shaped files as no data", () => {
  const root = tmpdir();
  assert.deepEqual(readQaCoverage(root), {}, "missing file");
  fs.mkdirSync(`${root}/.tumwater/state`, { recursive: true });
  writeMalformedJson(qaCoveragePath(root));
  assert.deepEqual(readQaCoverage(root), {}, "torn JSON");
  fs.writeFileSync(qaCoveragePath(root), JSON.stringify(["array"]));
  assert.deepEqual(readQaCoverage(root), {}, "array is not a ledger object");
  fs.writeFileSync(qaCoveragePath(root), JSON.stringify({ flows: "nope" }));
  assert.deepEqual(readQaCoverage(root), {}, "flows is not an object");
});

test("readQaCoverage drops malformed entries but keeps the well-formed ones", () => {
  const root = tmpdir();
  fs.mkdirSync(`${root}/.tumwater/state`, { recursive: true });
  fs.writeFileSync(
    qaCoveragePath(root),
    JSON.stringify({
      flows: {
        status: { lastRunAt: NOW, result: "passed" },
        logs: { lastRunAt: "soon", result: "passed" },
        gui: { lastRunAt: NOW, result: "maybe" },
        tui: null,
        prompt: { lastRunAt: NOW, result: "bug", summary: "the prompt box ate my text" },
      },
    }),
  );
  assert.deepEqual(readQaCoverage(root), {
    status: { lastRunAt: NOW, result: "passed" },
    prompt: { lastRunAt: NOW, result: "bug", summary: "the prompt box ate my text" },
  });
});

test("renderCoverageBlock leads with never-exercised flows, then oldest-first", () => {
  const block = renderCoverageBlock(
    {
      status: { lastRunAt: NOW - 4 * HOUR, result: "passed" },
      prompt: { lastRunAt: NOW - 2 * DAY, result: "bug", summary: "prompt --list misnumbered" },
      gui: { lastRunAt: NOW - 4 * DAY, result: "passed" },
      "run (real)": { lastRunAt: NOW - 6 * DAY, result: "passed" },
    },
    NOW,
  );
  const lines = block.split("\n");
  // The header, then never-exercised menu flows in menu order, then exercised oldest-first.
  assert.match(lines[0]!, /least recently exercised first/);
  assert.deepEqual(lines.slice(1), [
    "  init — never exercised",
    "  logs — never exercised",
    "  reset-counters — never exercised",
    "  tui — never exercised",
    "  run — never exercised",
    "  run (real) — 6d ago, passed",
    "  gui — 4d ago, passed",
    '  prompt — 2d ago, bug filed (BUGS.md: "prompt --list misnumbered")',
    "  status — 4h ago, passed",
  ]);
});

test("renderCoverageBlock formats ages as minutes, hours, and days", () => {
  const block = renderCoverageBlock(
    {
      init: { lastRunAt: NOW - 12 * MIN, result: "passed" },
      status: { lastRunAt: NOW - 5 * HOUR, result: "passed" },
      logs: { lastRunAt: NOW - 3 * DAY, result: "passed" },
    },
    NOW,
  );
  assert.match(block, /init — 12m ago, passed/);
  assert.match(block, /status — 5h ago, passed/);
  assert.match(block, /logs — 3d ago, passed/);
});

test("renderCoverageBlock surfaces a recorded flow outside the built-in menu", () => {
  const block = renderCoverageBlock(
    { "deploy check": { lastRunAt: NOW - HOUR, result: "passed" } },
    NOW,
  );
  assert.match(block, /deploy check — 1h ago, passed/);
});

test("renderCoverageBlock on an empty ledger lists every flow as never exercised", () => {
  const block = renderCoverageBlock({}, NOW);
  for (const flow of QA_FLOWS) assert.match(block, new RegExp(`  ${flow.replace(/[()]/g, "\\$&")} — never exercised`));
});

test("coverageRows keeps the prompt block's order and shape", () => {
  // A coverage with a recent recorded `status` and no `gui` entry: the menu flow `gui`
  // (never exercised) must lead the recorded stalest-first flow, in the ordering the prompt
  // block and the operator views share from this one function.
  const coverage: QaCoverage = {
    status: { lastRunAt: NOW - 4 * HOUR, result: "passed" },
    prompt: { lastRunAt: NOW - 2 * DAY, result: "bug", summary: "prompt --list misnumbered" },
  };
  const rows = coverageRows(coverage, NOW);
  const gui = rows.find((r) => r.flow === "gui")!;
  const status = rows.find((r) => r.flow === "status")!;
  const prompt = rows.find((r) => r.flow === "prompt")!;
  assert.deepEqual(gui, { flow: "gui", lastRunAt: null, result: null });
  const statusResult: QaFlowResult = status.result!; // the exported result union is load-bearing
  assert.equal(statusResult, "passed");
  assert.deepEqual(status, { flow: "status", lastRunAt: NOW - 4 * HOUR, result: "passed" });
  assert.deepEqual(prompt, {
    flow: "prompt",
    lastRunAt: NOW - 2 * DAY,
    result: "bug",
    summary: "prompt --list misnumbered",
  });
  assert.ok(rows.indexOf(gui) < rows.indexOf(status), "never-exercised gui leads the exercised status");
  assert.ok(rows.indexOf(prompt) < rows.indexOf(status), "stalest exercised flow comes first");
  // The same coverage renders the same lines as the prompt block's existing cases — the
  // refactor maps renderCoverageBlock over these rows, so the block and the rows cannot drift.
  const block = renderCoverageBlock(
    { status: { lastRunAt: NOW - 4 * HOUR, result: "passed" }, prompt: { lastRunAt: NOW - 2 * DAY, result: "bug", summary: "prompt --list misnumbered" } },
    NOW,
  );
  assert.match(block, /  status — 4h ago, passed/);
  assert.match(block, /  prompt — 2d ago, bug filed \(BUGS\.md: "prompt --list misnumbered"\)/);
  assert.match(block, /  gui — never exercised/);
});
