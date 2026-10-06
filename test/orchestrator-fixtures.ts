import fs from "node:fs";
import path from "node:path";
import { strict as assert } from "node:assert";
import { defaultConfig, loadConfig, saveConfig } from "../src/config/config.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, sh } from "./repo-fixtures.js";
import { runOrchestrator } from "../src/orchestrator/orchestrator.js";
import { drainMerge } from "../src/landing/landing-drain.js";
import { newLandingPipeline, type LandingPipelineContext } from "../src/landing/landing-pipeline.js";
import { startVet } from "../src/landing/landing-vetting.js";
import { headLanding } from "../src/landing/landing-queue.js";
import { landingRefName } from "../src/paths.js";
import { Semaphore } from "../src/semaphore.js";
import { loadLoopState } from "../src/loop/loop-state.js";
import { logEvent } from "../src/events/events.js";
import { type RedeployDeps } from "../src/redeploy/redeploy-policy.js";
import { Redeployer } from "../src/redeploy/redeployer.js";
import { LoopRunner } from "../src/loop/loop.js";
import { fakePiIdle } from "./fake-pi.js";
import { waitFor } from "./wait.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import type { TickResult } from "../src/tick/tick-outcome.js";

/** The live-orchestrator tier's test scaffolding — the helpers that drive a running
 * orchestrator or its landing pipeline: fast configs and repos, a start/stop wrapper around
 * runOrchestrator, and a one-entry driver for the landing pipeline. Split from the
 * loop-level fixtures (loop-fixtures.ts) so the e2e tier's machinery lives beside its tier,
 * mirroring repo-fixtures.ts / lander-fixtures.ts / status-fixtures.ts. */

/** Fast poll interval for live-orchestrator tests whose assertions don't depend on the real
 * 2s cadence: multi-cycle behavior (config reloads, marker consumption, wake events) resolves
 * in ~100ms instead of seconds. Tests that verify timing margins against the real cadence —
 * shutdown latency vs POLL_MS, and maxConcurrent's hold < poll boundary — keep the default.
 * Safe because idle ticks back off 1s (fastConfig), so no assertion relies on a >=2s gap
 * between polls to prevent back-to-back ticks. */
export const FAST_POLL_MS = 100;

/** Does `role`'s pinned landing ref still exist? `git rev-parse --verify` exits nonzero once
 * the ref is gone, so its absence is the postcondition the rejection, abort, and
 * successful-landing tests assert. Waiting on the outcome alone races the discard: a
 * deliberate stop's `discardPinnedRefs` runs in the landing slot's `finally`, AFTER
 * `writeLandingOutcome` has already recorded `lastResult` (the load-sensitive-test class in
 * BUGS.md, 2026-09-18). Single home of that try/rev-parse/catch probe: the loop-tier suites
 * (loop-3.test.ts, loop-leftover-recovery.test.ts) each held an inline copy before this was
 * extracted, and orchestrator-3.e2e.test.ts a file-local one. */
export function landingRefExists(repo: string, role: string): boolean {
  try {
    sh(repo, "git", "rev-parse", "--verify", landingRefName(role));
    return true;
  } catch {
    return false; // a missing ref makes rev-parse --verify exit nonzero
  }
}

/** The in-flight counts a concurrency-recording fake pi wrote, one per run start (empty before
 * any run). */
export function readSamples(runDir: string): number[] {
  try {
    return fs.readFileSync(path.join(runDir, "samples.log"), "utf8").trim().split("\n").map(Number);
  } catch {
    return [];
  }
}

/** A config where only the given roles tick quickly (no min gap, 1s backoff) so several
 * ticks land within a few poll cycles. */
export function fastConfig(roles: string[], model?: string): TumwaterConfig {
  const c = defaultConfig();
  if (model) c.model = model;
  c.minTickIntervalSeconds = 0;
  c.idleBackoff = { initialSeconds: 1, factor: 1, maxSeconds: 1 };
  for (const id of Object.keys(c.roles)) c.roles[id]!.enabled = roles.includes(id);
  return c;
}

/** The standard opening of a live-orchestrator e2e test in one call: a fresh repo, run through
 * initProject, configured so the given roles tick quickly (see fastConfig; `model` forwards to
 * it for tests that pin the model). Returns the repo path. */
export async function makeFastRepo(label: string, roles: string[], model?: string): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, label);
  saveConfig(repo, fastConfig(roles, model));
  return repo;
}

/** Start a run over `repo` with the fields every in-process test start repeats — the repo's
 * on-disk config (loadConfig), main, a fresh abort signal — leaving the rest (pollMs, once,
 * redeploy, modelsPath, …) to `overrides`. Returns runOrchestrator's exit promise unchanged.
 * The one home of the root/config/mainBranch/signal literal the live-run tests each carried
 * as a copy: a new RunOptions seam now reaches every test start through one edit. Tests that
 * abort mid-run keep their own AbortController and pass its signal; startLiveOrchestrator,
 * onceRound, and startRedeployRun build on this instead of repeating the literal. */
