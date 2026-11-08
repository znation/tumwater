/** The machine-readable contract the four repo-wide policy scans use to name each offender, and
 * the parse that turns a check's complete output back into per-test offender lists. Part 1/2 of
 * the policy-offender attribution work (BUGS.md 2026-11-08): before this, a scan reported one
 * aggregate failing test (parseFailingTests kept only its title), so a later attribution could not
 * tell a change's new offender from the base's or main's old one. Each scan prints one
 * POLICY_OFFENDER_PREFIX line per offender (policyOffenderLine, tab-delimited so a title or
 * offender that contains a tab is still parseable) before its own assertion fails, so the check's
 * complete output carries both the machine list and the assertion diff; runBuildCheck
 * (build-check.ts) folds it into BuildCheckOutcome.failingOffenders. THIS part only captures; no
 * reader outside the plumbing consumes the map yet — part 2/2 (the stale-base excuse in
 * review-precheck.ts) reads it. */

/** The prefix of a machine-readable policy-offender line. */
export const POLICY_OFFENDER_PREFIX = "tumwater-policy-offender";

/** The one machine-readable line a policy scan prints per offender: the prefix, that scan's exact
 * failing test title, and the offender string, tab-delimited so the parse cannot conflate a title
 * that contains spaces with the offender (offenders contain no tab). */
export function policyOffenderLine(testTitle: string, offender: string): string {
  return `${POLICY_OFFENDER_PREFIX}\t${testTitle}\t${offender}`;
}

/** Parse a check's complete output into the offender lists its policy scans reported: title-keyed,
 * in output order, deduplicated (a repeated offender for one title is listed once); lines without
 * the prefix are ignored, as are prefixed lines missing a tab or an offender. */
export function parsePolicyOffenders(output: string): Record<string, string[]> {
  const byTitle = new Map<string, string[]>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(POLICY_OFFENDER_PREFIX)) continue;
    const rest = line.slice(POLICY_OFFENDER_PREFIX.length);
    if (!rest.startsWith("\t")) continue;
    const [title, ...offenderParts] = rest.slice(1).split("\t");
    if (title === undefined || offenderParts.length === 0) continue;
    const offender = offenderParts.join("\t");
    const list = byTitle.get(title) ?? [];
    if (!list.includes(offender)) {
      byTitle.set(title, [...list, offender]);
    }
  }
  return Object.fromEntries(byTitle);
}
