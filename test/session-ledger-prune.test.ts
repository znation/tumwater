import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  hasResumableSession,
  pruneCodexSessions,
  pruneOpencodeSessions,
  pruneSessionLedgers,
  readSessions,
  recordSession,
  sessionLedgerPath,
} from "../src/agent/session-ledger.js";
import { skipIfRoot, tmpdir } from "./fixtures/repo-fixtures.js";
import { errnoError, withReadOnlyDir, withThrowingFs } from "./helpers/fs-faults.js";
import { readCapture } from "./helpers/read-capture.js";
import { record } from "./fakes/session-record.js";
import { writeScript } from "./fakes/fake-commands.js";

// The retention trim runs in the prune's background pass, where a throw fails that pass: these
// tests pin that a ledger it cannot rewrite is left as it was, plus the edges of the trim, the
// resume check and the OpenCode purge that test/session-ledger.test.ts does not reach.

const DAY = 24 * 3600 * 1000;

test("pruneSessionLedgers leaves a ledger it cannot rewrite as it was and counts nothing for it", (t) => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  const fresh = record({ id: "fresh" });
  recordSession(dir, record({ id: "old", at: Date.now() - 30 * DAY }));
  recordSession(dir, fresh);
  const before = fs.readFileSync(sessionLedgerPath(dir), "utf8");

  let pruned = -1;
  assert.doesNotThrow(() => {
    pruned = withThrowingFs("writeFileSync", errnoError("ENOSPC"), () => pruneSessionLedgers(root, 7));
  });
  assert.equal(pruned, 0);
  assert.equal(fs.readFileSync(sessionLedgerPath(dir), "utf8"), before);
  assert.deepEqual(fs.readdirSync(dir), ["sessions.jsonl"]);

  if (!skipIfRoot(t)) {
    assert.doesNotThrow(() => {
      pruned = withReadOnlyDir(dir, () => pruneSessionLedgers(root, 7));
    });
    assert.equal(pruned, 0);
    assert.equal(fs.readFileSync(sessionLedgerPath(dir), "utf8"), before);
    assert.deepEqual(fs.readdirSync(dir), ["sessions.jsonl"]);
  }

  assert.equal(pruneSessionLedgers(root, 7), 1);
  assert.deepEqual(readSessions(dir), [fresh]);
});

test("pruneSessionLedgers does not rewrite a ledger with nothing past the window", () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  recordSession(dir, record());
  const when = new Date(Date.now() - 3 * DAY);
  fs.utimesSync(sessionLedgerPath(dir), when, when);
  const before = fs.statSync(sessionLedgerPath(dir));
  assert.equal(pruneSessionLedgers(root, 7), 0);
  const after = fs.statSync(sessionLedgerPath(dir));
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ino, before.ino);
});

test("pruneSessionLedgers empties a fully stale ledger in place and ages out a non-numeric stamp", () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  recordSession(dir, record({ at: Date.now() - 30 * DAY }));
  fs.appendFileSync(
    sessionLedgerPath(dir),
    JSON.stringify({ ...record(), at: String(Date.now()) }) + "\n",
  );
  assert.equal(pruneSessionLedgers(root, 7), 2);
  assert.ok(fs.existsSync(sessionLedgerPath(dir)));
  assert.equal(fs.statSync(sessionLedgerPath(dir)).size, 0);
});

test("hasResumableSession counts a backend session file but never the ledger itself", () => {
  const root = tmpdir();
  const dir = path.join(root, "missing");
  assert.equal(hasResumableSession(dir), false);
  recordSession(dir, record());
  assert.equal(hasResumableSession(dir), false);
  fs.writeFileSync(path.join(dir, "s.jsonl"), "{}\n");
  assert.equal(hasResumableSession(dir), true);
});

test("recordSession into a path it cannot create drops the record without throwing", () => {
  const root = tmpdir();
  const blocker = path.join(root, "file");
  fs.writeFileSync(blocker, "x");
  const dir = path.join(blocker, "sub");
  assert.doesNotThrow(() => recordSession(dir, record()));
  assert.deepEqual(readSessions(dir), []);
});

