/** Post-merge machinery that can fail quietly while merges go on — surfaced as warnings so an
 * operator or the selfcheck role sees them (plans/fast-merge.md "Guardrails"). Pure and
 * synchronous over the event log and quarantine.json, so every surface (doctor's rows and the
 * selfcheck digest) words them the same. Read-only: it never writes an event, state or file.
 *
 * G1 lives on the `main_check` / `main_red_hold` event trail (src/baseline/main-watch.ts,
 * src/baseline/main-red.ts), and names the merge the watch blamed (`main_culprit`, logged by
 * src/baseline/main-watch.ts) in the same clause the dashboard alert uses. Only `main_check`
 * events that actually ran the check
 * (`durationMs` > 0; a cached or inherited verdict is ignored) and `main_red_hold` events
 * count, and a `main_check` that passed (a red naming only quarantined tests is recorded
 * passed) ends a red. G3 reads the quarantine list (src/review/known-flakes.ts) directly.
 * Both take an injected `now` so tests never read the clock. */

import { readEventsSince } from "../events/event-window.js";
import { loadQuarantine } from "../review/known-flakes.js";
import { DAY_MS, HOUR_MS, clockHm, humanAgo } from "../text/datetime.js";
import { shortSha } from "../text/format.js";
import { roleLabel } from "../roles/role-labels.js";
import { plural } from "../text/phrases.js";
import { squash } from "../text/text.js";
import type { HarnessEvent } from "../events/events.js";

/** How long a red main must last before the doctor and the selfcheck digest warn (G1). */
export const RED_MAIN_WARN_MS = 30 * 60_000;

/** True when the event is a `main_check` whose verdict actually ran the full check (G1's
 * `relevant` rule): `durationMs` > 0, so a cached or inherited verdict (durationMs 0) is
 * ignored. Shared by the report's main-red walk (src/report/report-main-red.ts) and
 * `redMainWarning` below, so the two cannot disagree about whether a check ran. */
function ranFullMainCheck(ev: HarnessEvent): boolean {
  return ev.type === "main_check" && typeof ev.durationMs === "number" && ev.durationMs > 0;
}

/** True when `ev` opens or extends a red spell on main (G1's rule): a `main_red_hold`, or a
 * `main_check` that ran the full check and failed. The report's per-day main-red walk
 * (src/report/report-main-red.ts) gates its spell opener on this, so it and G1 share the one
 * rule for when main is red. */
export function isRedMain(ev: HarnessEvent): boolean {
  return ev.type === "main_red_hold" || (ranFullMainCheck(ev) && ev.status === "failed");
}

/** True when `ev` is a `main_check` that ran the full check and passed — the event that ends a
 * red spell (G1's rule: a red naming only quarantined tests is recorded passed). Shared with
 * the report's main-red walk (src/report/report-main-red.ts), so a pass closes a spell the
 * same way G1 ends its red. */
export function isPassingMainCheck(ev: HarnessEvent): boolean {
  return ranFullMainCheck(ev) && ev.status === "passed";
}

/** A quarantined test's `firstSeen` age past which the doctor and digest warn it is being
 * hidden (G3). */
export const QUARANTINE_AGE_MS = 3 * DAY_MS;

/** A quarantine list longer than this many tests warns on size (G3). */
export const QUARANTINE_WARN_COUNT = 10;

/** How many of the oldest quarantined tests a warning names before folding the rest into a
 * remainder count. */
const QUARANTINE_DETAIL_MAX = 3;

/** The trailing-window scan's result: `relevant` holds the in-window events that open, extend
 * or end a red (the isRedMain / isPassingMainCheck set, in `events` order), and `culprit` is
 * the newest in-window `main_culprit` carrying a non-empty string `commit`. */
interface RedWindow {
  relevant: HarnessEvent[];
  culprit: HarnessEvent | undefined;
}

/** True when `e` is the newest `main_culprit` seen so far: no contender yet, or a later `ts`.
 * The newest-in-window pick that `scanRedWindow` folds into its loop. */
function isNewerCulprit(c: HarnessEvent | undefined, e: HarnessEvent): boolean {
  return c === undefined || e.ts > c.ts;
}

