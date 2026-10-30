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

test("prompt --attach refuses a flag-looking value instead of taking it as the path", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt attach flag-looking value");
  // --attach claims the next token as its path; a `--` token in that slot is a dropped value
  // (`--attach --role qa fix`), so it must name the slip up front rather than fail deep in
  // image reading with a misleading "cannot read attached image"/"unsupported image type".
  const r = await cli(repo, "prompt", "--attach", "--role", "qa", "fix the layout");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--attach needs a value \(the next token "--role" is a flag, not a value\)/);
  assert.equal(inboxSize(repo), 0, "the flag pair was not baked into queued content");
});

// --top's strictness surface, mirroring --cancel's: it is a position mode, so it refuses the
// other queue modes as mutually exclusive, the queue-only flags as meaningless, and any stray
// positional as prompt text it has no use for.
test("prompt --top refuses the other modes, the queue-only flags, and stray text", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt top strictness");

  // --top is mutually exclusive with the list/cancel/edit modes (the check runs before any
  // of those branches reads its own value, so `--top 2 --edit` needs no edit position).
  const rList = await cli(repo, "prompt", "--top", "2", "--list");
  assert.equal(rList.code, 1);
  assert.match(rList.stderr, /--list and --top are mutually exclusive/);
  const rCancel = await cli(repo, "prompt", "--top", "2", "--cancel", "1");
  assert.equal(rCancel.code, 1);
  assert.match(rCancel.stderr, /--cancel and --top are mutually exclusive/);
  const rEdit = await cli(repo, "prompt", "--top", "2", "--edit", "1");
  assert.equal(rEdit.code, 1);
  assert.match(rEdit.stderr, /--edit and --top are mutually exclusive/);

  // The queue-only flags have nothing to mean to a reorder, and are refused by name.
  for (const [flag, value] of [["--file", "x.txt"], ["--at", "1h"], ["--attach", "p.png"]] as const) {
    const r = await cli(repo, "prompt", "--top", "1", flag, value);
    assert.equal(r.code, 1, `--top with ${flag} should fail`);
    assert.match(r.stderr, new RegExp(`${flag} only queues a prompt`));
  }

  // A stray positional is prompt text this mode has none of.
  const r = await cli(repo, "prompt", "--top", "1", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /with --top there is no prompt text/);

  assert.equal(inboxSize(repo), 0, "nothing enqueued on failure");
});
