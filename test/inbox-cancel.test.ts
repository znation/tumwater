import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import {
  assertQueueFileName,
  cancelListedPrompt,
  cancelPrompt,
  cancelQueuedFile,
  cancelRolePrompt,
  listedQueueOutcome,
  queueFileNameProblem,
  resolveListedQueue,
} from "../src/inbox/inbox-cancel.js";
import { enqueuePrompt, enqueueRolePrompt, queuedFiles } from "../src/inbox/inbox.js";

/** src/inbox/inbox-cancel.ts's own tests: the cancel half of the prompt queues, which the
 * split-out module keeps together — the protected file-addressed guard
 * (queueFileNameProblem / assertQueueFileName), the shared resolveListedQueue resolution
 * and its lazily-forwarded outcome (also used by the edit half), and each submit surface.
 * inbox.test.ts and inbox-edit.test.ts cover the race-policy halves and the events; these
 * pin the split module's own surface. */

/** The queue files currently in one role's inbox, basenames only, so an assertion does not
 * depend on the seeded filenames' full path. */
function queueNames(root: string, role: string): string[] {
  return queuedFiles(root, role).map((f) => f.slice(f.lastIndexOf("/") + 1));
}

test("queueFileNameProblem rejects every name the filesystem cannot answer ENOENT for", () => {
  assert.equal(queueFileNameProblem(undefined), "file required");
  assert.equal(queueFileNameProblem(123 as unknown as string), "file required");
  assert.equal(queueFileNameProblem(""), "file required");
  // A path, a backslash, or `..` could name a file elsewhere on disk.
  assert.match(queueFileNameProblem("a/b.md")!, /plain queue-file basename/);
  assert.match(queueFileNameProblem("a\\b.md")!, /plain queue-file basename/);
  assert.match(queueFileNameProblem("..")!, /plain queue-file basename/);
  // A NUL byte is a character no filename can hold: the fs layer throws on it rather than
  // answering ENOENT, so the guard must reject it before anything touches disk.
  assert.match(queueFileNameProblem("a\u0000.md")!, /plain queue-file basename/);
  assert.match(queueFileNameProblem("notes.txt")!, /inbox message's .md file/);
  assert.equal(queueFileNameProblem("hello.md"), null);
  // The re-check a caller that skips the guard fails closed on does the same throwing.
  assert.equal(assertQueueFileName("hello.md"), undefined);
  assert.throws(() => assertQueueFileName("a\u0000.md"));
});

test("resolveListedQueue resolves one role, flags ambiguity, or misses with the largest queue length", () => {
  const root = tmpdir();
  enqueueRolePrompt(root, "director", "dir1");
  enqueueRolePrompt(root, "director", "dir2");
  enqueueRolePrompt(root, "feature-1", "alpha");
  const scope = ["director", "feature-1"];

  // Position 2: only the director's queue is that long — resolves to it.
  assert.deepEqual(resolveListedQueue(root, scope, 2), { status: "found", role: "director" });
  // Position 1: both queues hold it — ambiguous.
  assert.deepEqual(resolveListedQueue(root, scope, 1), { status: "ambiguous", roles: ["director", "feature-1"] });
  // Position 3 is beyond every queue: a miss carrying the largest length (director's 2).
  assert.deepEqual(resolveListedQueue(root, scope, 3), { status: "missing", queued: 2 });

  // An entirely empty binary scope misses with a zero count, not a false resolution.
  const empty = tmpdir();
  assert.deepEqual(resolveListedQueue(empty, scope, 1), { status: "missing", queued: 0 });
});

test("listedQueueOutcome forwards a found resolution to the action and passes misses through", () => {
  const invoked: string[] = [];
  const found = listedQueueOutcome(
    { status: "found", role: "feature-1" },
    (role) => { invoked.push(role); return "done"; },
  );
  assert.equal(found, "done");
  assert.deepEqual(invoked, ["feature-1"]);

  // A miss never runs the action: it is passed through verbatim, so no side effect fires.
  assert.deepEqual(
    listedQueueOutcome({ status: "ambiguous", roles: ["director", "feature-1"] }, () => "x"),
    { status: "ambiguous", roles: ["director", "feature-1"] },
  );
  assert.deepEqual(
    listedQueueOutcome({ status: "missing", queued: 4 }, () => "x"),
    { status: "missing", queued: 4 },
  );
  assert.deepEqual(invoked, ["feature-1"], "only the single found resolution ran the action");
});

test("cancelPrompt removes the Nth queued prompt and reports its text", () => {
  const root = tmpdir();
  enqueuePrompt(root, "alpha");
  enqueuePrompt(root, "beta");
  enqueuePrompt(root, "gamma");

  assert.deepEqual(cancelPrompt(root, 2), { status: "cancelled", text: "beta" });
  // Siblings keep their relative positions.
  assert.equal(queuedFiles(root, "director").length, 2);

  // Both remaining prompts cancel in order, then the queue is empty.
  assert.equal(cancelPrompt(root, 1).status, "cancelled");
  assert.equal(cancelPrompt(root, 1).status, "cancelled");
  assert.deepEqual(queueNames(root, "director"), []);

  // An out-of-range position throws, never reports a false "gone".
  assert.throws(() => cancelPrompt(root, 1), /no prompt at position/);
  assert.throws(() => cancelPrompt(root, 0), /no prompt at position/);
});

test("cancelRolePrompt removes by per-role position under the named role", () => {
  const root = tmpdir();
  enqueueRolePrompt(root, "feature-1", "f1");
  enqueueRolePrompt(root, "feature-1", "f2");

  assert.deepEqual(cancelRolePrompt(root, "feature-1", 2), { status: "cancelled", text: "f2" });
  assert.deepEqual(queueNames(root, "feature-1"), [basenameOf(queuedFiles(root, "feature-1")[0] as string)]);
  assert.throws(() => cancelRolePrompt(root, "feature-1", 5), /no prompt at position/);
});

test("cancelQueuedFile removes by basename and reports gone for a name naming no queued file", () => {
  const root = tmpdir();
  const file = enqueueRolePrompt(root, "feature-1", "queued body");
  const name = basenameOf(file);

  const outcome = cancelQueuedFile(root, "feature-1", name);
  assert.deepEqual(outcome, { status: "cancelled", text: "queued body" });
  assert.equal(existsSync(file), false, "the named queue file is removed");

  // A valid basename that names no queued file is a normal race with a dequeue -> gone.
  assert.deepEqual(cancelQueuedFile(root, "feature-1", "no-such.md"), { status: "gone" });
  assert.throws(() => cancelQueuedFile(root, "feature-1", "a\u0000.md"));
  assert.throws(() => cancelQueuedFile(root, "feature-1", "sub/a.md"));
});

test("cancelListedPrompt resolves list-wide and cancels in the one role that holds the position", () => {
  const root = tmpdir();
  enqueueRolePrompt(root, "director", "dir1");
  enqueueRolePrompt(root, "director", "dir2");
  enqueueRolePrompt(root, "feature-1", "f1");
  enqueueRolePrompt(root, "feature-1", "f2");
  const scope = ["director", "feature-1"];

  // Position 2 is held by both roles -> ambiguous, nothing cancelled.
  assert.deepEqual(cancelListedPrompt(root, scope, 2), { status: "ambiguous", roles: ["director", "feature-1"] });
  // Position 3 exceeds every queue -> miss with the largest length, nothing cancelled.
  assert.deepEqual(cancelListedPrompt(root, scope, 3), { status: "missing", queued: 2 });
  assert.equal(queuedFiles(root, "director").length + queuedFiles(root, "feature-1").length, 4);
  // Both queues still hold their two entries each.
  assert.equal(queuedFiles(root, "director").length, 2);
  assert.equal(queuedFiles(root, "feature-1").length, 2);
});

/** The basename of a queue file path, without slicing a path separator spelling. */
function basenameOf(file: string): string {
  return file.split("/").pop() as string;
}
