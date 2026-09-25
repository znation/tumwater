import fs from "node:fs";
import path from "node:path";
import type { LandRequest, LanderContext } from "../src/lander.js";
import { landVetted, vetRequest, type BatchContext, type BatchRoleWiring } from "../src/land-batch.js";
import { setRef } from "../src/git.js";
import { ensureWorktree } from "../src/worktree.js";
import { eventsLogPath, landingRefName } from "../src/paths.js";
import { defaultConfig } from "../src/config.js";
import { freshLoopState } from "../src/state.js";
import { readEvents } from "../src/events.js";
import type { TumwaterConfig } from "../src/config-schema.js";
import type { LoopState, PiRunResult, TickResult } from "../src/types.js";
import { assistantLine, makeRepo, sh, writeScript } from "./util.js";

/** Shared fixtures for the landing tests — lander.test.ts, lander-2.test.ts and lander-3.test.ts,
 * split from one file so node --test runs the three in parallel processes (top-level tests
 * within a file run one after another; each file gets its own process, and its own PATH for
 * fakePi's global swap). Contexts and wiring built the way loop.ts and the landing drain build
 * them, pinned-change repos in the queue shape the pipeline reads, and reviewer/check shims. */

export const ROLE = "improve";
export const REF = landingRefName(ROLE);

/** A compliant pi run result for the stubbed conflict-resolution runs. */
export function piResult(): PiRunResult {
  return {
    ok: true,
    finalText: "resolved",
    nothingToDo: false,
    refused: false,
    outputTokens: 0,
    peakContextTokens: 0,
    turns: 1,
    costUsd: 0,
    timedOut: false,
    quietKilled: false,
    aborted: false,
    contextExceeded: false,
    transientServerTimeout: false,
    transientRateLimit: false,
    transientPiCrash: false,
    finalMessageContentless: false,
    compacted: false,
  };
}

export interface PiCall {
  wt: string;
  prompt: string;
  session: string;
}

/** A LanderContext wired like loop.ts does: real config/state, a recording runPi stub for the
 * conflict resolver (which may also mutate the worktree via `resolve`), and an abortable signal. */
export function makeCtx(
  root: string,
  state: LoopState,
  resolve?: (wt: string) => void,
): { ctx: LanderContext; calls: PiCall[]; folded: PiRunResult[]; controller: AbortController } {
  const calls: PiCall[] = [];
  const folded: PiRunResult[] = [];
  const controller = new AbortController();
  const ctx: LanderContext = {
    root,
    mainBranch: "main",
    config: defaultConfig(),
    state,
    runPi: async (wt, prompt, session) => {
      calls.push({ wt, prompt, session });
      resolve?.(wt);
      return piResult();
    },
    foldUsage: (run) => folded.push(run),
    signal: () => controller.signal,
  };
  return { ctx, calls, folded, controller };
}

/** A repo with one commit NOT contained in main, pinned by the landing ref — exactly what
 * loop.ts leaves behind after pinAndReset. The role worktree is created at main (clean), as the
 * reset left it. */
