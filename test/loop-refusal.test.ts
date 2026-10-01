/** The loop e2e suite's refusal tests, in their own topic file (spun out of loop-4.test.ts
 * 2026-09-30): the TUMWATER_REFUSED sentinel's routing regressions. Like the other loop
 * slices, each test FILE gets its own process (and its own PATH, which fakePi's global PATH
 * swap requires); top-level tests within one file run sequentially. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { warningMessages } from "./log-fixtures.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { initializedRepo, sh, tmpdir } from "./repo-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { assistantLine } from "./pi-events.js";

// Refusal handling (plans/refusal-and-thrash.md): the TUMWATER_REFUSED sentinel routes a
// tick to handleRefusal, where only the markdown objection note may land — it is the durable
// record that blocks the entry for later ticks. Non-markdown half-work is discarded and the
// note commit merges directly (md-only diffs are review-exempt by construction). The sentinel
// is detected ONLY as an anchored line with a non-negating reason (BUGS.md 2026-09-23): a
// bare sentinel or a `TUMWATER_REFUSED: none` on an ordinary reply is not a refusal, and a
// refusal contradicted by its own SUMMARY beside real work keeps the work.

test("a refused tick lands only its markdown note, discards code changes, and skips review", async () => {
  const repo = await initializedRepo();
  // The fake pi counts its invocations in a file OUTSIDE the worktree: exactly one run is
  // expected (the author). A second invocation would mean the note commit went through the
  // review gate, which handleRefusal deliberately bypasses.
  const counter = path.join(tmpdir(), "pi-calls");
  fs.writeFileSync(counter, "0");
  const restore = fakePi(
    [
      `n=$(cat '${counter}'); n=$((n+1)); echo $n > '${counter}'`,
      // Declines the work and leaves a Refused note under the entry in PLANS.md — plus
      // half-done code changes (one tracked edit, one untracked file) that must NOT land.
      `printf '%s\\n' '${assistantLine("declining this plan\nTUMWATER_REFUSED: it would delete user data")}'`,
      `printf '\\n## Entry\\n\\n**Refused:** it would delete user data\\n' >> PLANS.md`,
      `echo bad >> seed.txt`,
      `echo bad > broken.ts`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "refused");
    assert.equal(outcome.summary, "it would delete user data");

    // The note landed on main with the refusal subject...
    assert.match(sh(repo, "git", "log", "-1", "--format=%s"), /tumwater\(improve\): refuse — it would delete user data/);
    assert.ok(
      fs.readFileSync(path.join(repo, "PLANS.md"), "utf8").includes("**Refused:** it would delete user data"),
      "the objection note is the durable record on main",
    );
    // ...and nothing else did: the tracked edit was reset and the untracked file cleaned.
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "seed\n", "the code change was discarded");
    assert.ok(!fs.existsSync(path.join(repo, "broken.ts")), "untracked half-work is cleaned");

    // The note commit merged directly: no reviewer run was burned on an md-only diff.
    assert.equal(fs.readFileSync(counter, "utf8").trim(), "1", "exactly one pi run (the author)");
  } finally {
    restore();
  }
});

test("a bare sentinel over work is not a refusal: the tick runs the normal flow (regression)", async () => {
  // BUGS.md 2026-09-23: the old whole-reply substring scan treated a bare sentinel mention
  // as a refusal and destroyed the work. An anchored line with no reason declares nothing.
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      `printf '%s\\n' '${assistantLine("TUMWATER_REFUSED")}'`,
      `echo bad > broken.ts`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "the work is not discarded as a refusal");
    // The edit survived — committed on the branch, headed for the normal gate, no refusal note.
    const subjects = sh(repo, "git", "log", "--format=%s", "-5");
    assert.ok(!subjects.includes("refuse —"), `no refusal commit: ${subjects}`);
  } finally {
    restore();
  }
});

test("a reply ending TUMWATER_REFUSED: none lands its work instead of refusing (regression)", async () => {
  // The exact shape that discarded two tested bugfix ticks (BUGS.md 2026-09-23): an ordinary
  // work-completed reply whose trailing line fills the sentinel in like a report field.
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      `printf '%s\\n' '${assistantLine("all done\nSUMMARY: shipped the fix\nTUMWATER_REFUSED: none")}'`,
      `echo fixed > src-fix.ts`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "a negated refusal never discards the work");
    const subjects = sh(repo, "git", "log", "--format=%s", "-5");
    assert.ok(!subjects.includes("refuse —"), `no refusal commit: ${subjects}`);
  } finally {
    restore();
  }
});

test("a refusal contradicted by its own SUMMARY beside work keeps the work behind a warning", async () => {
  // A real reason beside a SUMMARY and non-markdown work is self-contradictory: the work is
  // surfaced behind a warning and the normal flow judges it — not discarded (BUGS.md 2026-09-23).
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      `printf '%s\\n' '${assistantLine("did the work\nSUMMARY: fixed the leak\nTUMWATER_REFUSED: it would delete user data")}'`,
      `echo bad >> seed.txt`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "contradicted work runs the normal flow");
    const subjects = sh(repo, "git", "log", "--format=%s", "-5");
    assert.ok(!subjects.includes("refuse —"), `no refusal commit: ${subjects}`);
    const warnings = warningMessages(repo);
    assert.ok(
      warnings.some((w) => /refusal contradicted by its own reply/.test(w) && w.includes("seed.txt")),
      `warning names the kept work: ${JSON.stringify(warnings)}`,
    );
  } finally {
    restore();
  }
});
