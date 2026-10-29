/** The per-backend subscription account state: which billing pays for a backend's runs, and
 * the newest subscription usage-window reading each run reported (plans/agent-backends.md §7
 * "Billing" and §8 "The subscription usage window"). Persisted at
 * `.tumwater/state/<backend>-account.json` (plan design grounds/codex-backend.md "Groundwork:
 * the subscription account is per backend", item 1), written only by the orchestrator process,
 * so the sibling parts read one answer instead of re-deriving it per surface.
 *
 * The file is a cache, never a source of truth: a run that reports billing overwrites it, and a
 * missing or unreadable file reads as "no subscription". `resetsAt` is stored as epoch
 * milliseconds (the run parser reports unix seconds; observeAccount converts once here), so
 * consumers compare it to `Date.now()` directly. The claude account (src/agent/claude/
 * claude-account.ts) is this module specialized to the "claude" backend: for its file the
 * logical `plan` field is stored under the historical key `subscriptionType`, so claude's file
 * keeps today's shape. */
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { finiteNumber, isJsonObject, setOwn } from "../files/json-object.js";
import { accountPath } from "../paths.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import type { RateWindow } from "../pi/pi-stream.js";

/** How a backend's run is paid for: a subscription, or API credit (an API key or a
 * third-party provider). */
export type SubscriptionBilling = "subscription" | "api";

/** One subscription usage window (the `five_hour` window, plus any longer window an account
 * reports), as the account file stores it: the newest reading per `rateLimitType`, with the
 * instant it was observed. `resetsAt` is epoch ms. A window whose `resetsAt` has passed reads
 * back with `status: "reset"` (see readAccount). */
