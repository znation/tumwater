/** The role catalog and its derived registries. Pure catalog data — the shared instruction
 * fragments role prompts embed live in role-guidance.ts, which this module imports (still
 * import-only downward, so prompt assembly depends on both without a cycle). */

import {
  backlogMoveGuidance,
  DECOMPOSITION_GUIDANCE,
  NEEDS_REVIEW_NOTE,
  PLAN_SIZING,
  searchGuidance,
  VALIDATION_GAP_GUIDANCE,
  VALIDATION_GAP_TALLY,
} from "./role-guidance.js";
import { NOTHING_TO_DO } from "./reply-contract.js";

/** One loop's identity and instruction set: `id` is the key every surface names the loop
 * by, and `find` is the role-specific half of its tick prompt. */
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
}

/** The director loop's id — a target that is not in ROLES (allRoleIds appends it) and is
 * driven by operator prompts, not a find prompt: an un-targeted `tumwater prompt` queues
 * there. It keeps running through a fleet-wide `pause` (which stops only the role loops);
 * an un-targeted `stop` signals the whole orchestrator, director included. */
export const DIRECTOR_ROLE = "director";

/** The bugfix loop's id. It is the one work role that also defers like a maintenance role
 * while its backlog (BUGS.md `## Open`) is empty — see deferTick in src/scheduling.ts. */
export const BUGFIX_ROLE = "bugfix";

/** The opinionated role catalog. Every loop runs one role; a role's `find` text is
 * the role-specific "find something to do" half of the tick prompt.
 *
 * Order matters: it is the scheduling priority when loops are otherwise tied
 * (e.g. the startup burst), so shipping work (feature, bugfix) outranks hygiene. */
