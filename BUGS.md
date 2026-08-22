# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed.

## Open

_None yet._

## Fixed

### TUI: status table wider than terminal — rows wrapped and misaligned (reported 2026-08-20, fixed 2026-08-21)

**Fix:** `renderStatus` now takes a max width (the TUI passes `process.stdout.columns`, the
one-shot status command its own TTY width). When the content-sized table overflows, the
`last result` column shrinks first, then `state` (each to a 12-char minimum), and every cell and
line is ellipsis-clipped so no rendered line exceeds the terminal width — rows can no longer wrap.
Tests: test/status-render.test.ts. Files: src/status.ts, src/tui.ts, src/cli.ts.

### TUI: status table scrolled off the top as recent activity grew (reported 2026-08-20, fixed 2026-08-21)

**Fix:** Same root cause (unbounded line widths breaking the logical-line height budget). Every
TUI line — table (via width-aware renderStatus), event lines, flash/hint, and the input line
(which now shows its tail when long) — is clipped to the terminal width, so one logical line is
exactly one visual line and the existing height budget is exact; the table stays pinned at the
top. Files: src/tui.ts, src/status.ts.

### LM Studio logs flooded with WARN lines while loops run (reported 2026-08-20, resolved 2026-08-21)

**Resolution:** Captured the exact text from `~/.lmstudio/server-logs`:
`Reasoning setting 'high' is not supported by model 'unsloth/Qwen3.8-27B-GGUF/…'. Supported
settings: 'on', 'off'. Falling back to reasoning setting 'on'.` — suspected cause 1 (unsupported
thinking level), and it is benign: pi forwards its configured thinking level, the GGUF model only
exposes an on/off reasoning toggle, and LM Studio falls back to `on` with reasoning still enabled.
One WARN per request, no behavioral impact. Documented in README ("Notes on local model servers")
with the silencing option (configure a supported thinking level). No code change warranted at the
tumwater layer.

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
