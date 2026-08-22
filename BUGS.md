# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed.

## Open

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

## Fixed

### LM Studio logs flooded with WARN lines while loops run (reported 2026-08-20, resolved 2026-08-21)

**Resolution:** Captured the exact text from `~/.lmstudio/server-logs`:
`Reasoning setting 'high' is not supported by model 'unsloth/Qwen3.8-27B-GGUF/…'. Supported
settings: 'on', 'off'. Falling back to reasoning setting 'on'.` — suspected cause 1 (unsupported
thinking level), and it is benign: pi forwards its configured thinking level, the GGUF model only
exposes an on/off reasoning toggle, and LM Studio falls back to `on` with reasoning still enabled.
One WARN per request, no behavioral impact. Documented in README ("Notes on local model servers")
with the silencing option (configure a supported thinking level). No code change warranted at the
automaton layer.

### Spurious warning "pi finished without changes and without declaring nothing-to-do" (reported 2026-08-21, fixed 2026-08-21)

**Fix:** Sentinel detection now covers the whole reply: `PiStreamParser` sets a
`declaredNothingToDo` flag whenever *any* assistant message contains the sentinel (previously only
the last message's text was kept in `finalText`, so a declaration in an intermediate turn was lost
to a later closing remark — cause 1). The flag is propagated as `PiRunResult.nothingToDo` and
checked by `runTick` instead of `isNothingToDo(pi.finalText)`; `finalText` remains the last message
for `extractSummary`. The warning is now diagnosable: an abnormal stopReason (e.g.
`(stopReason=length)` for a truncated final reply — cause 3) and/or "no assistant text" are appended
to the event message. Cause 4 (lenient `ok` on non-zero exit with text) was deliberately left as-is:
it changes error-event behavior and is worth its own decision.
Regression tests: parser-level sentinel-survival test in `test/pi.test.ts`; end-to-end tick tests in
`test/loop.test.ts` asserting no spurious warning when the sentinel appears mid-run, plus the new
diagnostic suffixes. Files: `src/pi.ts`, `src/loop.ts`, `src/types.ts`, `test/pi.test.ts`,
`test/loop.test.ts`.

_None else yet._
