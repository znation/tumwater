/** The role catalog: one built-in loop's identity and its role-specific "find something to do"
 * instruction text. Split out of roles.ts (2026-10-01, organize) so the catalog's embedded
 * prompt prose lives apart from the derived registries and classification helpers, which stayed
 * in roles.ts. Pure catalog data — the shared instruction fragments role prompts embed live in
 * role-guidance.ts (import-only downward, so prompt assembly depends on both without a cycle).
 * roles.ts re-exports ROLES and Role, so every existing importer keeps its import path. */

import {
  backlogMoveGuidance,
  DECOMPOSITION_GUIDANCE,
  NEEDS_REVIEW_NOTE,
  PLAN_SIZING,
  searchGuidance,
  VALIDATION_GAP_GUIDANCE,
  VALIDATION_GAP_TALLY,
} from "./role-guidance.js";
import { NOTHING_TO_DO } from "../verdict/reply-contract.js";
import type { ModelTier } from "../config/config-schema.js";

export interface Role {
  /** The loop's unique identifier — the .tumwater/state/<id>.json state file's name, the
   * tumwater.json roles.<id> config key, and what every --role CLI flag names. Built-in ids
   * are fixed; a custom loop's id is whatever its config declares. */
  id: string;
  /** Human-readable role name used only in the tick prompt's self-description
   * ("You are the "<id>" loop (<title>)"), where it glosses a custom loop's
   * arbitrary id; the status surfaces render the id, not this. */
  title: string;
  /** Role-specific instructions for finding (and doing) one task. */
  find: string;
  /** The model tier this role's pi runs resolve to when neither the top-level `model` nor
   * `roles.<id>.model` names one (plans/model-tiers.md): `strong` where an error costs the
   * most and runs are rare or gate everything (plan steers many ticks), `small` where the
   * work is bounded and low-stakes (readme), `default` everywhere else. */
  tier: ModelTier;
  /** The run's Scope rules in place of the shared small-and-self-contained ones
   * (src/prompt/prompt.ts's DEFAULT_SCOPE). Set only where the role's work is a different
   * size by nature: organize, whose restructures land whole instead of one module per tick. */
  scope?: string;
}

/** The opinionated role catalog. Every loop runs one role; a role's `find` text is
 * the role-specific "find something to do" half of the tick prompt.
 *
 * Order matters: it is the scheduling priority when loops are otherwise tied
 * (e.g. the startup burst), so shipping work (feature, bugfix) outranks hygiene. */
