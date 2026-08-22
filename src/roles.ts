import { DECOMPOSITION_GUIDANCE } from "./prompt.js";

export interface Role {
  id: string;
  title: string;
  /** Role-specific instructions for finding (and doing) one task. */
  find: string;
}

export const DIRECTOR_ROLE = "director";

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
date). If PLANS.md is empty or everything is done, there is nothing to do.`,
  },
  {
    id: "bugfix",
    title: "bug fixer",
    find: `Open BUGS.md and pick the SINGLE most important open bug. Reproduce it if possible,
fix it, add a regression test, and update BUGS.md to mark it fixed (move it to a Fixed section
with the date). If you discover a new bug while investigating but cannot fix it in this run,
record it in BUGS.md instead. ${DECOMPOSITION_GUIDANCE}
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
    find: `Read README.md and compare it against the actual state of the project. Update the
status section (between the tumwater:status markers) to reflect reality: what works, what is in
progress, how to build/run/test. Fix any documentation that has drifted from the code. Never edit
the initial prompt between the tumwater:prompt markers. If the README is already accurate,
there is nothing to do.`,
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
    id: "improve",
    title: "general improver",
    find: `Find ONE concrete improvement that none of the other roles would obviously make:
better error messages, stronger types, a missing input validation, developer
ergonomics, tooling. Make that one improvement, keeping the project building and tests passing.`,
  },
];

/** Every role id, including the director (which is driven by user prompts, not a find prompt). */
export function allRoleIds(): string[] {
  return [...ROLES.map((r) => r.id), DIRECTOR_ROLE];
}

export function roleById(id: string): Role | undefined {
  return ROLES.find((r) => r.id === id);
}
