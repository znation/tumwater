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
implemented (prefer ones marked ready or with a written plan). Implement it completely: code,
tests, and any docs. Then update PLANS.md to mark it done (move it to a Done section with the
date). A plan that resists implementation is a finding: refuse it with the objection recorded
rather than forcing it. Skip plans whose entry carries a Refused note. If PLANS.md is empty or
everything is done, there is nothing to do.`,
  },
  {
    id: "bugfix",
    title: "bug fixer",
    find: `Open BUGS.md and pick the SINGLE most important open bug. Reproduce it if possible,
fix it, add a regression test, and update BUGS.md to mark it fixed (move it to a Fixed section
with the date). If you discover a new bug while investigating but cannot fix it in this run,
record it in BUGS.md instead. ${DECOMPOSITION_GUIDANCE}
A "bug" whose fix would harm the project is refused, not force-fixed. Skip BUGS.md entries
carrying a Refused note.
If BUGS.md has no open bugs, look briefly for one obvious latent
bug in the code; if you find none, there is nothing to do.`,
  },
  {
    id: "plan",
    title: "feature planner",
    find: `Think about what this project needs next, guided by its initial prompt in README.md and
what already exists. Choose ONE unplanned feature or improvement worth doing and write a concrete
plan for it: a short markdown section in PLANS.md (goal, approach, files touched, acceptance
criteria). Do not implement it. ${DECOMPOSITION_GUIDANCE}
If PLANS.md already has several unimplemented plans, prefer
refining the weakest existing plan over adding another.`,
  },
  {
    id: "readme",
    title: "README maintainer",
    find: `Read README.md and compare it against the actual state of the project. The status section
