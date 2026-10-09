/** The window-days clamp contract as one table, shared by every surface that takes a day
 * count (the CLI's windowDays validator, /api/report, /api/failures). Each entry is
 * [query string, expected days]: missing or any non-plain-digit spelling gets the default;
 * a real count is clamped into [1, REPORT_MAX_DAYS]. The query carries no leading "?", so
 * callers can splice it after "?" for an HTTP fetch or hand it straight to URLSearchParams. */
import { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS } from "../../src/events/event-window.js";

export const WINDOW_DAY_CASES: ReadonlyArray<readonly [string, number]> = [
  ["", REPORT_DEFAULT_DAYS], // days absent
  ["days=", REPORT_DEFAULT_DAYS], // days present but empty
  ["days=abc", REPORT_DEFAULT_DAYS],
  ["days=1e3", REPORT_DEFAULT_DAYS], // scientific spelling is not a count
  ["days=0x10", REPORT_DEFAULT_DAYS], // hex prefix: raw parseInt stopped at "x" and coerced to 0 → 1 day
  ["days=-5", REPORT_DEFAULT_DAYS], // signed spelling is not a count
  ["days=%207", REPORT_DEFAULT_DAYS], // whitespace-padded spelling is not a count
  ["days=0", 1],
  ["days=1", 1],
  ["days=3", 3],
  ["days=14", REPORT_DEFAULT_DAYS],
  ["days=91", REPORT_MAX_DAYS],
  ["days=900", REPORT_MAX_DAYS],
  [`days=${REPORT_MAX_DAYS + 1}`, REPORT_MAX_DAYS],
  [`days=${REPORT_MAX_DAYS + 500}`, REPORT_MAX_DAYS],
];
