/** The read-only query commands' bodies (status, diff, backlog, role), split out of
 * cli.ts's dispatcher: main() routes to a cmd* here exactly as it routes to operator-commands's
 * cmdAbort or config-commands's cmdConfig, and cli.ts keeps only routing and the help/version
 * surfaces. Each command owns its argument gate, ready-repo gating decision, and output shape,
 * with the wording and gating order moved verbatim from main()'s cases. */

import { fail, say, sayJson, sayJsonOrRender } from "./cli-output.js";
import { startParentDeathWatch } from "../process/supervisor.js";
import { flagValue, parseGrepFlag, parseRoleListScope, rejectRepeatFlag } from "./cli-args.js";
import { DIFF_PATH_FLAG, FOLLOW_FLAG, JSON_FLAG, READY_FLAG, grepFlagSpec, rejectUnknownArgs, OVERLAPS_FLAG, ROLE_FLAG, STAT_FLAG } from "./cli-flag-specs.js";
import { refuseTeamWorkspace, requireReadyRepo } from "./cli-repo-gate.js";
import { defaultConfig, knownRoleIds, loadConfigSafe } from "../config/config.js";
import { scopeSnapshotToRoles, snapshot } from "../status/status-data.js";
import { statusPayload } from "../ui/status-payload.js";
import { renderStatus } from "../ui/status-render.js";
import { backlogPayload } from "../backlog/backlog.js";
import { backlogHolds, backlogInProgress } from "../backlog/backlog-eligibility.js";
import { readyBacklog, grepBacklog, renderBacklogMarkdown } from "../backlog/backlog-render.js";
import { collectChangeOverlaps, scopeChangeOverlaps, scopeChangeOverlapsToPath, collectTeamChanges, collectRoleChange, collectRoleChanges, normalizeDiffPath } from "../change/change-data.js";
import { renderChangeOverlaps, renderTeamChange, renderRoleChange, renderRoleChanges } from "../change/change-render.js";
import { readMergeQueue, type MergeQueueView } from "../merge/merge-queue.js";
import { renderMergeQueue, scopeMergeQueue } from "../merge/merge-queue-render.js";
import type { MergeInFlight } from "../merge/merge-slot.js";
import { orchestratorAlive } from "../team/orchestrator-info.js";
import { queueInFlight } from "../status/status-polls.js";
import { rolePayload } from "../roles/role-view.js";
import { renderRoleMarkdown } from "../roles/role-render.js";
import { DIRECTOR_ROLE, unknownRoleMessage } from "../roles/roles.js";
import { saveRoleNote } from "../agent/role-notes-write.js";
import { roleNotesPath } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { readPromptFileArg } from "./cli-command-args.js";
import { canonicalRoleId } from "../roles/legacy-role-ids.js";
import { INSTANCE_ROLES, baseRoleOf, roleInScope } from "../roles/runner-ids.js";
import { setConfigKey, unsetConfigKey } from "../config/config-write.js";

/** `role`'s notes-write flags: clear the note, or replace it from a file (`-` for stdin). */
const CLEAR_NOTES_SPEC = { names: ["--clear-notes"] };
const NOTES_FILE_SPEC = { names: ["--notes-file"], value: true, valueName: "<path>" };

/** `role`'s instructions-override flags: clear it, or replace it from a file (`-` for stdin). */
const CLEAR_INSTRUCTIONS_SPEC = { names: ["--clear-instructions"] };
const INSTRUCTIONS_FILE_SPEC = { names: ["--instructions-file"], value: true, valueName: "<path>" };

/** `role`'s quiet-hours write flags: clear the window, or set it to a daily local-time window. */
const CLEAR_QUIET_HOURS_SPEC = { names: ["--clear-quiet-hours"] };
const QUIET_HOURS_SPEC = { names: ["--quiet-hours"], value: true, valueName: "<window>" };

/** `role`'s daily-cap write flags: clear the cap, or set it to a USD amount (0 disables). */
const CLEAR_CAP_SPEC = { names: ["--clear-cap"] };
const CAP_SPEC = { names: ["--cap"], value: true, valueName: "<usd>" };

/** `role`'s min-run-interval write flags: clear it, or set it to a second count (0 is
 * back-to-back). */
const CLEAR_MIN_RUN_INTERVAL_SPEC = { names: ["--clear-min-run-interval"] };
const MIN_RUN_INTERVAL_SPEC = { names: ["--min-run-interval"], value: true, valueName: "<seconds>" };

