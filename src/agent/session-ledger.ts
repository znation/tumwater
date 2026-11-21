/** The per-run session ledger (plans/agent-backends.md "Sessions"): one `sessions.jsonl` line
 * per agent run, written into the run's own session dir before its spawn. Backend-neutral — the
 * runner records and the resume paths query — so a later resume can pick the newest session of
 * its own KIND instead of whatever file happens to be newest in the dir. That is the latent pi
 * hazard: a merge conflict resolver's fresh session shares the author's dir, and pi's
 * `--continue` (newest file in the dir) would otherwise resume the resolver.
 *
 * pi resumes by session dir and claude by id; the record carries both so each caller reads what
 * it needs. `id` is backend-specific: claude mints a UUID before its spawn, pi leaves it as the
 * session name because pi has no separate id to hand out ahead of the run. */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { daysAgoMs, dirEntryNames, ensureParentDir, readTextOrNull, statOrNull, terminateTornTail, walkFiles, writeTextAtomic } from "../files/files.js";
import { isJsonObject } from "../files/json-object.js";
import { THREAD_ID_RE, indexRollouts } from "./codex/codex-rollout.js";
import type { PiRunKind } from "../pi/pi-event-line.js";

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
  kind: PiRunKind;
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
 * session dir or a full disk must degrade to "no resumable session" on a later run, never
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

/** The one run's ledger record, minus the id the two recording sites mint differently — the
 * pre-spawn id in agent-spawn.ts, or the stream-minted session id in agent-stream.ts. One place
 * for the record's non-id shape (agent, kind, name, cwd, the optional model and the stamp), so
 * the two appends cannot drift on the model spread or the required fields. `agent` is the
 * owning backend's id; the run options supply the rest. */
export function sessionRecordFor(
  agent: string,
  id: string,
  opts: { kind: PiRunKind; sessionName: string; cwd: string; config: { model?: string } },
): SessionRecord {
  return {
    agent,
    id,
    kind: opts.kind,
    name: opts.sessionName,
    cwd: opts.cwd,
    ...(opts.config.model !== undefined ? { model: opts.config.model } : {}),
    at: Date.now(),
  };
}

/** True when `dir` holds at least one session file a backend could resume by directory. This is
 * the backend-neutral filesystem check behind pi's `--continue` and the fallback for an
 * unregistered backend. The ledger file shares the dir and is a `.jsonl` too, so it is
 * excluded — it is the harness's record of runs, not a session. */
export function hasResumableSession(dir: string): boolean {
  // A missing directory reads empty — nothing to resume.
  return dirEntryNames(dir).some((f) => f.endsWith(".jsonl") && f !== SESSION_LEDGER_FILE);
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
    (value.kind === "author" || value.kind === "gate") &&
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
 * Returns the number of lines removed; a missing root or unreadable dir reads as nothing to do.
 * A ledger that cannot be rewritten (a full disk, a read-only dir) is left as it was and not
 * counted, because this pass runs in the orchestrator's poll loop, where a throw ends the team. */
export function pruneSessionLedgers(sessionsRoot: string, days: number): number {
  const cutoff = daysAgoMs(days);
  let pruned = 0;
  walkFiles(sessionsRoot, (file, entry) => {
    if (!entry.isFile() || entry.name !== SESSION_LEDGER_FILE) return;
    const text = readTextOrNull(file);
    if (text === null) return;
    const lines = text.split("\n").filter((line) => line !== "");
    const kept: string[] = [];
    let dropped = 0;
    for (const line of lines) {
      let at: unknown;
      try {
        at = (JSON.parse(line) as { at?: unknown }).at;
      } catch {
        dropped += 1; // Malformed line: no timestamp to keep, so it ages out.
        continue;
      }
      if (typeof at === "number" && at >= cutoff) kept.push(line);
      else dropped += 1;
    }
    if (kept.length !== lines.length) {
      try {
        writeTextAtomic(file, kept.length > 0 ? kept.join("\n") + "\n" : "");
      } catch {
        return;
      }
      pruned += dropped;
    }
  });
  return pruned;
}

/** The ids one backend's prune pass already handled before it was interrupted (paths.ts
 * sessionPruneResumePath). A pass records each id as it handles it, so the next pass skips
 * those rather than redoing them; the retention pass clears the record once the ledger lines
 * are trimmed, so `pruneSessionLedgers` stays the one ledger writer. A missing record is none
 * handled. */
function readPruneResume(file: string | undefined): Set<string> {
  if (file === undefined) return new Set();
  return new Set((readTextOrNull(file) ?? "").split("\n").filter((line) => line !== ""));
}

/** Append one handled id to the resume record. Best effort: a record that cannot be written
 * only means a restart redoes that id, and must not fail the prune. */
function recordPruneResume(file: string | undefined, id: string): void {
  if (file === undefined) return;
  try {
    ensureParentDir(file);
    fs.appendFileSync(file, `${id}\n`);
  } catch {
    // Best effort: an unwritable record only means a restart redoes this id.
  }
}

/** Remove a backend's resume record once the ledger lines it covers have been trimmed. */
export function clearPruneResume(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best effort: a record left behind only makes the next pass skip ids it already handled.
  }
}

