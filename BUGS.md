# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed.

## Open

### Auto-restart completes on every stale episode under churn: rate-limit completed auto-restarts to at most one per 12 hours (reported by user 2026-09-11)

**Symptom:** On a self-hosting fleet whose main churns (bugfix/feature work landing many commits an hour), every move of main past the running build's stamp drives a full auto-redeploy episode: green check → compile → hold, during which no new ticks start on any loop and in-flight role ticks are drained up to `RESTART_DRAIN_MAX_MS` (30 min) → swap → exit → respawn. Under sustained churn these episodes run back to back — the fleet halts for a drain window over and over (dashboards show `STALE: main +N`, then restart pending), interrupting work far more often than is desirable. The 30-minute cap bounds one episode's drain; nothing bounds how often episodes complete a restart.

**Repro:**
1. Dogfood with `autoRestart` true (or unit-test `Redeployer.poll` directly): let a first stale episode reach its swap — green main, compile ok, no in-flight ticks → poll returns "restart".
2. Move main again so the new build is stale; minutes later the second episode reaches the same point.
3. Today both episodes return "restart": `poll()` has no notion of when the last restart landed, so under churn the fleet redeploys — and halts for a drain — on every burst.

**Expected:** completed auto-restarts happen at most once per 12 hours. While inside that cooldown after a restart lands: the fleet keeps ticking on the stale build exactly as it does today when a restart is blocked — no hold, no drain, no new-tick block (poll returns "none"); staleness stays visible in both dashboards; status explains why the old build still runs via the existing `restartBlocked` channel with a deadline (e.g. `cooldown until <iso>`), plus one warning event per episode (not per poll). Once 12 h have elapsed since the last completed auto-restart, the next poll resumes the normal cycle for the current head. Only completed auto-restarts set the timestamp — an operator's manual restart (Ctrl+C / `tumwater run`) neither counts toward nor resets it.

**Suspected cause:**
- src/redeploy.ts — `Redeployer.poll` (~lines 165–270) has no record of when the last restart completed: every stale head drives a full hold+swap cycle. `RESTART_DRAIN_MAX_MS` (line 50, 30 min) bounds the drain within an episode; nothing bounds frequency across episodes.
- The timestamp must survive process exit — auto-restart kills the orchestrator (exit code 75 → supervisor respawn), and `.tumwater/state/orchestrator.json` is per-process-lifetime (written at start, src/orchestrator.ts:230–232; removed on exit, :495) — so it needs its own persistent file under `.tumwater/state/`.

**Fix direction:**
- New constant `RESTART_COOLDOWN_MS = 12 * 60 * 60_000` in src/redeploy.ts next to `RESTART_DRAIN_MAX_MS`, with a comment citing this entry. Do not touch the drain window or the director exemption (Fixed 2026-09-09): those bound one episode, this bounds how often episodes complete. A previous director tick tried to answer related drain complaints by raising `RESTART_DRAIN_MAX_MS` (commit 5f10e9f, discarded after review) — do not repeat that.
- Persist the last completed auto-restart as epoch ms in a new small JSON file under `.tumwater/state/` (new path helper next to `orchestratorStatePath`, src/paths.ts:27). Redeployer reads it at construction (test seam for injection) and writes `now` inside poll immediately before returning "restart" — the process exits right after, so orchestrator cleanup is too late.
- In poll: when main is stale and autoRestart is on but now < lastAutoRestartAt + RESTART_COOLDOWN_MS → do not set pendingHead or start green/compile/drain; publish a `restartBlocked`-style reason with the deadline (BuildStatus, src/build-info.ts:72–90; rendered as `restart BLOCKED: …` by src/ui/status-render.ts:207–209 and warned by doctor), log one warning event when an episode first hits the cooldown, and return "none" so the orchestrator keeps scheduling normally (src/orchestrator.ts:433 blocks only on "hold"). Re-evaluate on every poll — do not reuse `block()`/`blockedHead`, whose no-retry-until-main-moves semantics would skip the restart entirely if main happens not to move again.
- README "How it works" auto-restart paragraph: one sentence — completed auto-restarts are rate-limited to at most once per 12 h; during the cooldown STALE stays visible with a deadline and ticks continue.
- Tests (test/redeploy.test.ts): (a) a second stale episode within 12 h of a completed swap returns "none" without holding, and status carries the deferred reason with its deadline; (b) advancing injected `now` past lastAutoRestartAt + 12 h lets the same head proceed to "restart"; (c) the timestamp is written on swap and re-read by a second Redeployer constructed from the same state file (survives process restart); (d) the existing drain/director-exemption tests pass unchanged.

## Fixed

### readEvents' torn trailing line occupied one of the limit slots: while events.jsonl ended unterminated, feeds showed at most limit−1 events (found by bugfix loop 2026-09-11, fixed 2026-09-11)

**Symptom:** `readEvents` (src/events.ts) stops its backwards scan at `newlines >= limit + 1`, on the documented assumption that "the partial leading line, if any, is unparseable and skipped" — but a torn trailing line at EOF (no final \n) also becomes a split("\n") element, occupies one slot in `slice(-limit)`, and fails to parse. While events.jsonl ended with an unterminated line, every display surface (GUI feed limit 40, TUI, `tumwater logs`) showed at most limit−1 events even though the log held more complete lines.

**Repro:** write ≥ limit+2 complete event lines plus a final fragment without \n; readEvents returned limit−1 parseable events instead of limit.

**Cause:** slice(-limit) was applied before the torn tail was excluded. Unlike `readCompleteLines`/`followFile`, which hold back an unterminated trailing line until its newline lands, readEvents parsed (and silently dropped) it while still counting its slot.

