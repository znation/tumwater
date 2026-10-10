import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { planTickStart } from "../src/tick/tick-resume.js";
import { PendingPrompt } from "../src/inbox/pending-prompt.js";
import { enqueueRolePrompt, queuedRolePrompts } from "../src/inbox/inbox.js";
import { freshLoopState, type LoopState } from "../src/loop/loop-state.js";
import { sessionDir } from "../src/paths.js";
import { recordSession } from "../src/agent/session-ledger.js";
import { registerAgentBackend } from "../src/agent/agent-backend.js";
import { runAgent } from "../src/agent/run-agent.js";
import { resolveTickVerdict } from "../src/tick/tick-verdict.js";
import { applyTickOutcome } from "../src/tick/tick-apply.js";
import { slotPinnedForResume } from "../src/loop/loop-tick.js";
import { defaultConfig } from "../src/config/config.js";
import { fallbackRoleConfig } from "../src/config/config-views.js";
import { piBackend } from "../src/pi/pi-backend.js";
import { claudeBackend, claudeTranscriptPath } from "../src/agent/claude/claude-backend.js";
import { initializedWorktree, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakeClaudeReplay } from "./fakes/fake-claude.js";
import { piRunResult } from "./fakes/fake-pi.js";
import { claudeAssistant, claudeInit, claudeRateLimit, claudeResult, claudeToolUse } from "./fixtures/claude-events.js";
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
  opts: { tickPrompt?: (agent?: string) => string | null; pending?: PendingPrompt; agent?: string } = {},
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

