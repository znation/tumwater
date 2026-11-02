import fs from "node:fs";
import path from "node:path";
import type { MergeRequest, MergerContext } from "../../src/merge/merge-core.js";
import { mergeApprovedChange } from "../../src/merge/merge-core.js";
import { verifyRequest, type BatchRoleWiring } from "../../src/merge/merge-batch.js";
import { setRef } from "../../src/git/git.js";
import { ensureWorktree } from "../../src/git/worktree.js";
import { mergeRefName } from "../../src/paths.js";
import { defaultConfig } from "../../src/config/config.js";
import type { RunResult } from "../../src/run/run-outcome.js";
import type { PiRunResult } from "../../src/pi/pi-run-result.js";
import type { RunnerState } from "../../src/runner/runner-state.js";
import { projManifest, writeScript } from "../fakes/fake-commands.js";
import { mainSha, makeRepo, pinOffMain, sh } from "./repo-fixtures.js";
import { piRunResult } from "../fakes/fake-pi.js";
import { runPi } from "../../src/pi/pi.js";
import { ensureParentDir } from "../../src/files/files.js";

/** Shared fixtures for the merge tests — merger.test.ts and the slices split from it
 * (merger-check, merger-batch, merger-restack, merger-bisect, merger-fallback), split from one
 * file so node --test runs them in parallel processes (top-level tests within a file run one
 * after another; each file gets its own process, and its own PATH for fakePi's global swap).
 * Contexts and wiring built the way the merge drain builds them, pinned-change repos in the
 * queue shape the pipeline reads, and reviewer/check shims. */

export const ROLE = "improve";
export const REF = mergeRefName(ROLE);

/** A compliant pi run result for the stubbed conflict-resolution runs. */
export function piResult(over: Partial<PiRunResult> = {}): PiRunResult {
  return piRunResult({ finalText: "resolved", ...over });
}

export interface PiCall {
  wt: string;
  prompt: string;
  session: string;
}

/** A MergerContext wired like merge-batch.ts does: real config/state, a recording runPi stub
 * for the conflict resolver (which may also mutate the worktree via `resolve`), and an abortable
 * signal. */
export function makeCtx(
  root: string,
  state: RunnerState,
  resolve?: (wt: string) => void,
): { ctx: MergerContext; calls: PiCall[]; folded: PiRunResult[]; controller: AbortController } {
  const calls: PiCall[] = [];
  const folded: PiRunResult[] = [];
  const controller = new AbortController();
  const ctx: MergerContext = {
    root,
    mainBranch: "main",
    config: defaultConfig(),
    // No in-place reviewer retries unless a test opts in: most cases count one run per verify.
    reviewRetries: 0,
    reviewRetryDelayMs: 0,
    state,
    runPi: async (wt, prompt, session) => {
      calls.push({ wt, prompt, session });
      resolve?.(wt);
      return piResult();
    },
    runGatePi: async (opts) => runPi(opts),
    foldUsage: (run) => folded.push(run),
    signal: () => controller.signal,
  };
  return { ctx, calls, folded, controller };
}

/** A repo with one commit NOT contained in main, pinned by the merge ref — exactly what
 * runner.ts leaves behind after pinAndReset. The role worktree is created at main (clean), as the
 * reset left it. */
export async function pinnedFixture(): Promise<{ root: string; sha: string; wt: string }> {
  const root = makeRepo();
  const sha = pinOffMain(
    root,
    (d) => fs.appendFileSync(path.join(d, "seed.txt"), "the work\n"),
    "the work",
  );
  await setRef(root, REF, sha);
  const wt = await ensureWorktree(root, ROLE, "main"); // the role worktree: clean at main
  return { root, sha, wt };
}

// The reviewer's fake-pi shim and its approver preset live in pi-events.ts (next to the
// assistant-line helpers they build on); re-exported here for the merger fixtures' imports.
export { reviewerPi, APPROVE_PI } from "./pi-events.js";

export function request(sha: string, overrides: Partial<MergeRequest> = {}): MergeRequest {
  return { role: ROLE, sha, runNumber: 7, summary: "the work", ...overrides };
}

/** The BatchRoleWiring a test context implies: its own state and pi/fold halves, so the
 * hand-assembled literal cannot drift from the context it stubs. */
export function batchWiring(ctx: MergerContext): BatchRoleWiring {
  return {
    state: ctx.state,
    foldUsage: ctx.foldUsage,
    runPi: ctx.runPi,
    runGatePi: (opts) => ctx.runGatePi(opts),
  };
}

/** Merge one pinned change the way the pipeline does — its verify, then (approved) a one-change
 * merge through mergeApprovedChange — over one MergerContext's wiring, returning the outcome the
 * pipeline writes back. */
export async function verifyAndMerge(ctx: MergerContext, req: MergeRequest): Promise<RunResult> {
  const w = batchWiring(ctx);
  const v = await verifyRequest(ctx, req, w);
  if (v.kind === "result") return v.result;
  return mergeApprovedChange(ctx, { ...req, sha: v.sha, ...(v.verifiedHead ? { verifiedHead: v.verifiedHead } : {}) });
}

/** Shell that numbers this check run into `$n`, atomically: `mkdir` either creates
 * `<base>.<n>` or fails, so two checks running at once (the pipeline verifies changes
 * concurrently) can never both read the same count the way a read-increment-write counter
 * file does. Runs number 1, 2, … in start order. */
export const checkRunNumber = (base: string): string =>
  `n=1\nwhile ! mkdir '${base}'.$n 2>/dev/null; do n=$((n+1)); done\n`;

/** Declare the project's build check the way detectBuildCheck finds it: an install
 * signature (package.json + node_modules) at the root, the tool in node_modules/.bin. The
 * worktree resolves the toolchain from the installed root, as in the dogfood layout. */
export function declareCheck(root: string, toolBody: string): void {
  const tool = path.join(root, "node_modules", ".bin", "buildcheck-tool");
  ensureParentDir(tool);
  writeScript(tool, toolBody);
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ build: "buildcheck-tool" }),
  );
}

/** Shell that parks the check until the test drops `release` (bounded at 60 s, so a broken
 * test can never hang the suite), after first announcing itself through `started`. */
export const parkUntil = (started: string, release: string): string =>
  `touch ${started}; i=0; while [ ! -f ${release} ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done`;

/** Advance main past the fixture's pins with one commit touching only `file` — the "pins
 * based on an older main" shape: the queue's pins were taken before other merges moved
 * main. Only `file` is staged, so an untracked declared check at the root stays untracked. */
export function advanceMain(root: string, file: string, content: string): string {
  fs.writeFileSync(path.join(root, file), content);
  sh(root, "git", "add", file);
  sh(root, "git", "commit", "-m", `main moves: ${file}`);
  return mainSha(root);
}
