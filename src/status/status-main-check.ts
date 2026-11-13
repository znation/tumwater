/** The main-check reader split out of status/status-polls.ts: this poll's view of main's newest
 * merge-scope build check — the `mainCheck` field's shape and its derivation. The derivation is a
 * stat-cached event-tail scan (mainCheckScanFor, with its grown-full memo in mainCheckGrewFull)
 * and the branch/sha fallbacks are read per call, so a checkout or a config edit is observed on
 * the next poll even while events.jsonl sits still. It keeps its own module-level cache state,
 * as the other per-poll readers in status-polls.ts do, so status-data.ts's snapshot() — which
 * keeps the StatusSnapshot contract and the assembly — carries none of its own. Pure data
 * collection, no presentation concern (the badge and the status payload render it). */

import { asTestCounts, type TestCounts } from "../build/build-check-counts.js";
import { isFullCheckScope } from "../build/build-check-events.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { isPassingMainCheck } from "../baseline/main-guardrails.js";
import { DEFAULT_EVENT_TAIL, readEvents } from "../events/event-read.js";
import type { HarnessEvent } from "../events/events.js";
import { currentBranchFromHeadFile, readBranchHead, targetBranch } from "../git/git.js";
import { eventsLogPath } from "../paths.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";

/** The mainCheck field's shape (StatusSnapshot's contract): a runner summary block as the
 * build_check event carries it (build/build-check-events.ts spreads the outcome's counts through).
 * TestCounts is parseTestCounts's exported type, single-homed in build/build-check-counts.ts beside
 * its parser. Structurally checked on read (asTestCounts in build/build-check-counts.ts): the event
 * log is loose-typed. */
export interface MainCheckStatus {
  sha?: string;
  status: "passed" | "failed" | "skipped";
  counts?: TestCounts;
  at: number;
  /** When the newest full verdict's check completed (Hourly full check part 4/4): the
   * build_check event's run-settle stamp (`settledAt` — main-watch stamps the baseline's
   * `checkedAt` at the run's end), falling back to the event's log time. What the surfaces
   * show as how long ago main was fully checked. Absent when the newest full-scope check
   * carried no verdict (a skipped one). */
  checkedAt?: number;
  /** The epoch-ms the next full check is due: checkedAt + `check.fullIntervalMinutes` (the
   * cadence part 2b/4 already measures from the newest full verdict's checkedAt), so a
   * surface can say "next in …" or, once the interval has passed, "due now". Absent when the
   * verdict is a red (the watch rechecks the next head rather than the interval), when the
   * operator set the interval to 0 (one full run per new head — nothing is due), or when
   * there is no checkedAt. */
    nextDueAt?: number;
  /** True when the covered head is no longer main's tip (a green taken on a head main has
   * since moved past): the badge keeps the verdict word and covered sha but flags the
   * staleness, so a stale green is not read as a statement about current main (BUGS.md
   * 2026-11-11). A red never carries it — the red is already flagged by color and the watch
   * rechecks it on the next head. */
  tipAdvanced?: true; /** Present when a red cleared (part 3b/4) and its one confirming full run has not settled
   * yet: no full verdict covers the clearing head, so the surfaces show "cleared at <sha> ·
   * full check running" instead of a verdict. `sha` is the cleared head, `at` when it
   * cleared, and `status` reads "passed" because the open failures passed there — surfaces
   * render the word "cleared", never "green". */
  cleared?: true;
  /** The red-main evidence the status payload carries (it rides the machine-readable
   * `status --json` output through status-payload.ts's wholesale spread of mainCheck):
   * present only when `status` is
   * "failed" and a main_culprit verdict names the red this poll derived a sha for — the tip
   * itself, or the open spell's opener the tip re-checked (a doc-exempt re-check; INV-AZ4) —
   * with a well-formed failingTests list. `failingTests` is the main watch's list for that
   * tip; `culprit` is the same verdict's commit (always a string) and, when the watch named
   * one, the runner. */
  red?: {
    failingTests: string[];
    culprit?: { commit: string; runner?: string };
  };
}

