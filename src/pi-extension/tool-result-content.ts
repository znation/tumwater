/** The tool_result content patch the two context extensions answer with: append one text
 * block after the event's own content. pi can deliver a tool_result patch whose content is
 * absent or not an array (pi and the other extensions loaded on the same run control the
 * shape), so a missing/non-array list reads as empty and the note is the whole patch; a real
 * list keeps its blocks first and gains the note last. context-budget.ts's threshold note and
 * context-shake.ts's reclaim note both append through this one home.
 *
 * pi itself loads the bundled extensions, so the block shape stays structural and the real
 * pi types stay out of the dependency tree. */

/** Append `text` as one text block after `content`, with the blank-line separator the notes
 * carry — an absent or non-array content list reads as empty. */
export function appendToolResultNote(
  content: unknown,
  text: string,
): { content: Array<{ type: string; text: string }> } {
  const blocks = (Array.isArray(content) ? content : []) as Array<{ type: string; text: string }>;
  return { content: [...blocks, { type: "text", text: `\n\n${text}` }] };
}
