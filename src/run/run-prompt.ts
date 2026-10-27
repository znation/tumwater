import type { TumwaterConfig } from "../config/config-schema.js";
import type { RunnerState } from "../runner/runner-state.js";
import { allRoleIds, customRole, DIRECTOR_ROLE, roleById, unknownRoleMessage, type Role } from "../roles/roles.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { planBacklogTarget } from "../scheduling/claims.js";
import { configForRole } from "../config/config-views.js";
import { NOTHING_TO_DO } from "../verdict/reply-contract.js";
import { dequeuePromptEntry, dequeueRolePromptEntry, peekPrompt, peekRolePrompt } from "../inbox/inbox.js";
import { stripNotBeforeMarker } from "../inbox/prompt-not-before.js";
import { briefFile } from "../brief/brief.js";
import { buildDirectorPrompt, buildRunPrompt } from "../prompt/prompt.js";
import { readPrinciples } from "../prompt/principles.js";
import { buildCutOffNote } from "../prompt/prompt-followup.js";
import { buildAssignmentNote, buildConflictDiscardNote, buildHeldEntriesNote, buildMergedPrerequisitesNote, buildNoCheckNote, buildRejectedReviewNote, buildWaitingPartsNote } from "../prompt/gate-notes.js";
import { eligibleEntries, mergedPrerequisiteRanges, waitingPartRanges } from "../backlog/backlog-eligibility.js";
import { notesBacklogBlock } from "../prompt/notes-backlog.js";
import { donePlans, openBugEntries, plannedPlanEntries, declarationPlanEntry } from "../backlog/backlog.js";
import { detectBuildCheck, gateCommandOf, type BuildCheck } from "../build/build-check-detect.js";
import { flakeCounts, KNOWN_FLAKE_WINDOW_MS } from "../review/known-flakes.js";
import { readEventsSince } from "../events/event-window.js";
import { selfcheckDigest } from "./selfcheck-digest.js";
import { readQaCoverage, renderCoverageBlock } from "./qa-coverage.js";
import { parityBlockFor } from "./ci-parity.js";
import { readFeedbackFilings, renderFilingsBlock } from "./feedback-filings.js";
import { roleNotesPath } from "../paths.js";
import * as path from "node:path";
import { pathTokens } from "../text/text.js";
import { isDirectory, readRegularTextOrNull, readTextOrNull, statOrNull } from "../files/files.js";
import { dayKey } from "../text/datetime.js";
import { appendPromptNote, prependPromptNote } from "../text/format.js";
import { ROLE_NOTES_MAX_BYTES } from "../agent/role-notes-write.js";
import { truncateWithNote } from "../text/text.js";
import { renderBacklogStructureBlock } from "../backlog/backlog-structure.js";
import { renderBacklogIndexBlock } from "../backlog/backlog-index.js";

/** One role's inputs for assembling its run prompt: read-only views of what RoleRunner
 * holds, so the assembly stays a pure function of (root, config, role, state). */
interface RunPromptInput {
  root: string;
  config: TumwaterConfig;
  role: string;
  state: RunnerState;
  /** Preview mode (`tumwater role <id>`'s next-prompt view): the queued prompt is peeked at,
   * not dequeued, so assembling a preview can never consume a queued request. Everything
   * else — brief, principles, check, the state-derived notes — is assembled identically. */
  preview?: boolean;
  /** The effective backend this run RUNS on — the model-fallback pair while an episode
   * is active — selecting the prompt dialect. planRunStart passes the same `cfg.agent` the
   * authoring run gets, so a fallback seam's prompt cannot speak the primary's dialect.
   * Omitted: the role's primary `configForRole(config, role).agent`. */
  backend?: string;
}

/** The repo paths the entry at `file` lines `range` names that are absent from the checkout at
 * `root`: tokens whose first segment is a directory there but which do not exist themselves —
 * the self-check's top-level-directory rule, read from the working tree. */
function missingEntryPaths(root: string, file: string, range: { start: number; end: number }): string[] {
  const text = readTextOrNull(path.join(root, file));
  if (text === null) return [];
  const entry = text.split("\n").slice(range.start - 1, range.end).join("\n");
  return pathTokens(entry).filter((p) => {
    const top = p.slice(0, p.indexOf("/"));
    return isDirectory(path.join(root, top)) && statOrNull(path.join(root, p)) === null;
  });
}