/** `role`'s instances write flags: clear the count, or set it to a parallel-runner count
 * (an integer from 1 to 8; only feature and bugfix split). */
const CLEAR_INSTANCES_SPEC = { names: ["--clear-instances"] };
const INSTANCES_SPEC = { names: ["--instances"], value: true, valueName: "<n>" };

/** `role`'s enabled-state write flags: enable or disable the role, written to
 * roles.<base>.enabled. */
const ENABLE_SPEC = { names: ["--enable"] };
const DISABLE_SPEC = { names: ["--disable"] };

/** `role`'s model-triple write flags: clear the field, or set it, written to
 * roles.<base>.provider/.model/.thinking. model and provider take an id; thinking takes a
 * pi `--thinking` level (off|minimal|low|medium|high|xhigh|max). */
const CLEAR_PROVIDER_SPEC = { names: ["--clear-provider"] };
const PROVIDER_SPEC = { names: ["--provider"], value: true, valueName: "<id>" };
const CLEAR_MODEL_SPEC = { names: ["--clear-model"] };
const MODEL_SPEC = { names: ["--model"], value: true, valueName: "<id>" };
const CLEAR_THINKING_SPEC = { names: ["--clear-thinking"] };
const THINKING_SPEC = { names: ["--thinking"], value: true, valueName: "<level>" };

/** Peel `tumwater role <id>`'s positional id off the argument list: the first token that is
 * neither a flag nor the value of a --role, --notes-file, --instructions-file,
 * --quiet-hours, --cap, --min-run-interval, --instances, --provider, --model or
 * --thinking flag. Returns the id (null when absent) and the remaining arguments — flags
 * only, ready for rejectUnknownArgs and sayJsonOrRender. The id may also arrive as
 * --role <id>, the flag spelling every other role-targeting command shares; the
 * collector's caller rejects both spellings at once rather than silently picking one.
 * Lives here because it exists only for this one
 * command's mixed positional/flag vocabulary. */
function peelRolePositional(args: string[]): { id: string | null; rest: string[] } {
  const valueIdx = new Set<number>();
  for (const flag of ["--role", "--notes-file", "--instructions-file", "--quiet-hours", "--cap", "--min-run-interval", "--instances", "--provider", "--model", "--thinking"]) {
    const at = args.indexOf(flag);
    if (at >= 0) valueIdx.add(at + 1);
  }
  let id: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""; // Unreachable fallback: the loop bound guarantees a token here.
    // A non-flag token that is not a value-taking flag's value is the positional,
    // taken once; everything else — flags and their values alike — rides in rest for
    // rejectUnknownArgs and flagValue to claim.
    if (!arg.startsWith("-") && id === null && !valueIdx.has(i)) {
      id = arg;
      continue;
    }
    rest.push(arg);
  }
  return { id, rest };
}

/** `tumwater status [-f/--follow]`: the team snapshot as rendered text or as the JSON
 * document GET /api/status serves. `-f/--follow` repaints the table every couple of seconds
 * until Ctrl+C or the process that started it exits, so a backgrounded follow does not
 * outlive its parent. */
export async function cmdStatus(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  rejectUnknownArgs("status", args, [ROLE_FLAG, JSON_FLAG, FOLLOW_FLAG]);
  const follow = args.includes("-f") || args.includes("--follow");
  if (follow && args.includes("--json")) fail("status --json prints one document; -f/--follow repaints a live view — drop one of them");
  await requireReadyRepo(root);
  const scope = parseRoleListScope(root, args);
  if (follow) {
    await followStatus(root, scope, seams);
    return;
  }
  if (args.includes("--json")) {
    // Machine-readable team state — the document GET /api/status serves minus the
    // serving process's own `serverBuildSha`, printed with no server. A query, not a
    // health verdict: exit 0 on any successful read and let scripts interpret fields
    // themselves ("running": false is data, not failure).
    sayJson(statusPayload(root, Date.now(), scope));
  } else {
    const snap = snapshot(root);
    say(renderStatus(root, scope ? scopeSnapshotToRoles(snap, scope) : snap, process.stdout.isTTY ? process.stdout.columns : undefined, scope !== null));
  }
}

/** The default repaint interval for a follow view — a fixed cadence, no knob. */
const FOLLOW_VIEW_INTERVAL_MS = 2000;

/** Test seams for a follow view's repaint interval and parent-death watch, so a test can
 * drive the repaint and its end without waiting on real seconds or a real TTY. */
interface FollowViewSeams {
  ppid?: () => number;
  intervalMs?: number;
  tty?: boolean;
}

