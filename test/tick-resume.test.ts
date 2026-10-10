import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { planTickStart } from "../src/tick/tick-resume.js";
import { PendingPrompt } from "../src/inbox/pending-prompt.js";
import { enqueueRolePrompt, queuedRolePrompts } from "../src/inbox/inbox.js";
import { freshLoopState, type LoopState } from "../src/loop/loop-state.js";
import { sessionDir } from "../src/paths.js";
import { readSessions, recordSession } from "../src/agent/session-ledger.js";
import { registerAgentBackend } from "../src/agent/agent-backend.js";
import { runAgent } from "../src/agent/run-agent.js";
import { resolveTickVerdict } from "../src/tick/tick-verdict.js";
import { defaultConfig } from "../src/config/config.js";
import { piBackend } from "../src/pi/pi-backend.js";
import { claudeBackend, claudeTranscriptPath } from "../src/agent/claude/claude-backend.js";
import { initializedWorktree, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakeClaudeReplay } from "./fakes/fake-claude.js";
import { claudeInit, claudeResult } from "./fixtures/claude-events.js";
import { setEnv } from "./helpers/env.js";

// The resume guard dispatches to the registered backend, so this process must register the two
// real adapters exactly as src/agent/run-agent.ts does when the harness loads.
registerAgentBackend(piBackend);
registerAgentBackend(claudeBackend);

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

/** Record one claude author run and plant the transcript its resume check reads, under the
 * caller's temp HOME. A claude resume is id-based, so no pi session file is needed. */
function withClaudeAuthor(root: string, cwd: string, id = "c1"): void {
  recordSession(sessionDir(root, "feature"), {
    agent: "claude",
    id,
    kind: "author",
    name: "n",
    cwd,
    at: Date.now(),
  });
  const transcript = claudeTranscriptPath(cwd, id);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "");
}

function plan(
  root: string,
  s: LoopState,
  opts: { tickPrompt?: () => string | null; pending?: PendingPrompt; agent?: string } = {},
) {
  return planTickStart({
    root,
    role: s.role,
    state: s,
    pending: opts.pending ?? new PendingPrompt(root, s.role),
    tickPrompt: opts.tickPrompt ?? (() => "assembled tick prompt"),
    agent: opts.agent,
  });
}

test("a fresh tick takes the assembled prompt and derives the restart cause", () => {
  const dir = tmpdir();
  const s = state();
  const p = plan(dir, s);
  assert.ok(p);
  assert.equal(p.resuming, false);
  assert.equal(p.handoff, false);
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
  assert.equal(p.handoff, false, "a review-phase flag never hands off either");
  assert.equal(p.prompt, "assembled tick prompt");
  assert.equal(s.resumePending, false);
});

test("a resume whose newest author line names another agent hands off with the bridge", () => {
  const dir = tmpdir();
  const s = state({ resumePending: true });
  withSession(dir, "feature");
  recordSession(sessionDir(dir, "feature"), {
    agent: "claude",
    id: "c",
    kind: "author",
    name: "n",
    cwd: "/wt",
    at: Date.now(),
  });
  const p = plan(dir, s);
  assert.ok(p);
  assert.equal(p.resuming, false, "a cross-agent resume must not --continue another agent's session");
  assert.equal(p.handoff, true);
  assert.equal(p.resumeCause, "handoff");
  assert.match(p.prompt, /assembled tick prompt/, "the handoff carries the assembled tick prompt");
  assert.match(p.prompt, /uncommitted edits are in your worktree/);
  assert.equal(s.resumePending, false);
});

test("a newer gate session in the author dir hands off instead of resuming the resolver", () => {
  const dir = tmpdir();
  const s = state({ resumePending: true });
  withSession(dir, "feature");
  const base = { id: "i", name: "n", cwd: "/wt", at: 0 };
  recordSession(sessionDir(dir, "feature"), { agent: "pi", kind: "author", ...base, at: 1000 });
  recordSession(sessionDir(dir, "feature"), { agent: "pi", kind: "gate", ...base, at: 2000 });
  const p = plan(dir, s);
  assert.ok(p);
  assert.equal(p.resuming, false, "the newest file is the resolver's, so a continue would reach it");
  assert.equal(p.handoff, true);
  assert.match(p.prompt, /uncommitted edits are in your worktree/);
});

test("a claude author resumes its recorded session when the transcript exists", () => {
  const root = tmpdir();
  const cwd = fs.realpathSync(root);
  const restoreHome = setEnv("HOME", tmpdir());
  try {
    const s = state({ resumePending: true });
    withClaudeAuthor(root, cwd);
    const p = plan(root, s, { agent: "claude" });
    assert.ok(p);
    assert.equal(p.resuming, true, "a claude ledger id with a transcript resumes");
    assert.equal(p.handoff, false);
    assert.equal(p.resumeCause, "restart");
    assert.equal(s.resumePending, false);
  } finally {
    restoreHome();
  }
});

test("a claude author resumes its id even when a newer gate line shares the dir", () => {
  const root = tmpdir();
  const cwd = fs.realpathSync(root);
  const restoreHome = setEnv("HOME", tmpdir());
  try {
    const s = state({ resumePending: true });
    withClaudeAuthor(root, cwd);
    // claude resumes by id, not by newest file, so a newer gate run does not shadow it
    // (unlike pi's --continue).
    recordSession(sessionDir(root, "feature"), {
      agent: "claude",
      id: "g1",
      kind: "gate",
      name: "n",
      cwd,
      at: Date.now() + 1,
    });
    const p = plan(root, s, { agent: "claude" });
    assert.ok(p);
    assert.equal(p.resuming, true);
    assert.equal(p.handoff, false);
  } finally {
    restoreHome();
  }
});

