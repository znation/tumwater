# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed.

## Open

### Spurious warning "pi finished without changes and without declaring nothing-to-do" (reported 2026-08-21)

**Symptom:** Intermittently, the recent activity log (TUI/GUI event feed, `events.jsonl`) shows
`<role> warning: pi finished without changes and without declaring nothing-to-do`. The user sees it
as confusing noise: some of these ticks are ones where pi genuinely found nothing to do but did
declare it, so the warning is at least sometimes wrong — and when it is right (model misbehaved),
the message gives no clue why.

**How to reproduce:** Run `automaton run` with real pi for a while; the warning appears on random
ticks. The core defect is unit-testable without pi: feed `PiStreamParser` two assistant
`message_end` events — first text `AUTOMATON_NOTHING_TO_DO`, then any other non-empty text (e.g.
"all done") — and observe that `finalText` is only the last message, so `isNothingToDo(finalText)`
is false even though pi declared nothing-to-do. That is exactly the state `runTick`
(`src/loop.ts`) warns on: pi ok + worktree clean per `isDirty` (`git status --porcelain`) + no
sentinel in `finalText`.

**Suspected causes (in decreasing order of likelihood):**
1. **Sentinel lost because only the last assistant message is kept.** `PiStreamParser.feedLine`
   (`src/pi.ts`) overwrites: `if (text.trim()) this.finalText = text;`. In a multi-turn run, if
   the model declares nothing-to-do in an intermediate turn and then emits another assistant
   message afterwards (e.g. one more tool call plus a closing remark), the sentinel is gone by the
   time `runTick` checks it → spurious warning.
2. **Model non-compliance.** The model ends without emitting the exact sentinel line (paraphrases
   instead). The prompt does instruct it explicitly (`COMMON_RULES`, `src/prompt.ts`), but weaker
   models or long runs may not comply. This is a *correct* warning, but indistinguishable from
   cause 1 in the log.
3. **Truncated final reply.** If pi's last message hits max output tokens (stopReason `length`),
   the sentinel gets cut off → no changes + no sentinel → warning with zero diagnostic info about
   why. `PiRunResult.stopReason` is captured by the parser but never used in `loop.ts` or in the
   event message.
4. **Lenient `ok`.** A non-zero pi exit code *with* non-empty text counts as success (close handler,
   `src/pi.ts`: `failed = … || (code !== 0 && !parser.finalText.trim())`) with no errorMessage, so a
   failed run can surface as this warning instead of an error event.

**Fix guidance:**
- Make sentinel detection cover the whole reply: accumulate all assistant text in
  `PiStreamParser` (or set a flag when any message contains the sentinel) and check that in
  `runTick`, while keeping `finalText` as the last message for `extractSummary`. This kills cause 1.
- Make the warning diagnosable: include `stopReason` in the event message (e.g. append
  `(stopReason=length)` when set), so truncated replies are distinguishable from plain
  non-compliance. Consider a distinct message when `finalText` is empty.
- Optionally tighten cause 4 (treat non-zero exit as failure even with text, or at least surface
  stderr) — judge whether that belongs in this fix; it changes error-event behavior.
Files: `src/pi.ts`, `src/loop.ts` (and `test/pi.test.ts`).

### TUI: status table wider than terminal — rows wrap to two lines, misaligning everything (reported 2026-08-20)

**Symptom:** In `automaton tui`, the live-updating loop status table is sometimes rendered wider
than the current terminal. Each affected row then wraps onto a second visual line, so columns no
longer line up and the whole screen looks misaligned. It appears intermittently — only when some
cell's content makes the table exceed `process.stdout.columns` (e.g. right after a tick with a long
summary, or while a loop is working with a long state cell).

**How to reproduce:** Run `automaton run` with several roles enabled and let ticks complete so at
least one loop has a non-trivial `last result — <summary>` (summaries are up to ~72 chars) and/or a
working loop whose state cell is long (`working 5m03s · turn 4 · ctx 12.3k · Bash`, plus
`no pi output for …`). Open `automaton tui` in a terminal narrower than the rendered table (e.g.
80–120 columns). The table rows wrap mid-row; the wrapped continuation lines are not column-aligned,
misaligning the rest of the screen. Resizing the terminal wider makes it disappear — confirming
the table is content-sized, not terminal-sized.

**Suspected cause:** `renderStatus` (`src/status.ts`) sizes every column to its widest cell with no
cap: `widths = cols.map((c, i) => Math.max(c.length, ...rows.map(...)))`. The two unbounded cells
are:
- `state`: `workingDetail()` can exceed ~60 chars (elapsed · turn · ctx · tool · quiet-for suffix).
- `last result`: `${lastResult} — ${lastSummary}` where the summary is up to ~72+ chars.

Worst-case table width easily exceeds 180 columns. Neither `renderStatus` nor its TUI caller
(`src/tui.ts` `render()`) knows or enforces the terminal width, so rows longer than
columns wrap in the terminal instead of being truncated. The one-shot `automaton status` command
has the same unbounded-width behavior (shared function).

