import test from "node:test";
import { writePiListedModels } from "../src/pi/pi-listed-models.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveRunVerdict } from "../src/run/run-verdict.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { PendingPrompt } from "../src/inbox/pending-prompt.js";
import { freshRunnerState, type RunnerState } from "../src/runner/runner-state.js";
import { loadConfig } from "../src/config/config.js";
import { configRequestPath, qaCoveragePath, feedbackFilingsPath, ciParityPath } from "../src/paths.js";
import { readQaCoverage } from "../src/run/qa-coverage.js";
import { readCiParity } from "../src/run/ci-parity.js";
import { readFeedbackFilings } from "../src/run/feedback-filings.js";
import { failRenameSyncOn } from "./helpers/fs-faults.js";
import { writeConfig } from "./fixtures/repo-fixtures.js";
import type { PiRunResult } from "../src/pi/pi-run-result.js";
import { piRunResult } from "./fakes/fake-pi.js";
import { initializedWorktree } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

/** A RunVerdictContext for a finished, uneventful run: pi declared nothing-to-do on a clean
 * worktree, so the normal classification is a fulfilled no_change. Tests override only what
 * they exercise. resolveRunVerdict's context interface is module-private, so this is an
 * untyped builder mirroring the real shape. */
function makeCtx(root: string, wt: string, role: string, over: Record<string, unknown> = {}) {
  const warns: string[] = [];
  const merges: Array<{ wt: string; summary: string }> = [];
  const state: RunnerState = freshRunnerState(role);
  const pending = new PendingPrompt(root, role);
  const ctx = {
    root,
    wt,
    role,
    mainBranch: "main",
    state,
    pending,
    turns: 1,
    userPrompt: null,
    pi: piRunResult({ nothingToDo: true }),
    flow: null,
    filed: null,
    ci: null,
    warn: (m: string) => warns.push(m),
    merge: async (w: string, summary: string) => {
      merges.push({ wt: w, summary });
      return "changed" as const;
    },
    finishAbortedRun: async () => ({ result: "aborted" as const }),
    ...over,
  };
  return { ctx, warns, merges, state, pending };
}

// resolveRunVerdict's config-request block: the director's worktree request is consumed
// before every staging path; every other role's is left untouched. Each test puts a REAL
// request file on disk (or proves the absence of one matters), so removing the
// role === DIRECTOR_ROLE guard fails the stray-file test — the guard itself is exercised,
// not just the happy path around it.

test("the director's config request is applied to the live config and deleted", async () => {
  const { root, wt } = await initializedWorktree(DIRECTOR_ROLE);
  fs.writeFileSync(
    configRequestPath(wt),
    JSON.stringify({ customRoles: [{ name: "docs", task: "Keep the examples current." }] }),
  );

  const { ctx, warns } = makeCtx(root, wt, DIRECTOR_ROLE);
  const outcome = await resolveRunVerdict(ctx);

  // The request was applied: the custom role is live in the root config.
  assert.deepEqual(loadConfig(root).customRoles.map((c) => c.name), ["docs"]);
  // The request file is gone — it can never enter a diff or a review prompt.
  assert.ok(!fs.existsSync(configRequestPath(wt)));
  // A clean application is silent; only rejection paths warn.
  assert.deepEqual(warns, []);
  // The verdict classification itself is unaffected by the consumption.
  assert.equal(outcome?.result, "no_change");
});

test("a malformed config request is rejected with a warning and still deleted", async () => {
  const { root, wt } = await initializedWorktree(DIRECTOR_ROLE);
  const before = loadConfig(root).customRoles;
  fs.writeFileSync(configRequestPath(wt), JSON.stringify({ customRoles: "not an array" }));

  const { ctx, warns } = makeCtx(root, wt, DIRECTOR_ROLE);
  await resolveRunVerdict(ctx);

  assert.equal(warns.length, 1, "exactly one warning event");
  assert.match(warns[0]!, /config request rejected: /);
  assert.ok(!fs.existsSync(configRequestPath(wt)), "the rejected request is deleted too");
  assert.deepEqual(loadConfig(root).customRoles, before, "a rejected request changes nothing");
});

