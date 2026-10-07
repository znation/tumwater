/**
 * Bundled pi extension: the `role_notes` tool, which writes one bounded note per role into
 * the harness's runtime state so a role's next fresh tick can read it (PLANS.md "Role
 * notebook"). Loaded on every pi run via `-e <this file>` from src/pi/pi-args.ts, but it
 * registers the tool ONLY when TUMWATER_NOTES_PATH is set: src/loop/loop-pi.ts's
 * runAuthoringPi sets it for authoring ticks, while landing, review, and conflict-resolution
 * runs leave it unset (the director has no notebook either).
 *
 * Why: every tick is a fresh pi session, which retired session poisoning but also discards the
 * small continuity worth keeping — where things live, what was ruled out, what to look at
 * next. The note carries exactly that much, capped so it cannot grow into a transcript. The
 * 4,096-byte validation is a pure exported function (`validateRoleNote`), so it is testable
 * without pi, the same pattern as bounded-output and context-budget; the default export is the
 * thin adapter that registers the tool with pi's `registerTool()`.
 *
 * A plain JSON Schema `parameters` object is passed — no `typebox` import — matching the shape
 * pi's own MCP extension builds for its dynamically registered tools, and keeping this file
 * free of runtime dependencies (PRINCIPLES.md).
 */

import fs from "node:fs";
import path from "node:path";
import { gotSuffix } from "../text/text.js";

/** The cap on a role's note, in UTF-8 bytes. Small enough to cost little on every turn, large
 * enough for the codebase facts a role wants to keep. */
export const ROLE_NOTES_MAX_BYTES = 4096;

/** The tool's parameter schema (plain JSON Schema). */
const ROLE_NOTES_PARAMETERS = {
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

/** Validate note text against the byte cap. Returns null when the text is acceptable, or an
 * error naming the byte count and the limit. Pure, so the boundary is testable without pi. */
export function validateRoleNote(text: string): string | null {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > ROLE_NOTES_MAX_BYTES) {
    return `note is ${bytes} bytes; the limit is ${ROLE_NOTES_MAX_BYTES} bytes`;
  }
  return null;
}

/** Replace the note file at `notesPath` with `text`, writing to a temp file in the same
 * directory and renaming it over the target so a reader never sees a half-written note.
 * Creates the directory if needed. Callers validate first; this does not. */
export function writeRoleNote(notesPath: string, text: string): void {
  fs.mkdirSync(path.dirname(notesPath), { recursive: true });
  const tmp = `${notesPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, notesPath);
}

/** Minimal structural types for pi's extension API — pi itself loads this file, so the real
 * types are not needed at compile time and stay out of the dependency tree. */
interface RoleNotesToolResult {
  content: Array<{ type: string; text: string }>;
  details: undefined;
}

interface RoleNotesParams {
  text?: unknown;
}

interface PiExtensionApi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: RoleNotesParams,
    ): Promise<RoleNotesToolResult> | RoleNotesToolResult;
  }): void;
}

/** Register the `role_notes` tool when this run carries a notebook. */
export default function roleNotes(pi: PiExtensionApi): void {
  const notesPath = process.env.TUMWATER_NOTES_PATH;
  if (!notesPath) return;
  pi.registerTool({
    name: "role_notes",
    label: "role notebook",
    description:
      `Replace this role's notebook: the short note the role's own earlier ticks left for the ` +
      `next tick (where things live, what was ruled out, what to look at next; at most ` +
      `${ROLE_NOTES_MAX_BYTES} bytes). Pass the full replacement text; empty text clears it.`,
    parameters: ROLE_NOTES_PARAMETERS,
    execute(_toolCallId, params) {
      // The parameter schema asks for a string, but pi does not guarantee it enforced every
      // tool call's shape — and coercing a malformed `text` to "" cleared the notebook, the
      // destructive reading of a typo the model never sees. Reject it instead, naming the
      // offending value and the fix, so a bad call is retried rather than silently wiping the
      // continuity the tool exists to keep.
      const text = params?.text;
      if (typeof text !== "string") {
        throw new Error(
          `role_notes requires a string "text"${text === undefined ? "" : gotSuffix(text)} — pass the full replacement note, or "" to clear it`,
        );
      }
      const error = validateRoleNote(text);
      if (error) throw new Error(error);
      writeRoleNote(notesPath, text);
      return {
        content: [
          {
            type: "text",
            text: text === "" ? "notebook cleared" : `notebook saved (${Buffer.byteLength(text, "utf8")} bytes)`,
          },
        ],
        details: undefined,
      };
    },
  });
}
