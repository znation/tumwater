import { spawn } from "node:child_process";
import { childEnv, releaseChildHandles, signalTree } from "../process/process.js";
import { enabledRoleIds, defaultConfig, loadConfigSafe } from "../config/config.js";
import { configForRole, fallbackPair, reviewConfig, tierModel } from "../config/config-views.js";
import { cacheReadUnpriced, fallbackModelPair, piModelsPath, readPiProviders } from "../pi/pi-models.js";
import { MODEL_TIERS, type FallbackModelConfig, type TumwaterConfig } from "../config/config-schema.js";
import { isAgentId, routeModel } from "../config/model-selector.js";
import { claudeBackend } from "../agent/claude/claude-backend.js";
import { claudeAuthUsesSubscription, parseClaudeAuthStatus, readClaudeAccount, type ClaudeAuthStatus } from "../agent/claude/claude-account.js";
import { claudeEnv } from "../agent/claude/claude-env.js";
import { parseJsonObject } from "../files/json-object.js";
import { envPath } from "../files/files.js";
import { resolveAgentBin } from "../pi/pi-bin.js";
import { agree } from "../text/phrases.js";
import { formatTime } from "../text/datetime.js";
import { belowNodeFloor } from "../version.js";
import type { FallbackDemotion } from "../budget/fallback-breaker.js";
import { failOutcome, okOutcome, warnOutcome, type CheckOutcome } from "./outcome.js";

/** The doctor's model-readiness checks, split out of doctor-checks.ts (whose environment and
 * repo checks stay there): the cap fallback's price check (checkFallbackModel), the agent
 * binary's own credential probe (piProviderAuth), and the declared-tier resolution check
 * (checkTierModels). These three are the doctor's only checks that read pi's model definitions
 * and, for the credential probe, spawn the agent binary — a distinct concern from the
 * filesystem/git checks beside them, kept together so a change to how doctor reads models does
 * not touch the environment checks. The shared report contract (CheckOutcome) is imported from
 * outcome.ts, exactly as doctor-orphans.ts and doctor-backlog.ts do. */

/** The config a readiness check reads, or the warn outcome a broken tumwater.json earns:
 * checkInit already fails on a broken config, so a model check only reports that it could not
 * run. One home for the guard and its wording, shared by checkFallbackModel and
 * checkTierModels (the same shape doctor-backlog.ts's readDocChecked uses for unreadable
 * files). */
function loadConfigForCheck(root: string): { config: TumwaterConfig } | { outcome: CheckOutcome } {
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) return { outcome: warnOutcome(`cannot check — ${error}`) };
  return { config };
}

/** Fallback model readiness — the daily-cost budget's third state (plans/fallback-model.md): with
 * `fallbackModel` set, pi's definitions must price that pair at zero or the gate refuses it and
 * role loops pause at the cap exactly as if no fallback existed. That refusal is the right runtime
 * behavior (spend must never climb past the cap), but a typo'd id would otherwise surface only
 * after the day's budget is already spent — so doctor checks it up front, before the operator
 * needs it. Read-only: it inspects pi's definitions file, never pi or the network. A price is not
 * readiness, though: whether the backend can SERVE is known only from the fallback's own ticks
 * (src/budget/fallback-breaker.ts's breaker, BUGS.md 2026-09-20), so a free pair reads "serving not
 * verified" — unless the running orchestrator has published that its breaker demoted the pair
 * (`demoted`, from orchestrator.json; runDoctor passes it only while that orchestrator is alive),
 * which warns with the failure count and the next probe time. No fallbackModel configured is
 * informational, not a warning — plenty of fleets intend to stop at the cap. `modelsPath` is
 * injectable so tests need no real pi install. */
export function checkFallbackModel(
  root: string,
  modelsPath: string = piModelsPath(),
  demoted: FallbackDemotion | null = null,
): CheckOutcome {
  const loaded = loadConfigForCheck(root);
  if ("outcome" in loaded) return loaded.outcome;
  const { config } = loaded;
  const declared = fallbackPair(config);
  if (!declared) return okOutcome("none configured — role loops pause at the cap");
  // A pair missing either half would fall through to pi's own (unverified) default, so it can
  // never be free; naming that case beats rendering a bare "?/model". The free branch names
  // the price-resolved pair (a map with no `default` entry borrows another tier's), while the
  // refusal names the pair the operator declared.
  const nameOf = (pair: FallbackModelConfig) =>
    pair.provider && pair.model ? `${pair.provider}/${pair.model}` : "a half-resolved pair";
  const free = fallbackModelPair(config, modelsPath, readClaudeAccount(root));
  if (free) {
    const name = nameOf(free);
    if (demoted)
      return warnOutcome(`${name} is priced at zero but not serving — the running fleet demoted it after ${demoted.failures} consecutive failed ticks, so role loops pause at the cap; one probe tick retries it from ${formatTime(new Date(demoted.probeAt))}`);
    return okOutcome(`${name} — priced at zero (cost n/a), serving not verified`);
  }
  return warnOutcome(`${nameOf(declared)} is not priced at zero in ${modelsPath} — at the cap role loops pause instead of switching`);
}

