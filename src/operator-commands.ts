import { knownRoleIds, knownRoleIdsCached, loadConfig, loadConfigSafe } from "./config.js";
import { fail, failOverDurationCap, flagValue, parseDurationFlag, parseRoleFlag, say, sayJson } from "./cli-args.js";
import { parsePromptArgs } from "./cli-command-args.js";
import {
  type CancelOutcome,
  cancelRolePrompt,
  promptPreview,
  queuedPrompts,
  queuedRolePrompts,
} from "./inbox.js";
import { errorMessage, suggestClosest } from "./text.js";
import { TOP_LEVEL_KEYS } from "./config-validation.js";
import { setConfigKey } from "./config-write.js";
import { errCode } from "./errno.js";
import { allRoleIds, DIRECTOR_ROLE, unknownRoleMessage } from "./roles.js";
import { pauseFleet, pauseRole, pausedRoles, readOrchestratorInfo, resumeFleet, resumeRole } from "./fleet-state.js";
import { pidAlive } from "./process.js";
import {
  markerApplyNote,
  NO_HARNESS_ERROR,
  PAUSE_FOR_MAX_MS,
  requestAbort,
  requestResetCounters,
  requestWake,
  rolePauseMessage,
  roleResumeMessage,
  submitRolePromptAndWake,
  timedPauseBits,
} from "./operator-intent.js";

/** The CLI layer of the operator-intent protocol: the `reset-counters`, `wake`, `abort`,
 * `pause`, `resume`, `stop`, `config`, and `prompt` commands, split out of cli.ts so the
 * command bodies live beside their shared `--role` resolution. The marker-writing cores and
 * shared confirmations they print live in src/operator-intent.ts (shared with the dashboard
 * and TUI); the fleet-side consumer half is src/operator-requests.ts. Every command here is
 * deliberately usable without a live harness except `abort` and `stop`, which have nothing
 * to reach when no fleet is up. */

/** The `--role <id>` value when given, resolved WITHOUT tumwater.json when it names a
 * built-in catalog role: the fleet itself tolerates a broken config (the live reload keeps
 * the last-known-good one), so an operator marker aimed at a built-in loop must not depend
 * on the file parsing — the same resilience `logs --role` already has. A custom-loop id or
 * an unknown id falls through to the config-backed check, which fails with the honest error
 * (the config problem, or "unknown role" naming every valid id). Returns null when no
 * --role is given. */
function namedRole(root: string, args: string[]): string | null {
  const role = flagValue(args, "--role");
  if (role === null) return null;
  if (role && allRoleIds().includes(role)) return role;
  try {
    return parseRoleFlag(args, knownRoleIds(loadConfig(root)));
  } catch (err) {
    fail(errorMessage(err)); // same message main().catch would print, but via the standard fail()
  }
}

/** The role(s) a marker command targets: the `--role <id>` value when given, otherwise every
 * role in the config. reset-counters and wake share the same all-roles default, so it lives
 * here once instead of drifting between their bodies. */
function targetRoles(root: string, args: string[]): string[] {
  const role = namedRole(root, args);
  return role ? [role] : Object.keys(loadConfig(root).roles);
}

/** `tumwater reset-counters [--role <id>]`: zero the per-loop counters shown in the
 * dashboards so a fresh observation window can begin. Scheduling fields and pi session
 * continuity are untouched: loops keep sleeping/waking exactly as before. */
export async function cmdResetCounters(root: string, args: string[]): Promise<void> {
  say(requestResetCounters(root, targetRoles(root, args)));
}

/** `tumwater wake [--role <id>]`: tell the fleet "whatever the loops were failing on is
 * fixed — try again", so the named roles tick within one poll instead of sleeping until
 * their backoff expires. */
export async function cmdWake(root: string, args: string[]): Promise<void> {
  say(requestWake(root, targetRoles(root, args)));
}

/** `tumwater abort --role <id>`: kill one loop's in-flight tick right now. The CLI cannot
 * reach into the orchestrator process, so the request rides on disk like reset-counters':
 * a per-role marker file a running fleet consumes within one poll cycle (the runner's
 * abortTick kills the pi child and resets the worktree to main). Requires a live harness —
 * with no fleet there is nothing to consume the marker. The loop stays enabled: it backs
 * off normally and later ticks proceed as usual. */
export async function cmdAbort(root: string, args: string[]): Promise<void> {
  // As in cmdLogs: the config exists only to validate the id against built-ins plus
  // user-defined loops; a missing --role fails before it is ever needed.
  const role = namedRole(root, args);
  if (!role) fail("abort requires --role <id> (e.g. `--role feature`)");
  const result = requestAbort(root, role);
  if (!result.ok) fail(result.error);
  say(result.message);
}

