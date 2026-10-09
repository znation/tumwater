import type { TumwaterConfig } from "../config/config-schema.js";
import type { LoopState } from "../loop/loop-state.js";
import { allRoleIds, customRole, DIRECTOR_ROLE, roleById, unknownRoleMessage } from "../roles/roles.js";
import { baseRoleOf } from "../roles/loop-ids.js";
import { planBacklogTarget } from "../scheduling/claims.js";
import { NOTHING_TO_DO } from "../verdict/reply-contract.js";
import { dequeuePrompt, dequeueRolePrompt, peekPrompt, peekRolePrompt } from "../inbox/inbox.js";
import { stripNotBeforeMarker } from "../inbox/prompt-not-before.js";
import { readBrief } from "../brief.js";
import { buildDirectorPrompt, buildTickPrompt } from "../prompt/prompt.js";
import { readPrinciples } from "../prompt/principles.js";
import { buildCutOffNote } from "../prompt/prompt-followup.js";
import { buildAssignmentNote, buildConflictDiscardNote, buildRejectedReviewNote } from "../gates/gate-prompts.js";
import { eligibleEntries } from "../backlog/backlog-eligibility.js";
import { detectBuildCheck } from "../build/build-check-detect.js";
import { telemetryDigest } from "./telemetry-digest.js";
import { readQaCoverage, renderCoverageBlock } from "./qa-coverage.js";
import { roleNotesPath } from "../paths.js";
import { readTextOrNull } from "../files/files.js";
import { ROLE_NOTES_MAX_BYTES } from "../pi-extension/role-notes.js";
import { truncateWithNote } from "../text/text.js";
import { renderBacklogIndexBlock, renderBacklogStructureBlock } from "../backlog/backlog-structure.js";

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

/** Read a role's notebook through files.ts's readTextOrNull — the one read-and-swallow
 * step — or undefined when it is missing or unreadable (an empty or whitespace-only note is
 * left for buildTickPrompt to omit). The degradation is deliberate: a torn or absent
 * runtime-state file must never fail a tick.
 *
 * The note is bounded on read as well as on write: the role_notes tool rejects text over
 * ROLE_NOTES_MAX_BYTES, but the file lives in hand-editable runtime state, so an oversized
 * note (an old build, a manual edit) would otherwise ride into every one of this role's
 * prefill-heavy tick prompts uncapped. The same defensive backstop readPrinciples and the
 * initial-prompt reader apply to their hand-editable files. A UTF-8 character is never
 * fewer than one byte, so a note the tool accepted (≤ 4096 bytes) is always ≤ 4096 chars
 * and never trips this bound; only an over-cap file is cut, with truncateWithNote's visible
 * marker naming the loss. */
