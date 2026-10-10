/**
 * The one write path for a role's notebook, shared by the two agent-facing surfaces: the
 * bundled pi extension (src/pi-extension/role-notes.ts) and claude's stdio MCP server
 * (src/agent/mcp/role-notes-server.ts, plans/agent-backends.md "What the pi extensions did,
 * per backend"). Kept backend-neutral — no pi or claude types — so both registers can quote
 * the SAME 4 KB cap, the SAME parameter schema, and the SAME validate-then-atomic-write
 * execution, and cannot drift on what a valid note is or what a rejected call does.
 */

import { writeTextAtomic } from "../files/files.js";
import { gotSuffix } from "../text/text.js";

/** The cap on a role's note, in UTF-8 bytes. Small enough to cost little on every turn, large
 * enough for the codebase facts a role wants to keep. */
export const ROLE_NOTES_MAX_BYTES = 4096;

/** The tool's parameter schema (plain JSON Schema), shared by the pi extension and the MCP
 * server so both declare the same `{ text }` contract. */
export const ROLE_NOTES_PARAMETERS = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: `The full replacement note, at most ${ROLE_NOTES_MAX_BYTES} bytes. Empty text clears it.`,
    },
  },
  required: ["text"],
  additionalProperties: false,
} as const;

/** The human-facing description both surfaces carry: what the note is for, its cap, and the
 * replacement/clear semantics. */
export const ROLE_NOTES_DESCRIPTION =
  `Replace this role's notebook: the short note the role's own earlier ticks left for the ` +
  `next tick (where things live, what was ruled out, what to look at next; at most ` +
  `${ROLE_NOTES_MAX_BYTES} bytes). Pass the full replacement text; empty text clears it.`;

/** Validate note text against the byte cap. Returns null when the text is acceptable, or an
 * error naming the byte count and the fix — the same "shorten it to at most" wording
 * text/text.ts's tooLongMessage gives every other bounded text, so the model that overran
 * learns what to do, not just what went wrong. Pure, so the boundary is testable without pi. */
export function validateRoleNote(text: string): string | null {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > ROLE_NOTES_MAX_BYTES) {
    return `note is ${bytes} bytes — shorten it to at most ${ROLE_NOTES_MAX_BYTES} bytes`;
  }
  return null;
}

/** Replace the note file at `notesPath` with `text` through src/files/files.ts's
 * writeTextAtomic — the one home of the parent-dir creation, tmp+rename, and
 * no-remnant-on-failure contract, so a role's notebook cannot litter `.tumwater/state/notes/`
 * with a temp file that nothing prunes. Callers validate first; this does not. */
export function writeRoleNote(notesPath: string, text: string): void {
  writeTextAtomic(notesPath, text);
}

/** Validate and write one `role_notes` call's text, returning the surface's success message.
 * `text` is `unknown` because neither pi nor MCP guarantees the model honored the parameter
 * schema: coercing a malformed `text` to "" cleared the notebook, the destructive reading of
 * a typo the model never sees, so a bad call throws instead and the caller renders it as a
 * tool error. Shared so the two surfaces reject the same inputs with the same wording and the
 * same no-write-on-failure behavior. */
export function saveRoleNote(notesPath: string, text: unknown): string {
  if (typeof text !== "string") {
    throw new Error(
      `role_notes requires a string "text"${text === undefined ? "" : gotSuffix(text)} — pass the full replacement note, or "" to clear it`,
    );
  }
  const error = validateRoleNote(text);
  if (error) throw new Error(error);
  writeRoleNote(notesPath, text);
  return text === "" ? "notebook cleared" : `notebook saved (${Buffer.byteLength(text, "utf8")} bytes)`;
}
