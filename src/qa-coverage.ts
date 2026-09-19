import { readJsonFile, writeJsonAtomic } from "./json-files.js";
import { qaCoveragePath } from "./paths.js";

/** The `qa` observer's flow-coverage ledger (plans/observer-roles.md 2/2). Every `qa` tick
 * starts a fresh pi session, so the only durable memory of which flow it last exercised is a
 * runtime file the harness — not pi — maintains. A passing cheap check writes nothing into the
 * repo (a note commit per check would move main and wake every sleeping loop), so without this
 * ledger the model picks a flow blind every tick and converges on the top of its menu. The
 * ledger is gitignored runtime state under .tumwater/state/ and degrades to "no data" on any
 * missing or malformed file: an observer must never fail a tick on bookkeeping. */

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
 * passing run, so "the tick changed files" cannot stand in for "a bug was found". */
type QaFlowResult = "passed" | "bug";

/** One flow's last exercise. `summary` is the bug headline for a `bug` result, shown in the
 * next coverage block so the model can see what was already reported. */
interface QaFlowEntry {
  lastRunAt: number;
  result: QaFlowResult;
  summary?: string;
}

/** The ledger: flow name → its last exercise. */
type QaCoverage = Record<string, QaFlowEntry>;

function isResult(value: unknown): value is QaFlowResult {
  return value === "passed" || value === "bug";
}

/** Read the ledger, keeping only well-formed entries. A missing, torn, or wrong-shaped file
 * reads as an empty ledger — the caller renders no block and the tick proceeds as before. */
export function readQaCoverage(root: string): QaCoverage {
  const file = readJsonFile<{ flows?: unknown }>(qaCoveragePath(root));
  const flows = file?.flows;
  if (typeof flows !== "object" || flows === null || Array.isArray(flows)) return {};
  const out: QaCoverage = {};
  for (const [name, raw] of Object.entries(flows)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.lastRunAt !== "number" || !isResult(entry.result)) continue;
    out[name] = {
      lastRunAt: entry.lastRunAt,
      result: entry.result,
      ...(typeof entry.summary === "string" ? { summary: entry.summary } : {}),
    };
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
  coverage[flow] = { lastRunAt: now, result, ...(summary ? { summary } : {}) };
  writeJsonAtomic(qaCoveragePath(root), { flows: coverage });
}

/** A short age: minutes under an hour, hours under a day, days beyond (`12m`, `4h`, `6d`). */
function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Render the coverage block for the next `qa` prompt. Never-exercised flows lead (age = ∞),
 * then exercised flows oldest-first, so "exercise the flow at the top" actually rotates through
 * the whole menu instead of re-picking whatever is cheapest. The flow universe is `QA_FLOWS`
 * plus any recorded name (a project-specific flow still surfaces). */
export function renderCoverageBlock(coverage: QaCoverage, now: number = Date.now()): string {
  const names = [...QA_FLOWS];
  for (const name of Object.keys(coverage)) {
    if (!names.includes(name)) names.push(name);
  }
  const rows = names
    .map((name, index) => ({ name, index, entry: coverage[name] }))
    .sort((a, b) => {
      const ageA = a.entry ? now - a.entry.lastRunAt : Number.POSITIVE_INFINITY;
      const ageB = b.entry ? now - b.entry.lastRunAt : Number.POSITIVE_INFINITY;
      if (ageA !== ageB) return ageB - ageA; // stalest first; never-exercised (∞) leads
      return a.index - b.index; // stable: keep the menu order among equals
    });
  const lines = rows.map(({ name, entry }) => {
    if (!entry) return `  ${name} — never exercised`;
    const age = formatAge(now - entry.lastRunAt);
    const status =
      entry.result === "bug"
        ? `bug filed (BUGS.md: "${entry.summary ?? "see BUGS.md"}")`
        : "passed";
    return `  ${name} — ${age} ago, ${status}`;
  });
  return [
    "Flow coverage (from this fleet's own record; least recently exercised first):",
    ...lines,
  ].join("\n");
}
