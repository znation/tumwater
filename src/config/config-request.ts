/** The role's staged config-write request — one verb split out of config-write.ts (the
 * operator-editor mutators stay there, addressed by key through config-keys.ts). The director
 * (and, for a declared project check, the feature role) stages a JSON request file in its
 * worktree; this module consumes it: parse the request, keep only its `customRoles` array and
 * a declared `check.command`, apply it as a whole-config write, and delete the file on every
 * path. A request is shaped and lives differently from the interactive `config set` /
 * `unset` verbs (a staged file that must never reach a diff, not direct CLI text), so the
 * runtime (run-verdict.ts) imports this module rather than the whole editor. It
 * still shares the write machinery with the editor — withConfigLock and rawConfigObject from
 * config-write-core.ts (the editor verbs live in config-write.ts), validateConfig from
 * config-validation.ts, writeJsonAtomic from json-files.js — because a request is a
 * whole-config write too. */
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CheckConfigSlice, TumwaterConfig } from "./config-schema.js";
import { configPath, configRequestPath } from "../paths.js";
import { errorMessage, isNonBlankString } from "../text/text.js";
import { readTextOrNull } from "../files/files.js";
import { writeJsonAtomic } from "../files/json-files.js";
import { isJsonObject } from "../files/json-object.js";
import { withConfigLock, rawConfigObject } from "./config-write-core.js";
import { show } from "./config-field-checks.js";
import { validateConfig } from "./config-validation.js";
import { normalizeConfigKeys } from "./config-aliases.js";
import { collapseBackendAliases, loadConfig } from "./config.js";
import {
  BUILD_CHECK_TIMEOUT_MS,
  gateCommandOf,
  type BuildCheck,
} from "../build/build-check-detect.js";
import { type BuildCheckOutcome, runBuildCheck } from "../build/build-check.js";
import { CHECK_TIER, withCheckPermit } from "../concurrency/check-permit.js";

/** The guard that verifies a declared `check.command` before it is written (part 1/2): given
 * the worktree and a candidate command check, returns the outcome runBuildCheck would
 * produce there. Defaulting to the real runner keeps the guard fail-closed by default; tests
 * inject a fake to exercise the pass/fail branches without spawning a process. */
type CheckGuard = (
  wt: string,
  check: BuildCheck,
  config: CheckConfigSlice | undefined,
) => Promise<BuildCheckOutcome>;

async function defaultCheckGuard(
  wt: string,
  check: BuildCheck,
  config: CheckConfigSlice | undefined,
): Promise<BuildCheckOutcome> {
  // Take the same process-wide check permit every full-suite runner takes (runScopedBuildCheck's
  // gate/merge/batch scopes and checkMainBaseline), so a declaration burst cannot stack suites
  // on the host beside the authors' own runs. runBuildCheck's own arguments stand: the same
  // install-first step and upward PATH resolution the gate's run uses; the candidate BuildCheck
  // carries the config-resolved timeout, so checkTimeoutMs enforces it here exactly as the
  // pre-check would.
  return withCheckPermit(config, CHECK_TIER.other, () => runBuildCheck(wt, check));
}

/** The candidates the guard verifies before a declared `check.command` is written: the
 * declared command itself (the feature's fail-closed guarantee — a request whose own command
 * fails must not be written), plus, when a `check.gateCommand` is set and differs, that gate
 * command too (the gate scope's pre-check — runScopedBuildCheck — swaps in `check.gateCommand`
 * at scope "gate", so the guard must not read green on a command the gate never runs). Each is
 * run at `check.cwd` resolved against the worktree (default `.`), under the config-resolved
 * timeout. A preserved cwd must be honored or the guard runs in the wrong tree — a false green
 * or false red that defeats the fail-closed purpose. */
function guardChecks(current: TumwaterConfig, wt: string, declared: string): BuildCheck[] {
  const c = current.check;
  const configuredMs =
    typeof c?.timeoutSeconds === "number" && c.timeoutSeconds > 0 ? c.timeoutSeconds * 1000 : undefined;
  const base = {
    kind: "command" as const,
    cwd: path.resolve(wt, isNonBlankString(c?.cwd) ? c.cwd : "."),
    timeoutMs: configuredMs ?? BUILD_CHECK_TIMEOUT_MS,
  };
  const gate = gateCommandOf(current);
  if (gate !== undefined && gate !== declared) {
    return [{ ...base, command: gate }, { ...base, command: declared }];
  }
  return [{ ...base, command: declared }];
}

/** How a non-passed guard outcome is named in the rejection error. */
function describeGuardFailure(o: BuildCheckOutcome): string {
  if (o.status === "failed") return "failed";
  if (o.skipReason === "timeout") return "timed out";
  if (o.skipReason === "install") return "could not install dependencies";
  return "could not run";
}