// plans/agent-backends.md "Sessions", PLANS.md part 3d: a `--resume` whose id no longer has
// a transcript fails with `resumeMissing`; the verdict keeps the worktree and arms
// `resumePending`, so the next tick sees our own author line as unresumable. That is a
// handoff, not a reset: the interrupted edits survive into a FRESH session that carries the
// assembled tick prompt plus the bridge.
test("a claude author whose transcript is gone handoffs over the kept worktree", () => {
  const root = tmpdir();
  const restoreHome = setEnv("HOME", tmpdir());
  try {
    const s = state({ resumePending: true });
    recordSession(sessionDir(root, "feature"), {
      agent: "claude",
      id: "gone",
      kind: "author",
      name: "n",
      cwd: root,
      at: Date.now(),
    });
    const p = plan(root, s, { agent: "claude" });
    assert.ok(p);
    assert.equal(p.resuming, false, "there is no session left to continue");
    assert.equal(p.handoff, true, "the interrupted edits deserve a handoff, not a reset");
    assert.equal(p.resumeCause, "handoff");
    assert.match(p.prompt, /assembled tick prompt/, "the handoff carries the assembled task");
    assert.match(p.prompt, /uncommitted edits are in your worktree/);
  } finally {
    restoreHome();
  }
});

// PLANS.md part 3d: the resume-missing run itself, not just the hand-constructed state. A
// real fake-claude `--resume` run that answers "No conversation found" yields
// `resumeMissing`; fed through resolveTickVerdict against a dirty worktree, the failed turn
// must arm `resumePending`; the next tick then hands off over the kept worktree instead of
// resetting it. This is the verdict half the part-3d acceptance criterion calls out.
test("a fake-claude resumeMissing run arms resumePending, and the next tick hands off", async () => {
  const { root, wt } = await initializedWorktree("feature");
  const cwd = fs.realpathSync(wt);
  const logs = tmpdir();
  const restoreHome = setEnv("HOME", tmpdir());
  const fake = fakeClaudeReplay([
    claudeInit({ sessionId: "gone" }),
    claudeResult({ isError: true, text: "No conversation found with session ID gone" }),
  ]);
  try {
    // A recorded claude author lets the run resume by id; the fake replays the "no
    // conversation" error a pruned transcript would produce.
    withClaudeAuthor(root, cwd, "c1");
    const run = await runAgent({
      cwd,
      prompt: "p",
      config: { ...defaultConfig(), agent: "claude", model: "claude-sonnet-5-5" },
      sessionDir: sessionDir(root, "feature"),
      sessionName: "t",
      rawLogFile: path.join(logs, "raw.jsonl"),
      nativeLogFile: path.join(logs, "native.jsonl"),
      kind: "author",
      continueSession: true,
    });
    assert.equal(run.resumeMissing, true, "the translator parsed the resume-missing result");
    assert.equal(run.ok, false);
    assert.equal(run.producedAssistantContent, false, "the error turn carries no content");

    // The interrupted tick's edits are on disk, so the verdict keeps the worktree.
    fs.writeFileSync(path.join(wt, "wip.txt"), "half-done\n");
    const s = freshLoopState("feature");
    const outcome = await resolveTickVerdict({
      root,
      wt,
      role: "feature",
      mainBranch: "main",
      state: s,
      pending: new PendingPrompt(root, "feature"),
      turns: 1,
      userPrompt: null,
      pi: run,
      flow: null,
      warn: () => {},
      merge: async () => "changed" as const,
      finishAbortedTick: async () => ({ result: "aborted" as const }),
    });
    assert.equal(outcome?.result, "error", "a failed run with no content is an error outcome");
    assert.equal(s.resumePending, true, "the failed dirty resume armed the next resume");

    // The transcript is gone (the resume-missing cause), so the next tick cannot continue it:
    // it fresh-starts over the kept worktree with the handoff bridge.
    const recorded = readSessions(sessionDir(root, "feature")).at(-1)!;
    fs.rmSync(claudeTranscriptPath(cwd, recorded.id));
    const p = plan(root, s, { agent: "claude" });
    assert.ok(p);
    assert.equal(p.resuming, false, "the lost session is not resumable");
    assert.equal(p.handoff, true, "the kept worktree is handed off, not reset");
    assert.equal(p.resumeCause, "handoff");
    assert.match(p.prompt, /uncommitted edits are in your worktree/);
  } finally {
    fake.restore();
    restoreHome();
  }
});

test("a claude resume whose only ledger line names another agent hands off", () => {
  const root = tmpdir();
  const restoreHome = setEnv("HOME", tmpdir());
  try {
    const s = state({ resumePending: true });
    recordSession(sessionDir(root, "feature"), {
      agent: "pi",
      id: "p1",
      kind: "author",
      name: "n",
      cwd: root,
      at: Date.now(),
    });
    const p = plan(root, s, { agent: "claude" });
    assert.ok(p);
    assert.equal(p.resuming, false);
    assert.equal(p.handoff, true, "another agent's session is not claude's to resume");
    assert.match(p.prompt, /uncommitted edits are in your worktree/);
  } finally {
    restoreHome();
  }
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
