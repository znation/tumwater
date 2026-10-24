/** Post-merge machinery that can fail quietly while merges go on — surfaced as warnings so an
 * operator or the selfcheck role sees them (plans/fast-merge.md "Guardrails"). Pure and
 * synchronous over the event log and quarantine.json, so every surface (doctor's rows and the
 * selfcheck digest) words them the same. Read-only: it never writes an event, state or file.
 *
 * G1 lives on the `main_check` / `main_red_hold` event trail (src/baseline/main-watch.ts,
 * src/baseline/main-red.ts): only `main_check` events that actually ran the check
 * (`durationMs` > 0; a cached or inherited verdict is ignored) and `main_red_hold` events
 * count, and a `main_check` that passed (a red naming only quarantined tests is recorded
 * passed) ends a red. G3 reads the quarantine list (src/review/known-flakes.ts) directly.
 * Both take an injected `now` so tests never read the clock. */

import { readEventsSince } from "../events/event-window.js";
import { loadQuarantine } from "../review/known-flakes.js";
import { DAY_MS, clockHm, humanAgo } from "../text/datetime.js";
import { shortSha } from "../text/format.js";
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

/** G1 over `events`: warns when main has been red for more than RED_MAIN_WARN_MS, over the
 * trailing 24 h of `events` from `now`. Only `main_check` events with `durationMs` > 0 and
 * `main_red_hold` events count; a `main_check` with `durationMs` 0 (cached or inherited) is
 * ignored; a pass (including one naming only quarantined tests, recorded passed) ends the red.
 * The phrase names how long main has had no passing full check, the sha it has been red since,
 * its clock time, and the newest red's first failing test when one is named. Returns null when
 * main is green, or red for RED_MAIN_WARN_MS or less. */
export function redMainWarning(events: readonly HarnessEvent[], now: number): string | null {
  const cutoff = now - DAY_MS;
  const relevant: HarnessEvent[] = [];
  for (const e of events) {
    if (typeof e.ts !== "number" || e.ts < cutoff) continue;
    if (isRedMain(e) || isPassingMainCheck(e)) relevant.push(e);
  }
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
  const duration = unbroken || durationMs >= DAY_MS ? "more than 24 h" : redDurationPhrase(durationMs);
  const failing =
    Array.isArray(newest.failingTests) && typeof newest.failingTests[0] === "string" ? newest.failingTests[0] : undefined;
  const head = `main has had no passing full check for ${duration}: red since ${shortSha(startEv.sha)} at ${clockHm(startEv.ts)}`;
  return failing ? `${head} — ${squash(failing, 120)}` : head;
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
    phrases.push(`quarantine holds ${old.length} test${old.length === 1 ? "" : "s"} over 3 days: ${named.join(", ")}${more}`);
  }
  return phrases.length > 0 ? phrases.join("; ") : null;
}

/** How many `main_revert` events in the trailing 24 h the doctor and digest warn once the
 * daily ceiling is passed (G2's rate test): a burst of reverts reads like a flaky-revert
 * habit, distinct from a single false revert. */
export const REVERT_RATE_LIMIT = 5;

/** Whether a `main_revert` counts as red-main for the daily ceiling. A revert rejected by a
 * post-merge review is an intended revision cycle, not a red-main revert. Events written after
 * the reason split carry `reason` (post-review vs main-red, main-revert.ts). Older events
 * predate the split and carry none; classify those from what they already carry instead of
 * assuming they are red-main (revertReasonOf's absent-reason default is a display fallback): a
 * non-empty `failingTests` means the main watch's check was red, a matching `afterMerge: true`
 * `review_rejected` naming the reverted commit means a post-merge rejection, and an event with
 * neither is an unknown cause and is never counted as red-main — a deploy lag cannot turn an
 * intended rejection cycle into a daily-revert alarm. */
function isRedMainRevert(r: HarnessEvent, events: readonly HarnessEvent[]): boolean {
  if (r.reason === "post-review") return false;
  if (typeof r.reason === "string") return true; // an explicit main-red (or other) reason
  // reason-less: classify from the log (see the doc comment above).
  if (Array.isArray(r.failingTests) && r.failingTests.length > 0) return true;
  const commit = typeof r.commit === "string" ? r.commit : undefined;
  if (commit !== undefined) {
    if (
      events.some(
        (e) => e.type === "review_rejected" && e.afterMerge === true && e.head === commit,
      )
    )
      return false; // a post-merge rejection; not red-main
  }
  return false; // unknown cause; excluded from the red-main count
}

/** One `main_revert` in the last 24 h looks false when either G2 test holds — its failure did
 * not reproduce (a test it names has been quarantined at or since the revert, or a later
 * `main_check`'s `quarantined` list names it), or its change came back unchanged and main
 * stayed green (a later `merged` event carries the culprit's patch-id, and the first
 * `main_check` after that merge which actually ran the check passed). */
