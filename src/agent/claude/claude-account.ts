/** The claude account state: which billing pays for claude runs, and the newest subscription
 * usage-window reading each run reported (plans/agent-backends.md §7 "Billing" and §8 "The
 * subscription usage window"). Persisted at `.tumwater/state/claude-account.json`, written only
 * by the orchestrator process, so the sibling parts that throttle or display the subscription
 * window (6b/7–6e/7) read one answer instead of re-deriving it per surface.
 *
 * The file is a cache, never a source of truth: a run that reports billing overwrites it, and a
 * missing or unreadable file reads as "no subscription". `resetsAt` is stored as epoch
 * milliseconds (the run parser reports unix seconds; observeClaudeAccount converts once here),
 * so consumers compare it to `Date.now()` directly. */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { TumwaterConfig } from "../../config/config-schema.js";
import { finiteNumber, isJsonObject } from "../../files/json-object.js";
import { ensureParentDir } from "../../files/files.js";
import { claudeAccountPath } from "../../paths.js";
import type { PiRunResult } from "../../pi/pi-run-result.js";
import type { RateWindow } from "../../pi/pi-stream.js";
import { claudeBackend } from "./claude-backend.js";
import { claudeEnv } from "./claude-env.js";

/** How a claude run is paid for: a claude.ai subscription, or API credit (an API key or a
 * third-party provider). */
export type ClaudeBilling = "subscription" | "api";

/** One subscription usage window (the `five_hour` window, plus any longer window an account
 * reports), as the account file stores it: the newest reading per `rateLimitType`, with the
 * instant it was observed. `resetsAt` is epoch ms. A window whose `resetsAt` has passed reads
 * back with `status: "reset"` (see readClaudeAccount). */
interface ClaudeWindow {
  /** `ok` | `allowed_warning` | `rejected` | `reset`. */
  status: string;
  /** Epoch ms when the window resets, when the run reported one. */
  resetsAt?: number;
  /** Fraction of the window consumed (0–1), when reported. */
  utilization?: number;
  /** The account's overage state word, when reported. */
  overageStatus?: string;
  /** True while the account is spending into overage. */
  isUsingOverage?: boolean;
  observedAt: number;
}

/** The persisted account state: the billing answer plus the newest reading per window type. */
export interface ClaudeAccount {
  billing: ClaudeBilling;
  subscriptionType?: string;
  observedAt: number;
  windows: Record<string, ClaudeWindow>;
}

/** Read the persisted account state, or null when it is absent or unreadable. A file without a
 * usable top-level `observedAt` reads as absent (the plan's torn-file rule), and a window whose
 * `resetsAt` is at or before `now` reads back with `status: "reset"` — the reader, not every
 * consumer, decides that the window no longer limits. */
export function readClaudeAccount(root: string, now = Date.now()): ClaudeAccount | null {
  let raw: string;
  try {
    raw = fs.readFileSync(claudeAccountPath(root), "utf8");
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isJsonObject(doc)) return null;
  const billing =
    doc.billing === "subscription" || doc.billing === "api" ? (doc.billing as ClaudeBilling) : undefined;
  const observedAt = finiteNumber(doc.observedAt, Number.NaN);
  if (billing === undefined || !Number.isFinite(observedAt)) return null;
  const windows: Record<string, ClaudeWindow> = {};
  if (isJsonObject(doc.windows)) {
    for (const [type, value] of Object.entries(doc.windows)) {
      const window = readWindow(value, observedAt, now);
      if (window !== undefined) windows[type] = window;
    }
  }
  return {
    billing,
    ...(typeof doc.subscriptionType === "string" ? { subscriptionType: doc.subscriptionType } : {}),
    observedAt,
    windows,
  };
}

/** One window entry from the file, healed: a non-object or a status-less entry is dropped, a
 * missing per-window `observedAt` falls back to the file's, and a past `resetsAt` flips the
 * status to `reset`. */
function readWindow(value: unknown, fileObservedAt: number, now: number): ClaudeWindow | undefined {
  if (!isJsonObject(value) || typeof value.status !== "string") return undefined;
  const observedAt = finiteNumber(value.observedAt, fileObservedAt);
  const resetsAt = finiteNumber(value.resetsAt, Number.NaN);
  const resets = Number.isFinite(resetsAt);
  const window: ClaudeWindow = {
    status: resets && resetsAt <= now ? "reset" : value.status,
    ...(resets ? { resetsAt } : {}),
    ...(typeof value.utilization === "number" ? { utilization: value.utilization } : {}),
    ...(typeof value.overageStatus === "string" ? { overageStatus: value.overageStatus } : {}),
    ...(value.isUsingOverage === true ? { isUsingOverage: true } : {}),
    observedAt,
  };
  return window;
}

/** Overwrite the account file with `account`, creating the state directory. The orchestrator's
 * one writer; a failure to write is the caller's to handle (best-effort at the tick boundary). */
