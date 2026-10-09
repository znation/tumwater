/** The pi-side facade over the backend-neutral agent runner (src/agent/run-agent.ts) and the
 * pi adapter (src/pi/pi-backend.ts). `runPi` is a thin alias for `runAgent` so every existing
 * call site, fake, and test keeps importing the historical name; the stderr-match constants and
 * the run-kind/backend-failure types stay here for the same reason. The seam itself lives in
 * src/agent/agent-backend.ts, and `hasResumableSession` now lives beside the ledger it reads
 * (src/agent/session-ledger.ts) and is re-exported here so existing importers are unchanged. */

export { runAgent, runPi } from "../agent/run-agent.js";
export type { PiRunOptions } from "../agent/run-agent.js";
export { MODEL_FALLBACK_CLONE, TRANSIENT_PI_CRASH } from "./pi-backend.js";
export type { BackendFailureKind } from "./pi-stream.js";
export type { PiRunKind } from "./pi-event-line.js";
export { hasResumableSession } from "../agent/session-ledger.js";