/** Is a value one of MainCheckStatus's three statuses? The one home of the membership test:
 * the event log is loose-typed by design, and a check whose status is not one of the three
 * (a hand-edited or future-format block) is malformed — dropped like any other malformed
 * check (see MainCheckScan.check's note) rather than narrowed with a cast into a status it
 * cannot prove, which would otherwise leak a mystery word to the header badge and the GUI
 * payload (mainCheckVerdict renders any unmatched status verbatim). */
function isMainCheckStatus(status: unknown): status is "passed" | "failed" | "skipped" {
  return status === "passed" || status === "failed" || status === "skipped";
}

/** How far mainCheckForPoll may grow its event tail. The per-poll default
 * (event-read.ts's DEFAULT_EVENT_TAIL) covers a healthy team — a merge-scope check rides
 * every merge and every redeploy — but a burst of quiet or failing runs logs hundreds
 * of events without moving main, and a tail
 * that ends before the last check makes the header badge vanish and reappear as agent runs go
 * by. Growing until the check is found keeps "absent" meaning what the field's contract says
 * (no merge-scope check has run) rather than "the window ended"; the cap keeps the worst
 * per-poll scan bounded — readTailText reads bytes proportional to the line count, and the scan
 * runs only when events.jsonl changes, so it stays below history's one-ask bound
 * (HISTORY_SCAN_MAX_EVENTS, 20k).
 * Past the cap the badge drops, the same graceful loss log rotation already imposes. */
const MAIN_CHECK_SCAN_MAX_EVENTS = 5_000;

/** Per-root note that the previous scan had to grow past the default event tail
 * (DEFAULT_EVENT_TAIL) without finding a merge-scope check. A check rides every merge, so a poll
 * that grew all the way to the cap is a burst of quiet or failing runs — hundreds of events
 * between merges — and the next poll's growth starts straight at the cap instead of re-scanning
 * the ×4 ladder's intermediate windows (200→800→3200→5000 ≈ 9.2k re-parsed events per
 * fresh tail, vs 5.2k for 200→cap; measured on a 6k-event check-free log, ~2.3 ms → ~1.2 ms per
 * append+poll). A poll that finds a check clears the note, so the ordinary find-in-200 /
 * find-in-800 path pays the same small windows as before. In-memory only: a wrong guess costs the
 * ladder it skipped, never a wrong verdict — every window's scan is complete for its size. */
const mainCheckGrewFull = new Set<string>();
const MAIN_CHECK_FULL_SET_MAX = 64;

/** The log-derived half of the mainCheck derivation: the newest merge-scope build_check and
 * the merged commits bracketing it — everything the field needs that depends only on the
 * event log. Split out so it can be cached per events.jsonl stat: the scan (the tail ladder,
 * its re-parses, and the merged collection) is a pure function of the log content, while the
 * sha's branch fallback (readBranchHead/currentBranchFromHeadFile) and the config's
 * baseBranch stay per call, so a checkout or a config edit is still observed on the next
 * poll. */
interface MainCheckScan {
  /** The newest merge-scope check in the tail, or undefined when none is within the cap (or
   * the newest one found is malformed). */
  check?: HarnessEvent;
  /** The newest merged commit before or at the check's ts — the fallback when nothing merged
   * after it. */
  mergeDoneBeforeCommit?: string;
  /** The newest merged commit after the check's ts — the sha a pre-merge check verified. */
  mergeDoneAfterCommit?: string;
  /** The newest merged commit at or before a baseline run's spawn — the head a baseline
   * check covers, even when a merge lands while the run is still in flight. */
  mergeDoneBeforeSpawnCommit?: string;
  /** The newest main_culprit event in the tail — the main watch's blame for the red it named
   * (src/baseline/main-watch.ts). Collected in the same single pass as the check. */
  culprit?: HarnessEvent;
  /** The oldest main_culprit since the newest passing full main_check in the tail — the opener
   * of the red spell still open at the tail's end, or undefined when the tail's end is green
   * (a passing check closed the spell) or no main_culprit is in the tail. The watch names the
   * spell's OPENER as culprit even after later tips re-check red, so the red detail is
   * published for that commit while its spell is open, not only when it is the newest tip. */
  spellOpener?: HarnessEvent;
  /** A red that cleared (part 3b/4) whose one confirming full run has not settled: the newest
   * main_check with `cleared: true` that is NEWER than the newest full build_check and has no
   * later settled main_check — the confirming run's verdict, or a newer full build_check, ends
   * the state. When it is present the surfaces show no verdict for the clearing head (none was
   * written) — just who cleared and that the full check is running. */
  cleared?: HarnessEvent;
}