/** The credential verdict one provider's `pi auth check --provider <p> --json` gives:
 * ready (the provider has credentials), not-ready (pi ran and said otherwise), or unknown
 * (the check could not run or its output could not be parsed — never conflated with
 * not-ready, which would tell the operator to re-login when the real problem is elsewhere). */
type ProviderAuth = "ready" | "not-ready" | "unknown";

/** How long the credential probe may take before it counts as unknown — a doctor run is a
 * pre-flight, not a place to wait out a hung backend. */
const AUTH_CHECK_TIMEOUT_MS = 15_000;

/** Cap on the probe's captured stdout. The auth reply is a tiny JSON object; a binary whose
 * output is a runaway log (or a pipe held open with no EOF) must not grow `out` without bound.
 * Sibling probes share EXEC_MAX_BUFFER, but 1 MiB is already orders of magnitude past any real
 * reply, so it is the tighter bound here. Over it the probe kills the child and reads as
 * unknown. */
const AUTH_CHECK_MAX_OUTPUT_BYTES = 1024 * 1024;

/** One resolved seam pair: the backend it routes to and the provider/model it names, with the
 * thinking level its selector carried. Collected the same way fleetModelsFree sweeps — each
 * tier, every enabled role, and the reviewer — so doctor and the budget see the same seams. */
interface SeamPair {
  agent: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  thinking: string | undefined;
}

/** Every model a seam can run, paired with its backend (plans/agent-backends.md "Config"):
 * the top-level tiers (routed so a `claude/<id>` selector names its backend), every enabled
 * role's resolved pair, and the reviewer's while review is on. Deduplicated by
 * backend/provider/model, so a model reached through several surfaces is checked once. */
function seamPairs(config: TumwaterConfig): SeamPair[] {
  const pairs = new Map<string, SeamPair>();
  const add = (pair: SeamPair): void => {
    if (pair.model === undefined) return;
    pairs.set(`${pair.agent ?? ""}\0${pair.provider ?? ""}\0${pair.model}`, pair);
  };
  for (const tier of MODEL_TIERS) {
    const sel = tierModel(config, tier);
    if (!sel) continue;
    const routed = routeModel(sel.provider, sel.model, config.agent ?? "pi", tier);
    add({
      agent: routed.agent,
      provider: routed.agent === "pi" ? sel.provider : undefined,
      model: routed.model,
      thinking: sel.thinking,
    });
  }
  for (const role of enabledRoleIds(config)) {
    const rc = configForRole(config, role);
    add({ agent: rc.agent, provider: rc.provider, model: rc.model, thinking: rc.thinking });
  }
  if (config.review.enabled) {
    const rv = reviewConfig(config);
    add({ agent: rv.agent, provider: rv.provider, model: rv.model, thinking: rv.thinking });
  }
  return [...pairs.values()];
}

/** Whether any seam runs on the claude backend — the doctor's claude checks stand down when
 * none does (a pi-only fleet reads no `~/.claude` state and spawns no claude). */
export function claudeSeamsInUse(config: TumwaterConfig): boolean {
  return seamPairs(config).some((pair) => pair.agent === "claude");
}

/** One bounded probe of an agent binary: `null` when the spawn threw, the child errored, the
 * deadline passed, or stdout overran the cap — every case the caller must read as "could not
 * check", never as a verdict. The child runs detached and at the deadline (or on overrun) its
 * whole process group is SIGKILLed and the promise settles, because `'close'` waits for the
 * stdio pipes and a grandchild holding them open would otherwise leave the promise pending past
 * the deadline and hang `tumwater doctor` (the same trap git-run.ts's bounded spawn closes for
 * git). `timeoutMs` is a test seam; production callers leave it at the default. */