test("pruneOpencodeSessions counts only deletes that succeeded and never throws", async () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  recordSession(dir, record({ agent: "opencode", id: "ses_old", at: Date.now() - 30 * DAY }));

  const spillDir = path.join(tmpdir(), "spill");
  fs.mkdirSync(spillDir);
  const spill = path.join(spillDir, "old.txt");
  fs.writeFileSync(spill, "x");
  const when = new Date(Date.now() - 30 * DAY);
  fs.utimesSync(spill, when, when);
  assert.equal(await pruneOpencodeSessions(root, 7, { spillDir }), 0);
  assert.equal(fs.existsSync(spill), false);

  const failing = path.join(tmpdir(), "opencode");
  writeScript(failing, "exit 1");
  assert.equal(await pruneOpencodeSessions(root, 7, { bin: failing }), 0);

  const missing = path.join(tmpdir(), "no-such-opencode");
  assert.equal(await pruneOpencodeSessions(root, 7, { bin: missing }), 0);
});

/** A codex home whose `sessions` tree holds one rollout file naming `id`, under a fake
 * `CODEX_HOME`. Returns the home dir and the rollout path. */
function codexHomeWithRollout(id: string): { home: string; rollout: string } {
  const home = tmpdir("codex-home-");
  const rollout = path.join(home, "sessions", "2026", "09", "30", `rollout-2026-09-30T00-00-00-000-${id}.jsonl`);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, "{}\n");
  return { home, rollout };
}

test("pruneCodexSessions deletes each expired codex session with --force and keeps the fresh one", async () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  const id = "c7b3e2a1-0000-4000-8000-000000000001";
  recordSession(dir, record({ agent: "codex", id, at: Date.now() - 30 * DAY }));
  const freshId = "c7b3e2a1-0000-4000-8000-000000000002";
  recordSession(dir, record({ agent: "codex", id: freshId }));
  const { home, rollout } = codexHomeWithRollout(id);
  const freshRollout = codexHomeWithRollout(freshId).rollout;

  const bin = tmpdir("codex-bin-");
  const capture = path.join(tmpdir("codex-capture-"), "deleted.log");
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  writeScript(path.join(bin, "codex"), `printf '%s\\n' "$*" >> ${capture}`);

  const deleted = await pruneCodexSessions(root, 7, { bin: path.join(bin, "codex"), env: { CODEX_HOME: home } });
  assert.equal(deleted, 1);
  const log = readCapture(capture);
  assert.match(log, /delete --force c7b3e2a1-0000-4000-8000-000000000001\n/);
  assert.ok(!log.includes(freshId), "fresh session got no delete");
  assert.equal(fs.existsSync(rollout), false, "expired session's rollout gone");
  assert.equal(fs.existsSync(freshRollout), true, "fresh session's rollout untouched");
});

test("pruneCodexSessions runs at most four deletes at once, and more than one at a time", async () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  const ids = Array.from({ length: 12 }, (_, i) => `c7b3e2a1-0000-4000-8000-${String(i).padStart(12, "0")}`);
  for (const id of ids) recordSession(dir, record({ agent: "codex", id, at: Date.now() - 30 * DAY }));
  // Each stub delete logs a start, holds for 0.2 s, then logs its end: the log's running
  // count of starts minus ends is how many deletes were in flight at each point.
  const bin = tmpdir("codex-pool-bin-");
  const log = path.join(tmpdir("codex-pool-log-"), "events.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  writeScript(path.join(bin, "codex"), `printf 'start\\n' >> ${log}; sleep 0.2; printf 'end\\n' >> ${log}`);
  assert.equal(await pruneCodexSessions(root, 7, { bin: path.join(bin, "codex") }), ids.length);
  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.filter((line) => line === "start").length, ids.length, "every id is deleted");
  let inFlight = 0;
  let peak = 0;
  for (const line of lines) {
    inFlight += line === "start" ? 1 : -1;
    peak = Math.max(peak, inFlight);
  }
  assert.ok(peak <= 4, `at most four deletes in flight, saw ${peak}`);
  assert.ok(peak > 1, `the deletes overlap rather than run one by one, saw ${peak}`);
});

