/** `tumwater guide` — the working rules an interactive agent (claude, codex, omp) follows when it
 * steers this project's backlog for the person running tumwater. The static body ships with the
 * install, so it always matches the commands that installed CLI has; `guideText` appends a
 * `This project` section only when it is handed the repo's own facts, which printGuide collects.
 *
 * These rules deliberately do NOT live in CLAUDE.md or AGENTS.md: the claude, codex and opencode
 * backends load those files into every role run (src/agent/claude/claude-args.ts,
 * src/agent/codex/codex-args.ts, src/agent/opencode/opencode-config.ts), and this text speaks to
 * the agent steering the backlog, not to a role on the team. The body keeps to the plain-terms
 * vocabulary (plans/terminology.md), so the one backlog-syntax phrase it must quote verbatim sits
 * on its own exempted line below, interpolated like the vocabulary guard instructs.
 *
 * The body names commands in the `tumwater <command>` form test/operator-guide.test.ts extracts
 * and checks against the help listing, so a renamed command cannot leave this text stale. */
import { detectBuildCheck, type BuildCheck } from "../build/build-check-detect.js";
import { describeCheck } from "../build/build-check-report.js";
import { loadConfigSafe } from "../config/config.js";
import { currentBranch, targetBranch } from "../git/git.js";
import { repoNotReady } from "../gates/startup-gates.js";
import { orchestratorAlive } from "../team/team-orchestrator-info.js";
import { VALIDATION_GAP_TAGS } from "../roles/role-guidance.js";
import { say } from "../terminal.js";

/** The heading clause a series part waits on, quoted verbatim because the claim allocator reads
 * it from a heading's last parenthetical; on its own line so the vocabulary guard sees the quoted
 * word as the backlog syntax it is. */
const REQUIRES_CLAUSE = "requires … landed"; // vocabulary-ok: the PLANS.md heading syntax the guide quotes

/** The validation-gap tags a Fixed record names — the same closed vocabulary role-guidance.ts
 * defines once and the doctor's `validation gaps` row checks a record's tag against. */
const GAP_TAGS = VALIDATION_GAP_TAGS;

/** What one repo adds to the guide (not exported: projectFacts is the only producer, and the
 * exported surface is guideText's optional argument plus cmdGuide): its base branch, the check
 * its merges gate on, and whether a team is running in it right now. */
interface GuideProject {
  baseBranch: string;
  check: BuildCheck | null;
  teamRunning: boolean;
}

/** The static body: seven sections, markdown, wrapped at 100 columns. */
const GUIDE_BODY = `# Steering tumwater from your own agent

## What you are doing

tumwater runs a development team inside a git repo. The team reads two files, PLANS.md (planned
work) and BUGS.md (found bugs), and turns their \`### \` entries into small reviewed changes that
merge to main, one entry per run. You do not write that code. You steer: you investigate, write
sharp entries, reorder them, and retire the ones that no longer matter. Do this only where the
person running tumwater asks you to — they own the backlog's content.

## Orient first

Read the state before you write anything:

- \`tumwater status\` — what the team is doing now, and what it is waiting on.
- \`tumwater history --result problems\` — the runs that failed and what they hit.
- \`tumwater plan --list\` and \`tumwater bug --list\` — the open entries, numbered the way every
  later command numbers them, each marked \`[working on it: …]\`, \`[blocked: …]\`, or held.
- \`tumwater questions\` — what the roles asked that nobody has answered.
- \`tumwater doctor\` — whether the repo is ready and its safety gates are running.

## Writing a plan

One entry is one run's worth of work. Its heading is a \`### \` line whose last parenthetical is
the filing stamp; its body carries, in this order:

- **Goal.** What is true afterwards that is not true now.
- **Approach.** The files and functions to change, named, and how.
- **Files touched.** Every path the change should touch — the reviewer reads the diff against it.
- **Acceptance criteria.** Each one checkable by running something.
- **Tests.** Where each expected value comes from — never what the code happened to print.

Work too big for one run is a series: number its parts \`### <Series>, part i/n: <title>\` and put
the clause ${REQUIRES_CLAUSE} naming the part it waits on in that heading's LAST parenthetical —
the only place the scheduler reads a dependency. Split only truly independent parts.

## Writing a bug

The heading is the symptom, one \`### \` line; the body carries **Reproduce.** (the exact command
and what it does instead of what you expect) and **Suspected cause.** (named to the file and line,
or an explicit note that you have not found it). A record that moves to \`## Fixed\` carries a
**Validation gap:** line naming what made the bug hard to confirm, tagged:
${GAP_TAGS.slice(0, 4).map((t) => `\`${t}\``).join(", ")},
${GAP_TAGS.slice(4).map((t) => `\`${t}\``).join(", ")}.