/** Per-root scan cache (stat-cache.cachedByStat): both dashboards poll snapshot every second,
 * but events.jsonl is written only at run boundaries and merges, so an unchanged log serves
 * the whole scan from one stat instead of re-listing the ladder, re-parsing its windows, and
 * re-collecting the merged events. Rotation swaps the inode and every append changes the size,
 * so both invalidate through the same freshness check; keyed by root so distinct repos never
 * collide. Bounded inside cachedByStat. */
const mainCheckScanCache = new Map<string, StatKeyedValue<MainCheckScan>>();

/** The single pass over one window of the event tail: what that window contributes to the
 * main-check scan — the newest merge-scope build_check, every merged event, the newest
 * main_culprit blame, the open red spell's opener (the oldest main_culprit still open at the
 * window's end), and the newest cleared main_check. One pass collects all four facts the
 * derivation needs: the newest merge-scope check, every merged event, the newest
 * main_culprit blame, and the spell opener — the oldest main_culprit still open at the tail's
 * end (a passing full main_check after it closed its spell, so the next culprit in the tail is
 * a new spell's opener). The merges are re-read against the check's ts below — a pass over the
 * merges alone, not a second pass over every event in the window. A cleared red (part 3b/4)
 * whose one confirming full run has not settled: the surfaces read "full check running" from
 * the cleared event alone — no full verdict was written. A settled main_check after it (the
 * confirming run's verdict) closes the state, and so does a newer full build_check (the
 * clearedRedIsLive guard). ("what does one log window contribute to a main-check scan?") */
interface ScanWindowFacts {
  check?: HarnessEvent;
  /** The window's merged events, in scan order — collected in the same pass that finds the
   * check instead of a second full scan of the window below. */
  mergeDone: HarnessEvent[];
  culprit?: HarnessEvent;
  opener?: HarnessEvent;
  cleared?: HarnessEvent;
}
function scanMainCheckWindow(events: readonly HarnessEvent[]): ScanWindowFacts {
  let check: HarnessEvent | undefined;
  let mergeDone: HarnessEvent[] = [];
  let culprit: HarnessEvent | undefined;
  let opener: HarnessEvent | undefined;
  let cleared: HarnessEvent | undefined;
  for (const e of events) {
    if (e.type === "build_check" && isFullCheckScope(e.scope, e.full)) {
      check = e;
    } else if (e.type === "merge_done" && typeof e.ts === "number") {
      mergeDone.push(e);
    } else if (e.type === "main_check") {
      if (isPassingMainCheck(e)) opener = undefined; // a passing full main check closes the open red spell
      cleared = e.cleared === true ? e : undefined;
    } else if (e.type === "main_culprit") {
      culprit = e;
      if (opener === undefined) opener = e; // the oldest main_culprit since the last pass
    }
  }
  return { check, mergeDone, culprit, opener, cleared };
}

/** Whether a cleared red is still live: the newest cleared main_check is newer than the newest
 * full build_check, so the confirming full run has not settled and no full verdict covers the
 * clearing head. A confirming run that settled logs its own build_check (or a settled
 * main_check) after the cleared event; either ends the state.
 * ("when is a cleared red still live?") */
function clearedRedIsLive(cleared: HarnessEvent | undefined, check: HarnessEvent | undefined): boolean {
  return (
    cleared !== undefined &&
    typeof cleared.ts === "number" &&
    (check === undefined || typeof check.ts !== "number" || cleared.ts > check.ts)
  );
}

/** The three-way pairing of the window's merged events against the check's ts: the newest merge
 * after the check (the sha a pre-merge check verified), the newest merge at or before it (the
 * fallback when nothing merged after), and — for a baseline check, which runs on the head main
 * held at its spawn — the newest merge at or before the run's spawn, so a merge that lands while
 * the run is in flight logs before the check's settle stamp but is not covered by it.
 * ("which merge does a check cover?") */
