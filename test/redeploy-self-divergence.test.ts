import test from "node:test";
import assert from "node:assert/strict";
import type { HarnessEventInput } from "../src/events/events.js";
import type { Redeployer } from "../src/redeploy/redeployer.js";
import { IDLE, fakeDeps, harness, settle } from "./fixtures/redeploy-fixtures.js";

// --- The self-divergent running build (BUGS.md 2026-11-14) -------------------------------
// A build whose own green check and its own build disagree (its check is 7.x-clean, its build
// is 5.x-dirty) ACCEPTS a tip in its check and REJECTS it in its build. The state machine must
// say the BUILD is the problem — one distinct diagnostic and one process-lifetime latch —
// instead of re-emitting a generic per-tip "failed to build" and re-blocking on every new tip
// until an operator restarts the process.
//
// The discriminator is structural: a real-verdict compile failure in compileStage is only
// reachable after greenStage returned null (the green check PASSED), and the green check is the
// declared suite (npm test, which runs tsc) on the SAME mirror worktree and HEAD as compileStaged.
// In a self-consistent build the check and the build share one compiler, so a passed check plus
// a failed build on the same tree is impossible — it is the divergence itself.

const MINUTE = 60_000;

/** The self-divergence diagnostic, distinct from the sustained-pin ("has waited") and per-head
 * ("could not run"/"is red") warnings. */
const selfDivergence = (events: HarnessEventInput[]) =>
  events.filter((e) => e.type === "warning" && String(e.message ?? "").includes("cannot verify itself"));

/** Drive one tip's full episode: hold → (settle) hold → (settle) verdict. */
async function driveTip(r: Redeployer, t: number, head: string): Promise<void> {
  await r.poll(head, IDLE, true, t);
  await settle();
  await r.poll(head, IDLE, true, t);
  await settle();
  await r.poll(head, IDLE, true, t);
  await settle();
}

test("a self-divergent build warns once across many tips, not once per tip", async () => {
  // Every tip its check accepts (true) and its build rejects (a real verdict, not a rejection):
  // the self-divergent shape.
  const f = fakeDeps({
    mainGreen: async () => true,
    compile: async () => ({ ok: false, detail: "tsc exited 2" }),
  });
  const { r, events } = harness(f.deps);
  let t = 0;
  for (let i = 1; i <= 5; i++) {
    // A new tip a couple of minutes apart — well under the 6 h sustained-pin threshold, so the
    // only self-divergence signal is the one diagnostic, not the daily escalation.
    t = i * 2 * MINUTE;
    const head = `div${String(i).padStart(3, "0")}`.padEnd(40, "0");
    await driveTip(r, t, head);
  }
  // The fix: ONE distinct diagnostic for the life of the process, regardless of how many tips
  // main moves. Before the fix there was no such diagnostic (count 0) and instead one generic
  // per-tip "failed to build" warning — the 20× cluster the entry was filed against.
  const divergences = selfDivergence(events);
  assert.equal(divergences.length, 1, `one self-divergence diagnostic across 5 tips, got ${divergences.length}`);
  assert.ok(String(divergences[0]?.message).includes("restart the tumwater process to recover"));
  assert.ok(String(divergences[0]?.message).includes("running aaaaaaaa, staying put"));
  // The diagnostic names the binary, not any one commit.
  assert.equal(r.status(t).restartBlocked, "the running build cannot verify itself");
  // Nothing ever swapped in: a self-divergent build cannot verify its own deploy.
  assert.deepEqual(f.calls.swap, []);
  // The block is a typed transition the state stream replays.
  assert.ok(events.some((e) => e.type === "restart_blocked" && e.reason === "the running build cannot verify itself"));
});

test("a genuinely-red tip is a red-main block, never a self-divergence", async () => {
  // A commit the green check REJECTS (mainIsGreen false) is a bad commit, not a divergence:
  // it blocks on the red verdict and must NOT emit the self-divergence diagnostic. This is the
  // safety half of the fix — the discriminator must not over-fire on ordinary red tips.
  const f = fakeDeps({
    mainGreen: async () => false,
    compile: async () => ({ ok: false, detail: "tsc exited 2" }),
  });
  const { r, events } = harness(f.deps);
  const head = "red".repeat(20) + "0".repeat(20);
  let t = 0;
  for (let i = 0; i < 3; i++) {
    await driveTip(r, (t += 2 * MINUTE), head);
  }
  assert.equal(selfDivergence(events).length, 0, "a red tip is not self-divergence");
  assert.ok(String(r.status(t).restartBlocked ?? "").includes("is red"));
});