/** `tumwater pause [--role <id>] [--for <duration>]`: with a role, stop THAT loop from starting new ticks —
 * in-flight ones finish, every other role (the director included) keeps running; without one,
 * stop every role loop from starting NEW ticks while in-flight ones finish and the director
 * keeps running (its prompts outrank operator gates, like under the budget cap). The markers
 * are persistent state, not one-shot requests: presence means paused until `resume` removes
 * it — so pausing before startup starts an already-paused fleet. Unlike abort, no live
 * harness is required; when none runs, say where the pause takes effect instead of failing.
 * Idempotent: a second pause reports the existing marker as-is. */
export async function cmdPause(root: string, args: string[] = []): Promise<void> {
  // `--for <duration>` (the timed pause): the ms-epoch deadline pauseFleet/pauseRole write
  // into the marker and every consumer honors — the gate in cli.ts has already restricted
  // the flag to this command, so its value is parsed (and fails fast) here, beside the
  // writers it feeds.
  const forRaw = flagValue(args, "--for");
  const forMs = forRaw !== null ? parseDurationFlag("--for", forRaw) : undefined;
  // Fail fast beside the parse, before any marker is written: an over-cap deadline is a
  // standing pause in disguise, and the message names the command that is one (the same
  // capped-flag idiom the --since windows in cli.ts use).
  if (forMs !== undefined)
    failOverDurationCap(
      "pause --for",
      forMs,
      PAUSE_FOR_MAX_MS,
      "for a longer or standing pause run bare `tumwater pause` (lift it with `tumwater resume`)",
    );
  const timed = forMs === undefined ? undefined : { ms: forMs, untilMs: Date.now() + forMs };
  const untilMs = timed?.untilMs;
  // Per-role branch: pauseRole in src/fleet-state.ts is the single writer of the role marker
  // (the plan 2/2 dashboard endpoint will call it too), so CLI and dashboard cannot drift on
  // format or idempotence; a false return means the role was already in the set.
  const role = namedRole(root, args);
  if (role) {
    // pauseRole in src/fleet-state.ts is the single writer of the role marker (the TUI's
    // Ctrl+P calls it too), so CLI and TUI cannot drift on format or idempotence; a false
    // return means the role was already in the set, which rolePauseMessage words — unless a
    // `--for` stands, which overwrites the deadline and reports the fresh confirmation.
    say(rolePauseMessage(root, role, pauseRole(root, role, untilMs), timed));
    return;
  }
  // pauseFleet in src/fleet-state.ts is the single writer of the pause marker — the GUI's
  // /api/pause toggle calls it too, so the CLI and the dashboard cannot drift on format
  // or idempotence; a false return means the marker was already there (a `--for` never
  // no-ops: it overwrites the standing deadline instead).
  if (!pauseFleet(root, untilMs)) {
    say("already paused");
    return;
  }
  const { when, tail } = markerApplyNote(root);
  const { forPhrase, note } = timedPauseBits(timed);
  say(
    `fleet paused${forPhrase} — role loops stop starting new ticks${when} (in-flight ticks finish; the director keeps running your prompts)${note}${tail}`,
  );
}

/** Deliver the stop signal to the recorded orchestrator pid: "signalled" when SIGTERM was
 * delivered, "gone" when the process died between the caller's liveness check and the
 * signal (ESRCH) — stop's goal is already met in that case, so the caller reports it as
 * done instead of failing with a raw `kill ESRCH`. Any other delivery error is rethrown
 * with the pid named: an operator seeing Node's bare "kill EPERM" cannot tell it means a
 * process they cannot signal (recycled pid owned by another user), not a broken harness. */
export function signalOrchestrator(pid: number): "signalled" | "gone" {
  try {
    process.kill(pid, "SIGTERM");
    return "signalled";
  } catch (err) {
    const code = errCode(err);
    if (code === "ESRCH") return "gone";
    if (code === "EPERM")
      throw new Error(
        `stop could not signal pid ${pid} (EPERM) — it is owned by another user or the pid was recycled; kill it directly with \`kill ${pid}\``,
      );
    throw err;
  }
}

/** `tumwater stop`: SIGTERM the running orchestrator, which drains its in-flight ticks and
 * exits — exactly the shutdown the supervised child's own SIGINT/SIGTERM handler performs, so
 * Ctrl+C and `stop` from another terminal are the same code path (the supervisor needs no
 * signal of its own: a clean child exit already ends its loop). Unlike the marker commands
 * above this reaches a real process, so a live harness is required. The pid-recycling risk
 * that `orchestratorAlive` already accepts everywhere (status, abort, pause) applies here
 * too: the info file is refreshed by the live orchestrator, so the window is small, and the
 * signal is the same one a human `kill <pid>` would send. */