function mergesAroundCheck(
  mergeDone: readonly HarnessEvent[],
  checkTs: number,
  spawnedAt: number | undefined,
): { after?: HarnessEvent; before?: HarnessEvent; beforeSpawn?: HarnessEvent } {
  let after: HarnessEvent | undefined;
  let before: HarnessEvent | undefined;
  let beforeSpawn: HarnessEvent | undefined;
  for (const e of mergeDone) {
    if (e.ts > checkTs) after = e;
    else {
      before = e;
      if (spawnedAt !== undefined && e.ts <= spawnedAt) beforeSpawn = e;
    }
  }
  return { after, before, beforeSpawn };
}

/** Scan the log for MainCheckScan, growing the tail until a merge-scope check is inside it (see
 * MAIN_CHECK_SCAN_MAX_EVENTS): a check older than the default tail must still badge the header,
 * and every event after the check — the merged pairing the sha needs — is newer, so one window
 * holds the whole derivation. */
function scanMainCheck(root: string): MainCheckScan {
  const grewFull = mainCheckGrewFull.has(root);
  // A set note means the previous scan reached the cap without finding a check, so start
  // there: starting at DEFAULT_EVENT_TAIL would only re-read (and re-parse on a cache miss)
  // a window the next step discards. This is what the note's "starts straight at the cap"
  // promises; the update keeps a non-set scan on the ×4 ladder it has always used.
  let window = grewFull ? MAIN_CHECK_SCAN_MAX_EVENTS : DEFAULT_EVENT_TAIL;
  // The final window's facts — each iteration rescans from scratch, so no stale value from a
  // previous, smaller window survives; the break exits with the final tail's result.
  let facts: ScanWindowFacts = {
    check: undefined,
    mergeDone: [],
    culprit: undefined,
    opener: undefined,
    cleared: undefined,
  };
  for (;;) {
    const events = readEvents(root, window);
    facts = scanMainCheckWindow(events);
    const check = facts.check;
    // Found, the log is shorter than the window (nothing older exists to find), or the cap
    // is reached: the tail is final.
    if (check || events.length < window || window >= MAIN_CHECK_SCAN_MAX_EVENTS) break;
    window = grewFull ? MAIN_CHECK_SCAN_MAX_EVENTS : Math.min(window * 4, MAIN_CHECK_SCAN_MAX_EVENTS);
  }
  const check = facts.check;
  const mergeDone = facts.mergeDone;
  const culprit = facts.culprit;
  const opener = facts.opener;
  const cleared = facts.cleared;
  if (mainCheckGrewFull.size >= MAIN_CHECK_FULL_SET_MAX) mainCheckGrewFull.clear();
  if (check) mainCheckGrewFull.delete(root);
  else mainCheckGrewFull.add(root);
  // The loop's last pass over the FINAL tail left `opener` current: an earlier window's value
  // was reset before its own scan, and the break exits with the final tail's result.
  const clearedLive = clearedRedIsLive(cleared, check);
  if (!check || typeof check.ts !== "number" || !isMainCheckStatus(check.status)) {
    return {
      ...(clearedLive ? { cleared } : {}),
      ...(culprit ? { culprit } : {}),
      ...(opener ? { spellOpener: opener } : {}),
    };
  }
  // A baseline check runs on the head main held at its spawn; a merge that lands while the
  // run is in flight logs before the check's settle stamp but is not covered by it. Capture
  // that spawn-bounded merge separately so the sha can name the head the run actually saw.
  const spawnedAt = check.scope === "baseline" && typeof check.spawnedAt === "number" ? check.spawnedAt : undefined;
  const { after, before, beforeSpawn } = mergesAroundCheck(mergeDone, check.ts, spawnedAt);
  return {
    check,
    ...(clearedLive ? { cleared } : {}),
    ...(culprit ? { culprit } : {}),
    ...(opener ? { spellOpener: opener } : {}),
    ...(typeof after?.commit === "string" ? { mergeDoneAfterCommit: after.commit } : {}),
    ...(typeof before?.commit === "string" ? { mergeDoneBeforeCommit: before.commit } : {}),
    ...(typeof beforeSpawn?.commit === "string" ? { mergeDoneBeforeSpawnCommit: beforeSpawn.commit } : {}),
  };
}

