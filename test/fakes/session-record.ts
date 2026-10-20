/** A complete session-ledger record with overrides, for the tests that write or prune ledgers. */
import type { SessionRecord } from "../../src/agent/session-ledger.js";

export function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    agent: "pi",
    id: "id",
    kind: "author",
    name: "tumwater-feature-1",
    cwd: "/wt",
    at: Date.now(),
    ...overrides,
  };
}
