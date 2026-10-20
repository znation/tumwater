import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handleRefusal, newlyRefusedTitles, refusalContradiction, withoutBlockedPlanRefusals, type RefusalContext } from "../src/verdict/refusal.js";
import { freshRunnerState } from "../src/runner/runner-state.js";
import type { TickResult } from "../src/run/run-outcome.js";
import type { PiRunResult } from "../src/pi/pi-run-result.js";
import type { RunnerState } from "../src/runner/runner-state.js";
import { assertClean, commitIn, initializedWorktree, mainSha, sh } from "./fixtures/repo-fixtures.js";
import { readEvents } from "../src/events/event-read.js";
import { piRunResult } from "./fakes/fake-pi.js";

/** A refused pi run result; tests override only what they exercise. */
function refusedPi(over: Partial<PiRunResult> = {}): PiRunResult {
  return piRunResult({
    finalText: "TUMWATER_REFUSED",
    refused: true,
    turns: 3,
    ...over,
  });
}

interface MergeCall {
  wt: string;
  summary: string;
}

/** A RefusalContext for role "improve" whose merge records every call and returns `result`. */
function makeCtx(root: string, result: TickResult = "changed"): { ctx: RefusalContext; merges: MergeCall[] } {
  const merges: MergeCall[] = [];
  return {
    ctx: {
      role: "improve",
      root,
      mainBranch: "main",
      turns: 3,
      merge: async (wt, summary) => {
        merges.push({ wt, summary });
        return result;
      },
    },
    merges,
  };
}