export async function cmdStop(root: string): Promise<void> {
  // Deliberately the same liveness gate and wording `requestAbort` uses: an unreadable info
  // file (torn write) and a dead recorded pid both mean nothing is running to stop.
  const info = readOrchestratorInfo(root);
  if (!info || !pidAlive(info.pid)) {
    fail(NO_HARNESS_ERROR);
  }
  // A pid that dies between the liveness check and the signal (ESRCH) means the fleet is
  // already stopped — say so and exit clean rather than surfacing Node's raw kill error;
  // anything else (EPERM on a recycled pid, …) comes back as signalOrchestrator's message.
  if (signalOrchestrator(info.pid) === "signalled")
    say("stop requested — the fleet drains its in-flight ticks and exits (the same path as Ctrl+C)");
  else
    say("the orchestrator exited before the stop signal landed — nothing is running");
}

/** `tumwater config [get <key> | set <key> <value>]`: with no arguments, print the effective
 * merged config — exactly what `loadConfig(root)` returns — as pretty JSON, so an operator
 * debugging scheduling or custom-loop wiring sees what the fleet would actually load instead
 * of overlaying defaults onto tumwater.json by hand. A query, not a writer: no redaction (the
 * config holds no secrets — provider keys belong to pi's own env) and no transformation,
 * including the per-role entries custom loops merge into. `get <key>` prints that one key's
 * resolved value (defaults merged in, exactly what the no-arg dump prints) as JSON, failing
 * with the valid top-level keys on an unknown one. An optional key nothing sets (model,
 * provider, fallbackModel, …) prints `null` — JSON's no-value — because JSON.stringify of an
 * absent key is the undefined *value*, which say would render as the bare word `undefined`:
 * not parseable JSON for a script and indistinguishable from a crash for a human. `set <key> <value>` writes one top-level
 * key through setConfigKey and prints one confirmation line naming the key and its new value;
 * a running fleet picks the change up on its next ~2 s config poll (newLiveConfigReload).
 * A malformed or invalid tumwater.json fails with validateConfig's actionable message and
 * prints no JSON — the same surfacing doctor's config check produces. */
