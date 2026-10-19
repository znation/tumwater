// vocabulary: plain
import { agree, shortSpanPhrase } from "../text/phrases.js";
import { compactTokens, usd } from "../text/format.js";
import { clockHm, formatTimestamp, humanAgo, nextRunPhrase, secondsUntil } from "../text/datetime.js";
import { claudeWindowLabel } from "../agent/claude/claude-account.js";
import type { ChainTierInfo } from "../team/orchestrator-info.js";
import { yieldMultiplierSuffix } from "../scheduling/backoff.js";
import { quietWindowEnd } from "../scheduling/quiet-hours.js";
import { isAgentId } from "../config/model-selector.js";
import type { RoleViewPayload } from "./role-view.js";

/** The terminal's view of one loop — what `tumwater role <id>` prints, rendered as Markdown
 * from the payload role-view.ts's rolePayload collects (the same document `--json` prints).
 * Like backlog-render.ts, the renderer owns no collection of its own: the CLI's --json and
 * human branches share one collection through sayJsonOrRender's thunk, so the two surfaces
 * cannot drift. Verbatim text (the instructions override, the find text, the assembled next
 * prompt) rides in fenced code blocks — fenced, not indented, because these blocks are
 * prose-and-shell markdown the operator may copy verbatim — with the fence grown past any
 * backtick run the text itself contains, so a prompt that quotes a fence still round-trips.
 * Unset things render as explicit `_(none)_` lines rather than disappearing, so an
 * un-overridden loop reads as fully defaulted, not as a truncated report. */

/** A code fence one longer than any backtick run in the fenced text, so the block always
 * closes where the text itself would have ended it. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** A fenced verbatim block, or a placeholder line when there is nothing to show — `_(none)_`
 * by default, or the caller's note in the same emphasis form (the director's find text is
 * absent on purpose, and the line should say why rather than look like an omission). */
function fencedOrNone(label: string, text: string | null, noneNote = "none"): string[] {
  if (text === null || text.trim() === "") return [`## ${label}`, "", `_(${noneNote})_`, ""];
  const fence = fenceFor(text);
  return [`## ${label}`, "", fence, text.replace(/\n+$/, ""), fence, ""];
}

/** The Notebook and Next tick prompt blocks and the "more waits" disclosure, as Markdown
 * lines — the read-only inspection the TUI's notebook view and `tumwater role <id>` share,
 * so the terminal and the CLI show one loop's notebook and assembled prompt identically.
 * `renderRoleMarkdown` splices these at the same position, so the extracted function and the
 * full document cannot drift. */
export function inspectMarkdownLines(p: RoleViewPayload): string[] {
  const running = chainStepLine(p);
  return [...(running ? [running, ""] : []), ...inspectBodyLines(p)];
}

/** The notebook, prompt and disclosure blocks alone — what renderRoleMarkdown splices after
 * its own Team lines, which already carry the fallback-step bullet. */
function inspectBodyLines(p: RoleViewPayload): string[] {
  const lines: string[] = [];
  lines.push(
    ...fencedOrNone(
      "Notes",
      p.notes,
      "none yet — the role's own earlier runs write them, and the director has none",
    ),
  );
  lines.push(...fencedOrNone("Next run's prompt", p.nextPrompt, "nothing to do this run"));
  // tick-prompt.ts dequeues exactly one queued prompt per tick, so with more than one
  // waiting the block above shows only the oldest — say so, so the count line and the
  // block never read as a contradiction (the 2026-10-04 BUGS.md entry under ## Fixed).
  if (p.inboxCount > 1 && p.nextPrompt !== null && p.nextPrompt.trim() !== "") {
    const more = p.inboxCount - 1;
    lines.push(
      `_(the next run's prompt embeds the oldest inbox message — one is taken per run; ${more} more ${agree(more, "waits", "wait")})_`,
    );
  }
  return lines;
}

/** The provider/model wiring as one readable token — `provider/model` when both are named,
 * `model` alone when only the model is (the join simply drops unset halves) — shared by the
 * main line and the budget-fallback line, so the two render the same wiring the same way. */
function modelPair(provider: string | undefined, model: string | undefined): string {
  return [provider, model].filter(Boolean).join("/");
}

/** The backend's own-default label when no model resolves: `<agent> default` — pi's
 * historical `pi default` for the pi backend, `claude default` for claude (part 4f/7). */
