import { childEnv } from "../process/process.js";
import { AUTH_CHECK_MAX_OUTPUT_BYTES, AUTH_CHECK_TIMEOUT_MS, boundedProbe } from "./doctor-probe.js";
import { defaultConfig, loadConfigSafe } from "../config/config.js";
import { seamsInUse } from "../config/config-fallbacks.js";
import { cacheReadUnpriced, piModelsPath, readPiProviders, type PiModelDef } from "../pi/pi-models.js";
import { roleImageInfo } from "../agent/image-input.js";
import { readPiListedModels, type PiListedModels } from "../pi/pi-listed-models.js";
import { runnerIds } from "../roles/runner-ids.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { envPath } from "../files/files.js";
import { piListedModels, piProviderAuth, type ProviderAuth } from "./doctor-pi-checks.js";
import { agree } from "../text/phrases.js";
import { joinParts } from "../text/text.js";
import { failOutcome, okOutcome, warnOutcome, type CheckOutcome } from "./doctor-outcome.js";
import { belowNodeFloor } from "../version.js";

/** The one phrase a configured-models check uses when the config declares no models at all:
 * informational (capability falls to pi's own defaults), not a warning. Shared by
 * checkTierModels so the check words the same "nothing configured"
 * stance. */
const PHRASE_NO_MODELS_DECLARED =
  "no models declared — every model job uses pi's own default";

/** The one phrase a configured-models check uses when pi's definitions file could not be read
 * at all: the check cannot answer what it was asked, so it warns instead of guessing. Shared by
 * checkTierModels so the check words the "cannot check" stance
 * identically; each appends its own modelsPath after the shared stem, and checkTierModels
 * also appends its ompNote. */
const PHRASE_CANNOT_READ_MODELS = "cannot check — could not read pi's model definitions at ";

/** The doctor's model-readiness checks, split out of doctor-checks.ts (whose environment and
 * repo-setup checks stay there, and whose state/disk/build checks live in
 * doctor-project-checks.ts), and split apart again so one theme owns one module: this file holds
 * the shared config guard, the seam framework (seamPairs and the per-backend seam predicates),
 * and the declared-tier check (checkTierModels). The cap
 * fallback price and fallback-chain checks (checkFallbackModel, checkFallbackChain) live in
 * doctor-fallback-checks.ts, importing this file's loadConfigForCheck just as the per-backend
 * modules do. The claude, opencode, codex and pi provider checks live in their own per-backend
 * modules (doctor-claude-checks.ts, doctor-opencode-checks.ts, doctor-codex-checks.ts,
 * doctor-pi-checks.ts), each importing this file's shared seam framework and the AUTH_CHECK_*
 * probe budgets from doctor-probe.ts rather than duplicating them. The shared report contract
 * (CheckOutcome) is imported from doctor-outcome.ts, exactly as the other doctor-*
 * modules do. Together
 * these are the doctor's only checks that read pi's model definitions and, for the probes, spawn
 * an agent binary — a distinct concern from the filesystem/git checks, kept together so a change
 * to how doctor reads models does not touch the environment checks. */

/** The config a readiness check reads, or the warn outcome a broken tumwater.json earns:
 * checkInit already fails on a broken config, so a model check only reports that it could not
 * run. One home for the guard and its wording, shared by checkTierModels here and by
 * doctor-fallback-checks.ts and the per-backend modules (the same shape doctor-backlog.ts's
 * readDocChecked uses for unreadable files). The config or the warn outcome, so each check's
 * one-line guard — `const config = loadConfigForCheck(root); if ("level" in config) return
 * config;` — is all a check needs to read its config instead of repeating a
 * load-and-unwrap prologue. */