function boundedProbe(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string } | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd: process.cwd(),
        // Detached so the deadline's signalTree reaches a grandchild too; stderr is ignored
        // rather than piped, since nothing reads it and a full stderr pipe would block the
        // child until the deadline.
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
        env,
      });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let bytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: { code: number | null; stdout: string } | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // Destroy the captured stdout and unref the process handle (releaseChildHandles): a
      // grandchild that escaped the group and holds the pipe's write end would otherwise keep
      // the harness's event loop alive though the probe already has its answer.
      releaseChildHandles(child);
      resolve(result);
    };
    // Deadline or runaway output: kill the whole group, tear down the handles, and settle —
    // do not wait for a `'close'` the group may never deliver.
    const abort = (): void => {
      signalTree(child, "SIGKILL");
      settle(null);
    };
    timer = setTimeout(abort, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      bytes += chunk.length;
      if (bytes > AUTH_CHECK_MAX_OUTPUT_BYTES) abort();
    });
    child.on("error", () => settle(null));
    child.on("close", (code) => settle({ code, stdout: out }));
  });
}

/** The default credential probe: run the resolved agent binary's own auth check for one
 * provider and read `ready` out of its JSON. The binary resolves exactly as the spawn does
 * (resolveAgentBin — the same source a real tick would launch), so doctor tests the auth of
 * the pi it would actually run. Never throws; every failure mode lands on "unknown". The
 * bounded subprocess is boundedProbe above, shared with the claude probes. */
export async function piProviderAuth(
  config: TumwaterConfig,
  provider: string,
  pathEnv: string = envPath(),
  timeoutMs: number = AUTH_CHECK_TIMEOUT_MS,
): Promise<ProviderAuth> {
  const resolved = resolveAgentBin(config);
  const result = await boundedProbe(
    resolved.bin,
    ["auth", "check", "--provider", provider, "--json"],
    childEnv({ PATH: pathEnv }),
    timeoutMs,
  );
  if (result === null) return "unknown";
  if (result.code !== 0) return "unknown";
  // An unreadable reply is unknown, never not-ready (which would blame the credentials).
  const doc = parseJsonObject(result.stdout);
  if (doc === null) return "unknown";
  if (doc.ready === true) return "ready";
  if (doc.ready === false) return "not-ready";
  return "unknown";
}

/** One bounded probe of the resolved `claude` binary under the scrubbed run environment a real
 * tick gets: resolve the binary through the claude adapter that would spawn it and run `args`
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
  const env = claudeEnv(childEnv({ PATH: pathEnv }), { quietTimeoutSeconds: 0 });
  return boundedProbe(resolved.bin, args, env, timeoutMs);
}

/** Run `claude auth status` under the same scrubbed environment a real run gets (claudeEnv),
 * or null when the probe could not run or its reply was unreadable. */
async function claudeAuthProbe(
  config: TumwaterConfig,
  pathEnv: string,
  timeoutMs: number,
): Promise<ClaudeAuthStatus | null> {
  const result = await claudeProbe(config, ["auth", "status"], pathEnv, timeoutMs);
  if (result === null || result.code !== 0) return null;
  return parseClaudeAuthStatus(result.stdout);
}

/** claude credential readiness (plans/agent-backends.md "Every seam, checked"): a claude seam
 * whose login is gone fails every tick before it can work, so doctor runs `claude auth status`
 * under the scrubbed run environment and fails when it reports `loggedIn: false`. An ok detail
 * names the billing the reply implies — the subscription type, or an API key — so an operator
 * telling subscription spend from API spend does not have to run the command themselves. A
 * probe that could not run or a reply this cannot read warns rather than guesses. Stands down
 * (ok) when no seam routes to claude, so a pi-only fleet spawns nothing. */