/** How long one `opencode session delete <id> --standalone` may take before it gives up: the
 * session export measured 0.18 s live, so 10 s is a generous bound on a slow or wedged CLI. */
const SESSION_DELETE_TIMEOUT_MS = 10_000;

/** Run one bounded headless CLI session delete (`bin args…`) under `env`, best-effort: a
 * spawn that throws (a missing binary, an unwritable env) resolves false without rejecting, so
 * a failed delete never fails the prune. The child is killed at the bound and counts as failed.
 * Shared by the OpenCode and Codex session purges below so neither drift on the 10 s bound, the
 * status-0 success rule, or the swallow policy. */
function sessionDeleteSucceeds(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      // An abort kills the running delete (spawn's `signal`), which then resolves false. The
      // kill's `error` arrives before the child has exited, so a spawned child settles on `close`
      // alone: the caller's stop waits for the process to be gone, not just signalled.
      const child = spawn(bin, args, {
        env,
        timeout: SESSION_DELETE_TIMEOUT_MS,
        stdio: "ignore",
        signal,
      });
      child.on("error", () => {
        if (child.pid === undefined) resolve(false);
      });
      child.on("close", (status) => resolve(status === 0));
    } catch {
      // Best effort: an unwritable env or a missing binary must not fail the prune.
      resolve(false);
    }
  });
}

/** How many session deletes run at once: a pass over a busy team can hold many expired ids, and
 * each delete is a child process, so the pass runs a few at a time rather than one per id. */
const SESSION_DELETE_CONCURRENCY = 4;

