// The `checkpoint` tool and the two compaction handlers that together let a pi run compact its
// own context at a step boundary it chooses (Run checkpoints, part 2/2;
// plans/run-checkpoints.md "Part 2: the `checkpoint` tool and its rubric"). A long run can
// cross the same 256k window several times, so
// pi's own compaction at the fixed thresholds runs out for it (part 1/2 kept the prompt verbatim
// across each compaction; this adds the run's own choice of *when* to compact, at a step
// boundary rather than mid-exploration).
//
// The accepted checkpoint writes its compaction entry itself, as a `turn_end` boundary draft:
// pi's `compact()` aborts the turn still running the tool call and print mode exits once that
// aborted turn settles, so the compaction it starts never reaches its end and the run loses its
// turn for nothing (BUGS.md 2026-11-19). A boundary draft is the first-class way to append one:
// `emitBoundary` reads `entries` off the handler result, `appendCompaction` commits the entry,
// and the projection retains the range from its `firstKeptEntryId`.
//
// The self-suppression half borrows the idea from Self-Compacting Language Model Agents
// (the plan's sources): a weak model would otherwise compact every few turns and throw away a
// warm cache, so the tool refuses a checkpoint while there is nothing worth reclaiming. The
// compaction entry's summary is written by the extension, not the model — no extra LLM call —
// from the model's own done/state/next prose plus the file ops and a capped git reading of the
// worktree.
//
// pi loads the bundled extensions, so the real pi types stay out of the dependency tree: the
// adapter casts to its structural types, the pure helpers take them, and the tool's parameter
// schema is a plain JSON-Schema object (the shape TypeBox serializes to) rather than a typebox
// import, so this module builds in a worktree with no node_modules. pi reads the object for the
// provider schema and validates a call against it (a plain object round-trips both).

interface CheckpointParams { done?: string; state?: string; next?: string }

/** A context-usage reading, the fields the floor reads. */
interface Usage { tokens?: number; contextWindow?: number; percent?: number }

/** The file ops of the summarised range (the sets pi's `preparation.fileOps` carries). */
interface FileOps { read: Set<string>; written: Set<string>; edited: Set<string> }

/** A parsed `git diff --shortstat` reading, or null when the output is absent or malformed. */
type DiffStat = { insertions: number; deletions: number } | null;

/** The `session_before_compact` preparation: the file ops of the summarised range and the id
 * of the first entry the compaction keeps (kept by pi; the summary does not change it).
 * `tokensBefore` is the context size pi reads off the entry's result. */
interface BeforeCompactPreparation {
  fileOps?: FileOps;
  firstKeptEntryId?: string | null;
  tokensBefore?: number;
}

/** The extension's per-process state. `lastCheckpointTurn` is the turn index the last accepted
 * checkpoint recorded at, `fields` the model's prose the summary reuses, and `accepted`/`declined`
 * the call counts the compaction entry records in its `details` for the audit. */
interface CheckpointState {
  lastCheckpointTurn: number;
  requested: boolean;
  fields: CheckpointParams | null;
  accepted: number;
  declined: number;
}

// The suppression floor, in tokens: below the greater of 32k or 25% of the window there is
// nothing worth reclaiming, and compacting would only throw away a warm cache.
export const CHECKPOINT_MIN_TOKENS = 32_000;
const CHECKPOINT_WINDOW_FRACTION = 0.25;

// A checkpoint is refused while fewer turns have passed since the last one, so a weak model
// cannot compact every few turns.
export const CHECKPOINT_MIN_TURNS = 6;

// How much recent context a checkpoint's compaction entry keeps: the same target pi's own
// cut point aims at (its `compaction.keepRecentTokens` default), so a checkpoint rewrites the
// older context into the summary and leaves the working recent range untouched.
export const CHECKPOINT_KEEP_RECENT_TOKENS = 20_000;

// The git block is capped so a busy worktree cannot flood the summary; the whole block stays
// at or under this many lines.
const GIT_LINE_CAP = 40;
// The files block lists one path per line, so a run that touched many files can still flood
// it; each block is capped to this many lines, with block's "… N more line(s) omitted"
// remainder naming the drop — the same flood guard the git block uses, sized for a step that
// touched a handful of files rather than a worktree-wide status.
const FILES_LINE_CAP = 30;

/** The token floor below which a checkpoint is refused: the greater of `CHECKPOINT_MIN_TOKENS`
 * and `CHECKPOINT_WINDOW_FRACTION` of the window. An unknown window leaves the floor at the
 * constant minimum rather than refusing. */
