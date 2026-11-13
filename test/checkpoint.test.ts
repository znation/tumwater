// The `checkpoint` extension (src/pi-extension/checkpoint.ts): the SelfCompact suppression half
// (a checkpoint is refused while there is nothing worth reclaiming), the measured summary, the
// rubric, and the thin adapter.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECKPOINT_MIN_TOKENS,
  CHECKPOINT_MIN_TURNS,
  CHECKPOINT_RUBRIC,
  buildCheckpointSummary,
  buildCheckpointTool,
  checkpointDecision,
  checkpointFloor,
  default as checkpoint,
  parseShortstat,
} from "../src/pi-extension/checkpoint.js";

test("checkpointFloor is the greater of 32k and 25% of the window", () => {
  assert.equal(checkpointFloor({ tokens: 100, contextWindow: 100_000 }), 32_000, "25% under the minimum");
  assert.equal(checkpointFloor({ tokens: 100, contextWindow: 200_000 }), 50_000, "25% over the minimum");
  assert.equal(checkpointFloor({ tokens: 100, contextWindow: 0 }), 32_000, "no window stays at the minimum");
  assert.equal(checkpointFloor({ tokens: 100 }), 32_000, "missing window stays at the minimum");
  assert.equal(checkpointFloor(undefined), 32_000, "no usage at all stays at the minimum");
});

test("checkpointDecision refuses below the turn floor, then below the token floor, then accepts", () => {
  // Too few turns since the last checkpoint: refused whatever the context is.
  const early = checkpointDecision({ tokens: 200_000, contextWindow: 200_000 }, CHECKPOINT_MIN_TURNS - 1);
  assert.equal(early.accept, false);
  assert.match(early.reason!, /turn/);
  // Enough turns but the context under the floor: nothing worth reclaiming.
  const low = checkpointDecision({ tokens: 10_000, contextWindow: 100_000 }, 10);
  assert.equal(low.accept, false);
  assert.match(low.reason!, /floor/);
  // Enough turns and the context at or above the floor: accepted.
  const ready = checkpointDecision({ tokens: 60_000, contextWindow: 100_000 }, 10);
  assert.equal(ready.accept, true);
  assert.equal(ready.reason, undefined);
  // An unknown token count never refuses on the floor: the turn rule alone decides.
  const unknown = checkpointDecision({ contextWindow: 100_000 }, 10);
  assert.equal(unknown.accept, true, "a missing token count is not a reason to refuse");
});

test("the documented constants are the 6-turn floor and the 32k token floor", () => {
  assert.equal(CHECKPOINT_MIN_TURNS, 6);
  assert.equal(CHECKPOINT_MIN_TOKENS, 32_000);
});

test("parseShortstat reads insertions and deletions, insertions-only, or nothing", () => {
  assert.deepEqual(parseShortstat("2 files changed, 42 insertions(+), 3 deletions(-)"), { insertions: 42, deletions: 3 });
  assert.deepEqual(parseShortstat("1 file changed, 7 insertions(+)"), { insertions: 7, deletions: 0 });
  assert.equal(parseShortstat(""), null);
  assert.equal(parseShortstat(null), null);
  assert.equal(parseShortstat("nothing to report"), null);
});

test("buildCheckpointSummary carries the model's prose, the file ops, and the measured git, dropping what is absent", () => {
  const fields = { done: "split the parser", state: "tests pass", next: "wire it up" };
  const fo = { read: new Set(["b.ts", "a.ts"]), written: new Set(["x.ts"]), edited: new Set(["y.ts"]) };
  const s = buildCheckpointSummary(fields, fo, " M src/a.ts\n M src/b.ts", { insertions: 42, deletions: 3 });
  assert.match(s!, /done:\nsplit the parser/);
  assert.match(s!, /state:\ntests pass/);
  assert.match(s!, /next:\nwire it up/);
  // The file lists are one path per line (read and modified dedupe and sort, so a.ts<b.ts,
  // x.ts<y.ts): the read block leads its first path on the `read:` line, the rest one each.
  assert.match(s!, /read: a\.ts\nb\.ts/);
  assert.match(s!, /modified: x\.ts\ny\.ts/);
  assert.match(s!, /git status/);
  assert.match(s!, /git diff/);
  assert.match(s!, /\+42\/-3/);
  // No "… more line(s) omitted" remainder at this small size (well under the files cap).
  assert.ok(!s!.includes("more line(s) omitted"));
});

