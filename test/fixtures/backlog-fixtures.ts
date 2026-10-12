/** Backlog markdown fixtures shared across the split test/backlog-write*.test.ts suites. */

/** A hand-written BUGS.md with three body-carrying entries, so the cancel and edit halves can
 * compare bytes before and after a write rather than only the readers' titles. */
export function seededBugs(): string {
  return [
    "# Bugs",
    "",
    "## Open",
    "",
    "### first (reported by the operator 2026-10-01)",
    "",
    "body one",
    "",
    "### second (reported by the operator 2026-10-02)",
    "",
    "body two",
    "",
    "### third (reported by the operator 2026-10-03)",
    "",
    "body three",
    "",
    "## Fixed",
    "",
    "_None yet._",
    "",
  ].join("\n");
}
