/** The read-only render of the review gate's flake quarantine for the `tumwater
 * quarantine` command. The quarantine list (.tumwater/state/quarantine.json) is the tests
 * that failed then passed on the same tree; the doctor's `flaky checks` row and the
 * selfcheck digest share the underlying quarantineWarning, and this module renders the full
 * list — every entry oldest first with its age, flake count, last sighting and filed bug —
 * so an operator can see which tests the gate is excusing and why. Pure over its inputs
 * (no I/O, no clock): every branch has its own unit tests. */

import { plural } from "../text/phrases.js";
import { squash } from "../text/text.js";
import { humanAgo } from "../text/datetime.js";
import { quarantineWarning } from "../baseline/main-guardrails.js";
import type { QuarantineEntry } from "./known-flakes.js";

/** One rendered quarantine row — the fields `tumwater quarantine --json` serves. */
export interface QuarantineRow {
  position: number;
  test: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  bug: string;
}

/** The quarantine as sorted, positioned rows, oldest first (firstSeen ascending, the order
 * quarantineWarning names its oldest), ties by test name, numbered 1..N. `bug` passes
 * through with `""` staying `""`. */
export function quarantineRows(entries: readonly QuarantineEntry[]): QuarantineRow[] {
  return [...entries]
    .sort((a, b) => a.firstSeen - b.firstSeen || (a.test < b.test ? -1 : a.test > b.test ? 1 : 0))
    .map((e, i) => ({
      position: i + 1,
      test: e.test,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
      count: e.count,
      bug: e.bug,
    }));
}

/** The command's text for `rows`: an empty list prints the empty line (the merge queue empty
 * convention), otherwise a `flake quarantine: N tests` header, the shared quarantineWarning
 * phrase on its own line when one fires (so the command and the doctor's row agree), then one
 * numbered line per entry naming its test, first-seen and last-seen age, flake count and the
 * BUGS.md heading filed for it (or "not filed"). */
export function renderQuarantine(rows: readonly QuarantineRow[], now: number): string {
  if (rows.length === 0) return "flake quarantine is empty";
  const lines = [`flake quarantine: ${plural(rows.length, "test")}`];
  const warning = quarantineWarning(rows, now);
  if (warning !== null) lines.push(warning);
  for (const r of rows) {
    const filed = r.bug ? ` — filed: ${squash(r.bug, 80)}` : " — not filed";
    lines.push(
      `${r.position}. ${squash(r.test, 80)} — first seen ${humanAgo(r.firstSeen, now)}, ` +
        `last seen ${humanAgo(r.lastSeen, now)}, ${plural(r.count, "flake")}${filed}`,
    );
  }
  return lines.join("\n");
}

/** The Markdown section the Failures surfaces (the dashboard's Failures view and the TUI's
 * Failures pane) append below the failure digest — the read twin of the amber quarantine
 * alert, whose `See failures` action lands there. It reads the same `quarantineRows` rule as
 * `tumwater quarantine` (and shares its `quarantineWarning` phrase when one fires), so the CLI
 * and the always-on surfaces cannot disagree. Empty for an empty list, so a window with a
 * digest but a clean quarantine adds nothing. Pure over its inputs (no I/O, no clock). */
export function renderQuarantineSection(rows: readonly QuarantineRow[], now: number): string {
  if (rows.length === 0) return "";
  const lines = ["## Flake quarantine", ""];
  const warning = quarantineWarning(rows, now);
  if (warning !== null) lines.push(warning, "");
  for (const r of rows) {
    const filed = r.bug ? `filed: ${squash(r.bug, 80)}` : "not filed";
    // The test name is NOT squashed: the Failures Ctrl+X release editor matches the exact
    // path the list shows (releaseQuarantinedTest(session.root, test)), so truncating here
    // would make a title over the bound impossible to release. `tumwater quarantine` keeps
    // its own numbered squash because --release <n> never needs the full name.
    lines.push(
      `- ${r.test} — first seen ${humanAgo(r.firstSeen, now)}, ` +
        `last seen ${humanAgo(r.lastSeen, now)}, ${plural(r.count, "flake")} — ${filed}`,
    );
  }
  return lines.join("\n");
}
