import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { qaCoveragePath } from "../paths.js";
import { isJsonObject, setOwn } from "../files/json-object.js";
import { DAY_MS, formatAge } from "../text/datetime.js";

/** The `qa` observer's flow-coverage ledger (plans/observer-roles.md 2/2). Every `qa` run
 * starts a fresh pi session, so the only durable memory of which flow it last exercised is a
 * runtime file the harness — not pi — maintains. A passing cheap check writes nothing into the
 * repo (a note commit per check would move main and wake every sleeping role), so without this
 * ledger the model picks a flow blind every run and converges on the top of its menu. The
 * ledger is gitignored runtime state under .tumwater/state/ and degrades to "no data" on any
 * missing or malformed file: an observer must never fail a run on bookkeeping. */

/** The flows `qa` exercises, cheapest-first — the ordered menu from plans/qa-role.md, plus the
 * expensive `run (real)` variant. The names are the universe the coverage block renders; a flow
 * recorded by name but absent here (a project-specific flow) still renders, appended after. */
export const QA_FLOWS: readonly string[] = [
  "init",
  "status",
  "logs",
  "prompt",
  "reset-counters",
  "gui",
  "tui",
  "run",
  "run (real)",
];

/** How a flow went: `passed` (the flow worked as documented) or `bug` (a BUGS.md entry was
 * filed). The result token is load-bearing: `run (real)` commits a `## Verified` note on a
 * passing run, so "the run changed files" cannot stand in for "a bug was found". */
export type QaFlowResult = "passed" | "bug";

/** One flow's last exercise. `summary` is the bug headline for a `bug` result, shown in the
 * next coverage block so the model can see what was already reported. */
interface QaFlowEntry {
  lastRunAt: number;
  result: QaFlowResult;
  summary?: string;
}

/** The ledger: flow name → its last exercise. */
export type QaCoverage = Record<string, QaFlowEntry>;

/** A coverage ledger whose newest exercise is older than this window is a stall: the `qa`
 * role — the team's only flow-level observer, the one role that exercises the product's own
 * flows like a user — has silently stopped recording any exercise (disabled, paused, wedged,
 * or failing before it records). The doctor `qa coverage` warn fires through this one
 * threshold, mirroring `ciParityStalled`'s `CI_PARITY_STALE_MS`. */
export const QA_COVERAGE_STALE_MS = 3 * DAY_MS;

/** True only when the ledger has at least one well-formed entry and every entry's `lastRunAt`
 * is older than the stall window (`now - max(lastRunAt) > QA_COVERAGE_STALE_MS`). An empty
 * ledger — a missing file, or a project that never ran qa — is not a stall: "no record yet" is
 * not "stopped recording", the same rule `ciParityStalled` applies to a missing parity record.
 * This is the one stall predicate the doctor's `qa coverage` row (`checkQaCoverage`) reads, so
 * the row and the ledger cannot disagree on when a quiet qa is a problem. */
export function qaCoverageStalled(coverage: QaCoverage, now: number): boolean {
  let newest = 0;
  let has = false;
  for (const entry of Object.values(coverage)) {
    has = true;
    if (entry.lastRunAt > newest) newest = entry.lastRunAt;
  }
  return has && now - newest > QA_COVERAGE_STALE_MS;
}

/** One flow's row in the operator-facing coverage view (`coverageRows`) — the flow name plus
 * its last exercise and result, or nulls for a flow never exercised. `summary` is the bug
 * headline for a `bug` result, present only when the ledger records one (a pass or an
 * unexercised flow never carries it). */
export interface CoverageRow {
  flow: string;
  lastRunAt: number | null;
  result: QaFlowResult | null;
  summary?: string;
}

function isResult(value: unknown): value is QaFlowResult {
  return value === "passed" || value === "bug";
}

/** Read the ledger, keeping only well-formed entries. A missing, torn, or wrong-shaped file
 * reads as an empty ledger — the caller renders no block and the run proceeds as before. */
export function readQaCoverage(root: string): QaCoverage {
  const file = readJsonFile<{ flows?: unknown }>(qaCoveragePath(root));
  const flows = file?.flows;
  if (!isJsonObject(flows)) return {};
  const out: QaCoverage = {};
  for (const [name, raw] of Object.entries(flows)) {
    if (!isJsonObject(raw)) continue;
    const entry = raw;
    if (typeof entry.lastRunAt !== "number" || !isResult(entry.result)) continue;
    setOwn(out, name, {
      lastRunAt: entry.lastRunAt,
      result: entry.result,
      ...(typeof entry.summary === "string" ? { summary: entry.summary } : {}),
    });
  }
  return out;
}

/** Record that `flow` was exercised now (or at `now`, for tests). Reads-modifies-writes the
 * whole ledger atomically so a concurrent writer cannot leave a torn file behind. */
export function recordFlow(
  root: string,
  flow: string,
  result: QaFlowResult,
  summary?: string,
  now: number = Date.now(),
): void {
  const coverage = readQaCoverage(root);
  setOwn(coverage, flow, { lastRunAt: now, result, ...(summary ? { summary } : {}) });
  writeJsonAtomic(qaCoveragePath(root), { flows: coverage });
}

/** The coverage as ordered rows — the one universe (menu plus recorded project-specific flows)
 * and one ordering (never-exercised first, then exercised stalest-first, ties in menu order)
 * that the next `qa` prompt's block and the operator-facing views share, so they cannot drift.
 * Never-exercised flows lead (age = ∞), then exercised flows oldest-first, so "exercise the
 * flow at the top" actually rotates through the whole menu instead of re-picking whatever is
 * cheapest. The flow universe is `QA_FLOWS` plus any recorded name (a project-specific flow
 * still surfaces, appended after the menu). */
export function coverageRows(coverage: QaCoverage, now: number = Date.now()): CoverageRow[] {
  const names = [...QA_FLOWS];
  for (const name of Object.keys(coverage)) {
    if (!names.includes(name)) names.push(name);
  }
  return names
    .map((name, index) => ({ name, index, entry: coverage[name] }))
    .sort((a, b) => {
      const ageA = a.entry ? now - a.entry.lastRunAt : Number.POSITIVE_INFINITY;
      const ageB = b.entry ? now - b.entry.lastRunAt : Number.POSITIVE_INFINITY;
      if (ageA !== ageB) return ageB - ageA; // stalest first; never-exercised (∞) leads
      return a.index - b.index; // stable: keep the menu order among equals
    })
    .map(({ name, entry }) => ({
      flow: name,
      lastRunAt: entry?.lastRunAt ?? null,
      result: entry?.result ?? null,
      ...(entry?.summary !== undefined ? { summary: entry.summary } : {}),
    }));
}

/** Render the coverage block for the next `qa` prompt — the same rows `coverageRows` orders,
 * one line each (a two-space-prefixed row, never-exercised flows first). */
export function renderCoverageBlock(coverage: QaCoverage, now: number = Date.now()): string {
  const lines = coverageRows(coverage, now).map(({ flow, lastRunAt, result, summary }) => {
    if (lastRunAt === null) return `  ${flow} — never exercised`;
    const age = formatAge(now - lastRunAt);
    const status =
      result === "bug"
        ? `bug filed (BUGS.md: "${summary ?? "see BUGS.md"}")`
        : "passed";
    return `  ${flow} — ${age} ago, ${status}`;
  });
  return [
    "Flow coverage (from this team's own record; least recently exercised first):",
    ...lines,
  ].join("\n");
}
