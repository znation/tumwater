/** The machine-detectable half of the reply contract every pi run must follow: the
 * TUMWATER_NOTHING_TO_DO sentinel a loop emits when it found nothing to do, the
 * TUMWATER_REFUSED line a loop emits when it declines its task, and the review gate's VERDICT
 * line. This module owns both halves of that contract: the constants and detection the harness
 * uses to parse pi's replies — so the subprocess layer (pi.ts) and the review gate (review.ts)
 * detect it without reaching into prompt construction, and the verdict line's shape lives in
 * exactly one place instead of drifting between detector and parser — and the prompt-side prose
 * constants (the shared closing rules and the claims rules) that tell pi what to emit, so the
 * instructions and the detectors cannot drift apart. */


/** The claim-discipline rules every authoring run carries, stated just before the reply contract
 * they govern. Written against the budgeted model's review record (GLM-5.3-Flash, 2026-09-25..
 * 10-01: 191 of ~1,100 reviewed changes rejected): the leading cause was not wrong code but a
 * false or unchecked claim — "the untested X module" when tests already imported it, a moved block
 * called "byte-identical" that was not, "all references updated" with one left, a suite count
 * off by one, a VERIFIED command that does not exist on the tree — and the next was an edit made
 * after the last green run, which the gate's build check then failed. Each rule names the check
 * that makes its claim true, and none presumes a reviewer or a check exists: a doc-only diff skips
 * the review gate (review.exemptPaths), and a project may declare no check — so the rules name
 * what the run itself must do, and point verification at the check-aware bullet in prompt.ts's
 * commonRules. Backlog files are included because this repo's own suite reads them
 * (backlog-structure and validation-gap tests). The header says small changes are welcome on
 * purpose: a first wording ("one false claim rejects the whole change") made the improve role
 * decline real, small improvements in lab A/B runs, citing the reviewer. Must not mention the
 * reviewer's VERDICT form (prompt tests count it in the review prompt only). */
export const CLAIMS_RULE = `Claims — keep what your change says about itself accurate. Code changes are checked against
the code by an adversarial reviewer before they merge, and an inaccurate claim is what gets a
change rejected; a small, correct change is welcome:
- State only what you verified. SUMMARY, WHY, RISK, VERIFIED, and every doc comment or
  PLANS.md/BUGS.md line you write are claims about the code.
- Back each universal word — "all", "every", "only", "none remain", "untested", "byte-identical",
  "unchanged" — with the check that proves it (a grep over the source, the tests, and the docs;
  a diff), or drop the word.
- Never state test or suite counts: say what you ran and what you saw. When the landing gate runs
  the project's check, the harness attests the numbers itself.
- Verify after your LAST edit, per "Leave the project working" above: an edit made after the last
  green run is unverified, so verify again before you end. Order your work so the final
  verification comes after your last edit, backlog files included.`;

/** Sentinel a loop's pi run outputs when it found nothing worth doing (REPLY_ENDINGS below
 * instructs it). */
export const NOTHING_TO_DO = "TUMWATER_NOTHING_TO_DO";

/** True when `text` declares there was nothing to do (pi.ts's stream parser scans every
 * assistant message, so a declaration in an intermediate turn survives). */
export function isNothingToDo(text: string): boolean {
  return text.includes(NOTHING_TO_DO);
}

/** Sentinel a loop's pi run outputs when it declines its task (see plans/refusal-and-thrash.md):
 * `TUMWATER_REFUSED: <one-line reason>`. The reason is the durable objection — it becomes the
 * commit subject of the refusal note and the tick's lastSummary. */
export const REFUSED_SENTINEL = "TUMWATER_REFUSED";

/** The four-line SUMMARY/WHY/RISK/VERIFIED block itself — the machine-parsed half of the
 * closing contract, shared verbatim by REPLY_ENDINGS (tick, director, and resume prompts) and
 * prompt-followup.ts's buildSummaryRequestPrompt (the follow-up that recovers a missing block),
 * so they cannot drift (sibling of the NOTHING_TO_DO sentinel below, and parsed field-by-field
 * by git/commit-message.ts's labeledLine). */