export async function pinnedFixture(): Promise<{ root: string; sha: string; wt: string }> {
  const root = makeRepo();
  sh(root, "git", "checkout", "--detach");
  fs.appendFileSync(path.join(root, "seed.txt"), "the work\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "the work");
  const sha = sh(root, "git", "rev-parse", "HEAD").trim();
  sh(root, "git", "checkout", "main");
  await setRef(root, REF, sha);
  const wt = await ensureWorktree(root, ROLE, "main"); // the role worktree: clean at main
  return { root, sha, wt };
}

/** The reviewer's fake-pi shim: match the review run (the only run whose args carry a
 * VERDICT-bearing prompt), print `reply` as its one assistant turn, exit 0 — the gate reads
 * the verdict out of `reply`. Author-run shims live in test/util.ts. */
export const reviewerPi = (reply: string): string =>
  `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '${assistantLine(reply)}'; exit 0;; esac; done`;

export function request(sha: string, overrides: Partial<LandRequest> = {}): LandRequest {
  return { role: ROLE, sha, tick: 7, summary: "the work", ...overrides };
}

/** Land one pinned change the way the pipeline does — its vet, then (approved) a one-change
 * merge — over one LanderContext's wiring, returning the outcome the pipeline writes back. */
export async function vetAndLand(ctx: LanderContext, req: LandRequest): Promise<TickResult> {
  const w: BatchRoleWiring = { state: ctx.state, foldUsage: ctx.foldUsage, runPi: ctx.runPi };
  const v = await vetRequest(ctx, req, w);
  if (v.kind === "result") return v.result;
  const [result] = await landVetted(ctx, [{ ...req, sha: v.sha, ...(v.verifiedHead ? { verifiedHead: v.verifiedHead } : {}) }], () => w);
  return result!;
}

/** Shell that numbers this check run into `$n`, atomically: `mkdir` either creates
 * `<base>.<n>` or fails, so two checks running at once (the pipeline vets changes
 * concurrently) can never both read the same count the way a read-increment-write counter
 * file does. Runs number 1, 2, … in start order. */
export const checkRunNumber = (base: string): string =>
  `n=1\nwhile ! mkdir '${base}'.$n 2>/dev/null; do n=$((n+1)); done\n`;

/** A repo where every listed role has a single-commit pin based on main — the queue shape
 * the pipeline reads. One separate file per role by default so cherry-picks apply
 * cleanly; `edit` overrides the per-role change (the conflict test rewrites one line). */
export async function batchPinnedFixture(
  roles: string[],
  edit?: (root: string, role: string) => void,
): Promise<{ root: string; shas: Record<string, string> }> {
  const root = makeRepo();
  sh(root, "git", "checkout", "--detach");
  const shas: Record<string, string> = {};
  for (const role of roles) {
    // Each pin stands alone on main (independent branches, not a stack): the batch's
    // cherry-pick and the fallback's rebase then actually rewrite the second change.
    sh(root, "git", "reset", "--hard", "main");
    if (edit) edit(root, role);
    else fs.appendFileSync(path.join(root, `${role}.txt`), `work by ${role}\n`);
    sh(root, "git", "add", "-A");
    sh(root, "git", "commit", "-m", `work by ${role}`);
    const sha = sh(root, "git", "rev-parse", "HEAD").trim();
    shas[role] = sha;
    await setRef(root, landingRefName(role), sha);
  }
  sh(root, "git", "checkout", "main");
  return { root, shas };
}

/** Declare the project's build check the way detectBuildCheck finds it: an install
 * signature (package.json + node_modules) at the root, the tool in node_modules/.bin. The
 * worktree resolves the toolchain from the installed root, as in the dogfood layout. */
export function declareCheck(root: string, toolBody: string): void {
  const tool = path.join(root, "node_modules", ".bin", "buildcheck-tool");
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  writeScript(tool, toolBody);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool" } }),
  );
}

export const APPROVE_PI = reviewerPi("VERDICT: approve");

export function makeBatchCtx(root: string, config?: TumwaterConfig, controller?: AbortController): BatchContext {
  return {
    root,
    mainBranch: "main",
    config: config ?? defaultConfig(),
    signal: () => (controller ?? new AbortController()).signal,
  };
}

/** Per-role wiring resolved the way the drain resolves its authors: a live state object per
 * role, usage recorded per role, and the shared runPi stub (with an optional resolver) for
 * the one-at-a-time fallback landings. */
export function makeWiring(
  states: Record<string, LoopState>,
  resolve?: (wt: string) => void,
): { wiringFor: (role: string) => BatchRoleWiring; folded: Map<string, PiRunResult[]>; calls: PiCall[] } {
  const folded = new Map<string, PiRunResult[]>();
  const calls: PiCall[] = [];
  const wiringFor = (role: string): BatchRoleWiring => ({
    state: states[role]!,
    foldUsage: (run) => folded.set(role, [...(folded.get(role) ?? []), run]),
    runPi: async (wt, prompt, session) => {
      calls.push({ wt, prompt, session });
      resolve?.(wt);
      return piResult();
    },
  });
  return { wiringFor, folded, calls };
}