/** A follow view's live loop: render once, then repaint on an interval until Ctrl+C or the
 * process that started this one is gone (the same parent-death rule `logs -f` uses).
 * Repaints in place with the `watch` clear-screen shape on a TTY, and prints frames
 * separated by a blank line when stdout is not a TTY so a piped follow stays readable. */
async function followView(frameText: () => string, seams: FollowViewSeams): Promise<void> {
  const tty = seams.tty ?? process.stdout.isTTY;
  const interval = seams.intervalMs ?? FOLLOW_VIEW_INTERVAL_MS;
  const frame = (): void => {
    process.stdout.write(tty ? "\x1b[H\x1b[2J" + frameText() + "\n" : frameText() + "\n\n");
  };
  frame();
  await new Promise<void>((resolve) => {
    const timer = setInterval(frame, interval);
    startParentDeathWatch(() => {
      clearInterval(timer);
      resolve();
    }, {
      ...(seams.ppid ? { ppid: seams.ppid } : {}),
      ...(seams.intervalMs !== undefined ? { intervalMs: seams.intervalMs } : {}),
    });
  });
}

/** `tumwater status -f`'s live loop: the team snapshot repainted until the parent exits. */
async function followStatus(root: string, scope: string[] | null, seams: FollowViewSeams): Promise<void> {
  const tty = seams.tty ?? process.stdout.isTTY;
  await followView(() => renderStatus(root, scope ? scopeSnapshotToRoles(snapshot(root), scope) : snapshot(root), tty ? process.stdout.columns : undefined, scope !== null), seams);
}

/** `tumwater diff`: one line per role holding pending work, the files two or more roles touch
 * with `--overlaps` (`--role` keeps those a listed role holds, `--path` those at or under it),
 * or the full per-role view of each role listed with `--role <id>[,<id>...]`. */
export async function cmdDiff(root: string, args: string[]): Promise<void> {
  // The repo half of requireReadyRepo still gates: a directory tumwater cannot read yet
  // (no git, not a repository, no tumwater.json, no commits) has no team to ask about,
  // and the change view's own degradation would misreport that as "main branch <name>
  // does not exist" — so the shared readiness wording answers here, like every sibling
  // command. Past the gate an absent worktree still degrades to a `no worktree for
  // <role>` line (exit 0), so the command answers in any initialized directory —
  // report's rationale.
  rejectUnknownArgs("diff", args, [ROLE_FLAG, JSON_FLAG, STAT_FLAG, OVERLAPS_FLAG, DIFF_PATH_FLAG]);
  await requireReadyRepo(root);
  rejectRepeatFlag(args.filter((a) => a === "--path").length > 1, "--path");
  if (args.includes("--overlaps")) {
    if (args.includes("--stat")) fail("diff --overlaps prints paths, not patches; drop --stat");
    // Overlaps are computed across every role; --role only filters which entries print.
    const scope = parseRoleListScope(root, args);
    const path = diffPathArg(args);
    let view = await collectChangeOverlaps(root);
    if (scope === null && path === undefined) {
      sayJsonOrRender(args, view, renderChangeOverlaps);
      return;
    }
    if (scope !== null) view = scopeChangeOverlaps(view, scope);
    if (path !== undefined) view = scopeChangeOverlapsToPath(view, path);
    sayJsonOrRender(args, view, (v) => renderChangeOverlaps(v, scope ?? undefined, path));
    return;
  }
  // Absent --role is the team-wide form: one line per role holding pending work
  // (parseRoleListScope returns null only for an absent flag — an empty or unknown piece
  // already failed above). One named role keeps the single per-role view; a list prints each
  // listed role's view in order.
  const roles = parseRoleListScope(root, args);
  const path = roles === null ? undefined : diffPathArg(args);
  if (roles === null) {
    if (args.includes("--stat")) fail("diff --stat needs --role <id> (the team roster prints no patch)");
    if (args.includes("--path")) fail("diff --path needs --role <id> (the team roster prints no patch)");
    sayJsonOrRender(args, await collectTeamChanges(root), renderTeamChange);
  } else if (roles.length === 1) {
    const change = await collectRoleChange(root, roles[0]!, { stat: args.includes("--stat"), path });
    sayJsonOrRender(args, change, renderRoleChange);
  } else {
    sayJsonOrRender(args, await collectRoleChanges(root, roles, { stat: args.includes("--stat"), path }), renderRoleChanges);
  }
}

/** The normalised `--path` value of `diff --role` (undefined when absent): leading `./` pieces
 * and trailing `/` characters stripped, failing on an empty, absolute or `..`-bearing result. */