test("pruneCodexSessions removes the rollout when the delete fails", async () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  const id = "c7b3e2a1-0000-4000-8000-000000000003";
  recordSession(dir, record({ agent: "codex", id, at: Date.now() - 30 * DAY }));
  const { home, rollout } = codexHomeWithRollout(id);

  const bin = tmpdir("codex-bin-");
  writeScript(path.join(bin, "codex"), "exit 1");

  assert.equal(await pruneCodexSessions(root, 7, { bin: path.join(bin, "codex"), env: { CODEX_HOME: home } }), 0);
  assert.equal(fs.existsSync(rollout), false, "failed delete still removes the rollout");
});

/** Collects every `onProgress(done, total)` call a purge makes, in call order. */
function progressLog(): { calls: Array<[number, number]>; onProgress: (done: number, total: number) => void } {
  const calls: Array<[number, number]> = [];
  return { calls, onProgress: (done, total) => { calls.push([done, total]); } };
}

test("pruneCodexSessions reports progress once up front and once per candidate it handles", async () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  for (const n of ["1", "2", "3"]) {
    recordSession(dir, record({ agent: "codex", id: `c7b3e2a1-0000-4000-8000-00000000000${n}`, at: Date.now() - 30 * DAY }));
  }
  // No binary: the CLI deletes are skipped but the rollout fallback still handles every
  // candidate, so the reporter must still see each one — `total` counts what the loop handles.
  const progress = progressLog();
  await pruneCodexSessions(root, 7, { onProgress: progress.onProgress });
  assert.deepEqual(progress.calls, [[0, 3], [1, 3], [2, 3], [3, 3]]);
});

test("pruneCodexSessions reports no progress when nothing is expired, and spares an id out of total", async () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  const freshId = "c7b3e2a1-0000-4000-8000-0000000000f1";
  recordSession(dir, record({ agent: "codex", id: freshId }));
  const progress = progressLog();
  await pruneCodexSessions(root, 7, { onProgress: progress.onProgress });
  assert.deepEqual(progress.calls, [], "a ledger with nothing past the window reports nothing");

  // One id expired with no fresh record joins the reporter; an id whose records are both expired
  // AND resumed fresh is spared, so it never raises `total` to 2 — `done` must still reach
  // `total` exactly.
  recordSession(dir, record({ agent: "codex", id: "c7b3e2a1-0000-4000-8000-0000000000f2", at: Date.now() - 30 * DAY }));
  const sparedId = "c7b3e2a1-0000-4000-8000-0000000000f3";
  recordSession(dir, record({ agent: "codex", id: sparedId, at: Date.now() - 30 * DAY }));
  recordSession(dir, record({ agent: "codex", id: sparedId }));
  const second = progressLog();
  await pruneCodexSessions(root, 7, { onProgress: second.onProgress });
  assert.deepEqual(second.calls, [[0, 1], [1, 1]]);
});

test("pruneOpencodeSessions reports progress per delete, and nothing with no binary or nothing expired", async () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  const progress = progressLog();
  await pruneOpencodeSessions(root, 7, { onProgress: progress.onProgress });
  assert.deepEqual(progress.calls, [], "no binary means no delete candidates to report");

  const bin = tmpdir("opencode-bin-");
  writeScript(path.join(bin, "opencode"), "exit 0");
  recordSession(dir, record({ agent: "opencode", id: "ses_p1", at: Date.now() - 30 * DAY }));
  recordSession(dir, record({ agent: "opencode", id: "ses_p2", at: Date.now() - 30 * DAY }));
  const first = progressLog();
  await pruneOpencodeSessions(root, 7, { bin: path.join(bin, "opencode"), onProgress: first.onProgress });
  assert.deepEqual(first.calls, [[0, 2], [1, 2], [2, 2]]);

  // Everything now inside the window: the purge finds no candidate and reports nothing.
  const dir2 = path.join(root, "author");
  recordSession(dir2, record({ agent: "opencode", id: "ses_fresh" }));
  const dir3 = path.join(root, "gate");
  recordSession(dir3, record({ agent: "opencode", id: "ses_old", at: Date.now() - 30 * DAY }));
  const second = progressLog();
  await pruneOpencodeSessions(root, 400, { bin: path.join(bin, "opencode"), onProgress: second.onProgress });
  assert.deepEqual(second.calls, []);
});