export function checkpointFloor(usage: Usage | undefined): number {
  const window =
    typeof usage?.contextWindow === "number" && usage.contextWindow > 0
      ? usage.contextWindow
      : 0;
  return Math.max(CHECKPOINT_MIN_TOKENS, window * CHECKPOINT_WINDOW_FRACTION);
}

/** The when-to-call decision, the SelfCompact suppression half, named: a checkpoint is
 * accepted only when the context is at or above the floor *and* at least `CHECKPOINT_MIN_TURNS`
 * turns have passed since the last one. Below either line the run is too fresh, and compacting
 * would only throw away a warm cache. */
export function checkpointDecision(
  usage: Usage | undefined,
  turnsSinceCheckpoint: number,
): { accept: boolean; reason?: string } {
  if (turnsSinceCheckpoint < CHECKPOINT_MIN_TURNS) {
    return {
      accept: false,
      reason: `only ${turnsSinceCheckpoint} turn(s) since the last checkpoint (needs ${CHECKPOINT_MIN_TURNS}); keep going`,
    };
  }
  const tokens = usage?.tokens;
  const floor = checkpointFloor(usage);
  if (typeof tokens === "number" && tokens < floor) {
    return {
      accept: false,
      reason: `context is under the ${Math.round(floor / 1000)}k-token floor; nothing worth reclaiming`,
    };
  }
  return { accept: true };
}

/** One block of the summary: its header line plus its body, trimmed to a line cap so a large
 * worktree cannot flood the compaction entry. An empty body yields no block. */
function block(header: string, body: string, lineCap: number): string {
  const lines = body.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "";
  const shown = lines.slice(0, lineCap);
  const omitted = lines.length - shown.length;
  return `${header}:\n${shown.join("\n")}${omitted > 0 ? `\n… ${omitted} more line(s) omitted` : ""}`;
}

/** The files block's one category as lines: a `label: <path>` on the first line, one path per
 * line after, or the empty string for an empty list (which the caller drops, and block would
 * render as no block). One path per line is what makes block's line cap bind the list, so a run
 * that touched many files overruns the cap and block's remainder names the drop instead of one
 * unbounded joined line. */
function fileOpList(label: string, paths: string[]): string {
  return paths.length > 0 ? `${label}: ${paths.join("\n")}` : "";
}

/** The compaction entry's summary: the model's three fields word for word, the read and
 * modified file lists (one path per line, each capped to a handful, a "… N more" remainder when
 * it overruns) from the file ops, and a capped `git status`/`git diff --shortstat` of the
 * worktree. Every measured line is dropped rather than guessed when its source is absent, so
 * the summary never lies. */