**Fix:** when the concatenated tail text does not end with "\n", drop the last split element before slicing — holding the fragment back until its newline lands, the same policy as `readCompleteLines`. No-op for terminated or empty logs. Regression test in test/events.test.ts pins that a torn trailing line after limit+2 complete events still yields exactly `limit` events (the correct ones), not limit−1.

**Files:** src/events.ts; test in test/events.test.ts.

### logEvent glued a new event onto an unterminated trailing line: after a crash mid-append, one complete event was lost from every consumer (found by bugfix loop 2026-09-11, fixed 2026-09-11)

**Symptom:** `logEvent` (src/events.ts) appended with raw `fs.appendFileSync`. When the previous append was interrupted mid-write — kill -9 or power loss during the syscall, both documented recovery scenarios in the README — events.jsonl ended without a newline. The next append landed directly after the fragment: `{…torn{"ts":…,"type":"tick_end",…}\n` became one glued line that fails JSON.parse forever, so BOTH events were lost from every consumer until rotation (16 MB): `readEvents` (GUI/TUI feeds, `tumwater logs`) skipped it and `collectReport`'s totals undercounted by one tick/commit per crash. The harness's own policy for torn lines elsewhere is to hold them back until the newline lands (`readCompleteLines`: "a trailing partial line (torn write in flight) is NOT consumed") — but nothing on the writer side ever supplied that newline.

**Repro:** append an event, then `fs.appendFileSync(eventsLogPath(dir), '{"loop":"x","type":"tick_end","tick":1,"resu')` (no trailing \n), then logEvent again: before the fix the file held one glued line and readEvents returned only the first event.

