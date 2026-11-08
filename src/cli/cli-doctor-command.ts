import type { OrphanKillReport } from "../doctor/doctor-orphans.js";
import type { BacklogCommitReport } from "../doctor/doctor-backlog.js";
import type { RootInstallResync } from "../build/dep-install.js";
import type { BrokenPinDrop, LeftoverRetireReport } from "../doctor/doctor-contention-checks.js";
import {
  rejectUnknownArgs,
  JSON_FLAG,
  LIST_CHECKS_FLAG,
  PROBLEMS_FLAG,
  KILL_ORPHANS_FLAG,
  COMMIT_BACKLOG_FLAG,
  RESYNC_INSTALL_FLAG,
  DROP_BROKEN_PINS_FLAG,
  RETIRE_LEFTOVERS_FLAG,
  FOLLOW_FLAG,
  hasFollowFlag,
} from "./cli-flag-specs.js";
import { DOCTOR_CHECK_NAMES } from "../doctor/doctor-check-names.js";
import { fail, say, sayJson, sayJsonOrRender } from "./cli-output.js";
import { followView, type FollowViewSeams } from "./follow-view.js";
import { parseDoctorChecks, peelPositionals } from "./cli-command-args.js";
import { loadConfigSafe } from "../config/config.js";
import { failFollowJsonRival } from "./cli-args.js";

/** The optional side-effect results `tumwater doctor --kill-orphans`,
 * `--commit-backlog`, `--resync-install`, `--drop-broken-pins`, `--retire-leftovers`
 * carry onto a `--json` run — one slot per flag, present only when its flag was asked
 * for, so the JSON stays one document. */
interface DoctorOptionalParts {
  orphanKill: OrphanKillReport | undefined;
  backlogCommit: BacklogCommitReport | undefined;
  resyncInstall: RootInstallResync | undefined;
  brokenPinDrop: BrokenPinDrop | undefined;
  leftoverRetire: LeftoverRetireReport | undefined;
}

/** Run one doctor side-effect (`--kill-orphans`, `--commit-backlog`, `--resync-install`,
 * `--drop-broken-pins`, `--retire-leftovers`) and return its report payload for the optional
 * `--json` run — the shape every doctor*Case side-effect wrapper follows: import the effect's
 * module and run it only when its flag is present, then (text form only) print the effect's
 * own lines before the report with a separating blank line when there is anything to print;
 * `--json` keeps stdout one document, carrying the result on the payload instead. The lazy
 * per-effect `load` keeps each module imported only when its flag is asked for. */
async function doctorSideEffect<TPayload>(
  args: string[],
  flag: string,
  load: () => Promise<{ run: () => Promise<TPayload>; lines: (p: TPayload) => string[] }>,
): Promise<TPayload | undefined> {
  if (!args.includes(flag)) return undefined;
  const { run, lines } = await load();
  const payload = await run();
  // The text form prints the effect before the report; --json keeps stdout one document.
  if (!args.includes("--json")) {
    const out = lines(payload);
    for (const line of out) say(line);
    if (out.length > 0) say("");
  }
  return payload;
}

async function doctorKillOrphans(root: string, args: string[]): Promise<OrphanKillReport | undefined> {
  return doctorSideEffect(args, "--kill-orphans", async () => {
    const { killOrphans, orphanKillLines } = await import("../doctor/doctor-orphans.js");
    return { run: () => killOrphans(root), lines: orphanKillLines };
  });
}

async function doctorCommitBacklog(root: string, args: string[]): Promise<BacklogCommitReport | undefined> {
  return doctorSideEffect(args, "--commit-backlog", async () => {
    const { commitUncommittedBacklog, backlogCommitLines } = await import("../doctor/doctor-backlog.js");
    const { config } = loadConfigSafe(root); // the report's own config, so base resolution and the off-base skip match the `uncommitted backlog` row's
    return { run: () => commitUncommittedBacklog(root, config), lines: backlogCommitLines };
  });
}

async function doctorResyncInstall(root: string, args: string[]): Promise<RootInstallResync | undefined> {
  return doctorSideEffect(args, "--resync-install", async () => {
    const { resyncRootInstall, rootInstallResyncLines } = await import("../build/dep-install.js");
    return { run: () => resyncRootInstall(root), lines: rootInstallResyncLines };
  });
}

async function doctorDropBrokenPins(root: string, args: string[]): Promise<BrokenPinDrop | undefined> {
  return doctorSideEffect(args, "--drop-broken-pins", async () => {
    const { dropBrokenPins, brokenPinDropLines } = await import("../doctor/doctor-contention-checks.js");
    return { run: () => dropBrokenPins(root), lines: brokenPinDropLines };
  });
}

async function doctorRetireLeftovers(root: string, args: string[]): Promise<LeftoverRetireReport | undefined> {
  return doctorSideEffect(args, "--retire-leftovers", async () => {
    const { retireLeftovers, leftoverRetireLines } = await import("../doctor/doctor-contention-checks.js");
    const { config } = loadConfigSafe(root); // the row's own config, so the reap and the report agree on what is retirable
    return { run: () => retireLeftovers(root, config), lines: leftoverRetireLines };
  });
}

