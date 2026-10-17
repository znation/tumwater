// vocabulary: plain
import { childEnv } from "../process/process.js";
import { boundedProbe } from "./probe.js";
import { enabledRoleIds, defaultConfig, loadConfigSafe } from "../config/config.js";
import { configForRole } from "../config/config-views.js";
import { fallbackPair, resolveTierFallbacks, seamsInUse, tierChainSteps } from "../config/config-fallbacks.js";
import { cacheReadUnpriced, fallbackModelPair, piModelsPath, piPairFree, piProviderBaseUrl, readPiProviders, type PiModelDef } from "../pi/pi-models.js";
import { MODEL_TIERS, type FallbackModelConfig, type TumwaterConfig } from "../config/config-schema.js";
import { isAgentId } from "../config/model-selector.js";
import { imageReroute, seamImageInput } from "../agent/image-input.js";
import { modelLabel, usesPiModels } from "../agent/backend-traits.js";
import { agentBackend } from "../agent/agent-backend.js";
import {
  imageProbeEntryFresh,
  imageProbeKey,
  readImageProbeCache,
  runImageProbe,
  writeImageProbeCache,
  type ImageProbeResult,
} from "./image-probe.js";
import { claudeBackend } from "../agent/claude/claude-backend.js";
import { claudeAuthUsesSubscription, parseClaudeAuthStatus, readClaudeAccount, type ClaudeAccount, type ClaudeAuthStatus } from "../agent/claude/claude-account.js";
import { claudeEnv } from "../agent/claude/claude-env.js";
import { parseJsonObject } from "../files/json-object.js";
import { envPath } from "../files/files.js";
import { modelPairName, pairDailyCost } from "../budget/budget.js";
import { usd, usdCap } from "../text/format.js";
import { loadLoopStates } from "./doctor-holds.js";
import { resolveAgentBin } from "../pi/pi-bin.js";
import { agree } from "../text/phrases.js";
import { formatDate, formatTime } from "../text/datetime.js";
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
 * roles pause at the cap exactly as if no fallback existed. That refusal is the right runtime
 * behavior (spend must never climb past the cap), but a typo'd id would otherwise surface only
 * after the day's budget is already spent — so doctor checks it up front, before the operator
 * needs it. Read-only: it inspects pi's definitions file, never pi or the network. A price is not
 * readiness, though: whether the backend can SERVE is known only from the fallback's own ticks
 * (src/budget/fallback-breaker.ts's breaker, BUGS.md 2026-09-20), so a free pair reads "serving not
 * verified" — unless the running orchestrator has published that its breaker demoted the pair
 * (`demoted`, from orchestrator.json; runDoctor passes it only while that orchestrator is alive),
 * which warns with the failure count and the next probe time. No fallbackModel configured is
 * informational, not a warning — plenty of teams intend to stop at the cap. `modelsPath` is
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
  if (!declared) return okOutcome("none configured — roles pause at the cap");
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
      return warnOutcome(`${name} is priced at zero but not serving — the running team demoted it after ${demoted.failures} consecutive failed runs, so roles pause at the cap; one probe run retries it from ${formatTime(new Date(demoted.probeAt))}`);
    return okOutcome(`${name} — priced at zero (cost n/a), serving not verified`);
  }
  return warnOutcome(`${nameOf(declared)} is not priced at zero in ${modelsPath} — at the cap roles pause instead of switching`);
}

/** Whether a local server answers `GET <url>`: node's built-in fetch with a short timeout, false
 * on any failure — doctor is a pre-flight, not a place to wait out a hung server. */
async function probeModels(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const isLocalUrl = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
};

/** The `fallback chain` check: one fragment per step of every tier's chain saying whether the
 * step can run now — a local pi server that does not answer (warn), a step whose own daily cap is
 * spent, a free pair, a claude step with its billing, or a priced pair. Reads config, pi's
 * models.json and the loop states; only a pi step on 127.0.0.1/localhost makes a network
 * request. `probe` is injectable so tests need no real server. */
