/** The prompt line's session history: every successfully submitted prompt (director and
 * per-role alike — one list, like a shell's), recallable with Up/Down the way readline does
 * it. Pure state, so the recall rules are unit-testable without a TTY; tui.tsx owns pushing
 * on submit and wiring the arrow keys, this file owns the rules.
 *
 * Readline's two habits are kept: consecutive duplicates are not recorded twice (ignoredups
 * — re-sending the same nudge does not fill the history with copies), and the draft the
 * operator was typing when the first Up fired is saved and restored when Down walks back
 * past the newest entry, so history browsing never costs the unfinished line. */
export interface PromptHistory {
  /** Submitted prompts, oldest first. */
  items: string[];
  /** Where recall sits: `items.length` means the live draft (not browsing history). */
  index: number;
  /** The draft saved when the first Up left the live line; restored on Down past the end. */
  draft: string;
  /** Where the draft's cursor sat when the first Up fired, restored with the draft. */
  draftCursor: number;
}

/** The live-draft state: recall parked at the end of `items` with no saved draft. The neutral
 * state a session starts from, the state a submit returns to, and the state every mode switch
 * resets to. */
function liveDraft(items: string[]): PromptHistory {
  return { items, index: items.length, draft: "", draftCursor: 0 };
}

/** A fresh, empty history: no entries and recall at the live draft — the neutral state a
 * session starts from before any prompt is submitted. */
export function newPromptHistory(): PromptHistory {
  return liveDraft([]);
}

/** Record one submitted prompt and return to the live-draft state. Pure: the input state is
 * untouched, the next state is returned. An empty prompt records nothing — it queues nothing
 * either — and a repeat of the newest entry only resets the recall position. */
export function pushPromptHistory(h: PromptHistory, text: string): PromptHistory {
  const items = text !== "" && h.items[h.items.length - 1] !== text ? [...h.items, text] : h.items;
  return liveDraft(items);
}

/** One step through the history: `older` (Up) walks back from the live line or the current
 * entry, `newer` (Down) walks forward and — past the newest entry — restores the saved
 * draft. Null when the step does nothing: an empty history, or Down while already on the
 * live draft. The recalled cursor lands at the text's end, where a submit or an edit-over
 * begins. Pure, like applyKey. */
export function recallPromptHistory(
  h: PromptHistory,
  current: string,
  cursor: number,
  dir: "older" | "newer",
): { history: PromptHistory; text: string; cursor: number } | null {
  if (dir === "older") {
    if (h.items.length === 0) return null;
    const browsing = h.index < h.items.length;
    const index = browsing ? Math.max(0, h.index - 1) : h.items.length - 1;
    const text = h.items[index]!;
    return {
      history: browsing
        ? { items: h.items, index, draft: h.draft, draftCursor: h.draftCursor }
        : { items: h.items, index, draft: current, draftCursor: cursor },
      text,
      cursor: text.length,
    };
  }
  if (h.index >= h.items.length) return null; // already on the live draft
  const index = h.index + 1;
  if (index < h.items.length) {
    const text = h.items[index]!;
    return {
      history: { items: h.items, index, draft: h.draft, draftCursor: h.draftCursor },
      text,
      cursor: text.length,
    };
  }
  // Back past the newest entry: the saved draft returns, cursor and all, and browsing ends.
  return {
    history: liveDraft(h.items),
    text: h.draft,
    cursor: h.draftCursor,
  };
}

/** Hand the prompt line over to another editor (role-prompt or budget mode) mid-recall: if
 * history browsing is in flight, the recalled entry on the line is swapped back for the
 * draft the arrows saved — with its cursor — and the recall state resets, so the other
 * editor saves the text the operator was actually writing and no stale index or draft
 * survives the switch. Not browsing: nothing changes, the same history comes back. Pure. */
export function settlePromptRecall(
  h: PromptHistory,
  current: string,
  cursor: number,
): { history: PromptHistory; text: string; cursor: number } {
  if (h.index >= h.items.length) return { history: h, text: current, cursor };
  return {
    history: liveDraft(h.items),
    text: h.draft,
    cursor: h.draftCursor,
  };
}

/** Put the history back to the live-draft state after a mode switch restored a saved draft:
 * the restored line is the draft now, so the next Up saves it afresh instead of resuming a
 * stale browse (whose saved draft could belong to the other editor's line). Pure. */
export function resetPromptRecall(h: PromptHistory): PromptHistory {
  return liveDraft(h.items);
}
