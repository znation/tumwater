import test from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init/init.js";
import { dequeuePrompt, inboxSize } from "../src/inbox/inbox.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

// Spawned-CLI argument-strictness tests for `tumwater prompt`: the flag/positional boundary
// (only double-dash tokens are flags; single-dash ones are free-form content) and --at's value
// arity. Split out of cli-arg-strictness.test.ts, which keeps the parser-wide unknown-argument
// and flag-value gates, so node --test runs each command's strictness cases in parallel
// processes. The question boundary cases live in cli-questions-strictness.test.ts and the tui
// dispatch guards in cli-tui-strictness.test.ts.
test("prompt rejects unknown double-dash flags instead of baking them into content", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt unknown flag");

  // Before parsePromptArgs existed, `tumwater prompt --foo text` enqueued "--foo text" as the
  // prompt — the same class of hole init's parseInitArgs closed. The flag must fail and leave
  // the queue untouched.
  const r = await cli(repo, "prompt", "--foo", "text");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --foo/);
  assert.match(r.stderr, /--list, --json, --cancel <n>/);
  assert.equal(inboxSize(repo), 0, "the flag was not baked into queued content");
});

test("prompt keeps single-dash positionals as prompt content", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt single dash");

  // Only double-dash tokens are flags; a leading single dash is free-form content, like the
  // bullets init accepts.
  const r = await cli(repo, "prompt", "-x");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /added to the director's inbox/);
  assert.equal(dequeuePrompt(repo), "-x");
});

test("prompt --at without a value fails with parseDurationFlag's message", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt at missing value");
  // A bare --at claims a duration: a missing value is parseDurationFlag's own error, not a
  // silent enqueue of "--at re-check" as prompt text.
  const r = await cli(repo, "prompt", "--at");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--at needs a value/);
  assert.equal(inboxSize(repo), 0, "the flag pair was not baked into queued content");
});
