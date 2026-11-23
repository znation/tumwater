// The `checkpoint` extension (src/pi-extension/checkpoint.ts): the SelfCompact suppression half
// (a checkpoint is refused while there is nothing worth reclaiming), the measured summary, the
// rubric, and the thin adapter.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECKPOINT_KEEP_RECENT_TOKENS,
  CHECKPOINT_MIN_TOKENS,
  CHECKPOINT_MIN_TURNS,
  CHECKPOINT_RUBRIC,
  buildCheckpointSummary,
  buildCheckpointTool,
  checkpointDecision,
  checkpointFileOps,
  checkpointFloor,
  checkpointKeptEntryId,
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
  const refused = await buildCheckpointTool(fresh, () => 6).execute("t", { done: "x" }, undefined, undefined, {
    getContextUsage: () => ({ tokens: 200_000, contextWindow: 200_000, percent: 100 }),
    compact: () => { throw new Error("must not be called"); },
  });
  assert.match(refused.content[0]!.text, /refused/);
  assert.match(refused.content[0]!.text, /turn/);
  // Turn 3, last checkpoint at turn -3: 6 turns since, context high -> accepted.
  // The accept arm must never call `compact`: pi's compact() aborts the turn that is running the
  // tool call, and that abort is what lost an author run its turn on every accepted checkpoint
  // (BUGS.md 2026-11-19). A throwing `compact` therefore proves the call by failing the test.
  const ready = { lastCheckpointTurn: -3, requested: false, fields: null } as never;
  const accepted = await buildCheckpointTool(ready, () => 3).execute("t", { done: "x" }, undefined, undefined, {
    getContextUsage: () => ({ tokens: 200_000, contextWindow: 200_000, percent: 100 }),
    compact: () => { throw new Error("must not be called"); },
  });
  assert.match(accepted.content[0]!.text, /recorded/);
  assert.match(accepted.content[0]!.text, /done: x/);
  // The wording promises the boundary write, not a compaction already under way: the accept arm
  // starts nothing, so any "is being compacted" claim here would be false.
  assert.match(accepted.content[0]!.text, /will be compacted at the next turn boundary/);
  assert.ok(!accepted.content[0]!.text.includes("being compacted"), "nothing is compacting yet");
});

// A structural fake of pi's extension API: it records the registrations so the adapter's
// behaviour (register the tool, serve only a self-requested compaction) can be tested without pi.
// The `exec` fake returns a fixed status line and no shortstat, so the git block renders through
// the api object the handler reads it from (pi's real handler ctx does not carry `exec`).
// `_cmd` is unused (the handler always calls it with "git") but must occupy the first slot, so
// the `args` array the fake branches on lands in the second; the `_` prefix keeps it out of
// noUnusedParameters.
function fakePi() {
  const handlers: Record<string, (event: Record<string, unknown>, ctx?: Record<string, unknown>) => unknown> = {};
  let tool: unknown;
  return {
    handlers,
    get tool() { return tool; },
    on(event: string, cb: (event: Record<string, unknown>, ctx?: Record<string, unknown>) => unknown) { handlers[event] = cb; },
    registerTool(t: unknown) { tool = t; },
    exec: async (_cmd: string, args: string[]) => ({
      stdout: args[0] === "status" ? " M a.ts" : "",
    }),
  };
}

test("the documented keep-recent target is pi's own 20k-token cut", () => {
  // The checkpoint's boundary draft keeps the same recent range pi's own `findProjectedCutPoint`
  // targets (its `compaction.keepRecentTokens` default, 20000 in pi 1.5.2), so a checkpoint
  // rewrites the older context and leaves the working recent range untouched.
  assert.equal(CHECKPOINT_KEEP_RECENT_TOKENS, 20_000);
});

// A projected entry as the turn-end boundary hands it: the session entry (whose id names the
// kept range) plus the messages that entry contributes to the next prompt.
function projected(id: string | undefined, messages: unknown[]) {
  return { sourceEntry: id === undefined ? { type: "message" } : { id, type: "message" }, messages };
}
/** A user message of `chars` characters: pi's chars/4 estimate makes it chars/4 tokens. */
function userChars(chars: number) {
  return { role: "user", content: "u".repeat(chars) };
}

test("checkpointKeptEntryId cuts where the recent budget is reached, not one entry earlier", () => {
  // Three 1000-token entries; a 2000-token budget is reached AT the middle entry, so the cut
  // keeps the last two. A `>` instead of `>=` in the accumulation test would walk on and cut at
  // e1, keeping all three — the summary would then rewrite nothing.
  const entries = [projected("e1", [userChars(4000)]), projected("e2", [userChars(4000)]), projected("e3", [userChars(4000)])];
  assert.equal(checkpointKeptEntryId(entries, 2000), "e2");
  assert.equal(checkpointKeptEntryId(entries, 500), "e3", "a budget inside the newest entry keeps only it");
  assert.equal(checkpointKeptEntryId(entries, 100_000), "e1", "under budget the cut is the first entry");
});

