import type { TumwaterConfig } from "./config-schema.js";
import type { LoopState } from "./loop-state.js";
import { allRoleIds, customRole, DIRECTOR_ROLE, roleById, unknownRoleMessage } from "./roles.js";
import { dequeuePrompt, dequeueRolePrompt, peekPrompt, peekRolePrompt } from "./inbox.js";
import { stripNotBeforeMarker } from "./prompt-not-before.js";
import { briefFile, readInitialPrompt } from "./readme.js";
import { buildDirectorPrompt, buildTickPrompt } from "./prompt.js";
import { readPrinciples } from "./principles.js";
import { buildCutOffNote } from "./prompt-followup.js";
import { buildConflictDiscardNote, buildRejectedReviewNote } from "./gate-prompts.js";
import { detectBuildCheck } from "./build-check-detect.js";
import { telemetryDigest } from "./telemetry-digest.js";
import { readQaCoverage, renderCoverageBlock } from "./qa-coverage.js";
import { renderBacklogStructureBlock } from "./backlog-structure.js";

/** One loop's inputs for assembling its tick prompt: read-only views of what LoopRunner
 * holds, so the assembly stays a pure function of (root, config, role, state). */
export interface TickPromptInput {
  root: string;
  config: TumwaterConfig;
  role: string;
  state: LoopState;
  /** Preview mode (`tumwater role <id>`'s next-prompt view): the queued prompt is peeked at,
   * not dequeued, so assembling a preview can never consume a queued request. Everything
   * else — brief, principles, check, the state-derived notes — is assembled identically. */
  preview?: boolean;
}

/** Assemble the prompt a loop's next tick runs on — the whole "what should this tick see"
 * concern, split out of loop.ts so the runner owns only lifecycle and the prompt owns only
 * content. Returns null when the loop has nothing to run this tick (a director with an empty
 * inbox); `userPrompt` carries the dequeued user request — the director's, or a per-role one
 * queued by `tumwater prompt --role <id>` — back so the runner can record it as pending and
 * re-queue it if the tick leaves it unfulfilled. */