/** Build the whole-config write candidate a request would produce from a given `current`
 * config — the request's customRoles array (or the live one when absent) and, when a
 * check.command is declared, the check section with only `command` replaced — and return
 * whether that candidate differs from `current` at all. Shared by the pre-write validation
 * (which must reject an invalid request BEFORE the declared check runs, so a request pairing a
 * valid check.command with an invalid customRoles entry never spawns the check) and the locked
 * write, so the two can never build different candidates. Roles stripping is folded in: the
 * standalone validation has to reject what the write would reject, and the write has to strip
 * what the validation sees. */
function buildCandidate(
  root: string,
  current: TumwaterConfig,
  entries: unknown[] | undefined,
  checkCommand: string | undefined,
): { candidate: TumwaterConfig; changed: boolean } {
  const customRoles: TumwaterConfig["customRoles"] =
    entries === undefined ? current.customRoles : (entries as TumwaterConfig["customRoles"]);
  const checkChanged =
    checkCommand !== undefined && (current.check?.command ?? "") !== checkCommand;
  const unchanged = !checkChanged && isDeepStrictEqual(customRoles, current.customRoles);
  const requestedNames = requestedRoleNames(customRoles);
  const fileRoles = fileRolesAfterRemoval(root, current.customRoles, requestedNames);
  const candidate: Record<string, unknown> = { ...current, customRoles };
  withCheckCommand(candidate, current.check, checkCommand, checkChanged);
  withRolesSection(candidate, fileRoles.raw, fileRoles.roles);
  return { candidate: candidate as unknown as TumwaterConfig, changed: !unchanged };
}

/** The structurally valid role names a request's customRoles array carries (see
 * applyConfigRequest's docstring): only names on structurally valid entries feed the roles
 * strip; anything else stays for validateConfig to reject — never dereference a request
 * entry before validation. */
function requestedRoleNames(customRoles: TumwaterConfig["customRoles"]): Set<string> {
  const requestedNames = new Set<string>();
  for (const entry of customRoles) {
    if (isJsonObject(entry) && typeof entry.name === "string") requestedNames.add(entry.name);
  }
  return requestedNames;
}

/** The FILE's own roles section (not the loaded, catalog-merged map — this whole-config
 * write must not re-expand a partial section to every built-in, preserveFileRoles' rule)
 * with the removed custom roles' entries stripped: only the requested names the caller
 * passes are removed, and only from what the file actually holds. Returns both the raw value
 * (for when the file had no roles section) and the stripped map. */
function fileRolesAfterRemoval(
  root: string,
  currentRoles: TumwaterConfig["customRoles"],
  requestedNames: Set<string>,
): { raw: unknown; roles: Record<string, unknown> } {
  const raw = rawConfigObject(root).roles;
  const roles = isJsonObject(raw) ? { ...(raw) } : {};
  for (const c of currentRoles) {
    if (!requestedNames.has(c.name)) delete roles[c.name];
  }
  return { raw, roles };
}

/** Replace only `check.command` on the candidate when the request declares one, preserving
 * the rest of the check section (gateCommand/mergeCommand/timeoutSeconds). */
function withCheckCommand(
  candidate: Record<string, unknown>,
  currentCheck: TumwaterConfig["check"],
  checkCommand: string | undefined,
  checkChanged: boolean,
): void {
  if (checkChanged && checkCommand !== undefined) {
    candidate.check = { ...currentCheck, command: checkCommand };
  }
}

/** Set the candidate's roles section to the stripped map, or drop it when the file had none. */
function withRolesSection(
  candidate: Record<string, unknown>,
  rawRolesCandidate: unknown,
  roles: Record<string, unknown>,
): void {
  if (rawRolesCandidate === undefined) delete candidate.roles;
  else candidate.roles = roles;
}

/** Parse the request JSON into its customRoles entries and raw `check` value: the isJsonObject
 * throw, the old-key normalization and the top-level disallowed-key scan into `ignored`; the
 * `check` value is returned untouched for checkCommandFrom. */
function parseConfigRequest(
  raw: string,
  ignored: string[],
): { entries: unknown[] | undefined; check: unknown } {
  const unnormalized: unknown = JSON.parse(raw);
  if (!isJsonObject(unnormalized))
    throw new Error(`config request must be a JSON object (got ${show(unnormalized)})`);
  // Old key spellings read as the new ones; a request setting both fails with the pair named.
  const normalized = normalizeConfigKeys(unnormalized);
  if (normalized.problems.length > 0) throw new Error(normalized.problems.join("; "));
  const parsed = normalized.raw as Record<string, unknown>;
  for (const key of Object.keys(parsed)) {
    if (key !== "customRoles" && key !== "check") ignored.push(key);
  }
  return { entries: parsed.customRoles as unknown[] | undefined, check: parsed.check };
}