export const ROLES: Role[] = [
  {
    id: "feature",
    title: "feature implementer",
    find: `Implement the SINGLE most valuable planned feature in PLANS.md that is not yet implemented.
   1. List the entries cheaply: \`grep -n '^##' PLANS.md\` gives every heading with its line number.
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
A plan that resists implementation is a finding: refuse it with the objection recorded rather
than forcing it.`,
  },
  {
    id: "bugfix",
    title: "bug fixer",
    find: `Fix the SINGLE most important open bug in BUGS.md.
   1. \`grep -n '^##' BUGS.md\` lists the headings. Pick one entry under \`## Open\` and read only
      that entry's line range. Skip BUGS.md entries carrying a Refused note. If \`## Open\` holds
      no entry you can take, skip to the latent-bug hunt at the end instead.
   2. Reproduce it if possible: a failing test or a scratch script.
   3. Fix it, and add a regression test that fails without the fix.
   4. Mark it fixed in BUGS.md — ${backlogMoveGuidance("BUGS.md", "## Open", "## Fixed")}
   5. In the moved entry, write the required validation-gap trace line (format below).
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
    title: "feature planner",
    find: `Write ONE concrete plan for what this project needs next. Do not implement it.
   1. Check what is already waiting: \`grep -n '^##' PLANS.md\` lists every entry.
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
      - Per-tick landing narrative: No per-tick landing narrative in the section — landings are
        recorded by their owning loops in PLANS.md/BUGS.md and git log; stale narrative found in
        the section is deleted as part of updating it (that is an update, not a loss).
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
    title: "code organizer",
    find: `Find ONE way the code could be better organized — a file that has grown too many
responsibilities, a module in the wrong directory, a missing separation between layers, or
inconsistent file naming — and restructure that one thing.
${searchGuidance("organize")}
A move must remove a real confusion — never reshuffle for its own sake — and the diff stays the
move plus the import and reference updates it forces. Update all imports/references so the
project still builds and tests still pass. A move is complete only when a grep for the old path
and every moved name — over the source, the tests, and the markdown docs (doc comments, PLANS.md,
BUGS.md) — finds no stale reference.`,
  },
  {
    id: "coverage",
    title: "test coverage improver",
    find: `Find ONE meaningful gap in unit test coverage — an untested module, branch, or edge case
that could plausibly break — and close it with focused tests.
   1. Locate it from evidence rather than by reading every module: compare the source module list
      against the test files (a module with no test is the first candidate), or run
      \`npm run test:coverage\` (piped through \`tail\`) and pick the file with the most uncovered
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
    title: "product QA",
    find: `Act as a first-time user of this product: follow the README's usage instructions literally and check outputs against what the docs promise. You never edit source, tests, or docs — BUGS.md is your only write.

Steps:
   1. Pick ONE flow. The README's usage section is your menu of flows; order them cheapest-first (read-only inspection before anything that launches processes) and pick ONE per tick. Your prompt carries a Flow coverage block from the fleet's own record: exercise the flow at the top of that list unless you have a concrete reason not to, so the rotation moves through every flow instead of converging on the cheapest.
   2. Work in a scratch directory under the system temp — never inside this worktree or .tumwater/. Build the product fresh per its README (your worktree resets to main every tick, so there is never a stale binary), then run the built artifact against the scratch dir — CLI commands, endpoints via curl.
   3. Delete the scratch dir when the flow is done.
   4. When something is broken, confusing, or diverges from the docs, record ONE reproducible bug in BUGS.md: exact commands, expected vs actual. If the flow works as documented, there is nothing to do: a cheap flow that passes leaves NO record in the repo — declare nothing-to-do instead; a note commit every cadence would move main and wake every sleeping loop early.

Safety rails for anything you launch:
   - Every process gets a hard time limit and an explicit kill; no listening process may outlive your tick.
   - Servers bind ephemeral high ports, never the product's documented default port, on loopback only — check a flag that widens the bind (e.g. \`--all-interfaces\`) from its startup banner and stop it at once.
   - Track each background process by its own pid (in \`cd dir && server & echo $!\`, \`$!\` names the subshell, not the server — \`cd\` first).
   - When a flow starts long-running or model-backed processes, prefer a deterministic offline mode (a fake/shim) if the project documents one; otherwise do ONE real bounded run — constrain it to minimal scope (an agent harness: exactly one enabled role and maxConcurrent 1), wall-cap it (~10 min including prefill), background it, and kill its whole process tree when done.
   - Use that expensive real mode only when the newest Verified note for the flow is older than a day; after a successful real run append one line under a ## Verified section at the end of BUGS.md (e.g. "- 2026-08-28 run (real): init + one tick landed; status/logs confirm").

The FLOW line — required on every tick: your final reply carries one result-carrying line — \`FLOW: <name> — <passed|bug>\` — naming the flow you exercised and whether it passed or filed a bug (spell the name as the coverage block does, e.g. \`FLOW: run (real) — passed\`), placed just before your ending (the nothing-to-do line, or the SUMMARY block when you filed a bug). The verdict is required: a bare \`FLOW: <name>\` with no \`passed|bug\` suffix is not a result and is not recorded, so the rotation never advances. The harness records it for the next tick's coverage block. A passing flow's reply ends with exactly these two lines:
   FLOW: logs — passed
   ${NOTHING_TO_DO}`,
  },
  {
    id: "telemetry",
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
    id: "improve",
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
        those entries (${VALIDATION_GAP_TALLY});
      - compress an overflowing ## Done or ## Fixed section (rules below).
You edit only markdown — never source.

Reading the backlog files: you may see PLANS.md and BUGS.md whole, but do it cheaply — they run to
hundreds of KB. Map each file first with \`grep -n '^##' FILE\` (every section and entry heading
with its line number), read the Planned and Open sections in full, and read Done/Fixed entries by
line range only where your move needs their bodies. For the compression moves below, an entry's
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

/** Work-tier roles (need-based prioritization, PLANS.md "Prioritize loops by need"): they
 * ship work — feature and bugfix land code on main, plan feeds them — so their due ticks are
 * never deferred and slot allocation always orders them ahead of maintenance. */
const WORK_ROLES: ReadonlySet<string> = new Set(["feature", "bugfix", "plan"]);

/** Observer roles (plans/observer-roles.md 1/2): a role whose product is an observation, not
 * a commit, and for which `no_change` means "checked, all well" rather than "found nothing to
 * do". The idle ladder's premise — a loop that keeps finding nothing stops burning model time
 * — does not hold for these, so their no_change tick schedules at `minTickIntervalSeconds` and
 * leaves `backoffSeconds` at 0 (src/backoff.ts). The error ladder still applies in full, and they
 * are removed from DEFERRABLE_ROLES because their input (the running product for `qa`, the
 * event log for `telemetry`) is not a function of whether main moved. */
export const OBSERVER_ROLES: ReadonlySet<string> = new Set(["qa", "telemetry"]);

/** The built-in maintenance roles that author code on their own cadence — the six members
 * DEFERRABLE_ROLES and BASELINE_BLOCKED_ROLES share. Both sets list them because both charter
 * the same roles (defer-until-needed scheduling, red-main blocking), so the list lives once
 * here and a new maintenance role cannot be added to one set and missed in the other. */
const CODE_MAINTENANCE_ROLES: readonly string[] = [
  "organize",
  "coverage",
  "clean",
  "dry",
  "perf",
  "improve",
];

/** Maintenance-tier roles (need-based prioritization): exactly the eight built-ins whose due
 * ticks are deferrable while no feature/bugfix/director/human commit has landed on main since
 * their last tick and that tick did nothing. Unknown/custom roles are deliberately NOT in this
 * set — the harness cannot judge what an arbitrary custom role needs, so they never defer (they
 * still sort into tier 1 for fairOrder via roleTier). Observers are excluded: an unmoved tree
 * says nothing about whether the product or the event log has something new to report. */
export const DEFERRABLE_ROLES: ReadonlySet<string> = new Set([
  "readme",
  ...CODE_MAINTENANCE_ROLES,
  "steward",
]);

/** Does this role's recent yield scale its min-tick gap (yield-scaled clocks, PLANS.md)?
 * The search/maintenance roles — the deferrable eight, the observers, and bugfix on its
 * empty-backlog search duty (it is the one work role that defers like maintenance, so its
 * idle clock stretches like one too; the open-bugs state is deferTick's concern, not the
 * clock's: ten consecutive empty ticks are empty-yield evidence however many bugs are
 * recorded). Never the work roles whose ticks follow demand — feature, plan, director — a
 * role with a queued prompt or a fresh wake bypasses the gap entirely (isEligible), and the
 * multiplier is computed from counted results only (backoff.ts), so feature's errors
 * and quiet kills never stretch anything. */
export function yieldScaledRole(role: string): boolean {
  return DEFERRABLE_ROLES.has(role) || OBSERVER_ROLES.has(role) || role === BUGFIX_ROLE;
}

/** Scheduling tier for fairOrder's slot allocation (need-based prioritization): 0 for work
 * roles, 1 for everything else. The director is excluded by callers — it leads unconditionally,
 * ahead of both tiers. */
export function roleTier(role: string): number {
  return WORK_ROLES.has(role) ? 0 : 1;
}

/** The roles blocked from starting an authoring run while main's own build/test suite is known
 * red (the red-main baseline check, PLANS.md "Red-main baseline check"): every role whose diff
 * can carry non-exempt (code) changes — on a red main such a diff is rejected deterministically
 * by the gate's pre-check, so spending an authoring run on it is pure waste. Exempt: director
 * (human prompts outrank autonomous gates, like the budget gate), bugfix (the designated healer
 * — its tick runs the suite per "leave the project working" and can fix a red main through the
 * existing pre-merge gate; blocking it would leave only humans able to unblock the fleet), and
 * plan/readme/steward/qa/telemetry (markdown-only charter — their diffs are exempt from the build
 * pre-check via review.exemptPaths, so a red main does not block them). */
export const BASELINE_BLOCKED_ROLES: ReadonlySet<string> = new Set([
  "feature",
  ...CODE_MAINTENANCE_ROLES,
]);

/** Every role id, including the director (which is driven by user prompts, not a find prompt). */
export function allRoleIds(): string[] {
  return [...ROLES.map((r) => r.id), DIRECTOR_ROLE];
}

/** Look up a catalog role by id. Searches only the catalog, so unknown ids — and the
 * director (which has no find prompt and is not in ROLES) — yield undefined. */
export function roleById(id: string): Role | undefined {
  return ROLES.find((r) => r.id === id);
}

/** The harness's one unknown-role error text: `unknown role: <id> (valid ids: <ids>)`.
 * parseRoleFlag, the operator commands, and tick-prompt's defensive runner path share it so
 * the wording cannot drift between the CLI, the GUI, and a tick's internal error. */
export function unknownRoleMessage(role: string, validIds: readonly string[]): string {
  return `unknown role: ${role} (valid ids: ${validIds.join(", ")})`;
}

/** A user-defined loop as a Role (plans/user-defined-loops.md): its task IS the
 * role-specific find-something-to-do text, and the title is what identifies the loop inside
 * its own prompt (`You are the "<name>" loop (user-defined loop)`) and commit context. */
export function customRole(name: string, task: string): Role {
  return { id: name, title: "user-defined loop", find: task };
}
