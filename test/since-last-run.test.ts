import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectSinceLastRun } from "../src/prompt/since-last-run.js";
import { entryKey } from "../src/backlog/backlog-parts.js";
import { defaultConfig } from "../src/config/config.js";
import { freshRunnerState, type RunnerState } from "../src/runner/runner-state.js";
import { gitFailingOn } from "./helpers/git-faults.js";
import { makeRepo, sh, headSha } from "./fixtures/repo-fixtures.js";

/** A fresh checkout on main. `makeRepo`'s template ends with one "seed" commit and a clean
 * worktree, so every change a test wants committed must create or edit a file first. */
function repo(): string {
  return makeRepo();
}

/** Write `file` in `dir` (creating its parent) and commit it under `msg`. The worktree is
 * otherwise clean, so a commit with no file change would fail. */
function commit(d: string, file: string, content: string, msg: string): void {
  const p = path.join(d, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  sh(d, "git", "add", "-A");
  sh(d, "git", "commit", "-m", msg);
}

function state(overrides: Partial<RunnerState> = {}): RunnerState {
  return { ...freshRunnerState("feature"), ...overrides };
}

const NOW = 1_700_000_000_000;

test("collectSinceLastRun lists the commits that landed after the anchor, newest first", () => {
  const d = repo();
  const anchor = sh(d, "git", "rev-parse", "main");
  commit(d, "one.txt", "1\n", "second");
  commit(d, "two.txt", "2\n", "third");
  const out = collectSinceLastRun(d, "feature", defaultConfig(), state({ lastMainHead: anchor, lastRunEndedAt: NOW - 3_600_000 }), NOW);
  assert.ok(out, "block present");
  // Newest first: "third" precedes "second"; the anchor's own "seed" commit is excluded.
  const iThird = out!.indexOf("third");
  const iSecond = out!.indexOf("second");
  assert.ok(iThird !== -1 && iSecond !== -1 && iThird < iSecond, `third (${iThird}) before second (${iSecond})`);
  assert.doesNotMatch(out!, /seed/);
  // The header attests the commit count.
  assert.match(out!, /2 commits merged to main/);
  assert.doesNotMatch(out!, /Nothing has changed/);
});

test("a commit authored by the role itself is marked as its own merge", () => {
  const d = repo();
  const anchor = sh(d, "git", "rev-parse", "main");
  commit(d, "own.txt", "own\n", "tumwater(feature): Landed my thing");
  const out = collectSinceLastRun(d, "feature", defaultConfig(), state({ lastMainHead: anchor, lastRunEndedAt: NOW - 60_000 }), NOW);
  assert.ok(out);
  assert.match(out!, /tumwater\(feature\): Landed my thing \(your own merge\)/);
});

test("a foreign commit (another role's merge) is not marked as its own", () => {
  const d = repo();
  const anchor = sh(d, "git", "rev-parse", "main");
  commit(d, "x.txt", "x\n", "tumwater(plan): Wrote a plan");
  const out = collectSinceLastRun(d, "feature", defaultConfig(), state({ lastMainHead: anchor }), NOW);
  assert.ok(out);
  assert.match(out!, /tumwater\(plan\): Wrote a plan/);
  assert.doesNotMatch(out!, /\(your own merge\)/);
});

test("an empty anchor (a first run) omits the block", () => {
  const d = repo();
  const out = collectSinceLastRun(d, "feature", defaultConfig(), state({ lastMainHead: "" }), NOW);
  assert.equal(out, undefined);
});

test("an anchor that is not an ancestor of main omits the block", () => {
  const d = repo();
  // A sha that is no commit of this repo: git's merge-base --is-ancestor exits nonzero, so the
  // block is omitted.
  const out = collectSinceLastRun(d, "feature", defaultConfig(), state({ lastMainHead: "f".repeat(40) }), NOW);
  assert.equal(out, undefined);
});

test("main that has not moved renders the single 'nothing changed' line", () => {
  const d = repo();
  const anchor = headSha(d);
  const out = collectSinceLastRun(d, "feature", defaultConfig(), state({ lastMainHead: anchor }), NOW);
  assert.ok(out);
  assert.match(out!, /Nothing has changed on main/);
  assert.doesNotMatch(out!, /Commits on main/);
});

test("a git that cannot read the log omits the block rather than failing", () => {
  const d = repo();
  commit(d, "extra.txt", "e\n", "extra");
  const anchor = sh(d, "git", "rev-parse", "main");
  const restore = gitFailingOn("log");
  try {
    // merge-base still runs real git (returns a sha → ancestor true), but the `git log` call is
    // shimmed to fail, so collectSinceLastRun must omit the block.
    const out = collectSinceLastRun(d, "feature", defaultConfig(), state({ lastMainHead: anchor }), NOW);
    assert.equal(out, undefined);
  } finally {
    restore();
  }
});

test("an assigned run leads the file list with its entry's touched files", () => {
  const d = repo();
  fs.writeFileSync(
    path.join(d, "PLANS.md"),
    "## Planned\n\n### Alpha part 1/1: touch the thing (planned 2026-11-12 by the plan role)\n\n**Goal.** x.\n\n**Files touched.** src/thing.ts\n",
  );
  sh(d, "git", "add", "-A");
  sh(d, "git", "commit", "-m", "plan");
  const anchor = headSha(d);
  // The entry's file (src/thing.ts) is touched by ONE commit; the unrelated file is touched by
  // TWO. So the plain count ranking puts unrelated first — but the entry-priority reorder must
  // promote the entry's own file to the front of the file list.
  commit(d, "src/thing.ts", "export const t = 1;\n", "change1");
  commit(d, "unrelated.txt", "u1\n", "change2");
  commit(d, "unrelated.txt", "u2\n", "change3");
  const out = collectSinceLastRun(
    d,
    "feature",
    defaultConfig(),
    state({
      lastMainHead: anchor,
      claim: { file: "PLANS.md", key: entryKey("Alpha part 1/1: touch the thing"), title: "Alpha part 1/1: touch the thing", at: NOW, source: "assigned" },
    }),
    NOW,
  );
  assert.ok(out);
  const iThing = out!.indexOf("src/thing.ts");
  const iUnrelated = out!.indexOf("unrelated.txt");
  assert.ok(iThing !== -1, "the entry's touched file is listed");
  assert.ok(iUnrelated !== -1, "the unrelated file is listed");
  assert.ok(iThing < iUnrelated, `entry's file (${iThing}) precedes unrelated (${iUnrelated})`);
});

test("the block is capped at 4000 characters, keeping the newest commits", () => {
  const d = repo();
  const anchor = headSha(d);
  // 60 commits, each changing a distinct file: forces both the subject and the file caps.
  for (let i = 0; i < 60; i++) commit(d, `f${i}.txt`, `${i}\n`, `commit ${i}`);
  const out = collectSinceLastRun(d, "feature", defaultConfig(), state({ lastMainHead: anchor }), NOW);
  assert.ok(out);
  assert.ok(out!.length <= 4000, `block is ${out!.length} chars`);
  // The newest commit survives; the oldest is dropped with a "+N older" marker.
  assert.match(out!, /commit 59/);
  assert.doesNotMatch(out!, /commit 0\b/);
  assert.match(out!, /\+\d+ older/);
});
