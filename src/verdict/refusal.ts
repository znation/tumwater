import fs from "node:fs";
import path from "node:path";
import { commitPathsAndDiscardRest, fileContentAt } from "../git/git.js";
import { writeTextAtomic } from "../files/files.js";
import { parseEntryDetails } from "../backlog/backlog-md.js";
import { actionableEntryRanges } from "../backlog/backlog-index-data.js";
import { stripEntryStamp } from "../backlog/backlog-structure.js";
import { entryHoldAgainst, refusalNote, withoutRefusalNotes } from "../backlog/backlog-eligibility.js";
import { entryKey, plannedPartKeys } from "../backlog/backlog-parts.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { changedFiles } from "../git/git-diff.js";
import { resetWorktreeToMain } from "../git/worktree.js";
import { buildCommitMessage, commitTrailer, stampedSubject } from "../git/commit-message.js";
import { errorMessage } from "../text/text.js";
import { labeledLine } from "./reply-contract.js";
import { logEventBestEffort } from "../events/events.js";
import { clearSupersededRejection } from "../run/run-apply.js";
import type { RunOutcome, RunResult } from "../run/run-outcome.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { RunnerState } from "../runner/runner-state.js";

/** Handling a refused run (plans/refusal-and-thrash.md): the run declined its work and ended
 * with TUMWATER_REFUSED. Only the markdown objection note may merge — it is the durable record
 * that blocks the entry for later runs; any non-markdown half-work is discarded, tracked edits
 * via reset --hard and untracked files via clean -fd (the committed note is safe at HEAD by
 * then). A refusal with no note left resets the worktree cleanly and lets the reason live in
 * the event + lastSummary only. The note commit merges directly: md-only diffs are review-exempt
 * by construction under the gate's exemption patterns, so routing it through the gate would burn
 * nothing but add a failure mode for a record that is not code. Split out of runner.ts — which
 * keeps the run lifecycle around it — because this is a self-contained concern with its own
 * policy and its own git surface (commit-only-the-notes / reset); the only things it borrows
 * from the runner are identity, the pre-commit counters for the trailer, and the runner's shared
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

/** Stamp-free titles of the `section` entries whose Refused note is new on `headMd`: head carries
 * a note and base either lacks the entry (matched by entryKey) or holds it with none. Returned in
 * head's file order, so the entry_refused event can name what is now held. */
export function newlyRefusedTitles(baseMd: string, headMd: string, section: string): string[] {
  const baseByKey = new Map(parseEntryDetails(baseMd, section).map((e) => [entryKey(e.title), e]));
  return parseEntryDetails(headMd, section)
    .filter((e) => {
      if (refusalNote(e.body) === null) return false;
      const base = baseByKey.get(entryKey(e.title));
      return base === undefined || refusalNote(base.body) === null;
    })
    .map((e) => stripEntryStamp(e.title));
}

/** What handleRefusal needs from its owning runner: identity, this run's assistant-turn count
 * (deliberately not on RunnerState — see RunUsage.turns, src/run/run-usage.ts), and the
 * runner's shared merge step so a conflict-resolution run folds into the same run counters as
 * an authoring run. */
export interface RefusalContext {
  /** The trailer's Model line for the seam the refused run started on. */
  modelLine?: string;
  role: string;
  root: string;
  mainBranch: string;
  /** Assistant turns folded into this run so far (main + transient retry) — the same field
   * the friction flag reads. */
  turns: number;
  /** Merge the worktree branch on main with the runner's shared wiring. */
  merge(wt: string, summary: string): Promise<RunResult>;
}

/** Handle a refused run and return its outcome. Never throws: a failed note merge (a non-merge
 * result, or a throw such as a lock timeout) is recorded in `state.lastError` and reported
 * through the "refused" result like any other non-merge. A failed write of the stripped PLANS.md
 * logs a warning and leaves PLANS.md out of the commit, so the other notes still merge. */
export async function handleRefusal(
  ctx: RefusalContext,
  state: RunnerState,
  wt: string,
  pi: PiRunResult,
): Promise<RunOutcome> {
  const reason = (pi.refusedReason ?? "").trim() || "no reason given";
  const plansUnstripped = await stripBlockedPlanRefusalNotes(ctx, wt);
  const notes = await collectRefusalNotes(wt, plansUnstripped);
  const entries = await collectRefusedEntryTitles(ctx, wt, notes);
  return mergeRefusalNotes(ctx, state, wt, reason, notes, entries);
}

/** Strip this run's newly added Refused notes from any `## Planned` entry main still holds as
 * blocked by a planned prerequisite. Returns whether the strip write failed: a throw leaves the
 * flag set and PLANS.md out of the commit, so the other notes still merge. */
