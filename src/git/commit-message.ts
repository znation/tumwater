import { truncate, joinParts } from "../text/text.js";
import { compactTokens } from "../text/format.js";
import { modelLabel } from "../agent/backend-traits.js";
import { labeledLine } from "../verdict/reply-contract.js";
import type { MergeClaim } from "../merge/merge-withdrawn.js";
import type { PriorReview } from "../merge/merge-queue.js";
// The trailer-line shapes are owned by the merge queue: reusing its fail-closed validators here
// (the same ones its queue-file reader applies) keeps the commit-trailer and queue-file readers
// agreeing on what a well-formed Claim / Prior-review value is, instead of spelling the check
// twice. merge-queue imports nothing from the git layer, so this adds no cycle.
import { isMergeClaim, isPriorReview } from "../merge/merge-queue.js";

/** Assembling run commit messages from pi's final reply: the SUMMARY line becomes the
 * subject, the WHY/RISK/VERIFIED block becomes the body, and the harness stamps a trailer
 * with run metadata. Split out of prompt.ts — which keeps building the prompts that declare
 * this contract (the machine-detectable half — sentinel and verdict-line detection — lives in
 * reply-contract.ts) — because turning a reply into what `git commit` receives is the git side
 * of the contract, consumed by the run pipeline (run-stage.ts, run-summary-recovery.ts,
 * run-verdict.ts) and refusal.ts. */

/** Cap on the commit subject's summary portion (the SUMMARY line), so a verbose model cannot
 * bloat every commit subject. Truncated with an ellipsis — like the body fields below — rather
 * than silently cut mid-word, which would read as if the subject were complete. */
const COMMIT_SUMMARY_MAX = 100;

/** The untruncated SUMMARY length when it exceeds COMMIT_SUMMARY_MAX (extractSummary would cut
 * it); null when it fits or the reply has no SUMMARY line. */
export function summaryOverCap(finalText: string): number | null {
  const summary = labeledLine(finalText, "SUMMARY");
  return summary !== null && summary.length > COMMIT_SUMMARY_MAX ? summary.length : null;
}

/** Pull the SUMMARY: line out of a pi final reply; null when absent. Capped at
 * COMMIT_SUMMARY_MAX chars with an ellipsis (consistent with extractCommitBody's field cap). */
export function extractSummary(finalText: string): string | null {
  const summary = labeledLine(finalText, "SUMMARY");
  return summary === null ? null : truncate(summary, COMMIT_SUMMARY_MAX);
}

/** The subject for a changed run whose reply — and whose follow-up request — carried no
 * SUMMARY line: named from what actually changed, so the log still says what the commit touched
 * instead of only which role made it. Up to three repo-relative paths (worktree order), then a
 * count; capped like a real summary. Falls back to the bare "<role> run N" only when nothing is
 * known. */
export function fallbackSummary(files: string[], role: string, runNumber: number): string {
  if (files.length === 0) return `${role} run ${runNumber}`;
  const shown = files.slice(0, 3).join(", ");
  const rest = files.length > 3 ? ` and ${files.length - 3} more` : "";
  return truncate(`Update ${shown}${rest}`, COMMIT_SUMMARY_MAX);
}

/** Cap on each commit-body field. It only bounds a runaway reply: at 200 it cut almost half of
 * all body lines, which reviewers rejected as incomplete claims. */
const COMMIT_BODY_FIELD_MAX = 1000;

/** The author's explanation of a change — the WHY/RISK/VERIFIED half of the SUMMARY_BLOCK
 * contract declared by reply-contract.ts. Each field is optional: a non-compliant reply still
 * commits (subject + trailer). A revision run (plans/reviewer-as-role.md part 4/4) may also
 * carry Objection lines — numbered answers to the prior review's objections the author wrote
 * into the closing block, kept beside the body so the re-review reads a claim per objection.
 * Module-private: every consumer — extractCommitBody, formatCommitBody, buildCommitMessage —
 * lives in this file, and run-stage.ts works with the extracted values structurally rather than
 * naming the type. */
interface CommitBody {
  why?: string;
  risk?: string;
  verified?: string;
  objections?: { n: number; text: string }[];
}

/** A numbered `Objection N: <disposition>` line a revision run's reply carries (the closing
 * contract buildRevisionNote teaches, gate-notes.ts) — the author's answer to the prior
 * review's Nth numbered objection. Anchored at line start so prose that merely mentions an
 * objection mid-sentence cannot be read as one. */
