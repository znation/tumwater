import { spawn } from "node:child_process";
import { childEnv, releaseChildHandles, signalTree } from "../process/process.js";
import { enabledRoleIds, defaultConfig, loadConfigSafe } from "../config/config.js";
import { configForRole, fallbackPair, reviewConfig, tierModel } from "../config/config-views.js";
import { cacheReadUnpriced, fallbackModelFree, piModelsPath, readPiProviders } from "../pi/pi-models.js";
import { MODEL_TIERS, type TumwaterConfig } from "../config/config-schema.js";
import { isJsonObject } from "../files/json-object.js";
import { envPath } from "../files/files.js";
import { resolveAgentBin } from "../pi/pi-bin.js";
import { agree } from "../text/phrases.js";
import { formatTime } from "../text/datetime.js";
import type { FallbackDemotion } from "../budget/fallback-breaker.js";
import type { CheckOutcome } from "./doctor-checks.js";

/** The doctor's model-readiness checks, split out of doctor-checks.ts (whose environment and
 * repo checks stay there): the cap fallback's price check (checkFallbackModel), the agent
 * binary's own credential probe (piProviderAuth), and the declared-tier resolution check
 * (checkTierModels). These three are the doctor's only checks that read pi's model definitions
 * and, for the credential probe, spawn the agent binary — a distinct concern from the
 * filesystem/git checks beside them, kept together so a change to how doctor reads models does
 * not touch the environment checks. The shared report contract (CheckOutcome) is type-imported
 * from doctor-checks.ts, exactly as doctor-orphans.ts and doctor-backlog.ts do. */

/** The config a readiness check reads, or the warn outcome a broken tumwater.json earns:
 * checkInit already fails on a broken config, so a model check only reports that it could not
 * run. One home for the guard and its wording, shared by checkFallbackModel and
 * checkTierModels (the same shape doctor-backlog.ts's readDocChecked uses for unreadable
 * files). */
function loadConfigForCheck(root: string): { config: TumwaterConfig } | { outcome: CheckOutcome } {
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) return { outcome: { level: "warn", detail: `cannot check — ${error}` } };
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
  const pair = fallbackPair(config);
  if (!pair) return { level: "ok", detail: "none configured — role loops pause at the cap" };
  // A pair missing either half would fall through to pi's own (unverified) default, so it can
  // never be free; naming that case beats rendering a bare "?/model".
  const name =
    pair.provider && pair.model ? `${pair.provider}/${pair.model}` : "a half-resolved pair";
  if (fallbackModelFree(config, modelsPath)) {
    if (demoted)
      return {
        level: "warn",
        detail: `${name} is priced at zero but not serving — the running fleet demoted it after ${demoted.failures} consecutive failed ticks, so role loops pause at the cap; one probe tick retries it from ${formatTime(new Date(demoted.probeAt))}`,
      };
    return { level: "ok", detail: `${name} — priced at zero (cost n/a), serving not verified` };
  }
  return {
    level: "warn",
    detail: `${name} is not priced at zero in ${modelsPath} — at the cap role loops pause instead of switching`,
  };
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

/** The default credential probe: run the resolved agent binary's own auth check for one
 * provider and read `ready` out of its JSON. The binary resolves exactly as the spawn does
 * (resolveAgentBin — the same source a real tick would launch), so doctor tests the auth of
 * the pi it would actually run. Never throws; every failure mode lands on "unknown".
 *
 * The probe's wall-clock is enforced by the probe itself, not only by a signal: the child runs
 * detached, and at `timeoutMs` (or when its output passes AUTH_CHECK_MAX_OUTPUT_BYTES) its
 * whole process group is SIGKILLed AND the promise settles as "unknown" with the stdout pipe
 * destroyed. Killing alone is not enough — `'close'` waits for the stdio pipes to close, so a
 * child stuck in an uninterruptible sleep, or one that left a grandchild holding the pipes
 * open, would otherwise leave the promise pending forever and hang `tumwater doctor` past its
 * own deadline (the same trap git-run.ts's bounded spawn closes for git). `timeoutMs` is a
 * test seam; production callers leave it unset. */
