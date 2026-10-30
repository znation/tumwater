import { loadConfigForCheck } from "./doctor-model-checks.js";
import { fallbackPair, tierChainSteps } from "../config/config-fallbacks.js";
import { fallbackModelPair, piModelsPath, piPairFree, piProviderBaseUrl, readPiProviders, type PiModelDef } from "../pi/pi-models.js";
import type { FallbackModelConfig } from "../config/config-schema.js";
import { readClaudeAccount, type ClaudeAccount } from "../agent/claude/claude-account.js";
import { formatClock } from "../text/datetime.js";
import { loadRunnerStates } from "./doctor-holds.js";
import { modelPairName, pairDailyCost } from "../budget/budget.js";
import { usd, usdCap } from "../text/format.js";
import type { FallbackDemotion } from "../budget/fallback-breaker.js";
import { okOutcome, warnOutcome, type CheckOutcome } from "./doctor-outcome.js";

/** The doctor's cap-fallback checks, split out of doctor-model-checks.ts (whose seam framework
 * and declared-tier/image checks stay in a module whose per-backend provider checks live in
 * doctor-{claude,opencode,codex,pi}-checks.ts): the daily-cost budget's third state — whether
 * the configured fallback can really serve at the cap. checkFallbackModel prices the declared
 * fallback pair in pi's definitions, and checkFallbackChain reports one fragment per step of
 * every tier's chain saying whether that step can run now. Together they read config, pi's
 * model definitions and the role states, and are the only doctor checks concerned with the
 * budget's fallback — a distinct concern from the seam framework and declared-model checks,
 * kept separate so a change to fallback pricing does not touch how doctor reads seams. The
 * config guard (loadConfigForCheck) is imported from doctor-model-checks, exactly as the
 * per-backend modules import that file's seam framework. The shared report contract
 * (CheckOutcome) is imported from doctor-outcome.ts. */

/** Fallback model readiness — the daily-cost budget's third state (plans/fallback-model.md): with
 * `fallbackModel` set, pi's definitions must price that pair at zero or the gate refuses it and
 * roles pause at the cap exactly as if no fallback existed. That refusal is the right runtime
 * behavior (spend must never climb past the cap), but a typo'd id would otherwise surface only
 * after the day's budget is already spent — so doctor checks it up front, before the operator
 * needs it. Read-only: it inspects pi's definitions file, never pi or the network. A price is not
 * readiness, though: whether the backend can SERVE is known only from the fallback's own runs
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
  const config = loadConfigForCheck(root);
  if ("level" in config) return config;
  const declared = fallbackPair(config);
  if (!declared) return okOutcome("none configured — roles pause at the cap");
  // A pair missing either half would fall through to pi's own (unverified) default, so it can
  // never be free; naming that case beats rendering a bare "?/model". The free branch names
  // the price-resolved pair (a map with no `default` entry borrows another tier's), while the
  // refusal names the pair the operator declared.
  const nameOf = (pair: FallbackModelConfig) =>
    pair.provider && pair.model ? `${pair.provider}/${pair.model}` : "a half-resolved pair";
  // The claude account answer (6a/7); the fallback price lookup reads it only for "claude"
  // (part 2a/9).
  const account = readClaudeAccount(root);
  const accounts = (b: string) => (b === "claude" ? account : null);
  const free = fallbackModelPair(config, modelsPath, accounts);
  if (free) {
    const name = nameOf(free);
    if (demoted)
      return warnOutcome(`${name} is priced at zero but not serving — the running team demoted it after ${demoted.failures} consecutive failed runs, so roles pause at the cap; one probe run retries it from ${formatClock(demoted.probeAt)}`);
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

/** Which URL this step probes, and did it answer. A provider that names a backend other than
 * pi (claude today; opencode from part 2) never asks pi for a base URL or runs pi's price
 * probe — only a pi step may. Returns the step's backend-ness, the resolved base URL and
 * whether a local pi step answered; a non-local or non-pi step never probes (up stays null). */
