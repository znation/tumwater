/** Parsing of the reviewer's reply into a verdict — split out of review.ts so the review gate
 * (reviewAheadOfMain) and the reply-shape contract it reads (reply-contract.ts's verdictLines)
 * each have a single responsibility: this module knows how a reviewer reply is shaped, the
 * gate knows what to do about one. It depends only on the reply contract and build-check-report's
 * clipReason (the shared per-line cap for persisted machine text). */

import { verdictLines, type VerdictMatch } from "../verdict/reply-contract.js";
import { clipReason } from "../build/build-check-report.js";

/** A parsed reviewer verdict with its reasons (numbered lines after the VERDICT line; any
 * other non-empty prose as a fallback). */
interface ReviewVerdict {
  verdict: "approve" | "reject";
  reasons: string[];
}

/** Cap on recorded reasons, so a chatty reviewer cannot bloat persisted state. */
const MAX_REASONS = 10;

/** Parse the reviewer's reply: the LAST VERDICT line wins (the prompt asks for exactly one),
 * followed by its reasons — numbered/bulleted lines first, any other non-empty prose as a
 * fallback. Null when no parseable verdict exists: that is a FAILED review, never an approval
 * (fail closed). */
export function parseVerdict(text: string): ReviewVerdict | null {
  const matches = verdictLines(text);
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  if (!last) return null; // Unreachable: the length check above guarantees a match.
  // A verdict line is a marker, not a boundary: reasons may sit below the LAST verdict
  // line (the prompt's advertised shape — searched first), anywhere above it, or as prose
  // anywhere in the reply. Each region yields its numbered/bulleted lines, falling back to
  // its non-empty prose, and the first region whose reasons survive the reject filter wins.
  const after = text.slice(last.end);
  for (const reasons of [reasonsFrom(after), reasonsFrom(textWithoutVerdictLines(text, matches))]) {
    if (reasons.length === 0) continue;
    // A rejection's reasons are what the author is told to fix and what every reasons[0]
    // surface names, so a leading statement that the prior objections are resolved is
    // dropped: it is a resolution, not an outstanding objection (see
    // withoutResolvedPriorObjections). When that leaves nothing, the first region held only
    // a resolution, so the next region is tried — it may carry the objections stated above
    // the verdict line. Returning reasons: [] here would hide them.
    const kept = last.verdict === "reject" ? withoutResolvedPriorObjections(reasons) : reasons;
    if (kept.length === 0) continue;
    return { verdict: last.verdict, reasons: kept.slice(0, MAX_REASONS).map(clipReason) };
  }
  return { verdict: last.verdict, reasons: [] };
}

/** Numbered/bulleted lines first, any other non-empty prose as a fallback — over one region
 * of a reviewer reply. The prose fallback skips lead-ins and headings (isPreamble), so the
 * first reason is the reply's first finding, not "…Findings:" or "## Review"; a region of
 * nothing but those still yields them, since a lead-in beats recording no reason at all.
 * Empty when the region carries no lines at all. */
function reasonsFrom(region: string): string[] {
  const lines = region.split("\n").map((l) => l.trim()).filter(Boolean);
  const numbered = lines.map(listItemText).filter((r): r is string => Boolean(r));
  if (numbered.length > 0) return numbered;
  const findings = lines.filter((l) => !isPreamble(l));
  return findings.length > 0 ? findings : lines;
}

/** A list item: `1.`/`1)` numbering or a `-`/`*` bullet, optionally inside a markdown
 * heading (`### 1. X`) and/or opened by bold (`**1.** X`, `**1. X.** body` — the shape
 * reviewers most often number their findings in, which a bare-marker match missed so the
 * whole reply fell to the prose fallback and its preamble became the first reason). Group 1
 * is the bold opener, group 2 a bold closer directly after the marker, group 3 the text. */