export async function checkFallbackChain(
  root: string,
  modelsPath: string = piModelsPath(),
  probe: (url: string) => Promise<boolean> = probeModels,
): Promise<CheckOutcome> {
  const loaded = loadConfigForCheck(root);
  if ("outcome" in loaded) return loaded.outcome;
  const { config } = loaded;
  const steps = tierChainSteps(config);
  if (steps.length === 0) return okOutcome("none configured");
  const states = loadLoopStates(root, config);
  const providers = readPiProviders(modelsPath);
  const account = readClaudeAccount(root);
  const now = Date.now();
  let down = false;
  const fragments: string[] = [];
  for (const { tier, step, pair } of steps) {
    // A provider that names a backend other than pi (claude today; opencode from part 2) never
    // asks pi for a base URL or runs pi's price probe — only a pi step may.
    const nonPiBackend = isAgentId(pair.provider) && pair.provider !== "pi";
    const base = !nonPiBackend && pair.provider ? piProviderBaseUrl(modelsPath, pair.provider) : null;
    const local = base !== null && isLocalUrl(base);
    const up = local ? await probe(`${base}/models`) : null;
    const cap = pair.maxDailyCostUsd;
    const spent = cap !== undefined ? pairDailyCost(states, modelPairName(pair), now) : 0;
    let verdict: string;
    if (up === false) {
      down = true;
      verdict = `not running (GET ${base}/models failed)`;
    } else if (cap !== undefined && spent >= cap) {
      verdict = `cap reached (${usd(spent)}/${usdCap(cap)})`;
    } else if (nonPiBackend) {
      verdict = `claude ${pair.extraUsage ? "extra usage" : (account?.billing ?? "billing unknown")}`;
    } else if (piPairFree(providers, pair.provider, pair.model, account)) {
      verdict = up ? "free · server up" : "free";
    } else {
      verdict = cap !== undefined ? `priced, ${usd(spent)}/${usdCap(cap)} today` : "priced, team cap only";
    }
    fragments.push(`${tier} ${step + 1}: ${pair.provider ?? "?"}/${pair.model ?? "?"} — ${verdict}`);
  }
  const detail = fragments.join("; ");
  return down ? warnOutcome(detail) : okOutcome(detail);
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
 * thinking level its selector carried. Collected the same way teamModelsFree sweeps — each
 * tier, every enabled role, and the reviewer — so doctor and the budget see the same seams. */
interface SeamPair {
  agent: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  thinking: string | undefined;
}

/** Every model a seam can run, paired with its backend (plans/agent-backends.md "Config"): the
 * distinct pairs of the one seamsInUse list — every enabled role, the review gate, the
 * resolver, the director, and each tier's budget/model-failure fallback — so a claude or pi
 * pair that exists only as a fallback is checked exactly like a primary one. Deduplicated by
 * backend/provider/model, so a model reached through several surfaces is checked once. */
function seamPairs(config: TumwaterConfig): SeamPair[] {
  const pairs = new Map<string, SeamPair>();
  for (const seam of seamsInUse(config)) {
    if (seam.model === undefined) continue;
    pairs.set(`${seam.agent ?? ""}\0${seam.provider ?? ""}\0${seam.model}`, {
      agent: seam.agent,
      provider: seam.provider,
      model: seam.model,
      thinking: seam.thinking,
    });
  }
  return [...pairs.values()];
}

/** Whether any seam runs on the claude backend — the doctor's claude checks stand down when
 * none does (a pi-only team reads no `~/.claude` state and spawns no claude). */
export function claudeSeamsInUse(config: TumwaterConfig): boolean {
  return seamPairs(config).some((pair) => pair.agent === "claude");
}

/** The default credential probe: run the resolved agent binary's own auth check for one provider
 * and read `ready` out of its JSON. The binary resolves exactly as the spawn does (resolveAgentBin
 * — the same source a real tick would launch), so doctor tests the auth of the pi it would actually
 * run. Never throws; every failure mode ends on "unknown". The bounded subprocess is the shared
 * boundedProbe (probe.ts), also used by the claude probes. */
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
    AUTH_CHECK_MAX_OUTPUT_BYTES,
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
 * whose login is gone fails every tick before it can work, so doctor runs `claude auth status`
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
  const loaded = loadConfigForCheck(root);
  if ("outcome" in loaded) return loaded.outcome;
  const { config } = loaded;
  if (!claudeSeamsInUse(config)) return okOutcome("no model jobs run on claude");
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
  const loaded = loadConfigForCheck(root);
  if ("outcome" in loaded) return loaded.outcome;
  const { config } = loaded;
  if (!claudeSeamsInUse(config)) return okOutcome("no model jobs run on claude");
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

/** The dotted version in `claude --version`'s output, or undefined when it names none. */
function parseClaudeCliVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

/** claude CLI-version readiness (plans/agent-backends.md finding 9): an installed CLI below a
 * configured model's minimum fails or misprices that model, and team runs disable the
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
  if (seams.length === 0) return okOutcome("no model jobs run on claude");
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

/** Declared model readiness — plans/model-tiers.md "Doctor" (part 7c/8): every model the config can
 * put on a seam must resolve in pi's definitions, and its provider must report `ready` from the
 * agent binary's own auth check. A strong tier pi cannot resolve would fail every review, and so
 * every merge — the check exists so the operator finds out before the team does, mid-review. Pairs
 * collected in the same sweep teamModelsFree prices: each tier's top-level selector (a string is
 * default's), every enabled role's resolved pair (per-role overrides included; tier-name overrides
 * resolve through configForRole), and the reviewer's while review is on. A pair with no model is
 * pi's own default and out of scope; fallback pairs are the sibling check's (checkFallbackModel
 * prices the cap pair). Levels: an unresolvable pair fails, a provider that is not ready warns
 * (credentials are fixable without a config edit), a probe that cannot run warns rather than
 * guesses, and a priced model whose cache reads declare $0 warns — the daily budget would
 * undercount it (BUGS.md 2026-10-06). When one of PI_SMOL_MODEL / PI_SLOW_MODEL / PI_PLAN_MODEL is
 * set the check also reports that tumwater does not read it — the variables are oh-my-pi's, pi
 * ignores them, and with omp as `agentBin` they still reach omp through the inherited environment
 * (src/pi/pi-backend.ts, built on src/process/run-marker.ts's agentBaseEnv) — pointing at the tier
 * keys that do the same job (`model.small` / `model.strong`). `auth` is injectable so tests need no
 * pi on PATH; `env` so the PI_* branches stay hermetic. */
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
  // Routed (non-pi) models keyed by the backend they resolved to, so the routing note names
  // each backend correctly; opencode is not claude.
  const routedModels = new Map<string, Set<string>>();
  const add = (
    agent: string | undefined,
    provider: string | undefined,
    model: string | undefined,
  ) => {
    if (model === undefined) return;
    // A non-pi backend's models are not in pi's definitions, so they are not swept for
    // resolution or auth here — the backend's own checks cover them instead.
    if (agent !== undefined && agent !== "pi") {
      let models = routedModels.get(agent);
      if (models === undefined) routedModels.set(agent, (models = new Set()));
      models.add(model);
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
  if (pairs.size === 0 && routedModels.size === 0)
    return (ompVars.length === 0 ? okOutcome : warnOutcome)(`no models declared — every model job uses pi's own default${ompNote}`);
  const providers = readPiProviders(modelsPath);
  const fails: string[] = [];
  const warns: string[] = [];
  // Reserved agent ids: a pi provider whose name is an agent backend's id can never reach pi
  // (the provider segment wins the routing), so its definitions are unreachable — warn.
  if (providers) {
    const reserved = [...providers.keys()].filter(isAgentId);
    if (reserved.length > 0)
      warns.push(
        `pi's definitions (${modelsPath}) declare provider ${reserved.map((p) => `"${p}"`).join(", ")} — the name is reserved for an agent backend, so model ids under it never reach pi`,
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
    // A Claude model routed to pi (plans/provider-concurrency.md "Routing a bare Claude model id
    // to claude"): a named provider keeps it on pi, but since Anthropic's 2026-04-04
    // third-party-harness change a Claude plan's limits cover only first-party tools, so it is
    // billed per token even under a Claude subscription login — the bare `claude-…` form on the
    // claude CLI uses the plan's included usage instead.
    if (model?.startsWith("claude-")) {
      warns.push(`${provider}/${model} runs on pi and is billed per token, not the Claude plan's included usage — use a bare claude-… id to route it to the claude CLI`);
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
  // One routing note per non-pi backend in use, so an opencode-routed model is never labeled
  // as claude's. The opencode note also carries the design §2 caveat that a bare `opencode/…`
  // id always means the OpenCode CLI, never pi's built-in `opencode` gateway.
  const routedNotes: string[] = [];
  for (const [agent, models] of routedModels) {
    const n = models.size;
    routedNotes.push(
      agent === "opencode"
        ? `${n} opencode-routed ${agree(n, "model", "models")} — \`opencode/…\` ids run on the OpenCode CLI, and pi's built-in \`opencode\` provider is not reachable from tumwater`
        : `${n} claude-routed ${agree(n, "model", "models")} — resolved by the claude backend, not pi's definitions`,
    );
  }
  const routedText = routedNotes.length > 0 ? routedNotes.join("; ") : "";
  const base =
    fails.length === 0 && warns.length === 0
      ? [pairs.size > 0 ? resolvedPi : "", routedText].filter(Boolean).join("; ")
      : found;
  if (fails.length > 0) return failOutcome(`${base}${ompNote}`);
  return (warns.length > 0 || ompVars.length > 0 ? warnOutcome : okOutcome)(`${base}${ompNote}`);
}

/** The doctor's image-input capability check (plans/image-input.md "Doctor", parts 1-2/5):
 * which of the team's seams claim to read images, and whether every text-only enabled loop can
 * reroute to one that does. Part 2 adds the live probe — with `probeImages` "missing" (the
 * terminal `tumwater doctor` default) each claimed pi model with no fresh cached verdict is
 * shown a real image and the answer is checked; with "all" (the `--reprobe` flag) every claimed
 * model is re-probed; with "never" (the TUI Health tab and the GUI doctor endpoint) nothing is
 * spawned and only cached verdicts are read, so a refresh never spends a model call. claude
 * seams are never probed — every Claude model reads images, and a probe would spend subscription
 * window to confirm it.
 *
 * Covers the same seams as `tier models` (seamPairs — the tiers, enabled roles and the
 * reviewer) plus the tiers' fallback pairs (the reroute part picks its target among them, so a
 * text-only fallback would promise a reroute no fallback can serve). A claimed model whose probe
 * failed (fresh verdict) is dropped from the readers and reads false from seamImageInput, so the
 * reroute sweep never sends a text-only loop to a model that lost its probe. `providers`,
 * `account`, `pathEnv` and `probe` are injectable so tests need no real pi install or account. */
export async function checkImageInput(
  root: string,
  modelsPath: string = piModelsPath(),
  providers: Map<string, PiModelDef[]> | null = readPiProviders(modelsPath),
  account?: ClaudeAccount | null,
  probeImages: "missing" | "all" | "never" = "never",
  pathEnv: string = envPath(),
  probe: (
    config: TumwaterConfig,
    seam: { provider?: string; model: string; thinking?: string },
    env: NodeJS.ProcessEnv,
  ) => Promise<ImageProbeResult> = runImageProbe,
): Promise<CheckOutcome> {
  const loaded = loadConfigForCheck(root);
  if ("outcome" in loaded) return loaded.outcome;
  const { config } = loaded;
  // `tier models` already fails on a missing/unknown pair, so this check names only what it can
  // answer; unknown (null) pairs are left to that check. A missing definitions file only blocks
  // this check when a seam actually needs it — an all-claude team reads images without it.
  const accountNow = account === undefined ? readClaudeAccount(root) : account;
  const pairs = seamPairs(config);
  const needsDefinitions = pairs.some((p) => usesPiModels(p.agent ?? "pi"));
  if (providers === null && needsDefinitions)
    return warnOutcome(`cannot check — could not read pi's model definitions at ${modelsPath}`);
  const label = modelLabel;
  // The catalog claims (raw `input`, ignoring the cache): what to probe and report, including a
  // model whose earlier probe failed (it must still be named and re-probed by --reprobe).
  const claimed = new Map<string, { agent?: string; provider?: string; model: string; thinking?: string }>();
  for (const pair of pairs) {
    if (pair.model === undefined) continue;
    if (seamImageInput(pair, providers) === true)
      claimed.set(imageProbeKey(pair.agent, pair.provider, pair.model), {
        agent: pair.agent,
        provider: pair.provider,
        model: pair.model,
        thinking: pair.thinking,
      });
  }
  // The tiers' fallback pairs: a reroute target must itself read images to help, and part 4's
  // fallback regime picks among these, so a text-only fallback team is a coverage gap here.
  const resolved = resolveTierFallbacks(config, (p: FallbackModelConfig) =>
    piPairFree(providers, p.provider, p.model, accountNow),
  );
  for (const tier of MODEL_TIERS) {
    const pair = resolved[tier].pair;
    if (pair?.model === undefined) continue;
    // Fallback pairs are always pi (FallbackModelConfig has no agent), and the readers
    // (seamImageInput, imageReroute) resolve a pi seam to the "pi" agent, so the cache key
    // must carry "pi" — keying it `undefined` would write a verdict the readers never read.
    const agent = "pi";
    if (seamImageInput(pair, providers) === true)
      claimed.set(imageProbeKey(agent, pair.provider, pair.model), {
        agent,
        provider: pair.provider,
        model: pair.model,
        thinking: pair.thinking,
      });
  }
  const probes = readImageProbeCache(root);
  const now = Date.now();
  const env = childEnv({ PATH: pathEnv });
  const readsItems: string[] = [];
  const failed: string[] = [];
  const couldNot: string[] = [];
  let probedAny = false;
  // Settle one claimed seam: probe when asked and uncached, read a fresh cached verdict
  // otherwise, or report "not verified yet". Only pass/fail are cached; could-not-verify is
  // reported but never cached.
  for (const seam of claimed.values()) {
    const agent = seam.agent;
    // A backend that registers an imageInput hook trusts the hook (claude today, which reads
    // every model); a backend without one is probed through its model catalog.
    if (agent !== undefined && agentBackend(agent)?.imageInput !== undefined) {
      readsItems.push(label(agent, seam.provider, seam.model));
      continue;
    }
    const key = imageProbeKey(agent, seam.provider, seam.model);
    const cached = probes[key];
    const valid = imageProbeEntryFresh(cached, now);
    const wantProbe = probeImages !== "never" && (probeImages === "all" || !valid);
    if (wantProbe) {
      probedAny = true;
      const result = await probe(config, { provider: seam.provider, model: seam.model, thinking: seam.thinking }, env);
      if (result.verdict === "pass") {
        probes[key] = { verdict: "pass", detail: result.detail, at: now, claim: true };
        readsItems.push(`${label(agent, seam.provider, seam.model)} (verified ${formatDate(new Date(now))})`);
      } else if (result.verdict === "fail") {
        probes[key] = { verdict: "fail", detail: result.detail, at: now, claim: true };
        failed.push(`${label(agent, seam.provider, seam.model)} failed the image probe — ${result.detail}`);
      } else {
        couldNot.push(`${label(agent, seam.provider, seam.model)} could not be verified — ${result.detail}`);
      }
    } else if (cached && imageProbeEntryFresh(cached, now)) {
      if (cached.verdict === "pass") {
        readsItems.push(`${label(agent, seam.provider, seam.model)} (verified ${formatDate(new Date(cached.at))})`);
      } else {
        failed.push(`${label(agent, seam.provider, seam.model)} failed the image probe — ${cached.detail}`);
      }
    } else {
      readsItems.push(`${label(agent, seam.provider, seam.model)} (not verified yet — run \`tumwater doctor\`)`);
    }
  }
  if (probedAny) writeImageProbeCache(root, probes);
  // Text-only enabled loops: which can reroute to a tier that reads images (honoring failed
  // probes), and which cannot.
  const reroutes: string[] = [];
  const noTarget: string[] = [];
  for (const role of enabledRoleIds(config)) {
    const rc = configForRole(config, role);
    if (rc.model === undefined) continue;
    if (seamImageInput(rc, providers, probes) !== false) continue; // reads images, or unknown (to tier models)
    const rr = imageReroute(config, role, "primary", modelsPath, accountNow, probes);
    if (rr && seamImageInput(rr.config, providers, probes) === true)
      reroutes.push(
        `${role} text-only (${label(rc.agent, rc.provider, rc.model)}) — reroutes to ${rr.tier} (${label(rr.config.agent, rr.config.provider, rr.config.model)})`,
      );
    else noTarget.push(`${role} text-only (${label(rc.agent, rc.provider, rc.model)})`);
  }
  // A team that declared no models at all leaves capability to pi's own defaults — the same
  // "nothing configured" stance as tier models, informational rather than a warning.
  const declared =
    pairs.some((p) => p.model !== undefined) ||
    MODEL_TIERS.some((t) => resolved[t].pair?.model !== undefined);
  if (!declared) return okOutcome("no models declared — every model job uses pi's own default");
  const readsLine =
    readsItems.length > 0 ? `reads images: ${[...readsItems].sort().join(", ")}` : "";
  const details = [readsLine, ...reroutes].filter(Boolean).join("; ");
  if (failed.length > 0)
    return failOutcome(
      `${failed.join("; ")} — remove "image" from its input in pi's models.json or fix the endpoint, then run \`tumwater doctor --reprobe\``,
    );
  if (couldNot.length > 0)
    return warnOutcome(`${couldNot.join("; ")}; ${details}`.replace(/;\s*$/, ""));
  if (noTarget.length > 0)
    return warnOutcome(
      `${noTarget.join("; ")} — no configured model reads images, so a run that reads an image fails; declare image input on a vision model in pi's models.json, or point a tier at one`,
    );
  if (readsItems.length === 0)
    return warnOutcome(
      "no configured model reads images — a run that reads an image fails; declare image input on a vision model in pi's models.json, or point a tier at one",
    );
  return okOutcome(details);
}
