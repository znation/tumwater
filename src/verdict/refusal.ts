import fs from "node:fs";
import path from "node:path";
import { commitPathsAndDiscardRest, fileContentAt } from "../git/git.js";
import { writeTextAtomic } from "../files/files.js";
import { parseEntryDetails } from "../backlog/backlog-md.js";
import { actionableEntryRanges } from "../backlog/backlog-structure.js";
import {
  entryHoldAgainst,
  entryKey,
  plannedPartKeys,
  refusalNote,
  withoutRefusalNotes,
} from "../backlog/backlog-eligibility.js";
import { baseRoleOf } from "../roles/loop-ids.js";
import { changedFiles } from "../git/git-diff.js";
import { resetWorktreeToMain } from "../git/worktree.js";
import { buildCommitMessage, commitTrailer, stampedSubject } from "../git/commit-message.js";
import { labeledLine } from "./reply-contract.js";
import { logEventBestEffort } from "../events/events.js";
import { clearSupersededRejection } from "../tick/tick-apply.js";
import type { TickOutcome, TickResult } from "../tick/tick-outcome.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { LoopState } from "../loop/loop-state.js";

/** Handling a refused tick (plans/refusal-and-thrash.md): the run declined its work and ended
 * with TUMWATER_REFUSED. Only the markdown objection note may land — it is the durable record
 * that blocks the entry for later ticks; any non-markdown half-work is discarded, tracked edits
 * via reset --hard and untracked files via clean -fd (the committed note is safe at HEAD by
 * then). A refusal with no note left resets the worktree cleanly and lets the reason live in
 * the event + lastSummary only. The note commit merges directly: md-only diffs are review-exempt
 * by construction under the gate's exemption patterns, so routing it through the gate would burn
 * nothing but add a failure mode for a record that is not code. Split out of loop.ts — which
 * keeps the tick lifecycle around it — because this is a self-contained concern with its own
 * policy and its own git surface (commit-only-the-notes / reset); the only things it borrows
 * from the loop are identity, the pre-commit counters for the trailer, and the loop's shared
 * merge wiring. */

/** A self-contradicted refusal: the reply declares a refusal yet also carries a SUMMARY —
 * the contract field of a work-completed reply — beside non-markdown work in the worktree.
 * BUGS.md 2026-09-23: discarding half-done work is fine for a genuine objection, but a reply
 * that both reports its work and "refuses" it is discrediting itself — the destruction a
 * refusal performs (reset --hard / clean) would throw away finished, tested output. Returns
 * the offending work files (empty when the refusal stands: no non-markdown work, or no
 * SUMMARY beside it). */
export async function refusalContradiction(
  wt: string,
  finalText: string | undefined,
): Promise<string[]> {
  const workFiles = (await changedFiles(wt)).filter((f) => !f.toLowerCase().endsWith(".md"));
  if (workFiles.length === 0) return [];
  return labeledLine(finalText ?? "", "SUMMARY") ? workFiles : [];
}

/** `headMd` with the Refused notes this run newly added to `## Planned` entries that `baseMd`
 * still holds as blocked by a prerequisite dropped: the block already holds such a plan and lifts
 * by itself when the prerequisite lands, whereas a Refused note would hold it until a human
 * releases it. An entry qualifies when head carries a Refused note, base has the same entry
 * (entryKey) with none, and entryHoldAgainst reads it as blocked on base. Returns the rewritten
 * text and the dropped entries' titles; `headMd` itself and [] when nothing qualifies. */
export function withoutBlockedPlanRefusals(
  baseMd: string,
  headMd: string,
): { md: string; dropped: string[] } {
  const basePlanned = parseEntryDetails(baseMd, "Planned");
  const baseByKey = new Map(basePlanned.map((e) => [entryKey(e.title), e]));
  const baseParts = plannedPartKeys(basePlanned);
  const lines = headMd.split("\n");
  const dropped: string[] = [];
  const ranges = actionableEntryRanges(headMd, "Planned");
  for (const range of ranges.reverse()) {
    const slice = lines.slice(range.start - 1, range.end);
    if (refusalNote(slice.join("\n")) === null) continue;
    const baseEntry = baseByKey.get(entryKey(range.title));
    if (baseEntry === undefined || refusalNote(baseEntry.body) !== null) continue;
    const hold = entryHoldAgainst(baseEntry, baseParts);
    if (hold === null || typeof hold === "string") continue;
    lines.splice(range.start - 1, slice.length, ...withoutRefusalNotes(slice));
    dropped.unshift(range.title);
  }
  return dropped.length === 0 ? { md: headMd, dropped } : { md: lines.join("\n"), dropped };
}