export async function checkClaudeAuth(
  root: string,
  pathEnv: string = envPath(),
  timeoutMs: number = AUTH_CHECK_TIMEOUT_MS,
): Promise<CheckOutcome> {
  const loaded = loadConfigForCheck(root);
  if ("outcome" in loaded) return loaded.outcome;
  const { config } = loaded;
  if (!claudeSeamsInUse(config)) return okOutcome("no claude seams configured");
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

/** The dotted version in `claude --version`'s output, or undefined when it names none. */
function parseClaudeCliVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

/** claude CLI-version readiness (plans/agent-backends.md finding 9): an installed CLI below a
 * configured model's minimum fails or misprices that model, and fleet runs disable the
 * auto-updater, so the version an operator has is the version ticks run. Fails below the
 * highest floor among the claude-routed models, naming which model needs it; an ok detail
 * prints the installed version and the floor it satisfied (or no floor when none applies).
 * The `off`/`minimal` thinking clamp is noted here too, since this check already has the
 * claude seams in hand. Stands down when no seam routes to claude. */
export async function checkClaudeVersion(
  root: string,
  pathEnv: string = envPath(),
  timeoutMs: number = AUTH_CHECK_TIMEOUT_MS,
): Promise<CheckOutcome> {
  const loaded = loadConfigForCheck(root);
  if ("outcome" in loaded) return loaded.outcome;
  const { config } = loaded;
  const seams = seamPairs(config).filter((pair) => pair.agent === "claude" && pair.model !== undefined);
  if (seams.length === 0) return okOutcome("no claude seams configured");
  // The floor each configured model needs; a model the adapter does not gate contributes none.
  const floors = new Map<string, string>();
  for (const seam of seams) {
    const min = claudeBackend.minVersion?.(seam.model!);
    if (min !== undefined) floors.set(seam.model!, min);
  }
  const result = await claudeProbe(config, ["--version"], pathEnv, timeoutMs);
  const found = result !== null && result.code === 0 ? parseClaudeCliVersion(result.stdout) : undefined;
  if (found === undefined)
    return warnOutcome("could not check — `claude --version` did not run or its output was unreadable");
  const clamped = seams.some((seam) => seam.thinking === "off" || seam.thinking === "minimal");
  const clampNote = clamped
    ? "; `off`/`minimal` thinking clamps to `--effort low` (claude has no lower setting)"
    : "";
  if (floors.size === 0) return okOutcome(`claude ${found}${clampNote}`);
  // The highest floor decides: whichever model needs the newest CLI. Below it, fail and name
  // that model; at or above, print the version against the floor.
  let required = "";
  let neededBy = "";
  for (const [model, min] of floors) {
    if (required === "" || belowNodeFloor(required, `>=${min}`)) {
      required = min;
      neededBy = model;
    }
  }
  if (belowNodeFloor(found, `>=${required}`))
    return failOutcome(`claude ${found} is older than ${required} required by ${neededBy} — run \`claude update\``);
  return okOutcome(`claude ${found} (>= ${required} for ${neededBy})${clampNote}`);
}

/** Declared model readiness — plans/model-tiers.md "Doctor" (part 7c/8): every model the
 * config can put on a seam must resolve in pi's definitions, and its provider must report
 * `ready` from the agent binary's own auth check. A strong tier pi cannot resolve would fail
 * every review, and so every landing — the check exists so the operator finds out before the
 * fleet does, mid-review. Pairs collected in the same sweep fleetModelsFree prices: each
 * tier's top-level selector (a string is default's), every enabled role's resolved pair
 * (per-role overrides included; tier-name overrides resolve through configForRole), and the
 * reviewer's while review is on. A pair with no model is pi's own default and out of scope;
 * fallback pairs are the sibling check's (checkFallbackModel prices the cap pair). Levels:
 * an unresolvable pair fails, a provider that is not ready warns (credentials are fixable
 * without a config edit), a probe that cannot run warns rather than guesses, and a priced
 * model whose cache reads declare $0 warns — the daily budget would undercount it
 * (BUGS.md 2026-10-06). When one of
 * PI_SMOL_MODEL / PI_SLOW_MODEL / PI_PLAN_MODEL is set the check also reports that tumwater
 * does not read it — the variables are oh-my-pi's, pi ignores them, and with omp as
 * `agentBin` they still reach omp through the inherited environment (src/pi/pi-backend.ts,
 * built on src/process/run-marker.ts's agentBaseEnv) — pointing at the tier keys that do the
 * same job (`model.small` / `model.strong`). `auth` is
 * injectable so tests need no pi on PATH; `env` so the PI_* branches stay hermetic. */
export async function checkTierModels(
  root: string,
  modelsPath: string = piModelsPath(),
  auth: (provider: string) => Promise<ProviderAuth> = (provider) =>
    piProviderAuth(loadConfigSafe(root).config ?? defaultConfig(), provider),
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckOutcome> {
  const loaded = loadConfigForCheck(root);
  if ("outcome" in loaded) return loaded.outcome;
  const { config } = loaded;
  const pairs = new Map<string, { provider?: string; model?: string }>();
  const claudeModels = new Set<string>();
  const add = (
    agent: string | undefined,
    provider: string | undefined,
    model: string | undefined,
  ) => {
    if (model === undefined) return;
    // A non-pi backend's models are not in pi's definitions, so they are not swept for
    // resolution or auth here — the claude checks cover them instead.
    if (agent !== undefined && agent !== "pi") {
      claudeModels.add(model);
      return;
    }
    pairs.set(`${provider ?? ""}/${model}`, { provider, model });
  };
  for (const pair of seamPairs(config)) add(pair.agent, pair.provider, pair.model);
  const ompVars = ["PI_SMOL_MODEL", "PI_SLOW_MODEL", "PI_PLAN_MODEL"].filter(
    (v) => env[v] !== undefined && env[v] !== "",
  );
  const ompNote =
    ompVars.length === 0
      ? ""
      : ` — ${ompVars.join(" and ")} ${agree(ompVars.length, "is", "are")} set: tumwater does not read ${agree(ompVars.length, "it", "them")} (oh-my-pi's variables; pi ignores them; with omp as agentBin they still reach omp through the inherited environment) — set model.small / model.strong instead`;
  if (pairs.size === 0 && claudeModels.size === 0)
    return (ompVars.length === 0 ? okOutcome : warnOutcome)(`no models declared — every seam uses pi's own default${ompNote}`);
  const providers = readPiProviders(modelsPath);
  const fails: string[] = [];
  const warns: string[] = [];
  // Reserved agent ids: a pi provider whose name is an agent backend's id can never reach pi
  // (the provider segment wins the routing), so its definitions are unreachable — warn.
  if (providers) {
    const reserved = [...providers.keys()].filter(isAgentId);
    if (reserved.length > 0)
      warns.push(
        `pi's definitions (${modelsPath}) declare provider ${reserved.map((p) => `"${p}"`).join(", ")} — the name is reserved for an agent backend, so selectors under it never reach pi`,
      );
  }
  if (pairs.size > 0 && !providers)
    return warnOutcome(`cannot check — could not read pi's model definitions at ${modelsPath}${ompNote}`);
  const readyProviders = new Set<string>();
  const checkedProviders = new Set<string>();
  for (const { provider, model } of pairs.values()) {
    if (provider === undefined) {
      warns.push(`${model} names no provider — pi resolves it with its own default, tumwater cannot verify it`);
      continue;
    }
    const defs = providers?.get(provider);
    if (!defs) {
      fails.push(`provider ${provider} is not in pi's definitions (${modelsPath})`);
      continue;
    }
    const def = defs.find((d) => d.id === model);
    if (!def) {
      // No exact entry: pi clones the provider's default model for the id, inheriting that
      // default's price and context window (BUGS.md 2026-10-06) — name that consequence
      // instead of only the failed lookup.
      fails.push(
        `${provider}/${model} does not resolve in pi's definitions (${modelsPath}) — pi would price it at the provider default's rates and context window`,
      );
      continue;
    }
    if (cacheReadUnpriced(providers, provider, model)) {
      // A priced model whose cache reads declare $0: pi bills cache-read tokens at zero and
      // the daily budget undercounts the real spend (BUGS.md 2026-10-06).
      warns.push(`${provider}/${model} prices cache reads at $0 — the daily budget will undercount its spend`);
    }
    if (!checkedProviders.has(provider)) {
      checkedProviders.add(provider);
      const verdict = await auth(provider);
      if (verdict === "ready") readyProviders.add(provider);
      else if (verdict === "not-ready")
        warns.push(`provider ${provider} reports not ready — check its credentials`);
      else warns.push(`could not verify provider ${provider} — the auth check did not run or its output was unreadable`);
    }
  }
  const found = [...fails, ...warns].join("; ");
  const resolvedPi = `${pairs.size} declared ${agree(pairs.size, "model", "models")} resolve${readyProviders.size > 0 ? ` and ${agree(readyProviders.size, "provider", "all providers")} ${[...readyProviders].sort().join(", ")} report ready` : ""}`;
  const claudeNote =
    claudeModels.size > 0
      ? `${claudeModels.size} claude-routed ${agree(claudeModels.size, "model", "models")} — resolved by the claude backend, not pi's definitions`
      : "";
  const base =
    fails.length === 0 && warns.length === 0
      ? [pairs.size > 0 ? resolvedPi : "", claudeNote].filter(Boolean).join("; ")
      : found;
  if (fails.length > 0) return failOutcome(`${base}${ompNote}`);
  return (warns.length > 0 || ompVars.length > 0 ? warnOutcome : okOutcome)(`${base}${ompNote}`);
}
