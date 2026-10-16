import { agree, shortSpanPhrase } from "../text/phrases.js";
import { formatTimestamp } from "../text/datetime.js";
import { claudeWindowLabel } from "../agent/claude/claude-account.js";
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
  const lines: string[] = [];
  lines.push(
    ...fencedOrNone(
      "Notebook",
      p.note,
      "none yet — the role's own earlier ticks write it, and the director has none",
    ),
  );
  lines.push(...fencedOrNone("Next tick prompt", p.nextPrompt, "nothing to run this tick"));
  // tick-prompt.ts dequeues exactly one queued prompt per tick, so with more than one
  // waiting the block above shows only the oldest — say so, so the count line and the
  // block never read as a contradiction (the 2026-10-04 BUGS.md entry under ## Fixed).
  if (p.inboxCount > 1 && p.nextPrompt !== null && p.nextPrompt.trim() !== "") {
    const more = p.inboxCount - 1;
    lines.push(
      `_(the Next tick prompt embeds the oldest queued prompt — one is consumed per tick; ${more} more ${agree(more, "waits", "wait")})_`,
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
  return `${p.agent !== "pi" ? p.agent : "pi"} default`;
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
  const agent = p.agent !== "pi" ? `${p.agent}/` : "";
  return `${agent}${pair}${thinking}`;
}

/** A fallback pair as one readable token, agent-qualified exactly like modelLine — a non-pi
 * backend (its `agent`, or a provider that names one, `claude`) is named as the selector's
 * namespace; a pi pair keeps `provider/model`; neither half present falls back to the
 * backend-default label. One home for the Model fallback and Budget fallback lines, so a
 * claude fallback reads `claude/claude-sonnet-5-5`, not a bare id (PLANS.md "Mixed claude +
 * pi fleets, part 3/4" gap 7). */
function fallbackPairLabel(
  fb: { provider?: string; model?: string; agent?: string },
  agentDefault: string,
): string {
  const agentBackend =
    (fb.agent !== undefined && fb.agent !== "pi" ? fb.agent : undefined) ??
    (fb.provider !== undefined && isAgentId(fb.provider) ? fb.provider : undefined);
  if (fb.model !== undefined) {
    if (agentBackend !== undefined) return `${agentBackend}/${fb.model}`;
    return fb.provider !== undefined ? `${fb.provider}/${fb.model}` : fb.model;
  }
  if (fb.provider !== undefined) return fb.provider;
  return agentDefault;
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

/** Render one loop's inspection payload as Markdown. */
export function renderRoleMarkdown(p: RoleViewPayload): string {
  const lines: string[] = [`# tumwater role: ${p.id}`, ""];
  lines.push(`- Loop: "${p.id}" (${p.title})${p.custom ? " — user-defined loop" : ""}`);
  const state = [p.enabled ? "enabled" : "disabled", p.paused ? "paused" : "not paused"].join(", ");
  lines.push(`- State: ${state}`);
  lines.push(`- Scheduling tier: ${p.tier} (${p.tier === 0 ? "work" : "maintenance/observer"})`);
  lines.push(`- Model: ${modelLine(p)} (${p.modelTier} tier)`);
  // Per-provider concurrency cap (plans/provider-concurrency.md §8): name the key whose cap
  // bounds the role's concurrent ticks, plus the cap itself. Present only while
  // `maxConcurrentPerProvider` maps this seam's key — a cap-less default fleet has no
  // resolvable key entry, so its role view renders no new line and stays byte-identical.
  if (p.providerKey !== undefined && p.providerCap !== undefined) {
    lines.push(`- Provider: ${p.providerKey} (cap ${p.providerCap})`);
  }
  // Image input (plans/image-input.md "Surfaces", part 5/5): whether this loop's own model
  // reads images, and — when it cannot — where a tick that reads an image reroutes. Not just
  // `yes`/`no`: a text-only loop that falls back names the target, so `tumwater role <id>`
  // explains the fleet alert without running doctor. Unknown (null) renders `unknown` rather
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
    lines.push(`- Budget fallback: ${pair} (${p.fallbackFree ? "free" : "priced"})`);
  }
  // The claude seam's billing (plans/agent-backends.md §7/§8, PLANS.md part 6d/7): absent on
  // a pi seam, so its role view is byte-identical to before.
  if (p.billing) {
    const window =
      p.billing === "subscription" && p.billingWindow ? ` (${claudeWindowLabel(p.billingWindow)} window)` : "";
    lines.push(`- Billing: ${p.billing === "api" ? "API" : p.billing}${window}`);
  }
  lines.push(`- Min tick interval: ${p.minTickIntervalSeconds}s`);
  lines.push(`- Queued prompts: ${p.inboxCount}`);
  // The loop's recent tick outcomes (role-view.ts's recentOutcomes, read from the event log):
  // one line per outcome so `tumwater role <id>` shows what the loop has been DOING, not just
  // what it is. Absent (never ticked) renders nothing new, so old goldens are byte-identical.
  if (p.recentOutcomes && p.recentOutcomes.length > 0) {
    lines.push("", "## Recent tick outcomes", "");
    for (const o of p.recentOutcomes) lines.push(`- ${recentOutcomeLine(o)}`);
  }
  lines.push("");
  lines.push(...fencedOrNone("Instructions override", p.instructions));
  lines.push(
    ...fencedOrNone(
      "Find text",
      p.find,
      "none — the director is driven by its queued prompts, not a find text",
    ),
  );
  lines.push(...inspectMarkdownLines(p));
  return lines.join("\n").trimEnd();
}
