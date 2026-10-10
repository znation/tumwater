/** The per-run session ledger (plans/agent-backends.md "Sessions"): one `sessions.jsonl` line
 * per agent run, written into the run's own session dir before its spawn. Backend-neutral — the
 * runner records and the resume paths query — so a later resume can pick the newest session of
 * its own KIND instead of whatever file happens to be newest in the dir. That is the latent pi
 * hazard: a landing conflict resolver's fresh session shares the author's dir, and pi's
 * `--continue` (newest file in the dir) would otherwise resume the resolver.
 *
 * pi resumes by session dir and claude by id; the record carries both so each caller reads what
 * it needs. `id` is backend-specific: claude mints a UUID before its spawn, pi leaves it as the
 * session name because pi has no separate id to hand out ahead of the run. */

import fs from "node:fs";
import path from "node:path";
import { ensureParentDir, readTextOrNull, statOrNull, terminateTornTail, walkFiles, writeTextAtomic } from "../files/files.js";
import { isJsonObject } from "../files/json-object.js";

/** The ledger file name every session dir holds. Deliberately a `.jsonl` name so it sits beside
 * the backend's own session files; readers that count session files must exclude it. */
const SESSION_LEDGER_FILE = "sessions.jsonl";

/** One run's ledger line. `at` is epoch ms. */
export interface SessionRecord {
  /** The owning backend's id (plans/agent-backends.md "The seam"). */
  agent: string;
  /** Backend session id; the session name for pi (which mints no id ahead of the run). */
  id: string;
  /** The run's kind (PiRunKind: "author" | "gate"), so a follow-up can ignore another kind's
   * session in the same dir. */
  kind: string;
  /** The run's session name. */
  name: string;
  /** The worktree the run started in (claude's resume is cwd-scoped). */
  cwd: string;
  /** The resolved model selector, when one is configured. */
  model?: string;
  /** When the run was recorded, epoch ms. */
  at: number;
}

/** The ledger's path under a session dir. */
export function sessionLedgerPath(dir: string): string {
  return path.join(dir, SESSION_LEDGER_FILE);
}

/** Append one run's record to `dir`'s ledger, before its spawn. Best-effort: an unwritable
 * session dir or a full disk must degrade to "no resumable session" on a later tick, never
 * fail the run it was trying to describe. A crash or power loss mid-append leaves the previous
 * record without its newline; terminating that torn tail first keeps the next record on its
 * own line instead of gluing the two into one unparseable line that loses both runs' records
 * (the same repair the event log's append makes — files.ts's terminateTornTail). */
export function recordSession(dir: string, record: SessionRecord): void {
  try {
    const file = sessionLedgerPath(dir);
    ensureParentDir(file);
    terminateTornTail(file, statOrNull(file));
    fs.appendFileSync(file, JSON.stringify(record) + "\n");
  } catch {
    // Best effort: a lost ledger line costs resumability, not the run.
  }
}

/** True when `dir` holds at least one session file a backend could resume by directory. This is
 * the backend-neutral filesystem check behind pi's `--continue` and the fallback for an
 * unregistered backend. The ledger file shares the dir and is a `.jsonl` too, so it is
 * excluded — it is the harness's record of runs, not a session. */
export function hasResumableSession(dir: string): boolean {
  try {
    return fs
      .readdirSync(dir)
      .some((f) => f.endsWith(".jsonl") && f !== SESSION_LEDGER_FILE);
  } catch {
    return false; // Missing directory — nothing to resume.
  }
}

/** Every valid record in `dir`'s ledger, oldest first. A missing ledger reads as no records;
 * a torn, malformed, or shape-invalid line is skipped rather than poisoning the rest (a crash
 * mid-append must not cost every earlier record). Shape-invalid means valid JSON that is not a
 * complete SessionRecord (see isSessionRecord): a resume path turns a record's `cwd` and `id`
 * into a filesystem path, so a line missing either must read as no record instead of crashing
 * the resume check from an unvalidated field. */
export function readSessions(dir: string): SessionRecord[] {
  const text = readTextOrNull(sessionLedgerPath(dir));
  if (text === null) return [];
  const out: SessionRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (isSessionRecord(record)) out.push(record);
    } catch {
      // Torn or malformed line — no data.
    }
  }
  return out;
}

