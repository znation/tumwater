/** The author's own declaration that its change is incomplete or leaves the suite red, read from
 * the RISK and VERIFIED lines it wrote (BUGS.md 2026-11-20). A change whose commit message says
 * "NOT complete" or "leaves the suite red" merged once with a red main, because nothing read those
 * lines before queuing. The self-check reads them, so the one fix-up turn is asked to make the
 * tests pass or revert the change. */

/** The declaring forms, matched case-insensitively: "not complete", "incomplete", "not
 * suite-green", "leaves the suite red", and "the suite is red" / "the suite stays red". */
const DECLARING_FORM =
  /\bnot complete\b|\bincomplete\b|\bnot suite-green\b|\bleaves the suite red\b|\bthe suite (?:is|stays) red\b/i;

/** A line that blames main's known-red tests rather than the change. Such a line is not the
 * author's declaration, so it never fires the detector. */
const BLAMES_MAIN = /\bmain already fails\b|\bknown red\b/i;

/** The declaring phrase, as the author wrote it, from one RISK or VERIFIED line; null when the
 * line declares no incomplete change and no red suite, or blames main's known-red tests. */
function declaringPhrase(line: string | undefined): string | null {
  if (line === undefined || BLAMES_MAIN.test(line)) return null;
  const match = DECLARING_FORM.exec(line);
  return match === null ? null : match[0];
}

/** The first declaring phrase across a change's RISK and VERIFIED lines, RISK first; null when
 * neither line declares the change incomplete or the suite red. */
export function declaredRedPhrase(lines: { risk?: string; verified?: string }): string | null {
  return declaringPhrase(lines.risk) ?? declaringPhrase(lines.verified);
}
