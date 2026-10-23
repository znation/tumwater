/** The codex account state: the codex backend's subscription account (src/agent/
 * subscription-account.ts) — which billing pays for codex runs, and the newest subscription
 * usage-window reading each run reported (plans/codex-backend.md §7 "Spend, free-ness, window,
 * images"). Persisted at `.tumwater/state/codex-account.json`, written only by the
 * orchestrator process, so the sibling parts that throttle or display the subscription window
 * read one answer instead of re-deriving it per surface.
 *
 * Everything here is a thin wrapper over the generic per-backend store
 * (grounds/codex-backend.md "Groundwork: the subscription account is per backend", item 1),
 * specialized to the backend id "codex", plus the codex-only seed (the `codex login status`
 * probe that decides subscription vs API-key billing) that no other backend shares. A Codex
 * run's billing and window readings reach the store through the generic observeAccount call
 * the run finalizers make (run.agent === "codex"); the seed only fills the billing answer in
 * before the first run so the budget gate and the API-key refusal can act on it. The file is a
 * cache, never a source of truth: a run that reports billing overwrites it, and a missing or
 * unreadable file reads as "no subscription". */
import { spawnSync } from "node:child_process";
import type { TumwaterConfig } from "../../config/config-schema.js";
import { resolvedBackendConfig } from "../../config/config-views.js";
import {
  observeAccount,
  readAccount,
  writeAccount,
  type SubscriptionAccount,
  type SubscriptionBilling,
} from "../subscription-account.js";
import type { PiRunResult } from "../../pi/pi-run-result.js";
import { codexBackend } from "./codex-backend.js";
import { codexEnv } from "./codex-env.js";
import { codexHome } from "./codex-catalog.js";

/** How a codex run is paid for: a ChatGPT subscription, or API credit (an API key). */
type CodexBilling = SubscriptionBilling;

/** The persisted codex account state: the billing answer plus the newest reading per window
 * type. */
type CodexAccount = SubscriptionAccount;

/** Read the persisted codex account state, or null when it is absent or unreadable. A file
 * without a usable top-level `observedAt` reads as absent (the plan's torn-file rule). */
export function readCodexAccount(root: string, now = Date.now()): CodexAccount | null {
  return readAccount(root, "codex", now);
}

/** Fold one run's billing and rate-window readings into the codex account file — the store's
 * generic observeAccount for the "codex" backend, so a run's rollout feeding (plans/
 * codex-backend.md "Spend, free-ness, window, images") lands under the codex id. */
export function observeCodexAccount(
  root: string,
  run: Pick<PiRunResult, "billing" | "rateWindows">,
  now = Date.now(),
): CodexAccount | null {
  return observeAccount(root, "codex", run, now);
}

/** Seed the codex account file before the first run (plans/codex-backend.md §7): `codex login
 * status` decides — a ChatGPT login is subscription billing, an API key is API billing.
 * An existing non-api file is left alone, and a probe that cannot run or is not logged in (or
 * prints something else) leaves the file absent (readCodexAccount then reads "no subscription")
 * unless it must clear a sticky api refusal: an "api" answer is re-probed so the operator's
 * remedy (`codex login --device-auth`) clears it next startup, and a re-probe that cannot
 * decide keeps the api file so the refusal does not fail open.
 * Plan and windows arrive with the first run's rollout, so the seed writes no window readings.
 * Returns the account written, or null. A failed write also returns null and never throws, so
 * the first codex run's observation fills the file in. */
export function seedCodexAccount(
  root: string,
  config: TumwaterConfig,
  now = Date.now(),
): CodexAccount | null {
  const existing = readCodexAccount(root, now);
  // Leave an existing answer alone — a run's observation is fresher than this probe — except
  // an "api" answer: the startup gate refuses on that, so it must never be sticky. Re-probe
  // then, so an API-key login the operator has since fixed to a subscription (the refusal's
  // named remedy, `codex login --device-auth`) clears the refusal on the next startup instead
  // of a stale file refusing forever.
  if (existing !== null && existing.billing !== "api") return existing;
  const billing = seedBilling(config);
  if (billing === null) {
    // A re-probe that cannot decide must not fail open: without an existing answer it seeds
    // nothing, but a stale api answer keeps refusing — the persisted api file stays and the
    // gate still reads it as a refusal rather than quietly passing (review objection 2).
    return existing;
  }
  const account: CodexAccount = {
    billing,
    observedAt: now,
    windows: {},
  };
  try {
    writeAccount(root, "codex", account);
  } catch {
    return null;
  }
  return account;
}

/** The billing a `codex login status` reply names, or null when it names neither a ChatGPT
 * login nor an API key. The kind the reply spells out; the startup gate and the doctor read
 * it to refuse API-key billing (decision 5), and the seed writes it with no extra state. */
type CodexLoginStatus = "subscription" | "api" | null;

/** Parse `codex login status` stdout into the billing it names: a ChatGPT login is a
 * subscription, an API-key login is API billing, and anything else (not logged in, an unknown
 * string, an IP firewall prompt) is null — the seed then stays silent and the run's rollout
 * decides. Shared by seedBilling below and (from part 9/9) doctor's codex auth check, so the
 * two cannot disagree about what a login means. */
export function parseCodexLoginStatus(stdout: string | null): CodexLoginStatus {
  if (typeof stdout !== "string" || stdout === "") return null;
  if (stdout.includes("ChatGPT")) return "subscription";
  if (stdout.includes("API key")) return "api";
  return null;
}

/** The billing the login probe names, or null when it cannot be decided. */
function seedBilling(config: TumwaterConfig): CodexBilling | null {
  const status = probeLoginStatus(config);
  if (status === null) return null;
  if (status === "api") return "api";
  if (status === "subscription") return "subscription";
  return null;
}

/** Run `codex login status` under the same scrubbed environment a real run gets (a team
 * config dir's login is what it reports), bounded by a short deadline. Null when the probe
 * could not run or its stdout was unreadable. */
function probeLoginStatus(config: TumwaterConfig): CodexLoginStatus {
  const resolved = codexBackend.resolveBin(config);
  const home = codexHome(resolvedBackendConfig(config, "codex"));
  const env = codexEnv(process.env, home !== undefined ? { home } : {});
  try {
    const result = spawnSync(resolved.bin, ["login", "status"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    if (result.status !== 0) return null;
    return parseCodexLoginStatus(typeof result.stdout === "string" ? result.stdout : null);
  } catch {
    return null;
  }
}
