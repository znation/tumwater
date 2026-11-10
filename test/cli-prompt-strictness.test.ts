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
  assert.match(r.stderr, /--list, --json, -f\/--follow, --cancel <n>/);
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

  // --json is a view/mutation flag: it applies to --top (an acknowledgement), so it is
  // accepted — the miss it then hits is the prose error, unchanged by the flag.
  const withJson = await cli(repo, "prompt", "--top", "1", "--json");
  assert.equal(withJson.code, 1);
  assert.match(withJson.stderr, /no prompt at position 1/);
  // It is still at-most-once, and it is not prompt text: a stray token is refused as before.
  const dupJson = await cli(repo, "prompt", "--top", "1", "--json", "--json");
  assert.equal(dupJson.code, 1);
  assert.match(dupJson.stderr, /--json may only be given once/);
  const stray = await cli(repo, "prompt", "--top", "1", "--json", "extra");
  assert.equal(stray.code, 1);
  assert.match(stray.stderr, /with --top there is no prompt text/);

  // In the enqueue forms --json is now accepted as an acknowledgement flag: the prompt is
  // enqueued and the acknowledgement object is printed. The queue holds "hello" (the --json
  // token is claimed, never prompt text).
  const enqueue = await cli(repo, "prompt", "hello", "--json");
  assert.equal(enqueue.code, 0, enqueue.stderr);
  assert.match(enqueue.stdout, /"status":\s*"queued"/);

  assert.equal(inboxSize(repo), 1, "the --json enqueue form queues the prompt");
});

// --show's strictness surface, mirroring --cancel's: it is a read-only position mode, so it
// refuses the other queue modes as mutually exclusive, the queue-only flags and list-only
// filters as meaningless, and any stray positional as prompt text it has no use for.
test("prompt --show refuses the sibling modes, the queue-only and list-only flags, and stray text", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli prompt show strictness");

  // --show is mutually exclusive with the list/cancel/edit/top modes (the check runs before
  // any of those branches reads its own value, so `--show 2 --edit` needs no edit text).
  for (const other of ["--list", "--cancel", "--edit", "--top"] as const) {
    const args = other === "--list" ? ["--show", "2", other] : ["--show", "2", other, "1"];
    const r = await cli(repo, "prompt", ...args);
    assert.equal(r.code, 1, `--show with ${other} should fail`);
    assert.match(r.stderr, new RegExp(`${other} and --show are mutually exclusive`));
  }

  // The queue-only flags and the list-only filters have nothing to mean to a read-only show,
  // and are refused by name.
  for (const [flag, value] of [["--file", "x.txt"], ["--at", "1h"], ["--attach", "p.png"]] as const) {
    const r = await cli(repo, "prompt", "--show", "1", flag, value);
    assert.equal(r.code, 1, `--show with ${flag} should fail`);
    assert.match(r.stderr, new RegExp(`${flag} only queues a prompt`));
  }
  for (const [flag, value] of [["--grep", "x"], ["--follow", null]] as const) {
    const r = await cli(repo, "prompt", "--show", "1", flag, ...(value === null ? [] : [value]));
    assert.equal(r.code, 1, `--show with ${flag} should fail`);
    assert.match(r.stderr, new RegExp(`${flag} only applies to --list`));
  }

  // The -f spelling is a stray token in a text-less mode.
  const f = await cli(repo, "prompt", "--show", "1", "-f");
  assert.equal(f.code, 1);
  assert.match(f.stderr, /with --show there is no prompt text/);

  // A position needs the shared `--show 2` usage wording: a missing value names it, and a
  // non-integer or non-positive value is refused as not a positive integer.
  const missing = await cli(repo, "prompt", "--show");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--show needs a position number \(e\.g\. `--show 2`\)/);
  for (const bad of ["1.5", "0", "-2"]) {
    const r = await cli(repo, "prompt", "--show", bad);
    assert.equal(r.code, 1, `--show ${bad} should fail`);
    assert.match(r.stderr, /--show needs a positive integer/);
  }

  // A stray positional is prompt text this mode has none of.
  const r = await cli(repo, "prompt", "--show", "1", "extra");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /with --show there is no prompt text/);

  assert.equal(inboxSize(repo), 0, "nothing enqueued on failure");
});