export async function cmdConfig(root: string, args: string[] = []): Promise<void> {
  const [sub, key, ...rest] = args;
  if (sub === "get") {
    const k = key ?? "";
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(k)) {
      // The same did-you-mean setConfigKey appends to its unknown-key error, so a typo'd key
      // reads the same whichever verb misspelled it.
      const suggestion = suggestClosest(k, TOP_LEVEL_KEYS as readonly string[]);
      fail(
        `unknown config key "${k}" (valid top-level keys: ${TOP_LEVEL_KEYS.join(", ")})${
          suggestion ? ` — did you mean \`${suggestion}\`?` : ""
        }`,
      );
    }
    const { config, error } = loadConfigSafe(root);
    if (config === undefined) fail(error); // validateConfig's message, via the standard fail()
    const value = (config as unknown as Record<string, unknown>)[k];
    say(JSON.stringify(value === undefined ? null : value)); // Absent optional key → JSON null.
    return;
  }
  if (sub === "set") {
    const result = setConfigKey(root, key ?? "", rest[0] ?? "");
    if (!result.ok) fail(result.error);
    say(`set ${key} to ${JSON.stringify((result as { value: unknown }).value)}`);
    return;
  }
  // Bare config, or anything else: the whole-config dump is the default, and cli.ts's arity
  // check has already rejected a malformed get/set — this usage line is the defensive tail.
  if (sub !== undefined)
    fail("usage: tumwater config [get <key> | set <key> <value>] (bare config prints the whole resolved config)");
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) fail(error); // validateConfig's message, via the standard fail()
  sayJson(config);
}

/** `tumwater resume [--role <id>]`: with a role, lift that one role's pause (removed from the
 * per-role marker set); without one, lift a fleet pause by removing its marker. Idempotent
 * like pause: with no marker there is nothing to do. No live harness required — resuming
 * before startup just means the next `tumwater run` starts unpaused. */
export async function cmdResume(root: string, args: string[] = []): Promise<void> {
  const role = namedRole(root, args);
  if (role) {
    // resumeRole (src/fleet-state.ts) is the single remover of the per-role marker; a false
    // return means the role was never paused — the changed-state contract roleResumeMessage
    // words ("is already paused" vs "was not paused").
    say(roleResumeMessage(root, role, resumeRole(root, role)));
    return;
  }
  // resumeFleet (src/fleet-state.ts) is the single remover, shared with the GUI toggle; a false
  // return means there was no marker to lift.
  if (!resumeFleet(root)) {
    say("not paused");
    return;
  }
  const { when, tail } = markerApplyNote(root);
  // The per-role pause outlives a fleet resume (the markers are independent), so the resumed
  // fleet's confirmation must name the roles still individually paused instead of claiming
  // "role loops tick again" for loops the scheduler keeps gated.
  const still = pausedRoles(root);
  const roleNote = still.length > 0
    ? ` (${still.join(", ")} ${still.length === 1 ? "is" : "are"} still individually paused — \`tumwater resume --role <id>\` lifts each)`
    : "";
  say(`fleet resumed — role loops tick again${when}${roleNote}${tail}`);
}

/** `tumwater prompt [--role <id>] <text|list|cancel <n>>`: submit a steering prompt to the
 * director (default) or one role's queue, list what is queued with per-loop position
 * numbering, or cancel a queued prompt by position. The dispatcher in cli.ts gates on a ready
 * repo and delegates here; list output is grouped by loop — the director first (its queue is
 * the shared one every pre-1/2 prompt landed in), then each role with queued prompts — so a
 * per-role queue's position numbering stays unambiguous. */
export async function cmdPrompt(root: string, args: string[]): Promise<void> {
  const parsed = parsePromptArgs(args);
  // `--role <id>` scopes every mode to one loop's queue; the value is validated here, with
  // the same message every other --role consumer uses. The director is always valid: its
  // queue is the historical inbox (inbox.ts).
  //
  // Where the id set comes from differs by mode, following parseRoleScope's split: --list is
  // a read-only view, so a transiently broken tumwater.json must not take it down — it falls
  // back to the built-in catalog (knownRoleIdsCached), exactly like cmdLogs/cmdHistory's
  // --role scope, at the cost of a broken config hiding a custom loop's queued section. The
  // state-changing modes (enqueue, cancel) instead read through loadConfig and fail loudly
  // when an id was given: before writing to a named loop's queue the operator is owed the
  // config error, not a built-ins-only guess about whether the loop exists. With no --role
  // neither state-changing mode reads the config at all — the director queue (inbox.ts) needs
  // none, and a broken tumwater.json must not block steering the director.
  const validIds = parsed.mode === "list"
    ? knownRoleIdsCached(root)
    : parsed.role !== null
      ? knownRoleIds(loadConfig(root))
      : null;
  if (validIds !== null && parsed.role !== null && !validIds.includes(parsed.role)) {
    fail(unknownRoleMessage(parsed.role, validIds));
  }
  const role = parsed.role;
  if (parsed.mode === "list") {
    // Full text, verbatim: this is the inspection command that tells you what a queued
    // prompt actually says before you cancel it.
    if (role !== null) {
      const prompts = queuedRolePrompts(root, role);
      if (prompts.length === 0) {
        say(`nothing queued for ${role}`);
      } else {
        say(`${role}:`);
        prompts.forEach((p, i) => say(`${i + 1}. ${p}`));
      }
      return;
    }
    const sections: string[] = [];
    const director = queuedPrompts(root);
    if (director.length > 0) {
      sections.push(`director:\n${director.map((p, i) => `${i + 1}. ${p}`).join("\n")}`);
    }
    for (const r of validIds as string[]) {
      if (r === DIRECTOR_ROLE) continue;
      const prompts = queuedRolePrompts(root, r);
      if (prompts.length > 0) {
        sections.push(`${r}:\n${prompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}`);
      }
    }
    if (sections.length === 0) {
      say("nothing queued");
    } else {
      say(sections.join("\n"));
    }
    return;
  }
  if (parsed.mode === "cancel") {
    const target = role ?? DIRECTOR_ROLE;
    let outcome: CancelOutcome;
    try {
      outcome = cancelRolePrompt(root, target, parsed.position);
    } catch (err) {
      fail(errorMessage(err));
    }
    if (outcome.status === "gone") {
      // A concurrent dequeue is a normal race, not an error: report it and exit clean.
      say(`prompt ${parsed.position} is no longer queued — ${target} already took it`);
    } else {
      say(`cancelled: ${promptPreview(outcome.text)}`);
    }
    return;
  }
  const target = role ?? DIRECTOR_ROLE;
  const wake = submitRolePromptAndWake(root, target, parsed.text);
  if (role === null) {
    say("queued for the director loop");
  } else {
    say(`queued for the ${role} loop`);
  }
  say(wake);
}