export function buildCheckpointSummary(
  fields: CheckpointParams,
  fileOps: FileOps | undefined,
  gitStatus: string | null,
  diffStat: DiffStat,
): string | null {
  const parts: string[] = [];
  if (fields.done) parts.push(block("done", fields.done, 12));
  if (fields.state) parts.push(block("state", fields.state, 12));
  if (fields.next) parts.push(block("next", fields.next, 12));
  if (fileOps) {
    const files = block(
      "files",
      [
        fileOpList("read", [...fileOps.read].sort()),
        fileOpList("modified", [...new Set([...fileOps.written, ...fileOps.edited])].sort()),
      ]
        .filter((l) => l !== "")
        .join("\n"),
      FILES_LINE_CAP,
    );
    if (files) parts.push(files);
  }
  if (gitStatus) parts.push(block("git status", gitStatus, GIT_LINE_CAP));
  if (diffStat) parts.push(block("git diff", `+${diffStat.insertions}/-${diffStat.deletions}`, 4));
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/** Parse a `git diff --shortstat` line, or null when the output is absent or malformed. */
export function parseShortstat(text: string | null | undefined): DiffStat {
  if (!text) return null;
  // `git diff --shortstat` renders "N insertions(+), M deletions(-)" (either count optional),
  // so read the two counts independently rather than assuming they sit on one phrase.
  const insertions = /(\d+) insertion[s]?/.exec(text);
  const deletions = /(\d+) deletion[s]?/.exec(text);
  if (!insertions && !deletions) return null;
  return { insertions: insertions ? Number(insertions[1]) : 0, deletions: deletions ? Number(deletions[1]) : 0 };
}

/** The rubric, word for word, in both places the design puts it: the tool's description and
 * one rule in pi's prompt dialect (src/prompt/dialect.ts). Only pi runs see it. */
export const CHECKPOINT_RUBRIC = `Call \`checkpoint\` right after you finish a step: when your exploration has settled what to change, after a set of edits passes its targeted tests, or before you move to an unrelated part of the task. Never call it in the middle of an edit, while diagnosing a failure, or when stuck: a summary written then loses what you need. Write it so you could continue from it alone.`;

interface CompactCtx {
  cwd?: string;
  /** pi's own compaction request. Declared so a test can hand the tool a throwing one and pin
   * that it is never called: `compact()` aborts the turn that is running the tool call, which
   * is exactly what lost an author run its turn on every accepted checkpoint (BUGS.md
   * 2026-11-19). The compaction now rides the `turn_end` boundary draft instead. */
  compact?: (options?: { customInstructions?: string }) => void;
  getContextUsage?: () => Usage | undefined;
  exec?: (command: string, args: string[], options?: { cwd?: string }) => Promise<{ stdout: string }>;
}

/** One projected entry of the boundary context pi hands a `turn_end` handler: the session entry
 * (whose `id` the kept range names) plus the messages that entry contributes to the next
 * prompt. Structural, like every pi shape in this module. */
interface ProjectedEntry {
  sourceEntry?: { id?: unknown; type?: unknown };
  messages?: unknown;
}

interface ToolLike {
  name: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: CheckpointParams,
    _signal: unknown,
    _onUpdate: unknown,
    ctx: CompactCtx,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

// A plain JSON-Schema object, the shape pi's tool validation compiles; a plain object round-
// trips both the provider schema and the argument parse, so no typebox import is needed.
const CHECKPOINT_PARAMS = {
  type: "object",
  properties: {
    done: { type: "string" },
    state: { type: "string" },
    next: { type: "string" },
  },
  required: ["done"],
  additionalProperties: false,
} as const;

/** One message's character count, pi's own heuristic: text and thinking blocks count their
 * characters, a tool call its name plus its serialized arguments, and an image a fixed
 * stand-in count. Unknown shapes contribute nothing rather than throwing. */
const ESTIMATED_IMAGE_CHARS = 4800;
function messageChars(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
    else if (block.type === "thinking" && typeof block.thinking === "string") chars += block.thinking.length;
    else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
    else if (block.type === "toolCall") {
      if (typeof block.name === "string") chars += block.name.length;
      try {
        chars += JSON.stringify(block.arguments ?? {}).length;
      } catch {
        // A cyclic argument object is not something pi sends; the count is an estimate.
      }
    }
  }
  return chars;
}

/** One projected entry's estimated tokens, pi's chars/4 heuristic per message (pi's own
 * `estimateTokens` counts the same fields and rounds the same way). */
function estimateEntryTokens(entry: unknown): number {
  const messages = (entry as ProjectedEntry | undefined)?.messages;
  if (!Array.isArray(messages)) return 0;
  let tokens = 0;
  for (const message of messages) tokens += Math.ceil(messageChars(message) / 4);
  return tokens;
}

/** Whether an entry can start the kept range: it carries a user- or assistant-role message.
 * A bare tool-result entry never can — keeping one first would send pi an orphan tool result. */
function isCutPointEntry(entry: unknown): boolean {
  const messages = (entry as ProjectedEntry | undefined)?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (m) => (m as { role?: unknown })?.role === "user" || (m as { role?: unknown })?.role === "assistant",
  );
}

/** The id of the entry a checkpoint's compaction keeps from: walk the projected entries
 * backward accumulating estimated tokens until `keepRecentTokens` is reached, then cut at the
 * first entry at or after that point that may start a kept range. Under the budget the cut
 * lands on the first such entry, so the checkpoint rewrites nothing it did not have to. The id
 * must name a real entry — pi defaults a missing `firstKeptEntryId` to the compaction's own id,
 * which would keep nothing before the summary — so a cut that names nothing returns null and the
 * caller writes no draft. Exported for the tests. */
export function checkpointKeptEntryId(entries: unknown, keepRecentTokens: number): string | null {
  if (!Array.isArray(entries)) return null;
  const cutPoints: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (isCutPointEntry(entries[i])) cutPoints.push(i);
  }
  if (cutPoints.length === 0) return null;
  let cutIndex = cutPoints[0]!;
  let accumulated = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    accumulated += estimateEntryTokens(entries[i]);
    if (accumulated >= keepRecentTokens) {
      cutIndex = cutPoints.find((c) => c >= i) ?? cutPoints[cutPoints.length - 1]!;
      break;
    }
  }
  const id = (entries[cutIndex] as ProjectedEntry | undefined)?.sourceEntry?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The file ops of a checkpoint's summarised range: at a turn boundary that range is the whole
 * projected context (pi's own `preparation.fileOps` covers only the range it would summarize,
 * and the checkpoint path never reaches that preparation), so read the paths the projected
 * read/write/edit tool calls name. Returns undefined for a context that is not a list, so the
 * summary renders no files block rather than an empty one. Exported for the tests. */
