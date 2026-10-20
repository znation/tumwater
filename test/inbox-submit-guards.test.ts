import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { queuedRolePromptRecords, queuedRolePrompts } from "../src/inbox/inbox.js";
import { submitRolePrompt } from "../src/inbox/inbox-submit.js";
import { roleInboxDir } from "../src/paths.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// Two submitRolePrompt guards test/inbox-submit.test.ts does not reach: the image path keeps a
// not-before deferral, and a malformed image is refused before the role's inbox is created.

test("an image-carrying prompt submitted with notBeforeMs is queued deferred", () => {
  const dir = tmpdir();
  const until = Date.now() + 30 * 60_000;
  const image = { name: "shot.png", dataBase64: Buffer.from("a").toString("base64") };
  submitRolePrompt(dir, "qa", "look later", [image], until);
  const records = queuedRolePromptRecords(dir, "qa");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.notBeforeMs, until);
  assert.ok(records[0]?.text.includes("[image attached: "));
  assert.equal(queuedRolePrompts(dir, "qa").length, 0); // listed, not deliverable
});

test("a malformed image is refused before the role's inbox is touched", () => {
  const dir = tmpdir();
  assert.throws(
    () => submitRolePrompt(dir, "qa", "look at this", [{ name: "shot.png", dataBase64: "not base64!" }]),
    /valid base64/,
  );
  assert.equal(fs.existsSync(roleInboxDir(dir, "qa")), false);
  assert.equal(eventsOfType(dir, "prompt_enqueued").length, 0);
});