function agentDefault(p: RoleViewPayload): string {
  return `${p.backend !== "pi" ? p.backend : "pi"} default`;
}

/** The provider/model wiring as one readable token: `provider/model` when both resolve,
 * `model` alone when only the model is named, and the backend-default note when neither is.
 * A non-pi backend is named as the selector's provider namespace (`claude/claude-sonnet-5-5`),
 * matching the string the events and status rows carry; a pi seam is unchanged. */
function modelLine(p: RoleViewPayload): string {
  // pi's own saved default (part 2/2): the formatted selector already carries its thinking
  // level (piDefault is formatted with the effective thinking winning), so the separate
  // ` (thinking: …)` suffix is dropped for this case only.
  if (p.piDefault) return `${agentDefault(p)} (${p.piDefault})`;
  const pair = modelPair(p.provider, p.model);
  const thinking = p.thinking ? ` (thinking: ${p.thinking})` : "";
  if (!pair) return `${agentDefault(p)}${thinking}`;
  const agent = p.backend !== "pi" ? `${p.backend}/` : "";
  return `${agent}${pair}${thinking}`;
}

/** A fallback pair as one readable token, agent-qualified exactly like modelLine — a non-pi
 * backend (its `agent`, or a provider that names one, `claude`) is named as the selector's
 * namespace; a pi pair keeps `provider/model`; neither half present falls back to the
 * backend-default label. One home for the Model fallback and Budget fallback lines, so a
 * claude fallback reads `claude/claude-sonnet-5-5`, not a bare id (PLANS.md "Mixed claude +
 * pi fleets, part 3/4" gap 7). */
function fallbackPairLabel(
  fb: { provider?: string; model?: string; backend?: string },
  agentDefault: string,
): string {
  const agentBackend =
    (fb.backend !== undefined && fb.backend !== "pi" ? fb.backend : undefined) ??
    (fb.provider !== undefined && isAgentId(fb.provider) ? fb.provider : undefined);
  if (fb.model !== undefined) {
    if (agentBackend !== undefined) return `${agentBackend}/${fb.model}`;
    return fb.provider !== undefined ? `${fb.provider}/${fb.model}` : fb.model;
  }
  if (fb.provider !== undefined) return fb.provider;
  return agentDefault;
}

/** Why a tier moved down its fallback chain, as the role view words it. */
function chainReasonPhrase(reason: ChainTierInfo["reason"], windowType: string | undefined): string {
  switch (reason) {
    case "window":
      return `${windowType !== undefined ? claudeWindowLabel(windowType) : "Claude"} window used up`;
    case "reserve":
      return "window reserve reached";
    case "cap":
      return "daily cap reached";
    case "step-cap":
      return "previous step's cap reached";
    case "overage":
      return "extra usage refused";
    case "demoted":
      return "previous step demoted";
  }
}

/** The `Running on fallback <step> of <of> (<why>, resets HH:MM)` bullet, or null when the
 * role's tier is on its primary. */
function chainStepLine(p: RoleViewPayload): string | null {
  const c = p.chainStep;
  if (!c) return null;
  const resets = c.returnsAt !== undefined ? `, resets ${clockHm(c.returnsAt)}` : "";
  return `- Running on fallback ${c.step} of ${c.of} (${chainReasonPhrase(c.reason, p.billingWindow)}${resets})`;
}

/** One recent tick outcome as a Markdown bullet line — `<time> · <result> · <span> —
 * <summary>` — so `tumwater role <id>` and the TUI notebook view read a loop's discrete
 * outcomes at a glance. `time` is the same local `YYYY-MM-DD HH:MM:SS` stamp the model-
 * fallback `since` prints (formatTimestamp); `span` is the same short-duration phrasing
 * shortSpanPhrase renders for holdPhrase and the event feed's countdowns; the summary is
 * appended when the event carried one. Unset halves are dropped, never printed as a literal
 * `undefined`. */
function recentOutcomeLine(o: { ts: number; result: string; durationMs?: number; summary?: string }): string {
  let line = `${formatTimestamp(o.ts)} · ${o.result}`;
  if (o.durationMs !== undefined) line += ` · ${shortSpanPhrase(o.durationMs)}`;
  if (o.summary) line += ` — ${o.summary}`;
  return line;
}

/** One quiet-hours bullet: the window, whose it is, and whether it holds the loop now — with
 * the same `quiet until <end>` text the status table uses. */