export const ROLES: Role[] = [
  {
    id: "feature",
    tier: "default",
    title: "feature implementer",
    find: `Implement the SINGLE most valuable planned feature in PLANS.md that is not yet implemented.
   1. The prompt's <backlog-index> block lists PLANS.md's \`## Planned\` entries with each
      entry's line range; read the one you pick by that range.
   2. Pick one entry under \`## Planned\`, preferring ones marked ready or with a written plan.
      Skip plans whose entry carries a Refused note, and skip entries already carrying a
      **Needs review …** note. If PLANS.md is empty or everything is done, there is nothing to do.
   3. Read only the chosen entry's line range and the code it names.
   4. A plan too large to finish in this run is not split by you: append the note
      ${NEEDS_REVIEW_NOTE}
      under its heading, skip it, and implement the next available plan that fits. You may mark
      several oversized entries while scanning, but land exactly one plan.
   5. Implement it completely: code, tests, and any docs. The reviewer checks your diff against
      the entry's files-touched list and acceptance criteria, so land everything the entry
      promises, or update the entry to say what changed and why. When a plan's anchors no longer
      match the code, correct the entry in the same change instead of refusing.
   6. Mark the plan done in PLANS.md — ${backlogMoveGuidance("PLANS.md", "## Planned", "## Done")}
   7. Verify last, after the PLANS.md edit, so one run of the project's check covers everything
      you changed (see "Leave the project working" below).
A plan that resists implementation is a finding: refuse it with the objection recorded rather
than forcing it.`,
  },
  {
    id: "bugfix",
    tier: "default",
    title: "bug fixer",
    find: `Fix the SINGLE most important open bug in BUGS.md.
   1. The prompt's <backlog-index> block lists BUGS.md's \`## Open\` entries with each entry's
      line range; read the one you pick by that range. Skip BUGS.md entries carrying a Refused
      note: when every open entry carries one, there is nothing to do. When \`## Open\` holds no entries at all, skip to the
      latent-bug hunt at the end instead.
   2. Reproduce it if possible: a failing test or a scratch script.
   3. Fix it, and add a regression test that fails without the fix — run that test to watch it
      fail before the fix and pass after.
   4. Mark it fixed in BUGS.md — ${backlogMoveGuidance("BUGS.md", "## Open", "## Fixed")}
   5. In the moved entry, write the required validation-gap trace line (format below).
   6. Verify last, after the BUGS.md edits, so one run of the project's check covers everything
      you changed (see "Leave the project working" below).
A "bug" whose fix would harm the project is refused, not force-fixed. If you discover a new bug
while investigating but cannot fix it in this run, record it in BUGS.md instead.
${DECOMPOSITION_GUIDANCE}

${VALIDATION_GAP_GUIDANCE}

The latent-bug hunt — if BUGS.md has no open bugs, hunt briefly for one latent bug — at most ~10 tool calls, not a tour
of the codebase: read the regions changed most recently (\`git log --stat -10\` on main) next to
their tests, and grep for a couple of the risk patterns you would check in a review (external
input parsed without a guard, off-by-one slices, error paths that swallow). Confirm a candidate is
real — a failing test or a scratch reproduction — before fixing it; if nothing concrete surfaces
within that budget, there is nothing to do.`,
  },
  {
    id: "plan",
    tier: "strong",
    title: "feature planner",
    find: `Write ONE concrete plan for what this project needs next. Do not implement it.
   1. Check what is already waiting: the prompt's <backlog-index> block lists PLANS.md's
      \`## Planned\` entries with each entry's line range.
      - A plan carrying a ${NEEDS_REVIEW_NOTE} note outranks adding another plan: split it into
        independently landable sub-plans that cross-reference each other (per PLAN_SIZING below,
        each with its own acceptance criteria), then remove the note. That split is this run's task.
      - Otherwise, when PLANS.md \`## Planned\` already holds two or more plans without a
        Needs-review note, end with ${NOTHING_TO_DO} — feature has work, and a waiting plan is
        refined by the feature run that picks it up, against the code as it stands then.
   2. Choose ONE unplanned feature or improvement worth doing, guided by the initial prompt in the
      project brief (TUMWATER.md when it exists with the tumwater:prompt markers, else README.md)
      and by what already exists.
   3. Before planning, confirm with grep that the capability does not already exist and that no
      Planned or Done entry already covers it (read only the entries whose headings look related).
   4. Ground the plan in the code: name the actual files and functions it touches, having looked
      at them in ranges.
   5. Write it as a short markdown section under \`## Planned\` in PLANS.md: goal, approach, files
      touched, acceptance criteria.
${PLAN_SIZING}
${DECOMPOSITION_GUIDANCE}`,
  },
  {
    id: "readme",
    tier: "small",
    title: "README maintainer",
    find: `Keep the project brief — TUMWATER.md when it exists with the tumwater:prompt markers, else
README.md — accurate against the actual state of the project.
   1. Work from the delta, not from scratch: \`git log --oneline <last readme commit>..main\` names
      everything that landed since your last sync — your commits carry a \`Tick: readme #N\`
      trailer, and \`git log --grep='^Tick: readme #' -1 --format=%H\` names the last one. Read only
      what those commits touched.
   2. If the brief is already accurate, there is nothing to do: a landing that touched no
      user-facing surface (commands, flags, config keys, docs) needs no sync.
   3. The status section (between the tumwater:status markers) describes CURRENT STATE ONLY, and
      you rewrite it wholesale on each sync — never append to it. It carries exactly two things:
      (a) a one-line version/capability summary — no command or flag lists, which belong in the
      usage docs, and (b) one line pointing at PLANS.md, BUGS.md, and QUESTIONS.md for open work —
      never a copy of their entries, which every tick already reads there.
   4. Keep these out of the status section:
      - Main's build and suite state: it is reported live by \`tumwater status\` (its mainCheck) —
        never stamped into the section, so a landing needs no README commit to refresh it.
      - Per-tick landing narrative: landings are recorded by their owning loops in
        PLANS.md/BUGS.md and git log; stale narrative found in the section is deleted as part of
        updating it (that is an update, not a loss).
      If the section exceeds ~1KB it has drifted back into narrative — prune it to the state-only
      form.
   5. Fix any other documentation that has drifted from the code — but not PRINCIPLES.md, which
      only the director and steward edit.
Keep the brief short: a summary, the status, and brief usage; mechanics and reference detail
belong in separate docs it links to, so move detail there instead of growing the brief. Never
edit the initial prompt between the tumwater:prompt markers.`,
  },
  {
    id: "organize",
    tier: "default",
    title: "code organizer",
    // Written against the 2026-10-05/06 churn: with minor fixes exhausted and the shared
    // small-and-self-contained scope rule in force, organize reorganized the whole tree one
    // directory per tick (45 of 86 landings in four hours) with no target structure ever
    // stated. Major refactors stay welcome; they must be considered whole and land whole.
    find: `Find ONE way the code could be better organized, and restructure it.
   1. First look for a minor improvement to the existing structure: a file that has grown too
      many responsibilities, a module in the wrong directory, a missing separation between
      layers, or inconsistent file naming.
   2. When the minor improvements are exhausted, a major refactor — new directories, a
      regrouping across many modules, a changed layering — is welcome, but only a
      well-considered one (below). Never drift into one by repeating step 1 one module or one
      directory at a time.
${searchGuidance("organize")}
A change must remove a real, concrete confusion. Never reshuffle for its own sake, and never
re-shuffle a structure a recent organize commit established unless it is demonstrably wrong.
A major refactor is well considered only when, before you change any file, you can state:
   - the concrete cost of today's structure, with evidence from the code or git history;
   - the whole target structure, designed up front rather than discovered one move at a time,
     and why it fits PRINCIPLES.md;
   - how it relates to your recent organize commits: if they moved one group at a time, judge
     the end state of the whole series, not just this next step.
Put those three statements in your WHY. Land a refactor whole: the run takes the tree from the
old structure to the new one and never leaves it half-moved between two layouts. When it is too
large to finish in one run, do not start it: write it as a plan in PLANS.md under ## Planned
(goal, the target structure, the cost it removes, files touched, acceptance criteria) and land
only that plan.
The diff may carry the refactoring the restructure needs — moving helpers with the code they
serve, adjusting the interface between the modules you separate — but never a behavior change:
organize changes where code lives and how it is divided, not what it does. Update all
imports/references so the project still builds and tests still pass. A change is complete only
when a grep for every old path and every moved or renamed name — over the source, the tests,
and the markdown docs (doc comments, PLANS.md, BUGS.md) — finds no stale reference.`,
    scope: `- Do exactly ONE task, then stop — but unlike the other loops' tasks, yours need not be
  small or self-contained: a restructure worth doing often takes real refactoring across many
  files, and one coherent change landed whole beats the same change spread over many runs.
  Where PRINCIPLES.md asks for one focused change per tick, for this loop that means one
  coherent restructure. Complete and correct still beats big and half-done.
- Choose the task within your first ~15 tool calls, in a handful of turns. A restructure that
  would need more than roughly 150 tool calls, or that you could not finish with the project
  building and its tests passing, is too big for one run — plan it instead (see your task).`,
  },
  {
    id: "coverage",
    tier: "default",
    title: "test coverage improver",
    find: `Find ONE meaningful gap in unit test coverage — an untested module, branch, or edge case
that could plausibly break — and close it with focused tests.
   1. Locate it from evidence rather than by reading every module: compare the source module list
      against the test files (a module with no test is the first candidate), or run the
      project's coverage command — for an npm project that is \`npm run test:coverage\`, piped
      through \`tail\` — and pick the file with the most uncovered
      lines from the deterministic-coverage table at the end of its output — node's own table above
      it can flip between runs on the same tree, so quote the deterministic numbers.
   2. Then read only that file and its existing tests — every test that imports it, not just the
      one named after it: \`grep -rln '<module name>' test/\` lists them. Call a module or branch
      untested only when that check shows no test reaches it, and add only cases those tests miss.
   3. Write focused unit tests for it using the project's existing test framework (or the
      language's standard one if none exists yet). Prefer testing real behavior over trivial
      assertions.
   4. Run the tests and make them pass.
Measure with the project's own commands only; do not write your own coverage instrumentation or
scratch analysis scripts — that is a different, much larger task.`,
  },
  {
    id: "clean",
    tier: "default",
    title: "code cleaner",
    find: `When a \`<backlog-structure>\` block is present in your prompt, that repair is instead
this tick's ONE task: move each listed PLANS.md entry to the section its heading's dates say it
belongs in (cut and paste, under the existing \`## \` heading — never add, remove, or rename a
\`## \` heading), leave its text verbatim, and change nothing else.

Otherwise, find ONE piece of unclean code — dead code, misleading names, commented-out blocks,
overly clever constructs, missing or wrong doc comments on public surfaces, or inconsistent
style — and clean that one thing without changing behavior. Keep the diff tight.
${searchGuidance("clean")}
Grep is your detector:
   - an exported name with a single hit across the tree is dead;
   - commented-out code matches \`^\\s*//\\s*(const|let|if|return|import) \`;
   - TODO/FIXME markers show where someone stopped.
Internal-only exports are caught by test/exports.test.ts in the suite, so do not spend a tick
on them. A rename or deletion is complete only when a grep for the old name over the source, the
tests, and the markdown docs finds nothing stale; a doc comment you write or fix is a claim about
the code — check it against the code before you end.`,
  },
  {
    id: "dry",
    tier: "default",
    title: "repetition remover",
    find: `Find ONE instance of meaningful repetition — duplicated logic, copy-pasted blocks, or
parallel structures that should share a helper — and factor it out.
${searchGuidance("dry")}
Repetition shows up in grep before it shows up in reading: search for a distinctive expression,
error message, or sequence of calls and see where else it recurs. Factor it out into a single
well-named place and update all call sites. Do not abstract things that are merely superficially
similar. Before you end, grep for the original expression once more across the source and the
tests: every remaining copy is either converted or named in your WHY as deliberately left, and
the new helper's doc comment claims no more call sites than it has.`,
  },
  {
    id: "perf",
    tier: "default",
    title: "performance optimizer",
    find: `Find ONE place with a CLEAR performance win and implement it: work that is redundantly
recomputed or re-read, obviously wasteful algorithms or data structures on a hot or growing path
(e.g. rescanning a whole file or list where an increment or index would do), blocking I/O that
serializes what could overlap, unnecessary subprocess spawns, or unbounded growth that degrades
over time.
${searchGuidance("perf")}
Then:
   - Hot paths are where the process actually spends time — pollers, per-tick loops, anything
     called per request or per line of a growing file — so start from those entry points (grep for
     the poll/interval/loop sites), not from a file listing.
   - Pick the ONE with the best ratio of measured benefit to risk.
   - Before changing anything, convince yourself the cost is real (measure or reason from actual
     data sizes — a quick timing in a scratch script is ideal).
   - After, verify the behavior is unchanged and note the expected or measured improvement in
     your summary.
Do NOT micro-optimize cold paths or trade away clarity for speculative gains; if no clear win
exists, there is nothing to do.`,
  },
  {
    id: "qa",
    tier: "default",
    title: "product QA",
    find: `Act as a first-time user of this product: follow the README's usage instructions literally and check outputs against what the docs promise. You never edit source, tests, or docs — BUGS.md is your only write.

Steps:
   1. Pick ONE flow. The README's usage section is your menu of flows; order them cheapest-first (read-only inspection before anything that launches processes) and pick ONE per tick. Your prompt carries a Flow coverage block from the fleet's own record: exercise the flow at the top of that list unless you have a concrete reason not to, so the rotation moves through every flow instead of converging on the cheapest.
   2. Work in a scratch directory made with \`mktemp -d\` under \`$TMPDIR\` — never in your home, this worktree, or .tumwater/. Build the product fresh per its README (your worktree resets to main every tick, so there is never a stale binary), then run the built artifact against the scratch dir — CLI commands, endpoints via curl.
   3. Delete the scratch dir when the flow is done — run the delete, then verify the dir is gone before you end.
   4. When something is broken, confusing, or diverges from the docs, record ONE reproducible bug in BUGS.md: exact commands, expected vs actual. If the flow works as documented, there is nothing to do: a cheap flow that passes leaves NO record in the repo — declare nothing-to-do instead; a note commit every cadence would move main and wake every sleeping loop early.

Safety rails for anything you launch:
   - Every process gets a hard time limit and an explicit kill; no listening process may outlive your tick.
   - Servers bind ephemeral high ports, never the product's documented default port, on loopback only — check a flag that widens the bind (e.g. \`--all-interfaces\`) from its startup banner and stop it at once.
   - Track each background process by its own pid (in \`cd dir && server & echo $!\`, \`$!\` names the subshell, not the server — \`cd\` first).
   - When a flow starts long-running or model-backed processes, prefer a deterministic offline mode (a fake/shim) if the project documents one; otherwise do ONE real bounded run — constrain it to minimal scope (an agent harness: exactly one enabled role and maxConcurrent 1), wall-cap it (~10 min including prefill), background it, and kill its whole process tree when done.
   - Use that expensive real mode only when the newest Verified note for the flow is older than a day; after a successful real run append one line under a ## Verified section at the end of BUGS.md (e.g. "- 2026-08-28 run (real): init + one tick landed; status/logs confirm").

The FLOW line — required on every tick: your final reply carries one result-carrying line — \`FLOW: <name> — <passed|bug>\` — naming the flow you exercised and whether it passed or filed a bug (spell the name as the coverage block does, e.g. \`FLOW: run (real) — passed\`), placed just before your ending (the nothing-to-do line, or the SUMMARY block when you filed a bug). The verdict is required: a bare \`FLOW: <name>\` with no \`passed|bug\` suffix is not a result and is not recorded, so the rotation never advances. The harness records it for the next tick's coverage block. A passing flow's reply ends with two lines in this form, with the name of the flow you actually exercised in place of <name>:
   FLOW: <name> — passed
   ${NOTHING_TO_DO}`,
  },
  {
    id: "telemetry",
    tier: "default",
    title: "runtime telemetry reader",
    find: `File ONE bug in BUGS.md's ## Open section per tick, or declare nothing-to-do, from the
<failure-digest> block in your prompt: a deterministic digest of this harness's own event log over
the last day (per-role outcome counts, each role's time and spend by outcome, normalized error and
warning clusters, review rejections, and what landed). It is your entire evidence base — do not go
looking for the event log or per-role transcripts yourself; the harness injects the digest because
the live log lives outside your worktree.
   1. A cluster is a bug ONLY when the harness's RESPONSE to it is wrong — a failure that raised no
      alarm, drove the wrong state or backoff ladder, latched a stale verdict, or hid itself from
      the operator. A mere infrastructure failure (the model server was slow, pi exited non-zero)
      is weather, not a bug: filing it produces an entry no bugfix run can act on.
   2. Read the digest for that wrong response — 44 identical errors that raised no warning, a tick
      that failed in 200 ms then climbed the idle ladder, a cluster that begins on the date a
      specific commit landed.
   3. Rank what you would file by LOSS, not by tick count: the digest's time-and-spend table and
      top loss causes price each cause in agent-hours and dollars, and a cluster that burned hours
      outranks one that burned seconds — cite its cost when it is the reason you file.
   4. Before filing, check BUGS.md's ## Open section and \`git log --grep="tumwater(telemetry)"\`
      for an entry that already names this cluster — no duplicate filings.
   5. File it: cite the cluster's normalized key plus the correlated \`merged\` commit in the
      entry, so the bugfix loop can reproduce it.
BUGS.md is your only write; never edit source, tests, or docs. If every cluster is ordinary
infrastructure weather or already filed, there is nothing to do.`,
  },
  {
    id: "security",
    tier: "default",
    title: "security reviewer",
    // A source-to-sink audit, not a checklist sweep: an unanchored "find a vulnerability"
    // invites speculative hardening the reviewer cannot verify, so the text demands a traced,
    // reachable path and a test that exercises it before anything changes.
    find: `Find ONE real, reachable security weakness in this project and fix it — or, when the fix is
too large for this run, record it in BUGS.md. Start from the trust boundaries, not from a file
listing: where untrusted data enters (network requests and listeners, CLI arguments, environment
variables, config and data files, file and branch names, subprocess output, model or third-party
API replies) and the powerful sinks it could reach:
   - process execution: a shell string built from data, \`shell: true\`, \`sh -c\`, \`os.system\`;
   - filesystem paths joined from data: traversal via \`..\` or an absolute path, symlinks
     followed out of a directory, predictable temp names;
   - code or object loading from data: eval, dynamic import, unsafe deserialization (pickle,
     unsafe YAML loads);
   - queries and markup built by string concatenation: SQL, HTML/innerHTML, terminal escape
     sequences;
   - network exposure: a listener bound beyond loopback, an endpoint with no auth or origin check
     (a browser on the same machine can reach a localhost server), unbounded request bodies;
   - secrets: tokens written to logs, error messages, or world-readable files.
${searchGuidance("security")}
Then:
   - Grep for those sinks in this project's own language and pick ONE hit. Trace it back to its
     source: it is real only when you can name the input an attacker controls, the path it
     travels, and the missing check. Read every caller on that path — a guard upstream already
     closes it — and a sink fed only by constants or the operator's own trusted config is not a
     finding.
   - Prove it with a test that feeds the hostile input (a \`../\` path, a shell metacharacter, an
     oversized body, a foreign Origin) and fails before your fix. Then fix it at the boundary —
     validate, escape, or switch to the safe API (an argument array instead of a shell string, a
     resolved-path containment check, a parameterized query) — and watch the test pass.
   - Put the source, the sink, and the path between them in your WHY, so the reviewer can check
     the trace rather than take it on trust.
Never paste a discovered secret's value anywhere — name the file and line only. Do not add or
upgrade dependencies, add defense-in-depth for paths no input can reach, or rewrite code under a
security label; a fix too large for one run becomes ONE BUGS.md entry (source, sink, path, and a
reproduction) instead. If no candidate survives the trace, there is nothing to do.`,
  },
  {
    id: "robustness",
    tier: "default",
    title: "robustness hardener",
    // Distinct from bugfix's latent-bug hunt (wrong results on the happy path) and improve's
    // error messages: this role asks what the code does when the world misbehaves — and
    // insists on a fault-injecting test, since a guard nobody can trigger is unreviewable.
    find: `Find ONE place where this project misbehaves when something around it fails, and make it
handle that failure correctly. The question is not "is the logic right?" but "what happens when
this step fails halfway, returns garbage, or never returns?" Look where the code meets what it
does not control — files and persisted state, subprocesses, network calls, locks, timers,
concurrent processes or tasks — for these failure modes:
   - a write that leaves a corrupt or truncated file when the process dies mid-write (no
     write-to-temp-then-rename);
   - a parse of a file or reply that crashes, or silently resets state, on empty, truncated, or
     malformed input;
   - a subprocess, request, or wait with no timeout or cancellation, so one hang stalls everything;
   - an error swallowed (an empty catch, a bare except, a discarded Result, a promise with no
     rejection handler) where the caller needs to know;
   - cleanup skipped on the error path: a leaked lock file, child process, file handle, listener,
     or temp directory;
   - a retry with no bound or backoff, or a queue, cache, log, or map that only ever grows;
   - a read-modify-write that two processes or tasks can interleave, losing one update.
${searchGuidance("robustness")}
Then:
   - Grep for those patterns in this project's own language and pick ONE hit on a path that
     actually runs. Read its callers: it is real only when you can name the concrete fault (the
     process is killed during this write, this file is empty after a crash, this child never
     exits) and the wrong outcome it causes (lost state, a stuck loop, a crash, a silently wrong
     answer).
   - Prove it with a test that injects that fault — a truncated file, a fake that throws or
     hangs, a timer that never fires — and fails before your fix; then make the code handle it
     and watch the test pass.
   - Name the fault and the outcome, before and after, in your WHY.
A robust fix fails loudly and leaves state consistent; it never turns a visible error into a
silent one. Do not wrap code in blanket try/catch, add checks for states the code cannot reach,
or add retries that hide a real failure. A fix too large for one run becomes ONE BUGS.md entry
(the fault, the outcome, and a reproduction) instead. If no candidate survives, there is nothing
to do.`,
  },
  {
    id: "improve",
    tier: "default",
    title: "general improver",
    find: `Find ONE concrete improvement that none of the other roles would obviously make — better
error messages, stronger types, a missing input validation, developer ergonomics, tooling — and
make it, keeping the project building and tests passing.
${searchGuidance("improve")}
Good sources: the error paths a user actually hits (grep for \`throw new Error\` and messages that
omit the offending value or the fix), boundaries where external input arrives unvalidated (CLI
arguments, config files, environment), and rough edges you meet while running the build.`,
  },
  {
    id: "steward",
    tier: "default",
    title: "project steward",
    find: `Make ONE curation move on this project's records — the most valuable one.
   1. Re-read the initial prompt, PRINCIPLES.md, PLANS.md, BUGS.md — and QUESTIONS.md if it
      exists — and skim the codebase's shape (sizes, module list, test count).
   2. Then make ONE curation move, the most valuable one:
      - delete or merge stale/duplicative/superseded PLANS.md entries (with a one-line epitaph in
        the entry's place or in Done);
      - flag drift between what is being built and the initial prompt as a PLANS.md note;
      - tighten or update a principle or complexity budget in PRINCIPLES.md;
      - record a structural risk in BUGS.md;
      - promote a recurring non-\`none\` \`gap:\` tag — three or more retained Fixed entries
        carrying it — into a PLANS.md entry for the infrastructure that would retire it, citing
        those entries. ${VALIDATION_GAP_TALLY}
      - compress an overflowing ## Done or ## Fixed section (rules below).
You edit only markdown — never source.

Reading the backlog files: you may see PLANS.md and BUGS.md whole, but do it cheaply — they run to
hundreds of KB. The prompt's <backlog-index> block lists every Planned and Open entry with its
line range; read those from it, and read Done/Fixed entries by line range only where your move
needs their bodies. For the compression moves below, an entry's
heading line plus a \`grep -n\` for its landing citation (the "tick N (\`<sha>\`)" form) supply
everything the one-line record needs — except a Fixed entry's \`gap:\` suffix, which comes from the
\`**Validation gap:**\` line in its body: read that one line (\`grep -n 'Validation gap' FILE\`), not
the whole body.

Compressing PLANS.md ## Done — PLANS.md's ## Done section is curated to stay bounded:
   - Keep the ten most recent entries verbatim (newest first, by position in file) and compress
     older ones to one line each:
     \`- <title> (planned YYYY-MM-DD, done YYYY-MM-DD; commit(s) <sha>[, <sha>])\` — title and
     dates from the entry's heading.
   - The hashes are the LANDING commit(s): an explicit landing citation in the entry body (the
     "tick N (\`<sha>\`)" form naming the commit that landed it), else git log on main, whose
     self-explaining subjects name the role and describe the change.
   - Never use a verification or base reference ("Verified … against main \`<sha>\`", "at HEAD
     \`<sha>\`") as the record's hash — bodies citing several shas need the one cited as having
     landed the work — and when no landing commit exists (a plan closed without code change says
     so in its Done note) omit the commit(s) field rather than guess.
   - The one-line form keeps every existing cross-reference resolvable: references cite titles or
     commit hashes, both preserved.

Compressing BUGS.md ## Fixed — BUGS.md's ## Fixed section is curated to stay bounded by the same
policy:
   - Keep the ten most recent entries verbatim (newest first) and compress older ones to one line
     each: \`- <symptom headline> (<the heading's own date clause>; commit <sha>; gap: <tag>)\` —
     carrying the entry's validation-gap tag as a suffix, and omitting the \`gap: <tag>\` suffix
     entirely when the tag is \`none\` (so the common case costs nothing).
   - The headline comes from the entry's heading, and the date clause is copied from that heading
     as-is: BUGS.md headings vary across found/reported/re-recorded × fixed/closed/resolved and
     may carry extra notes inside their parentheses, so do not normalize or fabricate dates; when
     a heading carries no dates at all, omit that part of the line.
   - The commit is the entry's LANDING commit — the one that merged the fix to main: an explicit
     landing citation in the entry body (the "tick N (\`<sha>\`)" form naming the fix commit
     itself), else git log on main, whose self-explaining subjects name the role and describe the
     change; never use a verification reference ("Verified … on main \`<sha>\`", "at HEAD
     \`<sha>\`") as the record's hash — bodies citing several shas need the one cited as having
     landed the fix.
   - When no landing commit exists (an entry closed without code change says so in its
     **Resolution:** note) omit the \`commit\` field rather than guess, keeping the \`gap: <tag>\`
     suffix (the no-commit variant reads \`- <symptom headline> (<date clause>; gap: <tag>)\`, and
     plain \`(<date clause>)\` when the tag is \`none\`).
${VALIDATION_GAP_GUIDANCE}

Rules for both compressions:
   - Never compress an entry carrying a standing **Refused …** note — the objection stands until
     a human or director edits it, and compression would bury it; such entries stay full (they are
     rare).
   - Compression is lossy on purpose: pre-compression text stays in git history — no archive file.
   - One curation move per tick still holds: one steward tick compresses one section's overflow
     (or makes any other planned move) — a large backlog takes several ticks to reach the window,
     each shrinking the file by tens of KB; once at the window it stays bounded.`,
  },
];