function doctorPayload<T extends object>(payload: T, parts: DoctorOptionalParts): T {
  const out = { ...payload } as Record<string, unknown>;
  if (parts.leftoverRetire !== undefined) out.leftoverRetire = parts.leftoverRetire;
  if (parts.brokenPinDrop !== undefined) out.brokenPinDrop = parts.brokenPinDrop;
  if (parts.resyncInstall !== undefined) out.resyncInstall = parts.resyncInstall;
  if (parts.backlogCommit !== undefined) out.backlogCommit = parts.backlogCommit;
  if (parts.orphanKill !== undefined) out.orphanKill = parts.orphanKill;
  return out as T;
}

/** The doctor flags whose strict rivals `--list-checks` refuses by name — `--problems`, the
 * follow spellings, and the five repair flags — because the listing is read-only and runnable
 * only with `--json` beside it. */
const LIST_CHECKS_RIVALS = ["--problems", "-f", "--follow", "--kill-orphans", "--commit-backlog", "--resync-install", "--drop-broken-pins", "--retire-leftovers"] as const;

/** `tumwater doctor`: report what in the environment is keeping the team from running, and
 * run the optional repair side-effects. No ready-repo gate: doctor's job is to report WHY the
 * environment isn't ready, so it must run outside a git repo and print fail lines rather than
 * throwing. `--list-checks` is its own mode — print every check name in report order without
 * running any check (or touching the repo), so an operator can pick a name for
 * `tumwater doctor <check>...` without a slow, side-probing full audit. `-f/--follow` reruns
 * the checks every couple of seconds and repaints the report until Ctrl+C or the process that
 * started it exits — the live form is read-only, so `--json` and every repair flag are refused
 * with it (the repaint can never repair anything). `seams` is the follow view's test seam
 * (interval and parent-death watch), unused by the one-shot forms. */
export async function cmdDoctor(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  const { positionals: checkNames, rest: doctorFlags } = peelPositionals(args);
  rejectUnknownArgs("doctor", doctorFlags, [JSON_FLAG, LIST_CHECKS_FLAG, PROBLEMS_FLAG, KILL_ORPHANS_FLAG, COMMIT_BACKLOG_FLAG, RESYNC_INSTALL_FLAG, DROP_BROKEN_PINS_FLAG, RETIRE_LEFTOVERS_FLAG, FOLLOW_FLAG]);
  // The names-only listing mode, before parseDoctorChecks so it never imports the check
  // modules or touches the repo: text prints each name on its own line in array order with
  // no header, verdict or blank line; --json prints the same names as one `checks` array.
  if (args.includes("--list-checks")) {
    if (checkNames.length > 0) fail("tumwater doctor --list-checks takes no check names");
    const rival = LIST_CHECKS_RIVALS.find((f) => args.includes(f));
    if (rival !== undefined) fail(`tumwater doctor --list-checks takes no ${rival}`);
    if (args.includes("--json")) sayJson({ checks: [...DOCTOR_CHECK_NAMES] });
    else for (const name of DOCTOR_CHECK_NAMES) say(name);
    return;
  }
  const follow = hasFollowFlag(args);
  const only = parseDoctorChecks(checkNames);
  const { runDoctor } = await import("../doctor/doctor.js");
  if (follow && args.includes("--json"))
    failFollowJsonRival("doctor --json");
  if (follow) {
    const repair = ["--kill-orphans", "--commit-backlog", "--resync-install", "--drop-broken-pins", "--retire-leftovers"].find((f) =>
      args.includes(f),
    );
    if (repair !== undefined) fail(`-f/--follow repaints the report read-only; ${repair} repairs — drop one of them`);
    // The live form is the one-shot report repainted: each frame re-runs the named checks
    // (or all) afresh, and followView serializes a slow frame so ticks cannot stack.
    await followView(
      async () => {
        const { renderDoctor, renderDoctorProblems } = await import("../doctor/doctor-render.js");
        const report = await runDoctor(root, undefined, undefined, only);
        return (args.includes("--problems") ? renderDoctorProblems : renderDoctor)(report);
      },
      seams,
    );
    return; // A Ctrl+C or parent-death end leaves process.exitCode untouched (the one-shot exit contract below is the one-shot's).
  }
  const { renderDoctor, renderDoctorProblems, problemsOnly } = await import("../doctor/doctor-render.js");
  const parts: DoctorOptionalParts = {
    orphanKill: await doctorKillOrphans(root, args),
    backlogCommit: await doctorCommitBacklog(root, args),
    resyncInstall: await doctorResyncInstall(root, args),
    brokenPinDrop: await doctorDropBrokenPins(root, args),
    leftoverRetire: await doctorRetireLeftovers(root, args),
  };
  const report = await runDoctor(root, undefined, undefined, only);
  // --json prints the collector's own payload (the DoctorReport object), not a re-parse of
  // the render — the `report --json` precedent. The exit-code contract below holds in both
  // forms: 1 when any check fails, 0 otherwise; warnings never fail the exit.
  // --problems keeps the full report for the render (it counts the hidden ok rows) and
  // hands --json the filtered one; the exit code below reads the full report either way.
  // --kill-orphans adds the kill result to the JSON object as `orphanKill`.
  if (args.includes("--problems"))
    sayJsonOrRender(args, args.includes("--json") ? doctorPayload(problemsOnly(report), parts) : report, renderDoctorProblems);
  else sayJsonOrRender(args, args.includes("--json") ? doctorPayload(report, parts) : report, renderDoctor);
  if (report.checks.some((c) => c.level === "fail")) process.exitCode = 1; // Warnings never fail the exit.
}
