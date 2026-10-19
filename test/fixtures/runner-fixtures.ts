/** Fixtures around a LoopRunner and the build/baseline shapes its gates need: the constructor
 * call every loop test repeats, the counter-seeding and counter-reading pair, and the two
 * scratch-project shapes the build check and the main-baseline gate expect. The live
 * orchestrator tier has its own scaffolding in orchestrator-fixtures.ts; the fake toolchain
 * scripts these fixtures install come from fake-commands.ts. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { defaultConfig } from "../../src/config/config.js";
import { LoopRunner } from "../../src/runner/runner.js";
import { freshLoopState, loadLoopState, saveLoopState, type LoopState } from "../../src/runner/runner-state.js";
import { recordDailyCost } from "../../src/budget/budget.js";
import type { TumwaterConfig } from "../../src/config/config-schema.js";
import { gitInit, sh, tmpdir } from "./repo-fixtures.js";
import { pathPrepend, projManifest, writeScript } from "../fakes/fake-commands.js";
import { ensureParentDir } from "../../src/files/files.js";
import { readSlotsState, updateSlotsState } from "../../src/git/slots-state.js";
import { mergeRefName, worktreePath } from "../../src/paths.js";
import { headMerge, queueDepth } from "../../src/merge/merge-queue.js";
import { enqueuePrompt, inboxSize } from "../../src/inbox/inbox.js";
import { mergeHead } from "./orchestrator-fixtures.js";
import { withPi } from "../fakes/fake-pi.js";
import { assistantLine } from "./pi-events.js";
import { waitForFile } from "../helpers/wait.js";

/** A real LoopRunner for one role — the constructor call every loop test repeats with the
 * same `defaultConfig()` and `"main"` trailing arguments, so those stay implied here and a
 * test states only what differs (config, base branch, abort signal). Cheap by design: the
 * constructor only loads loop state from disk and starts no processes. */
export function makeLoopRunner(
  repo: string,
  role: string,
  config: TumwaterConfig = defaultConfig(),
  mainBranch = "main",
  signal?: AbortSignal,
  sleep?: (ms: number) => Promise<void>,
): LoopRunner {
  return new LoopRunner(repo, role, config, mainBranch, signal, sleep);
}

/** The directory a role's tick runs (or ran) in, resolving the pooled layout: the slot leased
 * for the role, else the slot pinned for it, else the free slot it released most recently,
 * else the legacy `.tumwater/worktrees/<role>` path. Non-director ticks lease a slot since
 * plans/worktree-pool.md part 4b, so a test that reads a role's checkout resolves it here
 * instead of assuming the legacy path. */
export function roleWt(root: string, role: string): string {
  const slots = readSlotsState(root).slots;
  const leased = slots.find((slot) => slot.lease?.role === role && slot.lease.purpose === "run");
  if (leased !== undefined) return leased.dir;
  const pinned = slots.find((slot) => slot.pinnedFor === role);
  if (pinned !== undefined) return pinned.dir;
  const released = slots.find((slot) => slot.lease === null && slot.lastRole === role);
  if (released !== undefined) return released.dir;
  return worktreePath(root, role);
}

/** Drive a director tick whose merge review is aborted once the verification's pooled checkout
 * appears: the tick commits and pins (result "queued"), the merge runs under its own
 * AbortSignal, and the abort kills the hung reviewer (the fake pi script loops on the
 * VERDICT review prompt and sleeps). Asserts the fail-closed shape a shutdown and
 * `tumwater abort` share at the loop level — nothing merged, the pin survives for next-start
 * recovery, the queue entry is dropped, and the completed tick consumed the prompt — so the
 * user-abort (runner-5.test.ts) and shutdown (runner-leftover-recovery.test.ts) tests state only
 * their framing. Only meaningful for a director tick, whose merge carries the review. */
export async function runAbortedDirectorMerge(repo: string): Promise<void> {
  await withPi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) exec sleep 30;; esac; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file")}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
    async () => {
      const controller = new AbortController();
      try {
        enqueuePrompt(repo, "ship the hello file");
        const runner = makeLoopRunner(repo, "director");
        const outcome = await runner.tick();
        assert.equal(outcome.result, "queued", "the tick ends at the pin; the review is the merge's");
        const head = headMerge(repo);
        assert.ok(head, "the merge is queued");
        const merge = mergeHead(repo, runner, defaultConfig(), "director", "main", controller.signal);
        // Abort only once the verification's pooled checkout exists: an earlier abort hits nothing.
        await waitForFile(path.join(repo, ".tumwater/worktrees/_slot-1"));
        controller.abort();
        assert.equal(await merge, "aborted", "a mid-review abort is an abort, not a failed review");

        // Fail closed: nothing merged — the role worktree is clean at main and the pin survives
        // the abort for next-start recovery. The queue entry is dropped; the prompt was consumed
        // by the completed tick, so recovery rides the pin, never a re-queued prompt.
        assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/director"), "0");
        const pinned = sh(repo, "git", "rev-parse", "--verify", mergeRefName("director")).trim();
        assert.ok(pinned.length === 40, "the pin survived the aborted merge");
        assert.ok(!fs.existsSync(path.join(repo, "hello.txt")), "nothing merged on main");
        assert.equal(queueDepth(repo), 0, "the entry is dropped after the aborted merge");
        assert.equal(inboxSize(repo), 0);
        const s = loadLoopState(repo, "director");
        assert.equal(s.lastResult, "aborted");
        assert.ok(!s.resumePending, "the director never resumes an author session");
        assert.ok(s.nextRunAt > Date.now(), "recovery runs at the role's normal cadence");
      } finally {
        // Kill any in-flight fake pi before PATH is restored.
        controller.abort();
      }
    },
  );
}

