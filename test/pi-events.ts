/** Builders for fake pi JSONL session event lines — the assistant/user message_end and
 * agent_start lines pi writes to a session file, as the fake-pi shim and transcript fixtures
 * need them. Split out of the old util.ts grab-bag (now dissolved into topic-named
 * modules); every builder here is pure string shaping. */

/** A pi JSON line for an assistant message_end. */
export function assistantLine(
  text: string,
  opts: { tokens?: number; output?: number; cost?: number; stopReason?: string } = {},
): string {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { totalTokens: opts.tokens ?? 0, output: opts.output ?? 0, cost: { total: opts.cost ?? 0 } },
    stopReason: opts.stopReason ?? "stop",
  };
  return JSON.stringify({ type: "message_end", message });
}

/** The reviewer's fake-pi shim: match the review run (the only run whose args carry a
 * VERDICT-bearing prompt), print `reply` as its one assistant turn, exit 0 — the gate reads
 * the verdict out of `reply`. Used inside larger scripts too: when the invocation is not the
 * review run, the case falls through and the surrounding lines answer the author run.
 * `recordTo` also dumps the run's full argv to that file before replying — the fixture tests
 * use to assert which reviewer prompt actually ran. */
export const reviewerPi = (reply: string, recordTo?: string): string =>
  `for a in "$@"; do case "$a" in *"VERDICT:"*)` +
  (recordTo ? ` printf '%s\\n' "$@" > '${recordTo}';` : "") +
  ` printf '%s\\n' '${assistantLine(reply)}'; exit 0;; esac; done`;

/** The common approver: a reviewer stub that approves. */
export const APPROVE_PI = reviewerPi("VERDICT: approve");

/** Shell that prints the role leasing the current pooled checkout into `$role`, read from
 * slots.json — how a fake-pi shim names the change under review now that a vet runs in a
 * pooled `_slot-<n>` instead of a `_land-<role>` path (plans/worktree-pool.md, part 2b/5). A
 * slot sits at `<root>/.tumwater/worktrees/_slot-<n>`, so the root is three levels up; the role
 * is the lease record whose slot dir realpaths to this cwd. Prints nothing when the cwd is not
 * a leased slot (the merge-side `_land-<role>` path). */
export function leasedRoleShell(): string {
  return (
    `role=$(node -e 'const fs=require("fs"),path=require("path");` +
    `const cwd=fs.realpathSync(process.cwd());` +
    `const root=path.resolve(cwd,"../../..");` +
    `let s={slots:[]};try{s=JSON.parse(fs.readFileSync(path.join(root,".tumwater/state/slots.json"),"utf8"))}catch{};` +
    `const m=(s.slots||[]).find(x=>{try{return fs.realpathSync(x.dir)===cwd}catch{return false}});` +
    `process.stdout.write(m&&m.lease?m.lease.role:"")' 2>/dev/null)`
  );
}

/** A pi JSON line for an assistant message_end whose content is thinking-only — the
 * signature of a generation cut off mid-stream (e.g. output clamped to the sliver left
 * under the declared context window); a compliant finish always ends with a text block. */
export function thinkingOnlyLine(
  thinking: string,
  opts: { tokens?: number; output?: number } = {},
): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking }],
      usage: { totalTokens: opts.tokens ?? 0, output: opts.output ?? 0, cost: { total: 0 } },
      stopReason: "stop",
    },
  });
}

/** A pi JSON line for an assistant message_end that ended in a server error. */
export function errorLine(errorMessage: string): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage },
  });
}

/** A fixed epoch-ms timestamp for transcript fixtures, so run separators render deterministically. */
export const FIXED_TS = 1787222691956;

/** A pi JSON line for an agent_start event — the only event that separates runs in a transcript (src/ui/transcript.ts). */
export function agentStart(): string {
  return JSON.stringify({ type: "agent_start" });
}

/** A pi JSON line for a user message_end (the tick prompt). Its content is never rendered, but its timestamp drives the run separator. */
export function userLine(text: string, timestamp: number = FIXED_TS): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text }], timestamp },
  });
}

/** A harness-written run-label marker line — the pre-part-1/5 shape (label only), kept for
 * the old-log tests: the transcript renderers read it and the progress demux falls back to
 * the session cwd. */
export function runMarker(label = "review"): string {
  return JSON.stringify({ type: "tumwater_run", label });
}

/** A harness-written run marker as src/pi/pi.ts now stamps it — the run's kind, plus its label
 * when it has one (a review run carries both). */
export function kindMarker(kind: "author" | "gate", label?: string): string {
  return JSON.stringify(label ? { type: "tumwater_run", kind, label } : { type: "tumwater_run", kind });
}

/** A pi JSON line for an assistant message_end with arbitrary content blocks (thinking/text/toolCall) and no usage — the richer fixture transcript rendering tests need, in contrast to assistantLine above. */
export function assistantBlocks(content: unknown[]): string {
  return JSON.stringify({ type: "message_end", message: { role: "assistant", content, stopReason: "stop" } });
}