test("a feature worktree's config request is applied too", async () => {
  // An instanced feature runner (`feature-8`), not the bare id: the gate is
  // ctx.role === DIRECTOR_ROLE || baseRoleOf(ctx.role) === "feature", and only an instanced
  // id exercises the baseRoleOf arm — reverting that fix to a bare-id comparison fails here.
  const { root, wt } = await initializedWorktree("feature-8");
  fs.writeFileSync(
    configRequestPath(wt),
    JSON.stringify({ customRoles: [{ name: "docs", task: "Keep the examples current." }] }),
  );

  const { ctx, warns } = makeCtx(root, wt, "feature-8");
  const outcome = await resolveRunVerdict(ctx);

  // The feature role is a consumer of the request file too (part 1/2: it declares check.command).
  assert.deepEqual(loadConfig(root).customRoles.map((c) => c.name), ["docs"]);
  assert.ok(!fs.existsSync(configRequestPath(wt)));
  assert.deepEqual(warns, []);
  assert.equal(outcome?.result, "no_change");
});

test("a rejected check request warns and declares nothing", async () => {
  const { root, wt } = await initializedWorktree("feature-8");
  const before = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");
  // A command that fails in the worktree must never be written — it would park the queue
  // behind a red main no role can repair. `false` exits 1 deterministically. An instanced
  // runner exercises the baseRoleOf arm of the consumer gate.
  fs.writeFileSync(configRequestPath(wt), JSON.stringify({ check: { command: "false" } }));

  const { ctx, warns } = makeCtx(root, wt, "feature-8");
  const outcome = await resolveRunVerdict(ctx);

  assert.match(warns[0] ?? "", /config request rejected: check\.command not declared/);
  assert.equal(fs.readFileSync(path.join(root, "tumwater.json"), "utf8"), before, "nothing declared");
  assert.ok(!fs.existsSync(configRequestPath(wt)), "the rejected request is still deleted");
  assert.equal(outcome?.result, "no_change");
});

test("a stray config request in a non-director worktree is left alone", async () => {
  const { root, wt } = await initializedWorktree("improve");
  fs.writeFileSync(
    configRequestPath(wt),
    JSON.stringify({ customRoles: [{ name: "docs", task: "injected" }] }),
  );

  const { ctx, warns } = makeCtx(root, wt, "improve");
  const outcome = await resolveRunVerdict(ctx);

  // Only the director and the feature role consume config requests: the file survives this
  // verdict untouched, the config is unchanged, and nothing warns. Remove the role guard and
  // applyConfigRequest consumes the file here — both assertions below fail.
  assert.ok(fs.existsSync(configRequestPath(wt)), "the stray request file was not consumed");
  assert.deepEqual(loadConfig(root).customRoles, []);
  assert.deepEqual(warns, []);
  // The stray file itself leaves the worktree dirty (status --porcelain sees it), so the
  // verdict is "fulfillable" — staging takes over, exactly as for any other leftover edit.
  assert.equal(outcome, null);
});

test("a clean nothing-to-do run classifies as a fulfilled no_change without requeueing", async () => {
  const { root, wt } = await initializedWorktree("improve");
  const pi: PiRunResult = piRunResult({ nothingToDo: true, finalText: "TUMWATER_FLOW: tests pass" });

  const { ctx, pending } = makeCtx(root, wt, "improve", { pi });
  const outcome = await resolveRunVerdict(ctx);

  assert.equal(outcome?.result, "no_change");
  assert.equal(outcome?.cutOff, undefined);
  assert.equal(pending.get(), null, "a fulfilled no_change requeues nothing");
});

test("a director question answered in prose ends no_change carrying the answer as its summary", async () => {
  const { root, wt } = await initializedWorktree(DIRECTOR_ROLE);
  const pi: PiRunResult = piRunResult({
    nothingToDo: true,
    finalText: "Not a bug. The merge slot is busy.\n\nTUMWATER_NOTHING_TO_DO",
  });

  // userPrompt non-null marks a prompt-driven director run: a question-type prompt needs no
  // change, but its prose reply must survive as the run's summary (BUGS.md 2026-10-14).
  const { ctx } = makeCtx(root, wt, DIRECTOR_ROLE, { pi, userPrompt: "Is this a bug?" });
  const outcome = await resolveRunVerdict(ctx);

  assert.equal(outcome?.result, "no_change");
  assert.equal(outcome?.summary, "Not a bug. The merge slot is busy.");
});

