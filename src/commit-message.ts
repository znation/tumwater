/** Assembling tick commit messages from pi's final reply: the SUMMARY line becomes the
 * subject, the WHY/RISK/VERIFIED block becomes the body, and the harness stamps a trailer
 * with tick metadata. Split out of prompt.ts — which keeps building the prompts that declare
 * this contract (and parsing the TUMWATER_NOTHING_TO_DO / VERDICT_LINE sentinels) — because
 * turning a reply into what `git commit` receives is the git side of the contract, consumed
 * only by loop.ts. */

/** Pull the SUMMARY: line out of a pi final reply; null when absent. */
export function extractSummary(finalText: string): string | null {
  const match = finalText.match(/^\s*SUMMARY:\s*(.+)\s*$/m);
  if (!match?.[1]) return null;
  return match[1].trim().slice(0, 100);
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

/** Pull the WHY:/RISK:/VERIFIED: lines out of a pi final reply. One anchored regex per field,
 * tolerant of any subset being absent (a non-compliant reply still commits), each field capped
 * at 200 chars (truncate + ellipsis). Null when none were found. */
export function extractCommitBody(finalText: string): CommitBody | null {
  const pick = (re: RegExp): string | undefined => {
    const m = finalText.match(re);
    if (!m?.[1]) return undefined;
    const v = m[1].trim();
    return v.length > COMMIT_BODY_FIELD_MAX ? `${v.slice(0, COMMIT_BODY_FIELD_MAX - 1)}…` : v;
  };
  const body: CommitBody = {
    why: pick(/^\s*WHY:\s*(.+)\s*$/m),
    risk: pick(/^\s*RISK:\s*(.+)\s*$/m),
    verified: pick(/^\s*VERIFIED:\s*(.+)\s*$/m),
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

/** Compact token count for the commit trailer, matching the status table's style (12k at
 * ≥10,000, bare integer below). */
function compactTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The harness-stamped trailer line of every tick commit — truth from the run's counters, not
 * model claims. `turns` sums this tick's pre-commit pi runs (main + transient retry); `peakCtx`
 * is their largest single-request context. */
export function commitTrailer(role: string, tick: number, turns: number, peakCtx: number): string {
  return `Tick: ${role} #${tick} · turns ${turns} · ctx ${compactTokens(peakCtx)}`;
}

/** Assemble a tick's full commit message — the single place that builds one. The subject is
 * the existing "tumwater(<role>): <summary>" line; the author's body (omitted when absent)
 * and the harness-stamped trailer follow as separate paragraphs. Refusal commits will route
 * through here too (subject + trailer only). */
export function buildCommitMessage(subject: string, body: CommitBody | null, trailer: string): string {
  const formatted = body ? formatCommitBody(body) : "";
  return formatted ? `${subject}\n\n${formatted}\n\n${trailer}` : `${subject}\n\n${trailer}`;
}
