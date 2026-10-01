#!/usr/bin/env node
import {
  fail,
  say,
  sayJson,
  sayJsonOrRender,
  flagValue,
  DURATION_FLAG,
  REASON_FLAG,
  grepFlagSpec,
  N_FLAG,
  parseCountFlag,
  parsePortFlag,
  parseRoleFlag,
  rejectUnknownArgs,
  ROLE_FLAG,
  RUN_FLAG_SPECS,
  SINCE_FLAG,
} from "./cli-args.js";
import { parsePromptArgs } from "./cli-command-args.js";
import { cmdAbort, cmdConfig, cmdPause, cmdResetCounters, cmdResume, cmdStop, cmdWake, CONFIG_USAGE } from "./operator-commands.js";
import { cmdPrompt } from "./prompt-commands.js";
import { cmdLogs, GREP_VALUE_ERROR } from "./ui/log-commands.js";
import { cmdInit, cmdRun } from "./cli-run.js";
import { repoToplevel } from "./git.js";
import { repoNotReady } from "./startup-gate.js";
import { runDoctor } from "./doctor.js";
import { renderDoctor } from "./ui/doctor-report.js";
import { renderBacklogMarkdown } from "./ui/backlog-report.js";
import { renderRoleMarkdown } from "./ui/role-report.js";
import { rolePayload } from "./role-view.js";
import { cmdHistory, HISTORY_GREP_VALUE_ERROR } from "./ui/history.js";
import { cmdTick, TICK_USAGE } from "./ui/tick-detail.js";
import { cmdReport } from "./ui/report.js";
import { snapshot } from "./status-data.js";
import { renderStatus } from "./ui/status-render.js";
import { runTui } from "./ui/tui.js";
import { cmdGui, TOKEN_VALUE_ERROR } from "./ui/gui.js";
import { statusPayload } from "./ui/status-payload.js";
import { backlogPayload } from "./backlog.js";
import { collectFleetChanges, collectRoleChange } from "./change-data.js";
import { renderFleetChange, renderRoleChange } from "./ui/change-preview.js";
import { knownRoleIdsCached } from "./config.js";
import { errorMessage } from "./text.js";
import { HELP, helpTopic, suggestCommand } from "./help.js";
import { PACKAGE_JSON, nodeFloorProblem, packageEnginesNode, packageVersion } from "./version.js";

// The CLI's help text and its per-command topic parser live in help.ts — importing cli.ts
// would run main(), so tests pin the topics against help.ts directly.

/** Fail fast on the first unmet repo precondition (startup-gate.ts's repoNotReady — the repo
 * half of `tumwater run`'s startup gate, shared by every repo-bound command). */
async function requireReadyRepo(root: string): Promise<void> {
  const notReady = await repoNotReady(root);
  if (notReady !== null) fail(notReady);
}

/** Peel `tumwater role <id>`'s positional id off the argument list: the first token that is
 * neither a flag nor the value of a --role flag. Returns the id (null when absent) and the
 * remaining arguments — flags only, ready for rejectUnknownArgs and sayJsonOrRender. The
 * id may also arrive as --role <id>, the flag spelling every other role-targeting command
 * shares; the collector's caller rejects both spellings at once rather than silently
 * picking one. Lives in cli.ts because it exists only for this one command's mixed
 * positional/flag vocabulary. */
function peelRolePositional(args: string[]): { id: string | null; rest: string[] } {
  const roleIdx = args.indexOf("--role");
  let id: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""; // Unreachable fallback: the loop bound guarantees a token here.
    // A non-flag token that is not a --role flag's value is the positional, taken once;
    // everything else — flags and their values alike — rides in rest for rejectUnknownArgs
    // and flagValue to claim.
    if (!arg.startsWith("-") && id === null && !(roleIdx >= 0 && i === roleIdx + 1)) {
      id = arg;
      continue;
    }
    rest.push(arg);
  }
  return { id, rest };
}