export function writeClaudeAccount(root: string, account: ClaudeAccount): void {
  const file = claudeAccountPath(root);
  ensureParentDir(file);
  fs.writeFileSync(file, JSON.stringify(account, null, 2) + "\n");
}

/** Fold one run's billing and rate-window readings into the account file: the run's `billing`
 * overwrites the stored answer, and each reported window replaces the stored reading for its
 * `type`, stamped with `observedAt`. A run that reported neither billing nor windows leaves the
 * file untouched (and returns whatever was already there). */
export function observeClaudeAccount(
  root: string,
  run: Pick<PiRunResult, "billing" | "rateWindows">,
  now = Date.now(),
): ClaudeAccount | null {
  const existing = readClaudeAccount(root, now);
  const billing = run.billing ?? existing?.billing;
  const reported = run.rateWindows ?? [];
  if (billing === undefined || (run.billing === undefined && reported.length === 0)) return existing;
  const windows: Record<string, ClaudeWindow> = { ...(existing?.windows ?? {}) };
  for (const w of reported) windows[w.type] = windowFromRun(w, now);
  const account: ClaudeAccount = {
    billing,
    ...(existing?.subscriptionType !== undefined ? { subscriptionType: existing.subscriptionType } : {}),
    observedAt: now,
    windows,
  };
  writeClaudeAccount(root, account);
  return account;
}

/** One run's rate-window reading in the file's shape: unix-seconds `resetsAt` becomes epoch ms,
 * and absent optional fields stay absent. */
function windowFromRun(w: RateWindow, now: number): ClaudeWindow {
  return {
    status: w.status,
    ...(typeof w.resetsAt === "number" ? { resetsAt: w.resetsAt * 1000 } : {}),
    ...(typeof w.utilization === "number" ? { utilization: w.utilization } : {}),
    ...(typeof w.overageStatus === "string" ? { overageStatus: w.overageStatus } : {}),
    ...(w.isUsingOverage === true ? { isUsingOverage: true } : {}),
    observedAt: now,
  };
}

/** Seed the account file before the first run (plans/agent-backends.md §7): `ANTHROPIC_API_KEY`
 * set means claude prefers the key, so billing is API; otherwise `claude auth status` decides —
 * a claude.ai OAuth login is a subscription, any other login is API. An existing file is left
 * alone, and a probe that cannot run or is not logged in leaves the file absent
 * (readClaudeAccount then reads "no subscription"). Returns the account written, or null. */
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
    ...(billing.subscriptionType !== undefined ? { subscriptionType: billing.subscriptionType } : {}),
    observedAt: now,
    windows: {},
  };
  writeClaudeAccount(root, account);
  return account;
}

/** The billing the environment implies, or null when it cannot be decided: an API key wins, a
 * third-party provider env (`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY`) is API billing, and
 * otherwise `claude auth status` names the login. */
function seedBilling(
  config: TumwaterConfig,
): { billing: ClaudeBilling; subscriptionType?: string } | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (typeof apiKey === "string" && apiKey !== "") return { billing: "api" };
  if (
    process.env.CLAUDE_CODE_USE_BEDROCK !== undefined ||
    process.env.CLAUDE_CODE_USE_VERTEX !== undefined ||
    process.env.CLAUDE_CODE_USE_FOUNDRY !== undefined
  )
    return { billing: "api" };
  const auth = probeAuthStatus(config);
  if (auth === null || auth.loggedIn !== true) return null;
  const subscription = auth.subscriptionType !== undefined || auth.authMethod === "claude.ai";
  return subscription
    ? { billing: "subscription", ...(auth.subscriptionType !== undefined ? { subscriptionType: auth.subscriptionType } : {}) }
    : { billing: "api" };
}

/** What `claude auth status` reports that seedBilling needs. */
interface ClaudeAuthStatus {
  loggedIn: boolean;
  subscriptionType?: string;
  authMethod?: string;
}

/** Run `claude auth status` under the same scrubbed environment a real run gets, bounded by a
 * short deadline. Null when the probe could not run or its reply was unreadable. */
function probeAuthStatus(config: TumwaterConfig): ClaudeAuthStatus | null {
  const resolved = claudeBackend.resolveBin(config);
  const env = claudeEnv(process.env, { quietTimeoutSeconds: 0 });
  try {
    const result = spawnSync(resolved.bin, ["auth", "status"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const doc: unknown = JSON.parse(result.stdout);
    if (!isJsonObject(doc) || typeof doc.loggedIn !== "boolean") return null;
    return {
      loggedIn: doc.loggedIn,
      subscriptionType: typeof doc.subscriptionType === "string" ? doc.subscriptionType : undefined,
      authMethod: typeof doc.authMethod === "string" ? doc.authMethod : undefined,
    };
  } catch {
    return null;
  }
}