export function runRepoOrchestrator(
  repo: string,
  overrides: Partial<Parameters<typeof runOrchestrator>[0]> = {},
): ReturnType<typeof runOrchestrator> {
  const { signal = new AbortController().signal, ...rest } = overrides;
  return runOrchestrator({
    root: repo,
    config: loadConfig(repo),
    mainBranch: "main",
    signal,
    ...rest,
  });
}

/** Start a live orchestrator on `repo` with the config currently on disk, for tests that
 * drive it while running. Returns its exit promise plus `stop`, which aborts the run and
 * awaits its exit — swallowing shutdown noise so the test's own failure (if any) stays
 * visible; call `stop` from finally after other cleanup (e.g. restoring a fake pi). */
export function startLiveOrchestrator(
  repo: string,
  pollMs?: number,
  modelsPath?: string,
): { done: Promise<unknown>; stop: () => Promise<void> } {
  const controller = new AbortController();
  const done = runRepoOrchestrator(repo, {
    signal: controller.signal,
    pollMs,
    // pi's model definitions, for the budget gate's fallback check (plans/fallback-model.md):
    // tests that exercise it write their own catalog instead of reading the real ~/.pi one.
    ...(modelsPath ? { modelsPath } : {}),
  });
  return {
    done,
    async stop() {
      controller.abort();
      try {
        await done;
      } catch {
        // The test's own failure (if any) takes precedence over shutdown noise.
      }
    },
  };
}

/** Run one once round in-process with the repo's on-disk config, failing loudly if the round
 * does not exit on its own — a once round that hangs is the bug `--once` exists to avoid, so
 * the race against a 30s unref'd timeout turns a hang into a test failure. `roleFilter`
 * scopes the round to one role (`run --once --role <id>`, PLANS.md 2026-09-25). The one home
 * of this dance, which the once-mode tests (orchestrator-once.test.ts, orchestrator-defer.test.ts,
 * orchestrator-once.e2e.test.ts) each carried as a near-identical local copy. */
export function onceRound(
  repo: string,
  roleFilter?: string,
): Promise<{ restart: boolean; settled?: ReadonlyMap<string, string>; ticksRun?: ReadonlyMap<string, number> }> {
  const done = runRepoOrchestrator(repo, {
    pollMs: FAST_POLL_MS,
    once: true,
    roleFilter,
  });
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error("once round did not exit on its own")), 30_000);
    t.unref();
  });
  return Promise.race([done, timeout]);
}

/** The idle-pi orchestrator prelude the e2e tests shared as a copy-pasted pair: install the
 * fake pi that prints TUMWATER_NOTHING_TO_DO forever and start a live orchestrator over it at
 * FAST_POLL_MS, returning both halves so the `restore()` in the test's finally and the `orch`
 * it drives cannot be wired to different runs. Tests whose pi must say something else use
 * fakePi/recordingFakePi plus startLiveOrchestrator directly, and tests that drive
 * runOrchestrator inline keep their own AbortController. */
export function startIdleOrchestrator(repo: string): {
  restore: () => void;
  orch: ReturnType<typeof startLiveOrchestrator>;
} {
  const restore = fakePiIdle();
  const orch = startLiveOrchestrator(repo, FAST_POLL_MS);
  return { restore, orch };
}

/** The shutdown tail every live-orchestrator test runs from its finally: put the fake pi's
 * PATH shim away (restore) and stop the orchestrator it drove — in that order, exactly as the
 * 45 copy-pasted `restore(); await orch.stop();` pairs ran, so the teardown contract (always
 * both halves, restore first, and the stop swallowing shutdown noise — startLiveOrchestrator)
 * lives in one place instead of drifting per file. `orch` is the start/startIdle return, so
 * the call sites cannot stop a different run than the one whose shim they restore. */
export async function stopOrchestrator(
  orch: ReturnType<typeof startLiveOrchestrator>,
  restore: () => void,
): Promise<void> {
  restore();
  await orch.stop();
}

/** Poll until `role`'s persisted loop state has completed at least `n` ticks and is idle
 * (not mid-tick) — the live-orchestrator e2e tests' shared "a tick finished" gate, the
 * `waitFor(() => loadLoopState(repo, role).ticks >= n && !loadLoopState(repo, role).running,
 * what)` idiom that recurred verbatim across the suite. Reads the state file fresh each
 * poll, exactly like the inline form; `ms` forwards to waitFor's deadline (default when
 * omitted). Tests that wait for the tick to start but not finish, or that assert on the
 * state between the two conditions, keep their explicit waitFor calls. */