test("a role runner's prompt-less nothing-to-do is not treated as an answer", async () => {
  const { root, wt } = await initializedWorktree("improve");
  // Prose above the sentinel, but no user prompt driving the run: only a director question
  // promotes the reply to a summary; a role runner's bare nothing-to-do stays summary-less.
  const pi: PiRunResult = piRunResult({
    nothingToDo: true,
    finalText: "Nothing to do today.\n\nTUMWATER_NOTHING_TO_DO",
  });

  const { ctx } = makeCtx(root, wt, "improve", { pi });
  const outcome = await resolveRunVerdict(ctx);

  assert.equal(outcome?.result, "no_change");
  assert.equal(outcome?.summary, undefined);
});

test("a no_change run records its qa flow", async () => {
  const { root, wt } = await initializedWorktree("qa");
  const pi: PiRunResult = piRunResult({ nothingToDo: true, finalText: "TUMWATER_NOTHING_TO_DO" });

  const { ctx } = makeCtx(root, wt, "qa", { pi, flow: { flow: "status", result: "passed" } });
  const outcome = await resolveRunVerdict(ctx);

  assert.equal(outcome?.result, "no_change");
  assert.equal(readQaCoverage(root).status?.result, "passed");
});

test("a failed qa coverage write warns and the no_change run stands", async () => {
  const { root, wt } = await initializedWorktree("qa");
  const pi: PiRunResult = piRunResult({ nothingToDo: true, finalText: "TUMWATER_NOTHING_TO_DO" });

  const { ctx, warns } = makeCtx(root, wt, "qa", { pi, flow: { flow: "status", result: "passed" } });
  const undo = failRenameSyncOn(qaCoveragePath(root), "EACCES fake");
  let outcome;
  try {
    outcome = await resolveRunVerdict(ctx);
  } finally {
    undo();
  }

  assert.equal(outcome?.result, "no_change");
  assert.deepEqual(readQaCoverage(root), {});
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /qa flow "status" not recorded: EACCES fake/);
});

test("a no_change feedback run with filed records the ledger entry", async () => {
  const { root, wt } = await initializedWorktree("feedback");
  const pi: PiRunResult = piRunResult({ nothingToDo: true, finalText: "TUMWATER_NOTHING_TO_DO" });

  const { ctx } = makeCtx(root, wt, "feedback", { pi, filed: { issue: 12, title: "a bug" } });
  const outcome = await resolveRunVerdict(ctx);

  assert.equal(outcome?.result, "no_change");
  const filings = readFeedbackFilings(root);
  assert.equal(filings.length, 1);
  assert.equal(filings[0]!.issue, 12);
  assert.equal(filings[0]!.title, "a bug");
});

test("a no_change ci run with a CI line records its parity coverage", async () => {
  const { root, wt } = await initializedWorktree("ci");
  const pi: PiRunResult = piRunResult({ nothingToDo: true, finalText: "TUMWATER_NOTHING_TO_DO" });

  const { ctx } = makeCtx(root, wt, "ci", { pi, ci: { sha: "abc1234", result: "passed" } });
  const outcome = await resolveRunVerdict(ctx);

  assert.equal(outcome?.result, "no_change");
  const entry = readCiParity(root);
  assert.ok(entry, "the ci run's declared coverage is recorded");
  assert.equal(entry!.tip, "abc1234");
  assert.equal(entry!.result, "passed");
  assert.ok(fs.existsSync(ciParityPath(root)), "the ledger lives under .tumwater/state");
});

test("a cut-off ci run's CI line records nothing", async () => {
  const { root, wt } = await initializedWorktree("ci");
  // The run was truncated before declaring its outcome, so its mid-stream CI line must not
  // advance the coverage — the same guard qa's FLOW line carries.
  const pi: PiRunResult = piRunResult({
    nothingToDo: false,
    finalMessageContentless: true,
    finalText: "CI: abc1234 — passed",
  });
  const { ctx } = makeCtx(root, wt, "ci", { pi, ci: { sha: "abc1234", result: "passed" } });
  await resolveRunVerdict(ctx);
  assert.equal(readCiParity(root), null, "truncation is not a coverage the run declared");
});