export function assembleTickPrompt(
  { root, config, role, state, preview = false }: TickPromptInput,
): { prompt: string; userPrompt: string | null } | null {
  const initialPrompt = readInitialPrompt(root);
  // The brief's owning file (TUMWATER.md first, README.md as the compatibility path —
  // plans/portability.md §7a/7), named in both prompt builders' rules instead of a hardcoded
  // README.md. "README.md" is the fallback for a repo with no marked file yet — the fleet
  // runs blind on prompts either way, so the name in the rules should still point somewhere.
  const brief = briefFile(root) ?? "README.md";
  // The project's design principles ride along in every prompt — tick and director alike — so
  // all loops share one standard of taste. Empty when the repo has no PRINCIPLES.md.
  const principles = readPrinciples(root);
  // The project's resolved check (plans/portability.md §6/7): the prompt names the actual
  // verify command instead of asserting npm. Detection is a handful of stat calls — a
  // per-tick recompute keeps a config edit live on the next tick.
  const check = detectBuildCheck(root, config) ?? undefined;
  let prompt: string;
  let userPrompt: string | null = null;
  if (role === DIRECTOR_ROLE) {
    // A deferred director prompt's `tumwater:not-before` marker line is plumbing
    // (src/prompt-not-before.ts),
    // not content — stripped here exactly like the per-role path below, so the director's tick
    // prompt and the runner's re-queue both see the operator's text alone.
    const dequeued = preview ? peekPrompt(root) : dequeuePrompt(root);
    if (!dequeued) return null;
    userPrompt = stripNotBeforeMarker(dequeued);
    prompt = buildDirectorPrompt(userPrompt, initialPrompt, principles, check, brief);
  } else {
    // Catalog first, then user-defined loops (plans/user-defined-loops.md): a custom's task
    // is its entire find-something-to-do text and the title identifies it in the prompt.
    const custom = config.customLoops.find((c) => c.name === role);
    const resolved = roleById(role) ?? (custom ? customRole(custom.name, custom.task) : undefined);
    if (!resolved) {
      // The shared unknownRoleMessage (parseRoleFlag, the operator commands) names the valid
      // ids; this defensive path — a runner asked to tick a role no catalog entry or
      // customLoops task can answer — says the same, so if it ever fires it reads as the
      // harness bug it is instead of a bare dead end.
      const validIds = [...allRoleIds(), ...config.customLoops.map((c) => c.name)];
      throw new Error(unknownRoleMessage(role, validIds));
    }
    // A queued per-role prompt is dequeued here, before the prompt is built, so its text rides
    // in the tick's prompt; loop.ts's runner records it as pending and re-queues it on every
    // unfulfilled outcome — including a red-main gate block, which returns before any run.
    // A deferred prompt's `tumwater:not-before` marker line is plumbing
    // (src/prompt-not-before.ts), not
    // content: it is stripped at delivery, so the loop sees the operator's text alone and the
    // runner's re-queue writes clean text.
    const dequeued = preview ? peekRolePrompt(root, role) : dequeueRolePrompt(root, role);
    const request = dequeued === null ? null : stripNotBeforeMarker(dequeued);
    // The telemetry role's evidence is the harness's own event log, one level outside this
    // worktree, so its evidence module renders it (telemetryDigest) and the tick injects it.
    const digest = role === "telemetry" ? telemetryDigest(root) : undefined;
    // The `qa` observer's flow rotation needs a memory of what it last exercised; every tick
    // is a fresh session, and a passing cheap check leaves nothing in the repo. The ledger is
    // runtime state, and a missing or unreadable one degrades to no block (plans/observer-roles.md 2/2).
    let coverage: string | undefined;
    if (role === "qa") {
      try {
        coverage = renderCoverageBlock(readQaCoverage(root));
      } catch {
        coverage = undefined;
      }
    }
    // The clean role's deterministic backlog repair: stranded plan headings in the primary
    // checkout's PLANS.md (plans, part 3/4), rendered like the digest and coverage blocks.
    // An unreadable or clean file gives no block, so the prompt is unchanged in the common case.
    const backlogStructure = role === "clean" ? renderBacklogStructureBlock(root) : undefined;
    prompt = buildTickPrompt({
      role: resolved,
      initialPrompt,
      principles,
      digest,
      coverage,
      backlogStructure,
      extraInstructions: config.roles[role]?.instructions,
      check,
      briefFile: brief,
      // A per-role prompt queued by `tumwater prompt --role <id>` rides as an explicit user
      // request block (PLANS.md "Per-role prompts 1/2"); its text is also the tick's userPrompt,
      // so the runner's pending-prompt machinery (re-queue on unfulfilled, clear on landing)
      // treats it exactly like the director's dequeued request.
      userRequest: request ?? undefined,
    });
    if (request) userPrompt = request;
  }
  // A change rejected in review is the only cross-tick memory of what was built and why it
  // failed — every tick starts a fresh session, so the full reasons ride along on the next
  // prompt until the role's next reviewed change replaces them.
  if (state.lastReview?.verdict === "reject") {
    prompt += `\n\n${buildRejectedReviewNote(state.lastReview)}`;
  }
  // Likewise a change leftover recovery discarded as unmergeable: named until the role queues
  // its next change (the discarding tick itself appends it after recovery — see runTick).
  const discard = state.conflictDiscard;
  if (discard) prompt += `\n\n${buildConflictDiscardNote(discard.summary, discard.attempts)}`;
  // A fresh tick after the previous run(s) were cut off at the context ceiling (the loop
  // stopped resuming, or never resumed — the director re-runs its prompt fresh): the only
  // memory that the last attempt was too big for the window is this note.
  if ((state.cutOffStreak ?? 0) > 0) {
    prompt += `\n\n${buildCutOffNote(state.cutOffStreak ?? 0)}`;
  }
  return { prompt, userPrompt };
}
