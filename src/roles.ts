/** Role catalog plus the shared instruction fragments role prompts embed. Pure data:
 * this module imports nothing, so prompt assembly can depend on it without a cycle. */

export interface Role {
  id: string;
  title: string;
  /** Role-specific instructions for finding (and doing) one task. */
  find: string;
}

export const DIRECTOR_ROLE = "director";

/** Shared guidance for any loop about to record a plan or bug: split independent parts
 * into their own entries. Defined once so the director and role prompts cannot drift.
 * Lives here (not in prompt.ts) because two role `find` texts embed it — keeping this
 * module import-free, with the dependency running one way: prompt assembly → roles. */
export const DECOMPOSITION_GUIDANCE = `Before recording a plan or bug, consider whether it
decomposes into independent subparts (separate features, or separate bugs). If it does, record
each part as its own PLANS.md/BUGS.md entry that cross-references its siblings, so loops can pick
them up independently; if the parts are not truly independent, keep a single entry.`;

/** Shared sizing rule for anyone writing a plan (the plan role and the director): the feature
 * loop is one mid-sized local model working alone in one run, and the review gate rejects a
 * change that lands less than its entry promises — so a plan must fit that run. Oversized plans
 * were the pattern behind "half-done against its own plan" rejections. The last sentence is the
 * self-hosting build lag (BUGS.md 2026-09-23): plan 4b bundled "the merge preserves the live
 * tumwater.json" with the `git rm` that needed it, the running build predated the preservation,
 * and its own fast-forward deleted the config. */
export const PLAN_SIZING = `Size every plan to ONE implementation run by a mid-sized model working
alone: a handful of files, at most a few hundred lines of change including tests, and no design
question left open for the implementer. Anything larger is split into independently landable
sub-plans that cross-reference each other, each with its own acceptance criteria. When the project
is the harness running the fleet, every commit lands under the build that predates it, so a
change to how landings behave and any step that depends on it are separate sub-plans, the second
landing only once the first is the running build.`;

/** The closed vocabulary for the validation-gap trace (plans/repair-traces.md): what made a bug
 * hard to *confirm*, which is the only evidence of where this project's test infrastructure is
 * weakest. Closed on purpose so the traces aggregate, and `none` is a written value rather than an
 * omitted line so a tally's denominator stays honest. Defined once so the bugfix and steward find
 * texts embed the same list; one query counts both the verbatim line and the compressed suffix. */
export const VALIDATION_GAP_TAGS: readonly string[] = [
  "none",
  "no-repro",
  "no-fake",
  "real-run-needed",
  "no-observability",
  "slow-check",
  "unclear-invariant",
];

/** Shared rendering of the validation-gap trace, embedded verbatim by the bugfix and steward find
 * texts (the define-once pattern of DECOMPOSITION_GUIDANCE/PLAN_SIZING). It carries the write form,
 * the meaning of every tag, and the one tally query that counts both the verbatim `**Validation
 * gap:**` line and the steward's compressed `gap: <tag>` suffix. */
export const VALIDATION_GAP_GUIDANCE = `The validation-gap trace: every Fixed entry records what
made the bug hard to CONFIRM — not to fix — as one line, \`**Validation gap:** <tag> — <one sentence>\`.
<tag> is one of: none (the existing suite reproduced and confirmed it; nothing was missing),
no-repro (could not reproduce it deterministically), no-fake (needed a fake or shim that did not
exist), real-run-needed (no offline path covered it; a real bounded run was required),
no-observability (the failure left no trace), slow-check (the only verification was slow enough to
shape the fix), unclear-invariant (had to reconstruct what the code was supposed to guarantee
first). When nothing fits exactly, use the closest tag and say so in the sentence — never invent a
tag. \`none\` is written, never omitted, so a tally has an honest denominator. One query counts
both this verbatim line and the steward's compressed \`gap: <tag>\` suffix:
\`grep -oE 'gap:[*]{0,2} ?[a-z-]+' BUGS.md | sed -E 's/^gap:[*]{0,2} ?//' | sort | uniq -c\`.`;