const OBJECTION_LINE = /^\s*Objection (\d+):\s*(.+)\s*$/gm;

/** Pull the numbered Objection lines out of a reply, each capped like a body field. */
function extractObjections(finalText: string): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = [];
  for (const m of finalText.matchAll(OBJECTION_LINE)) {
    out.push({ n: Number(m[1]), text: truncate(m[2] ?? "", COMMIT_BODY_FIELD_MAX) });
  }
  // Preserve the numbered order regardless of where the author placed each line.
  out.sort((a, b) => a.n - b.n);
  return out;
}

/** Pull the WHY:/RISK:/VERIFIED: lines out of a pi final reply via the shared labeled-line
 * parser, tolerant of any subset being absent (a non-compliant reply still commits), each field
 * capped at COMMIT_BODY_FIELD_MAX (truncate + ellipsis). Null when none were found. */
export function extractCommitBody(finalText: string): CommitBody | null {
  const pick = (label: string): string | undefined => {
    const v = labeledLine(finalText, label);
    return v === null ? undefined : truncate(v, COMMIT_BODY_FIELD_MAX);
  };
  const body: CommitBody = {
    why: pick("WHY"),
    risk: pick("RISK"),
    verified: pick("VERIFIED"),
  };
  const objections = extractObjections(finalText);
  if (objections.length > 0) body.objections = objections;
  return body.why || body.risk || body.verified || objections.length > 0 ? body : null;
}

/** Add the pre-queue self-check fix-up turn's RISK and VERIFIED lines to the run's body, each
 * after the authoring run's own line as `(self-check: …)`. The fix-up turn answers the
 * self-check's findings, not the change. When its lines replaced the authoring run's, the commit
 * described that answer over the whole diff ("No code changed" on a full feature), and review
 * rejected it as claims-vs-diff (BUGS.md 2026-10-21). Its WHY is dropped for the same reason.
 * Returns `base` unchanged when the reply has neither line. */
export function appendSelfCheckNotes(base: CommitBody | null, fixUp: CommitBody | null): CommitBody | null {
  if (!fixUp?.risk && !fixUp?.verified) return base;
  const note = (own: string | undefined, added: string | undefined): string | undefined =>
    added === undefined ? own : own === undefined ? `self-check: ${added}` : `${own} (self-check: ${added})`;
  return { ...base, risk: note(base?.risk, fixUp.risk), verified: note(base?.verified, fixUp.verified) };
}

/** The body's lines in commit order ("WHY: …\nRISK: …\nVERIFIED: …\nObjection N: …"); "" when
 * the body has no fields. Objection lines follow the VERIFIED line, numbered as the author
 * wrote them. Empty when the body is empty. */
export function formatCommitBody(body: CommitBody): string {
  return joinParts(
    [
      body.why && `WHY: ${body.why}`,
      body.risk && `RISK: ${body.risk}`,
      body.verified && `VERIFIED: ${body.verified}`,
      ...(body.objections ?? []).map((o) => `Objection ${o.n}: ${o.text}`),
    ],
    "\n",
  );
}

/** The harness-stamped trailer line of every run commit — truth from the run's counters, not
 * model claims. `turns` sums this run's pre-commit pi runs (main + transient retry); `peakCtx`
 * is their largest single-request context. A changed run flagged high-friction (plans/
 * refusal-and-thrash.md) appends a sibling Friction line after the Run line — minutes rounded,
 * e.g. `Friction: high (41 turns / 62m)`; only changed runs carry it, so the refusal path
 * never passes the argument and the Run line's asserted format stays stable. A `modelLine` (see
 * modelTrailerLine) goes on its own line directly after the Run line, before Friction and
 * Revision. A `claim` (the backlog entry a run worked) and a `priorReview` (the review a
 * revision answers) each ride on their own trailer line — `Claim:` and `Prior-review:` —
 * appended after the Friction line and before Revision, so Revision stays last; each is absent
 * on the runs that do not carry it (a user-request run has no claim, a fresh change no prior
 * review), keeping the line order stable for the other cases. */