function quietHoursLine(w: NonNullable<RoleViewPayload["quietHours"]>[number]): string {
  const whose = w.scope === "role" ? "own window" : "team window";
  const state = w.inWindow ? `holding now — quiet until ${quietWindowEnd(w.window)}` : "not holding now";
  return `- Quiet hours: ${w.window} (${whose}; ${state})`;
}

/** The loop's schedule as Markdown bullet lines — `Next tick`, `Last tick`, then one
 * `Quiet hours` line per governing window (none when the payload carries no windows) — in the
 * same words and wording family as the team surface's `next run` cell (status-render.ts's
 * nextRunCell), so the role view and the status table cannot drift on when a loop acts next:
 * a never-scheduled loop (nextRunAt 0) reads `not scheduled yet`; a due loop reads `due now`;
 * a future one reads `in <Ns>` through humanSeconds, prefixed `backoff ` while backoffSeconds
 * > 0 (the wake row-action clears exactly that) — the shared nextRunPhrase, so the role view
 * and the status `next run` cell cannot drift on the backoff prefix or the humanSeconds
 * bucketing. `Last tick` reuses formatTimestamp and the same `humanSeconds … ago` phrasing the
 * status `last tick` cell ages with, or `never` for a loop that has not ticked. `now` is
 * injected (default Date.now()) so the renderer stays a pure function of the payload and the
 * test can pin a fixed clock. */
function scheduleLine(p: RoleViewPayload, now: number): string[] {
  // The yield multiplier rides the line as `×N` exactly like nextRunCell/fmtNextRun: a quiet
  // yield-scaled loop's effective gap is longer than nextRunAt's countdown shows (isEligible
  // gates on the multiplier too), so the Schedule must not understate when the loop acts next.
  const suffix = yieldMultiplierSuffix(p.yieldMultiplier);
  let next: string;
  if (p.nextRunAt <= 0) {
    next = "not scheduled yet";
  } else {
    const remain = secondsUntil(p.nextRunAt, now);
    next = nextRunPhrase(remain, p.backoffSeconds > 0, "due now", true) + suffix;
  }
  const last =
    p.lastRunEndedAt !== undefined
      ? `${formatTimestamp(p.lastRunEndedAt)} (${humanAgo(p.lastRunEndedAt, now)})`
      : "never";
  return [`- Next run: ${next}`, `- Last run: ${last}`, ...(p.quietHours ?? []).map(quietHoursLine)];
}

/** Render one loop's inspection payload as Markdown. `now` is injected (default Date.now())
 * so the schedule lines stay a pure function of the payload — the test pins a fixed clock. */
