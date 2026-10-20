# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### Backend/model split, part 5/5: Retire the namespace spellings as load errors and drop the scalar budget backend (planned 2026-10-19 by user, split 2026-10-19 by the plan role; requires parts 3/5–4/5 landed; touches src/config/model-selector.ts src/config/config-views.ts src/config/config-fallbacks.ts src/config/config-validation.ts src/config/config-aliases.ts src/status/status-budget.ts src/ui/badges.ts docs/config.md docs/backends.md docs/glossary.md test/model-selector.test.ts test/config-validation.test.ts test/config-validation-model.test.ts test/config-views.test.ts test/config-aliases.test.ts test/badges.test.ts)

**Needs review 2026-10-19 by plan: merging this makes the live tumwater.json's `claude/…` model ids a load error, so the operator first migrates it — `model` loses the namespace (`"claude-sonnet-5-5"`, `"strong": "claude-opus-5-5"`) under the existing `"backend": "claude"`, and the pi fallback becomes `{ "backend": "pi", "model": "qwenrunner/qwen3.8-27b" }` (valid once parts 1/5-2/5 land) — then removes this note**

**Goal.** A model id never names a backend: each retired spelling fails the load with a message naming the exact edit (the operator chose no shims), and the fleet-wide scalar `BudgetSlice.backend` goes. Series goal and siblings: part 1/5.

**Approach.**
- `routeModel` (src/config/model-selector.ts) loses rule 1 (`isAgentId(provider)`) and rule 3a (`startsWith("claude-")`): the backend is the explicit backend ?? the top-level `backend` ?? `"pi"`, and claude/opencode take the id verbatim on both paths. `seamKeyedFallbackProvider` (src/config/config-fallbacks.ts) follows the same rule; a fallback step with no `backend` inherits its tier primary's resolved backend (the tier entry's, else the top level's). `seamAgent` keeps its `agent` read; its `isAgentId(seam.provider)` branch goes once no resolved seam carries a namespace provider. `AGENT_IDS`' doc comment drops "doubles as the selector provider namespace".
- `validateConfig`'s raw pass rejects, each naming the value and the fix: a selector whose first segment is a backend id (`claude/claude-opus-5-5` → write `backend: "claude"` beside `model: "claude-opus-5-5"`); a bare `claude-…` id resolved to pi (add `backend: "claude"`, or write `anthropic/claude-…` to keep it on pi); `opencode/…` resolved to pi (write `backend: "opencode"`). Drop the `agent → backend` row from `CONFIG_KEY_RENAMES` (src/config/config-aliases.ts) so a top-level `agent` key is an unknown-key error naming `backend`; `agents → backends` stays.
- Delete `BudgetSlice.backend` (src/status/status-budget.ts, its interface field and `backend: cfg.backend ?? "pi"`); src/ui/badges.ts's `agentDefault` uses the constant `pi default`, and the test/badges.test.ts case passing `backend: "claude"` drops that field and asserts the new label.
- docs/config.md, docs/backends.md and docs/glossary.md drop part 3/5's "still load until part 5/5" sentences and the `agent → backend` rename rows; test/config-aliases.test.ts asserts the `agent` error.

**Acceptance criteria.**
- `grep -rn 'isAgentId(provider)\|startsWith("claude-")' src` finds nothing; each retired spelling (`claude/<id>`, `opencode/<id>` under pi, bare `claude-…` under pi, top-level `agent`) fails `validateConfig` with a message naming the offending value and the edit.
- The migrated form of the team's config in the note above, loaded in a test, resolves `seamsInUse` to claude for every primary seam and `qwenrunner/qwen3.8-27b` on pi for the fallback.
- `backend: "claude"` with no `model` still resolves claude's three tier defaults and `CLAUDE_GATED_MODELS` still lists exactly those three.
- `BudgetSlice` has no `backend` field; `npm test` passes.

### Merge fast-forward: a failed `tumwater.json` write-back after the fast-forward warns instead of throwing out of a merge that already moved main (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/merge/merge-git.ts + test/merge-config.test.ts + docs/invariants.md)

**Goal.** `ffMainToOrWhy` (src/merge/merge-git.ts) runs `git merge --ff-only` on the working-tree arm and then calls `restoreConfigBytes(root, saved)` to write back a live `tumwater.json` that the merged commit untracked. That write (`writeBytesAtomic`) has no `try`, and it runs after the fast-forward has already moved main. When it throws (full disk, EACCES), the error escapes `ffMainToOrWhy` instead of the function returning `null`. All three callers then skip their post-merge steps even though main moved: `tryMerge`'s fast-forward in src/merge/merge-to-main.ts (no `merged` event, no `logNewQuestions`, no `syncRootInstall`), `ffStackToMain` in src/merge/merge-stack.ts (the same three steps for every change in the batch), and the main-revert path in src/baseline/main-revert.ts (no `main_revert` event, no `onReverted` hand-back). Nothing tells the operator that the live config is now missing. Fix it at the one shared site: the write-back failure becomes a warning event, and `ffMainToOrWhy` reports the merge it made.