export function commitTrailer(
  role: string,
  runNumber: number,
  turns: number,
  peakCtx: number,
  highFrictionMinutes?: number,
  revisionRound?: number,
  modelLine?: string,
  claim?: MergeClaim,
  priorReview?: PriorReview,
): string {
  const base = `Run: ${role} #${runNumber} · turns ${turns} · ctx ${compactTokens(peakCtx)}`;
  const model = modelLine === undefined ? "" : `\n${modelLine}`;
  const friction =
    highFrictionMinutes === undefined
      ? ""
      : `\nFriction: high (${turns} turns / ${Math.round(highFrictionMinutes)}m)`;
  // Each merge-only field rides on its own trailer line, appended before the Revision line so
  // Revision stays last; absent fields add nothing, keeping the line order the other cases assert.
  const claimLine = claim === undefined ? "" : `\nClaim: ${JSON.stringify(claim)}`;
  const priorReviewLine =
    priorReview === undefined ? "" : `\nPrior-review: ${JSON.stringify(priorReview)}`;
  // The revision line is last and absent on a fresh change: leftover recovery reads it back to
  // keep the rejected change's round when the queue marker is lost (plans/revise-rejected.md).
  const revision = revisionRound === undefined ? "" : `\nRevision: ${revisionRound}`;
  return `${base}${model}${friction}${claimLine}${priorReviewLine}${revision}`;
}

/** The trailer's Model line: the model and backend a run's seam started on, e.g.
 * `Model: claude-opus-5-5 · backend claude`; `default` when the seam names no model. */
export function modelTrailerLine(
  agent: string,
  provider: string | undefined,
  model: string | undefined,
): string {
  return `Model: ${model === undefined ? "default" : modelLabel(agent, provider, model)} · backend ${agent}`;
}

/** The high-friction trailer line a flagged run's commit carries (see commitTrailer) — the
 * durable record recovery reads back. Anchored to the whole line so prose that merely mentions
 * friction cannot set the flag. */
const FRICTION_TRAILER = /^Friction: high \(\d+ turns \/ \d+m\)$/m;

/** True when a commit message carries the harness-stamped high-friction trailer. */
export function hasFrictionTrailer(message: string): boolean {
  return FRICTION_TRAILER.test(message);
}

/** The revision trailer line a revision commit carries (see commitTrailer). Anchored to the
 * whole line so prose cannot claim a round. */
const REVISION_TRAILER = /^Revision: (\d+)$/m;

/** The revision round a commit message records — the harness-stamped `Revision: N` line — or
 * undefined for a fresh change. Leftover recovery reads this off the pinned commit so a
 * retriable revision keeps its round (and its rejected ref's cleanup) across a lost queue
 * marker (plans/revise-rejected.md). */
export function revisionRoundOf(message: string): number | undefined {
  const m = REVISION_TRAILER.exec(message);
  return m ? Number(m[1]) : undefined;
}

/** The run number a harness-stamped commit's Run trailer records (`Run: <role> #N · turns …`,
 * see commitTrailer), or undefined for a hand-made commit that carries no such line. The
 * drain's pin-scan entry builder reads it back so a kept pin keeps its authoring run for the
 * unique per-run session names — the one recoverable run when no runner is live to supply the
 * current one. */
const RUN_TRAILER = /^Run: .+ #(\d+) · turns /m;

/** The authoring run number a commit message's Run trailer records, or undefined for a
 * hand-made/unstamped commit. */
export function commitRunOf(message: string): number | undefined {
  const m = RUN_TRAILER.exec(message);
  return m ? Number(m[1]) : undefined;
}

/** The fields a merge request needs that a commit message can supply: the commit's subject (WHAT
 * merged — recovery rides it into its `merged` summary so the failure digest can name recovered
 * work, BUGS.md 2026-09-21), the author's body (WHY/RISK/VERIFIED, reformatted), whether the run
 * was high-friction, the revision round, and — the two merge-only fields the durable queue entry
 * used to hold — the backlog claim the run worked and the review a revision answers; a pin-only
 * merge reads them back off the commit (part 3e/7). */
export interface CommitMetadata {
  subject?: string;
  body?: string;
  highFriction?: boolean;
  /** The revision round this commit is, absent for a fresh change (plans/revise-rejected.md). */
  revisionRound?: number;
  /** The backlog entry the run worked — its file, key and title — absent for a run executing a
   * user request (run-stage stamps it only when `userPrompt` is null). */
  claim?: MergeClaim;
  /** The review a revision answers — the prior head, its objections and their counts — absent on a
   * fresh change. */
  priorReview?: PriorReview;
}

/** The backlog-claim trailer line a run commit carries (see commitTrailer): a whole `Claim: <json>`
 * line — JSON with `file` (PLANS.md or BUGS.md), `key` and `title` — stamped only when the run
 * worked a backlog entry, never when it executed a user request. Anchored to the whole line and
 * validated fail-closed (isMergeClaim) like revisionRoundOf, so prose that merely names the backlog
 * cannot be read as a claim. */
