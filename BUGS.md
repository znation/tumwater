# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed.

## Open

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
