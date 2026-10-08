/** Unit-tier coverage for the orchestrator's branch-divergence watch (src/orchestrator/orchestrator.ts):
 * when the primary checkout sits on a branch other than the fleet's merge target, the
 * orchestrator warns once — and only once — naming the branch, then re-arms when the checkout
 * returns to the target branch, so a second divergence warns again. The gating `npm test`
 * never ran this path; the shape was only implied by the orchestrator's source. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { loadLoopState } from "../src/loop/loop-state.js";
import { eventsLogPath } from "../src/paths.js";
import { FAST_POLL_MS, makeFastRepo, runRepoOrchestrator } from "./orchestrator-fixtures.js";
import { fakePiIdle } from "./fakes/fake-pi.js";
import { sleep, waitFor } from "./helpers/wait.js";

/** Every divergence warning in the repo's event log so far. */
function divergenceWarnings(repo: string): { message: string }[] {
  return fs
    .readFileSync(eventsLogPath(repo), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { loop: string; type: string; message: string })
    .filter((e) => e.type === "warning" && e.loop === "harness" && e.message.includes("primary checkout moved to"));
}

/** A settled tick on the configured role gates the baseline: the orchestrator has polled at
 * least once with the checkout still on `main`, so any warning found later is attributable. */
async function awaitFirstTick(repo: string, role: string): Promise<void> {
  await waitFor(
    () => loadLoopState(repo, role).ticks >= 1 && !loadLoopState(repo, role).running,
    `${role}'s first tick settled`,
  );
}

test("branch divergence: warns once per episode and re-arms when main returns", async () => {
  const repo = await makeFastRepo("divergence watch test", ["clean"]);
  const restore = fakePiIdle();
  const controller = new AbortController();
  const done = runRepoOrchestrator(repo, {
    signal: controller.signal,
    pollMs: FAST_POLL_MS,
  });
  try {
    await awaitFirstTick(repo, "clean");
    assert.equal(divergenceWarnings(repo).length, 0, "an on-main checkout never warns");

    // Diverge: the next poll names the branch, exactly once — a second poll of the same
    // episode must not repeat the warning (the one-warning-per-episode contract).
    execFileSync("git", ["-C", repo, "checkout", "-b", "wander"]);
    await waitFor(() => divergenceWarnings(repo).length >= 1, "the divergence warning");
    const first = divergenceWarnings(repo)[0]!.message;
    assert.match(first, /primary checkout moved to wander — the fleet keeps merging into main/);
    await sleep(3 * FAST_POLL_MS);
    assert.equal(divergenceWarnings(repo).length, 1, "one warning per divergence episode, not one per poll");

    // Back on main: the watch re-arms — no warning now, and a fresh divergence warns again.
    // The gap gives the poll loop a turn while on main: re-arming happens on the poll that
    // observes the return, and a later divergence must warn again.
    execFileSync("git", ["-C", repo, "checkout", "main"]);
    await sleep(3 * FAST_POLL_MS);
    assert.equal(divergenceWarnings(repo).length, 1, "returning to main stays silent");
    execFileSync("git", ["-C", repo, "checkout", "wander"]);
    await waitFor(() => divergenceWarnings(repo).length >= 2, "the re-armed warning");
    assert.equal(divergenceWarnings(repo).length, 2, "a second episode warns exactly once more");
  } finally {
    controller.abort();
    restore();
    await done.catch(() => undefined);
  }
});