export function claimOf(message: string): MergeClaim | undefined {
  for (const line of message.split("\n")) {
    if (!line.startsWith("Claim: ")) continue;
    const value: unknown = parseJson(line.slice("Claim: ".length));
    return isMergeClaim(value) ? value : undefined;
  }
  return undefined;
}

/** The prior-review trailer line a revision commit carries (see commitTrailer): a whole
 * `Prior-review: <json>` line — JSON with `sha`, `reasons` and optional `counts` — stamped only
 * on a revision run that held the rejected diff, absent on a fresh change. Anchored to the whole
 * line and validated fail-closed (isPriorReview) like revisionRoundOf, so prose cannot be read
 * as a prior review. */
export function priorReviewOf(message: string): PriorReview | undefined {
  for (const line of message.split("\n")) {
    if (!line.startsWith("Prior-review: ")) continue;
    const value: unknown = parseJson(line.slice("Prior-review: ".length));
    return isPriorReview(value) ? value : undefined;
  }
  return undefined;
}

/** Parse one trailer line's JSON payload, returning null (not a throw) when it is malformed or not
 * a plain object — the fail-closed base of the `Claim:` and `Prior-review:` readers above, which
 * read a bad line as the field being absent rather than crashing a parse. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The harness-stamped commit-subject prefix — the `tumwater(<role>):` part run-stage.ts (and
 * refusal.ts) adds before the SUMMARY line, space included when a summary follows. */
const SUBJECT_PREFIX = /^tumwater\(([^)]+)\):(?:\s|$)/;

/** Build a harness-stamped commit subject: `tumwater(<role>): <summary>` — the exact shape
 * SUBJECT_PREFIX below matches, so the stamp's writers (run-stage.ts's normal run commit and
 * refusal.ts's refusal note) and its parser live in one file and cannot drift apart. */
export function stampedSubject(role: string, summary: string): string {
  return `tumwater(${role}): ${summary}`;
}

/** The commit subject's summary portion: the message's first line with the harness's
 * `tumwater(<role>): ` stamp stripped. A hand-made commit has no stamp and rides its whole
 * subject; undefined when the line is empty or the stamp is all there is (nothing left to
 * name). The stamp itself carries only the role, which the caller already names. */
export function commitSubject(message: string): string | undefined {
  const line = (message.split("\n", 1)[0] ?? "").trim();
  if (!line) return undefined;
  const m = SUBJECT_PREFIX.exec(line);
  if (!m) return line;
  const rest = line.slice(m[0].length).trim();
  return rest === "" ? undefined : rest;
}

/** The `<role>` of a commit subject the harness stamped (`tumwater(<role>): …`); undefined for an
 * unstamped line. */
export function stampedRole(message: string): string | undefined {
  const line = (message.split("\n", 1)[0] ?? "").trim();
  return SUBJECT_PREFIX.exec(line)?.[1];
}

/** Reconstruct the review-gate metadata from a commit message the harness stamped itself.
 * Leftover recovery has no authoring run to read from, so the pinned commit's message is the
 * only source of truth: without this a recovered high-friction change loses both its flag and
 * its WHY/RISK/VERIFIED and is reviewed as if it were routine, and its merged event names the
 * recovery but not the work (BUGS.md 2026-09-21). Absent fields read as undefined when the
 * message carries none of them (e.g. a hand-made or non-compliant commit). */
export function parseCommitMetadata(message: string): CommitMetadata {
  const body = extractCommitBody(message);
  const revisionRound = revisionRoundOf(message);
  const claim = claimOf(message);
  const priorReview = priorReviewOf(message);
  return {
    subject: commitSubject(message),
    body: body ? formatCommitBody(body) : undefined,
    highFriction: hasFrictionTrailer(message) || undefined,
    ...(revisionRound !== undefined ? { revisionRound } : {}),
    ...(claim !== undefined ? { claim } : {}),
    ...(priorReview !== undefined ? { priorReview } : {}),
  };
}

/** Assemble a run's full commit message — the single place that builds one. The subject is
 * the existing "tumwater(<role>): <summary>" line; the author's body (omitted when absent)
 * and the harness-stamped trailer follow as separate paragraphs. Refusal commits route
 * through here too (subject + trailer only). */
export function buildCommitMessage(subject: string, body: CommitBody | null, trailer: string): string {
  const formatted = body ? formatCommitBody(body) : "";
  return formatted ? `${subject}\n\n${formatted}\n\n${trailer}` : `${subject}\n\n${trailer}`;
}