**Cause:** append-only writers assume the previous write completed; torn tails were handled reader-side only — and even there incompletely (see the sibling open bug about readEvents' slot).

**Fix:** logEvent now calls a private `terminateTornTail(file)` after rotation: stat-or-missing, fstat the opened inode, read the last byte, and append one "\n" when it is not already — so the fragment becomes its own (unparseable but harmless) line and the new event starts on a fresh line. No-op for missing/empty/terminated files; never throws. Regression test in test/events.test.ts pins that after an unterminated tail, the next logEvent terminates it in place and readEvents returns both surviving events.

**Files:** src/events.ts; test in test/events.test.ts.

### /api/report coerced hex/scientific/signed `days` spellings instead of degrading to the default window (found by bugfix loop 2026-09-11, fixed 2026-09-11)

**Symptom:** the GUI report endpoint parsed its query param with raw `Number.parseInt(q.get("days") ?? "", 10)` instead of the shared plain-decimal parsers. Its own doc comment promises "missing or non-numeric → 14, out-of-range clamped" — but `?days=1e3` served a **1-day** window (parseInt stops at the exponent), `?days=0x10` a 1-day one (stops at `x`, coerces to 0 → clamps up), and `?days=-5` a 1-day one (signed coercion). Whitespace-padded (`%207`) and trailing-garbage (`14abc`) spellings were accepted too. The endpoint was added in `465f1f6`, *after* improve #132 (`de9c7ae`) had made the shared parsers "the one definition of what counts as a valid count or position across every input surface (CLI flags and the GUI's query params)" — its sibling endpoints in the same file all use them; only this one bypassed the rule. The existing test table even pinned the coercion (`["days=-5", 1]`).

**Repro:** `node -e 'console.log(Number.parseInt("1e3",10), Number.parseInt("0x10",10), Number.parseInt("-5",10))'` → `1 0 -5`; then `curl "http://127.0.0.1:<port>/api/report?days=1e3"` returned `"days":1` where the documented rule says 14.

**Cause:** a new endpoint re-implemented integer parsing inline with `Number.parseInt` instead of importing from src/cli-args.ts, silently reviving exactly the coercions de9c7ae removed project-wide.

**Fix:** handleReport in src/ui/gui.ts now uses `parseNonNegativeInt(q.get("days") ?? "")` (already imported for /api/backlog's index) and maps null → 14 before clamping to 1..90 — so only plain decimal digit strings are counts, `0` still clamps to 1 as before, and every other spelling degrades to the default window. The test table in test/gui.test.ts now pins `-5`, `1e3`, `0x10`, and `%207` → 14 alongside the existing clamp cases.

**Files:** src/ui/gui.ts; test in test/gui.test.ts.

### forEachTailChunk ignored onChunk's early stop, so every poll of a grown log re-read it whole (found by bugfix loop 2026-09-11, fixed 2026-09-11)

**Symptom:** dry #141 (`25852c6`) factored the bounded backwards tail-scan out of `readEvents` (src/events.ts) and `readWindowEvents` (src/report.ts) into `files.forEachTailChunk`, converting each loop's inline break condition into a `return true` from the callback — but the new helper discarded the return value. Its own doc comment promises "onChunk, which returns true to stop early once enough bytes are in hand", and per-poll I/O is supposed to be bounded by the caller's need, not the log's size (the event log rotates at 16 MB and observers poll `readEvents` every second). With the contract unenforced, any events.jsonl past the 8 KB threshold was read whole — up to 16 MB per observer poll — exactly the cost the refactor existed to remove.

**Repro:** write a file > 8 KB (e.g. 100 KB) and call `forEachTailChunk(file, () => true)`; before the fix all ~13 chunks were delivered instead of one. The pre-refactor loops both had explicit breaks (`if (newlines >= limit + 1 || end <= 0) break;` / `… dayKey(ev.ts) < fromKey) break;`) that the extraction dropped.

**Cause:** the extracted loop body kept reading and advancing `end` unconditionally after delivering a chunk, never inspecting `onChunk`'s boolean. Results were still correct (the stop condition only bounded I/O), so no output-level test caught it — only the documented contract was broken.

**Fix:** one line in src/files.ts — `if (onChunk(buf.subarray(0, got))) break;` before advancing `end`, restoring both callers' pre-refactor semantics exactly. Regression test in test/files.test.ts pins the contract: a 24 KB file delivers exactly one chunk when the callback returns true immediately (the newest 8 KB), all three chunks newest-first with exact contents when it never does, plus the small-file single-chunk and missing-file paths.

**Files:** src/files.ts; test in test/files.test.ts.

### The review gate checks the pre-rebase tree, so the bytes that land on main were never run through a check (found by human analysis 2026-09-08, fixed 2026-09-10)

**Symptom:** dry tick 130's gate build check passed at 19:31:45 on head `8ce7ecaf` (tree `18f9917`), whose base was `9a1847e`. The change landed 9 m 16 s later as `e014175` (tree `f89fecb`), rebased over the **14** commits that reached main while it was under review. The tree the gate verified is not the tree that became main. Concretely: `7730bb1` — one of those 14 — is the commit that added test/pi.test.ts's label-marker test, so `git show 8ce7ecaf:test/pi.test.ts | grep -c 'writes exactly one marker line'` returns `0`. The suite the gate ran did not contain the test that then failed against main (see the entry above).

**Repro:** deterministic — start a tick, let another role land on main while it is under review, then compare `git rev-parse <reviewed head>^{tree}` with the tree of the resulting main commit. The window is wide in practice: review runs 7–13 minutes on local hardware, and main moved four times in the hour before this incident.

**Cause:** ordering. src/review.ts ran the deterministic pre-check (`scope: "gate"`) against the branch head as it stood outside the merge lock; only afterwards did `mergeToMain` take the lock and rebase before fast-forwarding, with nothing re-verifying the rebased result — a textual rebase succeeding says nothing about semantic compatibility. Second-order defect from the same assumption: review.ts seeded `noteGreenBaseline(head)` with the *pre-rebase* head on the premise that "main now points at this very SHA"; whenever a rebase happened that SHA was never main, so the seeding silently missed and the next fresh tick paid a full redundant suite run — exactly the run that flaked in the entry above.

**Fix:** the landing path now owns verification of what actually becomes main. `mergeToMain` captures the branch tip before any rebase; inside the lock, after `rebaseOntoMain` and before `ffMainTo`, `verifyLanding` (src/merge.ts) re-runs the project's declared check on the rebased tree whenever it differs from the pre-merge head — a failure returns `merge_blocked` without landing, and the commit stays on the branch for the next tick's recovery, whose gate pre-check rejects it deterministically with the build tail injected into the author's prompt (no model run consumed). Skips: no-op rebase (the tree is byte-identical to what was already checked), doc-only deltas ahead of main (the gate's own exemption test), and projects with no declared check. An environmental skip (timeout/no-npm) warns and proceeds, the gate's existing policy — a hung script cannot wedge landings behind the lock. The pre-rebase seeding moved: `reviewAheadOfMain` now hands its green verdict to the caller as `GateResult.verifiedHead` (threaded through loop.ts's tick path and leftover recovery), and `verifyLanding` seeds `noteGreenBaseline` with the POST-rebase head — after a green in-lock run, or on a no-op rebase when `verifiedHead` names that tree. The pre-merge head is captured once per landing (not per attempt) so a pi-resolved conflict tree is re-verified too: its second rebase is a no-op, but its bytes are new. Each in-lock run lands as a `build_check` event with `scope: "landing"`. Note the accepted tension from the fix direction: an in-lock suite serializes landings only when main moved under a code landing (the common case stays free via the no-op skip), and Merge queue 5/5's coalesced stack check will subsume this run later. Tests: five new regressions in test/merge.test.ts (green/red re-verify, no-op skip + baseline seeding, exempt-delta skip, conflict-resolution re-verify); review.test.ts's old gate-seeding test rewritten as a `verifiedHead` handoff test; the stale seeding contract corrected in src/build-check.ts, src/redeploy.ts, and README.md.

**Files:** src/merge.ts, src/review.ts, src/loop.ts, src/leftover.ts, src/build-check.ts (docs), src/redeploy.ts (doc); tests in test/merge.test.ts, test/review.test.ts.

### README promises `tumwater init` seeds a git repo, but it refuses to run outside an existing one (found by qa loop 2026-09-08, fixed 2026-09-10)

**Symptom:** A first-time user following the "How it works" section — "`tumwater init \"<prompt>\"` seeds a git repo with README.md … and commits them" — runs `tumwater init` in a fresh, empty project directory (the primary use case: the project does not exist yet, so no git repo exists to `cd` into) and gets an error instead of a seeded repo. The Usage block's comment `# any git repo` hints at the requirement, but it contradicts "seeds a git repo" — for a brand-new project there is no existing repo.

**Repro:**
```
mkdir /tmp/x && cd /tmp/x          # empty dir, not a git repository
tumwater init "Build a tiny markdown-to-html converter CLI in Python."
# → tumwater: /private/tmp/x is not a git repository (run `git init` first)
git init
tumwater init "Build a tiny markdown-to-html converter CLI in Python."
# → created README.md, PLANS.md, BUGS.md, QUESTIONS.md, PRINCIPLES.md, tumwater.json, .gitignore (committed)
```

**Expected:** per "How it works", `tumwater init` seeds a git repo — running it in an empty directory should work.

**Actual:** src/init.ts:87 threw unless the cwd was already a git repository; the user had to run `git init` themselves first. The error message did guide them, so it was recoverable, but the docs promised behavior the product did not deliver.

