# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed.

## Open

### The review gate checks the pre-rebase tree, so the bytes that land on main were never run through a check (found by human analysis 2026-09-08)

**Symptom:** dry tick 130's gate build check passed at 19:31:45 on head `8ce7ecaf` (tree `18f9917`), whose base was `9a1847e`. The change landed 9 m 16 s later as `e014175` (tree `f89fecb`), rebased over the **14** commits that reached main while it was under review. The tree the gate verified is not the tree that became main. Concretely: `7730bb1` — one of those 14 — is the commit that added test/pi.test.ts's label-marker test, so `git show 8ce7ecaf:test/pi.test.ts | grep -c 'writes exactly one marker line'` returns `0`. The suite the gate ran did not contain the test that then failed against main (see the entry above).

**Repro:** deterministic — start a tick, let another role land on main while it is under review, then compare `git rev-parse <reviewed head>^{tree}` with the tree of the resulting main commit. The window is wide in practice: review runs 7–13 minutes on local hardware, and main moved four times in the hour before this incident.

**Cause:** ordering. src/review.ts runs the deterministic pre-check (`scope: "gate"`, line 158) and then the model review against the branch head as it stands. Only afterwards does src/merge.ts:56 `mergeToMain` take the merge lock and rebase (`rebaseOntoMain`, line 70) before fast-forwarding (`ffMainTo`, line 71). Nothing re-verifies the rebased result, and a textual rebase succeeding says nothing about whether the two changes are semantically compatible. This is the structural hole behind BUGS.md's recurring "tests red on main" class: the gate is an oracle on a tree that is already historical by the time it answers.

Second-order defect from the same assumption: src/review.ts:191 seeds `noteGreenBaseline(head)` with the *pre-rebase* head, on the stated premise that "after the merge lands — main now points at this very SHA" (comment at lines 188–190). Whenever a rebase happened that SHA is never main, so the seeding silently misses and the next fresh tick pays a full redundant suite run — which is exactly the run that flaked in the entry above.

**Fix direction:** re-run the declared check inside the merge lock, after `rebaseOntoMain` and before `ffMainTo`, where the rebased head is by construction the exact tree that would become main; a failure returns `merge_blocked` (or a rejection carrying the tail onto the next prompt) instead of landing. Skip the re-run when the rebase was a no-op — reviewed head == rebased head, the common case — so only a tick whose main moved under it pays. Seed `noteGreenBaseline` with the rebased head and correct the comment's premise. Note the tension worth resolving first: a second full suite held inside the merge lock serializes landings, which is precisely what "Merge queue 5/5 — coalesce the build check across queued landings" (PLANS.md) exists to fix — sequencing this after the merge queue, or implementing it as the queue's coalesced check, is likely the cheaper order.

**Files:** src/merge.ts, src/review.ts; tests in test/merge.test.ts.

### Budget badge shows `$0.00/$50` on free/local LLM fleets instead of n/a (reported by user 2026-09-08)

**Symptom:** When the fleet runs a model that costs nothing — a local server (e.g. LM Studio via `openai-responses`) or any model with no price set in pi's models.json — both dashboards still show the daily budget badge as `· budget: $0.00/$50 today`, implying spend is being tracked against a cap that can never be reached. The user wants it to read n/a instead of `$0.00/$50`.

**Repro:**
1. Point tumwater.json at a free model (e.g. `provider: lm-studio`, `model: qwen3.8-27b` — no `cost` field in `~/.pi/agent/models.json`).
2. Run the fleet until at least one tick completes; open the TUI or GUI.
3. The header shows `· budget: $0.00/$50 today` (default cap) even though spend can never accumulate.

**Expected:** when every model the fleet could use is free, the badge reads n/a instead of a dollar figure.

**Suspected cause:** cost comes from pi's per-message usage (`msg.usage?.cost?.total`, src/pi.ts:159), which is 0 for unpriced models; nothing downstream knows the model is free. `snapshot()` (src/status.ts, ~line 110) emits `{ spentUsd, capUsd }` whenever `maxDailyCostUsd > 0`, and both renderers format it as `$X/$Y`:
- TUI + `tumwater status`: header line in src/ui/status-render.ts (`renderStatus`, ~line 220)
- GUI: src/ui/gui-page.ts (~lines 109–111), formatted client-side from the /api/status payload