/** Read a role's notes through files.ts's readTextOrNull — the one read-and-swallow
 * step — or undefined when it is missing or unreadable (an empty or whitespace-only note is
 * left for buildRunPrompt to omit). The degradation is deliberate: a torn or absent
 * runtime-state file must never fail a run.
 *
 * The note is bounded on read as well as on write: the write path rejects text over
 * ROLE_NOTES_MAX_BYTES, but the file lives in hand-editable runtime state, so an oversized
 * note (an old build, a manual edit) would otherwise ride into every one of this role's
 * prefill-heavy run prompts uncapped. The same defensive backstop readPrinciples and the
 * brief text reader apply to their hand-editable files. A UTF-8 character is never
 * fewer than one byte, so a note the tool accepted (≤ 4096 bytes) is always ≤ 4096 chars
 * and never trips this bound; only an over-cap file is cut, with truncateWithNote's visible
 * marker naming the loss. A symlinked note file reads as absent (readRegularTextOrNull never
 * follows a symlink out of the worktree, INV-G3/G4's lstat policy): a hostile note that is a
 * symlink cannot pull an arbitrary host file's text into this role's prompt. */
function readRoleNote(root: string, role: string): string | undefined {
  const text = readRegularTextOrNull(roleNotesPath(root, role));
  return text === null ? undefined : truncateWithNote(text, ROLE_NOTES_MAX_BYTES, "role notes");
}

/** The bugfix run's tally of checks the merge gate excused as flaky in the last day, or
 * undefined when none (or the log is unreadable — a missing tally never fails a run). */
function flakyChecksNote(root: string): string | undefined {
  let counts: [string, number][];
  try {
    counts = flakeCounts(readEventsSince(root, KNOWN_FLAKE_WINDOW_MS).events);
  } catch {
    return undefined;
  }
  if (counts.length === 0) return undefined;
  const shown = counts
    .slice(0, 5)
    .map(([key, n]) => `"${key}" ×${n}`)
    .join("; ");
  const more = counts.length > 5 ? ` (and ${counts.length - 5} more)` : "";
  return (
    `Flaky checks: in the last 24h the merge gate excused these check failures as flaky (each ` +
    `failed, then passed on its one re-run), most frequent first: ${shown}${more}. An excused ` +
    `flake blocks no merge, so it stays unfixed until it has a BUGS.md entry. When an open bug ` +
    `names one of these, that bug is still firing. When \`## Open\` holds no entries, a check ` +
    `excused 2 or more times is a confirmed latent bug: take it as this run's latent-bug candidate.`
  );
}

/** Build the director's prompt from its deferred request: the queue peek/dequeue, the
 * empty-inbox null return, the not-before marker strip, and the buildDirectorPrompt call.
 * Returns null when the director has nothing to run (an empty inbox). */
function buildDirectorRunPrompt(
  root: string,
  config: TumwaterConfig,
  preview: boolean,
  backend: string | undefined,
  brief: string,
  principles: string,
  check: BuildCheck | undefined,
  backlogIndex: string | undefined,
): { prompt: string; userPrompt: string; userPromptFile: string | null } | null {
  // A deferred director prompt's `tumwater:not-before` marker line is plumbing
  // (src/inbox/prompt-not-before.ts),
  // not content — stripped here exactly like the per-role path below, so the director's run
  // prompt and the runner's re-queue both see the operator's text alone.
  const entry = preview ? null : dequeuePromptEntry(root);
  const dequeued = preview ? peekPrompt(root) : entry?.text ?? null;
  if (!dequeued) return null;
  const userPrompt = stripNotBeforeMarker(dequeued);
  const userPromptFile = entry?.file ?? null;
  const prompt = buildDirectorPrompt(userPrompt, principles, check, brief, undefined, backlogIndex, backend ?? configForRole(config, DIRECTOR_ROLE).agent, config.roles[DIRECTOR_ROLE]?.instructions);
  return { prompt, userPrompt, userPromptFile };
}

/** Build a non-director role's prompt from its queued request and state: the catalog/custom
 * resolution and unknown-role throw, the role-prompt dequeue and marker strip, the
 * observer evidence blocks, the notes and their backlog state, the plan target, and the
 * flaky/no-check notes, feeding the single buildRunPrompt call. Never null — a role always
 * has a prompt to run on. Each stage is read by one named helper below, so the body is the
 * ordered calls and the single buildRunPrompt call. */