export function loadConfigForCheck(root: string): TumwaterConfig | CheckOutcome {
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) return warnOutcome(`cannot check — ${error}`);
  return config;
}

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
export function seamPairs(config: TumwaterConfig): SeamPair[] {
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

/** The model-carrying seam pairs for one backend — `seamPairs` with model guaranteed present
 * (seamPairs never emits a pair without a model, so the guard only narrows the type) and
 * narrowed to `agent`'s pairs. The backend readiness checks (claude, codex, opencode) each
 * walk exactly this filtered list, so they share one filter rather than three copies. */
export function seamedModels(config: TumwaterConfig, agent: string): SeamPair[] {
  return seamPairs(config).filter((p) => p.agent === agent && p.model !== undefined);
}

/** The dotted version one of the backend CLIs prints in its `--version` output (`2.0.32`),
 * or undefined when it names none. claude and codex print a bare version; opencode prints it
 * prefixed with `v` (`opencode v2.0.32`), which the caller opts into with `requireVPrefix` so
 * its check cannot mistake a version-like string missing the `v`. One home for the parser so
 * the claude, codex and opencode version checks cannot drift on the version shape they accept.
 */
function parseCliVersion(output: string, requireVPrefix = false): string | undefined {
  return (requireVPrefix ? /v(\d+\.\d+\.\d+)/ : /(\d+\.\d+\.\d+)/).exec(output)?.[1];
}

/** The dashed version verdict of one backend `--version` probe: the parsed dotted version
 * when the probe ran and exited 0, or undefined when it could not run, errored, or named no
 * version. The one home of the `code === 0 ? parseCliVersion : undefined` step the claude,
 * codex and opencode version checks each repeated, so they cannot drift on how a null or
 * non-zero probe reads (codex had already drifted to the `?.` form). `requireVPrefix` is
 * parseCliVersion's, passed through for opencode's `v`-prefixed output. */
export function versionFromProbe(
  result: { code: number | null; stdout: string } | null,
  requireVPrefix = false,
): string | undefined {
  return result !== null && result.code === 0
    ? parseCliVersion(result.stdout, requireVPrefix)
    : undefined;
}

/** The warn/fail/ok verdict for a backend CLI's `--version` check against one flat minimum
 * version (codex's checkCodexVersion and opencode's checkOpencodeVersion both require a
 * single floor for the whole backend, unlike claude's per-model floors). `found` is the
 * parsed dotted version, or undefined when the probe could not run or its output was
 * unreadable. Centralizing the three messages and the belowNodeFloor comparison keeps the
 * two backends' version verdicts from drifting. */
export function minVersionOutcome(
  name: string,
  found: string | undefined,
  min: string,
  upgradeHint: string,
): CheckOutcome {
  if (found === undefined)
    return warnOutcome(`could not check — \`${name} --version\` did not run or its output was unreadable`);
  if (belowNodeFloor(found, `>=${min}`))
    return failOutcome(`${name} ${found} is older than ${min} — ${upgradeHint}`);
  return okOutcome(`${name} ${found} (>= ${min})`);
}

/** Whether any seam runs on the claude backend — the doctor's claude checks stand down when
 * none does (a pi-only team reads no `~/.claude` state and spawns no claude). */
export function claudeSeamsInUse(config: TumwaterConfig): boolean {
  return seamPairs(config).some((pair) => pair.agent === "claude");
}

/** Whether any seam routes to opencode — the doctor's opencode checks stand down when none
 * does (a pi-only team spawns no opencode and reads no opencode state). */
export function opencodeSeamsInUse(config: TumwaterConfig): boolean {
  return seamPairs(config).some((pair) => pair.agent === "opencode");
}

/** Whether any seam routes to codex — the doctor's codex checks stand down when none does
 * (a pi-only team spawns no codex and reads no codex home state). */
export function codexSeamsInUse(config: TumwaterConfig): boolean {
  return seamPairs(config).some((pair) => pair.agent === "codex");
}

/** Whether any seam routes to the pi backend — the doctor's pi-extension row stands down when
 * none does (an all-claude or all-opencode team reads no `~/.pi` state). Unlike the model-based
 * seam consult, this scans the routed seams directly (not seamPairs' model-filtered view) so a
 * default pi team — whose seams route to pi with pi's own default model and no explicit
 * selector — still gets the row: that is the feature's main scenario. */
export function piSeamsInUse(config: TumwaterConfig): boolean {
  return seamsInUse(config).some((s) => s.agent === "pi");
}

/** The parsed pi model definitions read by readPiProviders — a map of provider name to its
 * declared models, or null when the definitions file could not be read. Module-private so the
 * per-job helpers need not re-spell the mapped type. */
type TierProviders = Map<string, PiModelDef[]> | null;

/** One job: sweep the config's seam pairs into the pair map and the routed-models map. */
function collectTierPairs(
  config: TumwaterConfig,
): {
  pairs: Map<string, { provider?: string; model?: string }>;
  routedModels: Map<string, Set<string>>;
} {
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
  return { pairs, routedModels };
}

/** One job: compute the oh-my-pi variables note, and whether any is set. */
function ompTierNote(env: NodeJS.ProcessEnv): { set: boolean; note: string } {
  const ompVars = ["PI_SMOL_MODEL", "PI_SLOW_MODEL", "PI_PLAN_MODEL"].filter(
    (v) => env[v] !== undefined && env[v] !== "",
  );
  return {
    set: ompVars.length > 0,
    note:
      ompVars.length === 0
        ? ""
        : ` — ${ompVars.join(" and ")} ${agree(ompVars.length, "is", "are")} set: tumwater does not read ${agree(ompVars.length, "it", "them")} (oh-my-pi's variables; pi ignores them; with omp as agentBin they still reach omp through the inherited environment) — set model.small / model.strong instead`,
  };
}

/** One job: read pi's provider definitions, or the empty map when the file is unreadable but
 * every pair names a provider the listing can back (the unreadable case the caller warns on). */
async function readTierProviders(
  modelsPath: string,
  pairs: Map<string, { provider?: string; model?: string }>,
  listed: () => Promise<Set<string> | null>,
): Promise<TierProviders> {
  let providers = readPiProviders(modelsPath);
  if (!providers && [...pairs.values()].some((p) => p.provider !== undefined) && (await listed()))
    providers = new Map();
  return providers;
}

/** One job: the fail string for a pair neither pi's definitions nor (when reachable) its
 * listing resolve, or undefined when the listing does contain it. */
function unresolvedModelFail(
  provider: string,
  model: string | undefined,
  defs: PiModelDef[] | undefined,
  listedModels: Set<string> | null,
  modelsPath: string,
): string | undefined {
  if (listedModels?.has(`${provider}/${model}`)) return undefined;
  const providerListed = listedModels != null && [...listedModels].some((k) => k.startsWith(`${provider}/`));
  if (!defs && !providerListed) {
    return listedModels === null
      ? `provider ${provider} is not in pi's definitions (${modelsPath})`
      : `provider ${provider} is not in pi's definitions (${modelsPath}) and \`pi --list-models\` lists none of its models — pi lists only providers it has credentials for`;
  }
  if (listedModels === null) {
    // No exact entry: pi clones the provider's default model for the id, inheriting that
    // default's price and context window (BUGS.md 2026-10-06) — name that consequence
    // instead of only the failed lookup.
    return `${provider}/${model} does not resolve in pi's definitions (${modelsPath}) — pi would price it at the provider default's rates and context window`;
  }
  return `${provider}/${model} is neither in pi's definitions (${modelsPath}) nor listed by \`pi --list-models\``;
}

/** One job: the warn string for a priced model whose cache reads declare $0, or undefined. */
function cacheReadWarning(
  providers: Map<string, PiModelDef[]>,
  provider: string,
  model: string | undefined,
  def: unknown,
): string | undefined {
  if (def && cacheReadUnpriced(providers, provider, model)) {
    return `${provider}/${model} prices cache reads at $0 — the daily budget will undercount its spend`;
  }
  return undefined;
}

/** One job: probe one provider's auth once, reporting ready or the warn when it is not. */
async function probeTierProvider(
  provider: string,
  auth: (provider: string) => Promise<ProviderAuth>,
  checkedProviders: Set<string>,
): Promise<{ warn?: string; ready?: boolean }> {
  if (checkedProviders.has(provider)) return {};
  checkedProviders.add(provider);
  const verdict = await auth(provider);
  if (verdict === "ready") return { ready: true };
  if (verdict === "not-ready")
    return { warn: `provider ${provider} reports not ready — check its credentials` };
  return { warn: `could not verify provider ${provider} — the auth check did not run or its output was unreadable` };
}

/** One job: resolve one pi pair — the per-token claude warn, the definitions lookup and its
 * unresolved fail, the free-cache-reads warn, and the once-per-provider auth probe. */
async function resolveTierPair(
  provider: string | undefined,
  model: string | undefined,
  providers: TierProviders,
  listed: () => Promise<Set<string> | null>,
  auth: (provider: string) => Promise<ProviderAuth>,
  checkedProviders: Set<string>,
  modelsPath: string,
): Promise<{ warns: string[]; fail?: string; ready?: boolean }> {
  const warns: string[] = [];
  if (provider === undefined) {
    warns.push(`${model} names no provider — pi resolves it with its own default, tumwater cannot verify it`);
    return { warns };
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
  const def = defs?.find((d) => d.id === model);
  if (!def) {
    const listedModels = await listed();
    const fail = unresolvedModelFail(provider, model, defs, listedModels, modelsPath);
    if (fail !== undefined) return { warns, fail };
  }
  if (providers) {
    const warning = cacheReadWarning(providers, provider, model, def);
    if (warning !== undefined) warns.push(warning);
  }
  const probe = await probeTierProvider(provider, auth, checkedProviders);
  if (probe.warn !== undefined) warns.push(probe.warn);
  return { warns, ready: probe.ready };
}

/** One job: one routing note per non-pi backend in use, joined. */
function routedTierNotes(routedModels: Map<string, Set<string>>): string {
  // One routing note per non-pi backend in use, so an opencode-routed model is never labeled
  // as claude's. The opencode note also carries the design §2 caveat that a bare `opencode/…`
  // id always means the OpenCode CLI, never pi's built-in `opencode` gateway. Every note opens
  // with the same `<n> <agent>-routed model[s] — ` frame — one phrase in one place (routedNote)
  // so the branches cannot drift on it; the count prints beside the label, so the number form
  // needs agree (not plural, which prints the count).
  const routedNote = (agent: string, n: number, tail: string) =>
    `${n} ${agent}-routed ${agree(n, "model", "models")} — ${tail}`;
  const routedNotes: string[] = [];
  for (const [agent, models] of routedModels) {
    const n = models.size;
    routedNotes.push(
      agent === "opencode"
        ? routedNote(agent, n, "`opencode/…` ids run on the OpenCode CLI, and pi's built-in `opencode` provider is not reachable from tumwater")
        : agent === "codex"
          ? routedNote(agent, n, "resolved by the codex backend, not pi's definitions")
          : routedNote(agent, n, "resolved by the claude backend, not pi's definitions"),
    );
  }
  return routedNotes.length > 0 ? routedNotes.join("; ") : "";
}

/** One job: assemble the final fail/warn/ok outcome from the collected verdicts. */
function tierOutcome(
  fails: string[],
  warns: string[],
  pairsCount: number,
  readyProviders: Set<string>,
  routedText: string,
  ompNote: string,
  ompSet: boolean,
): CheckOutcome {
  const found = [...fails, ...warns].join("; ");
  const resolvedPi = `${pairsCount} declared ${agree(pairsCount, "model", "models")} resolve${readyProviders.size > 0 ? ` and ${agree(readyProviders.size, "provider", "all providers")} ${[...readyProviders].sort().join(", ")} report ready` : ""}`;
  const base =
    fails.length === 0 && warns.length === 0
      ? joinParts([pairsCount > 0 ? resolvedPi : "", routedText])
      : found;
  if (fails.length > 0) return failOutcome(`${base}${ompNote}`);
  return (warns.length > 0 || ompSet ? warnOutcome : okOutcome)(`${base}${ompNote}`);
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
 * (src/pi/pi-backend.ts, built on src/process/run-marker.ts's backendBaseEnv) — pointing at the
 * tier keys that do the same job (`model.small` / `model.strong`). `auth` is injectable so tests
 * need no pi on PATH; `env` so the PI_* branches stay hermetic. The inline jobs are split into
 * the module-private helpers `collectTierPairs`, `ompTierNote`, `readTierProviders`,
 * `resolveTierPair`, `unresolvedModelFail`, `cacheReadWarning`, `probeTierProvider`,
 * `routedTierNotes` and `tierOutcome` so each is found by name. */
export async function checkTierModels(
  root: string,
  modelsPath: string = piModelsPath(),
  auth: (provider: string) => Promise<ProviderAuth> = (provider) =>
    piProviderAuth(loadConfigSafe(root).config ?? defaultConfig(), provider),
  env: NodeJS.ProcessEnv = process.env,
  listModels: () => Promise<Set<string> | null> = () =>
    piListedModels(loadConfigSafe(root).config ?? defaultConfig(), envPath(), AUTH_CHECK_TIMEOUT_MS, root),
): Promise<CheckOutcome> {
  const config = loadConfigForCheck(root);
  if ("level" in config) return config;
  // Asked lazily and at most once: only a pair models.json does not declare needs the listing.
  let listing: Promise<Set<string> | null> | undefined;
  const listed = () => (listing ??= listModels());
  const { pairs, routedModels } = collectTierPairs(config);
  const { set: ompSet, note: ompNote } = ompTierNote(env);
  if (pairs.size === 0 && routedModels.size === 0)
    return (ompSet ? warnOutcome : okOutcome)(`${PHRASE_NO_MODELS_DECLARED}${ompNote}`);
  const providers = await readTierProviders(modelsPath, pairs, listed);
  const fails: string[] = [];
  const warns: string[] = [];
  if (pairs.size > 0 && !providers)
    return warnOutcome(`${PHRASE_CANNOT_READ_MODELS}${modelsPath}${ompNote}`);
  const readyProviders = new Set<string>();
  const checkedProviders = new Set<string>();
  for (const { provider, model } of pairs.values()) {
    const result = await resolveTierPair(provider, model, providers, listed, auth, checkedProviders, modelsPath);
    warns.push(...result.warns);
    if (result.fail !== undefined) fails.push(result.fail);
    if (result.ready === true) readyProviders.add(provider as string);
  }
  const routedText = routedTierNotes(routedModels);
  return tierOutcome(fails, warns, pairs.size, readyProviders, routedText, ompNote, ompSet);
}

/** `gh` readiness for the opt-in `feedback` observer (plans/feedback-role.md "Shape" → "Part 1"):
 * the role files issues as the operator's GitHub login through `gh`, so doctor confirms `gh`
 * resolves and `gh auth status` exits 0 before a run tries to file — the codex-login pattern
 * (plans/codex-backend.md part 9/9). Shown only when the role is enabled: on a default install
 * nothing files upstream, so there is nothing to check and the row is omitted (null). `probe`
 * is injectable so tests use a fake gh (test/fakes/fake-gh.ts); the real probe runs `gh` under
 * the scrubbed run environment with a bounded deadline. */
export async function checkFeedbackFiling(
  root: string,
  pathEnv: string = envPath(),
  probe: (
    args: string[],
  ) => Promise<{ code: number | null; stdout: string } | null> = (args) =>
    boundedProbe(
      "gh",
      args,
      childEnv({ PATH: pathEnv }),
      AUTH_CHECK_TIMEOUT_MS,
      AUTH_CHECK_MAX_OUTPUT_BYTES,
    ),
): Promise<CheckOutcome | null> {
  const config = loadConfigForCheck(root);
  if ("level" in config) return config;
  if (!config.roles.feedback?.enabled) return null;
  const version = await probe(["--version"]);
  if (version?.code !== 0)
    return failOutcome(
      "gh is missing or unusable — install GitHub CLI (https://cli.github.com) so the feedback role can file issues as your login",
    );
  const auth = await probe(["auth", "status"]);
  if (auth?.code !== 0)
    return failOutcome(
      "gh is not authenticated — run `gh auth login` — the feedback role files issues as your GitHub login",
    );
  return okOutcome(
    "gh present and authenticated — the feedback role can file issues on znation/tumwater",
  );
}


/** The `image input` row (plans/image-input.md "Surfaces", part 5/5): which enabled roles run
 * on a model that cannot read images, and where each reroutes an image prompt — or that no
 * usable reroute exists. Re-added probe-free by Subtract part 1d/6 after part 5f/6 deleted the
 * probe-backed row: it reads roleImageInfo (the same resolver the status rows, role page, and
 * submit gate share) rather than spawning a backend, so doctor and the surfaces cannot drift on
 * who is text-only. No alert when none is (imageInput true or null — an unknown pair is not
 * counted as text-only, mirroring the submit gate and the `models for each tier` stance). */
export function checkImageInput(
  root: string,
  modelsPath: string = piModelsPath(),
  listed: PiListedModels | null = readPiListedModels(root),
): CheckOutcome | null {
  const config = loadConfigForCheck(root);
  if ("level" in config) return config;
  const textOnly = runnerIds(config).filter(
    (role) => roleImageInfo(config, role, modelsPath, listed).imageInput === false,
  );
  if (textOnly.length === 0) return okOutcome("every enabled role reads images");
  const noTarget = textOnly.filter((role) => {
    const rr = roleImageInfo(config, role, modelsPath, listed).imageReroute;
    return rr === null || rr === "";
  });
  if (noTarget.length > 0)
    return warnOutcome(
      `${noTarget.join(", ")} ${agree(noTarget.length, "runs", "run")} on models that can't read images and ${agree(noTarget.length, "has", "have")} no reroute target — a run that reads an image fails, and image attachments to these roles are refused. Declare image input on a vision model in pi's models.json, or point a tier at one.`,
    );
  const targets = new Set(
    textOnly.map((role) => roleImageInfo(config, role, modelsPath, listed).imageReroute ?? ""),
  );
  return okOutcome(
    `${textOnly.join(", ")} ${agree(textOnly.length, "runs", "run")} on models that can't read images — image prompts rerun on ${[...targets].join(", ")}.`,
  );
}
