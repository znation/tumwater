/** The claude account state: the claude backend's subscription account (src/agent/
 * subscription-account.ts) — which billing pays for claude runs, and the newest subscription
 * usage-window reading each run reported (plans/agent-backends.md §7 "Billing" and §8 "The
 * subscription usage window"). Persisted at `.tumwater/state/claude-account.json`, written only
 * by the orchestrator process, so the sibling parts that throttle or display the subscription
 * window (6b/7–6e/7) read one answer instead of re-deriving it per surface.
 *
 * Everything here is a thin wrapper over the generic per-backend store (found
 * grounds/codex-backend.md "Groundwork: the subscription account is per backend", item 1),
 * specialized to the backend id "claude", plus the claude-only seed (auth status, the API-key
 * and third-party-provider billing checks) that no other backend shares. The file is a cache,
 * never a source of truth: a run that reports billing overwrites it, and a missing or
 * unreadable file reads as "no subscription". `resetsAt` is stored as epoch milliseconds (the
 * run parser reports unix seconds; the store converts once), so consumers compare it to
 * `Date.now()` directly. */
import { spawnSync } from "node:child_process";
import os from "node:os";
import type { TumwaterConfig } from "../../config/config-schema.js";
import { resolvedBackendConfig } from "../../config/config-views.js";

import { parseJsonObject } from "../../files/json-object.js";
import {
  observeAccount,
  readAccount,
  subscriptionWindowRejected,
  utilizationPct,
  windowEntries,
  windowLabel,
  windowReserved,
  windowUsedUp,
  writeAccount,
  type SubscriptionAccount,
  type SubscriptionBilling,
  type SubscriptionWindow,
  type SubscriptionWindowEntry,
} from "../subscription-account.js";
import type { PiRunResult } from "../../pi/pi-run-result.js";
import { claudeBackend, claudeConfigDir } from "./claude-backend.js";
import { claudeEnv, claudeThirdPartyProvider } from "./claude-env.js";

/** How a claude run is paid for: a claude.ai subscription, or API credit (an API key or a
 * third-party provider). */
export type ClaudeBilling = SubscriptionBilling;

/** One subscription usage window (the `five_hour` window, plus any longer window an account
 * reports), as the claude account file stores it: the newest reading per `rateLimitType`, with
 * the instant it was observed. `resetsAt` is epoch ms. A window whose `resetsAt` has passed
 * reads back with `status: "reset"` (see readClaudeAccount). */
export type ClaudeWindow = SubscriptionWindow;

/** The persisted claude account state: the billing answer plus the newest reading per window
 * type. */
export type ClaudeAccount = SubscriptionAccount;

/** One window entry with its `rateLimitType` attached, as every display of the subscription
 * window needs it. */
export type ClaudeWindowEntry = SubscriptionWindowEntry;

/** Read the persisted claude account state, or null when it is absent or unreadable. A file
 * without a usable top-level `observedAt` reads as absent (the plan's torn-file rule), and a
 * window whose `resetsAt` is at or before `now` reads back with `status: "reset"` — the
 * reader, not every consumer, decides that the window no longer limits. */
export function readClaudeAccount(root: string, now = Date.now()): ClaudeAccount | null {
  return readAccount(root, "claude", now);
}

/** Overwrite the claude account file with `account`, creating the state directory. The
 * orchestrator's one writer; a failure to write is the caller's to handle (best-effort at the
 * run boundary). Written through writeJsonAtomic (tmp + rename): a crash or ENOSPC mid-write
 * leaves the previous file whole, not a torn one the reader heals to "no subscription" — which
 * would silently drop the billing answer and the window hold until the next run re-observed
 * them. */
export function writeClaudeAccount(root: string, account: ClaudeAccount): void {
  writeAccount(root, "claude", account);
}

/** Fold one run's billing and rate-window readings into the claude account file: the run's
 * `billing` overwrites the stored answer, and each reported window replaces the stored reading
 * for its `type`, stamped with `observedAt`. A run that reported neither billing nor windows
 * leaves the file untouched (and returns whatever was already there). */
export function observeClaudeAccount(
  root: string,
  run: Pick<PiRunResult, "billing" | "rateWindows">,
  now = Date.now(),
): ClaudeAccount | null {
  return observeAccount(root, "claude", run, now);
}

/** The subscription account's used-up usage window, or null — see subscription-account.ts's
 * windowUsedUp for the rule. */
export function claudeWindowUsedUp(
  account: ClaudeAccount | null,
  now: number,
  includeOverage = true,
  reserve?: Record<string, number>,
): { type: string; resetsAt: number; reserve?: true } | null {
  return windowUsedUp(account, now, includeOverage, reserve);
}

/** Re-export of the per-backend helpers under their historical claude names for callers that
 * predate the per-backend store (budget gates, team holds, the doctor, the role view, the
 * status poll). */
