/** The review gate's memory of its own flake warnings — split out of review-precheck.ts so the
 * "has this exact failure already passed on a re-run?" question lives on its own and can be
 * unit-tested over synthetic events. The gate re-runs a failed check once (BUGS.md 2026-09-23) and
 * logs `gate check failed then passed on retry — flaky: <headline>` when it passes (the in-lock
 * merge check's kept-pin retry logs the same with a `merge check` prefix); a later
 * repeat of that same headline is the flake firing again, not a verdict about whichever change
 * happened to hit it (BUGS.md 2026-10-06). The flake is matched by the shared failure-cluster
 * normalization so a duration, path, SHA, timestamp, or bare integer difference does not hide the
 * repeat. Only the gate's positive flake record is trusted: a check-failure rejection is not
 * evidence of flakiness — it is exactly the attribution this memory exists to avoid making
 * twice. */

import { DAY_MS } from "../text/datetime.js";
import { TUMWATER_SOURCE, tryOrWarn, warnEventBestEffort, type HarnessEvent } from "../events/events.js";
import { readEventsSince } from "../events/event-window.js";
import { increment } from "../collections.js";
import { normalizeClusterKey } from "../failure/failure-cluster.js";
import { FAILING_TESTS_MAX } from "../build/build-check-report.js";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { isJsonObject } from "../files/json-object.js";
import { parseEntryDetails } from "../backlog/backlog-md.js";
import { readTextOrNull } from "../files/files.js";
import { quarantinePath } from "../paths.js";
import path from "node:path";

/** How far back the gate looks for its own flake warnings. One local day: the example in
 * BUGS.md 2026-10-06 recorded a flake at 10:50 and rejected an unrelated change on the same
 * headline at 15:57, and a day is short enough that a retired flake stops excusing failures
 * while still covering a team's working span. Exported so the doctor's `flaky checks` check
 * and the gate share the one window and cannot drift. */
export const KNOWN_FLAKE_WINDOW_MS = DAY_MS;

/** The exact prefix review-precheck.ts writes before a flake's failure headline. Exported so
 * the writer and reader cannot drift over the separator. */
export const FLAKY_WARNING_PREFIX = "gate check failed then passed on retry — flaky: ";

/** The prefix merge-check-failures.ts writes when an in-lock merge check that failed passes on
 * its kept-pin retry — the merge-side twin of FLAKY_WARNING_PREFIX, read by the same consumers. */
export const MERGE_FLAKY_WARNING_PREFIX = "merge check failed then passed on retry — flaky: ";

/** The normalized cluster keys of every flake warning in `events` — the shared extraction
 * both the gate's flakeKeys and the doctor's `flaky checks` check fold from the log, so the
 * prefix slice-offset and original cluster normalization live once and cannot drift. Non-
 * warning events and warnings whose message is not a string are ignored; `cutoffMs`, when
 * given, also drops events timestamped strictly before it. Pure over its inputs (no I/O, no
 * clock) so the matching rules have their own unit tests. */
function flakeWarningKeys(events: readonly HarnessEvent[], cutoffMs?: number): string[] {
  const keys: string[] = [];
  for (const e of events) {
    if (e.type !== "warning" || typeof e.message !== "string") continue;
    if (cutoffMs !== undefined && typeof e.ts === "number" && e.ts < cutoffMs) continue;
    const message = e.message;
    const prefix = [FLAKY_WARNING_PREFIX, MERGE_FLAKY_WARNING_PREFIX].find((p) => message.includes(p));
    if (prefix === undefined) continue;
    keys.push(normalizeClusterKey(message.slice(message.indexOf(prefix) + prefix.length)));
  }
  return keys;
}

/** Each normalized flake headline in `events` with how often it was warned, most frequent first;
 * ties keep first-seen order. No cutoff: callers pass an already-windowed read. Pure. */
