import type { TumwaterConfig } from "./config-schema.js";
import type { LoopState } from "./types.js";
import { customRole, DIRECTOR_ROLE, roleById } from "./roles.js";
import { dequeuePrompt } from "./inbox.js";
import { briefFile, readInitialPrompt } from "./readme.js";
import { buildCutOffNote, buildDirectorPrompt, buildTickPrompt, readPrinciples } from "./prompt.js";
import { buildConflictDiscardNote, buildRejectedReviewNote } from "./gate-prompts.js";
import { detectBuildCheck } from "./build-check-detect.js";
import { telemetryDigest } from "./failure-report.js";
import { readQaCoverage, renderCoverageBlock } from "./qa-coverage.js";

/** One loop's inputs for assembling its tick prompt: read-only views of what LoopRunner
 * holds, so the assembly stays a pure function of (root, config, role, state). */
export interface TickPromptInput {
  root: string;
  config: TumwaterConfig;
  role: string;
  state: LoopState;
}

/** Assemble the prompt a loop's next tick runs on — the whole "what should this tick see"
 * concern, split out of loop.ts so the runner owns only lifecycle and the prompt owns only
 * content. Returns null when the loop has nothing to run this tick (a director with an empty
 * inbox); `userPrompt` carries the dequeued director request back so the runner can record it
 * as pending and re-queue it if the tick leaves it unfulfilled. */
export function assembleTickPrompt(
  { root, config, role, state }: TickPromptInput,
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
    const dequeued = dequeuePrompt(root);
    if (!dequeued) return null;
    userPrompt = dequeued;
    prompt = buildDirectorPrompt(dequeued, initialPrompt, principles, check, brief);
  } else {
    // Catalog first, then user-defined loops (plans/user-defined-loops.md): a custom's task
    // is its entire find-something-to-do text and the title identifies it in the prompt.
    const custom = config.customLoops.find((c) => c.name === role);
    const resolved = roleById(role) ?? (custom ? customRole(custom.name, custom.task) : undefined);
    if (!resolved) throw new Error(`unknown role: ${role}`);
    // The telemetry role's evidence is the harness's own event log, one level outside this
    // worktree, so the report module renders it (telemetryDigest) and the tick injects it.
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
    prompt = buildTickPrompt({
      role: resolved,
      initialPrompt,
      principles,
      digest,
      coverage,
      extraInstructions: config.roles[role]?.instructions,
      check,
      briefFile: brief,
    });
  }
  // A change rejected in review is the only cross-tick memory of what was built and why it
  // failed — every tick starts a fresh session, so the full reasons ride along on the next
  // prompt until the role's next reviewed change replaces them.
  if (state.lastReview?.verdict === "reject") {
    prompt += `\n\n${buildRejectedReviewNote(state.lastReview.reasons)}`;
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