**Cause:** init was written to assume an existing repo while the README wording ("seeds a git repo … and commits them") overstates what it does.

**Fix:** took the first option — `initProject` now runs `git init -b main` when the cwd is not yet a repository (src/init.ts), so the "seeds a git repo" promise holds for brand-new projects; `-b main` matches every doc reference and what `tumwater run` reports. The pure validations (prompt, README markers) moved ahead of that side effect, so an invalid prompt leaves no half-seeded repo behind. The CLI prints `initialized a new git repository on branch main`, and the Usage comment now reads "existing or new project dir". Tests: test/init.test.ts (seeding + validate-before-side-effect) and test/cli.test.ts (end-to-end in an empty directory).

### Budget badge shows `$0.00/$50` on free/local LLM fleets instead of n/a (reported by user 2026-09-08, fixed 2026-09-09)

**Symptom:** When the fleet runs a model that costs nothing — a local server (e.g. LM Studio via `openai-responses`) or any model with no price set in pi's models.json — both dashboards still show the daily budget badge as `· budget: $0.00/$50 today`, implying spend is being tracked against a cap that can never be reached. The user wants it to read n/a instead of `$0.00/$50`.

**Repro:**
1. Point tumwater.json at a free model (e.g. `provider: lm-studio`, `model: qwen3.8-27b` — no `cost` field in `~/.pi/agent/models.json`).
2. Run the fleet until at least one tick completes; open the TUI or GUI.
3. The header shows `· budget: $0.00/$50 today` (default cap) even though spend can never accumulate.

**Expected:** when every model the fleet could use is free, the badge reads n/a instead of a dollar figure.

**Cause:** cost comes from pi's per-message usage (`msg.usage?.cost?.total`, src/pi.ts:159), which is 0 for unpriced models; nothing downstream knows the model is free. `snapshot()` (src/ui/status.ts) emitted `{ spentUsd, capUsd }` whenever `maxDailyCostUsd > 0`, and both renderers formatted it as `$X/$Y` — TUI + `tumwater status` in src/ui/status-render.ts (`renderStatus`) and the GUI client-side from the /api/status payload (src/ui/gui-page.ts).

**Fix:** new src/pi-models.ts resolves every model the fleet could use — each enabled role's effective provider/model via `configForRole` (the director included, it is a catalog role) plus `reviewConfig` while review is on — against pi's definitions at `~/.pi/agent/models.json`: free = no `cost` field or all-zero cost; any unresolvable pair (omitted values = pi's own default, missing/malformed file, unknown provider or model id) counts as NOT free, so the badge never reads n/a while spend it tracks could still reach the cap. `StatusSnapshot.budget` now carries `free`, and both dashboards render `· budget: n/a today` when it is set — the dollar branch stays byte-identical, keeping the planned editable-budget entry's acceptance criteria intact (PLANS.md). The budget gate is untouched ($0 spend never reaches the cap), as are the per-loop cost/today columns. Tests: test/pi-models.test.ts (new) plus snapshot/render/payload coverage in test/status.test.ts, test/status-render.test.ts, and test/gui.test.ts.

### Auto-restart aborts an in-flight director tick after the 30-minute drain: the director should be exempt and waited for (reported by user 2026-09-08, fixed 2026-09-09)

**Symptom:** When a self-redeploy is pending (stale build, main green, compile done), the harness holds new ticks and waits up to `RESTART_DRAIN_MAX_MS` (30 min) for in-flight ticks to finish — then swaps dist/ and aborts whatever is still running. The drain counts ALL in-flight ticks alike, so a director tick carrying an explicit user prompt that outlives the window is aborted mid-task even though it was requested by a human. Median ticks run ~35 min on local hardware (the stated rationale for the 30-minute cap), so long director prompts routinely hit this.

**Repro:**
1. Dogfood setup with `autoRestart` true; make main move past the running build's stamp while a director prompt is executing (or unit-test `Redeployer.poll` + the orchestrator restart path directly).
2. Let the drain window elapse (`drainSince` + 30 min) with the director tick still in flight.
3. The orchestrator swaps dist/ and calls `internalStop.abort()`; the director's pi run ends as `aborted` (resumable on the new build, but the user's prompt is interrupted mid-task).

**Expected:** role ticks keep today's behavior — drained, then aborted resumably after the 30-minute window. A director tick in flight when the window expires extends the hold indefinitely: no swap and no abort until it finishes; only then does the restart land (aborting any remaining role ticks). The per-tick watchdogs (`quietTimeoutSeconds`, `tickTimeoutSeconds`) already bound a hung director run, so an unbounded wait cannot hang the fleet beyond what one tick can already do.

**Suspected cause:**
- src/redeploy.ts:49 — `RESTART_DRAIN_MAX_MS = 30 * 60_000`; line ~213 in `poll()`: `if (inFlight > 0 && now - this.drainSince < this.drainMaxMs) return "hold";` decides on a single aggregate count with no notion of which loops are still running, then swaps unconditionally.
- src/orchestrator.ts:216 — `inFlight` is one `Set<Promise<void>>` for every runner's task (director tasks added at ~line 389 like any other); on the `restart` action (~lines 348–357) it does `if (inFlight.size > 0) internalStop.abort()`, aborting everything including the director.

