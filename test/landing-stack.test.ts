/** landing-stack.ts's stack fast-forward (ffStackToMain): one ff of main through a whole
 * vetted stack, the per-change merged events, the question_posted diff, and the
 * merge_blocked contract when main moved under the batch. Moved from test/landing-merge.test.ts
 * with the function itself (the stack merge-half lives in landing-stack.ts). */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ffStackToMain } from "../src/landing/landing-stack.js";
import { eventsOfType } from "./log-fixtures.js";
import { mainSha, makeRepo, sh } from "./repo-fixtures.js";

// ── ffStackToMain (merge queue 5/5) ──────────────────────────────────────────────────────

/** A repo with main at its seed commit and a two-commit stack built off it (a.txt, then
 * b.txt on top), detached — the shape a stack's assembly (landing-stack.ts) leaves before the ff. */
async function stackFixture(): Promise<{ root: string; shaA: string; shaB: string }> {
  const root = makeRepo();
  // The merge lock's parent dir — withLock mkdir's <root>/.tumwater/merge.lock without
  // creating its parent, and a bare makeRepo has no .tumwater yet.
  fs.mkdirSync(path.join(root, ".tumwater"), { recursive: true });
  sh(root, "git", "checkout", "--detach");
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "work A");
  const shaA = sh(root, "git", "rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(root, "b.txt"), "b\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "work B");
  const shaB = sh(root, "git", "rev-parse", "HEAD").trim();
  sh(root, "git", "checkout", "main");
  return { root, shaA, shaB };
}

test("ffStackToMain fast-forwards main through the whole stack in one ff with per-change events", async () => {
  const { root, shaA, shaB } = await stackFixture();
  const stack = [
    { role: "alpha", sha: shaA, summary: "A" },
    { role: "beta", sha: shaB, summary: "B" },
  ];

  assert.equal(await ffStackToMain(root, "main", stack), "changed");
  assert.equal(mainSha(root), shaB, "main fast-forwarded to the stacked tip");
  const merged = eventsOfType(root, "merged");
  assert.equal(merged.length, 2, "one merged event per change, in queue order");
  assert.equal(merged[0]!.loop, "alpha");
  assert.equal(merged[0]!.commit, shaA, "the head's own sha");
  assert.equal(merged[1]!.loop, "beta");
  assert.equal(merged[1]!.commit, shaB, "the stacked tip");

  // An empty stack is a no-op: nothing to fast-forward, nothing logged.
  assert.equal(await ffStackToMain(root, "main", []), "changed");
  assert.equal(eventsOfType(root, "merged").length, 2, "the empty stack logged nothing");
});

test("ffStackToMain returns merge_blocked when main diverged under the stack, with no events", async () => {
  const { root, shaA, shaB } = await stackFixture();
  // A human commit on main from the same base: the stack and main have diverged, so the
  // fast-forward cannot succeed.
  fs.writeFileSync(path.join(root, "c.txt"), "c\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "human work");
  const mainAfter = mainSha(root);

  assert.equal(
    await ffStackToMain(root, "main", [
      { role: "alpha", sha: shaA, summary: "A" },
      { role: "beta", sha: shaB, summary: "B" },
    ]),
    "merge_blocked",
  );
  assert.equal(mainSha(root), mainAfter, "main is untouched");
  assert.equal(eventsOfType(root, "merged").length, 0, "no events on a blocked ff");
});

test("ffStackToMain emits question_posted for questions the stack adds, not pre-existing ones", async () => {
  // Mirror the single-change question_posted test: a batch's new Open headings must surface
  // as events so the dashboards and report see questions the same way whether one change or a
  // stack landed them. Seed an existing question so the diff is exercised, not just the empty
  // `before` list.
  const root = makeRepo();
  // withLock mkdir's <root>/.tumwater/merge.lock without creating its parent.
  fs.mkdirSync(path.join(root, ".tumwater"), { recursive: true });
  const existing =
    "# Questions\n\n## Open\n\n### Existing question (asked by improve)\n\nBody.\n\n## Answered\n\n_None yet._\n";
  fs.writeFileSync(path.join(root, "QUESTIONS.md"), existing);
  sh(root, "git", "add", "QUESTIONS.md");
  sh(root, "git", "commit", "-m", "seed questions");

  sh(root, "git", "checkout", "--detach");
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "work A");
  const shaA = sh(root, "git", "rev-parse", "HEAD").trim();
  fs.writeFileSync(
    path.join(root, "QUESTIONS.md"),
    existing.replace(
      "\n## Answered",
      "\n### New question (asked by improve)\n\nBody.\n\n## Answered",
    ),
  );
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "post a question");
  const shaB = sh(root, "git", "rev-parse", "HEAD").trim();
  sh(root, "git", "checkout", "main");

  assert.equal(
    await ffStackToMain(root, "main", [
      { role: "alpha", sha: shaA, summary: "A" },
      { role: "beta", sha: shaB, summary: "B" },
    ]),
    "changed",
  );
  const posted = eventsOfType(root, "question_posted");
  assert.deepEqual(
    posted.map((e) => e.question),
    ["New question (asked by improve)"],
    "exactly one event for the added heading — the pre-existing entry is not re-posted",
  );
  assert.equal(posted[0]!.loop, "alpha", "attributed to the batch's first change, like the single-change path");
});