function buildRoleRunPrompt(
  root: string,
  config: TumwaterConfig,
  role: string,
  state: RunnerState,
  preview: boolean,
  backend: string | undefined,
  brief: string,
  principles: string,
  check: BuildCheck | undefined,
  backlogIndex: string | undefined,
  rejectedReview: string | undefined,
): { prompt: string; userPrompt: string | null; userPromptFile: string | null } {
  const { base, resolved } = resolveRoleForPrompt(config, role);
  const { request, promptFile } = collectRoleRequest(root, role, preview);
  const digest = collectSelfcheckDigest(root, base);
  const coverage = collectQaCoverageBlock(root, base);
  const ciParity = collectCiParityBlock(root, config, base);
  const filings = collectFeedbackFilingsBlock(root, base);
  const backlogStructure = collectBacklogStructureBlock(root, base);
  const { notes, notesSavedDay, notesBacklog } = readPromptNotes(root, role);
  const { planTargetNote, flakyChecks, noCheck } = collectRoleDirectives(root, config, base, check);
  // A run holding a claim with no queued request is assigned its one entry (the assignment
  // note below). Such a run reads that entry first, so the backlog index — what an unassigned
  // run chooses its task from — stays out.
  const assigned = state.claim !== undefined && request === null;
  let userPrompt: string | null = null;
  let userPromptFile: string | null = null;
  const prompt = buildRunPrompt({
    role: resolved,
    principles,
    digest,
    coverage,
    ciParity,
    filings,
    backlogStructure,
    backlogIndex: assigned ? undefined : backlogIndex,
    notes,
    notesSavedDay,
    notesBacklog,
    planTargetNote,
    flakyChecks,
    noCheck,
    extraInstructions: config.roles[base]?.instructions,
    check,
    gateCommand: gateCommandOf(config),
    briefFile: brief,
    agent: backend ?? configForRole(config, role).agent,
    assigned,
    rejectedReview,
    // A per-role prompt queued by `tumwater prompt --role <id>` rides as an explicit user
    // request block; its text is also the run's userPrompt,
    // so the runner's pending-prompt machinery (re-queue on unfulfilled, clear on merge)
    // treats it exactly like the director's dequeued request.
    userRequest: request ?? undefined,
  });
  if (request) {
    userPrompt = request;
    userPromptFile = promptFile;
  }
  return { prompt, userPrompt, userPromptFile };
}

/** Resolve the run's role: the base role that keys the observer evidence, and the catalog or
 * user-defined charter. Throws the shared unknown-role message when neither answers. */
function resolveRoleForPrompt(config: TumwaterConfig, role: string): { base: string; resolved: Role } {
  // The role id keys its inbox and notes; every lookup ABOUT the role — catalog charter,
  // instructions, the qa/selfcheck/clean blocks — resolves through the base role, so
  // `feature-2` runs the feature charter and `roles.feature.instructions` while keeping its
  // own queue and notes (plans/parallel-work-instances.md).
  const base = baseRoleOf(role);
  // Catalog first, then user-defined roles (plans/user-defined-loops.md): a custom's task
  // is its entire find-something-to-do text and the title identifies it in the prompt.
  const custom = config.customRoles.find((c) => c.name === role);
  const resolved = roleById(role) ?? (custom ? customRole(custom.name, custom.task) : undefined);
  if (!resolved) {
    // The shared unknownRoleMessage (parseRoleFlag, the operator commands) names the valid
    // ids; this defensive path — a runner asked to run a role no catalog entry or
    // customRoles task can answer — says the same, so if it ever fires it reads as the
    // harness bug it is instead of a bare dead end.
    const validIds = [...allRoleIds(), ...config.customRoles.map((c) => c.name)];
    throw new Error(unknownRoleMessage(role, validIds));
  }
  return { base, resolved };
}

/** Dequeue (or, in preview, peek) the role's queued request and strip its not-before marker,
 * returning the delivered text and the queue file it came from. */