/** The cached scan for `root`, computing it through scanMainCheck on a cache miss. The clone
 * copies the one check event and the record, so a caller never receives the cached object
 * itself. */
function mainCheckScanFor(root: string): MainCheckScan {
  return (
    cachedByStat(
      mainCheckScanCache,
      root,
      eventsLogPath(root),
      () => scanMainCheck(root),
      (v) => ({
        ...v,
        ...(v.check ? { check: { ...v.check } } : {}),
        ...(v.culprit ? { culprit: { ...v.culprit } } : {}),
        ...(v.spellOpener ? { spellOpener: { ...v.spellOpener } } : {}),
        ...(v.cleared ? { cleared: { ...v.cleared } } : {}),
      }),
    ) ?? { check: undefined }
  );
}

/** The verdict while a cleared red's confirming full run has not settled (part 3b/4 → part
 * 4/4): the newest full build_check is the pre-clearing red, so reading it would call a head
 * "red" on which every open failure has passed. The cleared main_check alone carries the
 * state — no full verdict was written — until the confirming run settles (a newer full
 * build_check or a settled main_check ends it in the scan).
 * ("what does a cleared verdict carry?") */
function clearedMainCheckStatus(cleared: MainCheckScan["cleared"]): MainCheckStatus | undefined {
  if (cleared && typeof cleared.sha === "string" && typeof cleared.ts === "number") {
    return { sha: cleared.sha, status: "passed", at: cleared.ts, cleared: true };
  }
  return undefined;
}

/** The main sha a check's verdict names: a baseline check runs ON main's tip, after the merge that
 * put it there (the watch's hourly pass, a redeploy green, a gate's main-tip verdict), so its
 * covered head is the newest merge at or before its run's spawn (its log stamp when the event
 * carries no spawn) — never a merge that landed while the run was in flight or afterwards. The
 * after-first pairing still serves a historical pre-merge merge/batch check, whose verified head is
 * the merge it precedes. Without the baseline branch an hour-old green is shown "at" the newest
 * head the interval has not covered yet, which is the implication part 4/4 exists to remove. ("what
 * head does a check cover?") */
function mainCheckCoveredSha(scan: MainCheckScan, check: HarnessEvent, cfg: TumwaterConfig, root: string): string | undefined {
  const branch = targetBranch(cfg.baseBranch, currentBranchFromHeadFile(root));
  return check.scope === "baseline"
    ? scan.mergeDoneBeforeSpawnCommit ?? scan.mergeDoneBeforeCommit ?? readBranchHead(root, branch) ?? scan.mergeDoneAfterCommit
    : scan.mergeDoneAfterCommit ?? readBranchHead(root, branch) ?? scan.mergeDoneBeforeCommit;
}

/** The red detail the status payload carries (it rides the machine-readable `status --json`
 * output through status-payload.ts's wholesale spread of mainCheck): present only when the
 * check failed and a main_culprit verdict names the checked tip or the opener of the red spell
 * still open at the tail's end (spellOpener — the watch names the spell's opener as culprit
 * even after a later tip re-checks red, so an ongoing red keeps its blame instead of dropping
 * it) — with a well-formed failingTests list. A passing/skipped check, or a failing one whose
 * tip the watch hasn't blamed, keeps today's exact MainCheckStatus shape (no `red`).
 * ("what red detail does a verdict carry?") */
function mainCheckRedDetail(check: HarnessEvent, sha: string | undefined, scan: MainCheckScan): MainCheckStatus["red"] {
  let red: MainCheckStatus["red"] | undefined;
  if (check.status === "failed" && sha !== undefined && scan.culprit && typeof scan.culprit.commit === "string") {
    const c = scan.culprit;
    const openerCommit = scan.spellOpener && typeof scan.spellOpener.commit === "string" ? scan.spellOpener.commit : undefined;
    if (c.commit === sha || (openerCommit !== undefined && c.commit === openerCommit)) {
      const failing =
        Array.isArray(c.failingTests) && typeof c.failingTests[0] === "string"
          ? c.failingTests.filter((f): f is string => typeof f === "string")
          : undefined;
      if (failing) {
        red = {
          failingTests: failing,
          culprit: {
            commit: c.commit,
            ...(typeof c.runner === "string" ? { runner: c.runner } : {}),
          },
        };
      }
    }
  }
  return red;
}