test("a fresh tick hands the effective agent to the prompt assembly", () => {
  // plans/agent-backends.md, part 5/7: the tick's prompt dialect must match the backend the
  // run actually uses. planTickStart receives the effective `cfg.agent` (the model-fallback
  // pair while an episode is active) and passes it to the fresh-tick assembly; deriving the
  // dialect from the role's primary instead would speak claude's MCP dialect to a pi run.
  const dir = tmpdir();
  const s = state();
  let seen: string | undefined = "unset";
  const p = plan(dir, s, {
    agent: "claude",
    tickPrompt: (agent) => {
      seen = agent;
      return "assembled";
    },
  });
  assert.ok(p);
  assert.equal(seen, "claude", "the effective agent reaches the fresh prompt assembly");
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

// PLANS.md part 4d/7 ("Mixed seams"): the resolver is routed to another agent, so its ledger
// line is claude's while the author stays pi. pi's --continue reaches the newest FILE whichever
// agent wrote it, so the author's own-agent resume must still hand off.
test("a gate ledger line from another agent hands off the author's own-agent resume", () => {
  const dir = tmpdir();
  const s = state({ resumePending: true });
  withSession(dir, "feature");
  const base = { id: "i", name: "n", cwd: "/wt", at: 0 };
  recordSession(sessionDir(dir, "feature"), { agent: "pi", kind: "author", ...base, at: 1000 });
  recordSession(sessionDir(dir, "feature"), { agent: "claude", kind: "gate", ...base, at: 2000 });
  const p = plan(dir, s);
  assert.ok(p);
  assert.equal(p.resuming, false, "the claude resolver's file is newest, so a pi continue would reach it");
  assert.equal(p.handoff, true);
  assert.equal(p.resumeCause, "handoff");
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

    // The resume-missing verdict, not the filesystem, is what makes the session
    // gone — a transcript lingering under claude's project dir must not re-arm a
    // resume the backend just rejected. The transcript the fake planted (and the
    // resume run refreshed) is still present, yet the next tick must hand off.
    assert.ok(fs.existsSync(claudeTranscriptPath(cwd, "c1")), "the transcript lingers");
    const p = plan(root, s, { agent: "claude" });
    assert.ok(p);
    assert.equal(p.resuming, false, "a resumeMissing session is not resumable");
    assert.equal(p.handoff, true, "the kept worktree is handed off, not reset");
    assert.equal(p.resumeCause, "handoff");
    assert.match(p.prompt, /uncommitted edits are in your worktree/);
  } finally {
    fake.restore();
    restoreHome();
  }
});

// BUGS.md 2026-10-09: the resume-missing verdict must be remembered on every path that arms
// the next resume, not just the failed-dirty one. An aborted (shutdown) run keeps the session
// and worktree and resumes; when that run had already answered "No conversation found", the
// record must survive so the next tick hands off instead of re-resuming a dead session whose
// transcript file still exists.
test("an aborted resumeMissing run records the missing session for the next tick's handoff", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  const restoreHome = setEnv("HOME", tmpdir());
  try {
    withClaudeAuthor(root, fs.realpathSync(wt), "c1");
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
      pi: piRunResult({ aborted: true, ok: false, resumeMissing: true, errorMessage: "aborted" }),
      flow: null,
      warn: () => {},
      merge: async () => "changed" as const,
      finishAbortedTick: async () => ({ result: "aborted" as const }),
    });
    assert.equal(outcome?.result, "aborted");
    assert.equal(s.resumeMissing, true, "the killed run's missing-session verdict is remembered");
    // applyTickOutcome arms the resume for an aborted tick (tick-apply.ts); the next tick must
    // hand off over the kept worktree rather than re-resume the session claude just rejected.
    s.resumePending = true;
    assert.ok(fs.existsSync(claudeTranscriptPath(fs.realpathSync(wt), "c1")), "the transcript lingers");
    const p = plan(root, s, { agent: "claude" });
    assert.ok(p);
    assert.equal(p.resuming, false, "a resumeMissing session is not resumable");
    assert.equal(p.handoff, true, "the kept worktree is handed off, not reset");
  } finally {
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

// PLANS.md part 4d/7 ("Selectors"): the resume check and the spawn must read the same
// `cfg.agent`. While a model-fallback episode is active the resolved view is the fallback pair,
// so a claude primary whose tier falls back to a pi pair runs — and resumes — as pi: the
// interrupted claude session is not pi's to continue, so the next tick hands off.
test("the fallback view's routed agent drives the resume check", () => {
  const root = tmpdir();
  const restoreHome = setEnv("HOME", tmpdir());
  try {
    const s = state({ resumePending: true });
    withSession(root, "feature"); // a pi session file exists, so only the agent can refuse it
    withClaudeAuthor(root, fs.realpathSync(root));
    // The role's tier falls back to a pi pair; under a claude primary the fallback view still
    // routes to pi (a pi provider name survives in a pi-routed view).
    const config = { ...defaultConfig(), agent: "claude", fallback: "omlx/Qwen" };
    const fb = fallbackRoleConfig(config, "feature");
    assert.equal(fb?.agent, "pi", "a pi fallback pair routes to pi under a claude primary");
    const p = plan(root, s, { agent: fb?.agent });
    assert.ok(p);
    assert.equal(p.resuming, false, "the pi fallback cannot --continue a claude session");
    assert.equal(p.handoff, true);
    assert.equal(p.resumeCause, "handoff");
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

// PLANS.md part 6e/7: a subscription claude run cut off by a rejected usage window keeps its
// session and worktree edits and resumes after the window resets, instead of committing partial
// work or taking a fresh tick that resets the worktree. The rejected-window reading (not a bare
// 429) is the signal, so a pi 429 keeps the existing within-run retry.
test("a subscription claude rejected-window run resumes over the kept worktree once the window resets", async () => {
  const { root, wt } = await initializedWorktree("feature");
  const cwd = fs.realpathSync(wt);
  const logs = tmpdir();
  const restoreHome = setEnv("HOME", tmpdir());
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const fake = fakeClaudeReplay([
    claudeInit({ sessionId: "c1", apiKeySource: "none" }),
    claudeAssistant({ blocks: [claudeToolUse("t1", "Edit", { file_path: "wip.txt" })], stopReason: "tool_use" }),
    claudeRateLimit({ type: "five_hour", status: "rejected", resetsAt }),
    claudeResult({ isError: true, apiErrorStatus: 429, text: "Claude usage limit reached" }),
  ]);
  try {
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
    assert.equal(run.billing, "subscription");
    assert.equal(run.transientRateLimit, true, "a rejected window is a transient rate limit");
    assert.equal(run.ok, false);

    // The interrupted run's half-done edits are on disk and must survive the hold.
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
    assert.equal(outcome?.result, "error", "the window rejection is a hold, not a landing");
    // The lease release evaluates the pin condition right after the verdict, before
    // applyTickOutcome runs; if the arm has not armed resumePending by then the slot is
    // detached and the half-done edits are lost.
    assert.equal(s.resumePending, true, "the verdict arms the resume before the lease pins the slot");
    assert.equal(
      slotPinnedForResume(s, outcome),
      true,
      "the lease keeps the slot pinned across the hold",
    );
    applyTickOutcome(s, defaultConfig(), "feature", outcome!);
    assert.equal(s.resumePending, true, "the next eligible tick resumes the session");
    assert.equal(s.resumeCause, "rate-limit", "the resume names the held window");
    assert.equal(fs.readFileSync(path.join(wt, "wip.txt"), "utf8"), "half-done\n", "the edits survive");

    // After the hold lifts (resetsAt passes), the same claude session resumes — not a fresh
    // tick, and not a handoff, since the agent never changed.
    const p = plan(root, s, { agent: "claude" });
    assert.ok(p);
    assert.equal(p.resuming, true, "the same claude session resumes");
    assert.equal(p.handoff, false);
    assert.equal(p.resumeCause, "rate-limit");
    assert.match(p.prompt, /usage window/);
  } finally {
    fake.restore();
    restoreHome();
  }
});