**Fix direction:** track in-flight director ticks separately from role ticks in the orchestrator (e.g. a counter or flag updated where tasks are added/removed for `DIRECTOR_ROLE`) and pass both to `Redeployer.poll` — change its `inFlight: number` parameter accordingly (e.g. `{ roleInFlight, directorInFlight }`). In `poll`: hold while `directorInFlight > 0` with no time cap; otherwise apply the existing window logic against role ticks only. On `restart`, abort only if role ticks remain (the director is guaranteed finished by then). Update the comment at src/redeploy.ts:45–48, the `drainedMs`/`abortedTicks` semantics in the `restart` event (a director-extended hold will report >30 min drained — that is correct and informative), and the README's "How it works" sentence about the 30-minute drain to state the director exemption. Tests: test/redeploy.test.ts (poll holds past the window while a director tick is in flight; swaps once it clears) and test/orchestrator.test.ts if it exercises the restart/abort path.

**Note (2026-09-08):** An alternative approach — changing `RESTART_DRAIN_MAX_MS`'s default cap instead of exempting director ticks — was attempted by director tick #79 and rejected in review; it never landed on main, so this entry's description still matches current behavior. The fix direction above stands as the recorded way forward (the gate defect behind that rejection — rejecting for contradicting a recorded entry instead of letting the newer instruction win — is fixed; see its entry under ## Fixed).

### Review gate rejects a change for contradicting an already-recorded bug/plan instead of letting the newer user instruction win (reported by user 2026-09-08, fixed 2026-09-09)

**Symptom:** Director tick #79 was rejected in review on 2026-09-08 with "The change responds to a user report already recorded as an open BUGS.md entry". The change responded to a *newer* user prompt about the same topic as an existing open bug (the restart-drain entry, commit f62c4d4) and took a different approach than that entry's fix direction. Per the user: a new prompt always overrides an old one — work must not be rejected for contradicting prior recorded work or changing the design; it should be synthesized with the existing open bugs/features/docs (updating the existing entry in place rather than creating a duplicate or rejecting).

**Repro:**
1. Record a bug/plan entry with a fix direction (e.g. BUGS.md's restart-drain entry, f62c4d4).
2. Land a change responding to a newer user prompt on the same topic that takes a different approach than the recorded fix direction.
3. The review gate rejects it: checklist item 4 ("does the change deliver what its PLANS.md/BUGS.md entry promises") is read as "must match the recorded fix direction", and nothing in the review prompt gives a newer user instruction precedence over an older record.

**Expected:** A change responding to a newer user request than the one that produced a recorded entry may land when it is coherent and complete for its stated purpose; the reviewer checks that the author updated the existing entry so no stale contradiction remains — not that the change matches the old fix direction. Contradicting prior work or changing the design is not, by itself, a defect.

**Cause:** `buildReviewPrompt`'s checklist item 4 had no precedence rule between a newer user instruction and an older recorded entry; the reviewer generalized it into "the change must match the recorded fix direction". The "latest instruction wins" principle was in the prompt (via PRINCIPLES.md) but nothing tied it to the checklist.

**Fix:** item 4 now states that an entry records intent at recording time and that a change responding to a newer user instruction on the same topic is judged against that newer purpose — contradicting an older recorded fix direction is not itself a defect; reject only if the change is incoherent or incomplete for its stated purpose, or leaves the existing entry stale and contradictory (updating it in place is the author's duty). test/prompt.test.ts pins the new rule. Files: src/prompt.ts, test/prompt.test.ts.

### `runPi` resolves before its raw log flushes: a load-sensitive race that flakes the suite and can truncate a transcript (found by human analysis 2026-09-08, fixed 2026-09-09)

**Symptom:** On 2026-09-08 at 19:42 the dry loop's post-merge baseline check declared main `e014175d` red — "code merges blocked until main is green" — and dry, improve and clean all ended their ticks `main_red` within the same second. One second later the redeploy gate's own run of the *same SHA* passed and promoted it green fleet-wide, so nothing stayed blocked. Main was never broken: a clean `npm test` on `e014175` is 822/822. The single failure was test/pi.test.ts:422 ("runPi with a label writes exactly one marker line as the raw log's first line"), at its `assert.equal(content, …)` — reported as dist/test/pi.test.js:372.

**Repro:** deterministic under libuv threadpool contention; the assertion reads back an empty or marker-only file.

```
UV_THREADPOOL_SIZE=1 node -e '
const fs=require("fs"),os=require("os"),path=require("path"),{spawn}=require("child_process");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"race-")), big=path.join(dir,"big.bin");
fs.writeFileSync(big,Buffer.alloc(4*1024*1024));
let on=true; const flood=()=>{if(on)fs.readFile(big,()=>flood())}; for(let i=0;i<64;i++)flood();
let ok=0,bad=0,n=0;
const one=()=>new Promise(r=>{const f=path.join(dir,`raw${n++}.jsonl`);
  const w=fs.createWriteStream(f,{flags:"a"}); w.write("MARKER\n");
  const c=spawn("/bin/sh",["-c","printf %s\\\\n LINE"]);
  c.stdout.on("data",d=>w.write(d.toString()));
  c.on("close",()=>{w.end(); r(fs.readFileSync(f,"utf8"))});});
(async()=>{for(let i=0;i<200;i++){(await one())==="MARKER\nLINE\n"?ok++:bad++;}
  on=false; console.log({ok,bad});})();'
```

Verbatim run of the above: `{ ok: 9, bad: 191 }`. The same loop without the threadpool contention is 300/300 ok, which is why this has never flaked before.

**Cause:** src/pi.ts:306 — `finish()` calls `rawLog.end()` (line 312) and `resolve(result)` (line 313) in the same turn and never awaits the stream's `finish`/`close`. `rawLog` is an `fs.createWriteStream` (line 232) whose writes complete on the libuv threadpool, so when `runPi`'s promise settles the lines fed from `child.on("close")` (the `decoder.end()` flush) may still be unwritten. The test does `readFileSync` immediately after `await runPi(...)`. On an idle machine the flush always wins the race; under load it does not.

What loaded the machine on 2026-09-08 was two full `npm test` suites on the same commit at once — dry's red-main baseline check in `.tumwater/worktrees/dry` and the redeploy gate's green check in `_main`. They never dedup: the gate always passes `reverifyRed = true`, which keys `baselineInFlight` by sha+worktree rather than sha (src/build-check.ts, `checkMainBaseline`), by design. Both runs took ~70 s against the usual 59–64 s. Three LM Studio inference streams were also live.

**Impact beyond the flake:** the unflushed tail is real data loss, not only a test artifact. A tick whose process exits or is killed shortly after `runPi` resolves — an abort during a restart drain, a supervisor swap — can lose the last line(s) of `<role>.pi.jsonl`, which is what `tumwater logs` and both dashboards read.

**Fix:** `finish` now settles only after the raw log has flushed: `rawLog.end(settle)` resolves on 'finish', and an idempotent settle is also wired to the stream's 'error' so a broken log (EACCES, ENOSPC) degrades to a lost transcript instead of hanging the tick; a persistent error handler at creation marks the stream broken so an early failure neither crashes the process nor waits on a 'finish' that will never come. The `settled` guard remains the re-entry lock and the spawn-error path is covered since it routes through `finish`. Regression tests in test/pi.test.ts pin both halves with fake streams: a stalled stream that lands its buffered writes one macrotask after end() — resolve-before-flush code reads back an empty log on the turn runPi settles (verified failing against the pre-fix build) — and a broken stream whose 'error' fires instead of 'finish', where runPi still settles with the run's real result. Files: src/pi.ts, test/pi.test.ts.

### Auto-restart's drain clock restarted on every main move: a 30-minute cap held the fleet for 38 (found by human 2026-09-08, fixed 2026-09-08)

**Symptom:** the restart that landed at 13:29 on 2026-09-08 reported `drainedMs` of 30m02s, but the fleet had actually been held — no new ticks on any loop — since ~12:51, 38 minutes. The hold began for head `9656e1a`; at 12:59 the director merged `9a1847e`, superseding it, and the drain deadline started over from that moment (`restart_pending` for the new head at 13:00:02, swap exactly 30 minutes later). The 11 in-flight ticks the drain was waiting on were the same 11 throughout.

**Repro:** deterministic — `poll` a stale head to start a drain, let the green check and compile settle, then poll a NEW head partway through the window: the deadline is measured from the new head instead of from the first hold. Pinned by "a main move during the drain does not restart the clock" in test/redeploy.test.ts.

**Cause:** `pendingSince` was stamped in poll's "start a new pending restart" branch, so it measured the current head's turn at the restart rather than the fleet's unbroken hold. A main move calls `clearPending()`, which drops the pending head, and the next poll re-stamped the clock. Not unbounded starvation — nothing new starts during a hold, so main can only move as many more times as there were ticks already in flight — but each move handed those same ticks another full window, and the reported `drainedMs` understated the real hold.

**Fix:** `pendingSince` became `drainSince`, set only when the fleet was not already being held (`if (!this.drainSince)`) and cleared by a new `endDrain()` on every path out of `poll` that is not a `hold` — a block, a cleared staleness, `autoRestart` off. A superseded head hands its drain over to the new one; a drain that actually ended starts the next clock from scratch. `drainedMs` now reports the true hold. Files: src/redeploy.ts.

### Auto-restart deadlocked on a self-referential test: `npm test` fails in every worktree without a local install (found by readme loop 2026-09-08, diagnosed by human 2026-09-08, fixed 2026-09-08)

**Symptom:** The live fleet (pid 151, build `668c39e9`) sat 10 commits behind main for over two hours. It had noticed — `build_stale` and `restart_pending` at 10:05 for head `3c8c29b` — and then refused every head that followed: seven `main <sha> is red — holding the restart until main is green` warnings, one per head through `95d0c10`. Meanwhile new ticks kept starting, because a blocked restart correctly stops holding the fleet. Main was not red: `npm test` was 786/786 green in any checkout that had run `npm install`, and 785/786 in one that had not. The failing test was "compileStaged compiles the mirror worktree with the project's tsc and stamps the result" (test/redeploy.test.ts), which expected `{ ok: true }` and got `typescript is not installed under node_modules — cannot rebuild`.

**Repro:**
```
git worktree add /tmp/bare main   # fresh checkout; do NOT run npm install
cd /tmp/bare && npm test          # → 1 fail: redeploy.test.ts compileStaged (785/786)
npm ci && npm test                # → 786/786 green
```

**Cause:** two independent faults that compounded into a deadlock.

1. `compileStaged` looked for the compiler at `<root>/node_modules/typescript/bin/tsc` — a *local* install — while everything else in the harness (npm's run-script PATH walk, `detectBuildCheck`) climbs ancestors. Its test therefore had to symlink `<checkout>/node_modules/typescript` into a temp project, which dangles in every tumwater worktree (node_modules is gitignored, so it exists only where someone ran npm install). The redeploy gate runs `npm test` in the detached `_main` mirror, which never has one: main read red at every head, forever. The fleet could not restart itself onto the very commit that would fix this.
2. The baseline verdict cache (build-check.ts) was keyed by SHA alone, though the verdict depended on which worktree ran the check. At 11:07 the coverage loop — also install-less — cached a red for `6c91c25`, and 58 ms later the redeploy gate consumed that cached red without running anything. One worktree's broken environment became the fleet's verdict.

**Fix:** `resolveFromNodeModules` (build-check.ts) walks up from the project root the way npm and `detectBuildCheck` do, and `compileStaged` finds tsc through it; the test resolves this repo's typescript through node's own resolution instead of a hard-coded path, and a new test pins the ancestor-install case. A green verdict is now authoritative fleet-wide while a red is provisional: `checkMainBaseline`'s `reverifyRed` re-runs a cached red in the caller's own worktree, and a pass promotes the SHA for everyone (unblocking the role loops too). The redeploy gate is the one caller that pays for it — believing a wrong red there strands the whole fleet — and its suite run now appears in the feed as a `build_check` event. `BuildStatus` gained `restartPending`/`restartBlocked`, so orchestrator.json, `status --json`, both dashboards (`restart BLOCKED: <reason>`) and `doctor` distinguish a restart that is seconds away from one that will never happen. Files: src/build-check.ts, src/redeploy.ts, src/build-info.ts, src/ui/status-render.ts, src/ui/gui-page.ts, src/doctor.ts.

### Harness never picks up its own new build: the fleet ran a 2026-08-27 build for ten days while 350 commits landed (found by human log analysis 2026-09-07, fixed 2026-09-07)

**Symptom:** `tumwater run` loads dist/ once and never reloads it. From 2026-08-27 17:28 to 2026-09-07 00:04 the live orchestrator (pid 69563, started from `ba793ac`) kept running while main gained 350 commits — the review gate on the normal path, its build pre-check, the red-main gate, the daily budget, commit bodies, the qa and steward roles, pause/resume, doctor, status --json — none of which executed until a manual restart. Nothing in the fleet could see it: the roles list in the Aug 27 orchestrator_start event, the absence of every newer tick result and event type, state files without the budget fields, zero commit bodies after Aug 27, and qa/steward at tick 1 on Sep 7 were the only traces. Two entries below reasoned about why the pre-check "must have been skipped"; it was not running.

**Repro:** land a src/ change on main while `tumwater run` is up; observe that dist/ and the process are unchanged and that no dashboard, event, or `doctor` line says so.

**Cause:** no build provenance (dist/ carried no record of the commit it came from) and no redeploy path — a self-hosting harness with no way to notice or act on its own new code.

**Fix:** `npm run build` stamps `dist/build-info.json`; the orchestrator publishes the stamp and its staleness (vs main's src/, package.json, tsconfig.json) in orchestrator.json, its start event, a `build_stale` event, both dashboards' headers, `status --json`, and a `doctor` check. With `autoRestart` (default true) a self-hosted fleet verifies main is green, compiles it into `.tumwater/build/<sha>`, drains in-flight ticks (30 min cap, then aborted resumably), swaps dist/, and exits 75 for the new `tumwater run` supervisor to respawn it. Commit `debe885`. Files: src/build-info.ts, src/redeploy.ts, src/supervisor.ts, scripts/stamp-build.mjs, src/orchestrator.ts, src/cli.ts, src/doctor.ts, src/status*.ts, src/gui*.ts.

### pi crashing on malformed JSON abandoned the session: five ticks lost, one of them 2 h 39 m of director work (found by human log analysis 2026-09-07, fixed 2026-09-07)

**Symptom:** tick_end errors "Unterminated string in JSON at position N (line 1 column N+1)" (organize #88 on 2026-09-02, perf #88 on 09-05, director #70 on 09-06) and "Expected ',' or '}' after property value in JSON" (08-25, 08-28), each ending a tick as a plain error with backoff; director tick 70 had spent 2 h 39 m on the newest steering prompt, which then re-ran from scratch.

**Cause:** the messages are pi's own stderr — pi dying on a torn model-server chunk — not harness parsing (every harness JSON.parse is guarded). The session file survives such a crash intact, but the harness treated it like any failure and started the next tick fresh.

**Fix:** runPi flags a nonzero exit whose stderr ends in a JSON.parse failure as `transientPiCrash` (never for exits the harness itself caused); the loop gives it the same single `--continue` retry the predict-stream timeout gets, with one warning naming the crash. Commit `94f15ef`. Files: src/pi.ts, src/loop.ts, src/types.ts.

### Cut-off resumes were bridged as "the harness was restarted" and the cut-off streak froze at the resume limit (found by human log analysis 2026-09-07, fixed 2026-09-07)

**Symptom:** 308 of 733 autonomous-era ticks ended cut off at the context ceiling (179 model-hours landing nothing). A resumed cut-off session was told a restart had interrupted it and to verify a half-finished tool call; a fresh tick after the loop gave up resuming carried no memory that the last attempts were too big for the window; and `cutOffStreak` stopped counting at 3, so dashboards and prompts could not say how long a loop had been starving (improve: 36 consecutive cut-offs, Sep 1–6).

**Fix:** every run carries a context-budget rule; the resume bridge names the real cause and asks for the smallest finish without re-reading; a fresh tick after cut-offs carries a note counting them and offering nothing-to-do; the `resume` event carries its cause; the streak counts every consecutive cut-off. Commit `fa3c59c`. Files: src/prompt.ts, src/loop.ts, src/state.ts, src/event-format.ts.

### Changed ticks whose reply lacked SUMMARY landed as "<role> tick N" — 73 commits, 32 of them feature (found by human log analysis 2026-09-07, fixed 2026-09-07)

**Symptom:** a run that changed files but ended without the closing block (often a final message cut off at the ceiling) committed with the bare placeholder subject, so the largest diffs in the repo had no description in `git log`.

**Fix:** one bounded follow-up turn in the tick's own session (`--continue`, 15 min / 5 min quiet caps) asks for exactly the SUMMARY/WHY/RISK/VERIFIED block; failing that the subject is derived from the changed paths ("Update src/loop.ts, test/loop.test.ts and 2 more"). Commit `61cf063`. Files: src/loop.ts, src/prompt.ts, src/commit-message.ts.

- GUI dashboard executes HTML in backlog entry bodies — unescaped innerHTML injection (found by bugfix loop 2026-09-06, fixed 2026-09-06; commit 6fe4dfe)
- Build broken on main: feature tick 105 dropped `openBugs` from test/backlog.test.ts's imports, and two of its new assertions could never pass (found by coverage loop 2026-09-06, fixed 2026-09-06; commit f6ad136)
- Non-ASCII text in pi output garbled when a multi-byte character straddles a stdout chunk boundary (found by bugfix loop 2026-09-03, fixed 2026-09-03; commit 07b7a7e)
- Tests red on main: feature tick 83's `today` column broke two layout assertions (found by readme loop 2026-09-03, fixed 2026-09-03; commit 02a8661)
- readTranscriptTail returns duplicated entries when a pi log starts with a blank line (found by coverage loop 2026-09-03, fixed 2026-09-03; commit 86e6559)
- Main's suite red: stale duplicate of the already-fixed fmtUsdCap test break — re-recorded from a pre-fix snapshot (re-recorded by readme loop 2026-09-02, closed 2026-09-02; commit 91a0843)
- Tests red on main: clean tick 91's fmtUsdCap assertion carries a stray quote and can never match GUI_PAGE (found by coverage loop 2026-09-02, fixed 2026-09-02; commit 91a0843)
- Main's build broken: organize tick 78 deleted git.ts's rebase/fast-forward/conflict helpers without landing their move into merge.ts (found by readme loop 2026-08-31, fixed 2026-08-31; commit 2cff978)
- Interrupted tick on a slow-clock role does not resume promptly: the min gap holds it for a full interval (found by bugfix loop 2026-08-30, fixed 2026-08-30; commit f773a49)
- Orphaned merge lock (no pid file) can never be broken — every merge times out forever (found by bugfix loop 2026-08-29, fixed 2026-08-29; commit 6c44004)
- Tests red on main: feature tick 57's new contract tests break on prompt line-wrapping (found by improve loop 2026-08-29, fixed 2026-08-29; commit 06de235)
- `reset-counters` consumed mid-tick wedges the loop: running flag stuck true until restart (found by bugfix loop 2026-08-28, fixed 2026-08-28; commit 97b9900)
- Build broken on main: feature tick 52's questions-outbox changes leave three test files stale (found by readme loop 2026-08-28, fixed 2026-08-28; commit 2d3376f)
- Build broken on main: feature tick 49's steward default fails noUncheckedIndexedAccess (found by readme loop 2026-08-28, fixed 2026-08-28; commit 43fc759)
- Build broken on main: src/loop.ts calls git() without importing it — stale duplicate of the readme-loop entry (reported by organize loop 2026-08-28, closed 2026-08-28; commit 93b8535)
- Build broken on main: src/loop.ts calls `git` without importing it (found by readme loop 2026-08-28, closed 2026-08-28; duplicate entry above closed the same day; commit 93b8535)
- Build broken on main: feature tick 44 landed src/review.ts with a syntax error, type errors, and two failing recovery tests (reported by plan loop; detailed by readme loop, 2026-08-27, fixed 2026-08-27; commit be7211a)
- Flaky test: "a resumed tick continues the interrupted session" fails with no_change under parallel load (found by bugfix loop 2026-08-27, fixed 2026-08-27; commit 3f90083)
- Build broken on main: test/files.test.ts imports tail helpers from files.js after organize move (reported by plan loop 2026-08-27, closed 2026-08-27; commit 89828a5)
- TUI crashes and GUI goes blind while tumwater.json is transiently broken (found by bugfix loop 2026-08-27, fixed 2026-08-27; commit 2a1607b)
- gen / peak ctx columns should show the current or last run, not cumulative totals (reported 2026-08-25, fixed 2026-08-26; commit e959944)
- Merge conflicts logged as warnings in the main log although they are normal operation (reported 2026-08-25, fixed 2026-08-25; commit 7e0d789)
- gen / peak ctx columns sit at 0 while loops work for many turns; counters only move at tick boundaries (reported 2026-08-25, fixed 2026-08-25; commit ff3b6f0)
- Zombie streams defeat the quiet watchdog: loops stuck for hours on "turn 1" (reported 2026-08-24, fixed 2026-08-24; commit d207095)
- Loop hung ~10 hours on an interactive command; no guard fired (reported 2026-08-24, fixed 2026-08-24; commit ab328e8)
- Clean conflict resolutions rejected as conflicted when files contain seven-equals lines (found by bugfix loop 2026-08-23, fixed 2026-08-23; commit b3b803b)
- Director loses queued user prompts when a tick fails without landing work (reported 2026-08-23, fixed 2026-08-23; commit 9b9803f)
- Ticks fail with "Engine protocol predict stream timed out" after machine sleep/wake (reported 2026-08-23, fixed 2026-08-23; commit 5e68229)
- Ticks failing with "terminated" after ~20 minutes under concurrent load (reported 2026-08-22, fixed 2026-08-22; commit 4d6bc50)
- TUI: status table wider than terminal — rows wrapped and misaligned (reported 2026-08-20, fixed 2026-08-21; commit 9ddd731)
- TUI: status table scrolled off the top as recent activity grew (reported 2026-08-20, fixed 2026-08-21; commit 9ddd731)
- LM Studio logs flooded with WARN lines while loops run (reported 2026-08-20, resolved 2026-08-21; commit 413050c)
- Spurious warning "pi finished without changes and without declaring nothing-to-do" (reported 2026-08-21, fixed 2026-08-21; commit 936b1c9)
