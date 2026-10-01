/** Pure formatting and description of a build check's failure output — split out of
 * build-check.ts, which keeps the execution side (detect → run → classify, the toolchain
 * probe, the process-group runner). This module turns a check's raw combined output and a
 * BuildCheckOutcome into the machine text that is persisted and shown: the per-line clip cap
 * (clipReason/MAX_REASON_CHARS, shared with review-verdict.ts's parseVerdict), the clipped
 * output tail (clipBuildTail), the one-line headline a warning names the failure by
 * (failureHeadline), the check's human-facing command name (describeCheck), and the reasons a
 * red check hands its author (checkFailureReasons). Every consumer of a check's tail — the
 * review gate, the landing path, the red-main gate, the tick prompt — imports from here, so
 * "which line is the headline" and "how much output survives" have one answer each. Type-only
 * back-reference to build-check.ts for BuildCheckOutcome (no runtime cycle); BuildCheck comes
 * from build-check-detect.ts. */

import type { BuildCheck } from "./build-check-detect.js";
import type { BuildCheckOutcome } from "./build-check.js";
import { truncate } from "./text.js";

/** Per-reason length cap with ellipsis — bounds one line of machine-generated or reviewer
 * text so it cannot bloat persisted state (shared by clipBuildTail here and parseVerdict in
 * review-verdict.ts). */
const MAX_REASON_CHARS = 300;

/** Cap one line of text to MAX_REASON_CHARS with an ellipsis (unchanged when it fits). */
export function clipReason(r: string): string {
  return truncate(r, MAX_REASON_CHARS);
}

/** A line that NAMES a failure rather than framing it: Node prints an unhandled error's message
 * ABOVE its stack and property dump (`Error: ENOENT: …`, `AssertionError [ERR_ASSERTION]: …`),
 * so a ten-line tail window that cuts the stack can cut the message too. The pattern is used to
 * PRESERVE that line, never to skip lines: an over-broad "skip property lines" rule would drop
 * real diff content like `actual: 1,` / `expected: 2,` and pick a trailing `diff: 'simple'`
 * instead (BUGS.md 2026-09-19). It matches `<Something>Error: …` / `<Something>Error [CODE]: …`. */
const ERROR_MESSAGE_LINE = /^\S*Error\b[^:]*:\s/;

/** A failed test's name line in node:test's spec output (`✖ <test name> (12.3ms)`) — every `✖`
 * line but the `✖ failing tests:` section header. The run's LAST one is the failure whose detail
 * ends the output, so it names the test the tail's message and stack belong to. */
const FAILED_TEST_LINE = /^✖ (?!failing tests:)/;

/** Keep the TAIL of a build's combined output: last ≤10 meaningful lines, each via clipReason —
 * so a chatty build cannot bloat persisted state or the injected next-tick note. Blank lines
 * and npm's own script banner (`> pkg@1.0 script`, `> <command>`) are dropped: they name the
 * script that ran, not what broke in it. When the ten-line window cuts off the error-message
 * line that sits above the stack, the nearest such line is kept as well, so failureHeadline can
 * name the failure instead of a stack frame or an error property; likewise the failed test's
 * name line (FAILED_TEST_LINE) above it, so the headline says WHICH test — an assertion's
 * message alone (`Expected values to be strictly equal:`) names none, and a flake reported only
 * that way could not be traced (BUGS.md 2026-09-30). Twelve lines at most. */
export function clipBuildTail(output: string): string[] {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^>\s/.test(l));
  const tail = lines.slice(-10);
  const cut = [...lines.slice(0, -10)].reverse();
  const message = cut.find((l) => ERROR_MESSAGE_LINE.test(l));
  const testName = tail.some((l) => FAILED_TEST_LINE.test(l)) ? undefined : cut.find((l) => FAILED_TEST_LINE.test(l));
  return [...(testName ? [testName] : []), ...(message ? [message] : []), ...tail].map(clipReason);
}

