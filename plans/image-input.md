# Image input — know which models can read images, stop blind reads, rerun on one that can

**Partly retired 2026-10-26** by [subtract.md](subtract.md) (Subtract part 5/6): the doctor's live
capability probe, its cache, `--reprobe` and the failed-probe alert are gone; a claim in
models.json is trusted as written.

**Reroute restored 2026-10-28** (user decision): Subtract parts 5g/6 and 5h/6 had also deleted
the peer-tier reroute and its surfaces; the user saw the amber `images` alert with a vision
`strong` tier configured and asked that text-only roles fall back to it. Both parts were reverted
(blind-read reroute, attachment preflight, `image_reroute` event and report tallies, the
blue/amber alert, the role-page line and the submit notice). The reroute outlives the tier map:
Subtract part 5e/6 moves its target to an `images` model entry, and part 5v/6 removes its
fallback regime together with the budget fallback.

Planned 2026-10-15 · requested by user · decisions settled with the user the same day (end of file)

## Goal

Tumwater knows, for every model a seam can run, whether it reads images, and acts on it:

1. `tumwater doctor` checks that every model that **claims** image input really reads an image,
   with a live probe.
2. When a loop's model **does not** claim image input, the dashboard and the TUI say so. A tick
   whose agent reads an image on such a model fails, instead of working on as if it had seen the
   image.
3. When that tick fails and another configured tier (say `strong`) can read images, the tick
   runs again on that model.

## Motivation

- **pi hides a blind read.** When the current model's `input` lacks `"image"`, pi's `read` tool
  still returns the image, with a note: `[Current model does not support images. The image will
  be omitted from this request.]` (pi 1.2.0, `dist/core/tools/read.js:40-45`). pi-ai then swaps
  the image for `(tool image omitted: model does not support images)` when it builds the request
  (`pi-ai/dist/api/transform-messages.js:19-37`). Nothing errors: the run goes on and the agent
  answers about a picture it never saw. `modelFallbackVerdict` scores the run "answered".
- **A claim can be wrong, and nothing checks it.** pi takes image support from `input` in
  `~/.pi/agent/models.json`, and a custom model without `input` is text-only
  (`provider-composer.js:105`). Today's file claims images for
  `huggingface/deepseek-ai/DeepSeek-V4.1-Flash:deepinfra` but not for the same model without the
  `:deepinfra` pin. At least one of those claims is wrong. When a claim is wrong, pi sends the
  image and the provider either rejects it (a 4xx, which becomes `configError`) or drops it
  without a word.
- **Images reach ticks through attachments.** A GUI drop/paste or `tumwater prompt --attach`
  saves the file and adds an `[image attached: <path>]` line that the agent reads with its read
  tool (src/inbox/inbox-attachments.ts). In the retained logs (2026-10-15), the only image reads
  are 2 by the claude director (strong tier), and no pi run read an image. The feature matters most when tiers differ in what they can read, such as a
  text-only `default` tier with a vision `strong` tier, or a text-only free fallback at the cap.
- **Tumwater cannot see capabilities today.** `PiModelDef` (src/pi/pi-models.ts) keeps only `id`
  and `cost`. Nothing reads `input`. No path moves a tick to another *primary* tier: the model
  fallback (src/loop/model-fallback.ts) and the budget fallback both move only to the free
  fallback pairs.

## Design

### Capability: what a seam claims, and what doctor verified

One resolver, `seamImageInput(seam) → true | false | null`, in a new src/agent/image-input.ts.
It lives at runtime level because it needs the backend registry:

- **claude:** `true` for every model. A new optional `AgentBackend.imageInput?(model)` hook keeps
  the rule with the backend. The claude adapter answers true; Claude models accept images and
  Claude Code's Read tool returns them as image blocks.