function readRoleNote(root: string, role: string): string | undefined {
  const text = readTextOrNull(roleNotesPath(root, role));
  return text === null ? undefined : truncateWithNote(text, ROLE_NOTES_MAX_BYTES, "role notebook");
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
  // One read of the brief yields both the prompt it carries and the owning file's name
  // (brief.ts's readBrief): readInitialPrompt + briefFile were two full reads of the same
  // file on this per-tick path.
  const briefState = readBrief(root);
  const initialPrompt = briefState?.prompt ?? "";
  // The brief's owning file (TUMWATER.md first, README.md as the compatibility path —
  // plans/portability.md §7a/7), named in both prompt builders' rules instead of a hardcoded
  // README.md. "README.md" is the fallback for a repo with no marked file yet — the fleet
  // runs blind on prompts either way, so the name in the rules should still point somewhere.
  const brief = briefState?.file ?? "README.md";
  // The project's design principles ride along in every prompt — tick and director alike — so
  // all loops share one standard of taste. Empty when the repo has no PRINCIPLES.md.
  const principles = readPrinciples(root);
  // The project's resolved check (plans/portability.md §6/7): the prompt names the actual
  // verify command instead of asserting npm. Detection is a handful of stat calls — a
  // per-tick recompute keeps a config edit live on the next tick.
  const check = detectBuildCheck(root, config) ?? undefined;
  // The bounded actionable index every tick and director prompt carries, replacing the model's
  // per-tick `grep -n '^##'` map of the backlog files (BUGS.md 2026-10-06). One render serves
  // both branches; the worktree starts at main at tick start, so the ranges hold then.
  const backlogIndex = renderBacklogIndexBlock(root);
  let prompt: string;
  let userPrompt: string | null = null;
  if (role === DIRECTOR_ROLE) {
    // A deferred director prompt's `tumwater:not-before` marker line is plumbing
    // (src/inbox/prompt-not-before.ts),
    // not content — stripped here exactly like the per-role path below, so the director's tick
    // prompt and the runner's re-queue both see the operator's text alone.
    const dequeued = preview ? peekPrompt(root) : dequeuePrompt(root);
    if (!dequeued) return null;
    userPrompt = stripNotBeforeMarker(dequeued);
    prompt = buildDirectorPrompt(userPrompt, initialPrompt, principles, check, brief, undefined, backlogIndex);
  } else {
    // The loop id keys its inbox and notebook; every lookup ABOUT the role — catalog charter,
    // instructions, the qa/telemetry/clean blocks — resolves through the base role, so
    // `feature-2` runs the feature charter and `roles.feature.instructions` while keeping its
    // own queue and notes (plans/parallel-work-instances.md).
    const base = baseRoleOf(role);
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
    // (src/inbox/prompt-not-before.ts), not
    // content: it is stripped at delivery, so the loop sees the operator's text alone and the
    // runner's re-queue writes clean text.
    const dequeued = preview ? peekRolePrompt(root, role) : dequeueRolePrompt(root, role);
    const request = dequeued === null ? null : stripNotBeforeMarker(dequeued);
    // The telemetry role's evidence is the harness's own event log, one level outside this
    // worktree, so its evidence module renders it (telemetryDigest) and the tick injects it.
    const digest = base === "telemetry" ? telemetryDigest(root) : undefined;
    // The `qa` observer's flow rotation needs a memory of what it last exercised; every tick
    // is a fresh session, and a passing cheap check leaves nothing in the repo. The ledger is
    // runtime state, and a missing or unreadable one degrades to no block (plans/observer-roles.md 2/2).
    let coverage: string | undefined;
    if (base === "qa") {
      try {
        coverage = renderCoverageBlock(readQaCoverage(root));
      } catch {
        coverage = undefined;
      }
    }
    // The clean role's deterministic backlog repair: stranded plan headings in the primary
    // checkout's PLANS.md (plans, part 3/4), rendered like the digest and coverage blocks.
    // An unreadable or clean file gives no block, so the prompt is unchanged in the common case.
    const backlogStructure = base === "clean" ? renderBacklogStructureBlock(root) : undefined;
    // The role's notebook (PLANS.md "Role notebook"): its own earlier ticks' note. A missing,
    // empty, or unreadable file yields undefined, so the block is omitted; the write
    // instruction in buildTickPrompt is present either way. The director branch above never
    // reads this path, so it carries no notebook.
    const notes = readRoleNote(root, role);
    // The plan charter's stop threshold is derived from config (plans/parallel-work-
    // instances.md "…keeping the plan loop ahead", part 5c/7). The catalog text stays a
    // config-free description of the rule; this note supplies the concrete eligible-plan count
    // so the plan loop stops only once every configured feature instance has a plan waiting.
    const planTargetNote =
      base === "plan"
        ? `This tick's stop target: when PLANS.md \`## Planned\` already holds ` +
          `${planBacklogTarget(config)} or more eligible plans, end with ${NOTHING_TO_DO}.`
        : undefined;
    prompt = buildTickPrompt({
      role: resolved,
      initialPrompt,
      principles,
      digest,
      coverage,
      backlogStructure,
      backlogIndex,
      notes,
      planTargetNote,
      extraInstructions: config.roles[base]?.instructions,
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
  // A work instance holding a claim is told which entry is its one task (plans/parallel-work-
  // instances.md "Claims", part 4/7) — the harness picked it, so the charter's choosing step
  // is replaced. A tick that dequeued a user request runs that request instead and keeps the
  // claim for the next non-request tick. The range is looked up by key in the current checkout,
  // so it survives a moved section boundary.
  const claim = role === DIRECTOR_ROLE ? undefined : state.claim;
  if (claim && userPrompt === null) {
    const range = eligibleEntries(root, role).find((e) => e.key === claim.key);
    prompt += `\n\n${buildAssignmentNote(claim, range)}`;
  }
  // A change rejected in review is the only cross-tick memory of what was built and why it
  // failed — every tick starts a fresh session, so the full reasons ride along on the next
  // prompt until the role's next reviewed change replaces them.
  if (state.lastReview?.verdict === "reject" && !state.revision) {
    prompt += `\n\n${buildRejectedReviewNote(state.lastReview, role)}`;
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
