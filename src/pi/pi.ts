/** The pi-side facade over the backend-neutral agent runner (src/agent/run-agent.ts) and the
 * pi adapter (src/pi/pi-backend.ts). `runPi` is a thin alias for `runAgent` so every existing
 * call site, fake, and test keeps importing the historical name; `hasResumableSession`, the
 * stderr-match constants, and the run-kind/backend-failure types stay here for the same
 * reason. The seam itself lives in src/agent/agent-backend.ts. */

import fs from "node:fs";

export { runAgent, runPi } from "../agent/run-agent.js";
export type { PiRunOptions } from "../agent/run-agent.js";
export { MODEL_FALLBACK_CLONE, TRANSIENT_PI_CRASH } from "./pi-backend.js";
export type { BackendFailureKind } from "./pi-stream.js";
export type { PiRunKind } from "./pi-event-line.js";

/** True when `sessionDir` holds at least one pi session file for --continue to resume.
 * Guards the resume-after-shutdown path: with nothing to resume (sessions pruned, or the
 * aborted run died before pi created one), the tick falls back to a fresh start. */
export function hasResumableSession(sessionDir: string): boolean {
  try {
    return fs.readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false; // Missing directory — nothing to resume.
  }
}