export async function piProviderAuth(
  config: TumwaterConfig,
  provider: string,
  pathEnv: string = envPath(),
  timeoutMs: number = AUTH_CHECK_TIMEOUT_MS,
): Promise<ProviderAuth> {
  const resolved = resolveAgentBin(config);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolved.bin, ["auth", "check", "--provider", provider, "--json"], {
        cwd: process.cwd(),
        // Detached so the deadline's signalTree reaches a grandchild too; stderr is ignored
        // rather than piped, since nothing reads it and a full stderr pipe would block the
        // child until the deadline.
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: childEnv({ PATH: pathEnv }),
      });
    } catch {
      resolve("unknown");
      return;
    }
    let out = "";
    let bytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (auth: ProviderAuth): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // Destroy the captured stdout and unref the process handle (releaseChildHandles): a
      // grandchild that escaped the group and holds the pipe's write end would otherwise keep
      // the harness's event loop alive though the probe already has its answer.
      releaseChildHandles(child);
      resolve(auth);
    };
    // Deadline or runaway output: kill the whole group, tear down the handles, and settle —
    // do not wait for a `'close'` the group may never deliver.
    const abort = (): void => {
      signalTree(child, "SIGKILL");
      settle("unknown");
    };
    timer = setTimeout(abort, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      bytes += chunk.length;
      if (bytes > AUTH_CHECK_MAX_OUTPUT_BYTES) abort();
    });
    child.on("error", () => settle("unknown"));
    child.on("close", (code) => {
      try {
        const doc: unknown = JSON.parse(out);
        const ready = isJsonObject(doc) && doc.ready;
        if (code === 0 && ready === true) settle("ready");
        else if (code === 0 && ready === false) settle("not-ready");
        else settle("unknown");
      } catch {
        settle("unknown");
      }
    });
  });
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
 * `agentBin` they still reach omp through the inherited environment (src/pi/pi.ts) — pointing
 * at the tier keys that do the same job (`model.small` / `model.strong`). `auth` is
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
  const add = (provider: string | undefined, model: string | undefined) => {
    if (model !== undefined) pairs.set(`${provider ?? ""}/${model}`, { provider, model });
  };
  for (const tier of MODEL_TIERS) {
    const sel = tierModel(config, tier);
    if (sel) add(sel.provider, sel.model);
  }
  for (const role of enabledRoleIds(config)) {
    const rc = configForRole(config, role);
    add(rc.provider, rc.model);
  }
  if (config.review.enabled) {
    const rv = reviewConfig(config);
    add(rv.provider, rv.model);
  }
  const ompVars = ["PI_SMOL_MODEL", "PI_SLOW_MODEL", "PI_PLAN_MODEL"].filter(
    (v) => env[v] !== undefined && env[v] !== "",
  );
  const ompNote =
    ompVars.length === 0
      ? ""
      : ` — ${ompVars.join(" and ")} ${agree(ompVars.length, "is", "are")} set: tumwater does not read ${agree(ompVars.length, "it", "them")} (oh-my-pi's variables; pi ignores them; with omp as agentBin they still reach omp through the inherited environment) — set model.small / model.strong instead`;
  if (pairs.size === 0)
    return { level: ompVars.length === 0 ? "ok" : "warn", detail: `no models declared — every seam uses pi's own default${ompNote}` };
  const providers = readPiProviders(modelsPath);
  if (!providers)
    return {
      level: "warn",
      detail: `cannot check — could not read pi's model definitions at ${modelsPath}${ompNote}`,
    };
  const fails: string[] = [];
  const warns: string[] = [];
  const readyProviders = new Set<string>();
  const checkedProviders = new Set<string>();
  for (const { provider, model } of pairs.values()) {
    if (provider === undefined) {
      warns.push(`${model} names no provider — pi resolves it with its own default, tumwater cannot verify it`);
      continue;
    }
    const defs = providers.get(provider);
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
  const base =
    fails.length === 0 && warns.length === 0
      ? `${pairs.size} declared ${agree(pairs.size, "model", "models")} resolve${readyProviders.size > 0 ? ` and ${agree(readyProviders.size, "provider", "all providers")} ${[...readyProviders].sort().join(", ")} report ready` : ""}`
      : found;
  if (fails.length > 0) return { level: "fail", detail: `${base}${ompNote}` };
  return { level: warns.length > 0 || ompVars.length > 0 ? "warn" : "ok", detail: `${base}${ompNote}` };
}