export function checkpointFileOps(entries: unknown): FileOps | undefined {
  if (!Array.isArray(entries)) return undefined;
  const read = new Set<string>();
  const written = new Set<string>();
  const edited = new Set<string>();
  for (const entry of entries) {
    const messages = (entry as ProjectedEntry | undefined)?.messages;
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      const content = (message as { content?: unknown })?.content;
      if (!Array.isArray(content)) continue;
      for (const raw of content) {
        if (!raw || typeof raw !== "object") continue;
        const block = raw as { type?: unknown; name?: unknown; arguments?: unknown };
        if (block.type !== "toolCall" || typeof block.name !== "string") continue;
        const args = block.arguments as { path?: unknown } | undefined;
        if (!args || typeof args.path !== "string" || args.path.length === 0) continue;
        if (block.name === "read") read.add(args.path);
        else if (block.name === "write") written.add(args.path);
        else if (block.name === "edit") edited.add(args.path);
      }
    }
  }
  return { read, written, edited };
}

/** Run a git command, returning its stdout, or null when the spawn fails — a failed read
 * degrades to an omitted summary line rather than an error. At most two of these per compaction
 * (the design's budget). */
async function gitReading(
  exec: CompactCtx["exec"],
  args: string[],
  cwd: string,
): Promise<string | null> {
  if (!exec) return null;
  try {
    const r = await exec("git", args, { cwd });
    return r?.stdout ?? "";
  } catch {
    return null;
  }
}

/** Build the `checkpoint` tool from the shared state. Exported for the tests; the
 * default-export adapter wires it to pi. */
export function buildCheckpointTool(
  state: CheckpointState,
  currentTurn: () => number,
): ToolLike {
  return {
    name: "checkpoint",
    description: CHECKPOINT_RUBRIC,
    parameters: CHECKPOINT_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const decision = checkpointDecision(
        ctx?.getContextUsage?.(),
        currentTurn() - state.lastCheckpointTurn,
      );
      if (!decision.accept) {
        state.declined += 1;
        return {
          content: [{ type: "text", text: `checkpoint refused: ${decision.reason}. Continue the step.` }],
        };
      }
      state.lastCheckpointTurn = currentTurn();
      state.requested = true;
      state.fields = params;
      state.accepted += 1;
      // No `ctx.compact()` here, on purpose: pi's `compact()` aborts the turn still running this
      // tool call, waits for the run to go idle behind that abort, and print mode exits once the
      // aborted turn settles — so the compaction it starts never reaches its end and the run
      // loses its turn for nothing (BUGS.md 2026-11-19). The compaction entry itself is written
      // by the `turn_end` boundary handler below, at the next turn boundary, with the run alive.
      const echoed = [
        params.done ? `done: ${params.done}` : "",
        params.state ? `state: ${params.state}` : "",
        params.next ? `next: ${params.next}` : "",
      ]
        .filter((l) => l.length > 0)
        .join("\n");
      const text = `Checkpoint recorded; the context will be compacted at the next turn boundary.${
        echoed ? `\n${echoed}` : ""
      }`;
      return { content: [{ type: "text", text }] };
    },
  };
}

/** The bundled extension: register the `checkpoint` tool and the two compaction handlers over
 * one shared state. The `turn_end` handler writes the accepted checkpoint's compaction entry
 * itself, as a boundary draft, at the next turn boundary; the `session_before_compact` handler
 * stays as the guard that writes a summary only for a compaction this extension requested —
 * pi's own threshold/overflow compactions are left to pi. Never throws into pi: every handler
 * body is guarded, and a context with no compaction support at all (a non-session pi) degrades
 * to the tool alone. */
