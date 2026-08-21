# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed.

## Open

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
