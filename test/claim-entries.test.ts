/** Tests for src/scheduling/claim-entries.ts — the claim states an operator should act on,
 * shared between the doctor's `parallel instances` row and the always-on amber alert. */
import test from "node:test";
import assert from "node:assert/strict";
import { staleClaimEntries } from "../src/scheduling/claim-entries.js";
import { freshRunnerState, saveRunnerState } from "../src/runner/runner-state.js";
import { makeRepo, writeBacklogFile } from "./fixtures/repo-fixtures.js";

test("staleClaimEntries classifies gone before idle and omits a fresh claim", () => {
  const root = makeRepo();
  writeBacklogFile(root, "PLANS.md", [
    { heading: "## Planned", body: "### Alpha (planned 2026-10-01)\n\nBody." },
    { heading: "## Done" },
  ]);
  writeBacklogFile(root, "BUGS.md", [
    { heading: "## Open", body: "### An open bug" },
    { heading: "## Fixed" },
  ]);
  const now = Date.now();
  // feature-2 holds a key absent from PLANS.md `## Planned` — gone (and older than idle).
  saveRunnerState(root, {
    ...freshRunnerState("feature-2"),
    claim: { file: "PLANS.md", key: "gone", title: "Gone", at: now - 40 * 3_600_000, source: "assigned" },
  });
  // bugfix-2 holds an open bug's key, 25 h old — idle, whole-hour age.
  saveRunnerState(root, {
    ...freshRunnerState("bugfix-2"),
    claim: { file: "BUGS.md", key: "an open bug", title: "An open bug", at: now - 25 * 3_600_000, source: "assigned" },
  });
  // feature-3 holds a listed plan's key, fresh — omitted.
  saveRunnerState(root, {
    ...freshRunnerState("feature-3"),
    claim: { file: "PLANS.md", key: "alpha", title: "Alpha (planned 2026-10-01)", at: now, source: "assigned" },
  });
  assert.deepEqual(staleClaimEntries(root, ["feature-2", "bugfix-2", "feature-3"], now), [
    { id: "feature-2", file: "PLANS.md", title: "Gone", kind: "gone", hours: 0 },
    { id: "bugfix-2", file: "BUGS.md", title: "An open bug", kind: "idle", hours: 25 },
  ]);
});
