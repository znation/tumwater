import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  PRINCIPLES_CONSOLIDATION_LEAD,
  principlesConsolidationPrompt,
  requestPrinciplesConsolidation,
} from "../src/prompt/principles-consolidation.js";
import { PRINCIPLES_MAX_CHARS } from "../src/prompt/principles.js";
import { queuedPrompts } from "../src/inbox/inbox.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";

// The over-cap consolidation request (src/prompt/principles-consolidation.ts): the orchestrator
// hands the director — the role allowed to edit PRINCIPLES.md — a one-shot prompt instead of
// the team surfacing the old standing `principles-truncated` alert. These pin the
// one-assignment-at-a-time gate from the builder's own inputs and the real queue, never by
// running the builder to print its own text.

function overCap(root: string): void {
  fs.writeFileSync(path.join(root, "PRINCIPLES.md"), "x".repeat(PRINCIPLES_MAX_CHARS + 100));
}

test("an over-cap PRINCIPLES.md with a real queue queues exactly one director prompt, and not a second while it is queued", async () => {
  const root = makeRepo();
  overCap(root);
  const first = await requestPrinciplesConsolidation(root);
  assert.equal(first.requested, true, "the first over-cap poll requests the consolidation");
  const queued = queuedPrompts(root);
  assert.equal(queued.length, 1, "exactly one director prompt is enqueued");
  assert.ok(queued[0]!.startsWith(PRINCIPLES_CONSOLIDATION_LEAD), "the queued prompt leads with the marker");
  // One assignment per over-cap episode: a second poll while it is still queued queues nothing.
  const second = await requestPrinciplesConsolidation(root);
  assert.equal(second.requested, false, "a second call while the prompt is queued queues nothing");
  assert.equal(queuedPrompts(root).length, 1, "still exactly one in the queue");
});

test("a busy director and a held director pin each queue nothing", async () => {
  const root = makeRepo();
  overCap(root);
  const busy = await requestPrinciplesConsolidation(root, { directorBusy: true });
  assert.equal(busy.requested, false, "a director already running queues nothing");
  assert.equal(queuedPrompts(root).length, 0);
  const pinned = await requestPrinciplesConsolidation(root, { hasPin: async () => true });
  assert.equal(pinned.requested, false, "a held (unmerged) director pin queues nothing");
  assert.equal(queuedPrompts(root).length, 0);
});

test("an under-cap file and a missing file queue nothing", async () => {
  const under = makeRepo();
  fs.writeFileSync(path.join(under, "PRINCIPLES.md"), "x".repeat(100));
  const underRes = await requestPrinciplesConsolidation(under);
  assert.equal(underRes.requested, false, "a file at or under the cap queues nothing");
  assert.equal(queuedPrompts(under).length, 0);

  const missing = makeRepo(); // no PRINCIPLES.md at all
  const missingRes = await requestPrinciplesConsolidation(missing);
  assert.equal(missingRes.requested, false, "no PRINCIPLES.md queues nothing");
});

test("an enqueue that throws is returned as { requested: false, error } and never propagates", async () => {
  const root = makeRepo();
  overCap(root);
  let result: Awaited<ReturnType<typeof requestPrinciplesConsolidation>>;
  await assert.doesNotReject(
    async () => {
      result = await requestPrinciplesConsolidation(root, {
        submit: () => {
          throw new Error("the inbox is unwritable");
        },
      });
    },
    "a throwing enqueue must be caught, not propagate",
  );
  assert.equal(result!.requested, false, "a throwing enqueue is not a success");
  assert.equal(result!.error, "the inbox is unwritable", "the error is returned");
});

test("the consolidation prompt names the measured state and the consolidation's rules", () => {
  const chars = PRINCIPLES_MAX_CHARS + 250;
  const prompt = principlesConsolidationPrompt(chars);
  assert.ok(prompt.startsWith(PRINCIPLES_CONSOLIDATION_LEAD + "\n"), "the prompt opens with the marker lead");
  assert.ok(prompt.includes(`${chars} characters`), "names the current trimmed character count");
  assert.ok(prompt.includes(`${PRINCIPLES_MAX_CHARS}-character`), "names the prompt cap");
  assert.match(prompt, /Read PRINCIPLES\.md whole/, "tells the director to read the file whole");
  assert.match(prompt, /not the truncated/, "tells it not to trust its own truncated block");
  assert.match(prompt, /Merge overlapping rules/, "merges overlapping rules");
  assert.match(prompt, /delete wording the current code and Budgets have superseded/, "drops superseded wording");
  assert.match(prompt, /Keep every still-active rule/, "keeps every active rule");
  assert.match(prompt, /positive voice/, "keeps the positive voice");
  assert.match(prompt, /Leave the measured Budgets figures/, "keeps the measured Budgets facts");
  assert.match(prompt, /Target at most 3500 characters/, "targets at most 3500 characters");
  assert.match(prompt, /Edit only PRINCIPLES\.md/, "edits only PRINCIPLES.md");
  assert.match(prompt, /Add no PLANS\.md or BUGS\.md entry/, "adds no backlog entry");
});
