import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { feedbackFilingsPath } from "../paths.js";
import { isJsonObject } from "../files/json-object.js";
import { formatAge } from "../text/datetime.js";

/** The `feedback` observer's per-install filing ledger (plans/feedback-role.md 2/2). Every
 * `feedback` run starts a fresh pi session, so the only durable record of which GitHub issues
 * this install already filed must live in harness state — the same cross-run memory qa's
 * flow-coverage ledger provides (plans/observer-roles.md 2/2), and what makes the next run's
 * prompt able to render a "previously filed" block so the charter's dedupe does not rely on the
 * network alone. The ledger is gitignored runtime state under .tumwater/state/ and degrades to
 * "no data" on any missing or malformed file: an observer must never fail a run on bookkeeping
 * (a filing that fails to persist is a warning, never a run failure). */

/** The newest bound the ledger keeps. A fresh session files at most one issue per run, so this
 * caps the block's growth and the prompt's size; older filings are dropped (the charter still
 * dedupes against the live `gh issue list`). */
export const FEEDBACK_FILINGS_MAX = 100;

/** One previously-filed GitHub issue: its number, title, and when this install filed it. */
interface FeedbackFiling {
  issue: number;
  title: string;
  filedAt: number;
}

/** One row of the operator read of the `feedback` filing ledger: the issue number, title, and
 * when it was filed, ordered newest-first by `filingRows`. The single ordering the prompt
 * block, `tumwater role feedback`, the TUI notes view and the dashboard drawer all share, so
 * none of them can drift on what was filed. */
export interface FilingRow {
  issue: number;
  title: string;
  filedAt: number;
}

/** Collect the ledger into `FilingRow`s newest-first by `filedAt` — a stable sort, so two
 * filings sharing a timestamp keep their ledger (insertion) order. A ledger stored by
 * `recordFiled` is already newest-first, so this reorders nothing on the normal path; it
 * guarantees a hand-edited or torn file that is not already ordered still reads consistently. */
export function filingRows(filings: readonly FeedbackFiling[]): FilingRow[] {
  return [...filings].sort((a, b) => b.filedAt - a.filedAt);
}

function isFiling(value: unknown): value is FeedbackFiling {
  if (!isJsonObject(value)) return false;
  return (
    typeof value.issue === "number" &&
    typeof value.title === "string" &&
    typeof value.filedAt === "number"
  );
}

/** Read the ledger, keeping only well-formed entries. A missing, torn, or wrong-shaped file
 * reads as an empty ledger — the caller renders no block and the run proceeds as before. */
export function readFeedbackFilings(root: string): FeedbackFiling[] {
  const file = readJsonFile<{ filings?: unknown }>(feedbackFilingsPath(root));
  const filings = file?.filings;
  if (!Array.isArray(filings)) return [];
  return filings.filter(isFiling);
}

/** Record that this install filed issue `issue` now (or at `now`, for tests). Reads-modifies-
 * writes the whole ledger atomically so a concurrent writer cannot leave a torn file behind,
 * and keeps only the newest FEEDBACK_FILINGS_MAX entries. */
export function recordFiled(
  root: string,
  issue: number,
  title: string,
  now: number = Date.now(),
): void {
  const filings = readFeedbackFilings(root);
  const entry: FeedbackFiling = { issue, title, filedAt: now };
  writeJsonAtomic(feedbackFilingsPath(root), {
    filings: [entry, ...filings].slice(0, FEEDBACK_FILINGS_MAX),
  });
}

/** Render the "previously filed" block for the next `feedback` prompt; undefined when the
 * ledger is empty (the common first-run case), so the prompt is unchanged then. Newest-first,
 * each line `#<n> <title> (<age>)` mirroring qa's coverage lines. */
export function renderFilingsBlock(filings: readonly FeedbackFiling[], now: number = Date.now()): string | undefined {
  if (filings.length === 0) return undefined;
  // Render through filingRows, the one ordering the prompt block and the operator read share,
  // so a ledger not already newest-first still reads that way in both places.
  const lines = filingRows(filings).map(
    (f) => `  #${f.issue} ${f.title} (${formatAge(now - f.filedAt)})`,
  );
  return ["Previously filed from this install:", ...lines].join("\n");
}