test("checkpointKeptEntryId never cuts at an entry that cannot start a kept range", () => {
  // A bare tool-result entry first: keeping it first would send pi an orphan tool result, so the
  // cut moves to the first user/assistant entry (e2) whatever the budget.
  const entries = [
    projected("e1", [{ role: "toolResult", content: "output" }]),
    projected("e2", [userChars(4000)]),
    projected("e3", [userChars(4000)]),
  ];
  assert.equal(checkpointKeptEntryId(entries, 100_000), "e2");
  // A budget reached inside the newest entry cuts there: 1000 tokens of it cover 1000.
  assert.equal(checkpointKeptEntryId(entries, 1000), "e3");
});

test("checkpointKeptEntryId names nothing for a context it cannot cut", () => {
  // No usable entry: the caller writes no draft, because pi defaults a missing firstKeptEntryId
  // to the compaction's own id, which would drop everything before the summary.
  assert.equal(checkpointKeptEntryId(undefined, 20_000), null);
  assert.equal(checkpointKeptEntryId([], 20_000), null);
  assert.equal(checkpointKeptEntryId([projected(undefined, [userChars(40)])], 20_000), null, "an id-less entry cannot be named");
  assert.equal(checkpointKeptEntryId([projected("", [userChars(40)])], 20_000), null, "an empty id is no id");
});

test("checkpointFileOps reads the paths the projected read/write/edit calls name", () => {
  const call = (name: string, path: unknown) => ({
    role: "assistant",
    content: [{ type: "toolCall", name, arguments: { path } }],
  });
  const entries = [
    projected("e1", [call("read", "b.ts"), call("read", "a.ts")]),
    projected("e2", [call("edit", "c.ts"), call("write", "d.ts"), call("bash", undefined)]),
  ];
  const ops = checkpointFileOps(entries)!;
  assert.deepEqual([...ops.read].sort(), ["a.ts", "b.ts"]);
  // Distinct paths per tool: swapping the write and edit arms would land d.ts in `edited`.
  assert.deepEqual([...ops.edited], ["c.ts"]);
  assert.deepEqual([...ops.written], ["d.ts"]);
  // A context that is not a list contributes no file block at all (undefined, not empty sets).
  assert.equal(checkpointFileOps(undefined), undefined);
});

test("a requested checkpoint is written as the turn_end boundary draft, once", async () => {
  const fake = fakePi();
  checkpoint(fake as never);
  // An unrequested boundary writes nothing: pi's own threshold/overflow compactions stay pi's.
  const quiet = (await fake.handlers.turn_end!({ context: { contextEntries: [projected("e1", [userChars(40)])] } }, { cwd: "/w" })) as unknown;
  assert.equal(quiet, undefined, "a boundary with no queued checkpoint drafts nothing");
  // Advance the shared turn counter past the 6-turn floor, then accept a checkpoint.
  for (let i = 0; i < 10; i++) await fake.handlers.turn_end!({});
  const tool = fake.tool as {
    execute: (id: string, p: { done: string; state: string; next: string }) => Promise<unknown>;
  };
  await tool.execute("t", { done: "landed the parser", state: "tests green", next: "docs" });
  // The next boundary carries the projection pi would send: one entry with a `read` tool call
  // (so the files block renders from the projection) and a big user entry.
  const readCall = { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }] };
  const entries = [projected("e1", [readCall]), projected("e2", [userChars(40)])];
  const drafted = (await fake.handlers.turn_end!({ context: { contextEntries: entries } }, { cwd: "/w" })) as {
    entries: Array<{
      type: string;
      summary: string;
      firstKeptEntryId: string;
      details: { kind: string; accepted: number; declined: number };
    }>;
  };
  assert.equal(drafted.entries.length, 1, "one boundary draft");
  const draft = drafted.entries[0]!;
  assert.equal(draft.type, "compaction", "pi's appendCompaction is what commits it");
  assert.equal(draft.firstKeptEntryId, "e1", "the cut names the first entry the projection keeps");
  assert.match(draft.summary, /done:\nlanded the parser/, "the model's prose leads the summary");
  assert.match(draft.summary, /next:\ndocs/);
  assert.match(draft.summary, /read: src\/a\.ts/, "the file ops come off the projected context");
  assert.match(draft.summary, /git status/, "the git block rides the api's exec");
  assert.equal(draft.details.kind, "checkpoint");
  assert.equal(draft.details.accepted, 1);
  assert.equal(draft.details.declined, 0);
  // The boundary must not claim a continuation: pi reads `continue` off the handler result, and
  // a checkpoint that asked for one would change the turn's exit. A draft of `entries` only
  // leaves the run alive on the path it was already on, so the tool result and the next
  // assistant message both reach the stream.
  assert.ok(!("continue" in drafted), "the draft never requests continuation");
  // The request is consumed: the boundary after it drafts nothing, so a checkpoint writes one
  // compaction entry, not one per turn.
  const again = (await fake.handlers.turn_end!({ context: { contextEntries: entries } }, { cwd: "/w" })) as unknown;
  assert.equal(again, undefined, "the queued request is cleared after it is written");
});

