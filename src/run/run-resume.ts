import type { RunnerState } from "../runner/runner-state.js";
import { backendSessionResumable } from "../agent/agent-backend.js";
import { latestSession } from "../agent/session-ledger.js";
import { RETRIABLE_MERGE_RESULTS } from "../merge/merge-core.js";
import type { PendingPrompt } from "../inbox/pending-prompt.js";
import { sessionDir } from "../paths.js";
import { buildHandoffPrompt, buildResumePrompt, type ResumeCause } from "../prompt/prompt-followup.js";
import { appendPromptNote } from "../text/format.js";

/** What a run starts with, decided before any worktree or pi work: whether it resumes the
 * interrupted session (and why), the prompt it runs, and the raw user request it executes.
 * planRunStart owns the whole decision — runOnce (src/runner/runner.ts) consumes the
 * plan verbatim: a null plan means the role has nothing to run (the run is skipped), a
 * resumed run gets the cause-named bridge prompt, a fresh run the assembled one. */
export interface RunStartPlan {
  /** The last merge's failure (the merger's own vocabulary — review_error, merge_conflict,
   * merge_blocked — with the detail it wrote into `lastError`), captured before the plan
   * clears lastError: a non-terminally failed merge kept its pin, and when this run's
   * recovery re-queues that pin the failure must still feed the error streak
   * (finishRecoveryRun). Undefined when the last result was not a retriable merge failure. */
  priorMergeFailure: string | undefined;
  /** Resume the interrupted session instead of starting fresh. */
  resuming: boolean;
  /** Run a fresh session but leave the worktree as the interrupted run left it, with the
   * handoff bridge (plans/agent-backends.md "Sessions"): the newest author session belongs to
   * another agent or another kind, so it is not ours to `--continue` — but the interrupted
   * run's uncommitted edits are still in the worktree and must survive the fresh path's reset.
   * Mutually exclusive with `resuming`. */
  handoff: boolean;
  /** Why the resume: a named quiet-kill means the last run died on a stalled tool call (the
   * bridge then warns against re-running it unchanged) or on the run deadline while still
   * making progress (the bridge asks for the smallest finish against the same limit); a
   * cut-off streak means the last run ran out of context and pi compacted the session (the
   * bridge asks for the smallest finish); otherwise a shutdown/crash. */
  resumeCause: ResumeCause;
  /** The prompt this run runs: the resume bridge when resuming, the assembled run prompt
   * otherwise (runOnce may still append notes — a conflict-discard note, a main-red note —
   * before the run). Null only for a promptless recovery run (`recoveryOnly`): the run
   * re-enqueues a kept merge pin and authors nothing. */
  prompt: string | null;
  /** The raw user prompt this run is executing (null for role runners), so an unfulfilled
   * outcome can re-queue it. */
  userPrompt: string | null;
  /** The root-relative path of the salvaged patch restored into this run's checkout
   * (planWithSalvagedWork), named in the run's `resume` event. Absent otherwise. */
  restored?: string;
}

/** Whether a run takes back the work an earlier run of its role left unsettled
 * (src/git/slot-salvage.ts): an authoring run of the role's own work does, while a promptless
 * recovery run (it authors nothing) and a user's request (the edits are not about it) leave the
 * patch waiting for a later run. */
export function takesSalvagedWork(plan: RunStartPlan): boolean {
  return plan.prompt !== null && plan.userPrompt === null;
}

/** The plan of a run whose fresh checkout just had its role's salvaged work restored into it
 * (`restored`, the patch's root-relative path). A fresh run becomes a `salvaged` handoff over
 * those edits: a fresh session told they are there, which skips the fresh path's reset as every
 * handoff does. A resume or handoff keeps its plan: its kept slot was lost, and the restore gives
 * it back the edits it expects. `note`, when the restore left conflicts or hunks it could not
 * place (buildSalvageRestoreNote), is appended to either prompt. */
export function planWithSalvagedWork(
  role: string,
  plan: RunStartPlan,
  restored: string,
  note?: string,
): RunStartPlan {
  if (plan.prompt === null) return { ...plan, restored };
  const handingOff = !plan.resuming && !plan.handoff;
  const prompt = handingOff ? buildHandoffPrompt(role, plan.prompt, "salvaged") : plan.prompt;
  return {
    ...plan,
    ...(handingOff ? { handoff: true, resumeCause: "salvaged" as const } : {}),
    prompt: note === undefined ? prompt : appendPromptNote(prompt, note),
    restored,
  };
}

