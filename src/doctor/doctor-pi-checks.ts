import { childEnv } from "../process/process.js";
import { boundedProbe, AUTH_CHECK_MAX_OUTPUT_BYTES, AUTH_CHECK_TIMEOUT_MS } from "./doctor-probe.js";
import { parseJsonObject } from "../files/json-object.js";
import { envPath } from "../files/files.js";
import { resolveBackendBin } from "../pi/pi-bin.js";
import { parsePiModelImages, parsePiModelTable, writePiListedModels } from "../pi/pi-listed-models.js";
import type { TumwaterConfig } from "../config/config-schema.js";

/** The doctor's pi provider checks, split out of doctor-model-checks.ts (whose shared seam/model
 * framework and the fallback and tier-models checks stay there): the provider
 * credential probe piProviderAuth and the model-list probe piListedModels. claude, opencode and
 * codex each keep their provider checks in a doctor-<agent>-checks.ts module, so pi has the same
 * shape. This is doctor's only probe of `pi auth check --provider` and `pi --list-models`, a
 * distinct concern from the other model checks — the shared seam model framework and the
 * AUTH_CHECK_* probe budgets come from doctor-model-checks.ts and doctor-probe.ts, as the other
 * doctor-* modules do. */

/** The credential verdict one provider's `pi auth check --provider <p> --json` gives:
 * ready (the provider has credentials), not-ready (pi ran and said otherwise), or unknown
 * (the check could not run or its output could not be parsed — never conflated with
 * not-ready, which would tell the operator to re-login when the real problem is elsewhere). */
export type ProviderAuth = "ready" | "not-ready" | "unknown";

/** The default credential probe: run the resolved agent binary's own auth check for one provider
 * and read `status` out of its JSON. The binary resolves exactly as the spawn does
 * (resolveBackendBin — the same source a real run would launch), so doctor tests the auth of
 * the pi it would actually run. pi's contract is `{"status": "ready"|"not_ready"|"invalid",
 * provider, reason?, authType?}` with exit codes 0/1/2 — a non-zero exit there is a verdict, not
 * a crash, so readiness is read from the body alone and a reply that did not run or does not
 * parse is the only "unknown" (never not-ready, which would blame credentials). Never throws;
 * every failure mode ends on "unknown". The bounded subprocess is the shared boundedProbe
 * (doctor-probe.ts), also used by the claude probes. */
export async function piProviderAuth(
  config: TumwaterConfig,
  provider: string,
  pathEnv: string = envPath(),
  timeoutMs: number = AUTH_CHECK_TIMEOUT_MS,
): Promise<ProviderAuth> {
  const resolved = resolveBackendBin(config);
  const result = await boundedProbe(
    resolved.bin,
    ["auth", "check", "--provider", provider, "--json"],
    childEnv({ PATH: pathEnv }),
    timeoutMs,
    AUTH_CHECK_MAX_OUTPUT_BYTES,
  );
  if (result === null) return "unknown";
  // An unreadable reply is unknown, never not-ready (which would blame the credentials).
  const doc = parseJsonObject(result.stdout);
  if (doc === null) return "unknown";
  if (doc.status === "ready") return "ready";
  // `invalid` (a bad provider name, exit 2) is likewise not a healthy credential: it reads
  // not-ready so the warning blames the setup, not the probe.
  if (doc.status === "not_ready" || doc.status === "invalid") return "not-ready";
  return "unknown";
}

/** Read the table `pi --list-models` prints into a set of `provider/model` keys. Null unless the
 * first non-blank line is the `provider model …` header, so a "No models matching" reply or any
 * other text is never taken for an empty catalog. */
export function parsePiModelList(stdout: string): Set<string> | null {
  const table = parsePiModelTable(stdout);
  if (table === null) return null;
  const listed = new Set<string>();
  for (const [provider, model] of table.rows) if (model !== undefined) listed.add(`${provider}/${model}`);
  return listed;
}

/** The models pi itself lists (`pi --list-models`), which include its built-in catalog that
 * models.json does not repeat. pi lists only the providers it has credentials for. Null when the
 * probe could not run or failed; never throws. Given a `root`, it also records the images column
 * for `seamImageInput` (src/pi/pi-listed-models.ts). */
export async function piListedModels(
  config: TumwaterConfig,
  pathEnv: string = envPath(),
  timeoutMs: number = AUTH_CHECK_TIMEOUT_MS,
  root?: string,
): Promise<Set<string> | null> {
  const result = await boundedProbe(
    resolveBackendBin(config).bin,
    ["--list-models"],
    childEnv({ PATH: pathEnv }),
    timeoutMs,
    AUTH_CHECK_MAX_OUTPUT_BYTES,
  );
  if (result?.code !== 0) return null;
  const images = root === undefined ? null : parsePiModelImages(result.stdout);
  if (root !== undefined && images !== null) {
    try {
      writePiListedModels(root, images);
    } catch {} // A failed write never changes the check.
  }
  return parsePiModelList(result.stdout);
}