test("a refusal with a markdown note commits only the note and merges it directly", async () => {
  const { root, wt } = await initializedWorktree();
  // The refusing run's leftovers: an objection note (md), a half-done tracked edit, and junk.
  fs.appendFileSync(path.join(wt, "PLANS.md"), "\n**Refused:** it would delete user data\n");
  fs.appendFileSync(path.join(wt, "seed.txt"), "bad\n");
  fs.writeFileSync(path.join(wt, "broken.ts"), "export const broken = true;\n");

  const state: RunnerState = { ...freshRunnerState("improve"), runs: 7 };
  const { ctx, merges } = makeCtx(root);
  const outcome = await handleRefusal(ctx, state, wt, refusedPi({ refusedReason: "it would delete user data" }));

  assert.equal(outcome.result, "refused");
  assert.equal(outcome.summary, "it would delete user data");
  assert.ok(outcome.commit, "the note commit is reported");

  // The note commit sits on the branch with the refusal subject and the harness-stamped
  // trailer (merging it to main is the merge wiring's job — recorded above, not faked here)…
  const log = sh(wt, "git", "log", "-1", "--format=%s%n%b");
  assert.match(log, /tumwater\(improve\): refuse — it would delete user data/);
  assert.match(log, /Run: improve #7 · turns 3/);
  // …and nothing else did: the tracked edit was reset and the untracked file cleaned.
  assert.equal(fs.readFileSync(path.join(wt, "seed.txt"), "utf8"), "seed\n", "the code change was discarded");
  assert.ok(!fs.existsSync(path.join(wt, "broken.ts")), "untracked half-work is cleaned");

  // The note commit merges directly — through the runner's shared merge wiring, once.
  assert.equal(merges.length, 1);
  assert.equal(merges[0]!.summary, "refused: it would delete user data");

  const refused = readEvents(root).filter((e) => e.type === "entry_refused");
  assert.equal(refused.length, 1, "the merged note pages once");
  assert.equal(refused[0]!.source, "improve");
  assert.equal(refused[0]!.reason, "it would delete user data");
  assert.ok((refused[0]!.files as string[]).includes("PLANS.md"));
  assert.deepEqual(refused[0]!.entries, [], "a note under no entry names nothing, yet the event fires");
});

test("a refusal with no note resets the worktree and never merges", async () => {
  const { root, wt } = await initializedWorktree();
  fs.writeFileSync(path.join(wt, "broken.ts"), "export const broken = true;\n");

  const state: RunnerState = freshRunnerState("improve");
  const before = mainSha(root);
  const { ctx, merges } = makeCtx(root);
  const outcome = await handleRefusal(ctx, state, wt, refusedPi({ refusedReason: "half-baked" }));

  assert.equal(outcome.result, "refused");
  assert.equal(outcome.summary, "half-baked");
  assert.equal(outcome.commit, undefined, "no commit without a note");
  assert.equal(merges.length, 0, "nothing to merge");
  assert.equal(mainSha(root), before, "main is untouched");
  assert.ok(!fs.existsSync(path.join(wt, "broken.ts")), "the half-work was discarded");
  assertClean(wt, "the worktree is clean after the reset");
  assert.equal(readEvents(root).filter((e) => e.type === "entry_refused").length, 0, "no note merged, no page");
});

test("a bare sentinel falls back to a generic reason", async () => {
  const { root, wt } = await initializedWorktree();
  fs.appendFileSync(path.join(wt, "PLANS.md"), "\n**Refused:** no reason written\n");

  const state: RunnerState = freshRunnerState("improve");
  const { ctx } = makeCtx(root);
  const outcome = await handleRefusal(ctx, state, wt, refusedPi());

  assert.equal(outcome.result, "refused");
  assert.equal(outcome.summary, "no reason given", "a bare sentinel falls back to a generic reason");
  assert.match(sh(wt, "git", "log", "-1", "--format=%s"), /tumwater\(improve\): refuse — no reason given/);
});

test("a refusal contradicted by its own reply keeps its work (BUGS.md 2026-09-23)", async () => {
  // A refusal beside a SUMMARY and non-markdown work discredits itself: the harness must
  // surface it, not discard finished output.
  const { wt } = await initializedWorktree();
  fs.writeFileSync(path.join(wt, "broken.ts"), "export const fixed = true;\n");
  fs.appendFileSync(path.join(wt, "seed.txt"), "tweak\n");

  const contradiction = await refusalContradiction(wt, "did it\nSUMMARY: fixed the leak\nTUMWATER_REFUSED: none needed");
  assert.deepEqual(contradiction.sort(), ["broken.ts", "seed.txt"], "the work files are named");

  // No SUMMARY beside the work: a real objection over half-done scribbling stands — the
  // ordinary refusal path applies.
  assert.deepEqual(await refusalContradiction(wt, "it would delete user data\nTUMWATER_REFUSED: too risky"), []);

  // Work that is md-only: a note is all a refusal should leave, never flagged.
  fs.rmSync(path.join(wt, "broken.ts"));
  fs.writeFileSync(path.join(wt, "seed.txt"), "seed\n"); // revert to clean before the md edit
  fs.appendFileSync(path.join(wt, "PLANS.md"), "\n**Refused:** x\n");
  assert.deepEqual(await refusalContradiction(wt, "SUMMARY: note only"), []);
});

test("refusalContradiction returns empty when the worktree is clean", async () => {
  const { wt } = await initializedWorktree();
  assert.deepEqual(await refusalContradiction(wt, "SUMMARY: nothing changed"), []);
});

test("a failed note merge records lastError and still reports the commit", async () => {
  const { root, wt } = await initializedWorktree();
  fs.appendFileSync(path.join(wt, "PLANS.md"), "\n**Refused:** it would delete user data\n");

  const state: RunnerState = freshRunnerState("improve");
  const { ctx, merges } = makeCtx(root, "merge_conflict");
  const outcome = await handleRefusal(ctx, state, wt, refusedPi({ refusedReason: "it would delete user data" }));

  assert.equal(outcome.result, "refused", "the refusal itself still stands");
  assert.ok(outcome.commit, "the note commit exists on the branch even though it did not merge");
  assert.equal(merges.length, 1);
  assert.equal(state.lastError, "refusal note merge failed: merge_conflict");
  assert.equal(readEvents(root).filter((e) => e.type === "entry_refused").length, 0, "a failed merge pages nothing");
});

// The refusal-note merge bypasses applyMergeOutcome, so it must clear a stale rejection
// itself — otherwise a role whose refused note merged is still told to address an objection
// main has moved past (BUGS.md 2026-10-07). A still-owed revision keeps it, exactly as the
// merge fold does; a failed merge merges nothing and clears nothing.
test("a merged refusal note clears a superseded rejection unless a revision is owed", async () => {
  const { root, wt } = await initializedWorktree();
  fs.appendFileSync(path.join(wt, "PLANS.md"), "\n**Refused:** it would delete user data\n");
  const state: RunnerState = freshRunnerState("improve");
  state.lastReview = { verdict: "reject", reasons: ["old objection"], at: 1 };
  const { ctx } = makeCtx(root);
  await handleRefusal(ctx, state, wt, refusedPi({ refusedReason: "it would delete user data" }));
  assert.equal(state.lastReview, undefined, "the merged note supersedes the rejection");

  const { root: pendingRoot, wt: pendingWt } = await initializedWorktree();
  fs.appendFileSync(path.join(pendingWt, "PLANS.md"), "\n**Refused:** still risky\n");
  const pending: RunnerState = freshRunnerState("improve");
  pending.lastReview = { verdict: "reject", reasons: ["old objection"], at: 1 };
  pending.revision = { sha: "deadbeef", round: 1, at: 2 };
  const { ctx: pendingCtx } = makeCtx(pendingRoot);
  await handleRefusal(pendingCtx, pending, pendingWt, refusedPi({ refusedReason: "still risky" }));
  assert.equal(pending.lastReview?.verdict, "reject", "a pending revision keeps the rejection");

  const { root: failedRoot, wt: failedWt } = await initializedWorktree();
  fs.appendFileSync(path.join(failedWt, "PLANS.md"), "\n**Refused:** no\n");
  const failed: RunnerState = freshRunnerState("improve");
  failed.lastReview = { verdict: "reject", reasons: ["old objection"], at: 1 };
  const { ctx: failedCtx } = makeCtx(failedRoot, "merge_conflict");
  await handleRefusal(failedCtx, failed, failedWt, refusedPi({ refusedReason: "no" }));
  assert.equal(failed.lastReview?.verdict, "reject", "a failed merge clears nothing");
});

const BLOCKED_BASE = (part1Section: "Planned" | "Done"): string => {
  const one = "### S, part 1/2: a (planned 2026-10-12 by plan)\n\nbody\n";
  const two = "### S, part 2/2: b (planned 2026-10-12 by plan; requires part 1/2 landed)\n\nbody\n";
  return part1Section === "Planned"
    ? `# Plans\n\n## Planned\n\n${one}\n${two}\n## Done\n\n_None yet._\n`
    : `# Plans\n\n## Planned\n\n${two}\n## Done\n\n${one}`;
};

const REFUSED_LINE = "**Refused 2026-10-12 by feature: x**";

/** A worktree whose main holds `md` as PLANS.md. */
async function worktreeWithPlans(md: string): Promise<{ root: string; wt: string }> {
  const { root, wt } = await initializedWorktree();
  fs.writeFileSync(path.join(root, "PLANS.md"), md);
  commitIn(root, "plans");
  sh(wt, "git", "reset", "--hard", "main");
  return { root, wt };
}

/** `md` with the Refused line appended under the heading that starts with `heading`. */
function refuseUnder(md: string, heading: string): string {
  return md.replace(new RegExp(`^(${heading}.*)$`, "m"), `$1\n\n${REFUSED_LINE}`);
}

test("a refusal note on a plan still blocked by a planned prerequisite is dropped", async () => {
  const base = BLOCKED_BASE("Planned");
  const { root, wt } = await worktreeWithPlans(base);
  fs.writeFileSync(path.join(wt, "PLANS.md"), refuseUnder(base, "### S, part 2/2"));
  const { ctx, merges } = makeCtx(root);
  const outcome = await handleRefusal(ctx, freshRunnerState("improve"), wt, refusedPi({ refusedReason: "x" }));
  assert.equal(outcome.result, "refused");
  assert.equal(outcome.commit, undefined);
  assert.equal(merges.length, 0);
  assertClean(wt);
  const events = readEvents(root);
  assert.ok(events.some((e) => e.type === "warning" && String(e.message).includes("part 2/2: b")));
  assert.equal(events.filter((e) => e.type === "entry_refused").length, 0);
});

// The dropped-blocked-note path rewrites PLANS.md (and only that path does). The rewrite must
// be atomic and leave no `.tmp-` remnant behind in the worktree: the file is committed to main
// right after, and a leftover temp (or a torn write) would leak into — or silently drop entries
// from — the project's plan record.
test("the dropped-refusal PLANS.md rewrite is atomic and leaves no tmp remnant", async () => {
  const base = BLOCKED_BASE("Planned");
  const { root, wt } = await worktreeWithPlans(base);
  fs.writeFileSync(path.join(wt, "PLANS.md"), refuseUnder(base, "### S, part 2/2"));
  const { ctx } = makeCtx(root);
  await handleRefusal(ctx, freshRunnerState("improve"), wt, refusedPi({ refusedReason: "x" }));
  // The refusal note is gone from the worktree's PLANS.md and the two plan entries survive;
  const plans = fs.readFileSync(path.join(wt, "PLANS.md"), "utf8");
  assert.ok(!plans.includes(REFUSED_LINE), "the blocked refusal note is dropped");
  assert.ok(plans.includes("part 1/2: a"), "the first plan entry survives");
  assert.ok(plans.includes("part 2/2: b"), "the second plan entry survives");
  // …and no atomic-write temp remains to be picked up by the commit scan.
  const leftovers = fs.readdirSync(path.join(wt, ".")).filter((f) => f.includes("PLANS.md.tmp"));
  assert.deepEqual(leftovers, [], "no tmp remnant survives the atomic rewrite");
});

test("a refusal note on a plan whose prerequisite is Done merges as usual", async () => {
  const base = BLOCKED_BASE("Done");
  const { root, wt } = await worktreeWithPlans(base);
  fs.writeFileSync(path.join(wt, "PLANS.md"), refuseUnder(base, "### S, part 2/2"));
  const { ctx, merges } = makeCtx(root);
  const outcome = await handleRefusal(ctx, freshRunnerState("improve"), wt, refusedPi({ refusedReason: "x" }));
  assert.ok(outcome.commit);
  assert.equal(merges.length, 1);
  const refused = readEvents(root).filter((e) => e.type === "entry_refused");
  assert.equal(refused.length, 1);
  assert.deepEqual(refused[0]!.entries, ["S, part 2/2: b"]);
});

test("only the blocked plan's note is dropped when an eligible entry is refused too", async () => {
  const base = BLOCKED_BASE("Planned").replace("## Done", "### E: eligible (planned 2026-10-12 by plan)\n\nbody\n\n## Done");
  const { root, wt } = await worktreeWithPlans(base);
  fs.writeFileSync(
    path.join(wt, "PLANS.md"),
    refuseUnder(refuseUnder(base, "### S, part 2/2"), "### E: eligible"),
  );
  const { ctx, merges } = makeCtx(root);
  const outcome = await handleRefusal(ctx, freshRunnerState("improve"), wt, refusedPi({ refusedReason: "x" }));
  assert.ok(outcome.commit);
  assert.equal(merges.length, 1);
  const plans = fs.readFileSync(path.join(wt, "PLANS.md"), "utf8");
  assert.equal(plans.split(REFUSED_LINE).length - 1, 1);
  assert.ok(plans.indexOf(REFUSED_LINE) > plans.indexOf("### E: eligible"));
  const refused = readEvents(root).filter((e) => e.type === "entry_refused");
  assert.deepEqual(refused[0]!.entries, ["E: eligible"], "the dropped blocked plan is not named");
});

test("one run refusing a plan and a bug names both, plan first", async () => {
  const plans = "# Plans\n\n## Planned\n\n### P: plan (planned 2026-10-12 by plan)\n\nbody\n\n## Done\n\n_None yet._\n";
  const bugs = "# Bugs\n\n## Open\n\n### B: bug (found by test 2026-10-12)\n\nbody\n\n## Fixed\n\n_None yet._\n";
  const { root, wt } = await initializedWorktree();
  fs.writeFileSync(path.join(root, "PLANS.md"), plans);
  fs.writeFileSync(path.join(root, "BUGS.md"), bugs);
  commitIn(root, "backlog");
  sh(wt, "git", "reset", "--hard", "main");
  fs.writeFileSync(path.join(wt, "PLANS.md"), refuseUnder(plans, "### P: plan"));
  fs.writeFileSync(path.join(wt, "BUGS.md"), refuseUnder(bugs, "### B: bug"));
  const { ctx } = makeCtx(root);
  await handleRefusal(ctx, freshRunnerState("improve"), wt, refusedPi({ refusedReason: "x" }));
  const refused = readEvents(root).filter((e) => e.type === "entry_refused");
  assert.deepEqual(refused[0]!.entries, ["P: plan", "B: bug"]);
});

test("newlyRefusedTitles names only entries whose Refused note is new in the section", () => {
  const base = "## Planned\n\n### A (planned 2026-10-12 by plan)\n\nx\n\n### B (planned 2026-10-12 by plan)\n\n" + REFUSED_LINE + "\n\n## Done\n\n### D (planned 2026-10-12 by plan)\n\nx\n";
  const head = refuseUnder(base, "### A").replace("### D (planned 2026-10-12 by plan)\n\nx", "### D (planned 2026-10-12 by plan)\n\n" + REFUSED_LINE);
  assert.deepEqual(newlyRefusedTitles(base, head, "Planned"), ["A"], "stamp stripped; already-refused B and Done D skipped");
  const added = base.replace("## Done", "### N (planned 2026-10-12 by plan)\n\n" + REFUSED_LINE + "\n\n## Done");
  assert.deepEqual(newlyRefusedTitles(base, added, "Planned"), ["N"], "a new entry carrying a note counts");
  const fenced = "## Planned\n\n### F (planned 2026-10-12 by plan)\n\n```\n### Fake\n" + REFUSED_LINE + "\n```\n\n## Done\n";
  assert.ok(!newlyRefusedTitles("## Planned\n\n## Done\n", fenced, "Planned").includes("Fake"), "a fenced ### line is not an entry");
});

test("withoutBlockedPlanRefusals leaves unchanged, already-noted, and tidy cases right", () => {
  const base = BLOCKED_BASE("Planned");
  assert.deepEqual(withoutBlockedPlanRefusals(base, base), { md: base, dropped: [] });
  const noted = refuseUnder(base, "### S, part 2/2");
  assert.deepEqual(withoutBlockedPlanRefusals(noted, noted), { md: noted, dropped: [] });
  const res = withoutBlockedPlanRefusals(base, noted);
  assert.deepEqual(res.dropped, ["S, part 2/2: b (planned 2026-10-12 by plan; requires part 1/2 landed)"]);
  assert.equal(res.md, base);
});

test("a refusal note commit carries the Model line", async () => {
  const { root, wt } = await initializedWorktree();
  fs.appendFileSync(path.join(wt, "PLANS.md"), "\n**Refused:** not worth it\n");
  const { ctx } = makeCtx(root);
  ctx.modelLine = "Model: default · backend pi";
  await handleRefusal(ctx, freshRunnerState("improve"), wt, refusedPi({ refusedReason: "not worth it" }));

  const lines = sh(wt, "git", "log", "-1", "--format=%B").trimEnd().split("\n");
  assert.match(lines[lines.length - 2]!, /^Run: improve #/);
  assert.equal(lines[lines.length - 1], "Model: default · backend pi");
});