test("a failed ci parity write warns and the no_change run stands", async () => {
  const { root, wt } = await initializedWorktree("ci");
  const pi: PiRunResult = piRunResult({ nothingToDo: true, finalText: "TUMWATER_NOTHING_TO_DO" });

  const { ctx, warns } = makeCtx(root, wt, "ci", { pi, ci: { sha: "abc1234", result: "passed" } });
  const undo = failRenameSyncOn(ciParityPath(root), "EACCES fake");
  let outcome;
  try {
    outcome = await resolveRunVerdict(ctx);
  } finally {
    undo();
  }

  assert.equal(outcome?.result, "no_change");
  assert.equal(readCiParity(root), null, "the ledger write failed");
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /ci parity not recorded: EACCES fake/);
});

test("a cut-off feedback run with filed records nothing", async () => {
  const { root, wt } = await initializedWorktree("feedback");
  // A cut-off run was truncated before declaring its outcome: the FILED line it left mid-stream
  // is not a filing the run declared, exactly like the FLOW line (BUGS.md 2026-09-23).
  const pi: PiRunResult = piRunResult({
    nothingToDo: false,
    finalMessageContentless: true,
    finalText: "FILED: #12 — a bug",
  });
  const { ctx } = makeCtx(root, wt, "feedback", { pi, filed: { issue: 12, title: "a bug" } });
  const outcome = await resolveRunVerdict(ctx);

  assert.equal(outcome?.result, "no_change");
  assert.deepEqual(readFeedbackFilings(root), [], "a cut-off run records no filing");
});

test("a failed feedback ledger write warns and the no_change run stands", async () => {
  const { root, wt } = await initializedWorktree("feedback");
  const pi: PiRunResult = piRunResult({ nothingToDo: true, finalText: "TUMWATER_NOTHING_TO_DO" });

  const { ctx, warns } = makeCtx(root, wt, "feedback", { pi, filed: { issue: 12, title: "a bug" } });
  const undo = failRenameSyncOn(feedbackFilingsPath(root), "EACCES fake");
  let outcome;
  try {
    outcome = await resolveRunVerdict(ctx);
  } finally {
    undo();
  }

  assert.equal(outcome?.result, "no_change");
  assert.deepEqual(readFeedbackFilings(root), []);
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /feedback filing #12 not recorded: EACCES fake/);
});

test("a blind image read fails the run with an error naming the file and the model", async () => {
  const { root, wt } = await initializedWorktree("improve");
  // The runner killed the authoring run the moment its agent read an image its model cannot
  // see (plans/image-input.md "Failing the run"): pi strips such images, so the run must
  // fail rather than let the agent answer about a picture it never saw.
  const pi: PiRunResult = piRunResult({
    ok: false,
    imageBlind: { path: "/x/shot.png" },
    errorMessage: "read /x/shot.png, but some-model cannot read images",
  });

  const { ctx, state, pending } = makeCtx(root, wt, "improve", { pi });
  const outcome = await resolveRunVerdict(ctx);

  assert.equal(outcome?.result, "error");
  assert.match(state.lastError ?? "", /\/x\/shot\.png/, "lastError names the image file");
  assert.match(state.lastError ?? "", /cannot read images/, "lastError names the model gap");
  assert.equal(pending.get(), null, "an imageBlind run is not resume-armed (nothing to resume)");
});

// Image-input reroute (plans/image-input.md part 4/5): when the role's tier is text-only but
// another configured tier (here strong) can read images, a blind read stops routing its work
// to that tier instead of failing. The verdict ends `aborted` with the `image-reroute` resume
// cause and records a one-shot marker the next run's model choice reads. These unit tests
// exercise the pure verdict decision with a fake pi; the role e2e (test/runner-2.test.ts) covers
// the next run actually running on the target.

