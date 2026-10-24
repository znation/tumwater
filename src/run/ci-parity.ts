/** The `ci` observer's CI-parity ledger (plans, part 3/3). Every `ci` run starts a fresh pi
 * session, so the only durable memory of which main tip and `package-lock.json` each run
 * covered is a runtime file the harness — not pi — maintains. The role runs the workflow's own
 * full suite and e2e, which is minutes of work, so its nothing-to-do decision must be cheap:
 * the parity block tells the fresh session what the last run covered, and when main has not
 * moved (and the lock is unchanged) since a green run, the role declares nothing-to-do in one
 * model run instead of re-running the whole suite. The ledger is gitignored runtime state
 * under .tumwater/state/ and degrades to "no data" on any missing or malformed file: an
 * observer must never fail a run on bookkeeping (the same policy as qa-coverage.ts). */

import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { ciParityPath } from "../paths.js";
import { isJsonObject } from "../files/json-object.js";
import { currentBranchFromHeadFile, readBranchHead, targetBranch } from "../git/git.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

/** One CI run's record of what it covered and how it went. `tip` is the main tip the run
 * actually exercised — the sha named on the run's `CI:` line, so a fresh session that
 * remembers nothing still knows what the last run covered. `lockHash` is the hash of
 * `package-lock.json` at that coverage, computed by the harness at record time (the run's
 * `CI:` line names only the tip and the verdict, exactly like the packaged `FLOW:` verdict). */
interface CiParityEntry {
  tip: string;
  lockHash: string;
  result: "passed" | "failed";
  lastRunAt: number;
}

/** True when `value` is a well-formed parity record. A record missing any field, or carrying
 * a non-`passed|failed` result, reads as no data — the caller renders no block and the run
 * proceeds as before. */
function isParityEntry(value: unknown): value is CiParityEntry {
  if (!isJsonObject(value)) return false;
  return (
    typeof value.tip === "string" &&
    typeof value.lockHash === "string" &&
    (value.result === "passed" || value.result === "failed") &&
    typeof value.lastRunAt === "number"
  );
}

/** Read the parity ledger. A missing, torn, or wrong-shaped file reads as null — the caller
 * renders no block and the run proceeds as before. */
export function readCiParity(root: string): CiParityEntry | null {
  const file = readJsonFile<{ parity?: unknown }>(ciParityPath(root));
  return file?.parity && isParityEntry(file.parity) ? file.parity : null;
}

/** Record what a `ci` run covered: the tip it named on its `CI:` line and the verdict that
 * line carried, plus the lock hash of the coverage tree computed here. The single record is
 * written atomically (writeJsonAtomic) so a concurrent reader never sees a torn file; a
 * concurrent last-writer simply wins the slot. */
export function recordParity(
  root: string,
  sha: string,
  result: "passed" | "failed",
  now: number = Date.now(),
): void {
  writeJsonAtomic(ciParityPath(root), { parity: { tip: sha, lockHash: lockHashOf(root), result, lastRunAt: now } });
}

/** The hash of `package-lock.json` at `root` itself — what the current tree carries. An
 * empty string when the file is missing (or unreadable) reads as an unmatched hash, so a
 * swing to "no lock file" renders stale rather than pretending nothing moved. */
export function lockHashOf(root: string): string {
  let file: string;
  try {
    file = fs.readFileSync(path.join(root, "package-lock.json"), "utf8");
  } catch {
    return "";
  }
  return crypto.createHash("sha256").update(file).digest("hex");
}

/** The current main tip and lock hash, resolved synchronously from the ref files and the
 * working tree (mirroring status-polls.ts's per-poll read: readBranchHead + targetBranch, no
 * spawn). Either degrades to "" when it cannot be resolved, which the render treats as
 * "has definitely not matched", so a resolution failure can never declare a false current. */
export function currentCiParityState(
  root: string,
  config: { baseBranch?: string } | undefined,
): { tip: string; lockHash: string } {
  const branch = targetBranch(config?.baseBranch, currentBranchFromHeadFile(root));
  return { tip: readBranchHead(root, branch) ?? "", lockHash: lockHashOf(root) };
}

/** True when `entry` counts as "current": the last run passed AND it covered exactly this
 * tip with exactly this lock hash. This is the single home of the "current" decision, so the
 * ci prompt block (`renderParityBlock`) and the doctor `ci parity` row (`checkCiParity`) cannot
 * disagree on what "current" means. `entry.tip` is whatever the run named on its `CI:` line — a
 * 7-64-char abbreviated sha (the model's own shorthand) or the full 40-char head; match it as a
 * prefix of the current tip so an abbreviated recorded tip still reads current once the full
 * head shares that prefix. */
export function parityIsCurrent(entry: CiParityEntry, tip: string, lockHash: string): boolean {
  return entry.result === "passed" && tip !== "" && tip.startsWith(entry.tip) && entry.lockHash === lockHash;
}

/** Shorten an id for display without losing its discriminating prefix (a 40-char sha and a
 * 64-char lock hash both collapse to a 7-char prefix the model can compare). */
function shortId(id: string): string {
  return id.length > 7 ? id.slice(0, 7) : id;
}

/** Render the parity block for the next `ci` prompt from the last record and the current
 * main state. "current" only when the last run was green AND it covered exactly this tip with
 * exactly this lock hash — the cheap nothing-to-do case. Every other combination — a failed
 * last run, main moved, or the lock changed — renders "stale" naming both the covered and the
 * current tip/hash, so the role runs the suite. */
export function renderParityBlock(entry: CiParityEntry, tip: string, lockHash: string): string {
  const lines = ["CI parity (from this team's own record):"];
  if (parityIsCurrent(entry, tip, lockHash)) {
    lines.push(
      `  current — main is unmoved since the last green run covered tip ${shortId(entry.tip)} with lock ${shortId(
        entry.lockHash,
      )}; declare nothing-to-do without running the suite.`,
    );
  } else {
    const covered = `${shortId(entry.tip)} @ ${shortId(entry.lockHash)} (${entry.result})`;
    const now =
      tip === "" ? "could not be resolved" : `tip ${shortId(tip)} @ ${shortId(lockHash)}`;
    lines.push(
      `  stale — the last run covered ${covered}; main is now ${now}. Run the full suite and e2e before declaring anything.`,
    );
  }
  return lines.join("\n");
}

/** The full parity block for a `ci` prompt, or undefined when there is no record yet — a
 * missing or malformed ledger must render nothing rather than an empty verdict, so the very
 * first run carries no block and simply runs the suite (the same omission policy as qa's
 * coverage block). */
export function parityBlockFor(
  root: string,
  config: { baseBranch?: string } | undefined,
): string | undefined {
  const record = readCiParity(root);
  if (!record) return undefined;
  const { tip, lockHash } = currentCiParityState(root, config);
  return renderParityBlock(record, tip, lockHash);
}