function collectRoleRequest(root: string, role: string, preview: boolean): { request: string | null; promptFile: string | null } {
  // A queued per-role prompt is dequeued here, before the prompt is built, so its text rides
  // in the run's prompt; PendingPrompt records it as pending and re-queues it on every
  // unfulfilled outcome — including a merge-side `main_red` pin, which returns before any run.
  // A deferred prompt's `tumwater:not-before` marker line is plumbing
  // (src/inbox/prompt-not-before.ts), not
  // content: it is stripped at delivery, so the role sees the operator's text alone and the
  // runner's re-queue writes clean text.
  const entry = preview ? null : dequeueRolePromptEntry(root, role);
  const dequeued = preview ? peekRolePrompt(root, role) : entry?.text ?? null;
  const request = dequeued === null ? null : stripNotBeforeMarker(dequeued);
  return { request, promptFile: entry?.file ?? null };
}

/** The selfcheck and feedback observers' evidence is the harness's own event log, one level
 * outside this worktree, so its evidence module renders it (selfcheckDigest) and the run
 * injects it. */
function collectSelfcheckDigest(root: string, base: string): string | undefined {
  return base === "selfcheck" || base === "feedback" ? selfcheckDigest(root) : undefined;
}

/** The `qa` observer's flow-coverage ledger: rerendered from disk each run, degrading to no
 * block on a missing or unreadable ledger (plans/observer-roles.md 2/2). */
function collectQaCoverageBlock(root: string, base: string): string | undefined {
  // The `qa` observer's flow rotation needs a memory of what it last exercised; every run
  // is a fresh session, and a passing cheap check leaves nothing in the repo. The ledger is
  // runtime state, and a missing or unreadable one degrades to no block.
  let coverage: string | undefined;
  if (base === "qa") {
    try {
      coverage = renderCoverageBlock(readQaCoverage(root));
    } catch {
      coverage = undefined;
    }
  }
  return coverage;
}

/** The `ci` observer's parity block: what the last run covered (tip and lock hash) so a
 * fresh session can decide nothing-to-do without re-running the whole suite (part 3/3).
 * Runtime state, and a missing/unreadable record degrades to no block, exactly like qa's. */
function collectCiParityBlock(root: string, config: TumwaterConfig, base: string): string | undefined {
  let ciParity: string | undefined;
  if (base === "ci") {
    try {
      ciParity = parityBlockFor(root, config);
    } catch {
      ciParity = undefined;
    }
  }
  return ciParity;
}

/** The `feedback` observer's per-install filing ledger: what this install already filed as
 * GitHub issues on znation/tumwater, so the fresh session's charter dedupes against a
 * "previously filed" block instead of the network alone. Runtime state, and a missing or
 * unreadable ledger degrades to no block (plans/feedback-role.md 2/2). */
function collectFeedbackFilingsBlock(root: string, base: string): string | undefined {
  // The render returns undefined for an empty ledger, so the prompt is unchanged in the common
  // first-run case.
  let filings: string | undefined;
  if (base === "feedback") {
    try {
      filings = renderFilingsBlock(readFeedbackFilings(root));
    } catch {
      filings = undefined;
    }
  }
  return filings;
}

/** The clean role's deterministic backlog repair: stranded plan headings in the primary
 * checkout's PLANS.md (plans, part 3/4), rendered like the digest and coverage blocks. */
function collectBacklogStructureBlock(root: string, base: string): string | undefined {
  // An unreadable or clean file gives no block, so the prompt is unchanged in the common case.
  return base === "clean" ? renderBacklogStructureBlock(root) : undefined;
}

/** Read the role's own notes plus their saved day and live backlog state (notes-backlog.ts),
 * returning all three in one place. */
function readPromptNotes(root: string, role: string): { notes: string | undefined; notesSavedDay: string | undefined; notesBacklog: string | undefined } {
  // The role's own notes (readRoleNote): its earlier runs' note. A missing,
  // empty, or unreadable file yields undefined, so the block is omitted; the write
  // instruction in buildRunPrompt is present either way. The director branch above never
  // reads this path, so it carries no notes.
  const notes = readRoleNote(root, role);
  // The note file's mtime is when the notes were last saved (writes replace the file), so the
  // run can weigh how stale they are.
  const savedStat = notes === undefined ? null : statOrNull(roleNotesPath(root, role));
  const notesSavedDay = savedStat ? dayKey(savedStat.mtimeMs) : undefined;
  // The live state of each entry and series the notes name, so a stale note cannot keep a hold
  // the backlog has lifted (notes-backlog.ts). The three readers are already stat-cached. A
  // note naming nothing live yields undefined and no block — the common case, since most notes
  // are about the code, not the backlog.
  const notesBacklog =
    notes === undefined || notes.trim() === ""
      ? undefined
      : notesBacklogBlock(notes, {
          planned: plannedPlanEntries(root),
          openBugs: openBugEntries(root),
          donePlanTitles: donePlans(root),
        });
  return { notes, notesSavedDay, notesBacklog };
}