/** Extract the declared check command from a request's `check` object: the isJsonObject throw,
 * the sub-key scan that pushes the dropped `check.<key>` names into `ignored`, and the
 * non-blank `command` (or its collected drop). */
function checkCommandFrom(check: unknown, ignored: string[]): string | undefined {
  // A check request is read only for its `command` (a non-blank string). Every other
  // sub-key — and a blank `command` — is dropped into `ignored`, so it can never turn the
  // safety gates off; a blank/absent command simply declares nothing.
  if (check !== undefined) {
    const checkReq = check;
    if (!isJsonObject(checkReq))
      throw new Error(`config request's check must be an object (got ${show(checkReq)})`);
    for (const key of Object.keys(checkReq)) {
      if (key !== "command") ignored.push(`check.${key}`);
    }
    if (isNonBlankString(checkReq.command)) return checkReq.command;
    else if (checkReq.command !== undefined) ignored.push("check.command");
  }
  return undefined;
}

/** Verify a declared check.command before it is written (part 1/2): a declared check is
 * fail-closed — the gate's pre-check rejects a red run and a failure that reproduces on main
 * parks every queued pin behind a red main no role can repair by code — so the declared
 * command must be observed green in the requesting worktree BEFORE it is written. Only a
 * `passed` outcome writes; failed, timed-out, or skipped writes nothing and returns an error
 * naming what was observed. Each candidate is run at `check.cwd` resolved against the
 * worktree (default `.`) under the config-resolved timeout, and when a `check.gateCommand` is
 * set and differs the gate command is verified first too — the declared command is the
 * fail-closed promise, the gate command is what the gate scope will actually run — so a green
 * here is a green at the gate for every command the write leaves live. */
async function verifyDeclaredCheck(
  root: string,
  wt: string,
  entries: unknown[] | undefined,
  checkCommand: string,
  runCheck: CheckGuard,
): Promise<void> {
  // Read the current config only for the guard — the write reloads fresh under the lock.
  const currentForGuard = loadConfig(root);
  // Pre-validate what the request would write BEFORE the declared check runs: a request
  // that pairs a valid check.command with an invalid customRoles entry must be rejected
  // without ever spawning the check (it would fail validation anyway). The locked write
  // re-loads fresh and re-validates, so a config change between here and the write is
  // still caught.
  const { candidate: preCandidate } = buildCandidate(root, currentForGuard, entries, checkCommand);
  validateConfig(collapseBackendAliases(preCandidate));
  for (const check of guardChecks(currentForGuard, wt, checkCommand)) {
    const outcome = await runCheck(wt, check, currentForGuard);
    if (outcome.status !== "passed") {
      throw new Error(
        `check.command not declared: \`${outcome.script}\` ${describeGuardFailure(outcome)} in the worktree`,
      );
    }
  }
}

/** The locked whole-config write of a config request: the load-to-write sequence is one
 * critical section under withConfigLock — a concurrent `config set`/dashboard write between
 * the load and this write must not be dropped by the whole-file overwrite (see
 * writeConfigMutation). Returns whether the request changed nothing and the now-live custom
 * role names. */
function writeConfigRequest(
  root: string,
  entries: unknown[] | undefined,
  checkCommand: string | undefined,
): { unchanged: boolean; applied: string[] } {
  let applied: string[] = [];
  let unchanged = false;
  withConfigLock(root, () => {
    const current = loadConfig(root); // fresh — bypasses the stat cache: a writer sees the latest file
    const { candidate, changed } = buildCandidate(root, current, entries, checkCommand);
    // Nothing the request would change: write nothing, like writeConfigMutation's no-op skip.
    if (!changed) {
      unchanged = true;
      return;
    }
    // Collapse legacy/new pi spellings before writing so a merged config (which always
    // carries the default piArgs) never lands both forms in the file — the next load's raw
    // pass rejects a file holding both `piArgs` and `backends.pi.args`.
    const collapsed = collapseBackendAliases(candidate);
    validateConfig(collapsed); // throws listing every problem — nothing is written on failure
    writeJsonAtomic(configPath(root), collapsed, true);
    applied = collapsed.customRoles.map((c) => c.name);
  });
  return { unchanged, applied };
}

/** Delete the request on EVERY path — success, rejection, malformed JSON — so it can never be
 * staged by commitAll, reach a review gate, or retry forever. A failed unlink is surfaced as
 * an error so the caller logs it (the file would otherwise survive into the diff); a passed-in
 * error outranks the failed-deletion message. Returns the error to surface. */
function discardConfigRequest(requestFile: string, error: string | undefined): string | undefined {
  try {
    fs.unlinkSync(requestFile);
  } catch (err) {
    return error ?? `config request file could not be deleted: ${errorMessage(err)}`;
  }
  return error;
}

