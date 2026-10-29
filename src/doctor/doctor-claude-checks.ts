import os from "node:os";
import { childEnv } from "../process/process.js";
import { AUTH_CHECK_MAX_OUTPUT_BYTES, AUTH_CHECK_TIMEOUT_MS, boundedProbe } from "./doctor-probe.js";
import { claudeBackend, claudeConfigDir } from "../agent/claude/claude-backend.js";
import { claudeEnv } from "../agent/claude/claude-env.js";
import { claudeAuthUsesSubscription, parseClaudeAuthStatus, type ClaudeAuthStatus } from "../agent/claude/claude-account.js";
import { resolvedBackendConfig } from "../config/config-views.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { envPath } from "../files/files.js";
import { belowNodeFloor } from "../version.js";
import { failOutcome, okOutcome, warnOutcome, type CheckOutcome } from "./doctor-outcome.js";
import {
  claudeSeamsInUse,
  loadConfigForCheck,
  versionFromProbe,
  seamedModels,
} from "./doctor-model-checks.js";

/** The doctor's claude credential and version readiness checks, split out of
 * doctor-model-checks.ts (whose shared seam/model framework and the pi and tier-models
 * checks stay there): checkClaudeAuth, checkAnthroApiKey and checkClaudeVersion.
 * These are the doctor's only checks that spawn the `claude` binary and read its auth — a
 * distinct concern from the filesystem/git checks, kept together so a change to how doctor
 * spawns or scrubs claude does not touch the other model checks. The shared report contract
 * (CheckOutcome) and the seam/model framework (loadConfigForCheck, claudeSeamsInUse,
 * seamPairs) come from doctor-model-checks.ts, and the AUTH_CHECK_* probe budgets
 * from doctor-probe.ts, with the shared report contract (CheckOutcome) from
 * doctor-outcome.ts, exactly as the other doctor-* modules share them. */

/** The config a claude readiness row reads, or the warn outcome a broken `tumwater.json`
 * earns, or the ok stand-down when no seam routes to claude. The claude rows repeat the same
 * three-line guard and the same seam stand-down (`loadConfigForCheck` + `claudeSeamsInUse`);
 * folding them here mirrors codexCheckBase so a change to how doctor guards a claude check
 * touches one spot instead of three. Each caller still checks the seams it needs — the auth
 * rows use `claudeSeamsInUse` directly (folded here), the version row goes on to
 * `seamedModels` for the floors. */
function claudeCheckBase(root: string): TumwaterConfig | CheckOutcome {
  const config = loadConfigForCheck(root);
  if ("level" in config) return config;
  if (!claudeSeamsInUse(config)) return okOutcome("no model jobs run on claude");
  return config;
}

/** One bounded probe of the resolved `claude` binary under the scrubbed run environment a real
 * run gets: resolve the binary through the claude adapter that would spawn it and run `args`
 * with a short deadline. Null when the probe could not run, the child errored, or the deadline
 * passed. The one home of the resolveBin + claudeEnv pairing the auth and version checks share,
 * so neither probes a different binary or environment than the other. */
function claudeProbe(
  config: TumwaterConfig,
  args: string[],
  pathEnv: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string } | null> {
  const resolved = claudeBackend.resolveBin(config);
  // The configured team config dir must reach the probe's env the way a real run's does, or
  // the auth/version rows would look in claude's default dir (usually ~/.claude) while a run
  // with backends.claude.configDir writes and reads elsewhere — the very mismatch doctor exists
  // to surface. Mirror backends.run's expansion: only claude accepts configDir, and unset leaves
  // today's env byte-identical.
  const configDir = resolvedBackendConfig(config, "claude").configDir;
  const expandedConfigDir =
    configDir !== undefined ? claudeConfigDir(process.env, os.homedir(), configDir) : undefined;
  const env = claudeEnv(childEnv({ PATH: pathEnv }), {
    quietTimeoutSeconds: 0,
    ...(expandedConfigDir !== undefined ? { configDir: expandedConfigDir } : {}),
  });
  return boundedProbe(resolved.bin, args, env, timeoutMs, AUTH_CHECK_MAX_OUTPUT_BYTES);
}

/** Run `claude auth status` under the same scrubbed environment a real run gets (claudeEnv),
 * or null when the probe could not run or its reply was unreadable. */
async function claudeAuthProbe(
  config: TumwaterConfig,
  pathEnv: string,
  timeoutMs: number,
): Promise<ClaudeAuthStatus | null> {
  const result = await claudeProbe(config, ["auth", "status"], pathEnv, timeoutMs);
  if (result?.code !== 0) return null;
  return parseClaudeAuthStatus(result.stdout);
}

/** claude credential readiness (plans/agent-backends.md "Every seam, checked"): a claude seam
 * whose login is gone fails every run before it can work, so doctor runs `claude auth status`
 * under the scrubbed run environment and fails when it reports `loggedIn: false`. An ok detail
 * names the billing the reply implies — the subscription type, or an API key — so an operator
 * telling subscription spend from API spend does not have to run the command themselves. A
 * probe that could not run or a reply this cannot read warns rather than guesses. Stands down
 * (ok) when no seam routes to claude, so a pi-only team spawns nothing. */
