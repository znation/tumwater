/** Shared Markdown construction for the report renderers and gate prompts — the one place the
 * header row, the alignment separator, and the body rows of a table are joined (so the
 * separator always carries exactly as many cells as the header; a delimiter-less or mismatched
 * join collapses the separator into one cell, which renders the table as plain text — invisible
 * in the digest, which is mostly read as Markdown) and the one place an ordered list is
 * numbered. The usage report's day table (report/report-render.ts), the failure digest's
 * outcome, time-and-spend, and deltas tables (failure/failure-render.ts), and the landing
 * gate's numbered objections and findings (gates/gate-prompts.ts) all build through it.
 * Presentation only: depends on node built-ins alone. */

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

/** `items` as a `1. …` ordered list, one line each, joined with newlines — the single home of
 * the `map((item, i) => `${i + 1}. ${item}`).join("\n")` step, shared by the review prompt's
 * prior objections, its stage-fix findings, and the rejected/revision notes
 * (gates/gate-prompts.ts) and `tumwater questions`' open-question list
 * (cli/question-commands.ts), so the numbering shape cannot drift between the surfaces that
 * read a numbered list. `empty` is returned verbatim when `items` is empty (the reasons
 * sites pass `(no reasons recorded)`; the others keep the default empty string). */
export function numberedList(items: readonly string[], empty = ""): string {
  return items.length > 0 ? items.map((item, i) => `${i + 1}. ${item}`).join("\n") : empty;
}