/** The directive notes a run may carry: the plan charter's stop target, the bugfix flake
 * tally, and the plan/feature no-check note — each exactly as it stood inline. */
function collectRoleDirectives(root: string, config: TumwaterConfig, base: string, check: BuildCheck | undefined): { planTargetNote: string | undefined; flakyChecks: string | undefined; noCheck: string | undefined } {
  // The plan charter's stop threshold is derived from config (plans/parallel-work-
  // instances.md "…keeping the plan role ahead", part 5c/7). The catalog text stays a
  // config-free description of the rule; this note supplies the concrete eligible-plan count
  // so the plan role stops only once every configured feature instance has a plan waiting.
  const planTargetNote =
    base === "plan"
      ? `This run's stop target: when PLANS.md \`## Planned\` already holds ` +
        `${planBacklogTarget(config)} or more eligible plans, end with ${NOTHING_TO_DO}. ` +
        `It holds ${eligibleEntries(root, "feature").length} now (tumwater's count of entries ` +
        `feature could take, the same count that decides whether a plan run is deferred).`
      : undefined;
  const flakyChecks = base === "bugfix" ? flakyChecksNote(root) : undefined;
  // The no-check note: when the project declares no deterministic check and the team is
  // closing the gap itself, the plan note tells the plan role to write the declaration entry
  // (no marker entry waits yet) and the feature note tells the feature role to implement the
  // marker entry that does wait. Decided by CHECK_DECLARATION_MARKER (declarationPlanEntry)
  // rather than prose, so a feature run never invents a declaration the plan role never wrote
  // and a plan run cannot stack a second declaration on one already waiting. Any other role,
  // or a declared check, gets neither note — byte-unchanged prompts.
  const declaration = (base === "plan" || base === "feature") && check === undefined ? declarationPlanEntry(root) : undefined;
  // Whole declaration drives the decision: `declarationPlanEntry` returns null (not
  // undefined) when no marker entry waits, so a truthy test selects the feature note and a
  // falsy one the plan note.
  const noCheck =
    check === undefined && (base === "plan" || base === "feature")
      ? (declaration
          ? (base === "feature" ? buildNoCheckNote(base) : undefined)
          : (base === "plan" ? buildNoCheckNote(base) : undefined))
      : undefined;
  return { planTargetNote, flakyChecks, noCheck };
}

/** Append the shared claim/held/discard/cut-off tail — identical for a director and a role —
 * in its current order, and return the finished prompt. */
function appendRunEpilogue(
  root: string,
  role: string,
  state: RunnerState,
  prompt: string,
  userPrompt: string | null,
  rejectedReview: string | undefined,
): string {
  // A work instance holding a claim is told which entry is its one task (plans/parallel-work-
  // instances.md "Claims", part 4/7) — the harness picked it, so the charter's choosing step
  // is replaced. A run that dequeued a user request runs that request instead and keeps the
  // claim for the next non-request run. The range is looked up by key in the current checkout,
  // so it survives a moved section boundary.
  const claim = role === DIRECTOR_ROLE ? undefined : state.claim;
  if (claim && userPrompt === null) {
    const range = eligibleEntries(root, role).find((e) => e.key === claim.key);
    prompt = appendPromptNote(prompt, buildAssignmentNote(claim, range, range ? missingEntryPaths(root, claim.file, range) : []));
    const merged = claim.file === "PLANS.md" ? mergedPrerequisiteRanges(root, claim.title) : [];
    if (merged.length > 0) prompt = appendPromptNote(prompt, buildMergedPrerequisitesNote(merged));
  }
  if (claim && userPrompt === null && claim.file === "PLANS.md") {
    const waiting = waitingPartRanges(root, claim.title);
    if (waiting.length > 0) prompt = appendPromptNote(prompt, buildWaitingPartsNote(waiting));
  }
  if (!claim && userPrompt === null && role !== DIRECTOR_ROLE && state.heldElsewhere?.length) {
    prompt = appendPromptNote(prompt, buildHeldEntriesNote(state.heldElsewhere));
  }
  // The director builds its prompt through buildDirectorPrompt, which does not take the rejected
  // note, so the standing rejection leads its prompt here instead (a director-authored change can
  // be rejected too). Kept uniform with the authoring roles: the reasons open the run.
  if (rejectedReview !== undefined && role === DIRECTOR_ROLE) {
    prompt = prependPromptNote(prompt, rejectedReview);
  }
  // Likewise a change leftover recovery discarded as unmergeable: named until the role queues
  // its next change (the discarding run itself appends it after recovery — see runOnce).
  const discard = state.conflictDiscard;
  if (discard) prompt = appendPromptNote(prompt, buildConflictDiscardNote(discard.summary, discard.attempts));
  // A fresh run after the previous run(s) were cut off at the context ceiling (the role
  // stopped resuming, or never resumed — the director re-runs its prompt fresh): the only
  // memory that the last attempt was too big for the window is this note.
  if ((state.cutOffStreak ?? 0) > 0) {
    prompt = appendPromptNote(prompt, buildCutOffNote(state.cutOffStreak ?? 0));
  }
  return prompt;
}