async function resolveStepProbe(
  modelsPath: string,
  pair: FallbackModelConfig,
  probe: (url: string) => Promise<boolean>,
): Promise<{ nonPiBackend: boolean; base: string | null; up: boolean | null }> {
  const nonPiBackend = pair.backend !== undefined && pair.backend !== "pi";
  const base = !nonPiBackend && pair.provider ? piProviderBaseUrl(modelsPath, pair.provider) : null;
  const local = base !== null && isLocalUrl(base);
  const up = local ? await probe(`${base}/models`) : null;
  return { nonPiBackend, base, up };
}

/** The claude step's billing display: extra usage when the step follows an earlier claude
 * model, else the persisted account's billing answer (or unknowns when the account is absent). */
function claudeVerdict(extra: boolean | undefined, account: ClaudeAccount | null): string {
  return extra ? "extra usage" : (account?.billing ?? "billing unknown");
}

/** Why this step is not runnable now (or is, when no arm fires): the five-way verdict, and
 * whether the chain is down. The `up === false` arm is the only one that marks the chain down.
 * `accounts` prices a free/claude pair for the one claude account held by the caller. */
function stepVerdict(
  pair: FallbackModelConfig,
  ctx: {
    up: boolean | null;
    base: string | null;
    cap: number | undefined;
    spent: number;
    providers: Map<string, PiModelDef[]> | null;
    accounts: (backend: string) => ClaudeAccount | null;
  },
): { verdict: string; down: boolean } {
  const { up, base, cap, spent, providers, accounts } = ctx;
  if (up === false) {
    return { verdict: `not running (GET ${base}/models failed)`, down: true };
  } else if (cap !== undefined && spent >= cap) {
    return { verdict: `cap reached (${usd(spent)}/${usdCap(cap)})`, down: false };
  } else if (pair.backend !== undefined && pair.backend !== "pi") {
    return { verdict: `claude ${claudeVerdict(pair.extraUsage, accounts("claude"))}`, down: false };
  } else if (piPairFree(providers, pair, accounts)) {
    return { verdict: up ? "free · server up" : "free", down: false };
  }
  return {
    verdict: cap !== undefined ? `priced, ${usd(spent)}/${usdCap(cap)} today` : "priced, team cap only",
    down: false,
  };
}

/** One chain fragment's line: the tier, the 1-based step number and the step's pair and verdict. */
function chainFragment(tier: string, step: number, pair: FallbackModelConfig, verdict: string): string {
  return `${tier} ${step + 1}: ${pair.provider ?? "?"}/${pair.model ?? "?"} — ${verdict}`;
}

/** The `fallback chain` check: one fragment per step of every tier's chain saying whether the
 * step can run now — a local pi server that does not answer (warn), a step whose own daily cap is
 * spent, a free pair, a claude step with its billing, or a priced pair. Reads config, pi's
 * models.json and the role states; only a pi step on 127.0.0.1/localhost makes a network
 * request. `probe` is injectable so tests need no real server. */
export async function checkFallbackChain(
  root: string,
  modelsPath: string = piModelsPath(),
  probe: (url: string) => Promise<boolean> = probeModels,
): Promise<CheckOutcome> {
  const config = loadConfigForCheck(root);
  if ("level" in config) return config;
  const steps = tierChainSteps(config);
  if (steps.length === 0) return okOutcome("none configured");
  const states = loadRunnerStates(root, config);
  const providers = readPiProviders(modelsPath);
  const account = readClaudeAccount(root);
  // The free-ness lookup reads the one claude account held here (part 2a/9).
  const accounts = (b: string) => (b === "claude" ? account : null);
  const now = Date.now();
  let down = false;
  const fragments: string[] = [];
  for (const { tier, step, pair } of steps) {
    const { base, up } = await resolveStepProbe(modelsPath, pair, probe);
    const cap = pair.maxDailyCostUsd;
    const spent = cap !== undefined ? pairDailyCost(states, modelPairName(pair), now) : 0;
    const { verdict, down: isDown } = stepVerdict(pair, { up, base, cap, spent, providers, accounts });
    down ||= isDown;
    fragments.push(chainFragment(tier, step, pair, verdict));
  }
  const detail = fragments.join("; ");
  return down ? warnOutcome(detail) : okOutcome(detail);
}