**Detection approach (recommended):** resolve each enabled role's effective provider/model — `configForRole` in src/config.ts, plus `reviewConfig` when review is enabled — and look them up in pi's model definitions at `~/.pi/agent/models.json` (`providers.<p>.models[]`; free = no `cost` field or all-zero cost). If every resolvable model the fleet could use is free → budget n/a. Safe fallback: a provider/model not found there (e.g. pi's built-in paid providers) counts as NOT free, keeping `$X/$Y`. Expose the result on StatusSnapshot (e.g. `budget.free`) so TUI, GUI, and `status --json` all render from one source of truth — note the GUI formats client-side, so the payload must carry it. An alternative heuristic (observed usage: tokens > 0 with cumulative cost === 0) lags until the first tick and needs a persistent flag to survive midnight rollover / reset-counters; prefer the config-based check.

**Scope notes:**
- The budget *gate* is unaffected: $0 spend never reaches the cap (already acknowledged in src/config.ts, ~line 38). No change to `budgetReached` or pause behavior.
- Only the header badge changes; per-loop `cost`/`today` columns stay as-is ($0.00 remains accurate there).
- Cross-reference: the planned "Make the daily cost budget editable from the TUI/GUI" (PLANS.md) rewrites this same badge code — keep the enabled-case text byte-identical so that plan's acceptance criteria still hold, or coordinate ordering with it.

### README promises `tumwater init` seeds a git repo, but it refuses to run outside an existing one (found by qa loop 2026-09-08)

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

**Actual:** src/init.ts:87 throws unless the cwd is already a git repository; the user must run `git init` themselves first. The error message does guide them, so it is recoverable, but the docs promise behavior the product does not deliver.

**Suspected cause:** init was written to assume an existing repo while the README wording ("seeds a git repo … and commits them") overstates what it does. Either `init` should run `git init` itself when the cwd is not a repo (matching the docs), or "How it works" should say it seeds files into an *existing* repo and that `git init` comes first.

## Fixed

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

### GUI dashboard executes HTML in backlog entry bodies — unescaped innerHTML injection (found by bugfix loop 2026-09-06, fixed 2026-09-06)

**Symptom:** The dashboard's backlog detail panel (`tumwater gui` → click any planned feature / open bug / open question) spliced the entry's body straight into `innerHTML` without escaping, while every other dynamic value on the page — including the same entry's title two lines above — went through the page's `esc()`. A plan/bug/question entry containing HTML (a repro with `<img src=x onerror=…>`, a stray `<script>` tag) was parsed and executed in the operator's browser instead of rendering as text. With `--all-interfaces` the dashboard is reachable from the whole network without authentication, so this was a live XSS surface, not just a local oddity.

**Repro:** Write an entry under BUGS.md's ## Open whose body contains `<img src=x onerror=alert(1)>`, run `tumwater gui`, and click the entry: pre-fix the tag executes instead of rendering as text. Deterministic unit repro — test/gui.test.ts "the dashboard page escapes backlog entry bodies before innerHTML" (added with this fix) pins both halves: the served page routes d.body through esc, and /api/backlog still serves the raw body (escaping is the page's job).

**Cause:** src/gui-page.ts's refreshTranscript() built the detail panel as `panel.innerHTML = "<span class='muted'>" + esc(d.title) + " …</span>\n" + (d.body || "(no details for this entry)")` — d.title escaped, d.body not. The body is model-written markdown from PLANS/BUGS/QUESTIONS.md (loops edit those files constantly), i.e. untrusted content by the same standard as transcript lines and event text, both of which are escaped (`lines.map(esc)`, `d.events.map(esc)`). Found by latent-bug sweep; no open bug had been recorded.

**Fix:** One line in src/gui-page.ts: `(esc(d.body) || "(no details for this entry)")` — esc("") is "", so empty bodies still fall back to the placeholder. Server unchanged: /api/backlog keeps serving raw markdown (the TUI renders it as plain terminal text, and other clients may want it unescaped). The regression test fails against pre-fix code on its page-structure assertion. Verified: build clean, full suite green. Files: src/gui-page.ts, test/gui.test.ts.

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
