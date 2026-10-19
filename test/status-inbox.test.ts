import test from "node:test";
import assert from "node:assert/strict";
import { collectInboxes } from "../src/status/status-inbox.js";
import { loopIds } from "../src/roles/runner-ids.js";
import { enqueueRolePrompt } from "../src/inbox/inbox.js";
import { submitPrompt } from "../src/inbox/inbox-submit.js";
import { initProject } from "../src/init/init.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { loadConfig } from "../src/config/config.js";

// The inbox collector builds the director queue previews and the per-role counts/entries from
// one listing pass per role; this is the small per-domain test for status-inbox.ts (the bulk
// is covered through snapshot() in status-data-inbox.test.ts).
test("collectInboxes counts the director queue and the per-role queues", async () => {
  const repo = makeRepo();
  await initProject(repo, "inbox collector");
  const roles = loopIds(loadConfig(repo));
  submitPrompt(repo, "director prompt");
  enqueueRolePrompt(repo, "clean", "one");
  enqueueRolePrompt(repo, "clean", "two");
  const got = collectInboxes(repo, roles, Date.now());
  assert.equal(got.inbox, 1, "the director prompt is the shared inbox");
  assert.equal(got.inboxPrompts.length, 1);
  assert.equal(got.roleInbox.clean, 2);
  assert.ok(!("director" in got.roleInbox), "the director's queue is not in roleInbox");
  assert.equal(got.roleInboxPrompts.clean?.length, 2);
});
