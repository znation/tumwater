/** Third slice of the loop e2e suite (after loop.test.ts and loop-2.test.ts) — split so
 * node --test runs the slices in parallel processes: top-level tests within one file run
 * sequentially, while each test FILE gets its own process (and its own PATH, which fakePi's
 * global PATH swap requires). The slices are balanced by measured per-test duration; keep them roughly
 * equal when moving tests between the files. The suite's leftover/pin-recovery topic lives in
 * loop-leftover-recovery.test.ts (extracted 2026-09-29), the transient-retry regressions in
 * loop-transient-retry.test.ts (2026-09-30); what remains here is the rejection ride-along and
 * the landing-conflict regressions. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { landingRefName, worktreePath } from "../src/paths.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { landHead } from "./orchestrator-fixtures.js";
import { assertClean, initializedRepo, sh, tmpdir } from "./repo-fixtures.js";
import { firstRunThenIdle, logPromptsTo, readPromptRuns, withPi } from "./fake-pi.js";
import { APPROVE_PI, assistantLine } from "./pi-events.js";
test("a rejected change rides along on the role's next tick prompt with its reasons", async () => {
  const repo = await initializedRepo();
  // The reviewer (any run whose prompt asks for a VERDICT) rejects with two numbered
  // reasons. Author runs record their full argv — the prompt is pi's last argument — so
  // the test can assert what each tick was actually told, not just that state changed.
  const promptsFile = path.join(tmpdir(), "prompts.log");
  const marker = path.join(tmpdir(), "changed-once");
  const script = [
    `for a in "$@"; do case "$a" in *"VERDICT:"*)`,
    `  printf '%s\n' '${assistantLine("VERDICT: reject\n1. breaks the zero-dep rule\n2. no regression test")}'`,
    `  exit 0;; esac; done`,
    logPromptsTo(promptsFile),
    ...firstRunThenIdle(marker, [
      `printf '%s\n' '${assistantLine("did it\nSUMMARY: add rejected thing")}'`,
      `echo bad > rejected.txt`,
    ]),
  ].join("\n");
  await withPi(script, async () => {
    const runner = makeLoopRunner(repo, "improve");
    // Tick 1: the change is committed and enqueued, then the LANDING rejects it — nothing
    // lands on main.
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "rejected");
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
    const wt = worktreePath(repo, "improve");
    assertClean(wt, "a rejected tick leaves the role worktree clean at main");
    let refGone = false;
    try {
      sh(repo, "git", "rev-parse", "--verify", landingRefName("improve"));
    } catch {
      refGone = true; // a missing ref makes rev-parse --verify exit nonzero
    }
    assert.ok(refGone, "a rejection is terminal: the pin was deleted with it");
    assert.ok(!fs.existsSync(path.join(repo, "rejected.txt")), "the rejected change did not merge");

    // Tick 2: the rejection is the only cross-tick memory — every tick starts a fresh pi
    // session, so its full reasons must ride along on this tick's prompt.
    assert.equal((await runner.tick()).result, "no_change");
    const runs = readPromptRuns(promptsFile);
    assert.equal(runs.length, 2, "exactly two author runs were recorded");
    assert.ok(!runs[0]?.includes("rejected in review"), "tick 1's prompt had no rejection note yet");
    const second = runs[1] ?? "";
    assert.match(second, /Your previous change was rejected in review \(/);
    assert.match(second, /1\. breaks the zero-dep rule/);
    assert.match(second, /2\. no regression test/);
    assert.match(second, /Address the objections or take a different approach\./);
  });
});

test("concurrent-main-advance still lands (rebase path, linear history)", async () => {
  const repo = await initializedRepo();
  // The fake pi advances main itself mid-tick, simulating another loop landing work.
  const script = [
    // The tick's commit goes through the review gate before the (rebased) merge.
    APPROVE_PI,
    `printf '%s\n' '${assistantLine("ok\nSUMMARY: slow work")}'`,
    `echo slow > slow.txt`,
    `git -C "${repo}" -c user.name=t -c user.email=t@t commit --allow-empty -m "someone else"`,
  ].join("\n");
  await withPi(script, async () => {
    const runner = makeLoopRunner(repo, "organize");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "organize"), "changed");
    assert.ok(fs.existsSync(path.join(repo, "slow.txt")));
    // The tick's commit was rebased onto the concurrent main advance: no merge commits.
    assert.equal(sh(repo, "git", "log", "--merges", "--oneline"), "", "main's history stays linear");
  });
});

test("a clean resolution of a conflicted file with setext underlines lands (regression)", async () => {
  const repo = await initializedRepo();
  // docs.md uses a setext heading whose underline is exactly seven '=' — legitimate content
  // that the old marker check mistook for an unresolved conflict separator.
  fs.writeFileSync(path.join(repo, "docs.md"), "History\n=======\n\nFirst entry.\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "docs with setext heading");
  const marker = path.join(tmpdir(), "phase");
  // Phase 1 (the tick): both sides edit the same line. Phase 2 (the resolution run):
  // combine them, keeping the setext underline — no real conflict markers remain.
  const script = [
    `if [ ! -f "${marker}" ]; then`,
    `  touch "${marker}"`,
    `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch docs edit")}'`,
    `  printf 'History\\n=======\\n\\nBranch entry.\\n' > docs.md`,
    `  printf 'History\\n=======\\n\\nMain entry.\\n' > "${repo}/docs.md"`,
    `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main docs edit"`,
    `else`,
    `  printf 'History\\n=======\\n\\nBranch entry.\\nMain entry.\\n' > docs.md`,
    `fi`,
  ].join("\n");
  await withPi(script, async () => {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(
      await landHead(repo, runner, defaultConfig(), "improve"),
      "changed",
      "a clean resolution must not be rejected as conflicted",
    );
    assert.equal(
      fs.readFileSync(path.join(repo, "docs.md"), "utf8"),
      "History\n=======\n\nBranch entry.\nMain entry.\n",
    );
  });
});