/** What handleRefusal needs from its owning loop: identity, this tick's assistant-turn count
 * (deliberately not on LoopState — see TickUsage.turns, src/tick/tick-usage.ts), and the
 * loop's shared merge landing so a conflict-resolution run folds into the same tick counters as
 * an authoring run. */
export interface RefusalContext {
  role: string;
  root: string;
  mainBranch: string;
  /** Assistant turns folded into this tick so far (main + transient retry) — the same field
   * the friction flag reads. */
  turns: number;
  /** Land the worktree branch on main with the loop's shared wiring. */
  merge(wt: string, summary: string): Promise<TickResult>;
}

/** Handle a refused tick and return its outcome. Never throws: a failed note merge is recorded
 * in `state.lastError` and reported through the "refused" result like any other non-landing. */
export async function handleRefusal(
  ctx: RefusalContext,
  state: LoopState,
  wt: string,
  pi: PiRunResult,
): Promise<TickOutcome> {
  const reason = (pi.refusedReason ?? "").trim() || "no reason given";
  const plansFile = path.join(wt, "PLANS.md");
  if (fs.existsSync(plansFile)) {
    const { md, dropped } = withoutBlockedPlanRefusals(
      await fileContentAt(wt, ctx.mainBranch, "PLANS.md"),
      fs.readFileSync(plansFile, "utf8"),
    );
    if (dropped.length > 0) {
      // Atomic (tmp+rename): the note-stripped PLANS.md is committed to main moments later,
      // and a plain writeFileSync that a kill interrupted would commit a truncated file,
      // permanently dropping the plan entries past the cut point. writeTextAtomic is the
      // harness's one write-to-temp-then-rename entry point — the same one backlog-write.ts
      // and question-answer.ts use for the markdown backlog files.
      writeTextAtomic(plansFile, md);
      for (const title of dropped) {
        logEventBestEffort(ctx.root, {
          source: ctx.role,
          type: "warning",
          message: `dropped refusal note on blocked plan "${title}": its prerequisite is still planned, so the block already holds it`,
        });
      }
    }
  }
  const notes = (await changedFiles(wt)).filter((f) => f.toLowerCase().endsWith(".md"));
  let commit: string | undefined;
  if (notes.length > 0) {
    // Subject + trailer only — a refusal carries no WHY/RISK/VERIFIED body; the reason is
    // the subject, and the trailer's turn count is the same field the friction flag reads.
    const message = buildCommitMessage(
      stampedSubject(baseRoleOf(ctx.role), `refuse — ${reason}`),
      null,
      commitTrailer(ctx.role, state.ticks, ctx.turns, state.peakContextTokens),
    );
    commit = (await commitPathsAndDiscardRest(wt, message, notes)) ?? undefined;
  }
  if (!commit) {
    // No note landed (none left, or nothing stageable): reset and keep the reason in the
    // event + lastSummary only.
    await resetWorktreeToMain(wt, ctx.mainBranch);
    return { result: "refused", summary: reason };
  }
  const result = await ctx.merge(wt, `refused: ${reason}`);
  if (result !== "changed") state.lastError = `refusal note merge failed: ${result}`;
  // A landed refusal note is a landed change too: it supersedes a stale rejection exactly as
  // applyLandingOutcome's landed branch does (this path merges directly, bypassing that fold).
  else {
    clearSupersededRejection(state);
    // Page the operator: the entry stays held until a human or the director lifts it. Best-effort —
    // the note has already landed.
    logEventBestEffort(ctx.root, { source: ctx.role, type: "entry_refused", reason, files: notes });
  }
  return { result: "refused", summary: reason, commit };
}
