import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  latestSession,
  pruneSessionLedgers,
  readSessions,
  recordSession,
  resumableSession,
  sessionLedgerPath,
  sessionResumable,
  type SessionRecord,
} from "../src/agent/session-ledger.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// The session ledger (plans/agent-backends.md "Sessions") is the resume paths' memory of which
// session a `--continue` would actually reach: one line per run, kind and agent tagged. These
// tests pin the record/read round trip, the newest-of-kind lookup that fixes the conflict
// resolver shadowing the author's session, the file-exists requirement, and the retention trim.

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    agent: "pi",
    id: "id",
    kind: "author",
    name: "tumwater-feature-1",
    cwd: "/wt",
    at: Date.now(),
    ...overrides,
  };
}

test("recordSession and readSessions round-trip records, skipping malformed lines", () => {
  const dir = tmpdir();
  const first = record({ name: "one", at: 1000 });
  const second = record({ name: "two", at: 2000, model: "anthropic/claude" });
  recordSession(dir, first);
  recordSession(dir, second);
  // A torn write must not poison the earlier records.
  fs.appendFileSync(sessionLedgerPath(dir), "{not json\n");
  assert.equal(sessionLedgerPath(dir), path.join(dir, "sessions.jsonl"));
  assert.deepEqual(readSessions(dir), [first, second]);
  assert.deepEqual(latestSession(dir), second);
  assert.deepEqual(latestSession(dir, "author"), second);
  assert.equal(latestSession(dir, "gate"), null);
});

test("readSessions skips a line that parses but is not a complete record", () => {
  const dir = tmpdir();
  const good = record({ kind: "author", name: "author" });
  recordSession(dir, good);
  // Valid JSON, but not a complete SessionRecord: the claude resume path builds a transcript
  // path from cwd and id, so a line missing either must not reach it (it would throw from
  // undefined.replace instead of degrading to no resumable session).
  fs.appendFileSync(sessionLedgerPath(dir), '{"agent":"claude","kind":"author"}\n');
  fs.appendFileSync(
    sessionLedgerPath(dir),
    '{"agent":"claude","kind":"author","id":"x","name":"n","at":1}\n',
  );
  assert.deepEqual(readSessions(dir), [good]);
  assert.deepEqual(latestSession(dir), good, "a shape-invalid newest line does not shadow a valid one");
});

test("latestSession and resumableSession pick the newest of the run's kind, not the newest overall", () => {
  const dir = tmpdir();
  // The hazard: a conflict resolver's gate run shares the author's dir and is newest overall.
  const author = record({ kind: "author", name: "author", at: 1000 });
  const resolver = record({ kind: "gate", name: "resolver", at: 2000 });
  recordSession(dir, author);
  recordSession(dir, resolver);
  assert.equal(latestSession(dir)?.name, "resolver", "the resolver is newest overall");
  assert.equal(latestSession(dir, "author")?.name, "author");
  assert.deepEqual(
    resumableSession(dir, { kind: "author", agent: "pi" }),
    author,
    "an author follow-up reaches the author's session, not the resolver's",
  );
  assert.deepEqual(resumableSession(dir, { kind: "gate", agent: "pi" }), resolver);
});

test("resumableSession refuses a record whose agent or cwd does not match", () => {
  const dir = tmpdir();
  recordSession(dir, record({ agent: "claude", cwd: "/wt-a", kind: "author" }));
  assert.equal(resumableSession(dir, { kind: "author", agent: "pi" }), null, "agent mismatch");
  assert.equal(
    resumableSession(dir, { kind: "author", agent: "claude", cwd: "/wt-b" }),
    null,
    "cwd mismatch",
  );
  assert.ok(resumableSession(dir, { kind: "author", agent: "claude", cwd: "/wt-a" }));
  assert.ok(
    resumableSession(dir, { kind: "author", agent: "claude" }),
    "cwd is only enforced when given",
  );
});

test("sessionResumable requires a session file and, with a ledger, the right kind and agent", () => {
  const dir = tmpdir();
  // No ledger and no file: not resumable (the historical any-*.jsonl check).
  assert.equal(sessionResumable(dir, { kind: "author", agent: "pi" }, false), false);
  // No ledger but a file: the pre-ledger fallback resumes.
  assert.equal(sessionResumable(dir, { kind: "author", agent: "pi" }, true), true);
  // A ledger that names another agent is never resumable, file or not.
  recordSession(dir, record({ agent: "claude" }));
  assert.equal(sessionResumable(dir, { kind: "author", agent: "pi" }, true), false);
  // The right agent, but a session file must still exist.
  const dir2 = tmpdir();
  recordSession(dir2, record());
  assert.equal(sessionResumable(dir2, { kind: "author", agent: "pi" }, false), false);
  assert.equal(sessionResumable(dir2, { kind: "author", agent: "pi" }, true), true);
});

test("sessionResumable refuses when a newer line overall is not the run's to --continue", () => {
  const dir = tmpdir();
  // pi's --continue grabs the newest FILE, so the check must be newest-overall, not
  // newest-of-kind: a gate run after the author must refuse the author's follow-up.
  recordSession(dir, record({ kind: "author", at: 1000 }));
  recordSession(dir, record({ kind: "gate", at: 2000 }));
  assert.equal(
    sessionResumable(dir, { kind: "author", agent: "pi" }, true),
    false,
    "the newest line is the gate's, so --continue would reach it",
  );
  assert.equal(sessionResumable(dir, { kind: "gate", agent: "pi" }, true), true);
  // A newer line for another agent shadows just the same.
  const dir2 = tmpdir();
  recordSession(dir2, record({ kind: "author", at: 1000 }));
  recordSession(dir2, record({ kind: "author", agent: "claude", at: 2000 }));
  assert.equal(sessionResumable(dir2, { kind: "author", agent: "pi" }, true), false);
});

test("pruneSessionLedgers drops lines past the window and keeps the recent ones", () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  const now = Date.now();
  const old = record({ name: "old", at: now - 30 * 24 * 3600 * 1000 });
  const recent = record({ name: "recent", at: now });
  recordSession(dir, old);
  recordSession(dir, recent);
  fs.appendFileSync(sessionLedgerPath(dir), "junk\n");
  assert.equal(pruneSessionLedgers(root, 7), 2, "the old line and the malformed line age out");
  assert.deepEqual(readSessions(dir), [recent]);
  // A vanished root is nothing to do, and an empty result removes the file's content, not it.
  assert.equal(pruneSessionLedgers(path.join(root, "nope"), 7), 0);
});
