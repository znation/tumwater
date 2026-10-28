/** The agent-execution section rules of tumwater.json validation: `agentBin`, `baseBranch`,
 * the `backend` id, `piArgs` and the `backends` object (per-backend `bin`/`args`, the
 * claude/codex config-dir scan, the codex `-c <key>=…` arity-aware scan, the reserved
 * passthrough-flag screen), and the legacy `agentBin`/`piArgs` back-compat pair. Extracted
 * from the single validateConfig gate (config-validation.ts) so an agent-key edit lands as a
 * per-theme diff instead of a whole-gate one. Called from the gate where this block runs
 * today, so problem order across the whole pass is unchanged.
 *
 * The helpers passed in are closures the gate binds once (the problems-bound field checkers
 * and the per-backend config-dir / codex-config-key scans); everything else these rules need
 * is imported directly. */

import {
  BACKEND_IDS,
  BACKEND_KEYS,
  CLAUDE_AGENT_KEYS,
  CODEX_BACKEND_KEYS,
  HARNESS_PI_FLAGS,
} from "./config-schema.js";
import { isJsonObject } from "../files/json-object.js";
import { typoSuffix } from "../text/suggest.js";
import { isBackendId } from "./config-model-selector.js";
import { reservedPassthroughFlag } from "../agent/backend-traits.js";
import {
  checkObjectSection,
  checkReservedArgs,
  show,
} from "./config-field-checks.js";

/** The closures the gate binds once and hands to the agent block: the problems-bound field
 * checkers and the per-backend config-dir / codex-config-key scans. */
interface AgentsBlockHelpers {
  checkString: (
    obj: Record<string, unknown>,
    prefix: string,
    key: string,
    allowEmpty?: boolean,
  ) => void;
  checkStringArray: (
    obj: Record<string, unknown>,
    prefix: string,
    key: string,
  ) => void;
  checkKnownKeys: (
    obj: Record<string, unknown>,
    allowed: readonly string[],
    prefix: string,
    problems: string[],
  ) => void;
  checkBackendConfig: (entry: Record<string, unknown>, prefix: string) => void;
  checkCodexConfigKeys: (entry: Record<string, unknown>, prefix: string) => void;
}

/** Validate the agent-execution block: the bare `backend`, `agentBin`, `baseBranch` and
 * `piArgs` keys, the `backends` object in full, and the legacy spellings' back-compat pair. */
export function validateAgentsBlock(
  r: Record<string, unknown>,
  problems: string[],
  rawFile: boolean,
  helpers: AgentsBlockHelpers,
): void {
  const { checkString, checkStringArray, checkKnownKeys, checkBackendConfig, checkCodexConfigKeys } = helpers;
  // An empty baseBranch would silently fall back to the checked-out branch — the one value
  // the operator's explicit setting must never degrade to unannounced.
  checkString(r, "", "baseBranch", false);
  // An empty agentBin would silently fall back to "pi" — the same silent-ignore class: the
  // operator named a binary, so a blank value must fail validation, not run the default.
  checkString(r, "", "agentBin", false);
  // The agent backend for bare/no-model selectors (plans/agent-backends.md "Config"): a
  // non-blank id from the schema's reserved set. An unknown id would fall back to pi at run
  // time (src/agent/agent-run.ts), silently running the wrong backend against a named one.
  checkString(r, "", "backend", false);
  if (typeof r.backend === "string" && !isBackendId(r.backend))
    problems.push(`backend must name a backend (${BACKEND_IDS.join(", ")}; got ${show(r.backend)})${typoSuffix(r.backend, BACKEND_IDS)}`);
  checkStringArray(r, "", "piArgs");
  // A piArgs entry that repeats a harness-managed flag is appended after the harness's own and
  // pi's parser is last-wins, so it silently overrides it (see HARNESS_PI_FLAGS). Name the
  // position and the flag so one edit removes it.
  if (Array.isArray(r.piArgs))
    checkReservedArgs(problems, r.piArgs as unknown[], "piArgs", (flag) =>
      HARNESS_PI_FLAGS.get(flag),
    );
  // Agent backends (plans/agent-backends.md "Config"): each entry is an object with an
  // optional non-empty `bin` string and an optional array-of-strings `args`. A passthrough arg
  // that repeats a flag the backend's own harness invocation sets is appended last and wins,
  // so it silently overrides the harness — refused here for the backends whose reserved sets
  // are known (claude-args.ts HARNESS_CLAUDE_FLAGS, opencode-args.ts HARNESS_OPENCODE_FLAGS,
  // codex-args.ts HARNESS_CODEX_FLAGS, config-schema.ts HARNESS_PI_FLAGS).
  checkObjectSection(r, "backends", problems, (o) => {
    for (const [id, entry] of Object.entries(o)) {
      const prefix = `backends.${id}`;
      if (!isJsonObject(entry)) {
        problems.push(`${prefix} must be an object with optional bin and args (got ${show(entry)})`);
        continue;
      }
      checkKnownKeys(entry, id === "claude" ? CLAUDE_AGENT_KEYS : id === "codex" ? CODEX_BACKEND_KEYS : BACKEND_KEYS, prefix, problems);
      checkString(entry, `${prefix}.`, "bin", false);
      checkStringArray(entry, `${prefix}.`, "args");
      if (id === "claude" || id === "codex") checkBackendConfig(entry, prefix);
      if (id === "codex" && Array.isArray(entry.args)) checkCodexConfigKeys(entry, prefix);
      if (!Array.isArray(entry.args)) continue; // Already reported by checkStringArray.
      checkReservedArgs(problems, entry.args as unknown[], `${prefix}.args`, (flag) =>
        reservedPassthroughFlag(id, flag),
      );
    }
  });
  // Legacy back-compat (plans/agent-backends.md "Back-compat"): a file must not spell one pi
  // field both ways. This is a property of the FILE's own keys — the merged config always
  // carries a default `piArgs`, so only the raw pass (rawFile) can tell an explicit legacy
  // value from the default. The effective value resolves through config-views.ts
  // resolvedBackendConfig; a load-time mirror into `agents` would instead leak a duplicate
  // spelling into every later config write.
  if (rawFile && isJsonObject(r.backends)) {
    const pi = r.backends.pi;
    if (isJsonObject(pi)) {
      if (r.agentBin !== undefined && pi.bin !== undefined)
        problems.push(
          "agentBin and backends.pi.bin set the same value — keep one (backends.pi.bin is the current spelling; agentBin is its old name)",
        );
      if (r.piArgs !== undefined && pi.args !== undefined)
        problems.push(
          "piArgs and backends.pi.args set the same value — keep one (backends.pi.args is the current spelling; piArgs is its old name)",
        );
    }
  }
}
