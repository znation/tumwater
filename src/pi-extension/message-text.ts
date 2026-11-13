/**
 * The plain text of one pi message, read through the extensions' one shared reader.
 *
 * pi's message content crosses the provider boundary unvalidated: it is an array of content
 * blocks, or a torn or foreign shape (a plain string, a number, a null) when the wire is
 * mid-write or not pi's own. A non-array content reads as no text — the same rule as
 * pi-stream.ts's `messageContent`, transcript.ts's `contentBlocks` and progress-data.ts's
 * `workItemFromContent` apply to the identical field — and the reader never throws. An array
 * is its `text`-typed blocks in order, joined by a newline; a non-`text` block, a bare-string
 * element, or a torn entry is skipped.
 *
 * The bundled extensions read a message's text the same way: context-shake measures a result's
 * bulk and pin-prompt pins the run prompt verbatim. pi itself loads the extensions, so the block
 * shape stays structural and the real pi types stay out of the dependency tree, as in
 * tool-result-content.ts and context-usage.ts. The reader is exported so a test pins the one
 * shape and the extensions cannot drift apart on it.
 *
 * The harness keeps its own readers for the same field: transcript.ts's `contentBlocks` and
 * progress-data.ts's `workItemFromContent` render or summarize rather than extract one string,
 * and pi-stream.ts's `messageContent` normalizes the block array (including non-`text` blocks)
 * the `.filter`/`.some` chains need; this is the string-extraction half they all share.
 */

/** The text of one pi message's `content`, or the empty string when it is not an array of
 * content blocks. An array is its `text`-typed blocks in order, joined by a newline; a
 * non-`text` block, a bare-string element, or a torn entry is skipped. Never throws. */
export function messageText(msg: { content?: unknown }): string {
  const content = msg.content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: unknown; text?: unknown }>)
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}