/** Peel a positional-first command's bare tokens off the argument list: every flag-shaped
 * token rides in rest for rejectUnknownArgs, every bare token is a positional. For commands
 * with no valued flags (tick: `--json` alone) the split is a prefix test — a negative tick
 * number (`tick bugfix -3`) arrives flag-shaped and fails the unknown-arg gate, which is the
 * right answer for a non-positive n anyway. Lives in cli.ts beside peelRolePositional because
 * it exists only for this one command's positional vocabulary. */
function peelPositionals(args: string[]): { positionals: string[]; rest: string[] } {
  const positionals: string[] = [];
  const rest: string[] = [];
  for (const arg of args) (arg.startsWith("-") ? rest : positionals).push(arg);
  return { positionals, rest };
}

/** The marker commands that share runMarkerCommand's guard+dispatch shape below. */
type MarkerCommand = "reset-counters" | "wake" | "abort" | "pause" | "resume";

/** The CLI command layer of each marker command, keyed by its CLI name (the command bodies
 * live in operator-commands.ts, the shared marker-writing cores in operator-intent.ts). One
 * map so a new marker command registers its core beside its case label instead of growing
 * another copy of the guard sequence. */
const markerCommandCores: Record<MarkerCommand, (root: string, args: string[]) => Promise<void>> = {
  "reset-counters": cmdResetCounters,
  wake: cmdWake,
  abort: cmdAbort,
  pause: cmdPause,
  resume: cmdResume,
};

/** The shared shape of the five marker commands (reset-counters, wake, abort, pause, resume):
 * reject unknown args (each takes only the optional --role flag), gate on a ready repo, then
 * dispatch to its operator-commands core. One copy of the guard sequence so the five cannot
 * drift on validation order or gating. */