/** Assemble the prompt a role's next run operates on — the whole "what should this run see"
 * concern, split out of runner.ts so the runner owns only lifecycle and the prompt owns only
 * content. Returns null when the role has nothing to run this run (a director with an empty
 * inbox); `userPrompt` carries the dequeued user request — the director's, or a per-role one
 * queued by `tumwater prompt --role <id>` — back so the runner can record it as pending and
 * re-queue it if the run leaves it unfulfilled; `userPromptFile` is the queue file it came
 * from, so that bookkeeping can clean the prompt's attachments by that file's stem. */
export function assembleRunPrompt(
  { root, config, role, state, preview = false, backend }: RunPromptInput,
): { prompt: string; userPrompt: string | null; userPromptFile: string | null } | null {
  // The brief's owning file (TUMWATER.md first, README.md as the compatibility path —
  // plans/portability.md §7a/7), named in both prompt builders' rules instead of a hardcoded
  // README.md. "README.md" is the fallback for a repo with no marked file yet — the team
  // runs blind on prompts either way, so the name in the rules should still point somewhere.
  const brief = briefFile(root) ?? "README.md";
  // The project's design principles ride along in every prompt — run and director alike — so
  // all roles share one standard of taste. Empty when the repo has no PRINCIPLES.md.
  const principles = readPrinciples(root);
  // The project's resolved check (plans/portability.md §6/7): the prompt names the actual
  // verify command instead of asserting npm. Detection is a handful of stat calls — a
  // per-run recompute keeps a config edit live on the next run.
  const check = detectBuildCheck(root, config) ?? undefined;
  // The bounded actionable index every run and director prompt carries, replacing the model's
  // per-run `grep -n '^##'` map of the backlog files (BUGS.md 2026-10-06). One render serves
  // both branches; the worktree starts at main at run start, so the ranges hold then.
  const backlogIndex = renderBacklogIndexBlock(root);
  // A change rejected in review is the only cross-run memory of what was built and why it
  // failed — every run starts a fresh session, so the full reasons (with the reviewed head and
  // timestamp) ride along on the next prompt until the role's next reviewed change replaces
  // them. buildRunPrompt renders it at the very top, before the role charter, so the author
  // cannot miss it (plans/reviewer-as-role.md part 4/4). A revision run carries the reasons in
  // buildRevisionNote instead (the rejected diff is already in the worktree), so the note is
  // suppressed here exactly as it was before this part.
  const rejectedReview =
    (state.lastReview?.verdict === "reject" || state.lastReview?.verdict === "reverted") && !state.revision
      ? buildRejectedReviewNote(state.lastReview, role)
      : undefined;
  const built =
    role === DIRECTOR_ROLE
      ? buildDirectorRunPrompt(root, config, preview, backend, brief, principles, check, backlogIndex)
      : buildRoleRunPrompt(root, config, role, state, preview, backend, brief, principles, check, backlogIndex, rejectedReview);
  if (built === null) return null;
  return {
    prompt: appendRunEpilogue(root, role, state, built.prompt, built.userPrompt, rejectedReview),
    userPrompt: built.userPrompt,
    userPromptFile: built.userPromptFile,
  };
}