**Approach.**
1. src/merge/merge-git.ts, `ffMainToOrWhy`, working-tree arm: wrap `restoreConfigBytes(root, saved);` in `try { … } catch (err) { warnEventBestEffort(root, TUMWATER_SOURCE, …) }`, then `return null` as now. Import `warnEventBestEffort` and `TUMWATER_SOURCE` from `../events/events.js`. events.ts imports only paths, files, event-legacy and text, so this adds no import cycle. Message: `` `main fast-forwarded, but writing the live ${CONFIG_BASENAME} back failed: ${errorMessage(err)}; restore it by hand (it is no longer tracked on main)` ``. `CONFIG_BASENAME` and `errorMessage` are already imported. Do not retry, and do not change `restoreConfigBytes` itself: the existing test "a crash mid write-back leaves the live config absent, never torn" pins that it rethrows.
2. Extend `ffMainToOrWhy`'s doc comment with one sentence: the merge has already happened by the time of the write-back, so a failed write-back is a warning event and the function still returns null.

**Files touched.** src/merge/merge-git.ts (`ffMainToOrWhy`), test/merge-config.test.ts, docs/invariants.md.

**Acceptance criteria.**
- New test in test/merge-config.test.ts, "a failed config write-back after the fast-forward warns and still reports the merge". Seed it as "a merge that untracks the config preserves the live file byte-identical" does: `trackedConfigRoot(config)` with any valid config string, then `const sha = await untrackingBranch(root)`. Arm `patchFsMethod("writeFileSync", …)` (already imported from ./helpers/fs-faults.js) so it throws `new Error("disk full")` for any string `file` that starts with `path.join(root, "tumwater.json")` and falls through otherwise. Call `await ffMainTo(root, sha, "main")` and restore the patch in a `finally`. Assert:
  - the call resolves `true`;
  - `headSha(root)` (already imported from ./fixtures/repo-fixtures.js; check its signature before use) equals `sha`;
  - `tumwater.json` does not exist in `root`;
  - `warningMessages(root)` (import from ./fixtures/log-fixtures.js) has exactly one entry, matching `/tumwater\.json back failed: disk full/`.
  Mutation: remove the new `try`. `ffMainTo` then rejects with "disk full", so the test fails.