**Fix guidance:** Make the table width-aware: pass a max width into `renderStatus` (TUI passes
`process.stdout.columns`; the CLI can pass its own stdout columns or leave it uncapped) and truncate
wide cells with an ellipsis so total row width ≤ max. Truncate the widest offenders first (`last
result`, then `state`) while keeping fixed narrow columns intact; keep the header/separator rows in
sync. This is closely related to the vertical-overflow bug below (same root cause: render output not
bounded by terminal size) — fix both together if convenient, and make sure the TUI's line-budgeting
then counts visual lines correctly.
Files: `src/status.ts`, `src/tui.ts` (and possibly `src/cli.ts` for the one-shot command).

### TUI: status table scrolls off the top of the screen as recent activity grows (reported 2026-08-20)

**Symptom:** In `automaton tui`, once the "recent activity" list has accumulated a number of
events, the loop status table at the top scrolls off the top of the terminal — only the tail of
the event list and the prompt input line stay visible. It gets progressively worse as more events
accumulate.

**How to reproduce:** Run `automaton run` with several roles enabled until `.automaton/events.jsonl`
has a healthy number of tick/merge events, then open `automaton tui` in a terminal narrower than the
rendered table (e.g. 80 columns). Watch for a few seconds: as the recent activity list fills toward its
budget, each per-second re-render pushes the top of the screen up until the status table is gone.

**Suspected cause:** `src/tui.ts` `render()` budgets by *logical* lines, not *visual (wrapped)* lines:
- `statusLines = status.split("\n").length` counts each table row as one line, but rows are built with
  content-sized columns and no truncation (`renderStatus`, `src/status.ts`). The `last result` column
  holds the full tick summary (~72 chars) and a working loop's `state` cell can be long too
  (`working 5m03s · turn 4 · ctx 12.3k · Bash`), so on an 80-col terminal each row wraps to 2+ visual lines.
- Event lines from `formatEvent` (`src/events.ts`) also exceed 80 cols: `merged … — <summary>` and
  `prompt_enqueued: <preview up to 80 chars>` both wrap.
- `eventBudget = Math.max(3, rows - statusLines - 6)` therefore underestimates total height; the render
  exceeds `process.stdout.rows`, and because the TUI redraws every second with clear-screen + home,
  the overflow auto-scrolls the table off the top. More events in the list → more wrapped lines →
  worse, matching the report.

**Fix guidance:** In `src/tui.ts`, compute each line's visual height as `ceil(displayWidth(line) / cols)`
(stripping ANSI escapes first) and pick recent events so their *total wrapped* height fits the remaining
budget — not merely count ≤ budget. Optionally add width-aware truncation of wide cells (especially
`last result`) in `renderStatus` (`src/status.ts`, e.g. a max-width parameter with ellipsis); note that
function is shared with the one-shot `automaton status` table, so keep that output sensible too.
Files: `src/tui.ts`, possibly `src/status.ts`. (The browser GUI was checked — it has no such fixed-height
budget; this is TUI-only.)

### LM Studio logs flooded with WARN lines while loops run (reported 2026-08-20)

**Symptom:** With pi pointed at a model served by LM Studio, the LM Studio server log fills up
with `[WARN]` lines during normal operation (user's report: `2026-08-20 22:25:26 [WARN] ...`,
repeated many times). The pasted line was truncated to timestamp + level — capture the full WARN
message text first; it determines which suspected cause below applies.

**How to reproduce:** Configure pi for an LM Studio model (OpenAI-compatible endpoint, via pi's
models.json or `--provider`/`--model` in automaton.json), run `automaton run`, let a few roles
tick, and watch the LM Studio server log. Warnings appear repeatedly during ordinary ticks.

**Suspected causes:**
1. Unsupported request parameters — pi may send thinking/reasoning fields (e.g. `reasoning_effort`)
   that LM Studio doesn't understand. Check whether automaton.json sets `thinking` and what pi
   sends for the chosen model; if so, set `reasoning: false` / a proper `thinkingLevelMap` on the
   model in pi's models.json.
2. Context window overflow/truncation — the loaded context length is smaller than prompt + session,
   so LM Studio warns and truncates. Each tick starts a fresh pi session (`automaton-<role>-<tick>`),
   so history does not accumulate across ticks; check whether a single tick's prompt already exceeds
   the model's context.
3. Aborted streams — up to `maxConcurrent` (4) pi processes stream from LM Studio at once, and the
   harness SIGTERMs pi on timeout/shutdown (`src/pi.ts`); severed in-flight streams may be logged as
   warnings by LM Studio.

**Fix guidance:** Capture the exact WARN text first (reproduce or ask the user), then fix at the
right layer: pi's models.json model config for parameter/context issues, or `src/pi.ts` / config
defaults if automaton is sending something inappropriate. Note the LM Studio compatibility finding
in README.md once resolved.

## Fixed

_None yet._
