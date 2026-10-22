import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  latestSession,
  pruneOpencodeSessions,
  pruneSessionLedgers,
  readSessions,
  recordSession,
  resumableSession,
  sessionLedgerPath,
  sessionResumable,
} from "../src/agent/session-ledger.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { record } from "./fakes/session-record.js";
import { writeScript } from "./fakes/fake-commands.js";

// The session ledger (plans/agent-backends.md "Sessions") is the resume paths' memory of which
// session a `--continue` would actually reach: one line per run, kind and agent tagged. These
// tests pin the record/read round trip, the newest-of-kind lookup that fixes the conflict
// resolver shadowing the author's session, the file-exists requirement, and the retention trim.

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

test("recordSession repairs a torn previous line so the next record is not lost", () => {
  const dir = tmpdir();
  const first = record({ name: "first", at: 1000 });
  recordSession(dir, first);
  // A crash mid-append leaves the last line without its newline. The next append must
  // terminate it first: appended raw, the next record glues onto the fragment and BOTH
  // lines fail to parse (the same repair events.ts's appendEventLine already makes).
  fs.appendFileSync(sessionLedgerPath(dir), '{"agent":"pi"');
  const second = record({ name: "second", at: 2000 });
  recordSession(dir, second);
  assert.deepEqual(readSessions(dir), [first, second]);
  assert.deepEqual(latestSession(dir), second, "the run after a torn append is still resumable");
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

test("the stream-minted codex record wins over its own pre-spawn record", () => {
  // A fresh codex run pre-spawns a ledger record carrying the session name, then (when the
  // stream names its thread id) appends a second record with the UUID id. They share kind,
  // agent, cwd and name; the later-appended stream-minted one is what a resume must reach.
  const dir = tmpdir();
  recordSession(dir, record({ agent: "codex", kind: "author", name: "t", cwd: "/wt", id: "t", at: 1000 }));
  recordSession(dir, record({ agent: "codex", kind: "author", name: "t", cwd: "/wt", id: "01a15c9d-6762-7931-814e-a3e6e64c1b51", at: 2000 }));
  const got = resumableSession(dir, { kind: "author", agent: "codex", cwd: "/wt" });
  assert.equal(got?.id, "01a15c9d-6762-7931-814e-a3e6e64c1b51", "the stream-minted id is the one a resume uses");
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

test("pruneOpencodeSessions deletes expired opencode sessions and prunes old spill files", () => {
  const root = tmpdir();
  const dir = path.join(root, "feature");
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  recordSession(dir, record({ agent: "opencode", id: "ses-old", at: now - 30 * day }));
  recordSession(dir, record({ agent: "opencode", id: "ses-fresh", at: now }));
  // A non-opencode record is never handed to the delete hook.
  recordSession(dir, record({ agent: "pi", id: "id-pi", at: now - 30 * day }));

  const bin = tmpdir("opencode-prune-bin-");
  const capture = path.join(tmpdir("opencode-prune-capture-"), "deleted.log");
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  writeScript(path.join(bin, "opencode"), `printf '%s\\n' "$*" >> ${capture}`);

  const spill = path.join(root, "spill");
  fs.mkdirSync(spill, { recursive: true });
  const oldSpill = path.join(spill, "old.txt");
  const freshSpill = path.join(spill, "fresh.txt");
  fs.writeFileSync(oldSpill, "x");
  fs.writeFileSync(freshSpill, "x");
  const oldTime = new Date(now - 30 * day);
  fs.utimesSync(oldSpill, oldTime, oldTime);

  const deleted = pruneOpencodeSessions(root, 7, { bin: path.join(bin, "opencode"), env: { OPENCODE_DB: "/x.db" }, spillDir: spill });
  assert.equal(deleted, 1, "only the expired opencode session is deleted");
  const log = fs.existsSync(capture) ? fs.readFileSync(capture, "utf8") : "";
  assert.ok(log.includes("session delete ses-old --standalone"), `old session deleted: ${log}`);
  assert.ok(!log.includes("ses-fresh"), `fresh session left alone: ${log}`);
  assert.ok(!log.includes("id-pi"), `a non-opencode record never reaches the delete hook: ${log}`);
  assert.ok(!fs.existsSync(oldSpill), "the old spill file is deleted");
  assert.ok(fs.existsSync(freshSpill), "the fresh spill file is kept");
});