export const SUMMARY_BLOCK = `  SUMMARY: <imperative one-line description of the change, at most 72 characters>
  WHY: <why the change was made — one or two sentences>
  RISK: <what could break and where to look if it does>
  VERIFIED: <what you ran and observed beyond the suite total (the harness attests the counts), e.g. "the project's check; repro script showed X before, Y after" — write none when nothing was run>`;

/** The reply contract's closing rule: the three mutually exclusive ways a run ends, with the
 * exact SUMMARY/WHY/RISK/VERIFIED block git/commit-message.ts parses into the commit message as the
 * last one. Shared by the tick and director rules (prompt.ts's commonRules) and
 * prompt-followup.ts's resume bridge, so a resumed run ends under the same contract as a fresh
 * one. Written as an either/or list because, stated as separate rules, models filled in every
 * one: 56 fleet ticks ended a SUMMARY block with the nothing sentinel too, and
 * `TUMWATER_REFUSED: none` on completed work once made the harness discard it. The nothing
 * ending says "end your reply with", not "reply with the single line", so a run that must
 * report something first (the director's answer to a question, qa's FLOW line) can. */
export const REPLY_ENDINGS = `- End with exactly ONE of these three endings:
  1. Nothing worth doing for your role right now: make no changes, and end your reply with the
     line ${NOTHING_TO_DO} — anything your task asks you to report (an answer, a FLOW line) goes
     above it.
  2. You refused the task (and recorded its **Refused …** note): end with the line
     ${REFUSED_SENTINEL}: <the same one-line reason>
     Use this line ONLY when refusing — never in any other reply, not even as
     "${REFUSED_SENTINEL}: none", or the harness treats the whole tick as a refusal.
  3. You made changes: end your reply with this block, one line each:
${SUMMARY_BLOCK.replace(/^ {2}/gm, "     ")}`;

/** The review gate's closing rule as stated to pi: the two accepted verdict forms and the
 * numbered-reasons line that must follow them. buildReviewPrompt (gate-prompts.ts) ends its
 * rules list with this, and the gate's two same-session follow-ups (buildVerdictRequestPrompt,
 * buildNoRerunPrompt) re-state it — one home, so the advertised pair is edited in one place
 * instead of drifting between the three prompts. Indentation is the caller's: the review prompt
 * indents both lines, the two follow-ups indent only the VERDICT line. The machine detector for
 * these forms lives beside it (VERDICT_LINE_SOURCE below); gate-prompts.test.ts pins the forms
 * buildReviewPrompt advertises against what parseVerdict accepts. */
export const VERDICT_ENDING = `VERDICT: approve   or   VERDICT: reject
followed by numbered reasons (for an approval, state what you checked and why it holds).`;

/** The trimmed remainder of the first line that starts with `<label>:` (leading whitespace on
 * the line allowed); null when no such line carries content. Shared by every parser that pulls a
 * labeled field out of pi's final reply — SUMMARY/WHY/RISK/VERIFIED in git/commit-message.ts and the
 * TUMWATER_REFUSED reason here — so the anchored-line shape lives in one place instead of drifting. */
export function labeledLine(text: string, label: string): string | null {
  const match = text.match(new RegExp(`^\\s*${label}:\\s*(.+)\\s*$`, "m"));
  return match?.[1] ? match[1].trim() : null;
}

/** Extract the one-line reason from a TUMWATER_REFUSED sentinel line; null when no such line
 * exists. Anchored at line start like the VERDICT line, so prose that merely mentions the
 * sentinel mid-sentence cannot set the reason. THE ONLY source of a refusal (BUGS.md
 * 2026-09-23): a bare sentinel and a mid-sentence mention are not refusals, and a reason
 * that negates the refusal is not one either (isNegatedRefusal) — four ticks ended ordinary
 * work-completed replies with `TUMWATER_REFUSED: none` and the harness destroyed their
 * tested work. */
export function extractRefusal(text: string): string | null {
  return labeledLine(text, REFUSED_SENTINEL);
}

