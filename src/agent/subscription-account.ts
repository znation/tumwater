/** The per-backend subscription account state: which billing pays for a backend's runs, and
 * the newest subscription usage-window reading each run reported (plans/agent-backends.md §7
 * "Billing" and §8 "The subscription usage window"). Persisted at
 * `.tumwater/state/<backend>-account.json` (plan design grounds/codex-backend.md "Groundwork:
 * the subscription account is per backend", item 1), written only by the orchestrator process,
 * so the free-ness rule and the window displays read one answer instead of re-deriving it per
 * surface.
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
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
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

/** One window entry with its `rateLimitType` attached (the record key), as every display of
 * the subscription window needs it. */
type SubscriptionWindowEntry = SubscriptionWindow & { type: string };

/** One subscription backend's window block on a status poll (part 3a/9): the backend's display
 * name and its windows most-constrained-first, with `primary` the one the header badge shows.
 * Display only: since Subtract part 5u/6 no window holds or moves a seam, so the block carries
 * no hold deadline — a rejected window simply reads `limited` until it resets. */
export interface SubscriptionWindowBlock {
  /** The backend id (`"claude"`, `"codex"` …). */
  backend: string;
  /** Its display name (backendDisplayName): `"Claude"`, `"Codex"`. */
  label: string;
  windows: SubscriptionWindowEntry[];
  primary: SubscriptionWindowEntry;
}

/** Status severity for ordering: a rejected window limits, an allowed_warning nears its limit,
 * every other reading (allowed/ok) rides at the bottom, and a reset one no longer limits. */
const WINDOW_RANK: Record<string, number> = { rejected: 3, allowed_warning: 2, reset: 0 };

/** The window type as a compact label: `five_hour` → `5h`, `seven_day` → `7d`; an unknown
 * type falls back to its words with underscores as spaces. The one home of the window spelling
 * the status badge and the role view share (the browser dashboard keeps its inline copy). */
export function windowLabel(type: string): string {
  const m = /^(\w+)_(hour|day|week)$/.exec(type);
  if (!m) return type.replace(/_/g, " ");
  const words: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
  const unit = m[2] === "hour" ? "h" : m[2] === "day" ? "d" : "w";
  const word = m[1] ?? "";
  return `${words[word] ?? word}${unit}`;
}

/** The fraction of a subscription usage window consumed (0–1) as a whole-number percent: a
 * `0.64` utilization reads `64`. The one node-side home of the fraction→percent conversion
 * (the browser dashboard's own window line is embedded client-side and keeps its inline copy). */
export function utilizationPct(utilization: number): number {
  return Math.round(utilization * 100);
}

/** Order two window entries by the windowEntries rule: status severity, then the reported
 * utilization (a missing reading sorts below any number), then the earlier reset, then the
 * type name. Exported so a list of per-backend blocks can be ordered by their primary entry
 * the same way windowEntries orders one account's windows (part 3a/9). */
export function compareWindowEntries(a: SubscriptionWindowEntry, b: SubscriptionWindowEntry): number {
  const rank = (WINDOW_RANK[b.status] ?? 1) - (WINDOW_RANK[a.status] ?? 1);
  if (rank !== 0) return rank;
  const util = (b.utilization ?? -1) - (a.utilization ?? -1);
  if (util !== 0) return util;
  const reset = (a.resetsAt ?? Number.POSITIVE_INFINITY) - (b.resetsAt ?? Number.POSITIVE_INFINITY);
  if (reset !== 0) return reset;
  return a.type.localeCompare(b.type);
}

/** The account's windows as a list, most constrained first (by compareWindowEntries). Empty
 * when the account reported none. */
export function windowEntries(account: SubscriptionAccount): SubscriptionWindowEntry[] {
  return Object.entries(account.windows)
    .map(([type, w]) => ({ type, ...w }))
    .sort((a, b) => compareWindowEntries(a, b));
}

/** The parsed raw body of one backend's account file, keyed by that file's own stat — the same
 * stat-keyed contract cachedByStat gives every observer that polls a slowly-changing file. The
 * account file is written only by the orchestrator on a run's billing/window report, so it
 * changes no faster than runs; on the status snapshot path readAccount ran per backend per poll
 * as one more readJsonFile (read + parse) alongside the already stat-cached marker reads, and
 * budget-gates/role-view read it on other polling surfaces. Writes go through writeJsonAtomic's
 * tmp+rename (writeAccount), which bumps dev/ino/mtime/size, so a refresh invalidates like any
 * edit. The `now`-dependent heal is NOT cached: only the raw body is, and readAccount reapplies
 * its window/observedAt rules against each call's own `now` on a per-call copy, so a window
 * whose `resetsAt` lapses still reads back as reset on the very call it does. Bounded inside
 * cachedByStat. */
const accountBodyCache = new Map<string, StatKeyedValue<Record<string, unknown>>>();

/** Serve `file`'s parsed raw JSON-object body from accountBodyCache: null when the file is
 * missing, unreadable, torn, or not a plain object — the same no-data policy as readJsonFile —
 * and a fresh per-call copy so readAccount's owns the object it reads fields off. Never throws. */
function readAccountBody(file: string): Record<string, unknown> | null {
  return cachedByStat(
    accountBodyCache,
    file,
    file,
    () => readJsonFile<object>(file) as Record<string, unknown> | null,
    (body) => ({ ...body }),
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
  const doc = readAccountBody(accountPath(root, backend));
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
  // non-finite fraction would render as `Infinity%` in the badges and poison the
  // windowEntries comparator (Infinity - Infinity is NaN).
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

