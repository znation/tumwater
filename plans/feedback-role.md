# Upstream feedback — the telemetry concept back as an opt-in role that files bugs to the tumwater project

Planned 2026-10-23, requested by the user. Shared design for the two `Feedback role` entries in
PLANS.md; each is independently landable and cross-references this document. Siblings:
plans/telemetry-role.md (the digest and the selfcheck charter this builds on) and
plans/observer-roles.md (the observer scheduling both roles ride).

## The problem

The old `telemetry` role — renamed `selfcheck` (docs/glossary.md "Role names", src/roles/legacy-role-ids.ts) — reads the injected failure digest and files ONE bug per run into the **local BUGS.md**. That charter is only right on the tumwater repo itself. On any other install, every finding is a bug in tumwater filed into the end user's backlog, "which that project's bugfix role rightly rejects" (the comment at src/config/config.ts:53-58 says exactly this). The fix so far was to make it the one opt-in role — but opting in only moves the misfiled bugs *into* your project; it does not route them anywhere useful.

The evidence itself is valuable from every install. plans/telemetry-role.md's audit: 8 of 55 bugs in this repo's BUGS.md came from a human reading the event log by hand, and zero from a loop — and a human only reads the log of an install they sit at. The maintainer currently has no channel from the fleet of installs back to the project. What is wrong is not the concept but the destination.

## The decision

