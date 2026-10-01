import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { planTickStart } from "../src/tick-resume.js";
import { PendingPrompt } from "../src/pending-prompt.js";
import { enqueueRolePrompt, queuedRolePrompts } from "../src/inbox.js";
import type { LoopState } from "../src/loop-state.js";
import { sessionDir } from "../src/paths.js";
import { tmpdir } from "./repo-fixtures.js";

// tick-resume.ts owns planTickStart — the decision every tick starts with: whether it resumes
// the interrupted session (and under which cause), what prompt it runs, and which side effects
// (flag consumption, lastError capture, prompt reclaim) happen even on the paths that skip the
// work. loop.ts consumes the plan verbatim, so a wrong decision here misroutes whole ticks.
// These tests pin the decision table directly, against a real session dir and a real prompt
// queue, the way pending-prompt.test.ts pins the requeue policy.

function state(overrides: Partial<LoopState> = {}): LoopState {
  return { role: "feature", phase: "pi", ...overrides } as unknown as LoopState;
}

/** Plant one pi session file in the role's session dir, so hasResumableSession finds it. */
function withSession(root: string, role: string): void {
  const dir = sessionDir(root, role);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "session-abc.jsonl"), "{}\n");
}

function plan(
  root: string,
  s: LoopState,
  opts: { tickPrompt?: () => string | null; pending?: PendingPrompt } = {},
) {
  return planTickStart({
    root,
    role: s.role,
    state: s,
    pending: opts.pending ?? new PendingPrompt(root, s.role),
    tickPrompt: opts.tickPrompt ?? (() => "assembled tick prompt"),
  });
}

test("a fresh tick takes the assembled prompt and derives the restart cause", () => {
  const dir = tmpdir();
  const s = state();
  const p = plan(dir, s);
  assert.ok(p);
  assert.equal(p.resuming, false);
  assert.equal(p.resumeCause, "restart");
  assert.equal(p.prompt, "assembled tick prompt");
  assert.equal(p.userPrompt, null);
  assert.equal(p.priorLandingFailure, undefined);
  // The flags are consumed even on the fresh path, so a stale record never survives.
  assert.equal(s.resumePending, false);
  assert.equal(s.resumeCause, undefined);
  assert.equal(s.lastError, undefined);
});

test("a resumable session resumes with the restart bridge and skips the assembled prompt", () => {
  const dir = tmpdir();
  const s = state({ resumePending: true });
  withSession(dir, "feature");
  let assembled = false;
  const p = plan(dir, s, { tickPrompt: () => { assembled = true; return "assembled"; } });
  assert.ok(p);
  assert.equal(assembled, false, "a resume must not assemble a fresh prompt");
  assert.equal(p.resuming, true);
  assert.equal(p.resumeCause, "restart");
  assert.match(p.prompt, /the "feature" loop/);
  assert.match(p.prompt, /was restarted/);
  // Consumed: the next tick must not resume again unless another shutdown sets the flag.
  assert.equal(s.resumePending, false);
  assert.equal(s.resumeCause, undefined);
});

test("a cut-off streak derives the cut-off bridge", () => {
  const dir = tmpdir();
  const s = state({ resumePending: true, cutOffStreak: 2 });
  withSession(dir, "feature");
  const p = plan(dir, s);
  assert.ok(p);
  assert.equal(p.resumeCause, "cut-off");
  assert.match(p.prompt, /ran out of context/);
});

test("a named resumeCause wins over the derived one and reaches the bridge", () => {
  const dir = tmpdir();
  const s = state({ resumePending: true, resumeCause: "hung-tool" });
  withSession(dir, "feature");
  const p = plan(dir, s);
  assert.ok(p);
  assert.equal(p.resumeCause, "hung-tool");
  assert.match(p.prompt, /do not re-run it unchanged/);
});

test("a review-phase interruption never resumes — the author's work is already committed", () => {
  const dir = tmpdir();
  const s = state({ resumePending: true, phase: "review" });
  withSession(dir, "feature");
  const p = plan(dir, s);
  assert.ok(p);
  assert.equal(p.resuming, false, "a review-phase flag must fall back to a fresh tick");
  assert.equal(p.prompt, "assembled tick prompt");
  assert.equal(s.resumePending, false);
});

test("resumePending without a session file falls back to a fresh tick", () => {
  const dir = tmpdir();
  const s = state({ resumePending: true });
  const p = plan(dir, s);
  assert.ok(p);
  assert.equal(p.resuming, false);
  assert.equal(p.prompt, "assembled tick prompt");
  assert.equal(s.resumePending, false);
});

test("a retriable landing failure feeds the error streak; other lastResults do not", () => {
  const dir = tmpdir();
  const s = state({ lastResult: "merge_conflict", lastError: "conflict in src/x.ts" });
  const p = plan(dir, s);
  assert.ok(p);
  assert.equal(p.priorLandingFailure, "conflict in src/x.ts");
  assert.equal(s.lastError, undefined, "lastError must be cleared once captured");

  const noDetail = state({ lastResult: "review_error" });
  assert.equal(plan(dir, noDetail)?.priorLandingFailure, "landing failed: review_error");

  const landed = state({ lastResult: "changed", lastError: "stale" });
  assert.equal(plan(dir, landed)?.priorLandingFailure, undefined);
  assert.equal(landed.lastError, undefined);
});

test("a null assembled prompt skips the tick — but the flags are still consumed", () => {
  const dir = tmpdir();
  const s = state({ resumePending: true, resumeCause: "hung-tool" });
  const p = plan(dir, s, { tickPrompt: () => null });
  assert.equal(p, null);
  assert.equal(s.resumePending, false);
  assert.equal(s.resumeCause, undefined);
});

test("a resume reclaims its re-queued prompt; a fresh tick clears the stale record", () => {
  const dir = tmpdir();
  const resumeState = state({ resumePending: true });
  const pending = new PendingPrompt(dir, "feature");
  pending.requeueForResume(resumeState, "retry the task");
  const file = resumeState.resumePromptFile;
  assert.ok(file, "a role-loop requeue-for-resume must record the queue file");
  withSession(dir, "feature");

  const p = plan(dir, resumeState, { pending });
  assert.ok(p);
  assert.equal(p.resuming, true);
  assert.equal(p.userPrompt, "retry the task", "the resumed tick must own the reclaimed request");
  assert.equal(pending.get(), "retry the task");
  assert.equal(resumeState.resumePromptFile, undefined, "the reclaim record is consumed");
  assert.deepEqual(queuedRolePrompts(dir, "feature"), [], "the reclaim takes the exact file");

  // A fresh fallback clears the stale record without consuming the queue: the prompt stays
  // queued for the fresh tick's ordinary dequeue instead of vanishing with the record.
  const freshState = state({ resumePromptFile: file });
  const freshPending = new PendingPrompt(dir, "feature");
  enqueueRolePrompt(dir, "feature", "still queued");
  const fresh = plan(dir, freshState, { pending: freshPending });
  assert.ok(fresh);
  assert.equal(fresh.resuming, false);
  assert.equal(freshState.resumePromptFile, undefined);
  assert.deepEqual(queuedRolePrompts(dir, "feature"), ["still queued"]);
  assert.equal(freshPending.get(), null);
});