/** Scans the trailing 24 h of `events` (cutoff `now - DAY_MS`), collecting the events that open,
 * extend or end a red and picking the newest in-window `main_culprit` with a non-empty string
 * `commit`. Owns the window scan and the newest-culprit pick. */
function scanRedWindow(events: readonly HarnessEvent[], cutoff: number): RedWindow {
  const relevant: HarnessEvent[] = [];
  let culprit: HarnessEvent | undefined;
  for (const e of events) {
    if (typeof e.ts !== "number" || e.ts < cutoff) continue;
    if (e.type === "main_culprit") {
      if (typeof e.commit === "string" && e.commit.length > 0 && isNewerCulprit(culprit, e)) {
        culprit = e;
      }
      continue;
    }
    if (isRedMain(e) || isPassingMainCheck(e)) relevant.push(e);
  }
  return { relevant, culprit };
}

/** The red spell `redSpell` derives: the event the duration is counted from (`startEv`), the
 * newest red (`newest`), the duration in ms, and whether the spell is unbroken by a pass. Each
 * field is named as the local it replaces. */
interface RedSpell {
  startEv: HarnessEvent;
  newest: HarnessEvent;
  durationMs: number;
  unbroken: boolean;
}

/** Derives the red spell over `window`'s `relevant` events: the start event and duration from
 * `now`, whether the spell is unbroken, and the 30-minute threshold (null when main is green,
 * or red for RED_MAIN_WARN_MS or less). Owns the red-spell derivation and the 30-minute bail. */
function redSpell(window: RedWindow, now: number): RedSpell | null {
  const relevant = window.relevant;
  if (relevant.length === 0) return null;
  let newest = relevant[0]!;
  for (const e of relevant) if (e.ts > newest.ts) newest = e;
  if (!isRedMain(newest)) return null;
  const passes = relevant.filter(isPassingMainCheck);
  const red = isRedMain;
  const lastPass = passes.length > 0 ? passes[passes.length - 1] : undefined;
  const reds = relevant.filter(red);
  // No pass bounds the red spell, so the first red in the window opens it: a window with reds
  // and no pass has been red for the whole window's coverage, so it reads "more than 24 h" (G1)
  // no matter where the reds sit, not only when one happens to fall on the window's edge. A
  // single fresh red (the only span recorded, e.g. a hold 47 min ago) reads its own age.
  const firstRed = relevant.find((e) => red(e) && (lastPass === undefined || e.ts >= lastPass.ts));
  // The red is "since" the event the duration is counted from, which for a red spell with more
  // than one red is not the newest red: the design names the first red after the newest pass.
  const startEv = firstRed ?? newest;
  const durationMs = now - startEv.ts;
  if (durationMs <= RED_MAIN_WARN_MS) return null;
  const unbroken = lastPass === undefined && reds.length > 1;
  return { startEv, newest, durationMs, unbroken };
}

/** "more than 24 h" for an unbroken or full-window red, else the short duration phrase. Owns
 * the duration wording. */
function redSpellDuration(spell: RedSpell): string {
  return spell.unbroken || spell.durationMs >= DAY_MS ? "more than 24 h" : redDurationPhrase(spell.durationMs);
}

/** The newest red's first failing test, when one is named. Owns the first-failing-test read. */
function redFailingTest(newest: HarnessEvent): string | undefined {
  return Array.isArray(newest.failingTests) && typeof newest.failingTests[0] === "string" ? newest.failingTests[0] : undefined;
}

/** The blame clause naming the merge the main watch blamed, when the newest `culprit` in the
 * window blames the same sha the phrase names. Owns the blame clause. */
function redBlameClause(culprit: HarnessEvent | undefined, newest: HarnessEvent): string {
  // The blame names the merge the main watch blamed for the red — the same `main_culprit`
  // commit-equals-tip rule the dashboard alert uses (status-polls only publishes a blame whose
  // commit is the derived tip sha), so a red the watch did not blame never borrows another
  // head's culprit. A culprit naming another commit, or none, leaves the phrase as today.
  const shouldBlame = culprit !== undefined && culprit.commit === newest.sha;
  return shouldBlame
    ? typeof culprit.runner === "string" && culprit.runner.length > 0
      ? `; the main watch blames ${roleLabel(culprit.runner)}'s merge ${shortSha(culprit.commit)}`
      : `; the main watch blames merge ${shortSha(culprit.commit)}`
    : "";
}