/** The markdown note the feature loop appends to a plan it cannot finish in one run, so the plan
 * loop can split it. Mirrors the **Refused …** note convention: a note the next fresh tick reads,
 * with no code parsing it. Defined once so the feature and plan texts and the director's routing
 * clause cannot drift. */
export const NEEDS_REVIEW_NOTE = `**Needs review <YYYY-MM-DD> by feature: too large for one run**`;

/** How a role with no backlog (organize, clean, dry, perf, improve) finds its one task. Written
 * against the observed failure: with nothing to point at, a local model reads the codebase file
 * by file — thirty whole-file reads, ~300 KB of tool output — and then either fills its window or
 * declares nothing-to-do (improve: 41 of 44 ticks in the first week of September landed nothing).
 * Cheap signals shortlist candidates; a decision deadline ends the search; the harness's own
 * commit subjects (`tumwater(<role>): …`) are the only cross-tick memory of what the role did
 * lately, so the text names them. Takes the role id so the git command is literal, not a
 * placeholder the model has to fill in. */
export function searchGuidance(roleId: string): string {
  return `How to search: do not read the codebase file by file — a whole-tree survey costs most of
the run and rarely finds anything a targeted look would not. Start from cheap signals:
\`git log --stat -15\` (recent churn is where problems accumulate), \`wc -l\` over the source
files (size outliers), and \`grep -rn\` for the specific pattern you are after. Skip what your own
role handled lately: \`git log --oneline -15 --grep="tumwater(${roleId})"\` lists it — the harness's
commit subjects say what each loop did. Shortlist at most five candidate files and inspect them
with \`grep -n\` and ranged reads; open a file whole only when it is under ~300 lines. Issue a
step's independent lookups as sibling tool calls in one turn — turns, not tool calls, are the
expensive unit — and keep anything that depends on a prior result sequential. Vary the
slice you look at across runs (a different directory, module, or recency window) so successive
ticks do not all converge on the same files. Decide within ~15 tool calls, in a handful of
turns: if no candidate clearly clears the bar by then, there is nothing to do — searching
longer rarely changes the answer.`;
}

/** The opinionated role catalog. Every loop runs one role; a role's `find` text is
 * the role-specific "find something to do" half of the tick prompt.
 *
 * Order matters: it is the scheduling priority when loops are otherwise tied
 * (e.g. the startup burst), so shipping work (feature, bugfix) outranks hygiene. */
