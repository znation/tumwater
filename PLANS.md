# Backlog

This is the operator's view of what the team is carrying — open, in flight, done, and refused. You
write, sharpen, reorder and retire entries here too, usually through your own agent; the roles that
act on it are plan (adds and retires `## Planned` entries), feature (claims, completes, refuses, and
reports plan defects on `## Planned`), and bugfix (claims, fixes, and refuses `## Open`).
Refusals carry a note so the record shows an entry was
considered and set aside on purpose, and every state change is dated so staleness is visible.

## Planned

_None yet._

### The GitHub-issues mirror gets a terminal read: `tumwater issues` lists what the scan saw and what tumwater did about each issue, from the ledger file alone (planned 2026-11-21 by the plan role)

**Goal.** The GitHub-issues series (parts 1–5) landed the scan, the mirror check, the director queue
and the closer, but their state is only visible as the doctor's one `github issues` row and the
status snapshot's counts. An operator asking "which issues did the team see, and why was this one
left alone?" has no command to answer it. Add one read-only command, `tumwater issues`, mirroring
the shape of `tumwater quarantine`: a positioned list, a `--show <n>` detail, a `--grep` filter, and
`--json`.

**Approach.** Read only `.tumwater/state/github-issues.json` through the existing reader
`readGithubIssues` in `src/github/github-issues-state.ts` — never call `gh` (plans/github-issues.md
invariant 2: `gh` is called only by the orchestrator's scan and the doctor's `github issues` check).

- New pure module `src/github/github-issues-render.ts`, following `src/review/quarantine-render.ts`:
  `issueRows(ledger)` returns positioned rows (number ascending, positions 1..N) with `position`,
  `number`, `title`, `url`, `author`, `trusted`, `mirrored`, `labels`, `updatedAt` and the tumwater
  state folded in from the ledger's optional maps — `queued`, `declined` (with its `reason`),
  `fixedIn` (with its `sha`), `closed` (with its `at` and `shas`), `waitingPush` (with its shas) and
  membership in `retiredOnly`. Plus `grepIssueRows`, `issueRowAt(ledger, position)`,
  `renderIssues(rows, now)` and `renderIssueDetail(entry, position, now)`. Pure over its inputs: no
  I/O, no clock, every branch unit-tested with a hand-built `GithubIssuesLedger`.
- New `cmdIssues` (and a `cmdIssuesShow` branch routed before the flag gate, as `cmdQuarantine` does
  for `--show`) in `src/cli/cli-query-commands.ts`: `rejectUnknownArgs("issues", args,
  [JSON_FLAG, grepFlagSpec(ISSUES_GREP_VALUE_ERROR)])`, `refuseTeamWorkspace(root)`, then
  `sayJsonOrRender`-style output; registered as `issues:` in `COMMAND_HANDLERS` in `src/cli.ts`.
- One usage stanza in `src/cli/cli-help-text.ts`, beside the `tumwater quarantine` stanza:
  `tumwater issues [--show <n>] [--grep <text>] [--json]` plus its description continuation.
- One row in `docs/cli.md`'s table (between `Check state` and `Read a kept patch`) naming
  `tumwater issues` and every flag it offers — `test/cli-doc.test.ts` pins the help's command list
  and the help's long-flag set against the reference in both directions.
- Tests: new `test/cli-issues.test.ts` modelled on `test/cli-quarantine.test.ts` (writes the ledger
  with `writeFileDeep` at the path the state module reads, then runs the CLI), plus unit assertions
  on the render module; `test/help.test.ts` gains `"issues"` to `ALL_COMMANDS`, which its
  "ALL_COMMANDS names exactly the commands the full help lists" test cross-checks against the
  stanzas.

Deliberate non-goals for this entry: no `-f/--follow` (the ledger is rewritten only by a scan poll;
the list is cheap to re-run), no write mode of any kind, no dashboard card, and no new scan.

**Acceptance.**

1. With no ledger file, `tumwater issues` exits 0 and prints
   `the GitHub issues mirror has not been read yet`; `tumwater issues --json` prints
   `{ read: false, repo, branch }`-shaped output naming the same absence, not an error.
2. With a ledger naming three open issues — two trusted, one not, one of them mirrored —
   `tumwater issues` prints a header naming the repo and `3 open` with how long ago the scan ran,
   then three numbered lines ascending by issue number, each naming the squashed title, `trusted` or
   `untrusted`, `mirrored` or `not mirrored`, and the issue's age.
3. `tumwater issues --show <n>` prints, for the issue that list numbered `n`: full title, url,
   author and its `authorAssociation`, labels, `updated <ISO time>`, then tumwater's own state —
   `queued <ago>`, `declined <ago>: <reason>`, `fixed by <sha>`, `closed <ago>`, `waiting for a push
   of <shas>`, or `every mirroring entry is retired` — and the body excerpt when the ledger holds
   one; a position past the end fails with the same wording the quarantine detail view uses.
