/** The prompt queues' event logging is best-effort (src/events/events.ts's
 * logEventBestEffort). Submitting, cancelling, and editing a queued prompt each perform their
 * durable effect — the queue write, the queue-file removal, the in-place rewrite — before they
 * log their event, and the operator-facing surfaces (TUI, GUI, CLI) report the durable effect's
 * outcome. An unwritable events feed (ENOSPC, EACCES, the path replaced) must not make a
 * completed submit/cancel/edit look failed, or the operator's retry duplicates the prompt (or
 * believes a cancel that did happen did not). The fault is injected by putting a directory
 * where events.jsonl belongs: every append throws EISDIR, while every other file under the real
 * root still writes, so each path reaches its own event line exactly as it would on a full
 * disk. */

import test from "node:test";
import assert from "node:assert/strict";

import { tmpdir } from "./fixtures/repo-fixtures.js";
import { unwritableEvents } from "./fixtures/log-fixtures.js";
import { submitPrompt, submitRolePrompt } from "../src/inbox/inbox-submit.js";
import { cancelRolePrompt } from "../src/inbox/inbox-cancel.js";
import { editRolePrompt } from "../src/inbox/inbox-edit.js";
import { enqueueRolePrompt, inboxSize, queuedPrompts, queuedRolePrompts } from "../src/inbox/inbox.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const png = (): { name: string; dataBase64: string } => ({ name: "shot.png", dataBase64: PNG.toString("base64") });

test("submitPrompt queues the prompt and reports success when the events feed is unwritable", () => {
  const root = tmpdir();
  unwritableEvents(root);
  const queued = submitPrompt(root, "handle the failing build");
  assert.equal(queued, "handle the failing build");
  assert.deepEqual(queuedPrompts(root), ["handle the failing build"]); // the durable effect landed
});

test("submitRolePrompt's image path queues the prompt when the events feed is unwritable", () => {
  const root = tmpdir();
  unwritableEvents(root);
  const queued = submitRolePrompt(root, "qa", "look at this", [png()]);
  assert.ok(queued.includes("[image attached: "));
  assert.equal(queuedRolePrompts(root, "qa").length, 1); // the durable effect landed
});

test("cancelRolePrompt removes the prompt and reports cancelled when the events feed is unwritable", () => {
  const root = tmpdir();
  enqueueRolePrompt(root, "bugfix", "drop me");
  unwritableEvents(root);
  assert.deepEqual(cancelRolePrompt(root, "bugfix", 1), { status: "cancelled", text: "drop me" });
  assert.equal(inboxSize(root, "bugfix"), 0); // the durable effect landed
});

test("editRolePrompt rewrites the prompt when the events feed is unwritable", () => {
  const root = tmpdir();
  enqueueRolePrompt(root, "bugfix", "old text");
  unwritableEvents(root);
  assert.deepEqual(editRolePrompt(root, "bugfix", 1, "new text"), {
    status: "edited",
    oldText: "old text",
    newText: "new text",
  });
  assert.deepEqual(queuedRolePrompts(root, "bugfix"), ["new text"]); // the durable effect landed
});
