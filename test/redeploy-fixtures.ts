import { sleep } from "./wait.js";
import assert from "node:assert/strict";
import type { HarnessEventInput } from "../src/events/events.js";
import type { BuildStaleness } from "../src/build/build-info.js";
import { defaultConfig } from "../src/config/config.js";
import { type AutoRestartRecord, type RedeployDeps } from "../src/redeploy/redeploy-policy.js";
import { Redeployer } from "../src/redeploy/redeployer.js";

/** Shared scripted-effect fixtures for the self-redeploy tests: drive the state machine with
 * controllable deps so every decision branch is pinned without git, tsc, or a fleet. The
 * helpers' own behavior — compileStaged/swapDist against a temp project, mainIsGreen's
 * boolean view, the mirror worktree — is pinned beside their modules. */

export const BUILD = { sha: "a".repeat(40), builtAt: 1, root: "/proj" };
/** The live config mainIsGreen now requires (plans/portability.md §6/7): these tests exercise
 * npm auto-detection, so the defaults (no `check` configured) are the fixture. */
export const CFG = defaultConfig();
export const HEAD_B = "b".repeat(40);
export const HEAD_C = "c".repeat(40);
export const HEAD_D = "d".repeat(40);

/** A controllable deps object: each effect resolves when the test says so. */
export function fakeDeps(over: Partial<RedeployDeps> & { stale?: BuildStaleness | null } = {}) {
  const calls = { compile: [] as string[], swap: [] as string[], green: [] as string[], buildRed: [] as string[] };
  let resolveGreen: ((v: boolean) => void) | null = null;
  let resolveCompile: ((v: { ok: boolean; detail: string; rejected?: boolean }) => void) | null = null;
  let resolveRed: ((v: boolean | null) => void) | null = null;
  const deps: RedeployDeps = {
    staleness: async () => over.stale ?? { stale: true, aheadCommits: 3 },
    mainGreen: (h) => {
      calls.green.push(h);
      return new Promise((r) => (resolveGreen = r));
    },
    compile: (h) => {
      calls.compile.push(h);
      return new Promise((r) => (resolveCompile = r));
    },
    swap: (h) => {
      calls.swap.push(h);
    },
    bootProblem: async () => null, // a generation would boot: the startup gate passes
    buildRed: (sha) => {
      calls.buildRed.push(sha);
      return new Promise((r) => (resolveRed = r));
    },
    ...over,
  };
  return {
    deps,
    calls,
    green(v: boolean) {
      resolveGreen?.(v);
    },
    compiled(ok: boolean, detail = "", rejected = false) {
      resolveCompile?.({ ok, detail, rejected });
    },
    red(v: boolean | null) {
      resolveRed?.(v);
    },
  };
}

export function harness(deps: RedeployDeps, selfHosted = true, drainMaxMs?: number, restartRecord?: AutoRestartRecord) {
  const events: HarnessEventInput[] = [];
  const r = new Redeployer(BUILD, selfHosted, deps, (e) => events.push(e), drainMaxMs, restartRecord);
  return { r, events, types: () => events.map((e) => e.type) };
}

/** Let the tracked background promises settle (one macrotask is enough). */
export const settle = () => sleep(5);

export const IDLE = { roleInFlight: 0, directorInFlight: 0 };

/** Drive one episode (green → compile → idle swap) to its completed restart; returns the `now`
 * at which it landed — the cooldown's start for what follows. */
export async function driveToRestart(r: Redeployer, f: ReturnType<typeof fakeDeps>, head: string, startNow: number): Promise<number> {
  let t = startNow;
  assert.equal(await r.poll(head, IDLE, true, t), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(head, IDLE, true, (t += 10)), "hold", "green: the compile starts");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(head, IDLE, true, (t += 10)), "restart", "idle: swap and go");
  return t;
}