- The existing test/merge-config.test.ts tests pass unchanged, including "a crash mid write-back leaves the live config absent, never torn" and "the config write-back is restore-only-when-absent: a newer write wins".
- docs/invariants.md: at the END of the file, after every section present when the change is made (CH's sections included, if they have merged), add `## Merge fast-forward: a failed config write-back never undoes a merge`. Under it put `### INV-CI1: a fast-forward that moved main returns success even when the live tumwater.json write-back fails, and logs one warning`, in the Guarantee / Binds / Pinned by layout. Binds: `src/merge/merge-git.ts` (`ffMainToOrWhy`, `restoreConfigBytes`). Pinned by: the new test's name. Before writing, run `grep -n '^### INV-C' docs/invariants.md | tail`. INV-CH1/CH2 are reserved by the backlog-archive plan, and CI was free on 2026-10-20.
- `npm run test:gate` passes. The cited test names exist verbatim (`grep -rF` them in test/).

### Test runner: `--repeat=<n>` reruns a filtered test n times so a timing flake reproduces on demand (planned 2026-10-20 by the steward role; independent of the other entries)

**Goal.** Four of the five newest BUGS-FIXED.md entries (the quarantined `gui --all-interfaces prints the reachable LAN URLs…`, `pollPauseGates: a per-role pause whose shared deadline passes…`, `a killed run leaves no grandchild behind (regression)`, `merge_failed carries the reason mergeFailureReason derives…`) record `Validation gap: no-repro`: a timing race that only fired under load and passed on the same tree. The runner has no way to rerun one test many times, so each fix is confirmed by reasoning alone. A repeat mode lets a fixer (and a quarantine check) see a flake fail or hold across n runs.

**Approach.** In test/test-runner.ts, add a `--repeat=<n>` option beside `--coverage` and `--affected` (same argv-splitting style, e.g. a `splitRepeatArgv`, and the unknown-flag error text updated to name it). It requires at least one file or `file#name` filter (error otherwise) and n a positive integer no larger than 50. The runner invokes the same node --test command n times back to back, stops at the first non-zero exit, and reports which iteration failed. No new npm script: `node dist/test/test-runner.js --repeat=20 'supervisor#grandchild'`.

**Files touched.** test/test-runner.ts, test/test-runner.test.ts, docs/invariants.md only if the runner has a section there.

**Acceptance criteria.**
- A pure argv-splitting test in test/test-runner.test.ts covers `--repeat=3` with a filter, bare `--repeat` (rejected), `--repeat=0` and `--repeat=51` (rejected), and `--repeat=3` with no filter (rejected).
- A test with a stub runner function shows n invocations on success and a stop at the first failure.
- Default behavior (no `--repeat`) is unchanged: the existing test-runner tests pass without edits.
- `npm run test:gate` passes.

### Prompt move-to-top: a failed write of the new queue file moves the prompt's images back instead of orphaning them under a stem with no prompt (planned 2026-10-20 by the plan role; independent of every eligible plan; touches src/inbox/inbox-attachments.ts + src/inbox/inbox-top.ts + test/inbox-top.test.ts + docs/invariants.md)

**Goal.** `moveFileToTop` (src/inbox/inbox-top.ts) is the shared core of `tumwater prompt --top <n>` (`movePromptToTop`), the dashboard's Move to top (`topQueuedFile`) and the TUI Queued pane. It calls `movePromptImages(file, newFile, text)` first, which renames each attached image from the old stem to the new one. Only then does it call `writeTextAtomic(newFile, carried)`, and that write has no `try`. If the write throws (full disk, EACCES), the error escapes after the images have already moved. The old queue file is still queued and its text still names the old image paths, which no longer exist. The images sit under the new stem with no `.md` beside them, so neither the cancel sweep nor the fulfilment sweep (`removeSameStemSiblings`) ever finds them. A scratch test on 2026-10-20 reproduced this: with every `*.md.tmp-*` `writeFileSync` faulted to throw "disk full", `movePromptToTop(root, "feature", 2)` threw. The inbox then held the two queue files plus one `.png` named on a third, new stem, and the old-stem image was gone. `editQueuedFile` (src/inbox/inbox-edit.ts) already unwinds its own image saves when its write throws. The top path should do the same: put back the moves it made, then rethrow.

**Approach.**
1. src/inbox/inbox-attachments.ts, `movePromptImages`: add `moves: { from: string; to: string }[]` to the returned object. Push `{ from: resolved, to: target }` right after each successful `fs.renameSync(resolved, target)`. Do not change any other behavior. The caller in src/inbox/pending-prompt.ts (`enqueueCarryingImages`) reads only `text` and `problem`, so it needs no edit. Add one sentence about `moves` to the doc comment.
2. src/inbox/inbox-top.ts, `moveFileToTop`: wrap `writeTextAtomic(newFile, carried);` in `try { … } catch (err) { … throw err; }`. In the catch, rename each entry of `moved.moves` back (`fs.renameSync(m.to, m.from)`) with its own `try` that swallows its error, so one failed rename does not stop the others, and the original write error is what reaches the caller. Then rethrow. `removeQueueFile(file)` and the `prompt_topped` event stay after the `try`, so neither runs on failure. Import `renameSync` from `node:fs` beside the existing `existsSync`. Extend the function's doc comment with one sentence: a failed write moves the attachments back and rethrows, so the prompt stays queued at its old position with its images.

**Files touched.** src/inbox/inbox-attachments.ts (`movePromptImages`), src/inbox/inbox-top.ts (`moveFileToTop`), test/inbox-top.test.ts, docs/invariants.md.

**Acceptance criteria.**
- New test in test/inbox-top.test.ts, "movePromptToTop whose queue-file write fails moves the image back and leaves the queue as it was". Seed it as "movePromptToTop carries an attached image to the new stem and leaves no old-stem leak" does: enqueue "first" and then "second", write `<oldStem>.png` beside the second file, and rewrite that file to `second\n\n[image attached: <oldImage>]`. Record `fs.readdirSync(roleInboxDir(root, "feature")).sort()` and the second file's text. Import `patchFsMethod` from ./helpers/fs-faults.js and use it to wrap `writeFileSync`: throw `new Error("disk full")` when `file` is a string containing `.md.tmp-`, and otherwise call the original. Assert `assert.throws(() => movePromptToTop(root, "feature", 2), /disk full/)`, restoring the patch in a `finally`. Then assert:
  - the inbox directory listing, sorted, equals the recorded one (old-stem image back, no new-stem file);
  - the second file's text is unchanged;
  - `eventsOfType(root, "prompt_topped")` is empty (check that helper's signature in test/fixtures/log-fixtures.ts before use).
  Mutation: delete the rename-back loop. The `.png` then stays under the new stem, so the listing assertion fails.
- The existing test/inbox-top.test.ts and test/inbox-attachments.test.ts tests pass unchanged.
- docs/invariants.md: at the END of the file, after every section present when the change is made (CH's and CI's sections included, if they have merged), add `## Prompt move-to-top: a failed write leaves the prompt and its images where they were`. Under it put `### INV-CJ1: a move-to-top whose new queue file cannot be written renames every moved attachment back, rethrows, and logs no prompt_topped`, in the Guarantee / Binds / Pinned by layout. Binds: `src/inbox/inbox-top.ts` (`moveFileToTop`), `src/inbox/inbox-attachments.ts` (`movePromptImages`'s `moves`). Pinned by: the new test's name. Before writing, run `grep -n '^### INV-C' docs/invariants.md | tail`. INV-CH* and INV-CI1 are taken by the backlog-archive and merge fast-forward plans, and CJ was free on 2026-10-20.
- `npm run test:gate` passes. The cited test names exist verbatim (`grep -rF` them in test/).

## Done