export default function (
  pi: {
    registerTool(tool: ToolLike): void;
    // pi's extension API object carries `exec` (the handler's per-event ctx does not), so the
    // git reads ride the API object captured here, not the per-event ctx.
    exec?: CompactCtx["exec"];
    on(
      event: "turn_end" | "session_before_compact",
      handler: (
        event: {
          turnIndex?: number;
          preparation?: BeforeCompactPreparation;
          /** Boundary events only: the draft entries the handlers before this one proposed at
           * the same boundary (pi's `emitBoundary` chains them onto the event). */
          entries?: unknown;
          context?: { contextEntries?: unknown };
        },
        ctx?: CompactCtx,
      ) => object | Promise<object> | undefined,
    ): void;
  },
): void {
  const state: CheckpointState = {
    lastCheckpointTurn: -1,
    requested: false,
    fields: null,
    accepted: 0,
    declined: 0,
  };
  let turn = -1;
  try {
    // The turn counter and the checkpoint's compaction draft share one `turn_end` handler: pi's
    // boundary contract reads `entries` off the result (`extensions/runner.js` `emitBoundary`)
    // and appends them through `appendCompaction`, so the run stays alive and pi fills
    // `tokensBefore` and `usage` itself off the draft's projection. Returning no `continue` is
    // deliberate: the only turn-end exit pi sees is the one the run would have chosen anyway.
    pi.on("turn_end", async (event, ctx) => {
      turn += 1;
      try {
        if (!state.requested || !state.fields) return undefined;
        const entries = event.context?.contextEntries;
        // pi defaults a missing firstKeptEntryId to the compaction's own id, which would drop
        // everything before the summary, so a cut that names no entry writes no draft: the
        // request stays queued for a boundary that carries a context.
        const firstKeptEntryId = checkpointKeptEntryId(entries, CHECKPOINT_KEEP_RECENT_TOKENS);
        if (firstKeptEntryId === null) return undefined;
        // pi's boundary contract (`extensions/runner.js` `emitBoundary`): a handler sees the
        // entries the handlers before it proposed in `event.entries`, and its own `entries`
        // result *replaces* that field — so the draft must restate them. Returning only the
        // compaction entry would drop the earlier handler's work at this boundary: context-shake
        // registers its `turn_end` handler before this one (its name leads the load order in
        // src/pi/pi-args.ts), and a checkpoint at the same boundary would silently discard the
        // `context_edit` entries it proposed.
        const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
        // Two git spawns at most (the design's budget): the worktree's status and diff-stat.
        const gitStatus = await gitReading(pi.exec, ["status", "--short"], cwd);
        const diffStat = parseShortstat(await gitReading(pi.exec, ["diff", "--shortstat"], cwd));
        // At a turn boundary the checkpoint's summarised range is the whole projected context,
        // so the file ops come off the projection, not pi's `preparation.fileOps`.
        const summary = buildCheckpointSummary(
          state.fields,
          checkpointFileOps(entries),
          gitStatus,
          diffStat,
        );
        state.requested = false;
        state.fields = null;
        // `details` records the call counts the design's audit and A/B read off the entry.
        const proposed: unknown[] = Array.isArray(event.entries) ? event.entries : [];
        return {
          entries: [
            ...proposed,
            {
              type: "compaction",
              summary: summary ?? "",
              firstKeptEntryId,
              details: { kind: "checkpoint", accepted: state.accepted, declined: state.declined },
            },
          ],
        };
      } catch {
        return undefined;
      }
    });
    pi.registerTool(buildCheckpointTool(state, () => turn));
  } catch {
    return;
  }
  try {
    pi.on("session_before_compact", async (event, ctx) => {
      try {
        if (!state.requested || !state.fields) return undefined;
        const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
        // Two git spawns at most (the design's budget): the worktree's status and diff-stat.
        // `exec` rides the captured API object: pi's handler ctx does not carry it, so a
        // `ctx?.exec` read would always be undefined and the git block would never render.
        const gitStatus = await gitReading(pi.exec, ["status", "--short"], cwd);
        const diffStat = parseShortstat(await gitReading(pi.exec, ["diff", "--shortstat"], cwd));
        const summary = buildCheckpointSummary(state.fields, event.preparation?.fileOps, gitStatus, diffStat);
        state.requested = false;
        state.fields = null;
        // pi's compact() reads firstKeptEntryId/tokensBefore off the extension result and
        // defaults a missing firstKeptEntryId to the compaction's own id, which would make the
        // projection keep nothing before the summary — so carry pi's own values through.
        // `details` records the call counts the design's audit and A/B read off the entry.
        return {
          compaction: {
            summary: summary ?? "",
            firstKeptEntryId: event.preparation?.firstKeptEntryId ?? null,
            tokensBefore: event.preparation?.tokensBefore ?? 0,
            details: { kind: "checkpoint", accepted: state.accepted, declined: state.declined },
          },
        };
      } catch {
        return undefined;
      }
    });
  } catch {
    // No compact available; the tool alone still records the run's checkpoint prose.
  }
}