/** True when a TUMWATER_REFUSED reason negates the refusal instead of carrying it. The
 * recognized shapes, in the order the pipeline strips them — every dress beyond the bare
 * tokens was observed in a real reply and recorded in BUGS.md on 2026-09-28:
 *
 * - the bare tokens, case-insensitive: empty, `none`, `n/a`;
 * - under markdown decoration or quote wrapping: `**none**`, `` `n/a` ``, `(**None**) —
 *   nothing refused`, `"none"`, `none "nothing to do"`. Straight and typographic quotes
 *   alike, each of ‘ ’ “ ” decorating either side of the token (a model's quote direction
 *   is not reliable, so both classes carry all four);
 * - the whole reason itself stating absence: `nothing to do`, `nothing to refuse`,
 *   `nothing refused`, `no refusal` — a loop that found no work reaches for these phrases
 *   exactly as it reaches for `none`, and they are not objections (BUGS.md 2026-09-28);
 * - with trailing sentence punctuation: `None.`, `N/A!`, `none…` — punctuation is formatting
 *   (the one-character ellipsis beside its ASCII dots);
 * - inside brackets, which become spaces rather than deletions, so `(no)ne` cannot
 *   collapse into `none`;
 * - with an appended explanation introduced by any character that cannot begin a reason
 *   word — the hyphen and en/em dashes, an opening parenthesis, a quote, or a sentence
 *   mark (`none - no entry refused`, `none (no entry refused this run)`, `None; nothing
 *   to refuse.`, `None. Nothing worth doing.`).
 *
 * A refusal is a deliberate, affirmative declaration; classifying a reply as one must not
 * depend on the model never naming the sentinel (BUGS.md 2026-09-23 — the prompt lists the
 * line beside the reply-contract fields, so a compliant model fills it in on every reply). */