function diffPathArg(args: string[]): string | undefined {
  const raw = flagValue(args, "--path");
  if (raw === null || raw === undefined) return undefined;
  const norm = normalizeDiffPath(raw);
  if (norm === null) fail("diff --path takes a repo-relative path such as src/cli.ts (as diff --overlaps prints it)");
  return norm;
}

/** `tumwater queue [-f/--follow]`: the durable merge queue in execution order, as text or as
 * the `{entries, unreadable}` document. `-f/--follow` repaints the queue every couple of
 * seconds until Ctrl+C or the process that started it exits, so a backgrounded follow does
 * not outlive its parent (the same rule `status -f` uses). */
export async function cmdQueue(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  // The repo half of requireReadyRepo gates: like every repo-bound query, a directory
  // tumwater cannot read yet has no queue to show. Past the gate an absent queue dir reads
  // as an empty queue (a `merge queue empty` line, exit 0), so no merge ever queued is
  // data, not an error.
  rejectUnknownArgs("queue", args, [ROLE_FLAG, JSON_FLAG, FOLLOW_FLAG]);
  await requireReadyRepo(root);
  const roles = parseRoleListScope(root, args);
  const follow = args.includes("-f") || args.includes("--follow");
  if (follow && args.includes("--json")) fail("queue --json prints one document; -f/--follow repaints a live view — drop one of them");
  // Scoped read shared by the follow and the one-shot branches, so the render's age and the
  // in-flight marker share one clock read and each frame re-reads the queue. --role keeps
  // the listed roles' entries (a base id taking its instances too) under their whole-queue
  // positions; the in-flight marker is judged against the kept entries only, and
  // `unreadable` stays whole because an unreadable file has no role to attribute it to.
  const readQueue = (): { view: MergeQueueView; inFlight: MergeInFlight | undefined; scope: ReturnType<typeof scopeMergeQueue>["scope"] | undefined } => {
    const whole = readMergeQueue(root);
    const scoped = roles ? scopeMergeQueue(whole, roles, (r) => roleInScope(r, roles)) : undefined;
    const view = scoped ? scoped.view : whole;
    return { view, inFlight: queueInFlight(root, view.entries, orchestratorAlive(root)), scope: scoped?.scope };
  };
  if (follow) {
    await followView(() => {
      const { view, inFlight, scope } = readQueue();
      return renderMergeQueue(view, Date.now(), inFlight, scope);
    }, seams);
    return;
  }
  const { view, inFlight, scope } = readQueue();
  sayJsonOrRender(args, inFlight ? { ...view, inFlight } : view, () => renderMergeQueue(view, Date.now(), inFlight, scope));
}

/** `tumwater backlog`: the planned/open entries as Markdown or as the GUI's JSON payload. */
export async function cmdBacklog(root: string, args: string[], seams: FollowViewSeams = {}): Promise<void> {
  // No requireReadyRepo gate: the entry readers degrade to [] on a missing file, so the
  // command prints three empty sections in any directory (report's rationale, not config's);
  // the team-workspace refusal still applies.
  // --grep filters the three entry arrays to the matches, the finished-entry lists' one
  // matcher (entryMatches) on the active backlog; it composes with --ready (grep first, so
  // the hidden count and the kept entries count only the matches) and with --json. The
  // missing-value wording lives in BACKLOG_GREP_VALUE_ERROR, the flag gate's and this
  // parser's shared string. -f/--follow repaints the same view every couple of seconds
  // until Ctrl+C or the parent process exits, composing with --ready and --grep; it refuses
  // --json (a live view is one repainted document, not one snapshot).
  const BACKLOG_GREP_VALUE_ERROR = "backlog --grep needs text (usage: tumwater backlog --grep <text>)";
  rejectUnknownArgs("backlog", args, [JSON_FLAG, READY_FLAG, grepFlagSpec(BACKLOG_GREP_VALUE_ERROR), FOLLOW_FLAG]);
  refuseTeamWorkspace(root);
  const { rest, pattern } = parseGrepFlag(args, BACKLOG_GREP_VALUE_ERROR);
  const ready = rest.includes("--ready");
  const follow = rest.includes("-f") || rest.includes("--follow");
  if (follow && rest.includes("--json")) fail("backlog --json prints one document; -f/--follow repaints a live view — drop one of them");
  // Machine-readable backlog — the three entry arrays the Markdown view renders and the
  // GUI's /api/backlog serves (status --json's "print the endpoint's payload" pattern),
  // plus `holds.plans`/`holds.bugs` parallel to the entry arrays so a skipped entry's
  // reason is data, not inference: a pretty-printed JSON document in every exit-0 case,
  // never prose. The payload is read once per branch (snapshot or frame) so the Markdown
  // renderer and the JSON document consume the same arrays.
  // --ready filters both branches through readyBacklog; the Markdown branch adds a count of
  // the held entries it hid. The --json/--ready reads go over `rest` (the --grep value token
  // removed), so a flag-shaped pattern like `--grep --json` greps for "--json" rather than
  // flipping this branch into JSON mode.
  const readBacklog = (): { view: ReturnType<typeof backlogPayload>; hidden: number } => {
    const view = { ...backlogPayload(root), holds: backlogHolds(root), inProgress: backlogInProgress(root) };
    const filtered = pattern === null ? view : grepBacklog(view, pattern);
    if (!ready) return { view: filtered, hidden: 0 };
    const kept = readyBacklog(filtered);
    return { view: kept, hidden: filtered.plans.length + filtered.bugs.length - kept.plans.length - kept.bugs.length };
  };
  const renderBacklogText = (r: { view: ReturnType<typeof backlogPayload>; hidden: number }): string =>
    renderBacklogMarkdown(r.view) + (r.hidden > 0
      ? `\n\n_(${r.hidden} held entries hidden; run \`tumwater backlog\` to see them)_` : "");
  if (follow) {
    await followView(() => renderBacklogText(readBacklog()), seams);
    return;
  }
  const result = readBacklog();
  sayJsonOrRender(rest, result.view, () => renderBacklogText(result));
}

