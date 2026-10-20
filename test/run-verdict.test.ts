import test from "node:test";
import { writePiListedModels } from "../src/pi/pi-listed-models.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveTickVerdict } from "../src/run/run-verdict.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { PendingPrompt } from "../src/inbox/pending-prompt.js";
import { freshRunnerState, type RunnerState } from "../src/runner/runner-state.js";
import { loadConfig } from "../src/config/config.js";
import { configRequestPath } from "../src/paths.js";
import { writeConfig } from "./fixtures/repo-fixtures.js";
import type { PiRunResult } from "../src/pi/pi-run-result.js";
import { piRunResult } from "./fakes/fake-pi.js";
import { initializedWorktree } from "./fixtures/repo-fixtures.js";

/** A TickVerdictContext for a finished, uneventful run: pi declared nothing-to-do on a clean
 * worktree, so the normal classification is a fulfilled no_change. Tests override only what
 * they exercise. resolveTickVerdict's context interface is module-private, so this is an
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
    warn: (m: string) => warns.push(m),
    merge: async (w: string, summary: string) => {
      merges.push({ wt: w, summary });
      return "changed" as const;
    },
    finishAbortedTick: async () => ({ result: "aborted" as const }),
    ...over,
  };
  return { ctx, warns, merges, state, pending };
}

// resolveTickVerdict's config-request block: the director's worktree request is consumed
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
  const outcome = await resolveTickVerdict(ctx);

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
  await resolveTickVerdict(ctx);

  assert.equal(warns.length, 1, "exactly one warning event");
  assert.match(warns[0]!, /config request rejected: /);
  assert.ok(!fs.existsSync(configRequestPath(wt)), "the rejected request is deleted too");
  assert.deepEqual(loadConfig(root).customRoles, before, "a rejected request changes nothing");
});

test("a stray config request in a non-director worktree is left alone", async () => {
  const { root, wt } = await initializedWorktree("improve");
  fs.writeFileSync(
    configRequestPath(wt),
    JSON.stringify({ customRoles: [{ name: "docs", task: "injected" }] }),
  );

  const { ctx, warns } = makeCtx(root, wt, "improve");
  const outcome = await resolveTickVerdict(ctx);

  // Only the director consumes config requests: the file survives this verdict untouched,
  // the config is unchanged, and nothing warns. Remove the role guard and applyConfigRequest
  // consumes the file here — both assertions below fail.
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
  const outcome = await resolveTickVerdict(ctx);

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

  // userPrompt non-null marks a prompt-driven director tick: a question-type prompt needs no
  // change, but its prose reply must survive as the tick's summary (BUGS.md 2026-10-14).
  const { ctx } = makeCtx(root, wt, DIRECTOR_ROLE, { pi, userPrompt: "Is this a bug?" });
  const outcome = await resolveTickVerdict(ctx);

  assert.equal(outcome?.result, "no_change");
  assert.equal(outcome?.summary, "Not a bug. The merge slot is busy.");
});

test("a role runner's prompt-less nothing-to-do is not treated as an answer", async () => {
  const { root, wt } = await initializedWorktree("improve");
  // Prose above the sentinel, but no user prompt driving the tick: only a director question
  // promotes the reply to a summary; a role runner's bare nothing-to-do stays summary-less.
  const pi: PiRunResult = piRunResult({
    nothingToDo: true,
    finalText: "Nothing to do today.\n\nTUMWATER_NOTHING_TO_DO",
  });

  const { ctx } = makeCtx(root, wt, "improve", { pi });
  const outcome = await resolveTickVerdict(ctx);

  assert.equal(outcome?.result, "no_change");
  assert.equal(outcome?.summary, undefined);
});

test("a blind image read fails the tick with an error naming the file and the model", async () => {
  const { root, wt } = await initializedWorktree("improve");
  // The runner killed the authoring run the moment its agent read an image its model cannot
  // see (plans/image-input.md "Failing the tick"): pi strips such images, so the run must
  // fail rather than let the agent answer about a picture it never saw.
  const pi: PiRunResult = piRunResult({
    ok: false,
    imageBlind: { path: "/x/shot.png" },
    errorMessage: "read /x/shot.png, but some-model cannot read images",
  });

  const { ctx, state, pending } = makeCtx(root, wt, "improve", { pi });
  const outcome = await resolveTickVerdict(ctx);

  assert.equal(outcome?.result, "error");
  assert.match(state.lastError ?? "", /\/x\/shot\.png/, "lastError names the image file");
  assert.match(state.lastError ?? "", /cannot read images/, "lastError names the model gap");
  assert.equal(pending.get(), null, "an imageBlind run is not resume-armed (nothing to resume)");
});

// Image-input reroute (plans/image-input.md part 4/5): when the role's tier is text-only but
// another configured tier (here strong) can read images, a blind read stops routing its work
// to that tier instead of failing. The verdict ends `aborted` with the `image-reroute` resume
// cause and records a one-shot marker the next tick's model choice reads. These unit tests
// exercise the pure verdict decision with a fake pi; the role e2e (test/runner-2.test.ts) covers
// the next tick actually running on the target.

test("a blind read on a text-only tier with a vision reroute target aborts as image-reroute", async () => {
  const { root, wt } = await initializedWorktree("feature");
  // The feature role rides the default tier (text-only local/text); strong reads images
  // (local/vision). The models.json sits in the suite's scratch pi-agent dir.
  writeConfig(root, { model: { default: "local/text", strong: "local/vision" } });
  const config = loadConfig(root);
  const models = path.join(process.env.PI_CODING_AGENT_DIR ?? "", "models.json");
  fs.mkdirSync(path.dirname(models), { recursive: true });
  fs.writeFileSync(
    models,
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
  const outcome = await resolveTickVerdict(ctx);

  assert.equal(outcome?.result, "aborted");
  assert.equal(outcome?.resumeCause, "image-reroute");
  assert.equal(state.imageReroute?.tier, "strong");
  assert.equal(state.imageReroute?.model, "vision");
  assert.equal(state.imageReroute?.from, "local/text");
  assert.equal(state.imageReroute?.path, "/x/s.png");
  assert.match(state.lastError ?? "", /rerouting to strong/);
  // The verdict re-queues the prompt for a prompt-driven reroute; a bare role runner has none.
  // (applyTickOutcome, exercised in the role e2e, arms the prompt resume + nextRunAt.)
});

test("a blind read during an already-rerouted tick fails instead of rerouting a second time", async () => {
  const { root, wt } = await initializedWorktree("feature");
  writeConfig(root, { model: { default: "local/text", strong: "local/vision" } });
  const config = loadConfig(root);
  const models = path.join(process.env.PI_CODING_AGENT_DIR ?? "", "models.json");
  fs.mkdirSync(path.dirname(models), { recursive: true });
  fs.writeFileSync(
    models,
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
  // The tick already started on the target (tickPhase set this when it routed the reroute).
  state.imageRerouteActive = true;
  const outcome = await resolveTickVerdict(ctx);

  assert.equal(outcome?.result, "error", "a rerouted tick's blind read fails, no second hop");
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
  fs.mkdirSync(path.dirname(models), { recursive: true });
  fs.writeFileSync(models, JSON.stringify({ providers: { local: { models: [{ id: "text" }] } } }));
  const pi: PiRunResult = piRunResult({
    ok: false,
    imageBlind: { path: "/x/s.png" },
    errorMessage: "read /x/s.png, but local/text cannot read images",
  });
  const run = async () => {
    const { ctx, state } = makeCtx(root, wt, "feature", { pi, config, runModel: "local/text", rerouteRegime: "primary" });
    return { outcome: await resolveTickVerdict(ctx), state };
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
