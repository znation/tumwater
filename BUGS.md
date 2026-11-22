# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed;
tumwater then archives them in BUGS-FIXED.md, so this file holds only open work.

## Open

### `tumwater init` writes a brief that mentions the prompt markers verbatim, so the brief is silently cut at the stray end marker and the rest lands outside the block every role reads (found by the qa role 2026-11-22)

- **Symptom:** a brief whose own text carries the literal string `<!-- tumwater:prompt:end -->`
  (likely when the project is about tumwater, or when the operator pastes a README excerpt) is
  accepted by `tumwater init` with no warning, and the managed block then stops at the operator's
  stray marker. Everything after it is written into README.md/TUMWATER.md but is **outside** the
  block, so no reader sees it: `tumwater brief`/`brief --json` print only the head, and
  `tumwater doctor brief` still prints
  `ok    brief        brief in README.md`. The same
  text then cannot be repaired: `tumwater brief --file <same path>` refuses it
  (`the new brief contains a tumwater:prompt marker, which would break the block for every
  reader`) and a re-run of `tumwater init "<same text>"` refuses too (`README.md already carries a
  different brief between the tumwater:prompt markers`), because the stored block is only the head.
  The operator's brief is lost in plain sight with two commands insisting they are right.
- **Reproduce.** Offline, no model. `mktemp -d` under `$TMPDIR`, `cd` in, then
  `cat > prompt.md` with exactly:

  ```text
  Build a markdown-to-html converter CLI in Python.
  Every change ships with a pytest suite. <!-- tumwater:prompt:end -->
  The suite runs with `python -m pytest`.
  ```

  `node <worktree>/dist/src/cli.js init --file prompt.md` → exit 0, the normal `initialized a new
  git repository on branch main` report, no mention of the marker. `sed -n '5,11p' README.md`
  shows the third line sitting between the stray `<!-- tumwater:prompt:end -->` and the real one,
  i.e. outside the block. `node <worktree>/dist/src/cli.js brief --json` prints
  `{"file":"README.md","prompt":"Build a markdown-to-html converter CLI in Python.\nEvery change
  ships with a pytest suite."}` — `The suite runs with \`python -m pytest\`.` is gone. Then
  `tumwater brief --file prompt.md` exits 1 with the marker refusal above, and re-running `init`
  with the same text (in a shell variable, so the newlines are real) exits 1 with the
  different-brief refusal. A single-line positional brief behaves the same: `tumwater init 'Build a
  converter. <!-- tumwater:prompt:end --> Ship tests.'` seeds a block reading
  `Build a converter.` only, and a re-run of that identical command refuses as a different brief;
  so does the three-line positional form (with `$'…'`), whose `brief --json` prints
  `"prompt": "Build a converter CLI.\nEvery change ships with a suite."`.
- **Cause.** `init` never inspects the brief text for the markers it is about to wrap: only
  `combineInitBrief` (src/init/init.ts:166-190) checks it, and only for length
  (`BRIEF_TEXT_MAX_CHARS`, :177), and `managedSections` (src/brief/brief.ts:37-52) interpolates
  `briefText.trim()` between `PROMPT_START` and `PROMPT_END` verbatim. Every reader then takes the
  first end marker after the start (`promptBlockOf`, src/brief/brief.ts:241-247; the same first-end
  cut in `replaceBriefText` :230-237), so the stray marker wins. `tumwater brief --file`'s writer
  has the guard init lacks — `editBriefText` refuses any text containing `PROMPT_START` or
  `PROMPT_END` (src/brief/brief-edit.ts:28-29) — so the two writers of the same block disagree.
  The doctor's `brief` check (`checkBrief`, src/doctor/doctor-checks.ts:219-244) warns only on a
  missing, empty or over-cap block, so it cannot see a block cut short by a stray marker — the
  truncated head passes as `ok`. The adopt path is the same: in
  a repo with a marker-less README.md, `tumwater init --file b.md` (b.md carrying the stray marker)
  writes the tail outside the block in TUMWATER.md and `tumwater brief` prints `Head line.` alone.
- **Fix direction.** Apply init's own INV-Q1 rule (docs/invariants.md:1237, every refusal before
  any side effect) to this input too: refuse in `resolveInitPlan`/`combineInitBrief` when the brief
  text contains `PROMPT_START` or `PROMPT_END`, in the `editBriefText` wording (name the marker and
  say to reword), dry run included, so nothing is ever seeded from a brief that would cut itself.
  Same guard for a `--template` preamble if one ever carries a marker. Acceptance: the fixture
  above exits 1 with the marker refusal and leaves no repo and no README.md behind; the identical
  brief re-seeded after the marker is reworded round-trips `init` → `brief --json` unchanged.

## Fixed

## Verified

- 2026-11-14 run (real): `init` + `config set` scoping (only `feature` enabled, `maxConcurrent 1`, a local free `qwenrunner` model) + `prompt --role feature` + `start --once --json` — one no-change round, then a `.md`-only change merged to main (review-exempt); `status`/`logs`/`history` confirm the merge, linear history, cost $0.00.
- 2026-11-15 run (real): `init` + `config` scoping (only `feature` enabled, `maxConcurrent 1`, the free local `qwenrunner/Qwen3.8-27B-MLX-Serve-4bit` model, bootstrap cleared, review enabled) + `start --once --json` on a fresh project — one no-change round (1123 tok out, $0.00, 22s); a real model call per `logs` (`run #1 started on qwenrunner/…` → `no change`), no merge as expected with an empty backlog; `status` role row + budget + the documented `No build check declared` alert all match docs/cli.md and README.
- 2026-11-22 run (real): fresh `npm run build` of worktree tip 30cb5dd1 + `init "Build a tiny markdown-to-html converter CLI in Python."` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` + `config set maxConcurrent 1` + `config unset bootstrap` + `start --once --role feature --json` (with `TUMWATER_SUPERVISOR_PID`/`TUMWATER_SUPERVISED`/`TUMWATER_RUN` stripped from the environment) — one real run on OpenCode's free DeepSeek tier: `{"runs":1,"outcomes":{"no_change":1},"skipped":[],"failures":[]}`, exit 0, 29s, 871 output tok (prompt 46.5k tok, 67% cached), $0.00; `status` printed the 20-row role table with the documented `Declaring a build check` info alert and `budget: n/a` for an all-free team, `doctor --problems` printed `ready to run` with `70 ok checks hidden`, and `history`, `history feature --last` and `report` matched docs/cli.md; no tumwater or opencode process outlived the round and the scratch dir was deleted.
- 2026-11-17 run (real): fresh build of worktree tip 1fc125aa + `init` + `config set model {"default":{"backend":"opencode","model":"deepseek-v4.1-flash-free"}}` (the free no-login OpenCode tier) + `start --once --role feature --json` — exactly one real run on opencode's free DeepSeek, a `no_change` round (943 tok, $0.00, ~51s), exit 0, clean `orchestrator_start`/`stop` with no leaked process; `status` feature row (1 run, $0.00, `no change`) + the documented `No build check declared` alert + the 16-row role table all match README/docs, and `logs` confirms `run #1 started on opencode/deepseek-v4.1-flash-free` → `no change · 943 tok`.