export function flakeCounts(events: readonly HarnessEvent[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const key of flakeWarningKeys(events)) increment(counts, key);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** The bar at which a normalized check counts as flapping: one warning in the window is a
 * routine one-off the gate's single re-run already absorbed, while two means the check flapped
 * again and pays that re-run on every merge it touches — the one threshold the doctor's `flaky
 * checks` row reads, folded through
 * repeatedFlakeCounts. */
const FLAKE_REPEAT_WARN = 2;

/** The normalized checks in `events` that flapped at least FLAKE_REPEAT_WARN times, most
 * frequent first — the filter flakeCounts feeds the doctor's `flaky checks` row, so the
 * threshold lives in the one home. Pure. */
export function repeatedFlakeCounts(events: readonly HarnessEvent[]): [string, number][] {
  return flakeCounts(events).filter(([, n]) => n >= FLAKE_REPEAT_WARN);
}

/** A Set of the flakeWarningKeys at or after `now - windowMs` of the gate's own window. */
export function flakeKeys(
  events: readonly HarnessEvent[],
  now: number,
  windowMs: number = KNOWN_FLAKE_WINDOW_MS,
): Set<string> {
  return new Set(flakeWarningKeys(events, now - windowMs));
}

/** Whether `headline` matches a flake warning the gate logged within the last
 * KNOWN_FLAKE_WINDOW_MS, read from the live log and its one archived generation. */
export function isKnownFlake(root: string, headline: string): boolean {
  const { events } = readEventsSince(root, KNOWN_FLAKE_WINDOW_MS);
  return flakeKeys(events, Date.now()).has(normalizeClusterKey(headline));
}

/** One quarantined test: it failed, then passed on the same tree. `bug` is the heading of the
 * BUGS.md entry filed for it, empty until the filing is committed; `tail` is the failing output
 * kept only until then. Exported so the read-only `tumwater quarantine` renderer (and its
 * json feed) can name each entry's fields the operator sees. */
export interface QuarantineEntry {
  test: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  bug: string;
  tail?: string;
}

/** How many quarantined tests are kept; the oldest by lastSeen fall off. */
export const QUARANTINE_MAX = 100;

/** The quarantine list, a malformed file or entry reading as no data. */
export function loadQuarantine(root: string): QuarantineEntry[] {
  const stored = readJsonFile<{ tests?: unknown }>(quarantinePath(root));
  const out: QuarantineEntry[] = [];
  for (const e of Array.isArray(stored?.tests) ? stored.tests : []) {
    if (!isJsonObject(e) || typeof e.test !== "string") continue;
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    out.push({
      test: e.test,
      firstSeen: num(e.firstSeen),
      lastSeen: num(e.lastSeen),
      count: num(e.count) || 1,
      bug: typeof e.bug === "string" ? e.bug : "",
      ...(typeof e.tail === "string" ? { tail: e.tail } : {}),
    });
  }
  return out;
}

function saveQuarantine(root: string, entries: readonly QuarantineEntry[]): void {
  const kept = [...entries].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, QUARANTINE_MAX);
  writeJsonAtomic(quarantinePath(root), { tests: kept });
}

/** The quarantined test names. */
export function quarantinedTests(root: string): string[] {
  return loadQuarantine(root).map((e) => e.test);
}

/** The failing tests when every one is quarantined; null when none is named, any is outside the
 * list, or the list may have been cut short (FAILING_TESTS_MAX). */
export function onlyQuarantined(root: string, failingTests: readonly string[] | undefined): string[] | null {
  if (!failingTests || failingTests.length === 0 || failingTests.length >= FAILING_TESTS_MAX) return null;
  const known = new Set(quarantinedTests(root));
  return failingTests.every((t) => known.has(t)) ? [...failingTests] : null;
}

/** Quarantine each test of a check that failed and then passed on the same tree. A test already
 * listed counts another flake; `tail` is kept for the BUGS.md entry of a new one. Returns the
 * newly quarantined tests. Nothing is recorded for an empty or possibly truncated list. A failed
 * write warns and returns no tests: the callers run this after a re-run passed, so a lost record
 * must not fail that check. */
export function quarantineTests(root: string, tests: readonly string[] | undefined, tail: string | readonly string[] | undefined): string[] {
  if (!tests || tests.length === 0 || tests.length >= FAILING_TESTS_MAX) return [];
  const entries = loadQuarantine(root);
  const now = Date.now();
  const added: string[] = [];
  for (const test of new Set(tests)) {
    const have = entries.find((e) => e.test === test);
    if (have) {
      have.lastSeen = now;
      have.count += 1;
    } else {
      const text = typeof tail === "string" ? tail : (tail ?? []).join("\n");
      entries.push({ test, firstSeen: now, lastSeen: now, count: 1, bug: "", ...(text ? { tail: text } : {}) });
      added.push(test);
    }
  }
  if (!tryOrWarn(root, TUMWATER_SOURCE, "write quarantine.json", () => saveQuarantine(root, entries))) return [];
  return added;
}

/** Remove the one quarantined test named `test` at the operator's request — the manual twin
 * of releaseQuarantine's automatic release, and `tumwater quarantine --release <n>` its only
 * caller (which resolves the position the list prints down to the exact test first). Returns
 * whether the entry was present and the write succeeded, so the caller can answer a concurrent
 * removal: `false` with no warning and no write for a name not quarantined, or when a write
 * faulted (the quarantineTests write contract: a failed write warns and changes nothing). Logs
 * one `warning` under TUMWATER_SOURCE so the doctor's `flaky checks` row stops
 * excusing the name. */
export function releaseQuarantinedTest(root: string, test: string): boolean {
  const entries = loadQuarantine(root);
  const have = entries.some((e) => e.test === test);
  if (!have) return false;
  const removed = entries.filter((e) => e.test !== test);
  if (!tryOrWarn(root, TUMWATER_SOURCE, "write quarantine.json", () => saveQuarantine(root, removed))) return false;
  warnEventBestEffort(root, TUMWATER_SOURCE, `${test} released from the flake quarantine at the user's request — the gate no longer excuses its failures`);
  return true;
}

/** Record the BUGS.md heading filed for each of `tests`, dropping their kept output. */
export function markQuarantineFiled(root: string, bugs: ReadonlyMap<string, string>): void {
  const entries = loadQuarantine(root);
  for (const e of entries) {
    const bug = bugs.get(e.test);
    if (bug === undefined) continue;
    e.bug = bug;
    delete e.tail;
  }
  saveQuarantine(root, entries);
}

/** Release the quarantined tests whose filed BUGS.md entry is no longer under `## Open`; a later
 * flake of one puts it back. Returns the released tests. A missing BUGS.md releases nothing. */
export function releaseQuarantine(root: string): string[] {
  const entries = loadQuarantine(root);
  const md = readTextOrNull(path.join(root, "BUGS.md"));
  if (md === null || entries.length === 0) return [];
  const open = new Set(parseEntryDetails(md, "Open").map((e) => e.title));
  const released = entries.filter((e) => e.bug !== "" && !open.has(e.bug));
  if (released.length === 0) return [];
  saveQuarantine(root, entries.filter((e) => !released.includes(e)));
  return released.map((e) => e.test);
}
