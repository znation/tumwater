/**
 * The in-memory state of each root's open red spell (Hourly full check, part 3b/4) and the
 * root-keyed "known failures" maps that read from it — the spell state that
 * src/baseline/main-watch.ts mutates as its passes settle verdicts.
 *
 * A red spell is the commit that OPENED a red — the tip of the first red verdict since the last
 * green — plus the failing tests STILL open on the newest red tip. The open set starts from the
 * confirmed red's tests and narrows as a later head's re-run shows tests passing, so a healed
 * test leaves the set (and `knownMainFailures`) before the whole set clears. The opener stays the
 * named culprit while the spell is open: a later tip re-checks only the open set and never
 * re-attributes. A green verdict clears the whole entry, so a red that opens after a green names
 * its own opener. In-memory only: a restart mid-red loses the spell's opener, and the next
 * settled red tip then names itself as culprit — the pre-fix behaviour, and a bounded one (one
 * tip per restart, since a spell's later tips inherit the red and settle without a re-run).
 *
 * The maps are module-private; the watch (and its public `knownMainFailures` /
 * `onlyKnownMainFailures` reads) reach this state only through the named seams below, so the
 * state has one home and one way in and out.
 */

/** Each root's open red spell: the commit that OPENED the red, the failing tests STILL open on
 * the newest red tip, and (red only) the file each open test lives in plus the policy-scan
 * offender lists it carried, narrowed as the tests narrow. */
export interface OpenRedSpell {
  opener: string;
  tests: string[];
  /** The file each open test lives in, from the latest red baseline that named it — what a
   * re-run of only those tests selects files by (build-check-rerun.ts). Red only; absent when
   * the output named no file or a previous re-run dropped it. */
  files?: Readonly<Record<string, string>>;
  /** The policy-scan offender lists the red carried (MainBaseline.failingOffenders), narrowed as
   * the spell's tests narrow. Red only; plumbing, no reader — the stale-base excuse closed
   * via the scans' offender-named subtests (BUGS-FIXED.md 2026-11-08), not this map. */
  offenders?: Readonly<Record<string, string[]>>;
}

/** The open red spell of each root, keyed by root; absent when none is open. */
const redSpellOpeners = new Map<string, OpenRedSpell>();

/** The failing tests of each root's newest watch verdict, keyed by root. */
const knownFailures = new Map<string, string[]>();

/** The policy-scan offender lists of each root's newest watch verdict, keyed by root then by
 * failing test title (MainBaseline.failingOffenders, policy-offenders.ts). It keeps a restored
 * or inherited red intact (and the open red spell above narrows it with the tests); nothing
 * outside this plumbing reads it — the stale-base series closed through the scans'
 * offender-named subtests, not this map (BUGS-FIXED.md 2026-11-08). */
const knownOffenders = new Map<string, Record<string, string[]>>();

/** Drop an offender map's entries whose test title is no longer open, so a red that narrows to
 * still-failing tests keeps offenders only for them (undefined in → undefined out). */
function narrowOffenders(
  offenders: Readonly<Record<string, string[]>> | undefined,
  stillOpen: readonly string[],
): Record<string, string[]> | undefined {
  if (offenders === undefined) return undefined;
  const keep = new Set(stillOpen);
  const out: Record<string, string[]> = {};
  for (const [title, list] of Object.entries(offenders)) {
    if (keep.has(title)) out[title] = [...list];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Write `root`'s spell (a fresh red, or a re-settled one keeping its opener). Absent `files` /
 * `offenders` are left off the entry, so a re-settle that names no file or offender does not
 * resurrect a field a later red dropped. */
export function setSpell(
  root: string,
  opener: string,
  tests: string[],
  files?: Readonly<Record<string, string>>,
  offenders?: Readonly<Record<string, string[]>>,
): void {
  redSpellOpeners.set(root, {
    opener,
    tests,
    ...(files !== undefined ? { files } : {}),
    ...(offenders !== undefined ? { offenders } : {}),
  });
}

/** Narrow `root`'s open spell to the still-failing tests, keeping its opener, its files, and the
 * offenders narrowed to those tests — and rewrite both known-failure maps to the narrowed set. */
export function narrowStillFailing(root: string, spell: OpenRedSpell, stillFailing: string[]): void {
  const narrowed = narrowOffenders(spell.offenders, stillFailing);
  redSpellOpeners.set(root, {
    opener: spell.opener,
    tests: stillFailing,
    ...(spell.files !== undefined ? { files: spell.files } : {}),
    ...(narrowed !== undefined ? { offenders: narrowed } : {}),
  });
  knownFailures.set(root, stillFailing);
  knownOffenders.set(root, narrowed ?? {});
}

/** Delete `root`'s open spell (a green closes it; the next red names its own opener). Does not
 * touch the known-failure maps — a cleared-red confirm that settles red again re-sets them. */
export function clearSpell(root: string): void {
  redSpellOpeners.delete(root);
}

/** Clear `root`'s known-failure and known-offender maps (a settled non-red verdict, or a red
 * whose every test is quarantined). Does not touch the open spell. */
export function clearKnown(root: string): void {
  knownFailures.set(root, []);
  knownOffenders.set(root, {});
}

/** The open red spell of `root`, or undefined when none is open. */
export function spellFor(root: string): OpenRedSpell | undefined {
  return redSpellOpeners.get(root);
}

/** Whether a red spell is open for `root`. */
export function spellOpen(root: string): boolean {
  return redSpellOpeners.has(root);
}

/** The open failing tests of `root`'s red spell: empty when no spell is open (a green, or none
 * ever opened). A red's <main-known-red> note reads this so a test a later head showed passing
 * leaves the set while the spell is still open. */
export function spellOpenTests(root: string): string[] {
  return redSpellOpeners.get(root)?.tests ?? [];
}

/** The failing tests of `root`'s newest verdict (the knownFailures map): empty when the verdict
 * is green, red with no parsed test, or none has been recorded yet in this process. */
export function knownFailuresFor(root: string): string[] {
  return knownFailures.get(root) ?? [];
}

/** Record `root`'s newest verdict's failing tests in the knownFailures map. */
export function setKnownFailures(root: string, tests: string[]): void {
  knownFailures.set(root, tests);
}

/** Record `root`'s newest verdict's policy-scan offender lists in the knownOffenders map. */
export function setKnownOffenders(root: string, offenders: Record<string, string[]>): void {
  knownOffenders.set(root, offenders);
}