export function renderRoleMarkdown(p: RoleViewPayload, now = Date.now()): string {
  const lines: string[] = [`# tumwater role: ${p.id}`, ""];
  lines.push(`- ${p.custom ? "Custom role" : "Role"}: "${p.id}" (${p.title})`);
  const state = [p.enabled ? "enabled" : "disabled", p.paused ? "paused" : "not paused"].join(", ");
  lines.push(`- State: ${state}`);
  lines.push(`- Priority: ${p.tier === 0 ? "work" : "maintenance or observer"}`);
  lines.push(`- Model: ${modelLine(p)} (${p.modelTier} tier)`);
  // Context window: the resolved primary seam's declared window (the one `- Next run:`
  // previews, not the fallback — a run on the model fallback may use a different window, the
  // fallback's own documented state). `unknown` when it cannot be known (a non-pi seam, an
  // unresolvable pair, a model with no declared window).
  lines.push(`- Context window: ${p.contextWindow === null ? "unknown" : `${compactTokens(p.contextWindow)} tokens`}`);
  // Per-provider concurrency cap (plans/provider-concurrency.md §8): name the key whose cap
  // bounds the role's concurrent ticks, plus the cap itself. Present only while
  // `maxConcurrentPerProvider` maps this seam's key — a cap-less default team has no
  // resolvable key entry, so its role view renders no new line and stays byte-identical.
  if (p.providerKey !== undefined && p.providerCap !== undefined) {
    lines.push(`- Provider: ${p.providerKey} (cap ${p.providerCap})`);
  }
  // Image input (plans/image-input.md "Surfaces", part 5/5): whether this loop's own model
  // reads images, and — when it cannot — where a tick that reads an image reroutes. Not just
  // `yes`/`no`: a text-only loop that falls back names the target, so `tumwater role <id>`
  // explains the team alert without running doctor. Unknown (null) renders `unknown` rather
  // than guessing.
  const images =
    p.imageInput === true
      ? "yes"
      : p.imageInput === false
        ? p.imageReroute
          ? `no — reruns on ${p.imageReroute}`
          : "no"
        : "unknown";
  lines.push(`- Images: ${images}`);
  // Model failure fallback, part 2/2: name the off-model pair, when the episode began, and
  // the provider-class failure that tripped it, so `tumwater role <id>` explains the state.
  if (p.modelFallback) {
    const pair = fallbackPairLabel(p.modelFallback, agentDefault(p));
    lines.push(
      `- Model fallback: ${pair} — on fallback since ${formatTimestamp(p.modelFallback.since)} (primary failing: ${p.modelFallback.reason})`,
    );
  }
  if (p.fallback) {
    const pair = fallbackPairLabel(p.fallback, agentDefault(p));
    lines.push(`- Over-cap model: ${pair} (${p.fallbackFree ? "free" : "priced"})`);
  }
  const running = chainStepLine(p);
  if (running) lines.push(running);
  // The claude seam's billing (plans/agent-backends.md §7/§8, PLANS.md part 6d/7): absent on
  // a pi seam, so its role view is byte-identical to before.
  if (p.billing) {
    const window =
      p.billing === "subscription" && p.billingWindow ? ` (${claudeWindowLabel(p.billingWindow)} window)` : "";
    lines.push(`- Billing: ${p.billing === "api" ? "API" : p.billing}${window}`);
  }
  lines.push(`- Min run interval: ${p.minRunIntervalSeconds}s`);
  if (p.instances !== undefined) lines.push(`- Instances: ${p.instances}`);
  lines.push(`- Inbox: ${p.inboxCount}`);
  // The loop's own spend over its retained event window (role-view.ts's usage, summed from the
  // same run_end events recentOutcomes reads): how much the loop burned on tokens and cost,
  // with a notional suffix only when a claude-subscription seam burned non-zero notional spend
  // (plans/agent-backends.md part 6a). Absent for a never-costly loop, so old `tumwater role`
  // goldens are byte-identical.
  if (p.usage) {
    let spend = `- Spend: ${usd(p.usage.costUsd)} · ${compactTokens(p.usage.tokens)} tokens`;
    if (p.usage.notionalCostUsd !== 0) spend += ` · ${usd(p.usage.notionalCostUsd)} notional`;
    lines.push(spend);
  }
  // The per-role daily cap (role-view.ts's dailyCap): today's spend against the cap and whether
  // it holds the loop now. Absent without a cap, so old goldens are unchanged.
  if (p.dailyCap) {
    const dc = p.dailyCap;
    let cap = `- Daily cap: ${usd(dc.spentUsd)} of ${usd(dc.capUsd)} spent today (${dc.over ? "holding now — no new runs until local midnight" : "not holding"})`;
    if (dc.roleIds.length > 1) cap += ` · shared by ${dc.roleIds.join(", ")}`;
    lines.push(cap);
  }
  // The loop's schedule (role-view.ts's nextRunAt/backoffSeconds/lastRunEndedAt, read from
  // the same persisted state): when it may tick again, and when it last did — the one
  // place the team's `next run`/`last tick` vocabulary was absent. Rendered from the
  // injected `now`, so the lines stay a pure function of the payload.
  lines.push(...scheduleLine(p, now));
  // The loop's recent tick outcomes (role-view.ts's recentOutcomes, read from the event log):
  // one line per outcome so `tumwater role <id>` shows what the loop has been DOING, not just
  // what it is. Absent (never ticked) renders nothing new, so old goldens are byte-identical.
  if (p.recentOutcomes && p.recentOutcomes.length > 0) {
    lines.push("", "## Recent runs", "");
    for (const o of p.recentOutcomes) lines.push(`- ${recentOutcomeLine(o)}`);
  }
  lines.push("");
  lines.push(...fencedOrNone("Instructions override", p.instructions));
  lines.push(
    ...fencedOrNone(
      "Find text",
      p.find,
      "none — the director is driven by its inbox, not by instructions",
    ),
  );
  lines.push(...inspectBodyLines(p));
  return lines.join("\n").trimEnd();
}