export { subscriptionWindowRejected, windowReserved };

/** The window type as a compact label — subscription-account.ts's windowLabel, under its
 * historical claude name. */
export function claudeWindowLabel(type: string): string {
  return windowLabel(type);
}

/** The fraction of a subscription usage window consumed as a whole-number percent —
 * subscription-account.ts's utilizationPct, under its historical claude name. */
export function claudeUtilizationPct(utilization: number): number {
  return utilizationPct(utilization);
}

/** The account's windows as a list, most constrained first — subscription-account.ts's
 * windowEntries, under its historical claude name. */
export function claudeWindowEntries(account: ClaudeAccount): ClaudeWindowEntry[] {
  return windowEntries(account);
}

/** Seed the claude account file before the first run (plans/agent-backends.md §7):
 * `ANTHROPIC_API_KEY` set means claude prefers the key, so billing is API; otherwise
 * `claude auth status` decides — a claude.ai OAuth login is a subscription, any other login is
 * API. An existing file is left alone, and a probe that cannot run or is not logged in leaves
 * the file absent (readClaudeAccount then reads "no subscription"). Returns the account
 * written, or null. A failed write also returns null and never throws, so the first claude
 * run's observeClaudeAccount fills the file in. */
export function seedClaudeAccount(
  root: string,
  config: TumwaterConfig,
  now = Date.now(),
): ClaudeAccount | null {
  const existing = readClaudeAccount(root, now);
  if (existing !== null) return existing;
  const billing = seedBilling(config);
  if (billing === null) return null;
  const account: ClaudeAccount = {
    billing: billing.billing,
    ...(billing.plan !== undefined ? { plan: billing.plan } : {}),
    observedAt: now,
    windows: {},
  };
  try {
    writeClaudeAccount(root, account);
  } catch {
    return null;
  }
  return account;
}

/** The billing the environment implies, or null when it cannot be decided: an API key wins, a
 * third-party provider env (`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY`) is API billing, and
 * otherwise `claude auth status` names the login. */
function seedBilling(config: TumwaterConfig): { billing: ClaudeBilling; plan?: string } | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (typeof apiKey === "string" && apiKey !== "") return { billing: "api" };
  if (claudeThirdPartyProvider(process.env)) return { billing: "api" };
  const auth = probeAuthStatus(config);
  if (!auth?.loggedIn) return null;
  const subscription = claudeAuthUsesSubscription(auth);
  return subscription
    ? { billing: "subscription", ...(auth.subscriptionType !== undefined ? { plan: auth.subscriptionType } : {}) }
    : { billing: "api" };
}

/** What `claude auth status` reports: whether a login exists, and the billing it names.
 * `undefined` fields mean the reply did not name them. */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  subscriptionType?: string;
  authMethod?: string;
}

/** Parse `claude auth status` stdout, returning null when it is not a JSON object or does not
 * report a boolean `loggedIn` — the one home of the read, shared by this module's
 * probeAuthStatus and doctor's claudeAuthProbe (doctor-model-checks.ts). An optional string
 * field reads as absent when the reply names something else. */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus | null {
  const doc = parseJsonObject(stdout);
  if (doc === null || typeof doc.loggedIn !== "boolean") return null;
  return {
    loggedIn: doc.loggedIn,
    subscriptionType: typeof doc.subscriptionType === "string" ? doc.subscriptionType : undefined,
    authMethod: typeof doc.authMethod === "string" ? doc.authMethod : undefined,
  };
}

/** True when an auth-status reply names claude.ai subscription billing — a subscription type
 * (its presence alone signals one) or the explicit claude.ai auth method — rather than API
 * billing. Shared by seedBilling below and doctor's checkClaudeAuth (doctor-model-checks.ts),
 * which must not disagree about which seams are subscription-billed. */
export function claudeAuthUsesSubscription(auth: ClaudeAuthStatus): boolean {
  return auth.subscriptionType !== undefined || auth.authMethod === "claude.ai";
}

/** Run `claude auth status` under the same scrubbed environment a real run gets, bounded by a
 * short deadline. Null when the probe could not run or its reply was unreadable. */
function probeAuthStatus(config: TumwaterConfig): ClaudeAuthStatus | null {
  const resolved = claudeBackend.resolveBin(config);
  const configDir = resolvedBackendConfig(config, "claude").configDir;
  const env = claudeEnv(process.env, {
    quietTimeoutSeconds: 0,
    // The seed probes auth under the same env a real run gets, so a team config dir's login
    // is what it reports (plans/notes-command.md "Keeping funes out of team runs").
    ...(configDir !== undefined
      ? { configDir: claudeConfigDir(process.env, os.homedir(), configDir) }
      : {}),
  });
  try {
    const result = spawnSync(resolved.bin, ["auth", "status"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    return parseClaudeAuthStatus(result.stdout);
  } catch {
    return null;
  }
}
