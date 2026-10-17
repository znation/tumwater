// vocabulary: plain
/**
 * Bundled pi extension: the `role_notes` tool, which writes one bounded note per role into
 * the harness's runtime state so a role's next fresh tick can read it (PLANS.md "Role
 * notebook"). Loaded on every pi run via `-e <this file>` from src/pi/pi-args.ts, but it
 * registers the tool ONLY when TUMWATER_NOTES_PATH is set: src/loop/loop-pi.ts's
 * runAuthoringPi sets it for authoring ticks, while merge, review, and conflict-resolution
 * runs leave it unset (the director has no notebook either).
 *
 * Why: every tick is a fresh pi session, which retired session poisoning but also discards the
 * small continuity worth keeping — where things live, what was ruled out, what to look at
 * next. The note carries exactly that much, capped so it cannot grow into a transcript. The
 * cap, schema, validation, and atomic write live in src/agent/role-notes-write.ts, shared with
 * claude's MCP server (src/agent/mcp/role-notes-server.ts) so both agent backends write a note
 * the same way; this file is only pi's thin registerTool adapter.
 *
 * A plain JSON Schema `parameters` object is passed — no `typebox` import — matching the shape
 * pi's own MCP extension builds for its dynamically registered tools, and keeping this file
 * free of runtime dependencies (PRINCIPLES.md).
 */

import {
  ROLE_NOTES_DESCRIPTION,
  ROLE_NOTES_MAX_BYTES,
  ROLE_NOTES_PARAMETERS,
  saveRoleNote,
  validateRoleNote,
  writeRoleNote,
} from "../agent/role-notes-write.js";

// Kept re-exported from pi's extension for the callers and tests that have always imported
// them here (src/tick/tick-prompt.ts, test/role-notes.test.ts); the definitions now live in
// src/agent/role-notes-write.ts.
export { ROLE_NOTES_MAX_BYTES, validateRoleNote, writeRoleNote };

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
    label: "role notes",
    description: ROLE_NOTES_DESCRIPTION,
    parameters: ROLE_NOTES_PARAMETERS,
    execute(_toolCallId, params) {
      const text = saveRoleNote(notesPath, params?.text);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}