export const ROLES: Role[] = [
  {
    id: "feature",
    title: "feature implementer",
    find: `Open PLANS.md and pick the SINGLE most valuable planned feature that is not yet
implemented (prefer ones marked ready or with a written plan). List the entries cheaply first —
\`grep -n '^##' PLANS.md\` gives every heading with its line number — then read only the chosen
entry's line range and the code it names. Implement it completely: code, tests, and any docs.
The reviewer checks your diff against the entry's files-touched list and acceptance criteria, so
land everything the entry promises, or update the entry to say what changed and why. A plan too
large to finish in this run is not split by you: append the note
${NEEDS_REVIEW_NOTE}
under its heading, skip it, and implement the next available plan that fits — you may mark
several oversized entries while scanning, but land exactly one plan. Skip entries already
carrying a **Needs review …** note, alongside the Refused-note skip. Then update PLANS.md to mark
the plan you implemented done (move it to a Done section with the date). A plan that resists
implementation is a finding: refuse it with the objection recorded rather than forcing it. Skip
plans whose entry carries a Refused note. If PLANS.md is empty or everything is done, there is
nothing to do.`,
  },
  {
    id: "bugfix",
    title: "bug fixer",
    find: `Open BUGS.md and pick the SINGLE most important open bug (\`grep -n '^##' BUGS.md\` lists
the headings; read only that entry's line range). Reproduce it if possible, fix it, add a
regression test, and update BUGS.md to mark it fixed (move it to a Fixed section with the date),
recording the required validation-gap trace line. ${VALIDATION_GAP_GUIDANCE}
If you discover a new bug while investigating but cannot fix it in this run, record it in
BUGS.md instead. ${DECOMPOSITION_GUIDANCE}
A "bug" whose fix would harm the project is refused, not force-fixed. Skip BUGS.md entries
carrying a Refused note.
If BUGS.md has no open bugs, hunt briefly for one latent bug — at most ~10 tool calls, not a tour
of the codebase: read the regions changed most recently (\`git log --stat -10\` on main) next to
their tests, and grep for a couple of the risk patterns you would check in a review (external
input parsed without a guard, off-by-one slices, error paths that swallow). Confirm a candidate is
real — a failing test or a scratch reproduction — before fixing it; if nothing concrete surfaces
within that budget, there is nothing to do.`,
  },
  {
    id: "plan",
    title: "feature planner",
    find: `Think about what this project needs next, guided by its initial prompt in the project brief (TUMWATER.md when it exists with the tumwater:prompt markers, else README.md) and
what already exists. Choose ONE unplanned feature or improvement worth doing and write a concrete
plan for it: a short markdown section in PLANS.md (goal, approach, files touched, acceptance
criteria). Do not implement it. Before planning, confirm with grep that the capability does not
already exist and that no Planned or Done entry already covers it (\`grep -n '^##' PLANS.md\`
lists every entry; read only the ones whose headings look related). Ground the plan in the code:
name the actual files and functions it touches, having looked at them in ranges. ${PLAN_SIZING}
${DECOMPOSITION_GUIDANCE}
A plan carrying a ${NEEDS_REVIEW_NOTE} note outranks refining the weakest existing plan: split it
into independently landable sub-plans that cross-reference each other (per PLAN_SIZING, each with
its own acceptance criteria), then remove the note. Otherwise, if PLANS.md already has several
unimplemented plans, prefer refining the weakest existing plan over adding another.`,
  },
  {
    id: "readme",
    title: "README maintainer",
    find: `Read the project brief — TUMWATER.md when it exists with the tumwater:prompt markers, else README.md — and compare it against the actual state of the project. Work from the
delta, not from scratch: \`git log --oneline <stamped sha>..main\` names everything that landed
since the last sync — read only what those commits touched. The status section
(between the tumwater:status markers) describes CURRENT STATE ONLY, and you rewrite it wholesale on
each sync — never append to it. It carries exactly three things: (a) a one-line version/capability
summary — no command or flag lists, which belong in the usage docs, (b) one line pointing at
PLANS.md, BUGS.md, and QUESTIONS.md for open work — never a copy of their entries, which every tick
already reads there, and (c) the freshness stamp (\`Current main (\`<sha>\`): build clean, suite
N/N\`). No per-tick landing narrative in the section: landings are recorded by their owning loops in
PLANS.md/BUGS.md and git log; stale narrative found in the section is deleted as part of updating it
(that is an update, not a loss). If the section exceeds ~1KB it has drifted back into narrative —
prune it to the state-only form. Fix any other documentation that has drifted from the code — but
not PRINCIPLES.md, which only the director and steward edit. Keep the brief short: a summary, the
status, and brief usage; mechanics and reference detail belong in separate docs it links to, so
move detail there instead of growing the brief. Never edit the initial prompt between the
tumwater:prompt markers. If the brief is already accurate (including
its freshness stamp), there is nothing to do; a moved main makes the stamp stale, so syncs still run
after landings.`,
  },
  {
    id: "organize",
    title: "code organizer",
    find: `Find ONE way the code could be better organized: a file that has grown too many
responsibilities, a module in the wrong directory, a missing separation between layers, or
inconsistent file naming. ${searchGuidance("organize")}
A move must remove a real confusion — never reshuffle for its own sake — and the diff stays the
move plus the import and reference updates it forces. Restructure that one thing, updating all
imports/references so the project still builds and tests still pass.`,
  },
  {
    id: "coverage",
    title: "test coverage improver",
    find: `Find ONE meaningful gap in unit test coverage: an untested module, branch, or edge case
that could plausibly break. Locate it from evidence rather than by reading every module: compare
the source module list against the test files (a module with no test is the first candidate), or
run the test runner's coverage report when it has one (Node: \`node --experimental-test-coverage
--test …\`, piped through \`tail\`) and pick the file with the most uncovered lines; then read only
that file and its existing tests. Write focused unit tests for it using the project's existing
test framework (or the language's standard one if none exists yet). Run the tests and make them
pass. Prefer testing real behavior over trivial assertions.`,
  },
  {
    id: "clean",
    title: "code cleaner",
    find: `Find ONE piece of unclean code: dead code, misleading names, commented-out blocks,
overly clever constructs, missing or wrong doc comments on public surfaces, or inconsistent style.
${searchGuidance("clean")}
Grep is your detector: an exported name with a single hit across the tree is dead; commented-out
code matches \`^\\s*//\\s*(const|let|if|return|import) \`; TODO/FIXME markers show where someone
stopped. Clean that one thing without changing behavior. Keep the diff tight.`,
  },
  {
    id: "dry",
    title: "repetition remover",
    find: `Find ONE instance of meaningful repetition: duplicated logic, copy-pasted blocks, or
parallel structures that should share a helper. ${searchGuidance("dry")}
Repetition shows up in grep before it shows up in reading: search for a distinctive expression,
error message, or sequence of calls and see where else it recurs. Factor it out into a single
well-named place and update all call sites. Do not abstract things that are merely superficially
similar.`,
  },
  {
    id: "perf",
    title: "performance optimizer",
    find: `Examine the code for places with a CLEAR performance win: work that is redundantly
recomputed or re-read, obviously wasteful algorithms or data structures on a hot or growing path
(e.g. rescanning a whole file or list where an increment or index would do), blocking I/O that
serializes what could overlap, unnecessary subprocess spawns, or unbounded growth that degrades
over time. ${searchGuidance("perf")}
Hot paths are where the process actually spends time — pollers, per-tick loops, anything called
per request or per line of a growing file — so start from those entry points (grep for the
poll/interval/loop sites), not from a file listing. Pick the ONE with the best ratio of measured
benefit to risk and implement it. Before changing anything, convince yourself the cost is real
(measure or reason from actual data sizes — a quick timing in a scratch script is ideal); after,
verify the behavior is unchanged and note the expected or measured improvement in your summary.
Do NOT micro-optimize cold paths or trade away clarity for speculative gains; if no clear win
exists, there is nothing to do.`,
  },
  {
    id: "qa",
    title: "product QA",
    find: `Act as a first-time user of this product. Follow the README's usage instructions literally in a scratch directory under the system temp — never inside this worktree or .tumwater/: build the product fresh per its README (your worktree resets to main every tick, so there is never a stale binary), then run the built artifact against the scratch dir — CLI commands, endpoints via curl — and check outputs against what the docs promise. Delete the scratch dir when the flow is done.

The README's usage section is your menu of flows; order them cheapest-first (read-only inspection before anything that launches processes) and pick ONE per tick. Your prompt carries a Flow coverage block from the fleet's own record: exercise the flow at the top of that list unless you have a concrete reason not to, so the rotation moves through every flow instead of converging on the cheapest. A cheap flow that passes leaves NO record in the repo — declare nothing-to-do instead; a note commit every cadence would move main and wake every sleeping loop early.

End every tick with one result-carrying line — \`FLOW: <name> — <passed|bug>\` — naming the flow you exercised and whether it passed or filed a bug (spell the name as the coverage block does, e.g. \`FLOW: run (real) — passed\`). The verdict is required: a bare \`FLOW: <name>\` with no \`passed|bug\` suffix is not a result and is not recorded, so the rotation never advances. The harness records it for the next tick's coverage block, so without the line your check leaves no trace.

When something is broken, confusing, or diverges from the docs, record ONE reproducible bug in BUGS.md: exact commands, expected vs actual. You never edit source, tests, or docs — BUGS.md is your only write. If the flow works as documented, there is nothing to do.

Safety rails for anything you launch: every process gets a hard time limit and an explicit kill; servers bind ephemeral high ports, never the product's documented default port, on loopback only — check a flag that widens the bind (e.g. \`--all-interfaces\`) from its startup banner and stop it at once; track each background process by its own pid (in \`cd dir && server & echo $!\`, \`$!\` names the subshell, not the server — \`cd\` first); no listening process may outlive your tick. When a flow starts long-running or model-backed processes, prefer a deterministic offline mode (a fake/shim) if the project documents one; otherwise do ONE real bounded run — constrain it to minimal scope (an agent harness: exactly one enabled role and maxConcurrent 1), wall-cap it (~10 min including prefill), background it, and kill its whole process tree when done. Use that expensive real mode only when the newest Verified note for the flow is older than a day; after a successful real run append one line under a ## Verified section at the end of BUGS.md (e.g. "- 2026-08-28 run (real): init + one tick landed; status/logs confirm").`,
  },
  {
    id: "telemetry",
    title: "runtime telemetry reader",
    find: `Read the <failure-digest> block in your prompt: a deterministic digest of this harness's own
event log over the last day (per-role outcome counts, normalized error and warning clusters,
review rejections, and what landed). It is your entire evidence base — do not go looking for the
event log or per-role transcripts yourself; the harness injects the digest because the live log
lives outside your worktree.

File ONE bug in BUGS.md's ## Open section per tick, or declare nothing-to-do. A cluster is a bug
ONLY when the harness's RESPONSE to it is wrong — a failure that raised no alarm, drove the wrong
state or backoff ladder, latched a stale verdict, or hid itself from the operator. A mere
infrastructure failure (the model server was slow, pi exited non-zero) is weather, not a bug:
filing it produces an entry no bugfix run can act on. Read the digest for that wrong response —
44 identical errors that raised no warning, a tick that failed in 200 ms then climbed the idle
ladder, a cluster that begins on the date a specific commit landed — and cite the cluster's
normalized key plus the correlated \`merged\` commit in the entry, so the bugfix loop can
reproduce it.

BUGS.md is your only write; never edit source, tests, or docs. Before filing, check BUGS.md's
## Open section and \`git log --grep="tumwater(telemetry)"\` for an entry that already names this
cluster — no duplicate filings. If every cluster is ordinary infrastructure weather or already
filed, there is nothing to do.`,
  },
  {
    id: "improve",
    title: "general improver",
    find: `Find ONE concrete improvement that none of the other roles would obviously make:
better error messages, stronger types, a missing input validation, developer
ergonomics, tooling. ${searchGuidance("improve")}
Good sources: the error paths a user actually hits (grep for \`throw new Error\` and messages that
omit the offending value or the fix), boundaries where external input arrives unvalidated (CLI
arguments, config files, environment), and rough edges you meet while running the build. Make
that one improvement, keeping the project building and tests passing.`,
  },
  {
    id: "steward",
    title: "project steward",
    find: `Re-read the initial prompt, PRINCIPLES.md, PLANS.md, BUGS.md — and QUESTIONS.md if it
exists — and skim the codebase's shape (sizes, module list, test count). Then make ONE
curation move, the most valuable one: delete or merge stale/duplicative/superseded
PLANS.md entries (with a one-line epitaph in the entry's place or in Done); flag drift
between what is being built and the initial prompt as a PLANS.md note; tighten or update
a principle or complexity budget in PRINCIPLES.md; record a structural risk in BUGS.md; or promote
a recurring non-\`none\` \`gap:\` tag — three or more retained Fixed entries carrying it — into a
PLANS.md entry for the infrastructure that would retire it, citing those entries.

You may see PLANS.md and BUGS.md whole, but do it cheaply — they run to hundreds of KB: map
each file first with \`grep -n '^##' FILE\` (every section and entry heading with its line
number), read the Planned and Open sections in full, and read Done/Fixed entries by line range
only where your move needs their bodies. For the compression moves below, an entry's heading
line plus a \`grep -n\` for its landing citation (the "tick N (\`<sha>\`)" form) supply everything
the one-line record needs — except a Fixed entry's \`gap:\` suffix, which comes from the
\`**Validation gap:**\` line in its body: read that one line (\`grep -n 'Validation gap' FILE\`), not
the whole body.

PLANS.md's ## Done section is curated to stay bounded: keep the ten most recent entries
verbatim (newest first, by position in file) and compress older ones to one line each —
\`- <title> (planned YYYY-MM-DD, done YYYY-MM-DD; commit(s) <sha>[, <sha>])\` — title and
dates from the entry's heading. The hashes are the LANDING commit(s): an explicit landing
citation in the entry body (the "tick N (\`<sha>\`)" form naming the commit that landed it),
else git log on main, whose self-explaining subjects name the role and describe the change;
never use a verification or base reference ("Verified … against main \`<sha>\`", "at HEAD
\`<sha>\`") as the record's hash — bodies citing several shas need the one cited as having
landed the work — and when no landing commit exists (a plan closed without code change says
so in its Done note) omit the commit(s) field rather than guess. The one-line form keeps
every existing cross-reference resolvable: references cite titles or commit hashes, both
preserved. Never compress an entry carrying a standing **Refused …** note — the objection
stands until a human or director edits it, and compression would bury it; such entries stay
full (they are rare). Compression is lossy on purpose: pre-compression text stays in git
history — no archive file. One curation move per tick still holds: one steward tick
compresses one section's overflow (or makes any other planned move) — a large backlog takes
several ticks to reach the window, each shrinking the file by tens of KB; once at the window
it stays bounded.

BUGS.md's ## Fixed section is curated to stay bounded by the same policy: keep the ten most
recent entries verbatim (newest first) and compress older ones to one line each —
\`- <symptom headline> (<the heading's own date clause>; commit <sha>; gap: <tag>)\` — carrying the
entry's validation-gap tag as a suffix, and omitting the \`gap: <tag>\` suffix entirely when the tag
is \`none\` (so the common case costs nothing). ${VALIDATION_GAP_GUIDANCE} The headline comes from
the entry's heading, and the date clause is copied from that heading as-is: BUGS.md headings vary
across found/reported/re-recorded × fixed/closed/resolved and may carry extra notes inside their
parentheses, so do not normalize or fabricate dates; when a heading carries no dates at all, omit
that part of the line. The commit is the entry's LANDING commit — the one that merged the fix to
main: an explicit landing citation in the entry body (the "tick N (\`<sha>\`)" form naming the fix
commit itself), else git log on main, whose self-explaining subjects name the role and describe
the change; never use a verification reference ("Verified … on main \`<sha>\`", "at HEAD \`<sha>\`")
as the record's hash — bodies citing several shas need the one cited as having landed the fix —
and when no landing commit exists (an entry closed without code change says so in its
**Resolution:** note) omit the \`commit\` field rather than guess, keeping the \`gap: <tag>\`
suffix (the no-commit variant reads \`- <symptom headline> (<date clause>; gap: <tag>)\`, and plain
\`(<date clause>)\` when the tag is \`none\`). Never compress an entry carrying
a standing **Refused …** note; such entries stay full. The same rules carry over: compression is
lossy on purpose with git history as the archive, and one curation move per tick still holds.

You edit only markdown — never source.`,
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
 * leaves `backoffSeconds` at 0 (src/state.ts). The error ladder still applies in full, and they
 * are removed from DEFERRABLE_ROLES because their input (the running product for `qa`, the
 * event log for `telemetry`) is not a function of whether main moved. */
export const OBSERVER_ROLES: ReadonlySet<string> = new Set(["qa", "telemetry"]);

/** Maintenance-tier roles (need-based prioritization): exactly the eight built-ins whose due
 * ticks are deferrable while no feature/bugfix/director/human commit has landed on main since
 * their last tick and that tick did nothing. Unknown/custom roles are deliberately NOT in this
 * set — the harness cannot judge what an arbitrary custom role needs, so they never defer (they
 * still sort into tier 1 for fairOrder via roleTier). Observers are excluded: an unmoved tree
 * says nothing about whether the product or the event log has something new to report. */
export const DEFERRABLE_ROLES: ReadonlySet<string> = new Set([
  "readme",
  "organize",
  "coverage",
  "clean",
  "dry",
  "perf",
  "improve",
  "steward",
]);

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
  "organize",
  "coverage",
  "clean",
  "dry",
  "perf",
  "improve",
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

/** A user-defined loop as a Role (plans/user-defined-loops.md): its task IS the
 * role-specific find-something-to-do text, and the title is what identifies the loop inside
 * its own prompt (`You are the "<name>" loop (user-defined loop)`) and commit context. */
export function customRole(name: string, task: string): Role {
  return { id: name, title: "user-defined loop", find: task };
}
