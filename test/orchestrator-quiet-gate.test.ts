/** The live-orchestrator e2e drain tests gate on `awaitQuietHost` before touching the live
 * host: a load-sensitive drain (a handful of git spawns each stretched by a shared host's
 * 100 ms poll cycle) must defer on a loaded host rather than reddening a verdict the code
 * never broke. The e2e file itself runs in the e2e tier (`test:*.e2e.test.ts`), excluded from
 * the gating `npm test` tier, so the gate's presence is pinned here in the gating tier by
 * reading the e2e source — the same way docs/invariants.md's INV-F1 pins that e2e sources own
 * the live host. Regression for BUGS.md 2026-11-15 (the pin-drain test flaked on a loaded host
 * until it adopted the gate its sibling drain tests already carry). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// The compiled test sits in dist/test/ (no .ts sources are emitted there), so the e2e source
// is read from the repo root — the same resolution invariants-doc.test.ts uses for
// docs/invariants.md.
const E2E = fileURLToPath(new URL("../../test/orchestrator-3.e2e.test.ts", import.meta.url));

/** The span of a test: from its `test(` line to the next top-level `test(`/end of file. */
function testSpan(source: string, title: string): string {
  const start = source.indexOf(`test("${title}"`);
  assert.notEqual(start, -1, `orchestrator-3.e2e.test.ts still declares ${title}`);
  const next = source.indexOf(`test("`, start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("the pin-drain e2e test gates on awaitQuietHost before it runs", () => {
  const span = testSpan(fs.readFileSync(E2E, "utf8"), "a pin surviving a restart drains through the gate on next start");
  assert.ok(
    span.includes("awaitQuietHost()"),
    "the pin-drain test must sample the host load before it drains",
  );
  assert.ok(
    span.includes("t.skip(`host load") && span.includes("e2e deferred, not a verdict"),
    "a loaded host must defer the pin-drain test, not run it starved",
  );
  // The gate must come before the drain actually starts: a gate placed after
  // startLiveOrchestrator would already have admitted the test and starved it.
  const gate = span.indexOf("awaitQuietHost()");
  const orchestrator = span.indexOf("startLiveOrchestrator(");
  assert.ok(gate !== -1 && (orchestrator === -1 || gate < orchestrator),
    "the quiet-host gate must precede the live orchestrator it guards");
});

test("the stale-marker drain test keeps its quiet-host gate", () => {
  const span = testSpan(fs.readFileSync(E2E, "utf8"), "a stale marker beside a stale pin is dropped at the drain without a merge run");
  assert.ok(span.includes("awaitQuietHost()"), "the sibling stale-marker drain test must keep its gate");
  assert.ok(span.includes("t.skip(`host load"), "a loaded host must defer the stale-marker drain test");
});