**A new sibling role, `feedback` — selfcheck stays as it is.** The user picked the id (permanent
per plans/terminology.md: role ids land in state files, docs and the GUI; the retired `telemetry`
id cannot be reused — `LEGACY_ROLE_IDS` already maps it to `selfcheck`). selfcheck remains the
dogfood role: on the tumwater repo itself, harness bugs belong in this repo's BUGS.md where the
bugfix role can act on them. `feedback` is the same reading of the same digest with the
destination swapped: file ONE bug per run as a **GitHub issue on
[github.com/znation/tumwater](https://github.com/znation/tumwater)**, never into the local
BUGS.md. The two are alternatives per install, and the docs say so; on this repo, selfcheck is
enabled and feedback stays off.

**Opt-in by default-off config, exactly selfcheck's precedent.** `roles.feedback = { enabled: false,
minRunIntervalSeconds: 7200 }` beside `roles.selfcheck` (src/config/config.ts:59). The opt-in is
`"feedback": { "enabled": true }` in the end user's tumwater.json — the same key, example-file and
`role --enable` surfaces selfcheck already uses. **tumwater.example.json does not enable it**: the
example file is the template this repo ships and `init` seeds from
(src/config/config-example.ts), and on this repo selfcheck is the right observer.

**The harness adds no GitHub client.** The only outbound channel is the role's own shell running
`gh` under the operator's own `gh` login. Verified today: `grep` over src/ for `gh`, GitHub REST,
`GITHUB_TOKEN` finds nothing — the harness's only outbound fetches are the models.dev catalog
(src/agent/opencode/opencode-catalog.ts) and a doctor probe; every backend run already has a full
shell tool with inherited env (the write guard covers file-edit tools only, src/agent/write-guard.ts,
so a bash-run `gh` is fine; short marker-attributed children are swept normally at run exit).
So: zero new network code in core, no token storage, no credentials in `.tumwater/` state, and the
filing happens as the operator's own GitHub identity — auditable and revocable by them. The
charter tells the model the exact command; the harness never composes an HTTP request.

**A run writes nothing local.** The role never edits the repo: no BUGS.md, no commit, no merge,
no review. Every fulfilled run ends `no_change` with the nothing-to-do sentinel — the reading of
the sentinel observers already rely on (a passing `qa` flow ends the same way, catalog line
src/roles/role-catalog.ts:362-364), and the no-change machinery (src/run/run-verdict.ts:316-357)
treats it as fulfillment without the "finished without changes" warning. Because the diff is
always empty, the review gate, `review.exemptPaths`, and `falseFixReason` are untouched by
construction.

**The model reports its filing on a result line; the harness keeps the memory.** A fresh session
every run means the only durable record of what this install already filed must live in harness
state, exactly as `qa`'s flow rotation does (plans/observer-roles.md 2/2; src/run/qa-coverage.ts).
The reply contract gains a `FILED: #<n> — <title>` line, extracted like qa's `FLOW:` line
(src/verdict/reply-contract.ts:194, `labeledLine`-anchored, absent/malformed → null so a truncated
run never records), and persisted to a per-install ledger that the next run's prompt renders back
as a "previously filed" block. Cross-install dedupe is the charter's job: `gh issue list
--search` before every `gh issue create`.

## Invariants

1. **Nothing leaves the machine until the operator opts in.** `feedback` defaults to disabled on
   every install, like `selfcheck`; no config, no network calls, no digest rendered for it.
2. **The only outbound channel is the model's shell under the operator's `gh` login.** The harness
   itself makes no network request for this feature and stores no credentials.
3. **The issue body is bounded and redacted.** The charter forbids absolute paths, secrets, and
   project source beyond what the digest already shows; the digest itself is capped (~6 KB,
   plans/telemetry-role.md invariant 2) and its cluster keys are normalized. The body cites the
   cluster's normalized key, its count and roles, the correlated `merged` commit, and the output
   of `tumwater version`.
4. **The role never edits the repo.** Every fulfilled run ends `no_change`; nothing moves main
   and no role is woken by a filing.
5. **No duplicate filings.** Before each `gh issue create`: the injected "previously filed" block
   (this install's ledger) and `gh issue list --search` (cross-install). One issue per run, and
   a run that files nothing declares nothing-to-do.
6. **Scheduling is the existing observer machinery, unchanged.** `feedback` joins `OBSERVER_ROLES`
   (src/roles/roles.ts:38) and nothing else: not `DEFERRABLE_ROLES`, not
   `BASELINE_BLOCKED_ROLES`, no idle-ladder climb, the same 7200 s clock as selfcheck.

## Shape

### Part 1 — the role

- **src/roles/role-catalog.ts** — the `feedback` entry, inserted after `selfcheck` (line 366-398)
  and before `security` (line 399), `tier: "default"`, title
  `feedback: files tumwater bugs upstream on GitHub`. The charter mirrors selfcheck's five rules
  (evidence: the injected `<failure-digest>`; rule 1 verbatim — a cluster is a bug ONLY when
  tumwater's RESPONSE to it is wrong; rank by loss; dedupe; file) with the destination swapped:
  - file with `gh issue create --repo znation/tumwater --title … --body …` from the shell, and
    verify the issue URL in the command's output before reporting it;
  - dedupe via `gh issue list --repo znation/tumwater --search <cluster terms>` (part 2 adds the
    injected ledger block to this step);
  - the body rule of invariant 3, with `tumwater version` cited;
  - closing rule: "You never edit files in this repo — `gh` is your only write. End every run
    with the nothing-to-do sentinel; when you filed, one `FILED: #<n> — <title>` line rides just
    above it (part 2), named as qa's FLOW line is."
  - a run that cannot file because `gh` is missing, unauthenticated, or failed ends **without**
    the sentinel, naming the failure in its final prose: the resulting
    "finished without changes and without declaring nothing-to-do" warning
    (src/run/run-verdict.ts:321-326) is the visible, digest-clusterable signal, and doctor's
    check below makes the case rare. (Tradeoff: the warning text says "non-compliance", but it is
    the one existing channel that both survives and clusters; a new outcome type is not worth the
    seam for a doctor-covered failure mode.)
- **src/roles/roles.ts** — `OBSERVER_ROLES` gains `"feedback"` (line 38) and the comment names
  it. `DEFERRABLE_ROLES` and `BASELINE_BLOCKED_ROLES` exclude it by construction — no code change,
  but their doc comments (lines 36-37, 96-98) gain the role so the next edit does not miss it.
- **src/run/run-prompt.ts** — line 177 becomes
  `const digest = base === "selfcheck" || base === "feedback" ? selfcheckDigest(root) : undefined;`
  with the comment above it naming both observers.