/** Consume the role's config-write request file (plans/portability.md §3/7). After its pi
 * run the director may leave `.tumwater-config-request.json` at its worktree root:
 * `{ "customRoles": [ { "name", "task" }, … ] }` — the whole array, replacing the current one;
 * the feature role (only) may leave the same file carrying a `check.command` to declare the
 * project's verification command, which is observed green in the worktree before it is written.
 * Applied atomically to the live config, sharing the editor's trap (fresh loadConfig that
 * bypasses the stat cache, validateConfig, then writeJsonAtomic — readers poll every ~2 s), so
 * the orchestrator's live reload starts the new role with no commit, no review
 * gate, and no merge, and the request file never enters a diff.
 *
 * The permitted key set is enforced here, not in prose: `customRoles` and a `check` object are
 * accepted and every other top-level key is collected into `ignored` and dropped (the caller
 * logs the warning that names them). Inside `check` only `command` is read — a non-blank
 * string that declares the project's check; every other sub-key (and a blank `command`) is
 * collected into `ignored` and dropped, so a role can declare a check but never turn the
 * safety gates off (`gateCommand: ""`, `mergeCommand: ""`, `timeoutSeconds`). Validation runs
 * BEFORE any write and nothing here dereferences a request entry first — a structurally
 * malformed entry (`[null]`, a non-string name) is left for validateConfig to reject, so on
 * failure nothing is written and the previous config stays live. The request file is deleted
 * on EVERY path (including every failure), so a malformed request cannot retry forever and the
 * file cannot survive into `git add -A`.
 *
 * A declared `check.command` is verified before it is written: the declared command is run
 * through runBuildCheck in the requesting worktree — and, when a `check.gateCommand` is set
 * and differs, that gate command (which the gate scope runs) is verified first too — each at
 * `check.cwd` resolved against it (default `.`), under the config-resolved timeout, the same
 * install-first step, and the same process-wide check permit (`maxConcurrentChecks`) the gate's
 * pre-check takes — and only a `passed` outcome for every candidate writes. A failed, timed-out,
 * or skipped run writes nothing and returns an error naming what was observed — the role's own
 * claim is not the evidence, because a command that could never pass would park the whole queue
 * behind a red main no role can repair (part 1/2).
 *
 * Roles entries for custom roles the request removes are stripped before validation, from the
 * FILE's own `roles` section rather than the catalog-merged map (the rule every other
 * whole-config write follows, see preserveFileRoles): loadConfig seeds one `roles.<name>` per
 * current custom role and validateConfig rejects an id that is neither a catalog role nor a
 * requested custom-role name, so without the strip a removal would never apply. Only
 * structurally valid names feed the strip — a malformed entry stays in the array for
 * validateConfig to reject.
 *
 * Returns null when no request file exists. `applied` names the custom roles now live (empty
 * unless the write happened); `ignored` lists the discarded keys (top-level keys and, named
 * `check.<key>`, the check sub-keys that were dropped); `error`, when set, names why nothing
 * (or only part of the work) was done — the caller turns it and `ignored` into warning events.
 * `unchanged` is set when the request changes nothing; nothing is written. The body delegates
 * each phase to a named helper — parseConfigRequest, checkCommandFrom, verifyDeclaredCheck,
 * writeConfigRequest and discardConfigRequest. */
export async function applyConfigRequest(
  root: string,
  wt: string,
  runCheck: CheckGuard = defaultCheckGuard,
): Promise<{ applied: string[]; ignored: string[]; error?: string; unchanged?: true } | null> {
  const requestFile = configRequestPath(wt);
  const raw = readTextOrNull(requestFile);
  if (raw === null) return null; // no request this run

  const ignored: string[] = [];
  let applied: string[] = [];
  let error: string | undefined;
  let unchanged: true | undefined;
  try {
    const { entries, check } = parseConfigRequest(raw, ignored);
    const checkCommand = checkCommandFrom(check, ignored);
    // The array-shape check runs after the check-subkey scan in checkCommandFrom, preserving the
    // original ordering so a doubly-malformed request still reports its dropped `check.<key>`
    // warnings before the malformed-customRoles error.
    if (entries !== undefined && !Array.isArray(entries))
      throw new Error(`config request's customRoles must be an array (got ${show(entries)})`);
    if (checkCommand !== undefined) {
      await verifyDeclaredCheck(root, wt, entries, checkCommand, runCheck);
    }
    const written = writeConfigRequest(root, entries, checkCommand);
    applied = written.applied;
    unchanged = written.unchanged ? true : undefined;
  } catch (err) {
    applied = []; // no write happened, or it must not be reported as applied
    error = errorMessage(err);
  }
  error = discardConfigRequest(requestFile, error);
  return unchanged ? { applied, ignored, error, unchanged } : { applied, ignored, error };
}