/** Decide how a run starts, consuming the resume flags as a side effect (the flag is
 * consumed here so a resume that fails falls back to a normal fresh run; another shutdown
 * mid-resume sets it again) and reclaiming the interrupted run's re-queued prompt. Returns
 * null — meaning the run is skipped — when the role has nothing to run (an empty director
 * inbox); a role runner's assembly never returns null. */
export function planRunStart(opts: {
  root: string;
  role: string;
  state: RunnerState;
  /** The role's prompt queue: the interrupted run's re-queued request is reclaimed into it,
   * and a fresh run's assembled prompt is recorded onto it (via runPrompt). */
  pending: PendingPrompt;
  /** Assemble a fresh run's prompt (null when the role has nothing to run); the runner's
   * runPrompt() so the dequeued user request is recorded as pending exactly as before. The
   * effective `agent` below is passed through so the prompt speaks the dialect of the backend
   * the run actually runs on, not the role's primary. */
  runPrompt: (backend?: string) => string | null;
  /** The backend this run would run on, for the resume decision: a newest author ledger line
   * naming another agent hands off instead of resuming. Defaults to pi, the historical
   * backend. */
  agent?: string;
  /** The team's configured claude config dir (`backends.claude.configDir`, unexpanded), so a
   * claude run's resume guard looks under the same dir its run writes transcripts to.
   * Absent for a pi team or one that sets no config dir. */
  claudeConfigDir?: string;
  /** The role has no prompt but holds a kept merge pin: instead of the null plan (skip), return
   * a promptless plan so the run's leftover recovery runs. Ignored when a prompt exists. */
  recoveryOnly?: boolean;
}): RunStartPlan | null {
  const s = opts.state;
  // The last merge's failure, read before the clear below: a merge that failed
  // non-terminally kept its pin (the merger's own vocabulary — review_error, merge_conflict,
  // merge_blocked — with the detail it wrote into `lastError`), and when this run's recovery
  // re-queues that pin, the failure must still feed the error streak (finishRecoveryRun).
  const priorMergeFailure =
    s.lastResult !== undefined && RETRIABLE_MERGE_RESULTS.has(s.lastResult)
      ? (s.lastError ?? `merge failed: ${s.lastResult}`)
      : undefined;
  s.lastError = undefined;

  // A run interrupted by a harness shutdown left its pi session and its worktree's
  // uncommitted edits in place: resume that session instead of starting fresh. The flag
  // is consumed here so a resume that fails falls back to a normal fresh run; another
  // shutdown mid-resume sets it again. Nothing to resume (sessions pruned, or pi never
  // started) also falls back to fresh.
  //
  // The session ledger decides WHICH session a continue would reach. pi's --continue resumes
  // the newest file in the dir, so a conflict resolver's gate run in the same dir (or another
  // backend's session) would shadow the author's: only a newest author line for THIS agent is
  // resumable; any other newest line hands off to a fresh session in the unreset worktree.
  // A pre-ledger dir falls back to the historical any-*.jsonl check.
  const dir = sessionDir(opts.root, opts.role);
  const agent = opts.agent ?? "pi";
  const resumePending = s.resumePending === true;
  // The previous run's own verdict that its `--resume` target is gone is authoritative over the
  // transcript check: a lingering transcript (a torn/empty file, or the fake's planted one) must
  // not re-arm a resume the backend just rejected, or the role re-resumes and re-fails forever.
  const resumeMissing = s.resumeMissing === true;
  const latest = resumePending ? latestSession(dir) : null;
  // Our backend decides whether the newest session of this kind is actually resumable: pi
  // continues the newest FILE in the dir (only a newest author line for pi is safe), while
  // claude resumes an id (safe across a newer gate line). A backend with no `resumable` hook
  // falls back to the backend-neutral session-file check.
  const resumable = resumePending && !resumeMissing
    ? backendSessionResumable(dir, { kind: "author", agent }, opts.claudeConfigDir)
    : false;
  const resumableSession = resumable;
  // A newest line our backend cannot resume is not ours to continue: another kind's or
  // another agent's session, OR our own author line whose session the backend no longer holds
  // (a `--resume` that answered "No conversation found" mid-run, leaving `resumeMissing`, or a
  // pruned session dir). In every such case the interrupted run's uncommitted edits still
  // deserve a handoff rather than the fresh path's worktree reset: the next run runs a FRESH
  // session over the kept worktree, carrying the assembled run prompt plus the handoff
  // bridge (plans/agent-backends.md "Sessions"). The failed `resumeMissing` run arms
  // `resumePending` and records `resumeMissing` from the verdict (its error turn carries no
  // assistant content), so the very next run ends up here with the worktree intact. A dir with
  // no ledger line at all is not a handoff — there is no recorded interrupted session to carry
  // forward.
  // Captured before the flag is consumed below; a stale cause must not leak into a later resume.
  const pendingResumeCause = s.resumeCause;
  // A budget-capped API claude run is a handback onto the fallback seam: the kept worktree must
  // survive, but the next run is a FRESH session — the fallback seam may be a different backend,
  // and claude keeps no flags across `--resume` (plans/agent-backends.md §7, part 7a/7).
  const budgetCapped = pendingResumeCause === "budget-capped";
  // An image-blind run with an image-capable peer tier ends `aborted` with this cause
  // (plans/image-input.md part 4/5): the next run runs a FRESH session on the TARGET seam
  // over the kept worktree — never `--continue` — because the old session carries pi's
  // "image omitted" note and the target may be a different backend.
  const imageReroute = pendingResumeCause === "image-reroute";
  const handoff = (latest !== null && !resumable) || budgetCapped || imageReroute;
  s.resumePending = false;
  s.resumeCause = undefined;
  s.resumeMissing = undefined;
  // An interruption during the review gate leaves the author's work fully committed — there
  // is nothing left to finish in its session. Recover (and re-review) the leftover commits
  // via a fresh run instead: continuing the author session would burn a run on finished
  // work, and any uncommitted edits are the reviewer's stray output, discarded by the fresh
  // path's reset below.
  const resumeBlocked = s.phase === "review";
  // A budget-capped handback never resumes the session whose seam the cap moved off of, even
  // when its transcript is still resumable: it hands off instead.
  const resuming = resumableSession && !resumeBlocked && !budgetCapped && !imageReroute;
  const handingOff = handoff && !resumeBlocked;
  // Reclaim the prompt the interrupted run re-queued for its resume (src/inbox/pending-prompt.ts):
  // the resumed session still owns that request in its context, so this run's bookkeeping
  // operates on the queue's copy. A handoff runs a FRESH session, so it does not reclaim — the
  // fresh run dequeues the re-queued request like any other. Consumed even when this run does
  // not resume, so a stale record never survives into a later resume.
  opts.pending.reclaimForResume(s, resuming);

  // Why the resume: a named quiet-kill means the last run died on a stalled tool call (the
  // bridge then warns against re-running it unchanged) or on the run deadline while still
  // making progress (the bridge asks for the smallest finish against the same limit); a
  // cut-off streak means the last run ran out of context and pi compacted the session (the
  // bridge asks for the smallest finish); otherwise a shutdown/crash. A handoff names itself,
  // except a budget-capped one, which names the cap that ended the run.
  const resumeCause: ResumeCause = handingOff
    ? budgetCapped
      ? "budget-capped"
      : imageReroute
        ? "image-reroute"
        : "handoff"
    : pendingResumeCause ?? ((s.cutOffStreak ?? 0) > 0 ? "cut-off" : "restart");
  let prompt: string | null;
  if (resuming) {
    prompt = buildResumePrompt(opts.role, resumeCause, agent);
  } else {
    const assembled = opts.runPrompt(agent);
    // The image-reroute handoff note names the model the blind run was on and the image it
    // read; those facts ride the one-shot marker, which is consumed here. A handoff's fresh
    // session also needs the to-be-run model named for its own side of the note, but the
    // bridge already carries the facts that matter.
    const rerouteFacts =
      imageReroute && s.imageReroute
        ? { from: s.imageReroute.from ?? "the prior model", path: s.imageReroute.path ?? "an image" }
        : undefined;
    if (imageReroute) s.imageReroute = undefined;
    prompt =
      assembled === null
        ? null
        : handingOff
          ? buildHandoffPrompt(opts.role, assembled, resumeCause, rerouteFacts)
          : assembled;
  }
  if (prompt === null) {
    if (!opts.recoveryOnly) return null;
    return { priorMergeFailure, resuming: false, handoff: false, resumeCause, prompt: null, userPrompt: null };
  }
  // The raw user prompt a director run is executing (null for role runners), so an
  // unfulfilled outcome below can re-queue it. Captured before the field is cleared.
  const userPrompt = opts.pending.get();
  return { priorMergeFailure, resuming, handoff: handingOff, resumeCause, prompt, userPrompt };
}
