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
import { spawnSync } from "node:child_process";
import os from "node:os";
import type { TumwaterConfig } from "../../config/config-schema.js";
import { resolvedAgentConfig } from "../../config/config-views.js";

import { readJsonFile, writeJsonAtomic } from "../../files/json-files.js";
import { finiteNumber, isJsonObject, parseJsonObject } from "../../files/json-object.js";
import { claudeAccountPath } from "../../paths.js";
import type { PiRunResult } from "../../pi/pi-run-result.js";
import type { RateWindow } from "../../pi/pi-stream.js";
import { claudeBackend, claudeConfigDir } from "./claude-backend.js";
import { claudeEnv, claudeThirdPartyProvider } from "./claude-env.js";

/** How a claude run is paid for: a claude.ai subscription, or API credit (an API key or a
 * third-party provider). */
export type ClaudeBilling = "subscription" | "api";

/** One subscription usage window (the `five_hour` window, plus any longer window an account
 * reports), as the account file stores it: the newest reading per `rateLimitType`, with the
 * instant it was observed. `resetsAt` is epoch ms. A window whose `resetsAt` has passed reads
 * back with `status: "reset"` (see readClaudeAccount). */
export interface ClaudeWindow {
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

/** True when a failed run ended on a subscription usage window the account reported as
 * `rejected` without overage — the signal the team hold throttles on (plans/agent-backends.md
 * §8). Such a run is a transient of the world, not a failure of the session: its session and
 * worktree edits are kept and resumed after `resetsAt` (part 6e) rather than committed as
 * partial work or reset. API-billed claude and overage are budget/fallback matters, not a
 * window hold, so they read false; a pi 429 reports no window and also reads false. */
export function subscriptionWindowRejected(
  run: Pick<PiRunResult, "transientRateLimit" | "billing" | "rateWindows">,
): boolean {
  return (
    run.transientRateLimit &&
    run.billing === "subscription" &&
    (run.rateWindows ?? []).some((w) => w.status === "rejected" && w.isUsingOverage !== true)
  );
}

/** The subscription account's used-up usage window, or null: a window reading `rejected` with no
 * overage, or (with `includeOverage`, the default) a window whose current reading shows
 * `isUsingOverage`, and a `resetsAt` still ahead of `now`; among several, the one that resets
 * last. With a `reserve` (config `claudeWindowReserve`), a window whose utilization has reached
 * its type's fraction counts too, and comes back with `reserve: true`; a rejected or overage
 * window outranks a reserve one, so the flag is set only when no window is used up for real.
 * The budget gate's window move (pollBudgetGate) reads the default; the team hold
 * (claudeWindowObservation) passes `includeOverage: false`, because overage never holds a seam.
 * Only subscription billing produces one; a missing account reads null. */
export function claudeWindowUsedUp(
  account: ClaudeAccount | null,
  now: number,
  includeOverage = true,
  reserve?: Record<string, number>,
): { type: string; resetsAt: number; reserve?: true } | null {
  if (account?.billing !== "subscription") return null;
  let furthest: { type: string; resetsAt: number } | null = null;
  let reserved: { type: string; resetsAt: number; reserve: true } | null = null;
  for (const [type, w] of Object.entries(account.windows)) {
    if (typeof w.resetsAt !== "number" || w.resetsAt <= now) continue;
    const used = w.isUsingOverage === true ? includeOverage : w.status === "rejected";
    if (used) {
      if (furthest === null || w.resetsAt > furthest.resetsAt) furthest = { type, resetsAt: w.resetsAt };
      continue;
    }
    if (windowReserved(w, reserve?.[type]) && (reserved === null || w.resetsAt > reserved.resetsAt))
      reserved = { type, resetsAt: w.resetsAt, reserve: true };
  }
  return furthest ?? reserved;
}

/** Has this window's utilization reached its reserve fraction? False without a fraction or a
 * reading. */
export function windowReserved(w: Pick<ClaudeWindow, "utilization">, fraction: number | undefined): boolean {
  return fraction !== undefined && typeof w.utilization === "number" && w.utilization >= fraction;
}

/** One window entry with its `rateLimitType` attached (the record key), as every display of the
 * subscription window needs it. */
export type ClaudeWindowEntry = ClaudeWindow & { type: string };

/** Status severity for ordering: a rejected window limits, an allowed_warning nears its limit,
 * every other reading (allowed/ok) rides at the bottom, and a reset one no longer limits. */
const WINDOW_RANK: Record<string, number> = { rejected: 3, allowed_warning: 2, reset: 0 };

/** The window type as a compact label: `five_hour` → `5h`, `seven_day` → `7d`; an unknown
 * type falls back to its words with underscores as spaces. The one home of the window spelling
 * the status badge and the role view share. */
export function claudeWindowLabel(type: string): string {
  const m = /^(\w+)_(hour|day|week)$/.exec(type);
  if (!m) return type.replace(/_/g, " ");
  const words: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
  const unit = m[2] === "hour" ? "h" : m[2] === "day" ? "d" : "w";
  const word = m[1] ?? "";
  return `${words[word] ?? word}${unit}`;
}

/** The fraction of a subscription usage window consumed (0–1) as a whole-number percent: a
 * `0.64` utilization reads `64`. The one home of the fraction→percent conversion, shared by
 * the status badge and the doctor's hold reason so the two render a window's fill
 * identically (the browser dashboard's own window line is embedded client-side and keeps its
 * inline copy). */
export function claudeUtilizationPct(utilization: number): number {
  return Math.round(utilization * 100);
}

/** The account's windows as a list, most constrained first: by status severity, then the
 * reported utilization (a missing reading sorts below any number), then the earlier reset, then
 * the type name — so a tie always orders the same way. Empty when the account reported none. */
export function claudeWindowEntries(account: ClaudeAccount): ClaudeWindowEntry[] {
  return Object.entries(account.windows)
    .map(([type, w]) => ({ type, ...w }))
    .sort((a, b) => {
      const rank = (WINDOW_RANK[b.status] ?? 1) - (WINDOW_RANK[a.status] ?? 1);
      if (rank !== 0) return rank;
      const util = (b.utilization ?? -1) - (a.utilization ?? -1);
      if (util !== 0) return util;
      const reset = (a.resetsAt ?? Number.POSITIVE_INFINITY) - (b.resetsAt ?? Number.POSITIVE_INFINITY);
      if (reset !== 0) return reset;
      return a.type.localeCompare(b.type);
    });
}

/** Read the persisted account state, or null when it is absent or unreadable. A file without a
 * usable top-level `observedAt` reads as absent (the plan's torn-file rule), and a window whose
 * `resetsAt` is at or before `now` reads back with `status: "reset"` — the reader, not every
 * consumer, decides that the window no longer limits. */
export function readClaudeAccount(root: string, now = Date.now()): ClaudeAccount | null {
  const doc = readJsonFile<Record<string, unknown>>(claudeAccountPath(root));
  if (doc === null) return null;
  const billing =
    doc.billing === "subscription" || doc.billing === "api" ? (doc.billing) : undefined;
  const observedAt = finiteNumber(doc.observedAt, Number.NaN);
  if (billing === undefined || !Number.isFinite(observedAt)) return null;
  const windows: Record<string, ClaudeWindow> = {};
  if (isJsonObject(doc.windows)) {
    for (const [type, value] of Object.entries(doc.windows)) {
      const window = readWindow(value, observedAt, now);
      if (window !== undefined) setWindow(windows, type, window);
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
 * status to `reset` and drops the overage flags. */
function readWindow(value: unknown, fileObservedAt: number, now: number): ClaudeWindow | undefined {
  if (!isJsonObject(value) || typeof value.status !== "string") return undefined;
  const observedAt = finiteNumber(value.observedAt, fileObservedAt);
  const resetsAt = finiteNumber(value.resetsAt, Number.NaN);
  const resets = Number.isFinite(resetsAt);
  // utilization heals like the two stamps above: JSON's `1e999` parses to Infinity, and a
  // non-finite fraction would render as `Infinity%` in the badges and poison the
  // claudeWindowEntries comparator (Infinity - Infinity is NaN).
  const utilization = finiteNumber(value.utilization, undefined);
  const reset = resets && resetsAt <= now;
  const window: ClaudeWindow = {
    status: reset ? "reset" : value.status,
    ...(resets ? { resetsAt } : {}),
    ...(utilization !== undefined ? { utilization } : {}),
    // a reset window is no longer in overage: dropping both keeps every reader in agreement
    ...(!reset && typeof value.overageStatus === "string" ? { overageStatus: value.overageStatus } : {}),
    ...(!reset && value.isUsingOverage === true ? { isUsingOverage: true } : {}),
    observedAt,
  };
  return window;
}

/** Store one window under its `rateLimitType`. A plain `windows[type] = window` loses a type of
 * `__proto__`: the assignment hits Object.prototype's setter and rewrites the map's prototype
 * instead of adding an own entry, so the window vanishes from every `Object.entries`/`values`
 * reader (the display, the hold, and accountUsesOverage). Defining the own property keeps even
 * that key — the same inherited-key guard claude-stream's TOOL_NAMES lookup uses. */
function setWindow(windows: Record<string, ClaudeWindow>, type: string, window: ClaudeWindow): void {
  Object.defineProperty(windows, type, { value: window, enumerable: true, writable: true, configurable: true });
}

/** Overwrite the account file with `account`, creating the state directory. The orchestrator's
 * one writer; a failure to write is the caller's to handle (best-effort at the tick boundary).
 * Written through writeJsonAtomic (tmp + rename): a crash or ENOSPC mid-write leaves the
 * previous file whole, not a torn one the reader heals to "no subscription" — which would
 * silently drop the billing answer and the window hold until the next run re-observed them. */
export function writeClaudeAccount(root: string, account: ClaudeAccount): void {
  writeJsonAtomic(claudeAccountPath(root), account, true);
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
  for (const w of reported) setWindow(windows, w.type, windowFromRun(w, now));
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
  // The write choke point heals utilization like readWindow does, so a non-finite value
  // handed straight to observeClaudeAccount can never re-enter the file through a save.
  const utilization = finiteNumber(w.utilization, undefined);
  return {
    status: w.status,
    ...(typeof w.resetsAt === "number" ? { resetsAt: w.resetsAt * 1000 } : {}),
    ...(utilization !== undefined ? { utilization } : {}),
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
  if (claudeThirdPartyProvider(process.env)) return { billing: "api" };
  const auth = probeAuthStatus(config);
  if (!auth?.loggedIn) return null;
  const subscription = claudeAuthUsesSubscription(auth);
  return subscription
    ? { billing: "subscription", ...(auth.subscriptionType !== undefined ? { subscriptionType: auth.subscriptionType } : {}) }
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
  const configDir = resolvedAgentConfig(config, "claude").configDir;
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