test("pruneCodexSessions spares a session whose id was resumed fresh within the window", async () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  // Codex reuses a resumed session's UUID: an older expired record sits beside a still-fresh
  // resume of the same id, and the purge must leave the live session (and its rollout) alone.
  const id = "c7b3e2a1-0000-4000-8000-000000000004";
  recordSession(dir, record({ agent: "codex", id, at: Date.now() - 30 * DAY }));
  recordSession(dir, record({ agent: "codex", id }));
  const { home, rollout } = codexHomeWithRollout(id);

  const bin = tmpdir("codex-bin-");
  const capture = path.join(tmpdir("codex-capture-"), "deleted.log");
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  writeScript(path.join(bin, "codex"), `printf '%s\\n' "$*" >> ${capture}`);

  assert.equal(await pruneCodexSessions(root, 7, { bin: path.join(bin, "codex"), env: { CODEX_HOME: home } }), 0);
  const log = readCapture(capture);
  assert.equal(log, "", "resumed session got no delete");
  assert.equal(fs.existsSync(rollout), true, "resumed session's rollout untouched");
});

/** A codex home with one rollout per id, all under one day dir, so a walk of its sessions tree
 * reads four directories (sessions, year, month, day). */
function codexHomeWithRollouts(ids: string[]): { home: string; rollouts: Map<string, string> } {
  const home = tmpdir("codex-home-");
  const dayDir = path.join(home, "sessions", "2026", "09", "30");
  fs.mkdirSync(dayDir, { recursive: true });
  const rollouts = new Map<string, string>();
  for (const id of ids) {
    const file = path.join(dayDir, `rollout-2026-09-30T00-00-00-000-${id}.jsonl`);
    fs.writeFileSync(file, "{}\n");
    rollouts.set(id, file);
  }
  return { home, rollouts };
}

/** A stub codex that appends each call's argv as one line to `capture`. */
function codexStub(): { bin: string; capture: string } {
  const bin = tmpdir("codex-bin-");
  const capture = path.join(tmpdir("codex-capture-"), "argv.log");
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  writeScript(path.join(bin, "codex"), `printf '%s\\n' "$*" >> ${capture}`);
  return { bin: path.join(bin, "codex"), capture };
}

/** The thread ids the codex stub was handed, in call order. */
function codexDeletedIds(capture: string): string[] {
  return readCapture(capture)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(/^delete --force /, ""));
}

test("pruneCodexSessions never passes a session name to codex, and the line pass still trims it", async () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  recordSession(dir, record({ agent: "codex", id: "feature-run-1", at: Date.now() - 30 * DAY }));
  const { bin, capture } = codexStub();
  const { home } = codexHomeWithRollouts([]);

  assert.equal(await pruneCodexSessions(root, 7, { bin, env: { CODEX_HOME: home } }), 0);
  assert.deepEqual(codexDeletedIds(capture), [], "a session name is never handed to codex");
  assert.equal(pruneSessionLedgers(root, 7), 1, "its expired ledger line is still trimmed");
});

test("pruneCodexSessions skips codex delete for an expired id whose rollout is already gone", async () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  const withRollout = "c7b3e2a1-0000-4000-8000-0000000000b1";
  const alreadyGone = "c7b3e2a1-0000-4000-8000-0000000000b2";
  recordSession(dir, record({ agent: "codex", id: withRollout, at: Date.now() - 30 * DAY }));
  recordSession(dir, record({ agent: "codex", id: alreadyGone, at: Date.now() - 30 * DAY }));
  const { home, rollouts } = codexHomeWithRollouts([withRollout]);
  const { bin, capture } = codexStub();
  const progress = progressLog();

  assert.equal(await pruneCodexSessions(root, 7, { bin, env: { CODEX_HOME: home }, onProgress: progress.onProgress }), 1);
  assert.deepEqual(codexDeletedIds(capture), [withRollout], "only the id with a rollout reaches codex");
  assert.deepEqual(progress.calls.at(-1), [2, 2], "the gone id is still counted as handled");
  assert.equal(fs.existsSync(rollouts.get(withRollout) as string), false, "the delivered id's rollout is gone");
});

