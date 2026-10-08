import { sleep } from "./helpers/wait.js";
import fs from "node:fs";
import path from "node:path";
import { drainLandings } from "../src/landing/landing-drain.js";
import {
  landingTasks,
  newLandingPipeline,
  type InFlightLanding,
  type LandingPipeline,
  type LandingPipelineContext,
} from "../src/landing/landing-pipeline.js";
import { LoopRunner } from "../src/loop/loop.js";
import { enqueueLanding, queueDepth } from "../src/landing/landing-queue.js";
import { landingRefName } from "../src/paths.js";
import { setRef } from "../src/git/git.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import { defaultConfig } from "../src/config/config.js";
import { freshLoopState } from "../src/loop/loop-state.js";
import { snapshot } from "../src/status/status-data.js";
import { landingForRole, loopPhase } from "../src/ui/status-model.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import type { LandingEntry } from "../src/landing/landing-queue.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { makeLoopRunner } from "./fixtures/loop-fixtures.js";
import { headSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { assistantLine, leasedRoleShell, reviewerPi } from "./fixtures/pi-events.js";

/** Shared fixtures for the landing-drain tests — landing-drain.test.ts and
 * landing-pipeline.test.ts, which node --test runs as parallel processes (top-level tests
 * within one file run one after another). The pipeline context and poll loop the drain is
 * driven through, queue-shaped pinned commits, the per-role reviewer shim, and the row the
 * status observers render: until now the two slices carried byte-identical copies of all of
 * it — they build on this module instead. lander.test.ts's trio shares lander-fixtures.ts
 * (BatchContext wiring, a different shape), not this. */

export const APPROVE = (reply = "the work looks right") => reviewerPi(`VERDICT: approve\n${reply}`);

/** One pinned commit NOT contained in main, standing alone on main's tip — the queue shape
 * a changed tick leaves behind. Detach first: the commit must not land on main itself. */
export function pinnedCommit(root: string, role: string): string {
  sh(root, "git", "checkout", "--detach");
  sh(root, "git", "reset", "--hard", "main");
  fs.appendFileSync(path.join(root, `${role}.txt`), `work by ${role}\n`);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", `work by ${role}`);
  const sha = headSha(root);
  sh(root, "git", "checkout", "main");
  return sha;
}

export function entry(role: string, sha: string, enqueuedAt = Date.now()): LandingEntry {
  return { role, sha, tick: 7, summary: "the work", enqueuedAt };
}

/** A runner per role — a real LoopRunner (cheap constructor: state loaded from disk, no
 * subprocess) so the drain resolves its author wiring the way orchestrator.ts supplies it. */
export function runnersFor(root: string, roles: string[], signal?: AbortSignal, config = defaultConfig()): LoopRunner[] {
  return roles.map((role) => makeLoopRunner(root, role, config, "main", signal));
}

/** A pipeline context over a fresh repo — `cap` shared permits (the maxConcurrent semaphore
 * role ticks would share) and a start gate the test can close — plus a fresh pipeline: the
 * scheduler's pair, driven here by pump/pumpUntil like its poll loop. */
export function makePipeline(
  root: string,
  runners: LoopRunner[],
  opts: { cap?: number; signal?: AbortSignal; config?: TumwaterConfig; held?: () => boolean } = {},
): { ctx: LandingPipelineContext; pipeline: LandingPipeline } {
  const config = opts.config ?? defaultConfig();
  return {
    ctx: {
      root,
      mainBranch: "main",
      signal: opts.signal ?? new AbortController().signal,
      semaphore: new Semaphore(opts.cap ?? 3),
      runners,
      liveConfig: config,
      roleConfig: config,
      startHeld: opts.held ?? (() => false),
    },
    pipeline: newLandingPipeline(),
  };
}

/** Poll the pipeline every 50 ms, as the scheduler does every poll, until `done` holds right
 * after a drain. */
export async function pumpUntil(
  ctx: LandingPipelineContext,
  p: LandingPipeline,
  done: () => boolean,
  what: string,
  ms = 60_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    await drainLandings(ctx, p);
    if (done()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Keep polling in the background (for mid-flight assertions); `stop` ends the loop. */
export function pump(ctx: LandingPipelineContext, p: LandingPipeline): { stop: () => Promise<void> } {
  let running = true;
  const loop = (async () => {
    while (running) {
      await drainLandings(ctx, p);
      await sleep(50);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
    },
  };
}

/** The queue is empty and no vet or merge is running. */
export const drained = (root: string, p: LandingPipeline) => () => queueDepth(root) === 0 && landingTasks(p).length === 0;

/** Every task still settling — parked vets included — for a test's cleanup. A busySlot
 * stand-in never settles, so it is skipped: a test that fails before freeing its slot then
 * reports the failure instead of hanging in its finally. */
export const allTasks = (p: LandingPipeline) =>
  [...p.vetting.values(), ...(p.merge && !standIns.has(p.merge) ? [p.merge] : [])].map((t) => t.promise);

/** Pin and enqueue one change per role, every pin before any enqueue (a pin's `git add -A`
 * would sweep an already-written queue file into the next pin). */
export async function queueChanges(root: string, roles: string[]): Promise<Record<string, string>> {
  const shas = Object.fromEntries(roles.map((role) => [role, pinnedCommit(root, role)]));
  for (const role of roles) {
    await setRef(root, landingRefName(role), shas[role]!);
    enqueueLanding(root, entry(role, shas[role]!));
  }
  return shas;
}

/** A fake reviewer that tells the roles apart by the lease on its pooled checkout (a vet no
 * longer runs in `_land-<role>`): each role touches `<role>-reviewing`, a `held` role then
 * waits (bounded, ~60 s) for `<role>-release`, and each replies with its own verdict (approve
 * by default). */
export function reviewers(flags: string, roles: string[], verdicts: Record<string, string> = {}, held: string[] = []): string {
  return [
    leasedRoleShell(),
    `case "$role" in`,
    ...roles.map(
      (role) =>
        `"${role}") touch '${path.join(flags, `${role}-reviewing`)}'; ` +
        (held.includes(role)
          ? `i=0; while [ ! -f '${path.join(flags, `${role}-release`)}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done; `
          : "") +
        `printf '%s\\n' '${assistantLine(verdicts[role] ?? "VERDICT: approve")}'; exit 0;;`,
    ),
    `esac`,
  ].join("\n");
}

/** The busySlot stand-ins handed out so far (allTasks skips them). */
const standIns = new WeakSet<InFlightLanding>();

/** A stand-in for a merge already holding the slot, so an approved change has to wait for it. */
export function busySlot(): InFlightLanding {
  const slot = { promise: new Promise<void>(() => {}), controller: new AbortController(), roles: [], userAborted: false };
  standIns.add(slot);
  return slot;
}

/** A role's row as the observers render it (snapshot → landingForRole → loopPhase). The
 * observers show a landing only for a live orchestrator, so this stands the test process in
 * for one. */
export function rowReader(root: string, roles: string[]): (role: string) => string {
  writeOrchestratorMarker(root, roles);
  const noModels = path.join(tmpdir(), "no-models.json");
  return (role) => {
    const snap = snapshot(root, noModels);
    return loopPhase(freshLoopState(role), snap.running, undefined, false, undefined, false, landingForRole(snap.landQueue, role));
  };
}

export const REVIEWING = /^landing \d+s · reviewing$/;