## Rules

- Never edit or move an entry \`--list\` marks \`[working on it: …]\` — a role holds it. Put a
  competing plan above it with a ${REQUIRES_CLAUSE} clause instead.
- The newest instruction wins. Amend an unclaimed entry in place with a dated
  \`amended <date> by the user\` note rather than filing a duplicate of it.
- Never edit PLANS-DONE.md, BUGS-FIXED.md, or anything under \`.tumwater/\`.
- tumwater.json edits apply live: the running team picks them up within seconds.

## Getting edits onto main

For one entry at a time, the write commands commit on main under the team's lock:

- \`tumwater plan "<title>" [body…]\` and \`tumwater bug "<symptom>"\`, each also reading
  its text with \`--file <path>\`;
- \`tumwater plan --edit <n> --file <path>\` (\`--edit <n>\` alone opens \`$EDITOR\`), \`--top <n>\`,
  \`--cancel <n>\`, \`--retire <n>\`, \`--release <n>\` — \`tumwater bug\` takes the same verbs;
- \`tumwater questions answer <n>\` records an answered question and wakes the role that asked.

Each of those appends \`(reported by the user <date>)\` as its heading's last parenthetical, so a
series part that needs ${REQUIRES_CLAUSE} there cannot be filed that way. For those parts, and for
any rewrite of several entries at once: edit the files in your own branch or worktree, commit
there, then run \`tumwater land\` — it puts your commit(s) on main under the merge the team's
merges take, replaying onto a moved main and refusing (exit 1) a code conflict. Never commit,
merge, or pull on the base branch in the primary checkout yourself.

## Other steering

- \`tumwater prompt "<text>"\` sends a message to the director's inbox: \`--role <id>\` aims it at one
  role's next run, \`--file <path>\` reads the text from a file, \`--at <duration>\` sends it later;
  \`tumwater prompt --list\` reads the inbox back.
- \`tumwater revert <sha>\` undoes one merged change on main, committing its inverse;
  \`tumwater revert <role> --last\` reverts a run's merge.
- \`tumwater pause\` and \`tumwater resume\` stop and restart roles starting new runs; \`--role <id>\`
  scopes either to named roles and \`--for <duration>\` resumes by itself.
- \`tumwater report --failures\` ranks where the team is losing time, for judging what to fix first.`;

/** The section a ready repo appends: the facts an agent would otherwise have to guess — which
 * branch a merge lands on, what the project calls its verification command (describeCheck's
 * wording, so an npm repo and a `cargo test` repo each read their own), and whether a team is
 * live. */
function projectSection(p: GuideProject): string {
  const check = p.check === null
    ? "- Declared check: none — tumwater.json sets no `check.command` and no installed root " +
      "declares a `test`/`typecheck`/`build` script, so the merge gates have nothing to run."
    : `- Declared check: ${describeCheck(p.check)} — the command the team verifies a change with.`;
  return `## This project

- Base branch: \`${p.baseBranch}\` — the branch the team merges to.
${check}
- Team: ${p.teamRunning ? "a team is running here now." : "no team is running here."}`;
}

/** The guide: the static body, plus the `This project` section when `project` carries the repo's
 * facts. Pure — everything it reads arrives in the argument. */
export function guideText(project?: GuideProject): string {
  return project === undefined ? GUIDE_BODY : `${GUIDE_BODY}\n\n${projectSection(project)}`;
}

/** The repo's own guide facts, or null when `root` is not a ready tumwater repo — the same
 * preconditions `tumwater start` checks (startup-gates.ts's repoNotReady), read without failing,
 * so the command prints the static body outside a repo like `help` does. */
async function projectFacts(root: string): Promise<GuideProject | null> {
  if ((await repoNotReady(root)) !== null) return null;
  const config = loadConfigSafe(root).config;
  return {
    baseBranch: targetBranch(config?.baseBranch, await currentBranch(root)),
    check: detectBuildCheck(root, config),
    teamRunning: orchestratorAlive(root),
  };
}

/** Answer a `tumwater guide` invocation: print the guide for the repo the command runs in, or the
 * static body alone outside a repo (exit 0, like `help`). */
export async function cmdGuide(root: string): Promise<void> {
  say(guideText(await projectFacts(root) ?? undefined));
}
