import { compactTokens, truncate } from "./text.js";
import { labeledLine } from "./reply-contract.js";

/** Assembling tick commit messages from pi's final reply: the SUMMARY line becomes the
 * subject, the WHY/RISK/VERIFIED block becomes the body, and the harness stamps a trailer
 * with tick metadata. Split out of prompt.ts — which keeps building the prompts that declare
 * this contract (the machine-detectable half — sentinel and verdict-line detection — lives in
 * reply-contract.ts) — because turning a reply into what `git commit` receives is the git side
 * of the contract, consumed only by loop.ts. */

/** Cap on the commit subject's summary portion (the SUMMARY line), so a verbose model cannot
 * bloat every commit subject. Truncated with an ellipsis — like the body fields below — rather
 * than silently cut mid-word, which would read as if the subject were complete. */
const COMMIT_SUMMARY_MAX = 100;

/** Pull the SUMMARY: line out of a pi final reply; null when absent. Capped at
 * COMMIT_SUMMARY_MAX chars with an ellipsis (consistent with extractCommitBody's field cap). */
export function extractSummary(finalText: string): string | null {
  const summary = labeledLine(finalText, "SUMMARY");
  return summary === null ? null : truncate(summary, COMMIT_SUMMARY_MAX);
}

/** Cap on each commit-body field, so a verbose model cannot bloat every commit. */
const COMMIT_BODY_FIELD_MAX = 200;

/** The author's explanation of a change — the WHY/RISK/VERIFIED half of the SUMMARY_RULE
 * contract declared by prompt.ts. Each field is optional: a non-compliant reply still commits
 * (subject + trailer). */
export interface CommitBody {
  why?: string;
  risk?: string;
  verified?: string;
}

/** Pull the WHY:/RISK:/VERIFIED: lines out of a pi final reply via the shared labeled-line
 * parser, tolerant of any subset being absent (a non-compliant reply still commits), each field
 * capped at 200 chars (truncate + ellipsis). Null when none were found. */
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
  return body.why || body.risk || body.verified ? body : null;
}

/** The body's lines in commit order ("WHY: …\nRISK: …\nVERIFIED: …"); "" when the body is empty. */
export function formatCommitBody(body: CommitBody): string {
  return [
    body.why && `WHY: ${body.why}`,
    body.risk && `RISK: ${body.risk}`,
    body.verified && `VERIFIED: ${body.verified}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The harness-stamped trailer line of every tick commit — truth from the run's counters, not
 * model claims. `turns` sums this tick's pre-commit pi runs (main + transient retry); `peakCtx`
 * is their largest single-request context. A changed tick flagged high-friction (plans/
 * refusal-and-thrash.md) appends a sibling Friction line after the Tick line — minutes rounded,
 * e.g. `Friction: high (41 turns / 62m)`; only changed ticks carry it, so the refusal path
 * never passes the argument and the Tick line's asserted format stays stable. */
export function commitTrailer(
  role: string,
  tick: number,
  turns: number,
  peakCtx: number,
  highFrictionMinutes?: number,
): string {
  const base = `Tick: ${role} #${tick} · turns ${turns} · ctx ${compactTokens(peakCtx)}`;
  return highFrictionMinutes === undefined
    ? base
    : `${base}\nFriction: high (${turns} turns / ${Math.round(highFrictionMinutes)}m)`;
}

/** Assemble a tick's full commit message — the single place that builds one. The subject is
 * the existing "tumwater(<role>): <summary>" line; the author's body (omitted when absent)
 * and the harness-stamped trailer follow as separate paragraphs. Refusal commits will route
 * through here too (subject + trailer only). */
export function buildCommitMessage(subject: string, body: CommitBody | null, trailer: string): string {
  const formatted = body ? formatCommitBody(body) : "";
  return formatted ? `${subject}\n\n${formatted}\n\n${trailer}` : `${subject}\n\n${trailer}`;
}
