# Run checkpoints: compaction at step boundaries

Planned 2026-11-12 by the operator. One PLANS.md series: "Run checkpoints, part i/2".
Third of the context plans, after plans/since-last-run.md (between runs) and
plans/typed-role-notes.md (across runs). This one is about context inside a single run.

## Why

Inside a pi run, three bundled extensions manage context today:

- **context-shake** elides the oldest bulky tool results.
- **context-budget** adds a note when the window is 50%, 70% and 85% full.
- **pi's own compaction** runs once the context passes the window minus 16,384 tokens
  (about 114k on the 128k local Qwen). It asks the model for an LLM summary of everything
  except the last ~20k tokens.

Nothing compacts at a point *chosen* for being a good place to compact.

**Measured 2026-11-12** (sessions and events kept since the 11-12 01:12 loss: 81 authoring
sessions, 84 `run_end` events; 43 DeepSeek-V4-Flash-0731, 38 local Qwen3.8-27B with a 128k
window):

- Peak context: p50 49k, p90 101k, max 156k. 37% of runs pass 64k, 12% pass 96k, 5% pass 128k.
  This matches the 10-17 measurement (p50 50k, p90 101k), so runs have not shrunk since.
- The 50% budget note fired in 24 of 81 sessions and the 70% note in 2. pi compacted 3 times.
- By peak context: runs under 64k ended `aborted` 2 times out of 47; runs at 64–96k ended
  `aborted` 6 times out of 24. Restarts abort long runs more often simply because they are long,
  so this is a lead, not a result.
- Context hurts quality before it hits the window. The context-rot work (Chroma 2025, and
  "Diagnosing and Mitigating Context Rot in Long-horizon Search", 2026) finds that an
  accumulating, noisy history degrades behavior well before the limit.

**Research.** *SelfCompact* (arXiv 2606.23525) gives the model a compaction tool plus a short
rubric: compact when a subtask has resolved or the work is converging; hold off in the middle
of a derivation or when stuck. Across six benchmarks and seven models it matched or beat
fixed-interval summarization at 30–70% lower cost, and gained 5–9 points on agentic search
over no summarization. Both parts were needed. With the tool alone, models compacted unevenly;
the rubric alone could not act. Unprompted models "cannot reliably tell when their own context
is rotting".

**A hazard tumwater already has.** tumwater sends the whole run prompt, with every rule, as
the first *user* message. pi's system prompt is replayed after compaction, but the first user
message is summarized like any other message (pi 1.5.2 docs/compaction.md, "How It Works").
*The Compaction Cliff* (arXiv 2608.22752) measured rules kept 53% after one LLM summary and 10%
after five. So a run that compacts today can lose the kill-by-PID rule, the test-runner rule
and the write rules, which are the rules behind the 10-25 and 11-06 incidents.

## Design

### Part 1: pin the run prompt across every compaction (pi)

A new bundled extension, `src/pi-extension/pin-prompt.ts`, loaded last.

- On the first `context` event of a session, it records the first user message (the run
  prompt) verbatim.
- On every later `context` event, if that message is no longer first, because a compaction
  replaced it with a summary, it puts the recorded message back at the front. Nothing else
  changes.
- A resumed session (`--continue`, a new process) recovers the prompt from
  `ctx.sessionManager` entries: the first user message on the branch.

The re-inserted message is the same bytes every time, so after compaction the prefix is stable
and caches as well as it does today.

This fixes the Compaction Cliff for every compaction, whatever triggered it: pi's threshold
and overflow compactions now, and part 2's checkpoints later. It costs nothing until a
compaction happens.

### Part 2: the `checkpoint` tool and its rubric (pi)

A new bundled extension, `src/pi-extension/checkpoint.ts`, registers a `checkpoint` tool with
three fields, each at most 1,500 characters:

- `done`: what is finished and how it was verified;
- `state`: files changed, what passes, what still fails;
- `next`: the next step.

**When the call is refused.** The tool declines, and says why in its result, when:

- context is below max(32k tokens, 25% of the window), because there is nothing worth
  reclaiming and compacting would only throw away the cache;
- fewer than 6 turns have passed since the last checkpoint.