/** G1 over `events`: warns when main has been red for more than RED_MAIN_WARN_MS, over the
 * trailing 24 h of `events` from `now`. Only `main_check` events with `durationMs` > 0 and
 * `main_red_hold` events count; a `main_check` with `durationMs` 0 (cached or inherited) is
 * ignored; a pass (including one naming only quarantined tests, recorded passed) ends the red.
 * The phrase names how long main has had no passing full check, the sha it has been red since,
 * its clock time, the newest red's first failing test when one is named, and — when the newest
 * `main_culprit` in the window blames the same sha the phrase names — the merge the main watch
 * blamed (`; the main watch blames <role>'s merge <sha>`, or `; the main watch blames merge
 * <sha>` when no runner is named), the one rule the dashboard alert and this phrase share.
 * Returns null when main is green, or red for RED_MAIN_WARN_MS or less. The per-job work is
 * split into the module-private helpers `scanRedWindow`, `redSpell`, `redSpellDuration`,
 * `redFailingTest` and `redBlameClause`, one per job, so each is found by name. */
export function redMainWarning(events: readonly HarnessEvent[], now: number): string | null {
  const window = scanRedWindow(events, now - DAY_MS);
  const spell = redSpell(window, now);
  if (spell === null) return null;
  const duration = redSpellDuration(spell);
  const head = `main has had no passing full check for ${duration}: red since ${shortSha(spell.startEv.sha)} at ${clockHm(spell.startEv.ts)}`;
  const failing = redFailingTest(spell.newest);
  const blame = redBlameClause(window.culprit, spell.newest);
  return failing ? `${head} — ${squash(failing, 120)}${blame}` : `${head}${blame}`;
}

/** G3 over `entries` (the loadQuarantine list): warns when the list holds more than
 * QUARANTINE_WARN_COUNT tests, or when any test's `firstSeen` is more than QUARANTINE_AGE_MS
 * ago — an old entry is a failure the team has stopped seeing, and an unfiled one (`bug` empty)
 * never leaves quarantine. The detail names the oldest tests with their age and BUGS.md heading
 * (or "not filed"). Returns null when neither fires. */
export function quarantineWarning(entries: readonly { test: string; firstSeen: number; bug?: string }[], now: number): string | null {
  const phrases: string[] = [];
  if (entries.length > QUARANTINE_WARN_COUNT) {
    phrases.push(`quarantine holds ${entries.length} tests — over the ${QUARANTINE_WARN_COUNT}-test ceiling`);
  }
  const old = entries
    .filter((e) => e.firstSeen < now - QUARANTINE_AGE_MS)
    .sort((a, b) => a.firstSeen - b.firstSeen);
  if (old.length > 0) {
    const named = old.slice(0, QUARANTINE_DETAIL_MAX).map((e) => {
      const filed = e.bug ? squash(e.bug, 40) : "not filed";
      return `"${squash(e.test, 40)}" (${filed}, ${humanAgo(e.firstSeen, now)})`;
    });
    const more = old.length > QUARANTINE_DETAIL_MAX ? ` (and ${old.length - QUARANTINE_DETAIL_MAX} more)` : "";
    phrases.push(`quarantine holds ${plural(old.length, "test")} over 3 days: ${named.join(", ")}${more}`);
  }
  return phrases.length > 0 ? phrases.join("; ") : null;
}

/** Both guardrail phrases that fire for `root`, reading the trailing 24 h of the event log and
 * quarantine.json, oldest-test text bounded as the doctor rows are. */
export function guardrailWarnings(root: string, now: number = Date.now()): string[] {
  const warnings: string[] = [];
  const events = readEventsSince(root, DAY_MS).events;
  const red = redMainWarning(events, now);
  if (red !== null) warnings.push(red);
  const q = loadQuarantine(root);
  const qw = quarantineWarning(q, now);
  if (qw !== null) warnings.push(qw);
  return warnings;
}

/** "40 min", "3 h" — the duration a red main's warning names. */
function redDurationPhrase(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 24 * 60) return `${minutes} min`;
  return `${Math.round(ms / HOUR_MS)} h`;
}
