import type { RoleViewPayload } from "../role-view.js";

/** The terminal's view of one loop — what `tumwater role <id>` prints, rendered as Markdown
 * from the payload role-view.ts's rolePayload collects (the same document `--json` prints).
 * Like backlog-report.ts, the renderer owns no collection of its own: the CLI's --json and
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

/** The provider/model wiring as one readable token — `provider/model` when both are named,
 * `model` alone when only the model is (the join simply drops unset halves) — shared by the
 * main line and the budget-fallback line, so the two render the same wiring the same way. */
function modelPair(provider: string | undefined, model: string | undefined): string {
  return [provider, model].filter(Boolean).join("/");
}

/** The provider/model wiring as one readable token: `provider/model` when both resolve,
 * `model` alone when only the model is named, and the pi-default note when neither is. */
function modelLine(p: RoleViewPayload): string {
  const pair = modelPair(p.provider, p.model);
  const thinking = p.thinking ? ` (thinking: ${p.thinking})` : "";
  return pair ? `${pair}${thinking}` : `pi default${thinking}`;
}

/** Render one loop's inspection payload as Markdown. */
export function renderRoleMarkdown(p: RoleViewPayload): string {
  const lines: string[] = [`# tumwater role: ${p.id}`, ""];
  lines.push(`- Loop: "${p.id}" (${p.title})${p.custom ? " — user-defined loop" : ""}`);
  const state = [p.enabled ? "enabled" : "disabled", p.paused ? "paused" : "not paused"].join(", ");
  lines.push(`- State: ${state}`);
  lines.push(`- Scheduling tier: ${p.tier} (${p.tier === 0 ? "work" : "maintenance/observer"})`);
  lines.push(`- Model: ${modelLine(p)}`);
  if (p.fallback) {
    const pair = modelPair(p.fallback.provider, p.fallback.model) || "pi default";
    lines.push(`- Budget fallback: ${pair} (${p.fallbackFree ? "free" : "priced"})`);
  }
  lines.push(`- Min tick interval: ${p.minTickIntervalSeconds}s`);
  lines.push(`- Queued prompts: ${p.inboxCount}`);
  lines.push("");
  lines.push(...fencedOrNone("Instructions override", p.instructions));
  lines.push(
    ...fencedOrNone(
      "Find text",
      p.find,
      "none — the director is driven by its queued prompts, not a find text",
    ),
  );
  lines.push(...fencedOrNone("Next tick prompt", p.nextPrompt, "nothing to run this tick"));
  // tick-prompt.ts dequeues exactly one queued prompt per tick, so with more than one
  // waiting the block above shows only the oldest — say so, so the count line and the
  // block never read as a contradiction (the 2026-10-04 BUGS.md entry under ## Fixed).
  if (p.inboxCount > 1 && p.nextPrompt !== null && p.nextPrompt.trim() !== "") {
    const more = p.inboxCount - 1;
    lines.push(
      `_(the Next tick prompt embeds the oldest queued prompt — one is consumed per tick; ${more} more ${more === 1 ? "waits" : "wait"})_`,
    );
  }
  return lines.join("\n").trimEnd();
}