export async function awaitSettledTick(
  repo: string,
  role: string,
  n: number,
  what: string,
  ms?: number,
): Promise<void> {
  await waitFor(
    () => {
      const s = loadLoopState(repo, role);
      return s.ticks >= n && !s.running;
    },
    what,
    ms,
  );
}

/** Land the head of the durable land queue through the orchestrator's own landing pipeline
 * (landing-drain.ts). Loop-level tests call `runner.tick()` directly — no poll loop — so the
 * entry a changed tick enqueues needs a driver: this vets the head alone (startVet, on a
 * one-permit semaphore) and, once vetted, merges it (drainMerge), leaving every other queued
 * entry untouched — a test that ticks a second role meanwhile lands that one with its own call.
 * `signal` stands in for harness shutdown (the orchestrator's stop signal). Returns the
 * landing's outcome as folded into `runner`'s state; the entry is dropped after every outcome,
 * exactly as the pipeline does. */
export async function landHead(
  repo: string,
  runner: LoopRunner,
  config: TumwaterConfig,
  role: string,
  branch = "main",
  signal: AbortSignal = new AbortController().signal,
): Promise<TickResult> {
  const head = headLanding(repo);
  if (!head) throw new Error("expected a queued landing");
  assert.equal(head.entry.role, role, "the queue head belongs to the expected role");
  assert.equal(runner.role, role, "the landing folds into its own role's runner");
  const ctx: LandingPipelineContext = {
    root: repo,
    mainBranch: branch,
    signal,
    semaphore: new Semaphore(1),
    runners: [runner],
    liveConfig: config,
    roleConfig: config,
    startHeld: () => false,
  };
  const pipeline = newLandingPipeline();
  startVet(ctx, pipeline, head.entry, head.file);
  await Promise.all([...pipeline.vetting.values()].map((v) => v.promise));
  drainMerge(ctx, pipeline);
  await pipeline.merge?.promise;
  if (fs.existsSync(head.file)) throw new Error(`the landing of ${role} ended without an outcome`);
  const result = runner.state.lastResult;
  if (result === undefined) throw new Error(`the landing of ${role} recorded no result`);
  return result;
}

/** A Redeployer whose effects are scripted: main is always stale and green, the compile succeeds
 * at once, and the swap only records itself — so the orchestrator's half of the contract (hold,
 * drain, abort, exit) is what these tests pin. `mainGreen` replaces the instant green verdict,
 * for a test that needs the hold to last until something happens and then lift. */
export function scriptedRedeployer(
  repo: string,
  opts: { drainMaxMs?: number; compileOk?: boolean; stale?: () => boolean; mainGreen?: () => Promise<boolean> } = {},
) {
  const swaps: string[] = [];
  const deps: RedeployDeps = {
    staleness: async () => ({ stale: opts.stale ? opts.stale() : true, aheadCommits: 4 }),
    mainGreen: opts.mainGreen ?? (async () => true),
    compile: async () => ({ ok: opts.compileOk ?? true, detail: opts.compileOk === false ? "tsc exited 2" : "" }),
    swap: (h) => {
      swaps.push(h);
    },
    bootProblem: async () => null,
    buildRed: async () => false,
  };
  // Events go to the repo's log exactly as cmdRun wires them, so the assertions below read the
  // same events.jsonl an operator would.
  const redeployer = new Redeployer(
    { sha: "0".repeat(40), builtAt: 1, root: "/proj" },
    true,
    deps,
    (e) => logEvent(repo, e),
    opts.drainMaxMs,
  );
  return { redeployer, swaps };
}

/** The file's eight scripted-redeploy orchestrator runs in one place: the AbortController
 * (armed with a hard self-abort deadline so a stalled drain cannot hang the suite — absent
 * when the test stops the run itself and no fixed deadline fits its waits) plus the
 * runOrchestrator call with this file's fixed seam values (config from disk, main, the fast
 * poll, the redeployer). `stop` ends the run in finally — aborting (a no-op once the run has
 * returned) and swallowing shutdown noise; the fake-pi restore stays at the call site, since
 * each test's script differs. */
export function startRedeployRun(
  repo: string,
  redeployer: Redeployer,
  opts: { timeoutMs?: number; handoffLandingWindowMs?: number } = {},
) {
  const controller = new AbortController();
  const timeout = opts.timeoutMs === undefined ? null : setTimeout(() => controller.abort(), opts.timeoutMs);
  const run = runRepoOrchestrator(repo, {
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
    redeploy: redeployer,
    ...(opts.handoffLandingWindowMs ? { handoffLandingWindowMs: opts.handoffLandingWindowMs } : {}),
  });
  return {
    run,
    signal: controller.signal,
    async stop() {
      if (timeout !== null) clearTimeout(timeout);
      controller.abort();
      await run.catch(() => undefined);
    },
  };
}