/** True when `value` is a complete SessionRecord: the required fields with their declared
 * types, and `model` a string when present. A ledger line that parses but omits a field is not
 * a record and must be skipped like a torn one: the claude resume check turns `cwd` and `id`
 * into a filesystem path (claudeBackend's claudeResumableRecord), and an absent `cwd` there
 * throws a TypeError from `undefined.replace` instead of degrading to "no resumable
 * session". Validating in the one reader keeps every consumer's `SessionRecord` a real one. */
function isSessionRecord(value: unknown): value is SessionRecord {
  if (!isJsonObject(value)) return false;
  return (
    typeof value.agent === "string" &&
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    typeof value.name === "string" &&
    typeof value.cwd === "string" &&
    typeof value.at === "number" &&
    (value.model === undefined || typeof value.model === "string")
  );
}

/** The newest ledger record, optionally limited to `kind`, or null when the ledger holds none.
 * "Newest" is file order: lines are appended per run, so the last matching line is the latest
 * run (concurrent appends still leave a total order). */
export function latestSession(dir: string, kind?: string): SessionRecord | null {
  const records = readSessions(dir).filter((r) => kind === undefined || r.kind === kind);
  return records.length > 0 ? records[records.length - 1]! : null;
}

/** The newest record of `kind` this run may resume: its agent matches `agent` and, when `cwd`
 * is given, its cwd matches (claude's resume is cwd-scoped; pi's is not, so pi callers omit
 * cwd). This is the id-selecting query a backend uses to name the session it wants; pi's
 * `--continue` picks the newest FILE whatever its kind, so pi callers use `sessionResumable`
 * instead. Null when none matches — including a pre-ledger dir, where the caller falls back to
 * the backend's own session-file check. */
export function resumableSession(
  dir: string,
  opts: { kind: string; agent: string; cwd?: string },
): SessionRecord | null {
  const record = latestSession(dir, opts.kind);
  if (record === null) return null;
  if (record.agent !== opts.agent) return null;
  if (opts.cwd !== undefined && record.cwd !== opts.cwd) return null;
  return record;
}

/** Whether pi may `--continue` in `dir`: a session file must exist (`sessionFileExists`, the
 * backend's own check — the ledger never replaces it) AND, when a ledger exists, its NEWEST
 * line overall must be this kind and agent (and cwd when given). The overall rule — not
 * `resumableSession`'s newest-of-kind one — is what makes `--continue` safe: pi resumes the
 * newest file in the dir whatever its kind, so a newer gate or conflict-resolver run shadows
 * the author's session and must refuse the continue. A pre-ledger dir is governed by the file
 * check alone. */
export function sessionResumable(
  dir: string,
  opts: { kind: string; agent: string; cwd?: string },
  sessionFileExists: boolean,
): boolean {
  if (!sessionFileExists) return false;
  const newest = latestSession(dir);
  if (newest === null) return true;
  return (
    newest.kind === opts.kind &&
    newest.agent === opts.agent &&
    (opts.cwd === undefined || newest.cwd === opts.cwd)
  );
}

/** Drop ledger lines older than `days` from every session dir under `sessionsRoot`. The ledger
 * file's mtime keeps it young while its role runs, so pruneOldFiles never ages it out; trimming
 * its lines is what actually bounds it, under the same window the session files prune by.
 * Returns the number of lines removed; a missing root or unreadable dir reads as nothing to do. */
export function pruneSessionLedgers(sessionsRoot: string, days: number): number {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let pruned = 0;
  walkFiles(sessionsRoot, (file, entry) => {
    if (!entry.isFile() || entry.name !== SESSION_LEDGER_FILE) return;
    const text = readTextOrNull(file);
    if (text === null) return;
    const lines = text.split("\n").filter((line) => line !== "");
    const kept: string[] = [];
    for (const line of lines) {
      let at: unknown;
      try {
        at = (JSON.parse(line) as { at?: unknown }).at;
      } catch {
        pruned += 1; // Malformed line: no timestamp to keep, so it ages out.
        continue;
      }
      if (typeof at === "number" && at >= cutoff) kept.push(line);
      else pruned += 1;
    }
    if (kept.length !== lines.length) {
      writeTextAtomic(file, kept.length > 0 ? kept.join("\n") + "\n" : "");
    }
  });
  return pruned;
}