test("the checkpoint's draft restates the entries a prior boundary handler proposed", async () => {
  // pi's `emitBoundary` chains entries onto the event and lets each handler's `entries` result
  // replace them, so a handler that returns only its own draft drops the earlier handlers' work
  // at that boundary (context-shake registers its `turn_end` handler before checkpoint's).
  const fake = fakePi();
  checkpoint(fake as never);
  for (let i = 0; i < 10; i++) await fake.handlers.turn_end!({});
  const tool = fake.tool as { execute: (id: string, p: { done: string }) => Promise<unknown> };
  await tool.execute("t", { done: "d" });
  const shakeDraft = { type: "context_edit", targetId: "r", replacement: { content: "elided" } };
  const drafted = (await fake.handlers.turn_end!(
    { entries: [shakeDraft], context: { contextEntries: [projected("e1", [userChars(40)])] } },
    { cwd: "/w" },
  )) as { entries: Array<{ type: string }> };
  assert.deepEqual(
    drafted.entries.map((e) => e.type),
    ["context_edit", "compaction"],
    "the earlier handler's draft survives the checkpoint's entry, in proposal order",
  );
});

test("a boundary whose context offers no cut point drafts nothing and keeps the request", async () => {
  const fake = fakePi();
  checkpoint(fake as never);
  for (let i = 0; i < 10; i++) await fake.handlers.turn_end!({});
  const tool = fake.tool as { execute: (id: string, p: { done: string }) => Promise<unknown> };
  await tool.execute("t", { done: "d" });
  // A context with no entry pi could keep (no id): drafting here would let pi default
  // firstKeptEntryId to the compaction's own id and drop everything before the summary.
  const bad = (await fake.handlers.turn_end!({ context: { contextEntries: [projected(undefined, [userChars(40)])] } }, { cwd: "/w" })) as unknown;
  assert.equal(bad, undefined, "no cut point, no draft");
  const noContext = (await fake.handlers.turn_end!({}, { cwd: "/w" })) as unknown;
  assert.equal(noContext, undefined, "a boundary with no context drafts nothing");
  // The request is still queued, so a later boundary that does carry a cut writes it.
  const ok = (await fake.handlers.turn_end!({ context: { contextEntries: [projected("e9", [userChars(40)])] } }, { cwd: "/w" })) as
    | { entries: Array<{ firstKeptEntryId: string }> }
    | undefined;
  assert.equal(ok?.entries[0]?.firstKeptEntryId, "e9", "the queued checkpoint is written at the next usable boundary");
});

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
  // The handler then writes the measured summary into the compaction entry. It must also carry
  // pi's own firstKeptEntryId (and tokensBefore) through to the result pi expects, so the
  // projection keeps the recent turns after compaction instead of dropping everything before the
  // summary (pi defaults a missing firstKeptEntryId to the compaction's own id).
  const prep = {
    fileOps: { read: new Set(["a.ts"]), written: new Set(), edited: new Set() },
    firstKeptEntryId: "kept-42",
    tokensBefore: 90_000,
  };
  const resolved = (await fake.handlers.session_before_compact!({ preparation: prep }, { cwd: "/w" })) as
    | {
        compaction: {
          summary: string;
          firstKeptEntryId: string | null;
          tokensBefore: number;
          details: { kind: string; accepted: number; declined: number };
        };
      }
    | undefined;
  assert.ok(resolved, "a self-requested compaction gets our summary");
  assert.match(resolved.compaction.summary, /done:\nd/);
  assert.match(resolved.compaction.summary, /read: a\.ts/);
  assert.match(resolved.compaction.summary, /git status/, "the git block renders through the api's exec, not the handler ctx");
  assert.equal(resolved.compaction.firstKeptEntryId, "kept-42", "pi's kept-entry id is carried through");
  assert.equal(resolved.compaction.tokensBefore, 90_000, "pi's token count is carried through");
  // The design's audit signal: the entry's details kind and the accepted/declined call counts.
  assert.equal(resolved.compaction.details.kind, "checkpoint");
  assert.equal(resolved.compaction.details.accepted, 1, "one accepted checkpoint call so far");
  assert.equal(resolved.compaction.details.declined, 0, "no declined calls yet");
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