/** Register an existing checkout as a slot pinned for `role`: the shape an interrupted tick
 * leaves behind (its slot pinned with the branch checked out and its edits uncommitted), so a
 * test can seed that state without depending on the legacy path. The lease with
 * `{ keep: true }` then chooses it and preserves it. */
export function pinWorktreeAsSlot(root: string, role: string, dir: string): void {
  updateSlotsState(root, (state) => {
    state.slots.push({ dir, lease: null, pinnedFor: role, lastRole: null, lastReleasedAt: null });
  });
}

/** Scratch project for the build-check tests (build-check.test.ts and review.test.ts's gate
 * integration): `root` has package.json + a fake toolchain in node_modules/.bin; `wt` sits
 * INSIDE it at the real worktree location (`.tumwater/worktrees/improve`) with its own tracked
 * package.json and no install — so root is an ancestor, as detectBuildCheck requires. */
export function buildCheckFixture(): { root: string; wt: string } {
  const base = tmpdir("buildcheck-");
  const root = path.join(base, "project");
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ build: "buildcheck-tool --ok" }),
  );
  writeScript(path.join(binDir, "buildcheck-tool"), "echo buildcheck-ok");

  const wt = path.join(root, ".tumwater", "worktrees", "improve");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ build: "buildcheck-tool --ok" }),
  );
  return { root, wt };
}

/** A git repo whose main is "installed" (package.json + node_modules at root) with a linked
 * worktree checked out to it — the shape checkMainBaseline expects (a pristine main HEAD) —
 * shared by main-red.test.ts and main-baseline.test.ts. `testScript` is committed to main so
 * the worktree's checkout carries it; node_modules stays untracked — the install marker
 * detectBuildCheck walks up to, gitignored in real projects. Each fixture gets its own temp
 * dir, hence its own SHA: the gate's verdict cache and red-SHA warning state are module-level,
 * so tests must never share a HEAD. */
/** A fake `npm` executable at the front of PATH for the duration of a test (the repo's real
 * npm must never run in unit tests) — writeScript + pathPrepend assembled into the one shape
 * the baseline-gate tests need: a body script, a restore function. Shared by the main-red and
 * attribute-red-check suites, which both stage their gate scenarios over baselineFixture. */
export function fakeNpm(script: string): () => void {
  const dir = tmpdir("fake-npm-");
  writeScript(path.join(dir, "npm"), script);
  return pathPrepend(dir);
}

export function baselineFixture(role: string, testScript: string): { root: string; wt: string } {
  const root = path.join(tmpdir("baseline-"), "project");
  fs.mkdirSync(root, { recursive: true });
  gitInit(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ test: testScript }),
  );
  fs.mkdirSync(path.join(root, "node_modules")); // untracked install marker
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed");
  const wt = path.join(root, ".tumwater", "worktrees", role);
  ensureParentDir(wt);
  sh(root, "git", "worktree", "add", "-b", `tumwater/${role}`, wt, "main");
  return { root, wt };
}

/** A fresh `role` state already carrying `usd` of today's spend, recorded at `at` (the real
 * clock by default, matching the gates' own Date.now() read) — the shared home of the
 * freshLoopState + recordDailyCost pair used by the gate-poll, budget-gate, role-cap-gate,
 * gate-event-best-effort, loop-id, and status-snapshot suites. A test that needs the state
 * persisted calls saveLoopState(root, state) itself; a suite whose subject is recordDailyCost
 * itself still calls it directly. */
export function spentLoopState(role: string, usd: number, at?: number): LoopState {
  const state = freshLoopState(role);
  recordDailyCost(state, usd, at);
  return state;
}

/** Seed each role's state file with non-zero counters plus scheduling fields. Variadic so a
 * multi-role test seeds all its runners through this one home (the reset tests do). */
export function seedCounters(repo: string, ...roles: string[]): void {
  for (const role of roles) seedOneCounter(repo, role);
}

function seedOneCounter(repo: string, role: string): void {
  const s = freshLoopState(role);
  s.runs = 7;
  s.commits = 3;
  s.generatedTokens = 424242;
  s.totalCostUsd = 1.5;
  s.peakContextTokens = 65536; // last tick's peak — cleared by the reset
  s.nextRunAt = Date.now() + 60_000;
  s.backoffSeconds = 15;
  s.lastMainHead = "deadbeef";
  saveLoopState(repo, s);
}

/** How many times a fixture's test script actually ran (its appends to `counter`). Zero when
 * the counter was never written — an environmental skip ran nothing. */
export function runsOf(counter: string): number {
  try {
    return fs.readFileSync(counter, "utf8").trim().split("\n").length;
  } catch {
    return 0;
  }
}