This is SelfCompact's suppression half. It keeps a weak model from compacting every few turns.

**When the call is accepted:**

- The extension compacts at the next turn boundary, preferring a `compaction` draft entry at
  `turn_end` and falling back to `ctx.compact()`.
- A `session_before_compact` handler supplies the summary itself, so no extra LLM call runs:
  - the model's three fields, word for word;
  - the read and modified files from `preparation.fileOps`;
  - `git status --short` and `git diff --stat` of the worktree, capped at 40 lines, from at
    most two git spawns.
- It keeps pi's `firstKeptEntryId` (the last ~20k tokens).
- Part 1 puts the run prompt back in front.
- Compactions this extension did not request (threshold, overflow) are left to pi.

**The rubric** appears in two places: the tool's description, and one rule in pi's prompt
dialect (`backendRules` in src/prompt/dialect.ts), so only pi runs see it:

> Call `checkpoint` right after you finish a step: when your exploration has settled what to
> change, after a set of edits passes its targeted tests, or before you move to an unrelated
> part of the task. Never call it in the middle of an edit, while diagnosing a failure, or when
> stuck: a summary written then loses what you need. Write it so you could continue from it
> alone.

context-budget's 50% and 70% notes gain one clause: "if you just finished a step, call
`checkpoint` first".

The extension records the counts of accepted and declined checkpoint calls in each compaction's
`details` (`{ kind: "checkpoint" }`), so session files can be audited.

## How we will know it worked

**Lab A/B (operator, prompt lab, as soon as part 2 merges).** Part 2 goes live for the team
when it merges, because a config switch would outlive the experiment. The A/B runs against the
merged build, with the checkpoint extension left out of one arm's `-e` list. Replay real runs
from their base commits, using the method in the prompt-lab memory: isolated
`PI_CODING_AGENT_DIR`, n=3 per arm.

- **Tasks:** 6, chosen from the longest roles (organize, security, perf, improve, plus two
  feature runs).
- **Models:** both team models (local Qwen 128k, DeepSeek-V4-Flash-0731).
- **Arms:** part 1 alone against part 1 plus part 2.
- **Measures:**
  - task outcome: the final diff passes the suite independently, and a reviewer replay
    approves it;
  - turns, total prompt tokens, peak context and thinking tokens;
  - checkpoint calls accepted and declined;
  - rule violations found by grepping the transcripts for the pinned rules' forbidden
    commands.
- **Keep it if:** outcomes are no worse and prompt tokens or peak context fall. If weak models
  checkpoint at bad moments (mid-diagnosis in the transcripts), tighten the rubric before
  dropping the tool.

Part 1 is worth keeping on its own whatever the A/B shows. Its own check: force a compaction
in real pi and confirm the next request still starts with the run prompt.

**After merge (live, two weeks):**

- the share of runs with at least one checkpoint, and the median number per run;
- peak context p90 (was 101k);
- how often the 70% budget note fires (was 2/81);
- the `aborted` and `no_change` rates for runs over 64k, with restart aborts counted separately.

## Not in this plan

- **Other backends.** Claude Code, Codex and OpenCode compact by their own rules, and a run
  cannot trigger their compaction from inside. They get neither the tool nor the rubric. Pinning
  the prompt there depends on each CLI (Claude Code keeps its system prompt, but tumwater's
  prompt is a user turn there too). Revisit after the pi A/B.
- **A handoff rollover:** ending a run at ~75% and continuing in a fresh run through
  `buildHandoffPrompt`. Checkpoints should make it unnecessary. Revisit only if long runs still
  hit the window.
- **Replacing pi's threshold summary** with a harness-written one.

## Sources

- Self-Compacting Language Model Agents: https://arxiv.org/abs/2606.23525
- The Compaction Cliff: https://arxiv.org/abs/2608.22752
- Diagnosing and Mitigating Context Rot in Long-horizon Search:
  https://www.alphaxiv.org/abs/2606.29718v1
- CliffCompaction (cost of when to compact): https://arxiv.org/pdf/2609.26779
- pi 1.5.2 docs: docs/compaction.md, and docs/extensions.md "context", "session_before_compact",
  "ctx.compact()"
