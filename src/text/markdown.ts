/** Shared Markdown TABLE construction for the report renderers — the one place the header
 * row, the alignment separator, and the body rows are joined, so the separator always carries
 * exactly as many cells as the header (a delimiter-less or mismatched join collapses the
 * separator into one cell, which renders the table as plain text — invisible in the digest,
 * which is mostly read as Markdown). The usage report's day table (report/report-render.ts)
 * and the failure digest's outcome, time-and-spend, and deltas tables
 * (failure/failure-render.ts) all build through it. Presentation only: depends on node
 * built-ins alone. */

/** One table column's alignment: `right` writes `---:` in the separator row (numeric columns),
 * `left` writes `---` (text columns). A column past the end of the align array is left. */
export type ColumnAlign = "left" | "right";

/** A Markdown table as its lines: the header row, the separator row derived from the header,
 * then one line per body row. Cells are rendered verbatim — callers format their own — so the
 * only invariant this owns is that header and separator carry the same cell count. */
export function markdownTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  align: readonly ColumnAlign[] = [],
): string[] {
  const separator = header.map((_, i) => (align[i] === "right" ? "---:" : "---"));
  return [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
  ];
}
