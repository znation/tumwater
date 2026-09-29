import fs from "node:fs";
import path from "node:path";
import { strict as assert } from "node:assert";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.js";
import { initProject } from "../src/init.js";
import { makeRepo } from "./repo-fixtures.js";
import { runOrchestrator } from "../src/orchestrator.js";
import { drainMerge, newLandingPipeline, startVet, type LandingPipelineContext } from "../src/landing-drain.js";
import { headLanding } from "../src/landing-queue.js";
import { Semaphore } from "../src/semaphore.js";
import { loadLoopState } from "../src/loop-state.js";
import { LoopRunner } from "../src/loop.js";
import { waitFor } from "./wait.js";
import type { TumwaterConfig } from "../src/config-schema.js";
import type { TickResult } from "../src/tick-outcome.js";

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
  const done = runOrchestrator({
    root: repo,
    config: loadConfig(repo),
    mainBranch: "main",
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