function revertLooksFalse(
  r: HarnessEvent,
  events: readonly HarnessEvent[],
  quarantine: readonly { test: string; lastSeen: number }[],
): "quarantined" | "remerged" | null {
  const rts = typeof r.ts === "number" ? r.ts : 0;
  const tests = Array.isArray(r.failingTests)
    ? r.failingTests.filter((t): t is string => typeof t === "string")
    : [];
  const firstTest = tests[0];
  // Did not reproduce: the named test is quarantined at or since the revert, or a later
  // main_check's `quarantined` list names it (src/baseline/main-watch.ts records a red naming
  // only quarantined flaky tests as passed there).
  if (
    firstTest !== undefined &&
    (quarantine.some((q) => q.test === firstTest && q.lastSeen >= rts) ||
      events.some(
        (e) =>
          e.type === "main_check" &&
          typeof e.ts === "number" &&
          e.ts >= rts &&
          Array.isArray(e.quarantined) &&
          e.quarantined.includes(firstTest),
      ))
  )
    return "quarantined";
  // Came back unchanged and main stayed green: a later `merged` carries this revert's
  // patch-id, and the first `main_check` after that merge which ran the check passed.
  const patch = typeof r.patchId === "string" ? r.patchId : undefined;
  if (patch === undefined) return null;
  const remerged = events.find(
    (e) => e.type === "merged" && e.patchId === patch && typeof e.ts === "number" && e.ts >= rts,
  );
  if (remerged === undefined) return null;
  const rmTs = typeof remerged.ts === "number" ? remerged.ts : 0;
  const after = events
    .filter(
      (e) =>
        e.type === "main_check" &&
        typeof e.ts === "number" &&
        e.ts >= rmTs &&
        typeof e.durationMs === "number" &&
        e.durationMs > 0,
    )
    .sort((a, b) => a.ts - b.ts)[0];
  return after?.status === "passed" ? "remerged" : null;
}

/** The trailing-day revert facts behind G2's warning: how many `main_revert` events landed in
 * the trailing 24 h and the `revertWarnings` phrases that fired (the doctor's own wording).
 * Returned by revertGuardrail for the doctor, the selfcheck digest and the always-on `reverts`
 * alert, so every surface words the revert the same. null when nothing fired. */
export interface RevertGuardrail {
  count: number;
  phrases: string[];
}

/** G2 over `events` and the quarantine list: warns on a `main_revert` in the trailing 24 h that
 * looks false, and on more than REVERT_RATE_LIMIT reverts a day. The phrases name each
 * false-looking revert (culprit sha and which test failed / that it landed again unchanged)
 * and the count when over the rate limit. Returns null when nothing fires (no reverts, or only
 * ordinary reverts under the limit); otherwise the trailing-day revert count and the phrases
 * that fired, so a burst and a lone false revert can be told apart. revertWarnings is its
 * string-only view, so the two cannot drift. */
export function revertGuardrail(
  events: readonly HarnessEvent[],
  quarantine: readonly { test: string; lastSeen: number }[],
  now: number,
): RevertGuardrail | null {
  const cutoff = now - DAY_MS;
  const reverts = events.filter(
    (e) => e.type === "main_revert" && typeof e.ts === "number" && e.ts >= cutoff,
  );
  const redReverts = reverts.filter((r) => isRedMainRevert(r, events));
  if (redReverts.length === 0) return null;
  const phrases: string[] = [];
  if (redReverts.length > REVERT_RATE_LIMIT) {
    phrases.push(`${redReverts.length} reverts in the last 24 h — over the ${REVERT_RATE_LIMIT}-revert ceiling`);
  }
  for (const r of redReverts) {
    const culprit =
      typeof r.commit === "string" ? r.commit : typeof r.sha === "string" ? r.sha : "";
    const reason = revertLooksFalse(r, events, quarantine);
    if (reason === "quarantined") {
      const tests = Array.isArray(r.failingTests)
        ? r.failingTests.filter((t): t is string => typeof t === "string")
        : [];
      phrases.push(
        `revert ${shortSha(culprit)} blamed ${squash(tests[0] ?? "", 60)}, which has been quarantined since — the failure did not reproduce`,
      );
    } else if (reason === "remerged") {
      phrases.push(
        `revert ${shortSha(culprit)}'s change merged again unchanged and main stayed green — the revert looks false`,
      );
    }
  }
  return phrases.length > 0 ? { count: redReverts.length, phrases } : null;
}

/** G2 over `events` and the quarantine list, as the doctor and selfcheck digest read it: the
 * phrases revertGuardrail fires (empty when none do), byte-identical to revertGuardrail's own
 * strings so the doctor and the always-on `reverts` alert cannot drift on wording. */
export function revertWarnings(
  events: readonly HarnessEvent[],
  quarantine: readonly { test: string; lastSeen: number }[],
  now: number,
): string[] {
  return revertGuardrail(events, quarantine, now)?.phrases ?? [];
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
  warnings.push(...revertWarnings(events, q, now));
  return warnings;
}

/** The trailing-day revert guardrail over `root`'s event log and quarantine.json — the poll-path
 * read (one trailing-day event read plus the quarantine file) that feeds the always-on `reverts`
 * alert, the same material guardrailWarnings reads, over the same revertGuardrail rule. */
export function revertsFor(root: string, now: number = Date.now()): RevertGuardrail | null {
  return revertGuardrail(readEventsSince(root, DAY_MS).events, loadQuarantine(root), now);
}

/** "40 min", "3 h" — the duration a red main's warning names. */
function redDurationPhrase(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 24 * 60) return `${minutes} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}