test("buildCheckpointSummary caps the files list so a many-file run cannot flood it", () => {
  // 40 read paths: the files block is one line per path, so it overruns the line cap and the
  // tail is dropped with a visible remainder rather than riding into the summary as one long
  // unbounded line (the guard the module's doc comment promises). 40 paths is 40 lines
  // (the first rides the `read:` line), so the last 10 beyond the 30-line cap are dropped.
  const fo = {
    read: new Set(Array.from({ length: 40 }, (_, i) => `p${i}.ts`)),
    written: new Set<string>(),
    edited: new Set<string>(),
  };
  const s = buildCheckpointSummary({ done: "touched many files" }, fo, null, null)!;
  assert.match(s!, /read: p0\.ts/);
  // The tail is dropped: the last path is gone, and a named remainder says how much was cut.
  assert.ok(!s!.includes("p39.ts"), "the paths beyond the cap are dropped");
  assert.match(s!, /… 10 more line\(s\) omitted/);
});

test("buildCheckpointSummary omits an empty file list rather than a bare label", () => {
  // read empty, one written file: only the non-empty list renders — no `read:` line with no paths.
  const fo = { read: new Set<string>(), written: new Set(["x.ts"]), edited: new Set<string>() };
  const s = buildCheckpointSummary({ done: "d" }, fo, null, null)!;
  assert.match(s!, /modified: x\.ts/);
  assert.ok(!s!.includes("read:"), "an empty read list renders no line");
});

test("buildCheckpointSummary omits a measured line when its source is absent rather than guessing", () => {
  const s = buildCheckpointSummary({ done: "done" }, undefined, null, null);
  assert.match(s!, /done:\ndone/);
  assert.ok(!s!.includes("files"), "no file ops, no file block");
  assert.ok(!s!.includes("git status"), "no status read, no status block");
  assert.ok(!s!.includes("git diff"), "no diff read, no diff block");
});

test("buildCheckpointSummary is null when there is nothing at all to say", () => {
  assert.equal(buildCheckpointSummary({}, undefined, null, null), null);
});

test("the tool description is the rubric, word for word", () => {
  const tool = buildCheckpointTool(
    { lastCheckpointTurn: -1, requested: false, fields: null } as never,
    () => 0,
  );
  assert.equal(tool.description, CHECKPOINT_RUBRIC);
  assert.match(tool.description, /right after you finish a step/);
  assert.match(tool.description, /could continue from it alone/);
});

test("the tool refuses a too-fresh call and says why, and accepts a ready one", async () => {
  // Turn 6, last checkpoint at turn 5: only 1 turn since the last one -> refused on the turn floor.
  const fresh = { lastCheckpointTurn: 5, requested: false, fields: null } as never;
  let compacted = false;
  const refused = await buildCheckpointTool(fresh, () => 6).execute("t", { done: "x" }, undefined, undefined, {
    getContextUsage: () => ({ tokens: 200_000, contextWindow: 200_000, percent: 100 }),
    compact: () => { compacted = true; },
  });
  assert.match(refused.content[0]!.text, /refused/);
  assert.match(refused.content[0]!.text, /turn/);
  assert.equal(compacted, false, "a refused call never compacts");
  // Turn 3, last checkpoint at turn -3: 6 turns since, context high -> accepted and compacts.
  const ready = { lastCheckpointTurn: -3, requested: false, fields: null } as never;
  const accepted = await buildCheckpointTool(ready, () => 3).execute("t", { done: "x" }, undefined, undefined, {
    getContextUsage: () => ({ tokens: 200_000, contextWindow: 200_000, percent: 100 }),
    compact: () => { compacted = true; },
  });
  assert.match(accepted.content[0]!.text, /recorded/);
  assert.match(accepted.content[0]!.text, /done: x/);
  assert.equal(compacted, true, "an accepted call triggers pi's compaction");
});

// A structural fake of pi's extension API: it records the registrations so the adapter's
// behaviour (register the tool, serve only a self-requested compaction) can be tested without pi.
function fakePi() {
  const handlers: Record<string, (event: Record<string, unknown>, ctx?: Record<string, unknown>) => unknown> = {};
  let tool: unknown;
  return {
    handlers,
    get tool() { return tool; },
    on(event: string, cb: (event: Record<string, unknown>, ctx?: Record<string, unknown>) => unknown) { handlers[event] = cb; },
    registerTool(t: unknown) { tool = t; },
    exec: async () => ({ stdout: "" }),
  };
}