/** A batch test's whole fixture in one call: one pinned change per role (the queue shape the
 * drain reads), a live state per role, and the per-role wiring to land them — the setup every
 * batch test below otherwise spells out as batchPinnedFixture + states + makeWiring. `edit`
 * and `resolve` pass through to the fixture and wiring. */
export async function batchFixture<R extends string>(
  roles: R[],
  opts: { edit?: (root: string, role: string) => void; resolve?: (wt: string) => void } = {},
): Promise<{
  root: string;
  shas: Record<string, string>;
  states: Record<R, LoopState>;
  wiringFor: (role: string) => BatchRoleWiring;
  folded: Map<string, PiRunResult[]>;
  calls: PiCall[];
}> {
  const { root, shas } = await batchPinnedFixture(roles, opts.edit);
  const states = Object.fromEntries(roles.map((role) => [role, freshLoopState(role)])) as Record<R, LoopState>;
  return { root, shas, states, ...makeWiring(states, opts.resolve) };
}

/** Vet `requests` one after another, in queue order, then merge every approved one as the
 * pipeline's merge slot does (landVetted): each request's result, `undefined` when the merge left
 * it unattempted. A vet's own verdict is final for its request, exactly as the pipeline writes it
 * back at once; only the approved ones reach the merge. */
export async function vetThenMerge(
  ctx: BatchContext,
  requests: LandRequest[],
  wiringFor: (role: string) => BatchRoleWiring,
): Promise<Array<{ req: LandRequest; result?: TickResult }>> {
  const results: Array<{ req: LandRequest; result?: TickResult }> = requests.map((req) => ({ req }));
  const vetted: Array<{ at: number; req: LandRequest }> = [];
  for (const [at, req] of requests.entries()) {
    const v = await vetRequest(ctx, req, wiringFor(req.role));
    if (v.kind === "result") results[at]!.result = v.result;
    else vetted.push({ at, req: { ...req, sha: v.sha, ...(v.verifiedHead ? { verifiedHead: v.verifiedHead } : {}) } });
  }
  if (vetted.length === 0) return results;
  const merged = await landVetted(ctx, vetted.map((v) => v.req), wiringFor);
  merged.forEach((result, s) => {
    if (result !== undefined) results[vetted[s]!.at]!.result = result;
  });
  return results;
}

/** The standard vet-and-merge over a fixture's pinned changes, in `roles` order — the
 * makeBatchCtx + one-request-per-role call every batch test otherwise spells out. */
export function runBatch(
  root: string,
  shas: Record<string, string>,
  roles: string[],
  wiringFor: (role: string) => BatchRoleWiring,
  controller?: AbortController,
) {
  return vetThenMerge(
    makeBatchCtx(root, undefined, controller),
    roles.map((role) => request(shas[role]!, { role })),
    wiringFor,
  );
}

// A test that cares WHICH vet does what keys its reviewer on the change under review, and one
// that cares about order waits on an event rather than guessing a sleep long enough for a
// loaded host.

/** The shell that prints `reply` as a review run's one assistant turn. */
export const replyLine = (reply: string): string => `printf '%s\\n' '${assistantLine(reply)}'`;

/** A reviewer shim whose review run behaves per change: pi's cwd is the gate's
 * `_land-<role>` worktree, so `$PWD` names the change under review. `byRole` maps a role to
 * the shell its review run executes; every other role runs `otherwise` (approve at once). */
export function reviewerByRole(byRole: Record<string, string>, otherwise = replyLine("VERDICT: approve")): string {
  return [
    `for a in "$@"; do case "$a" in *"VERDICT:"*)`,
    `case "$PWD" in`,
    ...Object.entries(byRole).map(([role, body]) => `*_land-${role}) ${body} ;;`),
    `*) ${otherwise} ;;`,
    `esac; exit 0;;`,
    `esac; done`,
  ].join("\n");
}

