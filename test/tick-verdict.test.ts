import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveTickVerdict } from "../src/tick-verdict.js";
import { DIRECTOR_ROLE } from "../src/roles.js";
import { PendingPrompt } from "../src/pending-prompt.js";
import { freshLoopState, type LoopState } from "../src/loop-state.js";
import { loadConfig } from "../src/config/config.js";
import { configRequestPath } from "../src/paths.js";
import type { PiRunResult } from "../src/pi/pi-run-result.js";
import { piRunResult } from "./fake-pi.js";
import { initializedWorktree } from "./repo-fixtures.js";

/** A TickVerdictContext for a finished, uneventful run: pi declared nothing-to-do on a clean
 * worktree, so the normal classification is a fulfilled no_change. Tests override only what
 * they exercise. resolveTickVerdict's context interface is module-private, so this is an
 * untyped builder mirroring the real shape. */
function makeCtx(root: string, wt: string, role: string, over: Record<string, unknown> = {}) {
  const warns: string[] = [];
  const merges: Array<{ wt: string; summary: string }> = [];
  const state: LoopState = freshLoopState(role);
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
    JSON.stringify({ customLoops: [{ name: "docs", task: "Keep the examples current." }] }),
  );

  const { ctx, warns } = makeCtx(root, wt, DIRECTOR_ROLE);
  const outcome = await resolveTickVerdict(ctx);

  // The request was applied: the custom loop is live in the root config.
  assert.deepEqual(loadConfig(root).customLoops.map((c) => c.name), ["docs"]);
  // The request file is gone — it can never enter a diff or a review prompt.
  assert.ok(!fs.existsSync(configRequestPath(wt)));
  // A clean application is silent; only rejection paths warn.
  assert.deepEqual(warns, []);
  // The verdict classification itself is unaffected by the consumption.
  assert.equal(outcome?.result, "no_change");
});

test("a malformed config request is rejected with a warning and still deleted", async () => {
  const { root, wt } = await initializedWorktree(DIRECTOR_ROLE);
  const before = loadConfig(root).customLoops;
  fs.writeFileSync(configRequestPath(wt), JSON.stringify({ customLoops: "not an array" }));

  const { ctx, warns } = makeCtx(root, wt, DIRECTOR_ROLE);
  await resolveTickVerdict(ctx);

  assert.equal(warns.length, 1, "exactly one warning event");
  assert.match(warns[0]!, /config request rejected: /);
  assert.ok(!fs.existsSync(configRequestPath(wt)), "the rejected request is deleted too");
  assert.deepEqual(loadConfig(root).customLoops, before, "a rejected request changes nothing");
});

test("a stray config request in a non-director worktree is left alone", async () => {
  const { root, wt } = await initializedWorktree("improve");
  fs.writeFileSync(
    configRequestPath(wt),
    JSON.stringify({ customLoops: [{ name: "docs", task: "injected" }] }),
  );

  const { ctx, warns } = makeCtx(root, wt, "improve");
  const outcome = await resolveTickVerdict(ctx);

  // Only the director consumes config requests: the file survives this verdict untouched,
  // the config is unchanged, and nothing warns. Remove the role guard and applyConfigRequest
  // consumes the file here — both assertions below fail.
  assert.ok(fs.existsSync(configRequestPath(wt)), "the stray request file was not consumed");
  assert.deepEqual(loadConfig(root).customLoops, []);
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