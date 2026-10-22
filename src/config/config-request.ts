/** The director's staged config-write request — one verb split out of config-write.ts (the
 * operator-editor mutators stay there, addressed by key through config-keys.ts). The director
 * stages a JSON request file in its worktree; this module consumes it: parse the request,
 * keep only its `customRoles` array, apply it as a whole-config write, and delete the file on
 * every path. A request is shaped and lives differently from the interactive `config set` /
 * `unset` verbs (a staged file that must never reach a diff, not direct CLI text), so the
 * runtime (run-verdict.ts) imports this module rather than the whole editor. It
 * still shares the write machinery with the editor — withConfigLock and rawConfigObject from
 * config-write.ts, validateConfig from config-validation.ts, writeJsonAtomic from
 * json-files.js — because a request is a whole-config write too. */
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { TumwaterConfig } from "./config-schema.js";
import { configPath, configRequestPath } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { readTextOrNull } from "../files/files.js";
import { writeJsonAtomic } from "../files/json-files.js";
import { isJsonObject } from "../files/json-object.js";
import { withConfigLock, rawConfigObject } from "./config-write.js";
import { show } from "./config-field-checks.js";
import { validateConfig } from "./config-validation.js";
import { normalizeConfigKeys } from "./config-aliases.js";
import { collapseBackendAliases, loadConfig } from "./config.js";

/** Consume the director's config-write request file (plans/portability.md §3/7). After its pi
 * run the director may leave `.tumwater-config-request.json` at its worktree root:
 * `{ "customRoles": [ { "name", "task" }, … ] }` — the whole array, replacing the current one.
 * Applied atomically to the live config, sharing the editor's trap (fresh loadConfig that
 * bypasses the stat cache, validateConfig, then writeJsonAtomic — readers poll every ~2 s), so
 * the orchestrator's live reload starts the new role with no commit, no review
 * gate, and no merge, and the request file never enters a diff.
 *
 * The permitted key set is enforced here, not in prose: `customRoles` is accepted and every
 * other top-level key is collected into `ignored` and dropped (the caller logs the warning that
 * names them). Validation runs BEFORE any write and nothing here dereferences a request entry
 * first — a structurally malformed entry (`[null]`, a non-string name) is left for
 * validateConfig to reject, so on failure nothing is written and the previous config stays
 * live. The request file is deleted on EVERY path (including every failure), so a malformed
 * request cannot retry forever and the file cannot survive into `git add -A`.
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
 * unless the write happened); `ignored` lists the discarded top-level keys; `error`, when set,
 * names why nothing (or only part of the work) was done — the caller turns it and `ignored`
 * into warning events. `unchanged` is set when the request's array equals the live one;
 * nothing is written. */
export function applyConfigRequest(
  root: string,
  wt: string,
): { applied: string[]; ignored: string[]; error?: string; unchanged?: true } | null {
  const requestFile = configRequestPath(wt);
  const raw = readTextOrNull(requestFile);
  if (raw === null) return null; // no request this run

  const ignored: string[] = [];
  let applied: string[] = [];
  let error: string | undefined;
  let unchanged: true | undefined;
  try {
    const unnormalized: unknown = JSON.parse(raw);
    if (!isJsonObject(unnormalized))
      throw new Error(`config request must be a JSON object (got ${show(unnormalized)})`);
    // Old key spellings read as the new ones; a request setting both fails with the pair named.
    const normalized = normalizeConfigKeys(unnormalized);
    if (normalized.problems.length > 0) throw new Error(normalized.problems.join("; "));
    const parsed = normalized.raw as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      if (key !== "customRoles") ignored.push(key);
    }
    const entries = parsed.customRoles;
    if (!Array.isArray(entries))
      throw new Error(`config request's customRoles must be an array (got ${show(entries)})`);
    // The load-to-write sequence is one critical section under withConfigLock: a concurrent
    // `config set`/dashboard write between the load and this write must not be dropped by the
    // whole-file overwrite (see writeConfigMutation).
    withConfigLock(root, () => {
      const current = loadConfig(root); // fresh — bypasses the stat cache: a writer sees the latest file
      // Same as the live array: write nothing, like writeConfigMutation's no-op skip.
      if (isDeepStrictEqual(entries, current.customRoles)) {
        unchanged = true;
        return;
      }
      // Strip roles.<id> entries for custom roles this request removes (see docstring).
      // Structurally valid names only; anything else stays for validateConfig to reject — never
      // dereference a request entry before validation.
      const requestedNames = new Set<string>();
      for (const entry of entries) {
        if (isJsonObject(entry) && typeof entry.name === "string") requestedNames.add(entry.name);
      }
      // Base the roles rewrite on the FILE's own section, not the loaded (catalog-merged)
      // map: this whole-config write must not re-expand a partial section to every built-in
      // (preserveFileRoles' rule). Only the removed custom roles' entries are stripped, and
      // only from what the file actually holds.
      const rawRolesCandidate = rawConfigObject(root).roles;
      const roles = isJsonObject(rawRolesCandidate)
        ? { ...(rawRolesCandidate) }
        : {};
      for (const c of current.customRoles) {
        if (!requestedNames.has(c.name)) delete roles[c.name];
      }
      const candidate = { ...current, customRoles: entries as TumwaterConfig["customRoles"] };
      const candidateRecord = candidate as unknown as Record<string, unknown>;
      if (rawRolesCandidate === undefined) delete candidateRecord.roles;
      else candidateRecord.roles = roles;
      // Collapse legacy/new pi spellings before writing so a merged config (which always
      // carries the default piArgs) never lands both forms in the file — the next load's raw
      // pass rejects a file holding both `piArgs` and `backends.pi.args`.
      const collapsed = collapseBackendAliases(candidate);
      validateConfig(collapsed); // throws listing every problem — nothing is written on failure
      writeJsonAtomic(configPath(root), collapsed, true);
      applied = collapsed.customRoles.map((c) => c.name);
    });
  } catch (err) {
    applied = []; // no write happened, or it must not be reported as applied
    error = errorMessage(err);
  }

  // Delete the request on EVERY path — success, rejection, malformed JSON — so it can never be
  // staged by commitAll, reach a review gate, or retry forever. A failed unlink is surfaced as
  // an error so the caller logs it (the file would otherwise survive into the diff).
  try {
    fs.unlinkSync(requestFile);
  } catch (err) {
    error ??= `config request file could not be deleted: ${errorMessage(err)}`;
  }
  return unchanged ? { applied, ignored, error, unchanged } : { applied, ignored, error };
}
