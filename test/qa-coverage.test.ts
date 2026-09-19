import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  QA_FLOWS,
  readQaCoverage,
  recordFlow,
  renderCoverageBlock,
} from "../src/qa-coverage.js";
import { qaCoveragePath } from "../src/paths.js";
import { tmpdir } from "./util.js";

/** Unit coverage for src/qa-coverage.ts — the `qa` observer's flow-coverage ledger
 * (plans/observer-roles.md 2/2). Every tick is a fresh session and a passing cheap check
 * leaves nothing in the repo, so this runtime file is the only memory that rotates the flow
 * menu; its read path must degrade to "no data" rather than fail a tick, and its render order
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

test("readQaCoverage treats missing, torn, and wrong-shaped files as no data", () => {
  const root = tmpdir();
  assert.deepEqual(readQaCoverage(root), {}, "missing file");
  fs.mkdirSync(`${root}/.tumwater/state`, { recursive: true });
  fs.writeFileSync(qaCoveragePath(root), "{ not json");
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