const LIST_ITEM = /^(?:#{1,6}\s+)?(\*\*)?(?:\d+[.)]|[-*])(\*\*)?\s+(.+)$/;

/** A list line's item text with the list's own markup gone — marker, heading hashes, and
 * the bold pair around the marker, whose closer sits right after it (`**1.** X`) or ends the
 * lead (`**1. X.** body` → `X. body`), so no reason carries a dangling `**`. Emphasis inside
 * the item (`1. **X** body`) is the reviewer's own and is kept. Undefined for a non-item. */
function listItemText(line: string): string | undefined {
  const m = line.match(LIST_ITEM);
  if (!m?.[3]) return undefined;
  const text = m[1] && !m[2] ? m[3].replace("**", "") : m[3];
  return text.trim() || undefined;
}

/** A prose line that introduces findings rather than stating one: a markdown heading
 * (`## Review`) or a lead-in ending in a colon ("…Findings:", "Here is what I verified:",
 * "**Summary:**"). */
function isPreamble(line: string): boolean {
  return /^#{1,6}(?:\s|$)/.test(line) || /:(?:\*\*)?$/.test(line);
}

/** The reply with every VERDICT line removed, so reasons are read from the whole text (a
 * verdict line is a marker, not the start of the payload) without a verdict line itself
 * surfacing as a prose-fallback reason. */
function textWithoutVerdictLines(text: string, matches: VerdictMatch[]): string {
  let out = "";
  let pos = 0;
  for (const m of matches) {
    out += text.slice(pos, m.index);
    pos = m.end;
  }
  return out + text.slice(pos);
}

/** Drop leading prior-objection resolution statements from a rejection's reason list. A
 * revision re-review is asked to check the prior objections FIRST, so a reviewer may open its
 * numbered reasons with a statement that they are all resolved — e.g. "Prior objections 1–10
 * are all resolved — …". That resolution is not an objection, yet every reasons[0] consumer
 * (the gate's detail, a loop's lastError, the digest's rejection clusters, the author's
 * next-tick note) would name it as the outstanding rejection and tell the author to fix it.
 * Dropping only from the FRONT keeps a line that reports an objection still open — those are
 * real objections and stay. */
function withoutResolvedPriorObjections(reasons: readonly string[]): string[] {
  let firstKept = 0;
  while (firstKept < reasons.length && isResolvedPriorObjection(reasons[firstKept] ?? "")) firstKept++;
  return firstKept === 0 ? [...reasons] : reasons.slice(firstKept);
}

/** Whether a reason is solely a prior-objection resolution statement. Conservative by design:
 * a line is dropped only when it names the prior objections, states them resolved, and carries
 * no sign of an outstanding or newly stated objection (see hasOutstandingSignal). A resolution
 * left in the list is a redundant reason; a dropped objection is the author being told to fix
 * nothing, so anything ambiguous is kept. */
function isResolvedPriorObjection(reason: string): boolean {
  const text = reason.toLowerCase();
  if (!/\bprior objections?\b/.test(text)) return false;
  if (hasOutstandingSignal(text)) return false;
  return /\bresolved\b|\baddressed\b|\bsatisfied\b|\bfixed\b|\bno longer\b|\bclosed\b/.test(text);
}

/** Whether a resolution-shaped line also carries an outstanding or newly stated objection: a
 * negation ("not resolved", "not yet fully resolved"), a contrast that introduces another
 * item ("but", "however", "except", "though", "yet"), or an action/defect word
 * ("requires", "fails", "missing"). A bare "outstanding" is a signal too, unless it is
 * negated ("objection 6 is outstanding" keeps the line; "none is an outstanding rejection"
 * does not). */
function hasOutstandingSignal(text: string): boolean {
  if (
    /\bunresolved\b|\bnot\b|\bcannot\b|\bstill\b|\bremains?\b|\bpending\b|\bbut\b|\bhowever\b|\bexcept\b|\bthough\b|\balthough\b|\byet\b|\brequires?\b|\bneeds?\b|\bshould\b|\bmust\b|\bfails?\b|\bmissing\b|\bincorrect\b|\bbroken\b|\bwrong\b|\bbugs?\b|\berror\b/.test(
      text,
    )
  ) {
    return true;
  }
  return /\boutstanding\b/.test(text) && !/\b(?:none|no|nothing|never)\b[^.;]*\boutstanding\b/.test(text);
}