test("pruneCodexSessions walks the rollout tree once per pass, however many ids are expired", async () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  const ids = [1, 2, 3, 4].map((n) => `c7b3e2a1-0000-4000-8000-00000000000${n}`);
  for (const id of ids) recordSession(dir, record({ agent: "codex", id, at: Date.now() - 30 * DAY }));
  const { home } = codexHomeWithRollouts(ids);
  const { bin } = codexStub();
  const sessionsDir = path.join(home, "sessions");
  const reads: string[] = [];
  const realReaddir = fs.readdirSync;
  fs.readdirSync = ((dirPath: fs.PathLike, options?: unknown) => {
    if (String(dirPath).startsWith(sessionsDir)) reads.push(String(dirPath));
    return (realReaddir as (...args: unknown[]) => unknown)(dirPath, options);
  }) as unknown as typeof fs.readdirSync;
  try {
    await pruneCodexSessions(root, 7, { bin, env: { CODEX_HOME: home } });
  } finally {
    fs.readdirSync = realReaddir;
  }
  // One walk visits sessions, 2026, 09 and 30 once each; a per-id lookup would read 16 times.
  assert.equal(reads.length, 4);
});

test("pruneCodexSessions resumes an interrupted pass without deleting an id it already handled", async () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  // Six ids, more than the delete pool runs at once, so the stop leaves some unreached.
  const ids = [1, 2, 3, 4, 5, 6].map((n) => `c7b3e2a1-0000-4000-8000-00000000000${n}`);
  for (const id of ids) recordSession(dir, record({ agent: "codex", id, at: Date.now() - 30 * DAY }));
  const { bin, capture } = codexStub();
  const resumePath = path.join(tmpdir("prune-resume-"), "state", "session-prune-codex.txt");

  // The pass is stopped once two ids are handled: the reporter throws after the second. The
  // deletes already in flight settle and are recorded; no new one starts.
  await assert.rejects(
    pruneCodexSessions(root, 7, { bin, resumePath, onProgress: (done) => { if (done === 2) throw new Error("stopped"); } }),
    /stopped/,
  );
  const firstPass = codexDeletedIds(capture).length;
  assert.ok(firstPass >= 2 && firstPass < ids.length, `the stop left some ids unreached: ${firstPass}`);

  // The next pass spawns a delete only for the ids the first one did not reach.
  assert.equal(await pruneCodexSessions(root, 7, { bin, resumePath }), ids.length - firstPass);
  assert.deepEqual(codexDeletedIds(capture).sort(), [...ids].sort(), "each id deleted exactly once");
});

test("pruneOpencodeSessions resumes an interrupted pass without deleting an id it already handled", async () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  // Six ids, more than the delete pool runs at once, so the stop leaves some unreached.
  const ids = ["ses_r1", "ses_r2", "ses_r3", "ses_r4", "ses_r5", "ses_r6"];
  for (const id of ids) recordSession(dir, record({ agent: "opencode", id, at: Date.now() - 30 * DAY }));
  const bin = tmpdir("opencode-bin-");
  const capture = path.join(tmpdir("opencode-capture-"), "argv.log");
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  writeScript(path.join(bin, "opencode"), `printf '%s\\n' "$*" >> ${capture}`);
  const resumePath = path.join(tmpdir("prune-resume-"), "state", "session-prune-opencode.txt");
  const opencode = path.join(bin, "opencode");

  await assert.rejects(
    pruneOpencodeSessions(root, 7, { bin: opencode, resumePath, onProgress: (done) => { if (done === 2) throw new Error("stopped"); } }),
    /stopped/,
  );
  const readLog = (): string[] => fs.readFileSync(capture, "utf8").split("\n").filter((line) => line !== "");
  const firstPass = readLog().length;
  assert.ok(firstPass >= 2 && firstPass < ids.length, `the stop left some ids unreached: ${firstPass}`);
  assert.equal(await pruneOpencodeSessions(root, 7, { bin: opencode, resumePath }), ids.length - firstPass);
  const log = readLog();
  assert.equal(log.length, ids.length, "one delete per id in all");
  for (const id of ids) assert.equal(log.filter((line) => line.includes(id)).length, 1, `${id} deleted once`);
});