/** Refuse an unknown role id with the shared unknownRoleMessage wording before a per-role
 * config write resolves the id. Every `tumwater role` write branch starts with the same
 * prelude — load the config (falling back to defaultConfig so built-in roles resolve) and
 * throw the unknown-role error unless the id appears — so this keeps that check in one place.
 * The caller then derives `baseRoleOf(id)` for the write key. */
function requireKnownRole(root: string, id: string): void {
  const cfg = loadConfigSafe(root).config ?? defaultConfig();
  if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
}

/** The config-key write the six per-role hold branches (quiet hours, daily cap, min run
 * interval, provider, model and thinking) share: with `clear`, or an empty typed value, unset
 * `key` under `base`; else set it. `serialize` shapes the value `setConfigKey` stores (it
 * JSON-encodes nothing itself) and `display` gives the human phrase for the confirmation
 * line. The caller returns right after. The instructions branch keeps its own block: its
 * value is a file's text, so an empty value is a legitimate write, not a clear. A no-op (a
 * value the key already resolves to, or a clear of a key the file never held) reports itself
 * and writes nothing. */
function writeRoleConfigKey(
  root: string,
  base: string,
  clear: boolean,
  raw: string,
  key: string,
  noun: string,
  serialize: (value: string) => string,
  display: (value: string) => string,
): void {
  if (clear || raw.trim() === "") {
    const result = unsetConfigKey(root, key);
    if (!result.ok) fail(result.error);
    say(
      result.oldValue === undefined
        ? `${base}: ${noun} is not set in tumwater.json, so nothing was cleared`
        : `${base}: ${noun} cleared`,
    );
  } else {
    const result = setConfigKey(root, key, serialize(raw));
    if (!result.ok) fail(result.error);
    say(
      result.unchanged
        ? `${base}: ${noun} is already ${display(raw)}, so tumwater.json was not written`
        : `${base}: ${noun} set to ${display(raw)}`,
    );
  }
}