export interface SubscriptionWindow {
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

/** The persisted per-backend account state: the billing answer plus the newest reading per
 * window type and the subscription plan the run named, if any. For claude's file the plan is
 * stored under the historical `subscriptionType` key. */
export interface SubscriptionAccount {
  billing: SubscriptionBilling;
  /** The subscription plan the run reported (claude's `subscriptionType`), when one was
   * named. Kept under the file key `subscriptionType` for claude's file. */
  plan?: string;
  observedAt: number;
  windows: Record<string, SubscriptionWindow>;
}

/** True when a failed run ended on a subscription usage window the account reported as
 * `rejected` without overage — the signal the team hold throttles on (plans/agent-backends.md
 * §8). Such a run is a transient of the world, not a failure of the session: its session and
 * worktree edits are kept and resumed after `resetsAt` (part 6e) rather than committed as
 * partial work or reset. API-billed runs and overage are budget/fallback matters, not a
 * window hold, so they read false; a backend that reports no window also reads false (a pi
 * 429, for example). */
export function subscriptionWindowRejected(
  run: Pick<PiRunResult, "transientRateLimit" | "billing" | "rateWindows">,
): boolean {
  return (
    run.transientRateLimit &&
    run.billing === "subscription" &&
    (run.rateWindows ?? []).some((w) => w.status === "rejected" && w.isUsingOverage !== true)
  );
}

/** Read the persisted account state for a backend, or null when it is absent or unreadable. A
 * file without a usable top-level `observedAt` reads as absent (the plan's torn-file rule),
 * and a window whose `resetsAt` is at or before `now` reads back with `status: "reset"` — the
 * reader, not every consumer, decides that the window no longer limits. */
export function readAccount(
  root: string,
  backend: string,
  now = Date.now(),
): SubscriptionAccount | null {
  const doc = readJsonFile<Record<string, unknown>>(accountPath(root, backend));
  if (doc === null) return null;
  const billing =
    doc.billing === "subscription" || doc.billing === "api" ? (doc.billing) : undefined;
  const observedAt = finiteNumber(doc.observedAt, Number.NaN);
  if (billing === undefined || !Number.isFinite(observedAt)) return null;
  const windows: Record<string, SubscriptionWindow> = {};
  if (isJsonObject(doc.windows)) {
    for (const [type, value] of Object.entries(doc.windows)) {
      const window = readWindow(value, observedAt, now);
      if (window !== undefined) setWindow(windows, type, window);
    }
  }
  return {
    billing,
    ...(typeof doc.subscriptionType === "string" ? { plan: doc.subscriptionType } : {}),
    observedAt,
    windows,
  };
}

/** One window entry from the file, healed: a non-object or a status-less entry is dropped, a
 * missing per-window `observedAt` falls back to the file's, and a past `resetsAt` flips the
 * status to `reset` and drops the overage flags. */
function readWindow(
  value: unknown,
  fileObservedAt: number,
  now: number,
): SubscriptionWindow | undefined {
  if (!isJsonObject(value) || typeof value.status !== "string") return undefined;
  const observedAt = finiteNumber(value.observedAt, fileObservedAt);
  const resetsAt = finiteNumber(value.resetsAt, Number.NaN);
  const resets = Number.isFinite(resetsAt);
  // utilization heals like the two stamps above: JSON's `1e999` parses to Infinity, and a
  // non-finite fraction would poison any consumer's utilization read.
  const utilization = finiteNumber(value.utilization, undefined);
  const reset = resets && resetsAt <= now;
  const window: SubscriptionWindow = {
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

/** Store one window under its `rateLimitType`. A plain `windows[type] = window` loses a type
 * of `__proto__`: the assignment hits Object.prototype's setter and rewrites the map's
 * prototype instead of adding an own entry, so the window vanishes from every
 * Object.entries/values reader. Defining the own property keeps even that key — the same
 * inherited-key guard claude-stream's TOOL_NAMES lookup uses. */
function setWindow(
  windows: Record<string, SubscriptionWindow>,
  type: string,
  window: SubscriptionWindow,
): void {
  setOwn(windows, type, window);
}

/** Overwrite a backend's account file with `account`, creating the state directory. The
 * orchestrator's one writer; a failure to write is the caller's to handle (best-effort at the
 * run boundary). Written through writeJsonAtomic (tmp + rename): a crash or ENOSPC mid-write
 * leaves the previous file whole, not a torn one the reader heals to "no subscription" — which
 * would silently drop the billing answer and the window hold until the next run re-observed
 * them. The claude file's `plan` is serialized under its historical `subscriptionType` key. */
export function writeAccount(
  root: string,
  backend: string,
  account: SubscriptionAccount,
): void {
  writeJsonAtomic(
    accountPath(root, backend),
    {
      billing: account.billing,
      ...(account.plan !== undefined ? { subscriptionType: account.plan } : {}),
      observedAt: account.observedAt,
      windows: account.windows,
    },
    true,
  );
}

/** Fold one run's billing and rate-window readings into a backend's account file: the run's
 * `billing` overwrites the stored answer, and each reported window replaces the stored reading
 * for its `type`, stamped with `observedAt`. A run that reported neither billing nor windows
 * leaves the file untouched (and returns whatever was already there). */
export function observeAccount(
  root: string,
  backend: string,
  run: Pick<PiRunResult, "billing" | "rateWindows">,
  now = Date.now(),
): SubscriptionAccount | null {
  const existing = readAccount(root, backend, now);
  const billing = run.billing ?? existing?.billing;
  const reported = run.rateWindows ?? [];
  if (billing === undefined || (run.billing === undefined && reported.length === 0)) return existing;
  const windows: Record<string, SubscriptionWindow> = { ...(existing?.windows ?? {}) };
  for (const w of reported) setWindow(windows, w.type, windowFromRun(w, now));
  const account: SubscriptionAccount = {
    billing,
    ...(existing?.plan !== undefined ? { plan: existing.plan } : {}),
    observedAt: now,
    windows,
  };
  writeAccount(root, backend, account);
  return account;
}

/** One run's rate-window reading in the file's shape: unix-seconds `resetsAt` becomes epoch ms,
 * and absent optional fields stay absent. */
function windowFromRun(w: RateWindow, now: number): SubscriptionWindow {
  // The write choke point heals utilization like readWindow does, so a non-finite value
  // handed straight to observeAccount can never re-enter the file through a save.
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

