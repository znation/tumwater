import { sleep } from "../helpers/wait.js";
import assert from "node:assert/strict";
import type { HarnessEventInput } from "../../src/events/events.js";
import type { BuildStaleness } from "../../src/build/build-info.js";
import { defaultConfig } from "../../src/config/config.js";
import type { AutoRestartRecord, RedeployDeps } from "../../src/redeploy/redeploy-policy.js";
import { Redeployer } from "../../src/redeploy/redeployer.js";

/** Shared scripted-effect fixtures for the self-redeploy tests: drive the state machine with
 * controllable deps so every decision branch is pinned without git, tsc, or a team. The
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

/** fakeDeps whose green checks and compiles record themselves as steps on the one mirror worktree
 * they share in production (redeploy.ts): `steps` lists every step in start order, and `overlaps`
 * every step that started while an earlier one was still running — the re-point under a running
 * suite that recorded a red against the wrong tree on 2026-10-30. `finish` settles the oldest
 * running step: a green check with `ok`, a compile with `{ ok }`. */
export function mirrorFake() {
  const f = fakeDeps();
  const steps: { step: string; done: boolean; settle: (ok: boolean) => void }[] = [];
  const overlaps: string[] = [];
  const start = <T>(step: string, value: (ok: boolean) => T) =>
    new Promise<T>((resolve) => {
      const running = steps.filter((s) => !s.done).map((s) => s.step);
      if (running.length > 0) overlaps.push(`${step} under ${running.join(", ")}`);
      const s = { step, done: false, settle: (ok: boolean) => ((s.done = true), resolve(value(ok))) };
      steps.push(s);
    });
  const deps: RedeployDeps = {
    ...f.deps,
    mainGreen: (h) => start(`green ${h.slice(0, 1)}`, (ok) => ok),
    compile: (h) => start(`compile ${h.slice(0, 1)}`, (ok) => ({ ok, detail: "" })),
  };
  return {
    deps,
    calls: f.calls,
    overlaps,
    steps: () => steps.map((s) => s.step),
    finish(ok: boolean) {
      const running = steps.find((s) => !s.done);
      assert.ok(running, "a step is running");
      running.settle(ok);
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
 * at which it merged — the cooldown's start for what follows. */
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