test("the adapter registers the tool and serves only a compaction the run requested", async () => {
  const fake = fakePi();
  checkpoint(fake as never);
  assert.equal((fake.tool as { name: string }).name, "checkpoint");
  // A pi-triggered compaction (the run did not request one) is left to pi: the handler
  // resolves to no summary of our own.
  const notOurs = (await fake.handlers.session_before_compact!({}, {})) as unknown;
  assert.equal(notOurs, undefined, "an unrequested compaction gets no summary from us");
  // Advance the turn counter past the 6-turn floor, then checkpoint with a high context.
  for (let i = 0; i < 10; i++) fake.handlers.turn_end!({ turnIndex: i });
  const tool = fake.tool as {
    execute: (id: string, p: { done: string; state: string; next: string }) => Promise<{ content: Array<{ text: string }> }>;
  };
  const accepted = await tool.execute("t", { done: "d", state: "s", next: "n" });
  assert.match(accepted.content[0]!.text, /recorded/, "the tool accepted and queued the compaction");
  // The handler then writes the measured summary into the compaction entry.
  const prep = { fileOps: { read: new Set(["a.ts"]), written: new Set(), edited: new Set() } };
  const resolved = (await fake.handlers.session_before_compact!({ preparation: prep }, { cwd: "/w" })) as
    | { compaction: { summary: string } }
    | undefined;
  assert.ok(resolved, "a self-requested compaction gets our summary");
  assert.match(resolved.compaction.summary, /done:\nd/);
  assert.match(resolved.compaction.summary, /read: a\.ts/);
});

test("the adapter never throws into pi when the context offers nothing", () => {
  const fake = fakePi();
  assert.doesNotThrow(() => checkpoint(fake as never));
  assert.equal((fake.tool as { name: string }).name, "checkpoint");
});

// A fake pi whose register call throws for one event: the adapter must absorb the throw and
// degrade (the "never throws into pi" contract) rather than let it escape into pi.
function throwingPi(throwOn: string) {
  return {
    handlers: {} as Record<string, unknown>,
    tool: undefined as unknown,
    on(event: string, _cb: unknown) {
      if (event === throwOn) throw new Error("boom");
    },
    registerTool(t: { name: string }) {
      this.tool = t;
    },
  };
}

test("the adapter absorbs a throwing register of the turn_end handler and degrades to nothing", () => {
  const fake = throwingPi("turn_end");
  // The first register throws, so the adapter's first catch returns before registering the tool
  // and before the compaction handler: it must not throw into pi, and it registers nothing.
  assert.doesNotThrow(() => checkpoint(fake as never));
  assert.equal(fake.tool, undefined, "a failed turn_end register registers no tool and no handler");
});

test("the adapter absorbs a throwing register of the compaction handler and keeps the tool alone", () => {
  const fake = throwingPi("session_before_compact");
  // The turn_end register succeeds (the tool is registered); only the compaction handler's
  // register throws, so the second catch swallows it and the tool still stands.
  assert.doesNotThrow(() => checkpoint(fake as never));
  assert.equal((fake.tool as { name: string }).name, "checkpoint", "the tool is registered before the throwing handler");
});

test("the adapter's turn counter drives the tool and its handler writes the summary for a self-requested compaction", async () => {
  const fake = fakePi();
  checkpoint(fake as never);
  const tool = fake.tool as {
    execute: (id: string, p: { done: string }) => Promise<{ content: Array<{ text: string }> }>;
  };
  // Drive the shared turn counter through the registered turn_end handler, the way pi does at
  // each step boundary, so the tool's `currentTurn()` closure reads the advanced value.
  for (let i = 0; i < 10; i++) fake.handlers.turn_end!({ turnIndex: i });
  // A ready call (10 turns since the last checkpoint, context above the floor) is accepted and
  // queues the compaction the run asked for.
  const accepted = await tool.execute("t", { done: "stepped" }) as { content: Array<{ text: string }> };
  assert.match(accepted.content[0]!.text, /recorded/);
  // The session_before_compact handler then writes the measured summary for that request.
  const resolved = (await fake.handlers.session_before_compact!({ preparation: undefined }, { cwd: "/w" })) as
    | { compaction: { summary: string } }
    | undefined;
  assert.ok(resolved, "the self-requested compaction resolves to our summary");
  assert.match(resolved.compaction.summary, /done:\nstepped/);
});