- **pi:** from the model's `input` in pi's models.json. `readPiProviders` keeps the field
  (`PiModelDef.input`).
  - Includes `"image"` → true.
  - Present without it, or absent → false. This matches pi's own default.
  - Not in models.json at all (pi's built-in catalog) → the images column the doctor last saved
    from `pi --list-models` (`.tumwater/state/pi-listed-models.json`); a pair that listing does
    not name reads `null`, unknown.
- **Effective** = claimed **and not** a failed doctor probe (below). A failed probe overrides a
  claim. A passed probe never overrides a text-only claim, because pi strips the image anyway.

**Reroute target:** `imageRerouteTarget(config, role, regime) → ResolvedModelConfig | null`.

- Walk the tick's tier through the existing borrow order, skipping the tier itself: small →
  default → strong; default → strong → small; strong → default. A strong-tier seam (plan,
  director) never drops to small, for the same reason as the budget fallback (`BORROW_ORDER`,
  src/config/config-views.ts).
- Take the first tier whose model has effective image input. The target is that tier's
  top-level model, built the way `resolverConfig` builds strong (`withModelOverrides(config,
  tier, {})`). A role's own raw-selector pin does not carry over.
- **Regime:** look among the primary tiers normally. While the budget gate is on fallback, or the
  role is in a model-fallback episode, look only among the free fallback pairs
  (`resolveTierFallbacks`). A reroute must never spend past the cap.

### Doctor: an "image input" check with a live probe

A new check, `image input`, follows `tier models` in src/doctor/doctor.ts. It covers the same
seams as `seamPairs` (the tiers, enabled roles, and the reviewer) plus the tiers' fallback pairs.

**The probe:** for each pi seam that claims image input, doctor shows the model an image and
asks what it says.

- **The image:** a PNG built in-process showing a random 4-digit code, drawn with a built-in 5×7
  digit bitmap scaled up, black on white. Encoding uses `zlib.deflateSync` plus a hand-rolled
  CRC-32 (`zlib.crc32` is newer than the `>=20.3` node floor). No new dependency.
- **The run:** the resolved pi binary, in the environment a real run gets (same
  `PI_CODING_AGENT_DIR`, so the same models.json):
  `pi --print --mode json --no-session --no-tools --no-mcp --provider P --model M --thinking <seam level> @<png> "Reply with only the 4-digit number shown in the image."`
  Part 2 confirms first that `@image` arguments reach the model in `--print` mode
  (`dist/cli/file-processor.js`).
- **Pass:** the final assistant text contains the code.
- **Wrong answer:** retry once with a fresh code, since a misread is not blindness. Two wrong
  answers fail the probe. So does a 4xx on the request.
- **Could not verify:** a timeout, spawn failure, 429, 5xx, or connection error. These results are
  not cached.
- **claude seams** are not probed. They are reported as "reads images (claude backend)".

**The cache:** `.tumwater/state/image-probes.json`, keyed by agent/provider/model. Each entry
holds the verdict, the detail (the model's answer or the error), the time, and the claim it
tested. A verdict stays valid for 7 days, and only while the claim is unchanged.

**Who probes:**

- `tumwater doctor` in a terminal probes each claimed model that has no valid cached verdict.
  `--reprobe` re-probes all of them.
- The TUI Health tab (src/ui/tui/tui-keys.ts:363) and the dashboard's doctor endpoint
  (src/gui/gui-endpoints.ts:322) also call `runDoctor`. They must not spend a model call on every
  refresh, so they read cached verdicts only, and an unprobed model reads "not verified yet — run
  `tumwater doctor`". `runDoctor` takes a `probeImages: "missing" | "all" | "never"` option for
  this; it defaults to `"never"`.

**Levels:**

- **fail:** a model that claims images failed the probe. The line names the model, what it
  answered or the error, and the fix: remove `"image"` from its `input` in models.json, or fix the
  endpoint, then run `tumwater doctor --reprobe`.
- **warn:** a probe could not run, an enabled loop's model is text-only with no reroute target,
  or no seam can read images.
- **ok:** otherwise. The line lists which models read images (with the verified date) and which
  loops are text-only and where they reroute, e.g. `default text-only (huggingface/…) — reroutes
  to strong (claude-opus-5-5)`.

### Detecting a blind read

pi is the only backend that needs a detector. Claude models read images, and the claude
translator drops tool-result content anyway (src/agent/claude/claude-stream.ts:267-281).

`PiStreamParser.feedLine` (src/pi/pi-stream.ts) sees `tool_execution_start {toolName, args}` and
`tool_execution_end {result}` but ignores the result's content. It gains these rules:

- **An image read:** a `read` end whose `result.content` holds an `image` block, or a text block
  starting `Read image file [`. Its path is the matching start's `args.path`.
- **A blind read:** the result text carries pi's note `[Current model does not support images`,
  **or** the run's seam has effective image input `false`. The second case catches a claim that
  doctor's probe proved false, where pi sends the image and adds no note.
- **Not blind:** pi's `[Image omitted: could not be converted…]` / `…resized…` notes are
  processing failures, not a capability gap.

On a blind read the runner (src/agent/run-agent.ts) kills an **authoring** run at once, through
the same `terminateChild` the watchdogs use, so the agent does not go on working from a picture it
never saw. Gate runs (the reviewer, the conflict resolver) only log the read in this version.

### Failing the tick

- `PiRunResult.imageBlind = { path }`, with the error message `read <path>, but <model> cannot
  read images`.
- `resolveTickVerdict` (src/tick/tick-verdict.ts) gets a branch right after the `budgetCapped`
  one, before the refusal and dirty-tree checks.
- **With no reroute target:** the result is `error`, and `lastError` says exactly that. The error
  backoff and streak apply as usual, and a queued prompt is requeued as with any error.
- `modelFallbackVerdict` treats `imageBlind` as `"inconclusive"`. It is not a provider failure,
  and it says nothing about whether the provider is healthy.

### Rerunning on a model that can read images

With a target, the tick ends `aborted` with a new resume cause, `image-reroute`, added to
`ResumeCause` (src/prompt/prompt-followup.ts:25), `TickOutcome.resumeCause`, and
`LoopState.resumeCause`.

- **The aborted tick:**
  - sets a one-shot `LoopState.imageReroute = { tier, model, from, path }`;
  - sets `nextRunAt` to now;
  - requeues the prompt through `requeueForResume`.
- **The next tick:**
  - `tickPhase` (src/loop/loop-tick.ts:139-153) uses the target's config in place of the
    primary/fallback choice. `LoopRunner.runConfig` and `setTickPair` read the same field, so
    holds and the loop row agree.
  - The field clears at tick start, and `tick_start` records the model with `reroute: "image"`.
- **Always a fresh session over the kept worktree** (the `budget-capped` handoff path, via
  src/tick/tick-resume.ts), never `--continue`:
  - the old session carries pi's "image omitted" note;
  - a switch to another backend cannot resume anyway.

  The handoff note says: *an earlier run on <model> stopped when it read <path>, because that
  model cannot read images; its edits are in your worktree, so review `git diff` and finish or
  discard them; this model can read images, so read the image again.*
- **Director:** director ticks never resume, so its requeued prompt runs fresh on the target.
- **One hop:** a blind read during a rerouted tick fails that tick. There is no second reroute.

### Attachments: decide before the run

A prompt with `[image attached: …]` lines needs images before any run starts, so tumwater can
decide at model choice instead of spending a tick to learn it:

- **Preflight:** in `tickPhase`, peek at the loop's next prompt (`peekPrompt` /
  `peekRolePrompt`, which already exist for the preview path). If it carries image lines and the
  seam is text-only, start on the reroute target right away (`image_reroute`, `preflight:
  true`). With no target, fail the tick without spending a run.
- **At submit:** the GUI endpoint and `tumwater prompt --attach` both go through
  `submitRolePrompt`.
  - When no configured model can read images for the target, they refuse the images, naming the
    fix.
  - When the target loop's model is text-only but a reroute target exists, they accept the images
    with a notice, e.g. "feature's model can't read images; this prompt runs on strong
    (claude-opus-5-5)".

### Surfaces

- **Status snapshot / `status --json`:** per enabled loop, `imageInput: true | false | null` and
  `imageReroute: "<tier> (<model>)" | null`, plus the cached probe failures.
- **Fleet alert `images`** (src/ui/fleet-alerts.ts, so both the dashboard banner and the TUI's
  attention lines):
  - **blue** when every text-only loop has a target: "feature, bugfix and 3 more run on models
    that can't read images" — "A tick that reads an image stops and reruns on strong (…)".
  - **amber** when some text-only loop has no target: "No configured model can read images for
    …" — "A tick that reads an image fails, and image attachments to these loops are refused.
    Declare image input on a vision model in pi's models.json, or point a tier at one."
  - **amber** when a model claims images but failed doctor's probe.
  - **No alert** when every enabled loop reads images, as in today's all-claude fleet.
- **Role page** (`tumwater role <id>` and the dashboard's role panel): `Images: no — reruns on
  strong (…)`.
- **GUI composer:** the submit-time notice or refusal shows under the image chips, read from the
  status payload.
- **Feed** (src/events/event-format.ts):
  - `image_blind` and `image_reroute` lines;
  - the resume renderer, which today special-cases only `cut-off` and `handoff`, learns
    `image-reroute`.

### Events

- `image_blind {loop, tick, path, model, action: "reroute" | "fail" | "logged"}`
- `image_reroute {loop, tick, from, to, tier, preflight}`
- `tick_start.reroute: "image"` on the rerouted tick.

## Phases (one PLANS.md part each)

1. **Capability model + offline doctor check.** `PiModelDef.input`, `AgentBackend.imageInput`,
   `seamImageInput`, `imageRerouteTarget` (pure, regime-aware), and the `image input` doctor check
   reporting claims and coverage. No probe, no runtime behavior change.
2. **Doctor live probe + cache** (requires 1). PNG generator, pi probe runner, cache file,
   `--reprobe`, `runDoctor`'s `probeImages` option (CLI "missing", TUI/GUI "never"), and effective
   capability honoring failed probes.
3. **Detect blind reads and fail the tick** (requires 1). Parser rules, runner kill,
   `PiRunResult.imageBlind`, the verdict branch, `modelFallbackVerdict`, and the `image_blind`
   event and its feed line.
4. **Reroute** (requires 3). `LoopState.imageReroute`, the `image-reroute` resume cause and
   handoff note, model choice in `tickPhase` / `runConfig` / `setTickPair`, `tick_start.reroute`,
   the attachment preflight, and the `image_reroute` event.
5. **Surfaces** (requires 4). Status fields, the `images` alert, the role page line, and the
   submit-time notice/refusal in `submitRolePrompt`, the composer, and `prompt --attach`, plus
   docs (README.md, docs/cli.md, docs/backends.md).

Parts 2 and 3 touch disjoint areas (doctor; pi stream / runner / verdict), so they can run in
parallel once part 1 lands. Part 5 waits for part 4 so the alert and the submit notice never
promise a rerun that does not happen yet.

## Files touched

src/pi/pi-models.ts (`input`), src/agent/agent-backend.ts (`imageInput` hook),
src/agent/claude/claude-backend.ts, src/pi/pi-backend.ts, new src/agent/image-input.ts,
src/config/config-views.ts (export the borrow order / a tier-config builder),
src/doctor/doctor-model-checks.ts, src/doctor/doctor.ts, new src/doctor/image-probe.ts (PNG +
probe), src/paths.ts (cache path), src/cli.ts and src/cli/help.ts (`--reprobe`),
src/ui/tui/tui-keys.ts and src/gui/gui-endpoints.ts (`probeImages: "never"`), src/pi/pi-stream.ts,
src/pi/pi-run-result.ts, src/agent/run-agent.ts, src/tick/tick-verdict.ts,
src/tick/tick-outcome.ts, src/tick/tick-apply.ts, src/tick/tick-resume.ts,
src/prompt/prompt-followup.ts, src/loop/loop-state.ts, src/loop/loop-tick.ts, src/loop/loop.ts,
src/loop/model-fallback.ts, src/events/events.ts, src/events/event-format.ts,
src/inbox/inbox-submit.ts, src/inbox/prompt-commands.ts, src/gui/gui-prompt-commands.ts,
src/status/status-roles.ts, src/ui/fleet-alerts.ts, src/roles/role-render.ts,
src/ui/gui/gui-client-composer.ts, README.md, docs/cli.md, docs/backends.md, and their tests.

## Acceptance criteria

- `seamImageInput` reads `true` for any claude seam; for pi, it follows models.json `input`
  (absent → false); for a pair missing from models.json, it reads `null`.
- `imageRerouteTarget` follows the borrow order, never takes strong down to small, and with the
  budget gate on fallback considers only free fallback pairs.
- `tumwater doctor` with a fake pi that answers the probe code passes and caches the verdict.
  With a fake pi that answers wrong twice, it fails, naming the model and the models.json fix. A
  second run within 7 days spawns no probe. `--reprobe` spawns one again. The Health tab and the
  GUI doctor endpoint never spawn a probe.
- The generated probe PNG is valid: signature, IHDR, IDAT, IEND, correct CRCs, and it decodes to
  the drawn digits.
- With a fake pi emitting a `read` result carrying pi's non-vision note, the authoring run is
  killed and the tick ends `error` (no target) or `aborted`/`image-reroute` (target). The
  `image_blind` event names the path and model.
- The same read on a seam whose claim failed the probe (no note) is also caught.
- A rerouted tick runs a fresh session on the target model over the kept worktree, its prompt
  carries the handoff note, `tick_start` records `reroute: "image"`, and the tick after it is
  back on the loop's own tier.
- A blind read during a rerouted tick fails it without a second reroute.
- A queued prompt with an image line on a text-only seam starts directly on the target, with no
  failed tick first.
- With no image-capable model configured, `tumwater prompt --attach` and the GUI endpoint refuse
  images. With a target, they accept them and say where the prompt will run.
- The `images` alert appears blue or amber per the rules above, and no alert appears for an
  all-claude config.

## Out of scope

- Probing claude seams. Every Claude model reads images, and a probe would spend subscription
  window to confirm it.
- Probing text-only claims to find models that could read images but don't declare it.
- Probing automatically at `tumwater run` or on a schedule.
- Editing models.json for the operator.
- Images reached other ways: bash, a Python OCR script, image URLs.
- Rerouting the reviewer or the conflict resolver; they only log.
- Trimming the base64 image pi writes into the raw `<role>.pi.jsonl` log.

## Decisions (user, 2026-10-15)

1. **When doctor probes:** terminal `tumwater doctor` probes unverified models by default,
   cached 7 days, `--reprobe` to force. The TUI Health tab and the dashboard never probe.
   (Rejected: an opt-in `--probe-images` flag.)
2. **How the rerun treats the failed tick's work:** hand off over the kept worktree: a fresh
   session on the target, same task. (Rejected: discard the worktree and start over.)
3. **Attachments:** preflight at model choice, and refuse at submit when nothing can read
   images. (Rejected: the literal fail-then-retry for attachments too.)
4. **Which model the reroute picks:** the budget-fallback borrow order; strong never drops to
   small, and only free fallback pairs qualify at the cap. (Rejected: strongest capable tier
   first.)
