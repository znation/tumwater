/** Assertion oracles and normalizers: implementation-independent expectations tests compare
 * against (local-time renders and day keys built from raw date parts, never through
 * datetime.ts, so a drift in the production formatter fails an assertion instead of matching
 * its own output) plus the whitespace normalizer hard-wrapped prose assertions need. Pure
 * functions — no fs, no fixtures; the file-writing fixtures live in log-fixtures.ts. */

/** Collapse all whitespace runs to single spaces: prompts are hard-wrapped and formatting
 * ticks reflow them, so assertions match content with whitespace collapsed — a phrase wrapped
 * across lines must not break a contract check (the first landing of these tests did exactly
 * that: four red unit tests on main). */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ");
}

/** Local-calendar timestamp `daysAgo` days before today, at local `hour` (default 12 — noon
 * keeps a fixture from straddling midnight between seeding and the reader's own clock read).
 * The report/event-window/digest readers bucket by LOCAL day, so fixtures build timestamps
 * from local date parts (never UTC strings) the same way they do. */
export function atLocalTs(daysAgo: number, hour = 12): number {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

/** The local-day key `YYYY-MM-DD` the report/digest collectors bucket by, built from raw
 * local date parts as a test-local oracle — never through datetime.ts's formatDate — so a drift
 * in the collector's day keying fails an assertion instead of matching its own format. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** One hour in ms — the unit the --since window fixtures measure in (6h windows, hour-old
 * events). Shared by the report test files that seed relative timestamps. */
export const HOUR = 3_600_000;

/** Epoch-ms timestamp `ms` before now — the relative-clock oracle the --since fixtures seed
 * with (absolute timestamps would drift past the window cutoff as the test runs). */
export function ago(ms: number): number {
  return Date.now() - ms;
}

/** Local wall-clock rendering of an epoch-ms timestamp as `YYYY-MM-DD HH:MM:SS` — the same
 * shape the transcript's run separators print. Test-local oracle: built from raw local date
 * parts, never through datetime.ts's formatDate/formatTime, so the transcript renderers stay
 * pinned against an implementation-independent expectation. */
export function expectedTimestamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** True when `s` carries a lone UTF-16 surrogate unit: a high one not followed by a low, or a
 * low one not preceded by a high. The truncation and clipping tests assert on this — a cut
 * between an astral character's two units leaves a replacement box on a terminal. Test-local,
 * built from raw code-unit ranges rather than text.ts's pairing helpers, so a drift in the
 * production rule fails an assertion instead of matching its own predicate. */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++; // the low half is consumed; a later lone low is still caught below
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