/** Shell that holds a review run until the events log records `loop`'s `type` event — bounded
 * at ~30 s, so a regression fails the assertions instead of hanging the suite. */
export const awaitEvent = (root: string, loop: string, type: string): string =>
  `i=0; until grep -q '"loop":"${loop}","type":"${type}"' '${eventsLogPath(root)}' 2>/dev/null || [ $i -ge 300 ]; do sleep 0.1; i=$((i+1)); done; `;

/** A counting build check: `$n` is the invocation's 1-based number (checkRunNumber) — runs 1
 * and 2 are the two vets' gate pre-checks, run 3 is the stack's first shared check — and `body`
 * runs before the check
 * passes (or fails, if `body` exits nonzero). */
export function countingCheck(root: string, body: string): void {
  const count = path.join(root, ".checkcount");
  declareCheck(root, `#!/bin/sh\n${checkRunNumber(count)}${body}\necho ok\n`);
}

/** Shell that lands one commit on main from inside a running check — the primary checkout
 * sits on main, so a commit there is main moving under the batch. `line` is single-quoted
 * into the script, so it must not contain a quote itself. */
export const commitOnMain = (root: string, file: string, line: string): string =>
  `echo '${line}' >> ${path.join(root, file)} && git -C ${root} add ${file} && git -C ${root} commit -q -m 'concurrent ${file}'`;

/** Shell that parks the check until the test drops `release` (bounded at 60 s, so a broken
 * test can never hang the suite), after first announcing itself through `started`. */
export const parkUntil = (started: string, release: string): string =>
  `touch ${started}; i=0; while [ ! -f ${release} ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done`;

export const batchChecks = (root: string) =>
  readEvents(root).filter((e) => e.type === "build_check" && e.scope === "batch");

/** A check that passes its first `gates` runs (the vets' gate pre-checks, which all run
 * before any batch check) and afterwards runs `after` — which sees `$n`, and the invoking
 * worktree as `$INIT_CWD` (npm runs the script at the package root). */
export function checkAfterGates(root: string, gates: number, after: string): void {
  const count = path.join(root, ".checkcount");
  declareCheck(root, `#!/bin/sh\n${checkRunNumber(count)}if [ "$n" -gt ${gates} ]; then ${after}; fi\necho ok\n`);
}

/** Advance main past the fixture's pins with one commit touching only `file` — the "pins
 * based on an older main" shape: the queue's pins were taken before other landings moved
 * main. Only `file` is staged, so an untracked declared check at the root stays untracked. */
export function advanceMain(root: string, file: string, content: string): string {
  fs.writeFileSync(path.join(root, file), content);
  sh(root, "git", "add", file);
  sh(root, "git", "commit", "-m", `main moves: ${file}`);
  return sh(root, "git", "rev-parse", "main").trim();
}

/** A reviewer shim that answers per lander worktree: `replies[role]` for the review running
 * in that role's `_land-<role>` worktree, an approval for every other role. */
export const perRoleReviewerPi = (replies: Record<string, string>): string =>
  [
    `r='${assistantLine("VERDICT: approve")}'`,
    ...Object.entries(replies).map(([role, reply]) => `case "$PWD" in *_land-${role}) r='${assistantLine(reply)}';; esac`),
    `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' "$r"; exit 0;; esac; done`,
  ].join("\n");

/** A vet-and-merge run with the merge's status hook recorded as `role:status`, in call order —
 * the reports the pipeline mirrors into each change's marker record once it merges. */
export async function runBatchRecorded(
  root: string,
  shas: Record<string, string>,
  roles: string[],
  wiringFor: (role: string) => BatchRoleWiring,
): Promise<{ results: Array<TickResult | undefined>; seen: string[] }> {
  const seen: string[] = [];
  const results = await vetThenMerge(
    { ...makeBatchCtx(root), onChangeStatus: (role, status) => seen.push(`${role}:${status}`) },
    roles.map((role) => request(shas[role]!, { role })),
    wiringFor,
  );
  return { results: results.map((r) => r.result), seen };
}