export function isNegatedRefusal(reason: string | null | undefined): boolean {
  const raw = (reason ?? "").trim().toLowerCase();
  // Quotes join the wrapping strip beside the brackets: like brackets and markdown runs they
  // are decoration around the token, never part of the reason (BUGS.md 2026-09-28). All four
  // typographic quotes sit in BOTH classes — a model's quote direction is not reliable (the
  // probe `”none ”nothing to do”` opens with a closing quote), and a class missing one
  // direction leaves that dress a genuine refusal (BUGS.md 2026-09-28).
  const unwrapped = raw.replace(/^[(\[{'"‘’“”]+\s*|\s*[)\]}'"‘’“”]+$/g, "").trim();
  // The normalizations compose in one pipeline — markdown decoration, then trailing sentence
  // marks, then brackets — each seeing the output of the last, because the wrappings nest
  // (`(**None**) — nothing refused` is decoration inside brackets around the dash-appended
  // shape). Decoration and marks are stripped as formatting on the token; a bracket run becomes
  // a space rather than a deletion, so `(no)ne` cannot collapse into `none`, and the space the
  // dash-append regex already tolerates keeps `none) — …` from wedging a stray bracket against
  // the token. A real objection still carries words beyond the token under every stripping.
  const unbold = (s: string) => s.replace(/[*_~`'"‘’“”]+/g, " ").trim();
  // The one-character ellipsis joins the sentence marks: `none…` ends the reason the way
  // `none.` does (BUGS.md 2026-09-29), and the ASCII `...` already stripped via its dots.
  const bare = (s: string) => s.replace(/[.!,;:?!…]+$/, "").trim();
  const unbracket = (s: string) => s.replace(/[([{)\]}]+/g, " ").trim();
  const normalized = unbracket(bare(unbold(raw)));
  for (const candidate of [raw, unwrapped, normalized]) {
    if (candidate === "" || candidate === "none" || candidate === "n/a") return true;
    // The appended-explanation family: after the token, any character that cannot begin a
    // reason word — the ASCII hyphen and en/em dashes, an opening parenthesis, a quote
    // (straight or typographic, either direction), or sentence punctuation (`;`, `:`, `,`,
    // `.`, `!`, `?`, `…`) — starts a note that rides the token rather than continuing it (`none -
    // no entry refused`, `none (no entry refused this run)`, `None; nothing to refuse.`,
    // `None. Nothing worth doing.`, `none "nothing to do"`, `none “nothing to do”`). The
    // hyphen stays in the class beside the en/em dashes: `none - …` is the same
    // appended-note dress as `none — …` and dropping it would regress `n/a - …` replies to
    // genuine refusals. The alternation also carries the whole-reason absence statements a
    // loop writes instead of `none` (`nothing to do`, `nothing to refuse`, `nothing refused`,
    // `no refusal` — same negating intent, BUGS.md 2026-09-28). Anchored right after the
    // token, so a reason that continues with a word (`none of the attempted fixes work`,
    // `nothing to do with the review`, `no refusal of my own`) stays a refusal: punctuation
    // is formatting, a letter is the reason itself. Accepted tradeoff, same as the dash dress
    // already carried: a real objection that opens a quoted clause right after the token
    // (`none "of these work"`) now negates.
    if (/^(none|n\/a|nothing to do|nothing to refuse|nothing refused|no refusal)\b([ \t]*[—–\-;:,.!?…('"‘’“”].*)?$/.test(candidate)) return true;
  }
  return false;
}

/** The result of one `qa` flow check: which flow, and how it went. */
export interface FlowResult {
  flow: string;
  result: "passed" | "bug";
}

/** Extract the `qa` tick's result-carrying `FLOW: <name> — <passed|bug>` line (plans/observer-
 * roles.md 2/2); null when absent. Built on `labeledLine`, so the label is anchored at line
 * start and a mid-sentence mention is ignored. The verdict is required: a bare `FLOW: <name>`
 * — or a reply truncated mid-verdict (`FLOW: gui-budget-cap — pa`) — is not a result, and
 * returning null leaves the rotation unadvanced rather than latching a pass the run never
 * declared (BUGS.md 2026-09-23). Splits on the final dash/em-dash token before the result so a
 * name that itself contains a hyphen (`reset-counters`) stays intact. */
export function extractFlow(text: string): FlowResult | null {
  const value = labeledLine(text, "FLOW");
  if (!value) return null;
  const match = value.match(/^(.*)\s*[—-]\s*(passed|bug)\s*$/i);
  if (!match?.[1]) return null;
  return { flow: match[1].trim(), result: match[2]!.toLowerCase() as "passed" | "bug" };
}

// The review gate's verdict line as stated in buildReviewPrompt (prompt.ts): the reviewer
// ends with exactly `VERDICT: approve` or `VERDICT: reject`. Anchored at line start so prose
// that merely mentions "VERDICT:" mid-sentence cannot set the outcome, but leading horizontal
// whitespace is tolerated exactly like labeledLine (the REFUSED/SUMMARY/WHY/RISK/VERIFIED/FLOW
// family): a reviewer who nests or indents the final line must not fail the whole review as
// "no parseable verdict" while an identically indented refusal would still count. One source
// of truth, two derived regexes — stateless detection for pi.ts's per-message scan, and a
// global one for verdictLines's extraction, which review-verdict.ts's parseVerdict consumes
// (matchAll clones it internally, so sharing is safe).
const VERDICT_LINE_SOURCE = "^[ \\t]*VERDICT:\\s*(approve|reject)\\b";
const VERDICT_LINE = new RegExp(VERDICT_LINE_SOURCE, "m");
const VERDICT_LINES = new RegExp(VERDICT_LINE_SOURCE, "gm");

/** True when `text` carries a parseable verdict line (pi.ts's stream parser records the
 * last assistant message carrying one as the run's verdictText). Line-anchored with leading
 * horizontal whitespace allowed, like every other labeled field in the reply contract. */
export function hasVerdictLine(text: string): boolean {
  return VERDICT_LINE.test(text);
}

/** One verdict line found in `text`: where it sits and which way it went. */
export interface VerdictMatch {
  /** Index of the line's start in `text`. */
  index: number;
  /** Index just past the line's end — the reviewer's reasons follow here. */
  end: number;
  verdict: "approve" | "reject";
}

/** Every verdict line in `text`, in order (the prompt asks for exactly one, and the last
 * wins — review-verdict.ts's parseVerdict takes the final match and reads its reasons from after it). */
export function verdictLines(text: string): VerdictMatch[] {
  const out: VerdictMatch[] = [];
  for (const m of text.matchAll(VERDICT_LINES)) {
    if (!m[1]) continue; // Unreachable: the group is required by the pattern.
    const index = m.index ?? 0;
    out.push({ index, end: index + m[0].length, verdict: m[1] as "approve" | "reject" });
  }
  return out;
}