- **src/run/selfcheck-digest.ts** — no behavior change; the module doc comment (lines 1-22) names
  both consumers so the shared window (`SELFCHECK_DIGEST_MS`, trailing 24 h) reads as deliberate.
- **src/config/config.ts** — `roles.feedback = { enabled: false, minRunIntervalSeconds: 7200 }`
  beside line 59, and the comment at lines 53-58 rewritten: the two opt-in roles, why (selfcheck:
  findings in the wrong backlog; feedback: nothing leaves the machine uninvited), and that the
  example config keeps selfcheck (dogfood) and not feedback.
- **Doctor: a `feedback filing` check**, following the codex-login pattern (plans/codex-backend.md
  part 9/9): shown only when `config.roles.feedback?.enabled` —
  - `gh` resolves and `gh --version` answers (bounded), else fail: install gh;
  - `gh auth status` exits 0, else fail: "run `gh auth login` — the feedback role files issues as
    your GitHub login".
  Files: src/doctor/doctor-model-checks.ts (the check), src/doctor/doctor.ts (the conditional
  step), src/doctor/doctor-check-names.ts (the name, so `tumwater doctor feedback filing` parses).
- **Docs** — README.md's status line (lines 43-44: two opt-in roles, 16 catalog roles);
  docs/config.md:102 (`enabled` default `false` for selfcheck and feedback) and :108 (feedback
  joins the 7200 s clock list); docs/glossary.md:61 (the observer group names qa, selfcheck and
  feedback); docs/how-it-works.md's observer/opt-in mentions name feedback; a docs/config.md
  sentence: feedback and selfcheck are alternatives — selfcheck on the tumwater repo itself,
  feedback anywhere else.