/** Run `fn` over `items` with at most `limit` calls in flight, resolving once every started call
 * has settled. A call that throws stops the pool from starting another item; the first such
 * error is rethrown once the calls already in flight have settled. An abort in `signal` stops it
 * from starting any more items. */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length && !signal?.aborted) {
      const item = items[next] as T;
      next += 1;
      try {
        await fn(item);
      } catch (error) {
        if (failure === undefined) failure = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
}

/** The options the retention pass resolves for the OpenCode session purge (part 7/7): the
 * binary and environment (OPENCODE_DB) are per team root, resolved by the caller (retention)
 * exactly as a run's invocation resolves them — so the deletes hit the same database the runs
 * wrote. An undefined `bin` skips the session deletes (no opencode configured/spawnable). */
interface OpencodePruneOptions {
  /** The resolved opencode binary to run `session delete` with. */
  bin?: string;
  /** The run environment, carrying OPENCODE_DB for the team root. */
  env?: NodeJS.ProcessEnv;
  /** Progress reporter (PLANS.md "Visible session cleanup" part 1/3): called once with
   * `done = 0` once the expired set is built and only when it is non-empty, then after each id
   * this pass handles, so `done` rises monotonically to `total`. The purge stays free of path
   * knowledge — the caller owns the marker the report feeds. */
  onProgress?: (done: number, total: number) => void;
  /** The resume record this pass reads and appends to (paths.ts sessionPruneResumePath), so an
   * interrupted pass's handled ids are not deleted again on the next one. */
  resumePath?: string;
  /** Aborts the pass (PLANS.md "Fast session cleanup" part 2b/2): no further delete starts, each
   * running delete is killed, and its id is left unrecorded so the next pass redoes it. The
   * pass then resolves with what it counted so far. */
  signal?: AbortSignal;
}

/** Delete each OpenCode session the ledger records as expired, with one
 * `opencode session delete <id> --standalone` each (capped at SESSION_DELETE_TIMEOUT_MS), plus
 * the spill files older than the window in the team's shell spill dir. The session's spill files
 * and server state live OUTSIDE `.tumwater/` (finding 17), so trimming the ledger line alone would
 * orphan them; the
 * CLI's `session delete` is the one way to reach them. Best-effort and backend-specific, kept
 * out of the generic `pruneSessionLedgers` line pass: it returns the session-deletes that
 * reported success, and prunes spill files with the same window. The caller (retention) runs
 * this BEFORE pruneSessionLedgers trims the lines, so the full ledger is still in view. */
export async function pruneOpencodeSessions(
  sessionsRoot: string,
  days: number,
  opts: OpencodePruneOptions & { spillDir?: string },
): Promise<number> {
  const cutoff = daysAgoMs(days);
  let deleted = 0;
  if (opts.bin !== undefined) {
    const bin = opts.bin;
    // The expired ids are gathered before the delete loop so `total` is known up front — the
    // progress reporter's contract (part 1/3). The ledgers are not written by this pass, so
    // gathering first sees exactly what the old inline walk saw.
    // An id an interrupted pass already handled is spared (readPruneResume).
    const done = readPruneResume(opts.resumePath);
    const expired: string[] = [];
    walkFiles(sessionsRoot, (file) => {
      if (!file.endsWith(SESSION_LEDGER_FILE)) return;
      for (const record of readSessions(path.dirname(file))) {
        if (record.agent !== "opencode" || record.at >= cutoff || done.has(record.id)) continue;
        expired.push(record.id);
      }
    });
    const total = expired.length;
    if (total > 0) opts.onProgress?.(0, total);
    let handled = 0;
    await forEachLimited(
      expired,
      SESSION_DELETE_CONCURRENCY,
      async (id) => {
        const ok = await sessionDeleteSucceeds(bin, ["session", "delete", id, "--standalone"], opts.env, opts.signal);
        // An aborted delete was killed, so its id is not handled: the next pass redoes it.
        if (opts.signal?.aborted) return;
        if (ok) deleted += 1;
        recordPruneResume(opts.resumePath, id);
        handled += 1;
        opts.onProgress?.(handled, total);
      },
      opts.signal,
    );
  }
  const spill = opts.spillDir;
  if (spill !== undefined && spill !== "" && !opts.signal?.aborted) {
    // Walk and delete files older than the window in the team's spill dir. walkFiles never
    // throws (it swallows a vanished/unreadable dir), and each unlink is best-effort, so this
    // whole half of the purge cannot fail the prune.
    walkFiles(spill, (file, entry) => {
      if (!entry.isFile()) return;
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {
        // Best effort: a vanished or unwritable spill file is not a failure.
      }
    });
  }
  return deleted;
}

/** The options the retention pass resolves for the Codex session purge (part 9b/9): the binary
 * and environment (CODEX_HOME) are per team root, resolved by the caller (retention) exactly as
 * a run's invocation resolves them — so the deletes hit the same home the runs wrote. An
 * undefined `bin` skips the CLI deletes (no codex configured/spawnable); the rollout fallback
 * still runs where a home is in view, so a stale home never keeps a rollout past the window. */
interface CodexPruneOptions {
  /** The resolved codex binary to run `delete --force` with. */
  bin?: string;
  /** The run environment, carrying CODEX_HOME for the team root. */
  env?: NodeJS.ProcessEnv;
  /** Progress reporter, the OpenCode twin's shape: `done = 0` once the delete candidates are
   * built and only when there are any, then after each candidate handled. */
  onProgress?: (done: number, total: number) => void;
  /** The resume record this pass reads and appends to (paths.ts sessionPruneResumePath). */
  resumePath?: string;
  /** Aborts the pass, the OpenCode twin's semantics (see OpencodePruneOptions.signal). */
  signal?: AbortSignal;
}

/** Delete each Codex session the ledger records as expired, with one
 * `codex delete --force <id>` each (capped at SESSION_DELETE_TIMEOUT_MS), plus the rollout-file
 * fallback. Codex's sessions live under `CODEX_HOME` (part 8/9), OUTSIDE `.tumwater/` and outside
 * the session dirs this pass walks, so trimming the ledger line alone would orphan them; the CLI's
 * `delete --force` is the one way to reach them headless (design finding 21: without `--force`
 * Codex refuses to delete without a terminal). Best-effort and backend-specific, kept out of
 * the generic `pruneSessionLedgers` line pass: it returns the deletes that reported success. An
 * id that is not a thread UUID (a session name from a pre-spawn record) is never passed to the
 * CLI, and an id whose rollout is already gone is not either: `codex delete` has nothing left to
 * act on, so the id is counted handled, not deleted. Whether or not a delete succeeded the
 * session's own rollout file is removed as the fallback (the OpenCode spill-file fallback's
 * twin), so the ledger line and rollout do not outlive the window. The caller (retention) runs
 * this BEFORE pruneSessionLedgers trims the lines, so the full ledger is still in view. */
export async function pruneCodexSessions(
  sessionsRoot: string,
  days: number,
  opts: CodexPruneOptions,
): Promise<number> {
  const cutoff = daysAgoMs(days);
  let deleted = 0;
  // Codex reuses a resumed session's UUID, so one id can carry several ledger records — each
  // resume appends a fresh line with the same id (design §4 resumes by id). Only an id whose
  // EVERY record is expired is a session safe to trim: an older expired record beside a
  // still-fresh resume must not `delete` the live session or unlink its rollout, so the live
  // ids are gathered first and every candidate id is checked against them.
  const live = new Set<string>();
  const expired = new Set<string>();
  walkFiles(sessionsRoot, (file) => {
    if (!file.endsWith(SESSION_LEDGER_FILE)) return;
    for (const record of readSessions(path.dirname(file))) {
      if (record.agent !== "codex") continue;
      (record.at >= cutoff ? live : expired).add(record.id);
    }
  });
  // A resumed id is spared, so the reporter's `total` counts what this loop actually handles —
  // `done` still rises monotonically to `total` and a run with nothing to do reports nothing.
  // A placeholder (a session name, not a thread UUID) is spared too: `codex delete --force`
  // refuses a name, and its ledger lines are trimmed by the line pass all the same. An id an
  // interrupted pass already handled is spared by the resume record.
  const done = readPruneResume(opts.resumePath);
  const candidates = [...expired].filter((id) => THREAD_ID_RE.test(id) && !live.has(id) && !done.has(id));
  const total = candidates.length;
  if (total > 0) opts.onProgress?.(0, total);
  // One walk of the home's rollout tree serves every candidate. With no home in view there is no
  // rollout to check, so each candidate is deleted as it always was.
  const home = opts.env?.CODEX_HOME;
  const rollouts = home !== undefined && total > 0 ? indexRollouts(home) : undefined;
  const bin = opts.bin;
  let handled = 0;
  await forEachLimited(candidates, SESSION_DELETE_CONCURRENCY, async (id) => {
    const rollout = rollouts?.get(id);
    const gone = rollouts !== undefined && rollout === undefined;
    if (!gone && bin !== undefined && (await sessionDeleteSucceeds(bin, ["delete", "--force", id], opts.env, opts.signal)))
      deleted += 1;
    // An aborted delete was killed, so its id is not handled: the next pass redoes it.
    if (opts.signal?.aborted) return;
    // Fallback: unlink the home's rollout for this session so neither the ledger line nor
    // its file outlives the window. A real `codex delete` removes the rollout itself, so a
    // successful delete has nothing left to unlink (the unlink is then a no-op); a failed or
    // skipped delete does, and this is what trims it.
    if (rollout !== undefined) {
      try {
        fs.unlinkSync(rollout);
      } catch {
        // Best effort: a vanished or unwritable rollout is not a failure.
      }
    }
    recordPruneResume(opts.resumePath, id);
    handled += 1;
    opts.onProgress?.(handled, total);
  }, opts.signal);
  return deleted;
}