test("a blind read on a text-only tier with a vision reroute target aborts as image-reroute", async () => {
  const { root, wt } = await initializedWorktree("feature");
  // The feature role rides the default tier (text-only local/text); strong reads images
  // (local/vision). The models.json sits in the suite's scratch pi-agent dir.
  writeConfig(root, { model: { default: "local/text", strong: "local/vision" } });
  const config = loadConfig(root);
  const models = path.join(process.env.PI_CODING_AGENT_DIR ?? "", "models.json");
  writeFileDeep(models,
    JSON.stringify({ providers: { local: { models: [{ id: "text" }, { id: "vision", input: ["text", "image"] }] } } }),
  );

  const pi: PiRunResult = piRunResult({
    ok: false,
    imageBlind: { path: "/x/s.png" },
    errorMessage: "read /x/s.png, but local/text cannot read images",
  });
  const { ctx, state } = makeCtx(root, wt, "feature", {
    pi,
    config,
    runModel: "local/text",
    rerouteRegime: "primary",
  });
  const outcome = await resolveRunVerdict(ctx);

  assert.equal(outcome?.result, "aborted");
  assert.equal(outcome?.resumeCause, "image-reroute");
  assert.equal(state.imageReroute?.tier, "strong");
  assert.equal(state.imageReroute?.model, "vision");
  assert.equal(state.imageReroute?.from, "local/text");
  assert.equal(state.imageReroute?.path, "/x/s.png");
  assert.match(state.lastError ?? "", /rerouting to strong/);
  // The verdict re-queues the prompt for a prompt-driven reroute; a bare role runner has none.
  // (applyRunOutcome, exercised in the role e2e, arms the prompt resume + nextRunAt.)
});

test("a blind read during an already-rerouted run fails instead of rerouting a second time", async () => {
  const { root, wt } = await initializedWorktree("feature");
  writeConfig(root, { model: { default: "local/text", strong: "local/vision" } });
  const config = loadConfig(root);
  const models = path.join(process.env.PI_CODING_AGENT_DIR ?? "", "models.json");
  writeFileDeep(models,
    JSON.stringify({ providers: { local: { models: [{ id: "text" }, { id: "vision", input: ["text", "image"] }] } } }),
  );

  const pi: PiRunResult = piRunResult({
    ok: false,
    imageBlind: { path: "/x/s.png" },
    errorMessage: "read /x/s.png, but local/vision cannot read images",
  });
  const { ctx, state } = makeCtx(root, wt, "feature", {
    pi,
    config,
    runModel: "local/vision",
  });
  // The run already started on the target (runPhase set this when it routed the reroute).
  state.imageRerouteActive = true;
  const outcome = await resolveRunVerdict(ctx);

  assert.equal(outcome?.result, "error", "a rerouted run's blind read fails, no second hop");
  assert.equal(state.imageReroute, undefined, "no new reroute marker is set");
  assert.match(state.lastError ?? "", /cannot read images/);
});

test("a blind read onto a built-in vision tier that pi lists as reading images aborts as image-reroute", async () => {
  const { root, wt } = await initializedWorktree("feature");
  // strong names a pair models.json does not define; only the saved `pi --list-models`
  // listing says it reads images.
  writeConfig(root, { model: { default: "local/text", strong: "builtin/vision-x" } });
  const config = loadConfig(root);
  const models = path.join(process.env.PI_CODING_AGENT_DIR ?? "", "models.json");
  writeFileDeep(models, JSON.stringify({ providers: { local: { models: [{ id: "text" }] } } }));
  const pi: PiRunResult = piRunResult({
    ok: false,
    imageBlind: { path: "/x/s.png" },
    errorMessage: "read /x/s.png, but local/text cannot read images",
  });
  const run = async () => {
    const { ctx, state } = makeCtx(root, wt, "feature", { pi, config, runModel: "local/text", rerouteRegime: "primary" });
    return { outcome: await resolveRunVerdict(ctx), state };
  };

  const unlisted = await run();
  assert.equal(unlisted.outcome?.result, "error", "no listing: no reroute target");
  assert.equal(unlisted.state.imageReroute, undefined);

  writePiListedModels(root, { "builtin/vision-x": true });
  const listed = await run();
  assert.equal(listed.outcome?.result, "aborted");
  assert.equal(listed.outcome?.resumeCause, "image-reroute");
  assert.equal(listed.state.imageReroute?.tier, "strong");
  assert.equal(listed.state.imageReroute?.model, "vision-x");
});