export async function checkClaudeAuth(
  root: string,
  pathEnv: string = envPath(),
  timeoutMs: number = AUTH_CHECK_TIMEOUT_MS,
): Promise<CheckOutcome> {
  const config = claudeCheckBase(root);
  if ("level" in config) return config;
  const auth = await claudeAuthProbe(config, pathEnv, timeoutMs);
  if (auth === null)
    return warnOutcome("could not check — `claude auth status` did not run or its output was unreadable");
  if (!auth.loggedIn)
    return failOutcome("claude reports logged in: false — run `claude auth login`");
  const subscription = claudeAuthUsesSubscription(auth);
  const billing = subscription
    ? `subscription${auth.subscriptionType !== undefined ? ` (${auth.subscriptionType})` : ""}`
    : "API key";
  return okOutcome(`logged in — billing: ${billing}`);
}

/** The subscription-vs-API billing trap (plans/provider-concurrency.md §9 gap 6): an operator
 * who exports `ANTHROPIC_API_KEY` for pi's `anthropic` provider will silently move every claude
 * seam to API billing — claude prefers the key over a claude.ai login — and subscription seams
 * stop counting as free. Doctor warns when the key is set, some seam routes to claude, and
 * `claude auth status` reports a claude.ai login (the subscription the key would override). It
 * stays silent (ok) when no seam runs on claude, when the key is unset, or when claude reports
 * an API-key login (then there is no subscription to lose). `env` is injectable so the check
 * stays hermetic; a probe that cannot run warns rather than guesses like checkClaudeAuth. */
export async function checkAnthroApiKey(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  pathEnv: string = envPath(),
  timeoutMs: number = AUTH_CHECK_TIMEOUT_MS,
): Promise<CheckOutcome> {
  const config = claudeCheckBase(root);
  if ("level" in config) return config;
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") return okOutcome("no ANTHROPIC_API_KEY set");
  const auth = await claudeAuthProbe(config, pathEnv, timeoutMs);
  if (auth === null)
    return warnOutcome("could not check — `claude auth status` did not run or its output was unreadable");
  if (!auth.loggedIn || !claudeAuthUsesSubscription(auth))
    return okOutcome("ANTHROPIC_API_KEY is set, but claude reports no claude.ai login");
  return warnOutcome(
    "ANTHROPIC_API_KEY is set while claude reports a claude.ai login — model jobs on claude will bill the API key, not the subscription; unset it or route every anthropic model job on pi explicitly",
  );
}

/** The floor each configured model needs, keyed by model; a model the adapter does not gate
 * contributes none. */
function claudeVersionFloors(seams: ReadonlyArray<{ model: string | undefined }>): Map<string, string> {
  const floors = new Map<string, string>();
  for (const seam of seams) {
    const min = claudeBackend.minVersion?.(seam.model!);
    if (min !== undefined) floors.set(seam.model!, min);
  }
  return floors;
}

/** The clamp note when any claude seam clamps thinking, else empty. */
function claudeVersionClampNote(seams: ReadonlyArray<{ thinking: string | undefined }>): string {
  const clamped = seams.some((seam) => seam.thinking === "off" || seam.thinking === "minimal");
  const clampNote = clamped
    ? "; `off`/`minimal` thinking clamps to `--effort low` (claude has no lower setting)"
    : "";
  return clampNote;
}

/** The highest floor decides: whichever model needs the newest CLI. */
function claudeVersionNeededBy(floors: Map<string, string>): { required: string; neededBy: string } {
  let required = "";
  let neededBy = "";
  for (const [model, min] of floors) {
    if (required === "" || belowNodeFloor(required, `>=${min}`)) {
      required = min;
      neededBy = model;
    }
  }
  return { required, neededBy };
}

/** Verdict on the found version against the claude seams' floors, carrying the clamp note. */
function claudeVersionOutcome(
  found: string,
  floors: Map<string, string>,
  clampNote: string,
): CheckOutcome {
  if (floors.size === 0) return okOutcome(`claude ${found}${clampNote}`);
  const { required, neededBy } = claudeVersionNeededBy(floors);
  if (belowNodeFloor(found, `>=${required}`))
    return failOutcome(`claude ${found} is older than ${required} required by ${neededBy} — run \`claude update\``);
  return okOutcome(`claude ${found} (>= ${required} for ${neededBy})${clampNote}`);
}

/** claude CLI-version readiness (plans/agent-backends.md finding 9): an installed CLI below a
 * configured model's minimum fails or misprices that model, and team runs disable the
 * auto-updater, so the version an operator has is the version agent runs use. Fails below the
 * highest floor among the claude-routed models, naming which model needs it; an ok detail
 * prints the installed version and the floor it satisfied (or no floor when none applies).
 * The `off`/`minimal` thinking clamp is noted here too, since this check already has the
 * claude seams in hand. Stands down when no seam routes to claude. */
export async function checkClaudeVersion(
  root: string,
  pathEnv: string = envPath(),
  timeoutMs: number = AUTH_CHECK_TIMEOUT_MS,
): Promise<CheckOutcome> {
  const config = claudeCheckBase(root);
  if ("level" in config) return config;
  const seams = seamedModels(config, "claude");
  if (seams.length === 0) return okOutcome("no model jobs run on claude");
  const floors = claudeVersionFloors(seams);
  const result = await claudeProbe(config, ["--version"], pathEnv, timeoutMs);
  const found = versionFromProbe(result);
  if (found === undefined)
    return warnOutcome("could not check — `claude --version` did not run or its output was unreadable");
  return claudeVersionOutcome(found, floors, claudeVersionClampNote(seams));
}
