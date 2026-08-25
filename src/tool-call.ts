import path from "node:path";

/** Human one-liner for a pi tool call, shared by live progress data collection
 * (LiveProgress.lastTool) and transcript rendering. Presentation only: depends on nothing but
 * the shape of tool-call args — so neither the progress data layer nor the transcript module
 * owns it, and both can import it without reaching into each other. */

/** One-line description of a tool call from its name and args. */
export function describeToolCall(toolName: string, args: unknown): string {
  let detail = "";
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const candidate = a.path ?? a.file_path ?? a.command ?? a.cmd ?? a.pattern ?? a.url;
    if (typeof candidate === "string") {
      detail = candidate === a.path || candidate === a.file_path ? path.basename(candidate) : candidate;
    }
  }
  detail = detail.replace(/\s+/g, " ").trim();
  if (detail.length > 32) detail = detail.slice(0, 31) + "…";
  return detail ? `${toolName} ${detail}` : toolName;
}