async function stripBlockedPlanRefusalNotes(ctx: RefusalContext, wt: string): Promise<boolean> {
  const plansFile = path.join(wt, "PLANS.md");
  let plansUnstripped = false;
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
      try {
        writeTextAtomic(plansFile, md);
        for (const title of dropped) {
          logEventBestEffort(ctx.root, {
            source: ctx.role,
            type: "warning",
            message: `dropped refusal note on blocked plan "${title}": its prerequisite is still planned, so the block already holds it`,
          });
        }
      } catch (err) {
        plansUnstripped = true;
        logEventBestEffort(ctx.root, {
          source: ctx.role,
          type: "warning",
          message: `could not drop refusal note(s) on blocked plan(s) ${dropped.map((t) => `"${t}"`).join(", ")}: ${errorMessage(err)}; PLANS.md is left out of this refusal's commit`,
        });
      }
    }
  }
  return plansUnstripped;
}

/** The markdown notes this refusal may commit: changed `.md` files, PLANS.md dropped only when
 * the blocked-plan strip write failed. */
async function collectRefusalNotes(wt: string, plansUnstripped: boolean): Promise<string[]> {
  return (await changedFiles(wt)).filter(
    (f) => f.toLowerCase().endsWith(".md") && !(plansUnstripped && f === "PLANS.md"),
  );
}

/** Best-effort names for the entry_refused event, per changed file's section — it must never
 * fail the refusal, so a read error swallows and leaves that file unnamed. */
async function collectRefusedEntryTitles(
  ctx: RefusalContext,
  wt: string,
  notes: string[],
): Promise<string[]> {
  const entries: string[] = [];
  for (const { file, section } of [{ file: "PLANS.md", section: "Planned" }, { file: "BUGS.md", section: "Open" }]) {
    if (!notes.includes(file)) continue;
    try {
      entries.push(...newlyRefusedTitles(
        await fileContentAt(wt, ctx.mainBranch, file),
        fs.readFileSync(path.join(wt, file), "utf8"),
        section,
      ));
    } catch {
      // Unnamed is fine: the event still carries reason and files.
    }
  }
  return entries;
}

/** Merge this refusal's notes onto main: commit only the markdown notes (subject + trailer only —
 * a refusal carries no WHY/RISK/VERIFIED body; the reason is the subject, and the trailer's turn
 * count is the same field the friction flag reads), then merge directly. A failed note merge (a
 * throw such as a lock timeout, or a non-"changed" result) is recorded in `state.lastError` and
 * reported through the "refused" result like any other non-merge. A merged refusal note supersedes
 * a stale rejection exactly as applyMergeOutcome's merged branch does (this path merges directly,
 * bypassing that fold), then pages the operator: the entry stays held until a human or the
 * director lifts it. */
async function mergeRefusalNotes(
  ctx: RefusalContext,
  state: RunnerState,
  wt: string,
  reason: string,
  notes: string[],
  entries: string[],
): Promise<RunOutcome> {
  let commit: string | undefined;
  if (notes.length > 0) {
    const message = buildCommitMessage(
      stampedSubject(baseRoleOf(ctx.role), `refuse — ${reason}`),
      null,
      commitTrailer(
        ctx.role,
        state.runs,
        ctx.turns,
        state.peakContextTokens,
        undefined,
        undefined,
        ctx.modelLine,
      ),
    );
    commit = (await commitPathsAndDiscardRest(wt, message, notes)) ?? undefined;
  }
  if (!commit) {
    // No note merged (none left, or nothing stageable): reset and keep the reason in the
    // event + lastSummary only.
    await resetWorktreeToMain(wt, ctx.mainBranch);
    return { result: "refused", summary: reason };
  }
  let result: RunResult;
  try {
    result = await ctx.merge(wt, `refused: ${reason}`);
  } catch (err) {
    // A lock timeout or `cannot acquire lock`: the note stays committed on the branch for
    // leftover recovery, as for merge_conflict.
    state.lastError = `refusal note merge failed: ${errorMessage(err)}`;
    return { result: "refused", summary: reason, commit };
  }
  if (result !== "changed") state.lastError = `refusal note merge failed: ${result}`;
  else {
    clearSupersededRejection(state);
    // Page the operator: the entry stays held until a human or the director lifts it. Best-effort —
    // the note has already merged.
    logEventBestEffort(ctx.root, { source: ctx.role, type: "entry_refused", reason, files: notes, entries });
  }
  return { result: "refused", summary: reason, commit };
}