(between the tumwater:status markers) describes CURRENT STATE ONLY, and you rewrite it wholesale on
each sync — never append to it. It carries exactly three things: (a) a one-line version/capability
summary (which commands exist, which roles are enabled), (b) open items — planned features not yet
done, open bugs, open questions — one line each or "none", and (c) the freshness stamp (\`Current
main (\`<sha>\`): build clean, suite N/N\`). No per-tick landing narrative in the section: landings are
recorded by their owning loops in PLANS.md/BUGS.md and git log; stale narrative found in the section
is deleted as part of updating it (that is an update, not a loss). If the section exceeds ~8KB it has
drifted back into narrative — prune it to the state-only form. Fix any other documentation that has
drifted from the code — but not PRINCIPLES.md, which only the director and steward edit. Never edit
the initial prompt between the tumwater:prompt markers. If the README is already accurate (including
its freshness stamp), there is nothing to do; a moved main makes the stamp stale, so syncs still run
after landings.`,
  },
  {
    id: "organize",
    title: "code organizer",
    find: `Find ONE way the code could be better organized: a file that has grown too many
responsibilities, a module in the wrong directory, a missing separation between layers, or
inconsistent file naming. Restructure that one thing, updating all imports/references so the
project still builds and tests still pass.`,
  },
  {
    id: "coverage",
    title: "test coverage improver",
    find: `Find ONE meaningful gap in unit test coverage: an untested module, branch, or edge case
that could plausibly break. Write focused unit tests for it using the project's existing test
framework (or the language's standard one if none exists yet). Run the tests and make them pass.
Prefer testing real behavior over trivial assertions.`,
  },
  {
    id: "clean",
    title: "code cleaner",
    find: `Find ONE piece of unclean code: dead code, misleading names, commented-out blocks,
overly clever constructs, missing or wrong doc comments on public surfaces, or inconsistent style.
Clean that one thing without changing behavior. Keep the diff tight.`,
  },
  {
    id: "dry",
    title: "repetition remover",
    find: `Find ONE instance of meaningful repetition: duplicated logic, copy-pasted blocks, or
parallel structures that should share a helper. Factor it out into a single well-named place and
update all call sites. Do not abstract things that are merely superficially similar.`,
  },
  {
    id: "perf",
    title: "performance optimizer",
    find: `Examine the code for places with a CLEAR performance win: work that is redundantly
recomputed or re-read, obviously wasteful algorithms or data structures on a hot or growing path
(e.g. rescanning a whole file or list where an increment or index would do), blocking I/O that
serializes what could overlap, unnecessary subprocess spawns, or unbounded growth that degrades
over time. Pick the ONE with the best ratio of measured benefit to risk and implement it.
Before changing anything, convince yourself the cost is real (measure or reason from actual data
sizes — a quick timing in a scratch script is ideal); after, verify the behavior is unchanged and
note the expected or measured improvement in your summary. Do NOT micro-optimize cold paths or
trade away clarity for speculative gains; if no clear win exists, there is nothing to do.`,
  },
  {
    id: "qa",
    title: "product QA",
    find: `Act as a first-time user of this product. Follow the README's usage instructions literally in a scratch directory under the system temp — never inside this worktree or .tumwater/: build the product fresh per its README (your worktree resets to main every tick, so there is never a stale binary), then run the built artifact against the scratch dir — CLI commands, endpoints via curl — and check outputs against what the docs promise. Delete the scratch dir when the flow is done.

The README's usage section is your menu of flows; order them cheapest-first (read-only inspection before anything that launches processes) and pick ONE per tick. Vary across ticks: prefer a flow not recently exercised, as far as BUGS.md filings and Verified notes show. A cheap flow that passes leaves NO record — declare nothing-to-do instead; a note commit every cadence would move main and wake every sleeping loop early.

When something is broken, confusing, or diverges from the docs, record ONE reproducible bug in BUGS.md: exact commands, expected vs actual. You never edit source, tests, or docs — BUGS.md is your only write. If the flow works as documented, there is nothing to do.

Safety rails for anything you launch: every process gets a hard time limit and an explicit kill; servers bind ephemeral high ports, never the product's documented default port; no listening process may outlive your tick. When a flow starts long-running or model-backed processes, prefer a deterministic offline mode (a fake/shim) if the project documents one; otherwise do ONE real bounded run — constrain it to minimal scope (an agent harness: exactly one enabled role and maxConcurrent 1), wall-cap it (~10 min including prefill), background it, and kill its whole process tree when done. Use that expensive real mode only when the newest Verified note for the flow is older than a day; after a successful real run append one line under a ## Verified section at the end of BUGS.md (e.g. "- 2026-08-28 run (real): init + one tick landed; status/logs confirm").`,
  },
  {
    id: "improve",
    title: "general improver",
    find: `Find ONE concrete improvement that none of the other roles would obviously make:
better error messages, stronger types, a missing input validation, developer
ergonomics, tooling. Make that one improvement, keeping the project building and tests passing.`,
  },
  {
    id: "steward",
    title: "project steward",
    find: `Re-read the initial prompt, PRINCIPLES.md, PLANS.md, BUGS.md — and QUESTIONS.md if it
exists — and skim the codebase's shape (sizes, module list, test count). Then make ONE
curation move, the most valuable one: delete or merge stale/duplicative/superseded
PLANS.md entries (with a one-line epitaph in the entry's place or in Done); flag drift
between what is being built and the initial prompt as a PLANS.md note; tighten or update
a principle or complexity budget in PRINCIPLES.md; or record a structural risk in BUGS.md.
You edit only markdown — never source.`,
  },
];

/** Every role id, including the director (which is driven by user prompts, not a find prompt). */
export function allRoleIds(): string[] {
  return [...ROLES.map((r) => r.id), DIRECTOR_ROLE];
}

/** Look up a catalog role by id. Searches only the catalog, so unknown ids — and the
 * director (which has no find prompt and is not in ROLES) — yield undefined. */
export function roleById(id: string): Role | undefined {
  return ROLES.find((r) => r.id === id);
}