4. `--grep <text>` keeps only rows whose number or title contains the text, case-insensitively,
   each kept row still numbered as the full list numbers it, so `--show` addresses the same issue;
   a non-empty list where nothing matches prints `no GitHub issues match "<pattern>"` and exits 0;
   `--grep` with no value fails with the shared missing-value wording
   (`issues --grep needs text (usage: tumwater issues --grep <text>)`).
5. `--json` serves the rows as data: `repo`, `branch`, `checkedAt`, `gh`, `reason` when the gh probe
   was not ok, and `issues` — each with the row fields above plus its state — so a script never
   parses the text.
6. A ledger whose `gh` state is `missing` or `unauthenticated` still lists the issues it holds and
   adds one line naming that state (and its `reason` when present) — the read never depends on a
   working `gh`.
7. The command runs with `gh` nowhere on `PATH`: a test that writes a ledger and runs the CLI with
   that PATH prints the same list as the same ledger with `gh` present, proving no scan happened.
8. `tumwater help` lists the `tumwater issues` stanza, `tumwater help issues` prints it, shell
   completion offers `issues`, and `docs/cli.md` names `tumwater issues` and its flags; the existing
   help, completion and cli-doc checks pass with `"issues"` added to `ALL_COMMANDS`.
9. Unknown flags are refused with the standard unknown-argument wording naming the `issues` command,
   and running the command from a role worktree refuses the same way `quarantine` does.

### The model check's verdicts survive an orchestrator restart (planned 2026-11-21 by the plan role)

**Why.** `ModelCheckGate` keeps every pair's verdict in memory only, so when a deploy or a crash
restarts the orchestrator the map is empty and a pair that had failed is `checking` again: every
role on it is held while a fresh probe runs, and the doubling back-off (`retryMs`, capped at
`maxRetryMs`) is thrown away and restarts at one interval — a host that has been down for an hour
gets re-probed every `retryMs` instead of waiting out the back-off it already earned.
`plans/model-check.md`'s `## Not covered (follow-ups)` records exactly this: "Verdicts are in memory
only, so every restart (including self-redeploys) re-checks every pair and holds the roles for the
probe's few seconds." Do that follow-up.

**Approach.**

1. `src/paths.ts`: add `modelChecksPath(root)` returning `.tumwater/state/model-checks.json`,
   beside `githubIssuesPath`/`piListedModelsPath`/`qaCoveragePath`. The file holds
   `{ pairs: Record<string, ModelCheckEntry>, savedAt: number }` — one entry per pair in the same
   shape `recordModelCheck`/`recheckModelChecks` already produce (`pair`, `status`, `failures`,
   `probeAt`, `retryMs`, `probing`, `checkedAt`, and the optional `reason`/`reply`/`detail`), so no
   new verdict model is introduced.
2. `src/model-check/model-check.ts`: add `readModelCheckPairs(root): ModelCheckMap` and
   `writeModelCheckPairs(root, map): void` beside the other state helpers, reading through
   `readJsonFile` and writing through `writeJsonAtomic` (both `src/files/json-files.ts`) inside a
   best-effort wrapper that swallows a write error the way `stampHeartbeat`
   (`src/orchestrator/orchestrator-poll.ts`) does — a read-only working tree never breaks the
   check. Both normalize what they touch: the reader drops an entry that is not an object, drops
   any entry with `probing` true, and forces `probeAt`/`retryMs`/`failures` to finite numbers
   (`retryMs` floored at the policy's `retryMs`, so a corrupt file cannot make the check spam a
   provider); the writer also drops `probing` entries, because an in-flight probe dies with the
   process and a restart must not leave a pair looking mid-probe forever. The writer stamps
   `savedAt` (epoch ms) itself.
3. `src/model-check/model-check-gate.ts`: the constructor, which already takes `root`, seeds
   `this.checks` by passing the persisted map to `rekeyModelChecks` as the map to update — that
   function already keeps an existing entry for a pair in use (`map[pair] ?? {status: "checking",
   probeAt: now}`), so a persisted `failed` pair keeps its `probeAt`/`retryMs`/`failures` and stays
   held until its back-off comes due, while a pair the config added since is still `checking` with
   `probeAt: now`. A persisted `verified` pair starts `probing: false`, so the first poll does not
   re-probe it. Then persist the map from `poll()`, after `this.publish(input.info)` — not from
   `settle` alone, because the busy-deferral branch of `settle` and the `recheckNow()`/`suspect()`
   back-off changes land in the same map and are worth keeping. Write only when what would be
   written differs from the JSON this gate last wrote (hold that string in a private field), the
   same only-when-changed rule `publishInfoFields` uses for the info block, so a steady poll leaves
   the file untouched.
