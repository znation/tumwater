/** Rendering half of `tumwater history <role> <n>`: one completed run's full event block
 * printed as a short summary header followed by the run's events through the shared
 * formatEvent, plus the pinned-commit stat/patch and the --transcript text. The payload
 * itself is collected by run-detail-data.ts (the collector-in-core convention beside
 * history-data.ts / history.ts), the CLI command and not-found wording live in run-detail.ts;
 * this module renders the shared payload for both the terminal and the GUI's pre-rendered
 * /api/run, so the CLI and the browser cannot drift on one run's block. Read-only over the
 * event log, stdout only. */
import type { RunDetail } from "./run-detail-data.js";
import { runCommitSha } from "./run-detail-data.js";
import { formatEvent } from "../events/event-format.js";
import { eventTypeLabel } from "../events/event-labels.js";
import { roleLabel } from "../roles/role-labels.js";
import { shortSpanPhrase } from "../text/phrases.js";
import { shortSha, contextShareLabel, compactTokens } from "../text/format.js";
import { piLogPath } from "../paths.js";
import { readRunTranscript } from "../ui/transcript-run.js";
import { gitTry } from "../git/git-run.js";

/** The `git show --stat` summary or full `--patch` of a run's pinned commit. The sha is the
 * authored commit the run pinned: a merge that rebased gives main a different sha with the
 * same changes, so this describes what the run changed. */
async function runCommitShow(root: string, sha: string | null, what: "--stat" | "--patch"): Promise<string> {
  if (sha === null) return "(no commit: this run sent nothing to merge)";
  const out = await gitTry(root, "show", what, "--format=", sha);
  if (out === null) return `(commit ${shortSha(sha)} is not in this repository)`;
  return out.trimEnd();
}

/** The pinned commit's stat text for a run, shared by `run --stat` and GET /api/run so both
 * apply one rule for the sha and the "(no commit …)" / "(commit … is not in this repository)"
 * texts. */
export function runDetailStat(root: string, d: RunDetail): Promise<string> {
  return runCommitShow(root, runCommitSha(d), "--stat");
}

/** The pinned commit's full patch for a run, for `history --patch`. Like runDetailStat it
 * shows the commit the run pinned (runCommitSha), not the `merged as` sha, so the stat and
 * the patch describe the same commit; the placeholder texts are the stat's. GET /api/run is its
 * second caller (the dashboard's "Show patch" button). */
export function runDetailPatch(root: string, d: RunDetail): Promise<string> {
  return runCommitShow(root, runCommitSha(d), "--patch");
}

/** The human view of a RunDetail: one summary line — result (or the in-flight/unpaired
 * marker), duration, usage, and the model the run started on when its `run_start` carried one
 * (after the usage, before the pinned-commit sha), plus the pinned commit sha when the block's
 * `merge_queued`/`merge_done` event carries one — then each event through formatEvent, the
 * shared renderer `logs` and the
 * TUI use, so the trail reads exactly like the feed it came from. A queued run whose merge
 * has finished shows that verdict in the header and ends with the merge's outcome line; a
 * leftover-recovery run's verdict is the failed attempt it re-queued (resolveQueuedResult),
 * logged before the run began, so that outcome line leads the trail instead — the trail stays
 * in time order. */
export function renderRunDetail(d: RunDetail): string {
  const summary: string[] = [];
  if (d.endTs === null) summary.push(d.startTs === null ? "unpaired" : "in flight");
  else summary.push(d.result ? eventTypeLabel(d.result) : "?");
  // The ceiling-truncation marker, straight after the result cell. It only rides a
  // completed end (cutOff is set from the run_end), so it can never follow in flight/unpaired.
  if (d.cutOff === true) summary.push("cut off at the context ceiling");
  if (d.durationMs !== null) summary.push(shortSpanPhrase(d.durationMs));
  if (d.usage !== "") summary.push(d.usage);
  // The run's prompt-token total and the share the backend served from cache, the input
  // side a cost-only header hides. The `${n}% cached` wording and rounding are the usage
  // report's `Prompt tokens by role` share; a run with prompt tokens but no cache reads
  // shows no parenthetical, and a run that reported neither keeps today's header
  // byte-identical (the omit-when-zero convention).
  const prompt = d.promptTokens ?? 0;
  const cached = Math.min(d.cacheReadTokens ?? 0, prompt);
  if (prompt > 0) summary.push(cached > 0 ? `prompt ${compactTokens(prompt)} tok (${Math.round((100 * cached) / prompt)}% cached)` : `prompt ${compactTokens(prompt)} tok`);
  // The run's pre-edit prompt-token share, the `… before first edit` signal a cost-only
  // header hides: how much of the prompt budget went out before the run made its first
  // edit. Clamped to the total (run-detail-data.ts), written after the prompt cell and
  // before the peak-context cell; a run that reported no pre-edit reading — and an
  // in-flight run — keeps today's header byte-identical.
  const preEdit = Math.min(d.preEditPromptTokens ?? 0, prompt);
  if (preEdit > 0) summary.push(`pre-edit ${compactTokens(preEdit)} tok`);
  // The run's peak context against the seam's declared window, the one header every surface
  // renders. Omitted when the run reported no peak (byte-identical to today's header).
  if ((d.peakContextTokens ?? 0) > 0) summary.push(`peak ctx ${contextShareLabel(d.peakContextTokens ?? 0, d.contextWindow)}`);
  if (d.model !== null) summary.push(d.model);
  const sha = runCommitSha(d);
  let header = `${roleLabel(d.role)} run #${d.run} — ${summary.join(" · ")}`;
  if (sha !== null) header += ` · commit ${shortSha(sha)}`;
  if (d.mergedSha !== null && d.mergedSha !== sha) header += ` · merged as ${shortSha(d.mergedSha)}`;
  if (d.reverted !== null) {
    header += ` · reverted ${shortSha(d.reverted.sha)} (by operator)`; // vocabulary-ok: the deliberate-revert writer this header names
  }
  const trail = d.events.map(formatEvent);
  if (d.merge !== null) {
    const first = d.events[0];
    if (first !== undefined && d.merge.ts < first.ts) trail.unshift(formatEvent(d.merge));
    else trail.push(formatEvent(d.merge));
  }
  return [header, ...trail].join("\n");
}

/** The transcript block of `--transcript`: the rendered lines of the agent runs that started in the
 * run's window, or `found: []` plus the `note` the text view prints in their place. The
 * dashboard's `/api/run?transcript` serves the same text. */
export function runTranscriptLines(
  root: string,
  role: string,
  runNumber: number,
  detail: RunDetail,
  opts: { includePrompts?: boolean; grep?: string } = {},
): { found: string[]; note: string } {
  if (detail.startTs === null) {
    return { found: [], note: `(no transcript: run ${runNumber}'s start rotated out of the event log)` };
  }
  return {
    found: readRunTranscript(piLogPath(root, role), detail.startTs, detail.endTs, {
      includePrompts: opts.includePrompts,
      grep: opts.grep?.toLowerCase(),
    }),
    note:
      opts.grep !== undefined
        ? `(no transcript entries matching "${opts.grep}" in ${role} run ${runNumber})`
        : `(no transcript for ${role} run ${runNumber}: rotated out of .tumwater/log/${role}.pi.jsonl, or the run started no agent)`,
  };
}
