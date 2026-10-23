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
import { record } from "./fakes/session-record.js";
import { writeScript } from "./fakes/fake-commands.js";

// The retention trim runs in the orchestrator's poll loop, where a throw ends the team: these
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

test("pruneOpencodeSessions counts only deletes that succeeded and never throws", () => {
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
  assert.equal(pruneOpencodeSessions(root, 7, { spillDir }), 0);
  assert.equal(fs.existsSync(spill), false);

  const failing = path.join(tmpdir(), "opencode");
  writeScript(failing, "exit 1");
  assert.equal(pruneOpencodeSessions(root, 7, { bin: failing }), 0);

  const missing = path.join(tmpdir(), "no-such-opencode");
  assert.doesNotThrow(() => {
    assert.equal(pruneOpencodeSessions(root, 7, { bin: missing }), 0);
  });
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

test("pruneCodexSessions deletes each expired codex session with --force and keeps the fresh one", () => {
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

  const deleted = pruneCodexSessions(root, 7, { bin: path.join(bin, "codex"), env: { CODEX_HOME: home } });
  assert.equal(deleted, 1);
  const log = fs.existsSync(capture) ? fs.readFileSync(capture, "utf8") : "";
  assert.match(log, /delete --force c7b3e2a1-0000-4000-8000-000000000001\n/);
  assert.ok(!log.includes(freshId), "fresh session got no delete");
  assert.equal(fs.existsSync(rollout), false, "expired session's rollout gone");
  assert.equal(fs.existsSync(freshRollout), true, "fresh session's rollout untouched");
});

test("pruneCodexSessions removes the rollout when the delete fails", () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  fs.mkdirSync(dir);
  const id = "c7b3e2a1-0000-4000-8000-000000000003";
  recordSession(dir, record({ agent: "codex", id, at: Date.now() - 30 * DAY }));
  const { home, rollout } = codexHomeWithRollout(id);

  const bin = tmpdir("codex-bin-");
  writeScript(path.join(bin, "codex"), "exit 1");

  assert.equal(pruneCodexSessions(root, 7, { bin: path.join(bin, "codex"), env: { CODEX_HOME: home } }), 0);
  assert.equal(fs.existsSync(rollout), false, "failed delete still removes the rollout");
});

test("pruneCodexSessions spares a session whose id was resumed fresh within the window", () => {
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

  assert.equal(pruneCodexSessions(root, 7, { bin: path.join(bin, "codex"), env: { CODEX_HOME: home } }), 0);
  const log = fs.existsSync(capture) ? fs.readFileSync(capture, "utf8") : "";
  assert.equal(log, "", "resumed session got no delete");
  assert.equal(fs.existsSync(rollout), true, "resumed session's rollout untouched");
});