4. Same constructor, immediately after the seed: a sweep for a stale store. When the file's
   `savedAt` is absent or older than `this.policy.suspectMinMs` (10 minutes in
   `MODEL_CHECK_POLICY`), every seeded entry is re-opened for probing — `{ ...e, probing: false,
   probeAt: now }` — so the first poll probes every pair. Do not reuse `recheckModelChecks` for
   this: it moves only `failed` entries and leaves a `verified` one with `probeAt: null`, so a
   verdict days old would be trusted and that pair never probed again (a fault on it would surface
   only through `suspectModelCheck`). Stamping `probeAt: now` on every entry keeps today's restart
   behaviour for stale data — "every restart re-checks every pair" — while a store written within
   the suspicion interval keeps its verdicts and its earned back-off. No change to
   `src/orchestrator/orchestrator.ts` or `src/orchestrator/orchestrator-poll.ts` is needed: the
   gate is already built there with `root` and the policy, and its `poll` publishes and persists.
5. `src/team/team-orchestrator-info.ts`: `ModelCheckInfo` gains `savedAt?: number` — the store's
   stamp, copied onto every row the gate's `publish` builds — so the dashboard and the doctor can
   tell a verdict read from disk at restart from one probed in this process. `parseModelCheck` must
   keep the field the way it keeps `probeAt`/`checkedAt` (`isFiniteNumber` guard), or a round-trip
   through `readOrchestratorInfo` silently drops it. The doctor (`checkModelChecks` in
   `src/doctor/doctor-fallback-checks.ts`, which takes the info block's `ModelCheckInfo[]`) needs no
   change: the info block stays the single live source.
6. Docs: rewrite that `plans/model-check.md` follow-up bullet to say the verdicts are persisted
   (naming `modelChecksPath` and the restart path); extend the model-check paragraph in
   `docs/how-it-works.md` (the one that starts "The model check proves every model pair the team can
   run on can answer" and ends "The check runs for `tumwater start`, not for a `--once` round") with
   one sentence naming `.tumwater/state/model-checks.json` and saying the verdicts and their
   back-off survive a restart, and that a verdict older than the suspicion interval is re-probed
   rather than trusted. `docs/invariants.md` binds no model-check symbol today (grep it for
   `ModelCheckGate`: no match), so add nothing there.

**Files touched:** `src/paths.ts`, `src/model-check/model-check.ts`,
`src/model-check/model-check-gate.ts`, `src/team/team-orchestrator-info.ts`, `plans/model-check.md`,
`docs/how-it-works.md`; tests in `test/paths.test.ts`, `test/model-check.test.ts`,
`test/orchestrator-model-check.test.ts`.

**Acceptance criteria.**

- `test/paths.test.ts`: `modelChecksPath(root)` is `.tumwater/state/model-checks.json`, and both
  "config lives at the repo root; every other runtime state lives under .tumwater" and "pins the
  full runtime layout" name the new path (the same two entries every new state file has to name).
- Gate unit test in `test/model-check.test.ts` (the `manualProber`/`makeRepo`/`POLICY` style): a
  gate constructed over a `.tumwater/state/model-checks.json` recording `local/flint` as `failed`
  with `failures: 3` and a future `probeAt` holds that pair's roles and starts no probe at all on
  its first poll; the same pair with a past `probeAt` is probed once. After the first gate's probe
  fails, a second gate over the same file sees `failures: 4`; after one answers, `readModelCheckPairs`
  reports that pair as `verified`.
- A corrupt store is survived: with `{"pairs":{"local/flint":{"status":"nope","retryMs":"x",
  "probeAt":null}}}` on disk, the gate does not hold the pair forever — it probes it on its first
  poll — and the next write leaves the file valid JSON whose `retryMs` is a finite number at least
  `POLICY.retryMs`.
- Restart end to end, in `test/orchestrator-model-check.test.ts` (the `makeFastRepo` + `fakePiNoCheck`
  pair `local/flint`): the first orchestrator round leaves the pair failed and
  `.tumwater/state/model-checks.json` on disk; a second `runRepoOrchestrator` over the same repo,
  whose fake pi answers probes with word salad, starts no probe while the recorded back-off still
  runs — its fake's probe-log count stays where the first round left it — and its
  `orchestrator.json` still carries the `failed` row for that pair, with its `failures` count and a
  `savedAt` number.
- A stale verdict is re-tested, not trusted: with a store whose `savedAt` is older than
  `POLICY.suspectMinMs` and whose `local/flint` entry is `verified`, a gate over that file probes
  that pair on its first poll instead of letting its roles run on a verdict days old; with the same
  file one minute old, the gate starts no probe. A `failed` entry with a `probeAt` a day ahead is
  held past that `probeAt` when the store is fresh, and probed on the first poll when it is stale.
- No other reader appears: the doctor's model-check row and the dashboard still get their verdicts
  from `orchestrator.json` alone, so `checkModelChecks(false, null)` over a host that has a
  `.tumwater/state/model-checks.json` but no running orchestrator still returns the green row
  "not checked — a running team checks each model pair before running on it".

## Done