/** `tumwater role <id>`: one role's standing prompt and next run's assembled prompt. */
export async function cmdRole(root: string, args: string[]): Promise<void> {
  // No requireReadyRepo gate, like backlog: role-view degrades (missing state files →
  // fresh defaults, a missing queue directory an empty inbox), so the command inspects
  // a repo the team never started in — and a torn one — instead of refusing (a team
  // workspace still refuses).
  const { id: positional, rest } = peelRolePositional(args);
  rejectUnknownArgs("role", rest, [ROLE_FLAG, JSON_FLAG, CLEAR_NOTES_SPEC, NOTES_FILE_SPEC, CLEAR_INSTRUCTIONS_SPEC, INSTRUCTIONS_FILE_SPEC, CLEAR_QUIET_HOURS_SPEC, QUIET_HOURS_SPEC, ENABLE_SPEC, DISABLE_SPEC, CLEAR_CAP_SPEC, CAP_SPEC, CLEAR_MIN_RUN_INTERVAL_SPEC, MIN_RUN_INTERVAL_SPEC, CLEAR_INSTANCES_SPEC, INSTANCES_SPEC, CLEAR_PROVIDER_SPEC, PROVIDER_SPEC, CLEAR_MODEL_SPEC, MODEL_SPEC, CLEAR_THINKING_SPEC, THINKING_SPEC]);
  refuseTeamWorkspace(root);
  // The id is required: positional (`tumwater role <id>`) or --role <id> (the flag
  // spelling every other role-targeting command shares). Both at once is a mistake, not
  // a silent pick of one.
  const flagId = flagValue(rest, "--role") ?? null;
  const typedId = positional ?? flagId;
  if (!typedId) fail("tumwater role needs a role id");
  const id = canonicalRoleId(typedId);
  if (positional !== null && flagId !== null && flagId !== positional)
    fail("give the role id once — as the positional or as --role <id>, not both");
  const clear = rest.includes("--clear-notes");
  const notesFile = flagValue(rest, "--notes-file");
  const clearInst = rest.includes("--clear-instructions");
  const instFile = flagValue(rest, "--instructions-file");
  const clearQuiet = rest.includes("--clear-quiet-hours");
  const clearCap = rest.includes("--clear-cap");
  const clearInterval = rest.includes("--clear-min-run-interval");
  const clearInstances = rest.includes("--clear-instances");
  const clearProvider = rest.includes("--clear-provider");
  const clearModel = rest.includes("--clear-model");
  const clearThinking = rest.includes("--clear-thinking");
  const notesWrite = clear || rest.includes("--notes-file");
  const instructionsWrite = clearInst || rest.includes("--instructions-file");
  const quietWrite = clearQuiet || rest.includes("--quiet-hours");
  const capWrite = clearCap || rest.includes("--cap");
  const intervalWrite = clearInterval || rest.includes("--min-run-interval");
  const instancesWrite = clearInstances || rest.includes("--instances");
  const providerWrite = clearProvider || rest.includes("--provider");
  const modelWrite = clearModel || rest.includes("--model");
  const thinkingWrite = clearThinking || rest.includes("--thinking");
  const enable = rest.includes("--enable");
  const disable = rest.includes("--disable");
  const writes: string[] = [];
  if (notesWrite) writes.push("notes");
  if (instructionsWrite) writes.push("instructions");
  if (quietWrite) writes.push("quiet-hours");
  if (instancesWrite) writes.push("instances");
  if (capWrite) writes.push("cap");
  if (intervalWrite) writes.push("min-run-interval");
  if (providerWrite) writes.push("provider");
  if (modelWrite) writes.push("model");
  if (thinkingWrite) writes.push("thinking");
  if (enable) writes.push("enable");
  if (disable) writes.push("disable");
  if (writes.length > 1)
    fail(`${writes.join(" and ")} writes cannot share one invocation`);
  if (notesWrite) {
    if (clear && rest.includes("--notes-file")) fail("give --clear-notes or --notes-file, not both");
    if (rest.includes("--json")) fail("--json does not apply to a notes write");
    if (id === DIRECTOR_ROLE) fail("the director has no notes");
    requireKnownRole(root, id);
    const text = clear ? "" : readPromptFileArg(notesFile || fail("--notes-file needs a path"));
    try {
      say(`${id}: ${saveRoleNote(roleNotesPath(root, id), text)}`);
    } catch (err) {
      fail(errorMessage(err));
    }
    return;
  }
  // The instructions-override write: the file-shaped twin of the notes flags, but the value
  // lands in roles.<base>.instructions (run-prompt reads config.roles[base]) through the
  // same setConfigKey/unsetConfigKey core `config set`/`config unset` use, so validateConfig
  // enforces the 4096-char cap and the write is atomic. The director is allowed here (its
  // override reaches its own runs), unlike the notes branch's director refusal.
  if (instructionsWrite) {
    if (clearInst && rest.includes("--instructions-file")) fail("give --clear-instructions or --instructions-file, not both");
    if (rest.includes("--json")) fail("--json does not apply to an instructions write");
    requireKnownRole(root, id);
    const base = baseRoleOf(id);
    if (clearInst) {
      const result = unsetConfigKey(root, `roles.${base}.instructions`);
      if (!result.ok) fail(result.error);
      say(`${base}: instructions cleared`);
    } else {
      const text = readPromptFileArg(instFile || fail("--instructions-file needs a path"));
      const result = setConfigKey(root, `roles.${base}.instructions`, JSON.stringify(text));
      if (!result.ok) fail(result.error);
      say(`${base}: instructions saved (${text.length} chars)`);
    }
    return;
  }
  // The quiet-hours write: the third write kind, the terminal twin of `config set
  // quietHoursPerRole.<base> <window>`. The window lands in quietHoursPerRole.<base> through
  // the same setConfigKey/unsetConfigKey core config set/unset use, so checkQuietHours (with
  // the typed key as its label) and validateConfig own validation and the write is atomic.
  // The director is exempt — its quietHoursPerRole.director entry is inert (the gate and
  // doctor both exempt it), like the notes branch's director refusal.
  if (quietWrite) {
    if (clearQuiet && rest.includes("--quiet-hours")) fail("give --clear-quiet-hours or --quiet-hours, not both");
    if (rest.includes("--json")) fail("--json does not apply to a quiet-hours write");
    requireKnownRole(root, id);
    if (id === DIRECTOR_ROLE) fail("the director has no quiet hours");
    const base = baseRoleOf(id);
    const window = flagValue(rest, "--quiet-hours") ?? "";
    writeRoleConfigKey(root, base, clearQuiet, window, `quietHoursPerRole.${base}`, "quiet hours", (v) => JSON.stringify(v), (v) => v);
    return;
  }
  // The daily-cap write: the terminal twin of `config set maxDailyCostUsdPerRole.<base>
  // <usd>`, the two remaining per-role holds' write the dashboard and the TUI already own.
  // The value lands in maxDailyCostUsdPerRole.<base> through the same
  // setConfigKey/unsetConfigKey core `config set`/`config unset` use, so checkDailyBudgetUsd
  // (with the typed key as its label) and validateConfig own validation and the write is
  // atomic. The director is exempt — it has no cap, like the notes and quiet-hours branches'
  // director refusals.
  if (capWrite) {
    if (clearCap && rest.includes("--cap")) fail("give --clear-cap or --cap, not both");
    if (rest.includes("--json")) fail("--json does not apply to a cap write");
    requireKnownRole(root, id);
    if (id === DIRECTOR_ROLE) fail("the director has no daily cap");
    const base = baseRoleOf(id);
    const cap = flagValue(rest, "--cap") ?? "";
    writeRoleConfigKey(root, base, clearCap, cap, `maxDailyCostUsdPerRole.${base}`, "daily cap", (v) => v, (v) => v);
    return;
  }
  // The min-run-interval write: the terminal twin of `config set
  // roles.<base>.minRunIntervalSeconds <seconds>`, the fourth per-role hold's write. The
  // value lands in roles.<base>.minRunIntervalSeconds through the same
  // setConfigKey/unsetConfigKey core `config set`/`config unset` use, so validateConfig's
  // roles.<id>.minRunIntervalSeconds DURATION_NON_NEGATIVE check owns validation and the
  // write is atomic. Unlike the notes/quiet-hours/cap branches there is no director refusal:
  // the director runs on the same clock.
  if (intervalWrite) {
    if (clearInterval && rest.includes("--min-run-interval")) fail("give --clear-min-run-interval or --min-run-interval, not both");
    if (rest.includes("--json")) fail("--json does not apply to a min-run-interval write");
    requireKnownRole(root, id);
    const base = baseRoleOf(id);
    const secs = flagValue(rest, "--min-run-interval") ?? "";
    writeRoleConfigKey(root, base, clearInterval, secs, `roles.${base}.minRunIntervalSeconds`, "min run interval", (v) => v, (v) => `${v}s`);
    return;
  }
  // The instances write: the terminal twin of `config set roles.<base>.instances <n>`, the
  // last per-role hold's write. The count lands in roles.<base>.instances through the same
  // setConfigKey/unsetConfigKey core `config set`/`config unset` use, so validateConfig's
  // roles.<id>.instances INSTANCE_COUNT check owns the bound and the write is atomic. As
  // with min run interval there is no director (or non-instance-role) refusal of its own:
  // validateConfig's `!INSTANCE_ROLES.has(id)` branch answers for the director and every
  // custom role, and an unset/empty value clears the key.
  if (instancesWrite) {
    if (clearInstances && rest.includes("--instances")) fail("give --clear-instances or --instances, not both");
    if (rest.includes("--json")) fail("--json does not apply to an instances write");
    const loaded = loadConfigSafe(root);
    const cfg = loaded.config ?? defaultConfig();
    if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
    const base = baseRoleOf(id);
    const n = flagValue(rest, "--instances") ?? "";
    // An absent count already means 1 (instanceCount's default), so asking for 1 is a no-op —
    // but only for a role that may split; any other role falls through to validateConfig's refusal.
    // A tumwater.json that fails to load is no basis for "already": fall through to the failure.
    if (loaded.config && !clearInstances && n.trim() === "1" && INSTANCE_ROLES.has(base) && cfg.roles[base]?.instances === undefined) {
      say(`${base}: instances is already 1, so tumwater.json was not written`);
      return;
    }
    writeRoleConfigKey(root, base, clearInstances, n, `roles.${base}.instances`, "instances", (v) => v, (v) => v);
    return;
  }
  // The model-triple writes: the terminal twins of `config set roles.<base>.provider|model|thinking
  // <value>` and `config unset` — the three fields configForRole resolves through seamOverrides.
  // `tumwater role <id>` renders them as its Model: line. Each lands in roles.<base>.<field>.
  // Through setConfigKey/unsetConfigKey, validateConfig's checkModelTripleField ("tier-name"
  // shape) owns validation (model accepts a tier name; thinking must be a THINKING_LEVELS level)
  // and each write is atomic. No director refusal: accepted exactly as --min-run-interval is.
  if (providerWrite) {
    if (clearProvider && rest.includes("--provider")) fail("give --clear-provider or --provider, not both");
    if (rest.includes("--json")) fail("--json does not apply to a provider write");
    const cfg = loadConfigSafe(root).config ?? defaultConfig();
    if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
    const base = baseRoleOf(id);
    const provider = flagValue(rest, "--provider") ?? "";
    writeRoleConfigKey(root, base, clearProvider, provider, `roles.${base}.provider`, "provider", (v) => JSON.stringify(v), (v) => v);
    return;
  }
  if (modelWrite) {
    if (clearModel && rest.includes("--model")) fail("give --clear-model or --model, not both");
    if (rest.includes("--json")) fail("--json does not apply to a model write");
    const cfg = loadConfigSafe(root).config ?? defaultConfig();
    if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
    const base = baseRoleOf(id);
    const model = flagValue(rest, "--model") ?? "";
    writeRoleConfigKey(root, base, clearModel, model, `roles.${base}.model`, "model", (v) => JSON.stringify(v), (v) => v);
    return;
  }
  if (thinkingWrite) {
    if (clearThinking && rest.includes("--thinking")) fail("give --clear-thinking or --thinking, not both");
    if (rest.includes("--json")) fail("--json does not apply to a thinking write");
    const cfg = loadConfigSafe(root).config ?? defaultConfig();
    if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
    const base = baseRoleOf(id);
    const level = flagValue(rest, "--thinking") ?? "";
    writeRoleConfigKey(root, base, clearThinking, level, `roles.${base}.thinking`, "thinking", (v) => JSON.stringify(v), (v) => v);
    return;
  }
  // The enable/disable write: the scoped write for the enabled state `tumwater role <id>`
  // already renders, the terminal twin of `config set roles.<base>.enabled true|false`. The
  // value lands in roles.<base>.enabled through the same setConfigKey core config set uses, so
  // validateConfig's checkBoolean (the roles.<id>. prefix) owns the type and the write stays
  // atomic and applies live. The director cannot be disabled: with it disabled runnerIds omits
  // it and no role dequeues the operator's inbox, so that refusal is explicit (enabling stays
  // allowed). knownRoleIds holds every catalog and custom role whether or not it is enabled, so
  // a currently-disabled id resolves; an instance id writes its base role's key. A role already
  // in the asked-for state is reported as such and the file is left alone.
  if (enable || disable) {
    if (rest.includes("--json")) fail("--json does not apply to an enable/disable write");
    requireKnownRole(root, id);
    if (disable && id === DIRECTOR_ROLE) fail("the director cannot be disabled");
    const base = baseRoleOf(id);
    const state = enable ? "enabled" : "disabled";
    if (loadConfigSafe(root).config?.roles[base]?.enabled === enable) {
      say(`${base}: already ${state}`);
      return;
    }
    const result = setConfigKey(root, `roles.${base}.enabled`, enable ? "true" : "false");
    if (!result.ok) fail(result.error);
    say(`${base}: ${state}`);
    return;
  }
  // The unknown-role answer (exit 1, unknownRoleMessage's wording) lives in the
  // collector; here the id just has to be non-null for the thunk's types.
  sayJsonOrRender(rest, () => rolePayload(root, id), renderRoleMarkdown);
}