async function runMarkerCommand(root: string, command: MarkerCommand, args: string[]): Promise<void> {
  // `pause` alone accepts `--for <duration>` (the timed pause) and `--reason <text>` (the
  // operator pause's why); the other marker commands keep the plain --role vocabulary, so a
  // stray --for or --reason fails fast instead of being silently ignored.
  rejectUnknownArgs(command, args, command === "pause" ? [ROLE_FLAG, DURATION_FLAG, REASON_FLAG] : [ROLE_FLAG]);
  await requireReadyRepo(root);
  await markerCommandCores[command](root, args);
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  // The Node-floor gate, before any command does work: package.json's engines spec is the
  // declared minimum, and a runtime below it fails with the fix instead of whatever the
  // first unsupported API call happens to throw. A floor the package read cannot supply
  // (a broken install) stands down rather than blocking every command on a value it
  // cannot evaluate — packageEnginesNode's rationale, not the version command's job here.
  const floor = packageEnginesNode(PACKAGE_JSON);
  if (floor !== null) {
    const problem = nodeFloorProblem(process.versions.node, floor);
    if (problem !== undefined) fail(problem);
  }
  // `tumwater <command> --help` (or `-h`) prints that command's help topic — the same text
  // `tumwater help <command>` derives from the full listing — and exits 0. Intercepted once
  // here, before any command parses its arguments or gates on a ready repo, so the flag
  // cannot collide with a command's real flags (a command's arg gate never sees it) and every
  // command gains the convention at once — `help` included, whose own topic it answers
  // (a `--help` topic lookup would only fail: the listing names no such command); a command
  // with no topic falls through to its ordinary dispatch, where an unknown argument is
  // still named.
  if (
    command !== undefined &&
    command !== "--help" &&
    command !== "-h" &&
    (args.includes("--help") || args.includes("-h"))
  ) {
    const topic = helpTopic(command);
    if (topic !== null) {
      say(topic);
      return;
    }
  }
  // The repo root, not the cwd: every command must behave identically from any subdirectory
  // of the repo it targets (.tumwater/ and tumwater.json live at the toplevel, and
  // readBranchHead's ref-file fast path needs a root that actually holds .git). Outside a
  // repository the probe fails and cwd is used as before, so doctor outside a repo still
  // reports why the environment is not ready.
  const root = (await repoToplevel(process.cwd())) ?? process.cwd();
  switch (command) {
    case "init":
      await cmdInit(root, args);
      break;
    case "run":
      rejectUnknownArgs("run", args, RUN_FLAG_SPECS);
      await cmdRun(root, args);
      break;
    case "tui":
      rejectUnknownArgs("tui", args, []);
      await requireReadyRepo(root);
      await runTui(root);
      break;
    case "gui":
      rejectUnknownArgs("gui", args, [
        {
          names: ["--port"],
          value: true,
          valueName: "<n>",
          // gui is gui.ts's only flag, so the shape parser lives beside its one body; the
          // gate's early report re-runs it so `gui --port abc` names the typo before the
          // ready-repo gate can mask it.
          validate: (value) => {
            parsePortFlag(value);
          },
        },
        { names: ["--all-interfaces"] },
        { names: ["--token"], value: true, valueName: "<secret>", missingValue: TOKEN_VALUE_ERROR },
      ]);
      await requireReadyRepo(root);
      await cmdGui(root, args);
      break;
    case "status":
      rejectUnknownArgs("status", args, [{ names: ["--json"] }]);
      await requireReadyRepo(root);
      if (args.includes("--json")) {
        // Machine-readable fleet state — the document GET /api/status serves minus the
        // serving process's own `serverBuildSha`, printed with no server. A query, not a
        // health verdict: exit 0 on any successful read and let scripts interpret fields
        // themselves ("running": false is data, not failure).
        sayJson(statusPayload(root));
      } else {
        say(renderStatus(root, snapshot(root), process.stdout.isTTY ? process.stdout.columns : undefined));
      }
      break;
    case "config": {
      // Subcommand arity before the ready-repo gate, so a malformed get/set fails with its
      // usage no matter the directory: bare config takes nothing, `get` exactly one key,
      // `set` exactly a key and a value. cmdConfig dispatches on the (now well-shaped) args.
      if (args.length > 0) {
        if (args[0] !== "get" && args[0] !== "set")
          fail(CONFIG_USAGE);
        if (args[0] === "get" && args.length !== 2) fail("usage: tumwater config get <key>");
        if (args[0] === "set" && args.length !== 3) fail("usage: tumwater config set <key> <value>");
      }
      // An initialized repo always has tumwater.json, so this gate doubles as "a config
      // exists to print" — the command never runs outside a project.
      await requireReadyRepo(root);
      await cmdConfig(root, args);
      break;
    }
    case "report": {
      // No requireReadyRepo gate: the report aggregates files that degrade to zeros when
      // missing, so it runs (and prints an all-zero window) in any directory.
      rejectUnknownArgs("report", args, [
        {
          names: ["--days"],
          value: true,
          valueName: "<n>",
          // The gate's early report re-runs cmdReport's own shape parser (report.ts), so
          // `report --days abc` names the typo even though report has no ready-repo gate.
          validate: (value) => {
            parseCountFlag("--days", value);
          },
        },
        { names: ["--failures"] },
        SINCE_FLAG,
        { names: ["--json"] },
      ]);
      // --since is handled before the day-shape reads: it is a rival shape (totals over a
      // trailing window vs a series over whole days), not a modifier of either.
      await cmdReport(root, args);
      break;
    }
    case "doctor": {
      // No requireReadyRepo gate: doctor's job is to report WHY the environment isn't ready,
      // so it must run outside a git repo and print fail lines rather than throwing.
      rejectUnknownArgs("doctor", args, [{ names: ["--json"] }]);
      const report = await runDoctor(root);
      // --json prints the collector's own payload (the DoctorReport object), not a re-parse of
      // the render — the `report --json` precedent. The exit-code contract below holds in both
      // forms: 1 when any check fails, 0 otherwise; warnings never fail the exit.
      sayJsonOrRender(args, report, renderDoctor);
      if (report.checks.some((c) => c.level === "fail")) process.exitCode = 1; // Warnings never fail the exit.
      break;
    }
    case "logs":
      rejectUnknownArgs("logs", args, [
        { names: ["-f", "--follow"] },
        N_FLAG,
        SINCE_FLAG,
        grepFlagSpec(GREP_VALUE_ERROR),
        { names: ["--json"] },
        ROLE_FLAG,
        { names: ["--prompt"] },
      ]);
      await requireReadyRepo(root);
      await cmdLogs(root, args);
      break;
    case "history":
      rejectUnknownArgs("history", args, [
        N_FLAG,
        SINCE_FLAG,
        grepFlagSpec(HISTORY_GREP_VALUE_ERROR),
        { names: ["--json"] },
        ROLE_FLAG,
      ]);
      await requireReadyRepo(root);
      await cmdHistory(root, args);
      break;
    case "tick": {
      // Positional-first command (the role command's pattern): the <role> <n> tokens peel off,
      // the flags that remain go through rejectUnknownArgs (only --json is admitted), and
      // cmdTick owns the arity and value validation — a missing role, an unknown id, a
      // non-positive or non-numeric n, or a stray extra positional fails there with the usage.
      const { positionals, rest } = peelPositionals(args);
      rejectUnknownArgs("tick", rest, [{ names: ["--json"] }]);
      // Arity before the ready-repo gate (the config subcommands' precedent): a malformed
      // invocation fails with its usage no matter the directory. cmdTick keeps the guard too —
      // in-process callers reach it without this dispatcher.
      if (positionals.length !== 2) fail(`usage: ${TICK_USAGE}`);
      await requireReadyRepo(root);
      await cmdTick(root, positionals, rest.includes("--json"));
      break;
    }
    case "diff": {
      // The repo half of requireReadyRepo still gates: a directory tumwater cannot read yet
      // (no git, not a repository, no tumwater.json, no commits) has no fleet to ask about,
      // and the change view's own degradation would misreport that as "main branch <name>
      // does not exist" — so the shared readiness wording answers here, like every sibling
      // command. Past the gate an absent worktree still degrades to a `no worktree for
      // <role>` line (exit 0), so the command answers in any initialized directory —
      // report's rationale.
      rejectUnknownArgs("diff", args, [ROLE_FLAG, { names: ["--json"] }]);
      await requireReadyRepo(root);
      // Absent --role is the fleet-wide form: one line per loop holding pending work
      // (parseRoleFlag returns null only for an absent flag — an empty or unknown value
      // already failed above). A named role keeps the full per-role view.
      const role = parseRoleFlag(args, knownRoleIdsCached(root));
      if (role === null) {
        sayJsonOrRender(args, await collectFleetChanges(root), renderFleetChange);
      } else {
        const change = await collectRoleChange(root, role);
        sayJsonOrRender(args, change, renderRoleChange);
      }
      break;
    }
    case "backlog": {
      // No requireReadyRepo gate: the entry readers degrade to [] on a missing file, so the
      // command prints three empty sections in any directory (report's rationale, not config's).
      rejectUnknownArgs("backlog", args, [{ names: ["--json"] }]);
      // Machine-readable backlog — the three entry arrays the Markdown view renders and the
      // GUI's /api/backlog serves (status --json's "print the endpoint's payload" pattern):
      // a pretty-printed JSON document in every exit-0 case, never prose. The payload is a
      // thunk, so whichever branch runs reads the three entry files exactly once — the
      // Markdown renderer consumes the same arrays the JSON document prints.
      sayJsonOrRender(args, () => backlogPayload(root), renderBacklogMarkdown);
      break;
    }
    case "role": {
      // No requireReadyRepo gate, like backlog: role-view degrades (missing state files →
      // fresh defaults, a missing queue directory an empty inbox), so the command inspects
      // a repo the fleet never started in — and a torn one — instead of refusing.
      const { id: positional, rest } = peelRolePositional(args);
      rejectUnknownArgs("role", rest, [ROLE_FLAG, { names: ["--json"] }]);
      // The id is required: positional (`tumwater role <id>`) or --role <id> (the flag
      // spelling every other role-targeting command shares). Both at once is a mistake, not
      // a silent pick of one.
      const flagId = flagValue(rest, "--role") ?? null;
      const id = positional ?? flagId;
      if (!id) fail("tumwater role needs a role id");
      if (positional !== null && flagId !== null && flagId !== positional)
        fail("give the role id once — as the positional or as --role <id>, not both");
      // The unknown-role answer (exit 1, unknownRoleMessage's wording) lives in the
      // collector; here the id just has to be non-null for the thunk's types.
      sayJsonOrRender(rest, () => rolePayload(root, id), renderRoleMarkdown);
      break;
    }
    case "prompt":
      // Parse before the gate: prompt's positionals are free-form, so rejectUnknownArgs
      // cannot run here, and without this pre-parse `tumwater prompt --role` outside an
      // initialized repo would report "not a git repository" instead of the flag error —
      // the same masking every other command's spec-based missing-value check avoids.
      // parsePromptArgs is pure (fail() is its only effect), so cmdPrompt re-running it
      // below cannot drift from what this pre-parse accepted.
      parsePromptArgs(args);
      await requireReadyRepo(root);
      await cmdPrompt(root, args);
      break;
    case "reset-counters":
    // Fall through: the five marker commands share one guard+dispatch shape — unknown-args
    // rejection against the optional --role flag, the ready-repo gate, then the
    // operator-commands core — so runMarkerCommand holds it once instead of five copies
    // drifting. The case labels above are exactly MarkerCommand's members, which is what
    // makes the cast below exhaustive.
    case "wake":
    case "abort":
    case "pause":
    case "resume": {
      await runMarkerCommand(root, command as MarkerCommand, args);
      break;
    }
    case "stop": {
      // No flags: stop is a bare signal to the recorded orchestrator pid, so any argument is
      // a mistake and fails before a signal is ever sent.
      rejectUnknownArgs("stop", args, []);
      await requireReadyRepo(root);
      await cmdStop(root);
      break;
    }
    case "version":
    case "--version":
    case "-v": {
      // A stray flag fails like every other command's: `tumwater version --json` (a plausible
      // slip from `status --json`) must not print a version as if it had answered the query.
      rejectUnknownArgs("version", args, []);
      // The read lives in version.ts (testable; cli.ts runs main() on import). A broken
      // install — a missing or malformed package.json — fails with the reason instead of a
      // raw stack trace, and a non-string version fails instead of printing "undefined".
      const { version, problem } = packageVersion(PACKAGE_JSON);
      if (problem !== undefined || version === undefined)
        fail(problem ?? "package.json carries no version field (the running harness's install looks broken)");
      say(version);
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined: {
      // `help <command>` prints that command's usage stanza(s), parsed from the same text the
      // full listing prints, so a topic cannot drift from it; a bare `help` (or an unknown
      // topic) points back at the full list rather than pretending the token was answered.
      if (args.length > 1) fail("help takes at most one command name");
      if (args.length === 1) {
        const name = args[0] ?? "";
        const topic = helpTopic(name);
        if (topic === null) {
          const suggestion = suggestCommand(name);
          fail(
            `no help topic: ${name}${suggestion ? ` — did you mean \`${suggestion}\`?` : ""} (try \`tumwater help\` for the full command list)`,
          );
        }
        say(topic);
      } else {
        process.stdout.write(HELP);
      }
      break;
    }
    default: {
      const suggestion = suggestCommand(command);
      fail(
        `unknown command: ${command}${suggestion ? ` — did you mean \`${suggestion}\`?` : ""} (try \`tumwater help\`)`,
      );
    }
  }
}

main().catch((err: unknown) => {
  fail(errorMessage(err));
});
