// The `checkpoint` tool and the `session_before_compact` summary handler that together let a pi
// run compact its own context at a step boundary it chooses (Run checkpoints, part 2/2;
// plans/run-checkpoints.md §5-6). A long run can cross the same 256k window several times, so
// pi's own compaction at the fixed thresholds runs out for it (part 1/2 kept the prompt verbatim
// across each compaction; this adds the run's own choice of *when* to compact, at a step
// boundary rather than mid-exploration).
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
 * of the first entry the compaction keeps (kept by pi; the summary does not change it). */
interface BeforeCompactPreparation {
  fileOps?: FileOps;
  firstKeptEntryId?: string | null;
}

/** The extension's per-process state. `lastCheckpointTurn` is the turn index the last accepted
 * checkpoint recorded at, and `fields` the model's prose the summary reuses. */
interface CheckpointState {
  lastCheckpointTurn: number;
  requested: boolean;
  fields: CheckpointParams | null;
}

// The suppression floor, in tokens: below the greater of 32k or 25% of the window there is
// nothing worth reclaiming, and compacting would only throw away a warm cache.
export const CHECKPOINT_MIN_TOKENS = 32_000;
const CHECKPOINT_WINDOW_FRACTION = 0.25;

// A checkpoint is refused while fewer turns have passed since the last one, so a weak model
// cannot compact every few turns.
export const CHECKPOINT_MIN_TURNS = 6;

// The git block is capped so a busy worktree cannot flood the summary; the whole block stays
// at or under this many lines.
const GIT_LINE_CAP = 40;

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

/** The compaction entry's summary: the model's three fields word for word, the read and
 * modified file lists from the file ops, and a capped `git status`/`git diff --shortstat` of the
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
        `read: ${[...fileOps.read].sort().join(", ")}`,
        `modified: ${[...new Set([...fileOps.written, ...fileOps.edited])].sort().join(", ")}`,
      ].join("\n"),
      12,
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
  compact?: (options?: { customInstructions?: string }) => void;
  getContextUsage?: () => Usage | undefined;
  exec?: (command: string, args: string[], options?: { cwd?: string }) => Promise<{ stdout: string }>;
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
        return {
          content: [{ type: "text", text: `checkpoint refused: ${decision.reason}. Continue the step.` }],
        };
      }
      state.lastCheckpointTurn = currentTurn();
      state.requested = true;
      state.fields = params;
      let compacted = false;
      try {
        ctx?.compact?.();
        compacted = true;
      } catch {
        compacted = false;
      }
      const echoed = [
        params.done ? `done: ${params.done}` : "",
        params.state ? `state: ${params.state}` : "",
        params.next ? `next: ${params.next}` : "",
      ]
        .filter((l) => l.length > 0)
        .join("\n");
      const text = `Checkpoint recorded${compacted ? "; the context is being compacted" : ""}.${
        echoed ? `\n${echoed}` : ""
      }`;
      return { content: [{ type: "text", text }] };
    },
  };
}

/** The bundled extension: register the `checkpoint` tool and the `session_before_compact`
 * summary handler over one shared state. The handler writes its summary only for a compaction
 * this extension requested (`state.requested`); compactions pi triggered itself (threshold,
 * overflow) are left to pi. Never throws into pi: every handler body is guarded, and a context
 * with no `compact` at all (a non-session pi) degrades to the tool alone. */
export default function (
  pi: {
    registerTool(tool: ToolLike): void;
    on(
      event: "turn_end" | "session_before_compact",
      handler: (
        event: {
          turnIndex?: number;
          preparation?: BeforeCompactPreparation;
        },
        ctx?: CompactCtx,
      ) => object | Promise<object> | undefined,
    ): void;
  },
): void {
  const state: CheckpointState = { lastCheckpointTurn: -1, requested: false, fields: null };
  let turn = -1;
  try {
    pi.on("turn_end", () => {
      turn += 1;
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
        const gitStatus = await gitReading(ctx?.exec, ["status", "--short"], cwd);
        const diffStat = parseShortstat(await gitReading(ctx?.exec, ["diff", "--shortstat"], cwd));
        const summary = buildCheckpointSummary(state.fields, event.preparation?.fileOps, gitStatus, diffStat);
        state.requested = false;
        state.fields = null;
        return { compaction: { summary: summary ?? "" } };
      } catch {
        return undefined;
      }
    });
  } catch {
    // No compact available; the tool alone still records the run's checkpoint prose.
  }
}