/** The line of a clipped failure tail (clipBuildTail) worth putting in a one-line warning.
 * clipBuildTail keeps the LAST ten meaningful lines (plus the error-message line above the
 * window when it would otherwise be cut), so a check that died on an unhandled rejection ends
 * mid-stack and the tail's FIRST line is a frame: every red-main warning logged before
 * 2026-09-18 read "main <sha> is red (test: at process.processTicksAndRejections
 * (node:internal/...))" — where, never what, which is why a false red that blocked the fleet
 * for hours could not be diagnosed from the event feed at all (BUGS.md). Prefer the first line
 * that is not framing — a stack frame, or node:test's summary/framing lines (below) — and fall
 * back to the tail's first line when every line is framing, so a caller always has something
 * to print. Only framing is skipped — an assertion diff,
 * a compiler error and a bare "1) test name" all read as the headline they are. Lives beside
 * clipBuildTail, whose output it interprets, so every consumer of a check's tail — the red-main
 * gate (main-red.ts) and the review gate (review.ts) — shares one "which line is the
 * headline" answer. node:test's spec reporter ends a failing run with its summary block
 * (`ℹ pass 0`, `ℹ todo 0`, `ℹ duration_ms …`) followed by the `✖ failing tests:` detail
 * (a bare `test at <file>:<line>` marker, then the failure's own message); when both fit in
 * the ten-line window the first non-frame line was a summary counter, and the headline named
 * nothing again (BUGS.md 2026-09-22) — so summary and section-framing lines are skipped like
 * frames, while a failure line (`✖ <message>`) and an assertion diff still read as the
 * headline they are. */
const FRAMING_LINE = /^(?:at\s|ℹ\s|✖ failing tests:|test at \S+:\d+:\d+)/;

/** The one-line headline for a red check's clipped tail (clipBuildTail's output): the first
 * line that is neither framing (FRAMING_LINE) nor a failed test's name, prefixed with the
 * test's name (its duration dropped, so one flake's warnings cluster as one) when the tail
 * carries one — else the name alone, else the tail's first line when every line is framing, so
 * a caller always has something to print. Undefined for an absent or empty tail. */
export function failureHeadline(tail: readonly string[] | undefined): string | undefined {
  if (!tail?.length) return undefined;
  const name = tail.findLast((line) => FAILED_TEST_LINE.test(line))?.replace(/ \([\d.]+m?s\)$/, "");
  const what = tail.find((line) => !FRAMING_LINE.test(line) && !FAILED_TEST_LINE.test(line));
  if (name !== undefined) return what !== undefined ? `${name} — ${what}` : name;
  return what ?? tail[0];
}

/** The human/prompt-facing name of a check (plans/portability.md §6/7): the tick prompt and
 * the gate's check reasons name the actual verification command instead of asserting npm —
 * "verify with `pytest -q`" in a Python repo, "`npm run test`" in an npm one. */
export function describeCheck(check: BuildCheck): string {
  return check.kind === "npm" ? `\`npm run ${check.script}\`` : `\`${check.command}\``;
}

/** The machine-generated reasons a red check hands its author: the headline joined to the rest
 * of the clipped tail, so the compiler error sits right after it in the injected next-tick note.
 * The headline is failureHeadline's — the first line that is not a stack frame — not
 * outputTail[0]: a suite that dies on an unhandled rejection opens mid-stack, and naming the
 * frame tells the author where it broke, never what (BUGS.md 2026-09-19). One definition for
 * every red that rejects a change: the gate's pre-check, a batch's single-change red, and a
 * single landing's in-lock check. */
export function checkFailureReasons(check: BuildCheck, outcome: BuildCheckOutcome): string[] {
  const tail = outcome.outputTail ?? [];
  // An unverified rejection already says what happened — the check never finished, the tree is
  // unverified — so its reason keeps its own wording verbatim: prefixing it with "build check
  // failed" would read as a deterministic tree failure and send the author hunting a test
  // failure that never happened (BUGS.md 2026-09-28). The empty-tail fallback keeps the safe
  // default should a remap ever lose its reason line.
  if (outcome.unverified) {
    return tail.length > 0 ? tail : [`build check failed (${describeCheck(check)})`];
  }
  const headline = failureHeadline(tail);
  const what = describeCheck(check);
  return headline !== undefined
    ? [`build check failed (${what}): ${headline}`, ...tail.filter((l) => l !== headline)]
    : [`build check failed (${what})`];
}
