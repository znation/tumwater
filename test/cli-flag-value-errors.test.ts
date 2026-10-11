import test from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init/init.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";

// Parser-wide flag-value tests: a flag whose value is present but malformed (`--since bogus`,
// `-n 0`, `--port abc`) or absent (`pause --role`) must be named before the ready-repo gate, in
// the command's own parser wording. These walk several commands because the shared dispatch
// applies the same gate everywhere; the unknown-argument sibling lives in
// cli-arg-strictness.test.ts. Split out of it so the two gate families run in parallel
// processes. Spawned via the CLI so node --test can run them there.
test("a malformed flag value is named before the ready-repo gate", async () => {
  // The missing-value gate above covers a flag whose value is ABSENT; this covers a value
  // present but malformed (`--since bogus`, `-n 0`, `--port abc`): the same masking applied —
  // outside an initialized repo the ready-repo gate reported "not a git repository" while the
  // operator's actual typo went unnamed. Each spec now re-runs its command body's own pure
  // shape parser at the gate, so the wording is the parser's, byte for byte, in both places.
  const empty = tmpdir();
  const cases: Array<[string[], RegExp]> = [
    [["logs", "--since", "bogus"], /logs --since needs a duration like 45s, 90m, 1h30m, or 2d \(got "bogus"\)/],
    [["history", "--since", "0s"], /history --since needs a duration like 45s, 90m, 1h30m, or 2d \(got "0s"\)/],
    [["report", "--since", "45"], /report --since needs a duration like 45s, 90m, 1h30m, or 2d \(got "45"\)/],
    [["logs", "-n", "0"], /-n needs a positive integer \(got "0"\)/],
    [["history", "-n", "abc"], /-n needs a positive integer \(got "abc"\)/],
    [["report", "--days", "abc"], /--days needs a positive integer \(got "abc"\)/],
    [["gui", "--port", "abc"], /--port must be an integer between 1 and 65535 \(got "abc"\)/],
    [["pause", "--for", "xyz"], /pause --for needs a duration like 45s, 90m, 1h30m, or 2d \(got "xyz"\)/],
    [["pause", "--for"], /pause --for needs a value/],
    [["run", "--for"], /run --for needs a value/],
    [["wake", "--in"], /wake --in needs a value/],
  ];
  for (const [args, pattern] of cases) {
    const r = await cli(empty, ...args);
    assert.equal(r.code, 1, `tumwater ${args.join(" ")}`);
    assert.match(r.stderr, pattern, `tumwater ${args.join(" ")}`);
    assert.doesNotMatch(r.stderr, /git repository/, `tumwater ${args.join(" ")}`);
  }

  // In a ready repo the same slips fail identically — the gate runs there too.
  const repo = makeRepo();
  await initProject(repo, "cli malformed flag value");
  const ready = await cli(repo, "logs", "--since", "bogus");
  assert.equal(ready.code, 1);
  assert.match(ready.stderr, /logs --since needs a duration like 45s, 90m, 1h30m, or 2d \(got "bogus"\)/);
});

test("a valued flag left without its value is named before the ready-repo gate", async () => {
  // Outside an initialized repo, `pause --role` used to report "not a git repository": the
  // ready-repo gate sits between rejectUnknownArgs and each command's own parser, so the
  // missing value was masked until the operator had fixed an environment that was never the
  // problem. The gate now names it with the parser's own wording, and no marker is written.
  const empty = tmpdir();
  const r = await cli(empty, "pause", "--role");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tumwater: --role needs a role id/);
  assert.doesNotMatch(r.stderr, /git repository/);

  // The pause reason's missing value names its own command, the same masking rule.
  const reasonless = await cli(empty, "pause", "--reason");
  assert.equal(reasonless.code, 1);
  assert.match(reasonless.stderr, /tumwater: pause --reason needs a reason/);
  assert.doesNotMatch(reasonless.stderr, /git repository/);

  // prompt has no rejectUnknownArgs (free-form positionals), so its parse runs before the
  // gate instead — the same slip, the same wording, no environment error.
  const p = await cli(empty, "prompt", "--role");
  assert.equal(p.code, 1);
  assert.match(p.stderr, /tumwater: --role needs a role id/);
  assert.doesNotMatch(p.stderr, /git repository/);

  // In a ready repo the same slips fail identically — the gate runs there too.
  const repo = makeRepo();
  await initProject(repo, "cli missing flag value");
  for (const args of [["pause", "--role"], ["prompt", "--role"]]) {
    const ready = await cli(repo, ...args);
    assert.equal(ready.code, 1);
    assert.match(ready.stderr, /tumwater: --role needs a role id/);
  }
});