/** The verdict's clock: how old it is and when the next full check is due. The checked time is
 * the run's settle stamp (main-watch stamps the baseline's checkedAt at the run's end; the
 * event carries the same settle time) falling back to the event's log time (test fixtures and
 * older events). The next due rides the cadence part 2b/4 measures from — the newest full
 * verdict's checkedAt + check.fullIntervalMinutes (default 60). A skipped check produced no
 * verdict, so it carries neither. A red is rechecked on every new head rather than on the
 * interval (main-watch's fullCheckPlan), so only a green carries a clock due; quoting "next
 * in …" for a red would promise a run the cadence never starts. Interval 0 (one full run per
 * new head) has nothing due either. ("what age and next-due does a verdict carry?") */
function mainCheckCadence(check: HarnessEvent, cfg: TumwaterConfig): {
  checkedAt: number;
  hasVerdict: boolean;
  nextDueAt?: number;
} {
  const checkedAt = typeof check.settledAt === "number" ? check.settledAt : check.ts;
  const interval = cfg.check?.fullIntervalMinutes ?? 60;
  const hasVerdict = check.status !== "skipped";
  const nextDueAt = check.status === "passed" && interval > 0 ? checkedAt + interval * 60_000 : undefined;
  return { checkedAt, hasVerdict, nextDueAt };
}

/** The newest merge-scope build_check in the event tail, with the main sha it verified
 * (mainCheck's derivation — see the field's comment). A gate-scope check is excluded: it
 * verified a role worktree, not main. The log-derived scan is stat-cached per events.jsonl
 * (mainCheckScanFor); only the branch/sha fallback reads here are per call, so a config or
 * checkout change is observed even while the log sits still. */
export function mainCheckForPoll(root: string, cfg: TumwaterConfig): MainCheckStatus | undefined {
  const scan = mainCheckScanFor(root);
  // A cleared red whose confirming full run has not settled: the cleared main_check alone
  // carries the state until the confirming run settles.
  const cleared = clearedMainCheckStatus(scan.cleared);
  if (cleared) return cleared;
  const check = scan.check;
  if (!check || typeof check.ts !== "number" || !isMainCheckStatus(check.status)) return undefined;
  const sha = mainCheckCoveredSha(scan, check, cfg, root);
  const counts = asTestCounts(check.counts);
  const red = mainCheckRedDetail(check, sha, scan);
  const { checkedAt, hasVerdict, nextDueAt } = mainCheckCadence(check, cfg);
  // A green verdict taken on an old head keeps the verdict word and reads as a statement
  // about current main once main has moved on — the staleness the entry named (BUGS.md
  // 2026-11-11). Read the branch's current tip (cheap: HEAD file / loose refs, like the
  // covered-sha read above) and flag a green whose covered sha is behind it. A red is
  // already flagged by color (the watch rechecks it on the next head) and a skipped check
  // produced no verdict, so neither carries the staleness mark. `targetBranch`,
  // `currentBranchFromHeadFile` and `readBranchHead` are the same imports the covered-sha
  // read above uses, and `readBranchHead` returns null (not throws) when the repo or ref is
  // unreadable, so a null tip leaves the verdict word intact.
  const tipSha = sha && check.status === "passed"
    ? readBranchHead(root, targetBranch(cfg.baseBranch, currentBranchFromHeadFile(root)))
    : null;
  return {
    ...(sha ? { sha } : {}),
    status: check.status,
    ...(counts ? { counts } : {}),
    at: check.ts,
    ...(hasVerdict ? { checkedAt } : {}),
    ...(nextDueAt !== undefined ? { nextDueAt } : {}),
    ...(tipSha && tipSha !== sha ? { tipAdvanced: true } : {}),
    ...(red ? { red } : {}),
  };
}
