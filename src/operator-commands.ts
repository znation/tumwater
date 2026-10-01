import { knownRoleIds, knownRoleIdsCached, loadConfig, loadConfigSafe } from "./config.js";
import { fail, failOverDurationCap, flagValue, parseDurationFlag, parseRoleFlag, say, sayJson } from "./cli-args.js";
import { parsePromptArgs } from "./cli-command-args.js";
import {
  type CancelOutcome,
  type ListedCancelOutcome,
  cancelListedPrompt,
  cancelRolePrompt,
  promptPreview,
  queuedPrompts,
  queuedRolePrompts,
} from "./inbox.js";
import { errorMessage, pauseReasonSuffix } from "./text.js";
import { setConfigKey, unknownConfigKeyError } from "./config-write.js";
import { errCode } from "./errno.js";
import { allRoleIds, DIRECTOR_ROLE, unknownRoleMessage } from "./roles.js";
import {
  normalizePauseReason,
  pauseFleet,
  pauseRole,
  pausedRoles,
  readOrchestratorInfo,
  resumeFleet,
  resumeRole,
} from "./fleet-state.js";
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
export async function cmdPause(root: string, args: string[] = [], now: number = Date.now()): Promise<void> {
  // `--for <duration>` (the timed pause): the ms-epoch deadline pauseFleet/pauseRole write
  // into the marker and every consumer honors — the gate in cli.ts has already restricted
  // the flag to this command, so its value is parsed (and fails fast) here, beside the
  // writers it feeds.
  const forRaw = flagValue(args, "--for");
  const forMs = forRaw !== null ? parseDurationFlag("--for", forRaw) : undefined;
  // `--reason <text>` (the operator pause's why): the gate in cli.ts has already restricted
  // the flag to this command, and its trailing-no-value slip to the spec's wording, so here
  // a valueless or empty reason fails with that same line beside the writer it feeds. The
  // reason folds to one line (normalizePauseReason, the same home pauseFleet writes through)
  // so the confirmation line, the marker, and every single-line surface carry the same text
  // — a raw newline in the flag's value would otherwise break the header's one-line badge.
  const reasonRaw = flagValue(args, "--reason");
  if (reasonRaw !== null && (reasonRaw === undefined || reasonRaw.trim() === ""))
    fail("pause --reason needs a reason");
  const reason = normalizePauseReason(reasonRaw ?? undefined);
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
  // `now` is the one instant the deadline and the confirmation both read, injected by tests
  // so the wording they pin cannot drift with the wall clock — the same single-clock
  // discipline timedPauseBits's own `now` parameter follows.
  const timed = forMs === undefined ? undefined : { ms: forMs, untilMs: now + forMs };
  const untilMs = timed?.untilMs;
  // Per-role branch: pauseRole in src/fleet-state.ts is the single writer of the role marker
  // (the plan 2/2 dashboard endpoint will call it too), so CLI and dashboard cannot drift on
  // format or idempotence; a false return means the role was already in the set.
  const role = namedRole(root, args);
  if (role) {
    // The plan keeps per-role pauses anonymous (a per-role reason would need a per-role map
    // for no observed need), so a reason aimed at a role pause fails fast here — accepting
    // the flag and silently dropping the note would tell the operator the reason stands
    // when no marker carries it. Before any marker is written, beside the other fail-fasts.
    if (reason !== undefined)
      fail(
        "pause --reason states why the whole fleet is paused — a per-role pause carries no reason (drop --role, or run bare `tumwater pause --reason <text>`)",
      );
    // pauseRole in src/fleet-state.ts is the single writer of the role marker (the TUI's
    // Ctrl+P calls it too), so CLI and TUI cannot drift on format or idempotence; a false
    // return means the role was already in the set, which rolePauseMessage words — unless a
    // `--for` stands, which overwrites the deadline and reports the fresh confirmation.
    say(rolePauseMessage(root, role, pauseRole(root, role, untilMs), timed, now));
    return;
  }
  // pauseFleet in src/fleet-state.ts is the single writer of the pause marker — the GUI's
  // /api/pause toggle calls it too, so the CLI and the dashboard cannot drift on format
  // or idempotence; a false return means the marker was already there (a `--for` never
  // no-ops: it overwrites the standing deadline instead).
  // The reason rides the fresh pause write (or a `--for` overwrite): the same last-write-wins
  // rule as the deadline, so an "already paused" no-op keeps the standing note as-is.
  if (!pauseFleet(root, untilMs, reason)) {
    say("already paused");
    return;
  }
  const { when, tail } = markerApplyNote(root);
  const { forPhrase, note } = timedPauseBits(timed, now);
  const why = pauseReasonSuffix(reason);
  say(
    `fleet paused${forPhrase}${why} — role loops stop starting new ticks${when} (in-flight ticks finish; the director keeps running your prompts)${note}${tail}`,
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

/** The config command's malformed-shapes usage line: cli.ts's arity gate fails a non-get/set
 * or wrongly-shaped subcommand with it, and cmdConfig repeats it as the defensive tail for an
 * argument the gate somehow missed. One constant so the synopsis cannot drift between the two
 * sites (mirrors tick-detail.ts's TICK_USAGE). */
export const CONFIG_USAGE =
  "usage: tumwater config [get <key> | set <key> <value>] (bare config prints the whole resolved config)";

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
    // setConfigKey's shared unknown-key error, so a typo'd key reads the same whichever
    // verb misspelled it.
    const unknown = unknownConfigKeyError(k);
    if (unknown) fail(unknown);
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
  if (sub !== undefined) fail(CONFIG_USAGE);
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

/** One traversal of the queues behind `prompt --list`'s render: with `--role`, that loop's
 * queue alone; otherwise the director first (its queue is the shared pre-1/2 inbox), then the
 * remaining catalog ids in order, empty queues skipped — exactly the sections the prose
 * prints. `position` is the 1-based per-loop number the prose prints and `--cancel`
 * consumes; `text` is the full verbatim prompt, not a preview. */
function promptListPayload(
  root: string,
  role: string | null,
  validIds: string[],
): { prompts: { role: string; position: number; text: string }[] } {
  const prompts: { role: string; position: number; text: string }[] = [];
  if (role !== null) {
    queuedRolePrompts(root, role).forEach((text, i) => prompts.push({ role, position: i + 1, text }));
    return { prompts };
  }
  queuedPrompts(root).forEach((text, i) => prompts.push({ role: DIRECTOR_ROLE, position: i + 1, text }));
  for (const r of validIds) {
    if (r === DIRECTOR_ROLE) continue;
    queuedRolePrompts(root, r).forEach((text, i) => prompts.push({ role: r, position: i + 1, text }));
  }
  return { prompts };
}

/** The user-facing reply for one resolved cancel: a concurrent dequeue is a normal race, not an
 * error, so it is reported and exited clean; a real cancel previews the text it removed. When
 * `labelRole` the cancelled line names the loop — the no-`--role` cancel resolves across every
 * loop, so its output must say where the prompt went — while a `--role`-scoped cancel already
 * names it in the user's own command. Shared by both cancel paths so their wording cannot
 * drift. */
function sayCancelOutcome(position: number, role: string, outcome: CancelOutcome, labelRole: boolean): void {
  if (outcome.status === "gone") {
    say(`prompt ${position} is no longer queued — ${role} already took it`);
    return;
  }
  say(labelRole ? `cancelled (${role}): ${promptPreview(outcome.text)}` : `cancelled: ${promptPreview(outcome.text)}`);
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
  // config error, not a built-ins-only guess about whether the loop exists. With no --role,
  // enqueue touches only the director queue (inbox.ts) and never reads the config — a broken
  // tumwater.json must not block steering the director — while cancel resolves its position
  // across the per-loop sections --list prints, through the same cached, never-throwing id set
  // --list uses, so it cancels exactly what the list showed even under a broken config.
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
    // One payload, two shapes: the prose render and the --json output both come from the
    // same array, so the per-loop positions --cancel consumes can never disagree with the
    // data a script reads. Full text, verbatim: this is the inspection command that tells
    // you what a queued prompt actually says before you cancel it.
    const payload = promptListPayload(root, role, validIds as string[]);
    if (parsed.json) {
      // An empty queue still prints the document, the history --json empty-rows precedent.
      sayJson(payload);
      return;
    }
    if (payload.prompts.length === 0) {
      say(role !== null ? `nothing queued for ${role}` : "nothing queued");
      return;
    }
    const sections: string[] = [];
    let currentRole: string | null = null;
    let lines: string[] = [];
    for (const p of payload.prompts) {
      if (p.role !== currentRole) {
        if (currentRole !== null) sections.push(`${currentRole}:\n${lines.join("\n")}`);
        currentRole = p.role;
        lines = [];
      }
      lines.push(`${p.position}. ${p.text}`);
    }
    if (currentRole !== null) sections.push(`${currentRole}:\n${lines.join("\n")}`);
    say(sections.join("\n"));
    return;
  }
  if (parsed.mode === "cancel") {
    if (role === null) {
      // No --role: the position addresses what --list shows — its per-loop sections, each
      // numbered from 1 (the director first, then the roles in catalog order). Resolve across
      // that scope: one loop holding the position cancels there, several are ambiguous (the
      // list itself shows two "N." lines), none is a miss. The output names the loop, since
      // the caller scoped nothing.
      const scope = [DIRECTOR_ROLE, ...knownRoleIdsCached(root).filter((r) => r !== DIRECTOR_ROLE)];
      const listed: ListedCancelOutcome = cancelListedPrompt(root, scope, parsed.position);
      if (listed.status === "ambiguous") {
        fail(`position ${parsed.position} is queued for more than one loop (${listed.roles.join(", ")}) — name one with --role <id>`);
      }
      if (listed.status === "missing") {
        fail(`no prompt at position ${parsed.position} (${listed.queued} queued across all loops)`);
      }
      sayCancelOutcome(parsed.position, listed.role, listed.outcome, true);
      return;
    }
    const target = role ?? DIRECTOR_ROLE;
    let outcome: CancelOutcome;
    try {
      outcome = cancelRolePrompt(root, target, parsed.position);
    } catch (err) {
      fail(errorMessage(err));
    }
    sayCancelOutcome(parsed.position, target, outcome, false);
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