Part 1 tests: test/roles.test.ts (the `exempt` set at line 52 gains `feedback`; the observer
assertion at line 71 gains it; the message at line 69), test/config.test.ts (the default-off loop
at lines 40-48 skips both opt-ins and asserts `roles.feedback?.enabled === false`; line 63 adds
feedback's 7200; the `slow` set at line 71 gains feedback), test/prompt-roles.test.ts (a feedback
charter contract test, oneLine-anchored like selfcheck's), test/run-prompt.test.ts (line 458's
"neither evidence block" roles become "other than qa, selfcheck, feedback"; a feedback prompt
carries `<failure-digest>`), test/doctor-checks.test.ts (line 307's count becomes
`allRoleIds().length - 2`; the gh check's pass/fail rows on a fake gh, test/fakes/fake-gh.ts),
test/fixtures/orchestrator-fixtures.ts needs no edit (fastConfig zeroes seeded clocks by
iteration, lines 86-89).

### Part 2 — cross-run memory and visibility

- **src/verdict/reply-contract.ts** — `extractFiled(text)` beside `extractFlow` (line 194):
  `labeledLine(text, "FILED")`, then `/^#(\d+)\s*[—-]\s*(.+)$/`; null on no match, no number, or
  an empty title. Returns `{ issue: number; title: string }`.
- **src/runner/runner-run.ts** — beside the qa extraction at line 731:
  `const filed = ctx.baseRole === "feedback" ? extractFiled(pi.finalText) : null;`, threaded into
  the verdict context beside `flow`.
- **src/run/feedback-filings.ts** (new, mirroring qa-coverage.ts) — the ledger
  `{ filings: [{ issue, title, filedAt }] }`, newest 100; `readFeedbackFilings(root)` (malformed →
  empty), `recordFiled(root, issue, title, now)` (atomic read-modify-write, `writeJsonAtomic`),
  and `renderFilingsBlock(filings, now)` → `undefined` when empty, else a bounded
  "Previously filed from this install" block, newest first, each line
  `#<n> <title> (<age>)` using qa-coverage's `formatAge` idiom.
- **src/paths.ts** — `feedbackFilingsPath(root)` = `.tumwater/state/feedback-filings.json`, with
  the qaCoveragePath-style doc comment.
- **src/prompt/prompt.ts** — `RunPromptInput` gains `filings?: string` (documented beside
  `digest`, line 310-313), rendered as a block beside `digestBlock` (line 253-257).
- **src/run/run-prompt.ts** — `const filings = base === "feedback" ? renderFilingsBlock(readFeedbackFilings(root)) : undefined;`
  in the same try/catch shape as the qa coverage block (lines 183-189); passed to
  `buildRunPrompt`.
- **src/run/run-verdict.ts** — the no-change branch records beside the qa flow (lines 334-346):
  a non-cut-off `ctx.filed` calls `recordFiled` and logs `issue_filed` (below); a failed write
  warns `feedback filing #<n> not recorded: …` and never fails the run. The context interface
  (line 62) gains `filed: FiledResult | null`.
- **src/run/run-stage.ts** — the changed-branch mirror of qa's `recordFlow` (line 381): a
  feedback run that somehow also changed the tree still records its filing, exactly as qa's does.
- **Event: `issue_filed`** — src/events/events.ts's type union (line 42-128) gains it, carrying
  `issue` and `title`; src/events/event-format.ts renders
  `filed issue #<n> <title> on znation/tumwater`; src/events/event-labels.ts gains the label
  `issue filed`. Logged best-effort from run-verdict with `source` the role.
- **src/roles/role-catalog.ts** — the charter's dedupe step gains one sentence naming the
  injected "previously filed" block.

Part 2 tests: test/reply-contract.test.ts (`extractFiled` parses `FILED: #12 — title`; `FILED: title` without a number, a mid-sentence mention, and a truncated `FILED: #12 — tit` yield null — the last mirrors the BUGS.md 2026-09-23 flow-line lesson: never latch a result the run never declared), test/feedback-filings.test.ts (new: ledger round-trip, 100-entry cap keeps newest, malformed file reads empty, empty ledger renders no block, block renders newest-first with ages), test/run-prompt.test.ts (a feedback prompt with a non-empty ledger carries the filings block; other roles never do), test/run-verdict.test.ts (a no_change feedback run with `filed` records the ledger entry and the run's next prompt shows it — mirroring lines 156-171's qa shape, including the failed-write warning; a cut-off run records nothing, mirroring the flow guard at line 334), test/event-format.test.ts and test/event-labels.test.ts (the `issue_filed` rendering and label).

## Sequencing

1. **1/2 — the role.** Catalog, observers, digest injection, config default, doctor check, docs.
   Independently useful: an opted-in install files real issues, deduped by the charter's
   `gh issue list --search`.
2. **2/2 — memory and visibility.** The FILED line, the ledger, the prompt block, the
   `issue_filed` event. Requires 1/2; without it every run re-derives its dedupe from the network
   alone and the operator's activity feed shows nothing.

## How we will know it worked

The telemetry plan's metric was "bugs filed that a bugfix tick later lands a fix for". The
upstream analogue: issues on znation/tumwater that came from an opted-in install and that the
bugfix role later closes with a landing. The baseline is the same zero it started from — today
the maintainer hears about an install's harness bug only if the operator reads their own event
log by hand and writes it up. If after a month the issues are noise, the charter's rule 1 is not
being enforced and the role should be tuned or retired; if they cluster with the human-found
kind, the fleet has acquired the return channel it never had.

## Deliberately out of scope

- **A harness-side GitHub REST client, token storage, or config for credentials.** The model's
  shell plus the operator's `gh` login is the whole channel (the decision above).
- **A configurable target repo or labels.** The destination is the tumwater project; a fork that
  wants its own tracker forks the charter line. Labels depend on maintainer-side state and would
  make `gh issue create` fail on a missing label.
- **Analytics-style telemetry.** No usage collection, crash reporting, or automatic uploads —
  the digest already exists, and this feature files a considered bug report a model wrote under
  rule 1, nothing else.
- **Enabling feedback on the tumwater repo itself.** Dogfood stays selfcheck's job; the example
  config keeps it that way.
- **Alerting on filing failures** beyond the standard no-change warning and the doctor check.
- **A config-validation cross-check refusing selfcheck and feedback both enabled.** They are
  documented alternatives; the operator may have a reason, and the gate's job is not to enforce
  taste.
