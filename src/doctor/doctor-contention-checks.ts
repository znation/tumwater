/** The worktree/process contention checks, split out of doctor-checks.ts (the project's
 * largest module, ~6x the file-size median, holding four unrelated check domains): the merge
 * lock, the worktree pool, the three `_wait` contention rows (slot, provider, check), and the
 * parallel-work-instance, tumwater-pin, leftover-role-branch and provider-concurrency audits.
 * Read-only like every doctor check; they share the wait fold (sumWaits) and the pin/worktree
 * leftovers helpers, all of which live here beside the checks that use them. The environment
 * and repo-setup checks stay in doctor-checks.ts; the project's own state, disk and build
 * checks live in doctor-project-checks.ts; model readiness lives in doctor-model-checks.ts;
 * the per-document backlog checks live in doctor-backlog-plans.ts and doctor-backlog-bugs.ts
 * beside doctor-backlog.ts's shared helpers and queue checks;
 * doctor.ts remains the composition layer
 * that calls each check in fixed order. */
import path from "node:path";
import { defaultConfig, knownRoleIds, slotCount } from "../config/config.js";
import { CUSTOM_NAME_RE, type TumwaterConfig } from "../config/config-schema.js";
import { subdirectoryNames } from "../files/files.js";
import { finiteNumber, stringList } from "../files/json-object.js";
import { commitExists, deleteRefIfAt, listBranches, refSha, refsUnder } from "../git/git.js";
import { readSlotsState } from "../git/slots-state.js";
import { eventsSince } from "../events/event-window.js";
import type { HarnessEvent } from "../events/events.js";
import { DAY_MS } from "../text/datetime.js";
import { shortSha } from "../text/format.js";
import { errorMessage, joinParts, textOr } from "../text/text.js";
import { rankCountEntries } from "../collections.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { INSTANCE_ROLES, runnerEnabled, runnerIds } from "../roles/runner-ids.js";
import { staleClaimDetail, staleClaimEntries } from "../scheduling/claim-entries.js";
import { piModelsPath } from "../pi/pi-models.js";
import { piSettingsPath, readPiDefaultModel } from "../pi/pi-settings.js";
import { seamConcurrencyKey } from "../config/config-views.js";
import type { ModelSelector } from "../config/model-selector.js";
import { seamsInUse } from "../config/config-fallbacks.js";
import { enforcedKeyCaps } from "../concurrency/semaphore.js";
import { classifyLock, readLockPid } from "../concurrency/lock.js";
import { branchName, mergeLockDir, worktreesDir } from "../paths.js";
import { artifactPhrase, retireRole } from "../operator/retire.js";
import { loadRunnerState } from "../runner/runner-state-load.js";
import { agree, plural, shortSpanPhrase } from "../text/phrases.js";
import { failOutcome, okOutcome, warnOutcome, type CheckOutcome } from "./outcome.js";

/** Merge lock — read-only classification via classifyLock (the same three cases the breaker
 * uses). A stale lock is a warning, not a failure: it self-heals on the next merge. */
export function checkMergeLock(root: string): CheckOutcome {
  const dir = mergeLockDir(root);
  switch (classifyLock(dir)) {
    case "absent":
      return okOutcome("not held");
    case "live": {
      const pid = readLockPid(dir);
      return okOutcome(pid !== null ? `held by running role (pid ${pid})` : "held (pid not yet written)");
    }
    case "stale":
      return warnOutcome("stale — will be broken on next merge");
  }
}

/** A pin older than a day is the doctor's stuck-pin signal: a paused or retired role is holding
 * a pooled checkout nobody will reuse (plans/worktree-pool.md, "Observability"). */
const PIN_STALE_MS = DAY_MS;

/** One stale pin the worktree-pool row (checkWorktreePool) and the standing `workspace-pins`
 * alert (alert-feeds.ts) share: a slot held out of the pool by a run that never resumed.
 * role is the slot's pinnedFor, dir the slot's directory name, ageMs the pin's whole-ms age. */
export interface StaleWorkspacePin {
  role: string;
  dir: string;
  ageMs: number;
}

/** The single selector of a stale workspace pin, shared by the doctor's `worktree pool` row
 * (checkWorktreePool) and the always-on `workspace-pins` alert, so the two cannot drift on
 * what a stale pin is: every pinned-for slot whose pin is older than PIN_STALE_MS. Empty when
 * nothing is pinned old enough — an unpinned pool, a malformed or absent slots.json, or a
 * timeouted (non-finite) pinnedAt all read as no stale pin, exactly the tolerance
 * checkWorktreePool has today. `now` is a test seam. */
export function staleWorkspacePins(root: string, now = Date.now()): StaleWorkspacePin[] {
  return readSlotsState(root).slots
    .filter(
      (slot) =>
        slot.pinnedFor !== null && slot.pinnedAt != null && now - slot.pinnedAt > PIN_STALE_MS,
    )
    .map((slot) => ({
      role: slot.pinnedFor as string,
      dir: path.basename(slot.dir),
      ageMs: now - (slot.pinnedAt as number),
    }));
}

/** The shared one-pin clause of the doctor's `worktree pool` row (checkWorktreePool) and the
 * standing `workspace-pins` alert (team-alert-tail.ts): `<role> pinned on <dir> for <Nh>`. One
 * home so the row and the alert cannot drift on how a pin's age is phrased (whole hours, off
 * the pin's whole-ms age). `role` is a non-optional string on StaleWorkspacePin, but the
 * clause renders it through textOr like the row always did, so a malformed pin can never
 * print nothing where the phrase expects a role. */
export function stalePinPhrase(pin: StaleWorkspacePin): string {
  return `${textOr(pin.role)} pinned on ${pin.dir} for ${Math.round(pin.ageMs / 3_600_000)}h`;
}

/** Directory names under the worktrees root that the pool no longer owns: a legacy per-role
 * `<role>` checkout (the pre-pool layout) or a `_land-<role>` checkout from the merge queue. The
 * dedicated `director`, `_slot-<n>`, `_merge`, `_main`, `_gate-main` and `_build` checkouts are
 * expected and never reported. An unreadable worktrees dir means nothing to report. */
function leftoverWorktreeDirs(root: string): string[] {
  return subdirectoryNames(
    worktreesDir(root),
    (name) => name !== DIRECTOR_ROLE && !(name.startsWith("_") && !name.startsWith("_land-")),
  );
}

/** The window of `slot_wait` events the pool row sums, and the total wait inside it that warns. */
export const SLOT_WAIT_CHECK_WINDOW_MS = DAY_MS;
const SLOT_WAIT_WARN_TOTAL_MS = 10 * 60_000;

export const PROVIDER_WAIT_CHECK_WINDOW_MS = DAY_MS;
const PROVIDER_WAIT_WARN_TOTAL_MS = 10 * 60_000;

export const CHECK_WAIT_CHECK_WINDOW_MS = DAY_MS;
const CHECK_WAIT_WARN_TOTAL_MS = 10 * 60_000;

/** Fold a window's `*_wait` events into the three numbers every contention check reads: how
 * many waits there were (each event counts once), the total ms they waited, and the longest
 * single wait — plus the longest event itself, for the check that names the role/purpose off
 * it. The single home of that fold for the three contention checks (checkWorktreePool's
 * `slot_wait` half, checkProviderContention, checkCheckContention), so the sum and the
 * longest-wait selection cannot drift between them. A wait that omits or corrupts `waitedMs`
 * reads as 0 for the sum, exactly as each inline `finiteNumber(ev.waitedMs, 0)` fold did;
 * the longest-wait tie keeps the first event that reached it. */
function sumWaits(waits: readonly HarnessEvent[]): { count: number; totalMs: number; longestMs: number; longest: HarnessEvent } {
  let count = 0;
  let totalMs = 0;
  let longestMs = 0;
  let longest = waits[0]!;
  for (const ev of waits) {
    count += 1;
    const waited = finiteNumber(ev.waitedMs, 0);
    totalMs += waited;
    if (waited > longestMs) {
      longestMs = waited;
      longest = ev;
    }
  }
  return { count, totalMs, longestMs, longest };
}

/** The verdict one `*_wait` contention row folds: whether the window's waits cross that row's
 * warn threshold, and the exact detail the doctor prints (the same rule the always-on
 * contention alert carries, so the two cannot drift — see alert-feeds.ts's
 * capacityContention). `warn` mirrors the total crossing the row's ten-minute threshold and
 * the appended knob-raising advice, so the doctor's level and the alert's presence are decided
 * by one rule. */
export interface WaitContention {
  warn: boolean;
  detail: string;
}

/** The `slot_wait` half of checkWorktreePool's rule: whether the window's waits cross
 * SLOT_WAIT_WARN_TOTAL_MS and the pool row's exact detail clause — the wait count, total and
 * longest spans (naming the role and whether it was a check or a run), and, on a warn, the
 * knob to raise past `slotCount`. Shared by the doctor's `workspaces` row and the always-on
 * contention alert, so the trigger and the advice cannot drift. */
export function slotWaitContention(waits: readonly HarnessEvent[], slotCount: number): WaitContention {
  const { count, totalMs, longestMs, longest } = sumWaits(waits);
  const contended = totalMs >= SLOT_WAIT_WARN_TOTAL_MS;
  const purpose = longest.purpose === "verify" ? "check" : "run";
  const detail = `${plural(count, "wait")} to start in the last 24h, ${shortSpanPhrase(totalMs)} total, longest ${shortSpanPhrase(
    longestMs,
  )} (${textOr(longest.role)} ${purpose})${contended ? ` — raise worktreeSlots above ${slotCount}` : ""}`;
  return { warn: contended, detail };
}

/** Provider-slot contention's rule (the body of checkProviderContention from `sumWaits` on):
 * sums the waits, ranks the per-key buckets busiest first (the key-less bucket, which also
 * takes every team-cap wait whatever its key, reads "the run cap") and, on a warn past
 * PROVIDER_WAIT_WARN_TOTAL_MS, names each key's maxConcurrentPerProvider cap to raise plus
 * maxConcurrent for the run cap. Shared by the doctor's `provider contention` row and the
 * always-on contention alert, so the trigger and the advice cannot drift. The shared rule
 * leaves the count-zero and read-error arms to checkProviderContention. */
export function providerWaitContention(waits: readonly HarnessEvent[], config: TumwaterConfig | undefined): WaitContention {
  const perKey = new Map<string, number>();
  const { count, totalMs, longestMs } = sumWaits(waits);
  for (const ev of waits) {
    const waited = finiteNumber(ev.waitedMs, 0);
    const key = ev.cap !== "team" && typeof ev.key === "string" && ev.key.length > 0 ? ev.key : "";
    perKey.set(key, (perKey.get(key) ?? 0) + waited);
  }
  // Rank the buckets by wait total, ties breaking on key name so the detail is deterministic.
  // The key-less bucket reads "the run cap" — maxConcurrent, since no seam keys to a provider.
  const ranked = rankCountEntries(perKey).map(([key, total]) => ({ key, total }));
  const bucketLabel = (key: string) => (key === "" ? "the run cap" : `the ${key} slot`);
  const cells = ranked.map((b) => `${bucketLabel(b.key)} ${shortSpanPhrase(b.total)}`);
  // A single bucket keeps the pre-existing wording, a bare `(the X slot)` without the total
  // (the total is already named by the `shortSpanPhrase(total)` in the clause before it);
  // two or more name each bucket's total so the ranking reads at a glance.
  const parenthetical =
    ranked.length === 1
      ? `(${bucketLabel(ranked[0]!.key)})`
      : `(${cells[0]}, also ${cells.slice(1).join(", ")})`;
  let detail = `${plural(count, "wait")} for a provider slot in the last 24h, ${shortSpanPhrase(totalMs)} total, longest ${shortSpanPhrase(longestMs)} ${parenthetical}`;
  const contended = totalMs >= PROVIDER_WAIT_WARN_TOTAL_MS;
  if (contended) {
    const advice = ranked
      .filter((b) => b.key !== "" && config?.maxConcurrentPerProvider?.[b.key] !== undefined)
      .map((b) => `raise maxConcurrentPerProvider.${b.key} above ${config?.maxConcurrentPerProvider?.[b.key]}`)
      .join(" and ");
    const teamAdvice =
      perKey.has("") && config !== undefined ? [`raise maxConcurrent above ${config.maxConcurrent}`] : [];
    const all = [...(advice ? [advice] : []), ...teamAdvice].join(" and ");
    if (all) detail += ` — ${all}`;
  }
  return { warn: contended, detail };
}

/** Check-slot contention's rule (the body of checkCheckContention from `sumWaits` on): sums
 * the waits and warns past CHECK_WAIT_WARN_TOTAL_MS naming the knob (maxConcurrentChecks),
 * with the `(behind <kind> <span>, …)` clause when the waits carried `heldBy` labels, kinds
 * busiest first. Shared by the doctor's `check contention` row and the always-on contention
 * alert, so the trigger and the advice cannot drift. The shared rule leaves the count-zero
 * and read-error arms to checkCheckContention. */
export function checkWaitContention(waits: readonly HarnessEvent[], config: TumwaterConfig | undefined): WaitContention {
  const perKind = new Map<string, number>();
  const { count, totalMs, longestMs } = sumWaits(waits);
  for (const ev of waits) {
    const waited = finiteNumber(ev.waitedMs, 0);
    for (const kind of new Set(stringList(ev.heldBy).map(checkHolderKind))) {
      perKind.set(kind, (perKind.get(kind) ?? 0) + waited);
    }
  }
  let detail = `${plural(count, "wait")} for a check slot in the last 24h, ${shortSpanPhrase(totalMs)} total, longest ${shortSpanPhrase(longestMs)}`;
  if (perKind.size > 0) {
    const ranked = rankCountEntries(perKind);
    detail += ` (behind ${ranked.map(([kind, ms]) => `${kind} ${shortSpanPhrase(ms)}`).join(", ")})`;
  }
  if (totalMs < CHECK_WAIT_WARN_TOTAL_MS) return { warn: false, detail };
  detail += ` — raise maxConcurrentChecks above ${config?.maxConcurrentChecks ?? defaultConfig().maxConcurrentChecks}`;
  return { warn: true, detail };
}

/** Worktree pool (plans/worktree-pool.md, part 5/5): report the pooled slots and warn on the
 * states an operator should act on — a legacy `<role>` or `_land-*` checkout the pool migration
 * left behind, a pin older than PIN_STALE_MS (a paused role holding a checkout), and the last
 * 24 h of `slot_wait` events totalling SLOT_WAIT_WARN_TOTAL_MS (the pool is too small). The stale
 * pin is also the standing `workspace-pins` alert's selection (staleWorkspacePins). Read-only,
 * like every doctor check; `now` is a test seam for the pin-age arithmetic. */
export function checkWorktreePool(root: string, now = Date.now()): CheckOutcome {
  const slots = readSlotsState(root).slots;
  const leased = slots.filter((slot) => slot.lease !== null);
  const pins = slots.filter((slot) => slot.pinnedFor !== null);
  const stale = staleWorkspacePins(root, now);
  const leftover = leftoverWorktreeDirs(root);
  const parts = [`${plural(slots.length, "workspace")}, ${leased.length} leased, ${pins.length} pinned`];
  if (leftover.length > 0) parts.push(`legacy worktrees still present: ${leftover.join(", ")}`);
  if (stale.length > 0) {
    // The stale-pin clause renders the shared staleWorkspacePins selection (the same list the
    // standing `workspace-pins` alert carries), so the row's wording and the alert's selection
    // cannot disagree on what a stale pin is or how old it is.
    parts.push(
      stale.map(stalePinPhrase).join("; "),
    );
  }
  let contended = false;
  try {
    const waits = eventsSince(root, SLOT_WAIT_CHECK_WINDOW_MS, now, (ev) => ev.type === "slot_wait");
    if (waits.length > 0) {
      const c = slotWaitContention(waits, slots.length);
      contended = c.warn;
      parts.push(c.detail);
    }
  } catch (err) {
    parts.push(`could not read the event log for waits to start: ${errorMessage(err)}`);
  }
  const warn = leftover.length > 0 || stale.length > 0 || contended;
  return (warn ? warnOutcome : okOutcome)(parts.join(" — "));
}

/** The shared wrapper of the `checkProviderContention`/`checkCheckContention` twins: read the
 * window's `*_wait` events (a read error leaves the level ok, saying so rather than crying
 * wolf, exactly like the slot-wait branch's own read), sum them, and resolve the row's rule;
 * a window with no waits reads "no <noun>". One home for the try/catch, count-zero and
 * ok-fallback arms the two siblings repeated, so they cannot drift on which inputs read ok;
 * the row-specific rule (`providerWaitContention` / `checkWaitContention`) is `rule`. `noun`
 * names the waits in the ok message. */
function waitContentionRow(
  root: string,
  windowMs: number,
  type: string,
  noun: string,
  rule: (waits: readonly HarnessEvent[], config: TumwaterConfig | undefined) => WaitContention,
  config: TumwaterConfig | undefined,
  now: number,
): CheckOutcome {
  let count = 0;
  let verdict: WaitContention;
  try {
    const waits = eventsSince(root, windowMs, now, (ev) => ev.type === type);
    count = sumWaits(waits).count;
    verdict = rule(waits, config);
  } catch (err) {
    // A read error leaves the level ok, exactly like the slot-wait branch's own read: the
    // check cannot measure, so it says so rather than crying wolf.
    return okOutcome(`could not read the event log for ${noun}: ${errorMessage(err)}`);
  }
  if (count === 0) return okOutcome(`no ${noun}`);
  return (verdict.warn ? warnOutcome : okOutcome)(verdict.detail);
}

/** Provider-slot contention: sums the last 24 h of `provider_wait` events (each a role run
 * whose semaphore admission waited PROVIDER_WAIT_EVENT_MS or more, recorded in
 * orchestrator-launch.ts) and warns when the total reaches PROVIDER_WAIT_WARN_TOTAL_MS — the
 * provider cap is too small. Names every key that waited, busiest first (the key-less
 * bucket, which also takes every team-cap wait whatever its key, reads "the run cap") and, on
 * a warn, each key's maxConcurrentPerProvider cap to raise, plus maxConcurrent for the run cap.
 * A counterpoint to checkWorktreePool's slot-wait half; read-only, like every doctor check.
 * `now` is a test seam for the window. */
export function checkProviderContention(root: string, config: TumwaterConfig | undefined, now = Date.now()): CheckOutcome {
  return waitContentionRow(root, PROVIDER_WAIT_CHECK_WINDOW_MS, "provider_wait", "provider waits", providerWaitContention, config, now);
}

/** Names the kind of check a `heldBy` label stands for, in checkCheckContention's tally. */
function checkHolderKind(label: string): string {
  if (label === "main baseline") return "the main baseline";
  const scope = label.slice(label.lastIndexOf(" ") + 1);
  return scope === "gate" || scope === "merge" || scope === "batch" ? `${scope} checks` : "other checks";
}

/** Check-slot contention: sums the last 24 h of `check_wait` events (each a scoped check whose
 * permit wait reached CHECK_WAIT_EVENT_MS, recorded in build-check-events.ts) and warns when
 * the total reaches CHECK_WAIT_WARN_TOTAL_MS — maxConcurrentChecks is too small. The third
 * sibling of checkWorktreePool's slot-wait half and checkProviderContention; read-only.
 * When events carry `heldBy` (the labels of the permit holders the check parked behind), the
 * detail gains `(behind <kind> <span>, …)` after the longest clause, kinds busiest first: a
 * wait counts once toward each distinct kind that held a slot. `now` is a test seam for the
 * window. */
export function checkCheckContention(root: string, config: TumwaterConfig | undefined, now = Date.now()): CheckOutcome {
  return waitContentionRow(root, CHECK_WAIT_CHECK_WINDOW_MS, "check_wait", "check waits", checkWaitContention, config, now);
}

/** The ids `leftover role branches` calls retirable and the branches it leaves for manual
 * deletion — the one walk the row and the reap share, so the two can never disagree on what a
 * retirable leftover is. Retirable ids are the branches whose role is no longer enabled (disabled
 * in tumwater.json, or an instance above the configured count) and that `tumwater retire --role
 * <id>` accepts (knownRoleIds, or any well-formed custom-role name); a `tumwater/<id>` branch for
 * any other id — a removed custom role or an id retire can't name — falls to `unknown` as its
 * full branch name. The director and enabled roles are skipped. An unreadable tumwater.json
 * (config null) sees no branches. */
export async function retirableLeftoverRoles(
  root: string,
  config?: TumwaterConfig | null,
): Promise<{ retirable: string[]; unknown: string[] }> {
  if (!config) return { retirable: [], unknown: [] };
  const prefix = branchName("");
  const known = new Set(knownRoleIds(config));
  const retirable: string[] = [];
  const unknown: string[] = [];
  for (const branch of await listBranches(root)) {
    if (!branch.startsWith(prefix)) continue;
    const id = branch.slice(prefix.length);
    if (!id || id.includes("/") || id === DIRECTOR_ROLE || runnerEnabled(config, id)) continue;
    if (known.has(id) || CUSTOM_NAME_RE.test(id)) retirable.push(id);
    else unknown.push(branch);
  }
  return { retirable, unknown };
}

/** The "leftover role branches" row: `tumwater/<id>` branches whose role is no longer enabled
 * (disabled in tumwater.json, or an instance above the configured count), through the shared
 * retirableLeftoverRoles walk. Any other id is listed by
 * full branch name with a manual-delete hint. Read-only, like every check: it only lists refs;
 * an unreadable tumwater.json skips it. */
export async function checkLeftoverRoleBranches(root: string, config?: TumwaterConfig | null): Promise<CheckOutcome> {
  if (!config) return okOutcome("no readable tumwater.json — nothing to verify");
  const { retirable, unknown } = await retirableLeftoverRoles(root, config);
  const parts: string[] = [];
  if (retirable.length > 0) {
    const n = retirable.length;
    parts.push(
      `${retirable.join(", ")} ${agree(n, "is", "are")} disabled but still ${agree(n, "has", "have")} a branch — \`tumwater retire --role <id>\` removes each (\`--dry-run\` previews)`,
    );
  }
  if (unknown.length > 0) {
    parts.push(
      `${unknown.join(", ")} ${agree(unknown.length, "names", "name")} no role retire accepts — delete with \`git branch -D\` once its commits are not needed`,
    );
  }
  return parts.length === 0 ? okOutcome("no branches left by disabled roles") : warnOutcome(parts.join("; "));
}

/** The `refs/tumwater/` pins and, among them, the broken ones (whose commit is gone) — the one
 * walk the `tumwater pins` row (checkTumwaterPins) and its reap (dropBrokenPins) share, so the
 * two can never disagree on what a broken pin is. Filtered from `refsUnder(root,
 * "refs/tumwater/")` by `!commitExists(root, pin.sha)`. */
async function brokenPins(root: string): Promise<{ pins: { ref: string; sha: string }[]; broken: { ref: string; sha: string }[] }> {
  const pins = await refsUnder(root, "refs/tumwater/");
  const broken: { ref: string; sha: string }[] = [];
  for (const pin of pins) if (!(await commitExists(root, pin.sha))) broken.push(pin);
  return { pins, broken };
}

/** The "tumwater pins" row: fails when a `refs/tumwater/` pin (merge, rejected or legacy landing)
 * names a commit that is gone. It fails rather than warns because such a pin stops `git gc`
 * (and the `gc --auto` commits trigger), and a slot reset or leftover recovery only drops one
 * when it reaches it. Read-only: it lists refs and names the `git update-ref -d` fix (the
 * `--drop-broken-pins` flag performs it). */
export async function checkTumwaterPins(root: string): Promise<CheckOutcome> {
  const { pins, broken } = await brokenPins(root);
  if (broken.length === 0) {
    return okOutcome(pins.length === 0 ? "no tumwater pins" : `${plural(pins.length, "tumwater pin")}, each naming a commit that exists`);
  }
  const n = broken.length;
  return failOutcome(
    `${broken.map((p) => `${p.ref} names ${shortSha(p.sha)}, which is gone`).join("; ")} — git gc and a detached checkout abort on ${agree(n, "it", "them")}; \`git update-ref -d <ref>\` drops each (the work ${agree(n, "it", "they")} pinned is already lost)`,
  );
}

/** What `doctor --drop-broken-pins` and the dashboard's Drop broken pins button did: the pins
 * whose ref is now gone (`dropped`) and the refs that still name a gone commit afterwards
 * (`failed`). */
export interface BrokenPinDrop {
  dropped: { ref: string; sha: string }[];
  failed: { ref: string; reason: string }[];
}

/** The lines `doctor --drop-broken-pins` prints (and the dashboard's Drop broken pins toast),
 * one per dropped pin and, when any, one for the pins that could not be dropped. No lines for
 * a run that dropped nothing and failed nothing. */
export function brokenPinDropLines(drop: BrokenPinDrop): string[] {
  const lines: string[] = [];
  if (drop.dropped.length > 0)
    lines.push(`${plural(drop.dropped.length, "dropped broken pin")}: ${drop.dropped.map((p) => `${p.ref} names ${shortSha(p.sha)}`).join(", ")}`);
  if (drop.failed.length > 0)
    lines.push(`${plural(drop.failed.length, "pin could not be dropped", "pins could not be dropped")}: ${drop.failed.map((f) => `${f.ref} — ${f.reason}`).join(", ")}`);
  return lines;
}

/** What `doctor --retire-leftovers` did: the disabled roles its reap retired, each naming the
 * artifacts `retireRole` removed, and the ones a rail refusal stopped (with the refusal's
 * reason, left exactly as they were). */
export interface LeftoverRetireReport {
  retired: { role: string; removed: string[] }[];
  failed: { role: string; reason: string }[];
}

/** The lines `doctor --retire-leftovers` prints, one per retired role naming its removed
 * artifacts through the same wording `tumwater retire --role <id>` surfaces, and one naming
 * each failed role and its reason. No lines for a run that retired and failed nothing. */
export function leftoverRetireLines(report: LeftoverRetireReport): string[] {
  const lines: string[] = [];
  for (const r of report.retired)
    lines.push(`retired ${r.role}: ${r.removed.map((a) => artifactPhrase(a, r.role)).join("; ")}`);
  for (const f of report.failed) lines.push(`failed to retire ${f.role}: ${f.reason}`);
  return lines;
}

/** Retire each disabled role `retirableLeftoverRoles` calls retirable — the reap behind `doctor
 * --retire-leftovers` — through the same `retireRole` core `tumwater retire --role <id>` uses,
 * never `--force` (exactly the CLI's own refusal policy). A thrown rail refusal is caught into
 * `failed` with its reason and the loop continues, leaving that role exactly as it was.
 * Read-only checks never call this. */
export async function retireLeftovers(
  root: string,
  config?: TumwaterConfig | null,
): Promise<LeftoverRetireReport> {
  const { retirable } = await retirableLeftoverRoles(root, config);
  const retired: { role: string; removed: string[] }[] = [];
  const failed: { role: string; reason: string }[] = [];
  for (const role of retirable) {
    try {
      const { removed } = await retireRole(root, role, {});
      retired.push({ role, removed });
    } catch (err) {
      failed.push({ role, reason: errorMessage(err) });
    }
  }
  return { retired, failed };
}

/** Drop each broken `refs/tumwater/` pin — the reap behind `doctor --drop-broken-pins` and the
 * dashboard's Drop broken pins button. Each pin is deleted only while it still names the broken
 * sha (deleteRefIfAt's guarded `git update-ref -d`), so a ref that moved under us is never
 * dropped; a ref that still names a gone commit afterwards is reported failed. Read-only checks
 * never call this. */
export async function dropBrokenPins(root: string): Promise<BrokenPinDrop> {
  const { broken } = await brokenPins(root);
  const dropped: { ref: string; sha: string }[] = [];
  const failed: { ref: string; reason: string }[] = [];
  for (const pin of broken) {
    await deleteRefIfAt(root, pin.ref, pin.sha);
    const still = await refSha(root, pin.ref);
    if (still === null) dropped.push(pin);
    else if (!(await commitExists(root, still))) failed.push({ ref: pin.ref, reason: `still names ${shortSha(still)}, which is gone` });
  }
  return { dropped, failed };
}

/** The ok detail of the instance check: non-zero counts, plans first, each pluralized. */
function claimCounts(claims: Array<{ file: string }>): string {
  const bugs = claims.filter((c) => c.file === "BUGS.md").length;
  const plans = claims.length - bugs;
  const joined = joinParts(
    [
      plans > 0 ? plural(plans, "claimed plan") : "",
      bugs > 0 ? plural(bugs, "claimed bug") : "",
    ],
    ", ",
  );
  return joined || "no claimed plans or bugs";
}

/** Parallel work instances (plans/parallel-work-instances.md "Observability", part 6/7):
 * each instance's claimed plan or bug and the two states an operator should act on — a claim
 * whose key is no longer listed under its role's section (its instance is stuck on an entry
 * that moved), and a claim idle for more than CLAIM_IDLE_MAX_MS (the scheduler releases
 * these, so seeing one means the reader's view and the scheduler's disagree). An enabled
 * multi-instance role configured with fewer pooled slots than maxConcurrent also warns:
 * instances then contend for the same checkouts. A disabled role runs none of its
 * configured instances, so it never contends and
 * stays out of that warning. The pool-mismatch clause comes from the shared
 * `smallPoolProblems` selector, so the row and the always-on `instance-pool` alert cannot
 * drift on the trigger, the role list, or the wording.
 * Read-only, like every check; `now` is the claim-age test seam, and an unreadable
 * tumwater.json (config undefined) skips the walk — checkInit reports the config itself. */
export function checkWorkInstances(
  root: string,
  config?: TumwaterConfig | null,
  now = Date.now(),
): CheckOutcome {
  if (!config) return okOutcome("no readable tumwater.json — nothing to verify");
  const claims = runnerIds(config).map((id) => loadRunnerState(root, id).claim).filter((c) => c !== undefined);
  const entries = staleClaimEntries(root, runnerIds(config), now);
  const gone = entries.filter((e) => e.kind === "gone");
  const stale = entries.filter((e) => e.kind === "idle");
  const smallPool = smallPoolProblems(config);
  if (gone.length === 0 && stale.length === 0 && smallPool.length === 0)
    return okOutcome(claimCounts(claims));
  const parts: string[] = [...gone.map(staleClaimDetail), ...stale.map(staleClaimDetail)];
  parts.push(...smallPool);
  return warnOutcome(parts.join("; "));
}

/** An enabled multi-instance role contending for a worktree pool smaller than the run cap —
 * the pool-mismatch clause of the doctor's `parallel instances` row (checkWorkInstances) and
 * the always-on `instance-pool` alert (alert-feeds.ts instancePoolProblems). Returns the
 * `INSTANCE_ROLES` ids with more than one configured instance while `slotCount(config)`
 * (worktreeSlots, else maxConcurrent + 1) is below `config.maxConcurrent`, phrased as the
 * row's one clause; `[]` when no such role or the pool is at least `maxConcurrent`. Shared by
 * the doctor row and the alert so they cannot drift on the trigger, the role list, or the
 * wording. */
export function smallPoolProblems(config: TumwaterConfig): string[] {
  const multi = Object.entries(config.roles)
    .filter(
      ([id, role]) => INSTANCE_ROLES.has(id) && role.enabled && (role.instances ?? 1) > 1,
    )
    .map(([id]) => id);
  const slots = slotCount(config);
  if (multi.length === 0 || slots >= config.maxConcurrent) return [];
  return [`${multi.join(", ")} run instances but worktreeSlots ${slots} is below maxConcurrent ${config.maxConcurrent}`];
}

/** Provider concurrency caps (plans/provider-concurrency.md §8): audit the
 * `maxConcurrentPerProvider` map against the seams the config can actually spawn — each role,
 * the review gate, the resolver, the director, and each tier's fallback — so the operator
 * sees whether every cap names a provider in use and whether any cap actually binds. Warns on
 * a cap key no seam resolves to (a typo, or a provider not in use), a cap at or above
 * `maxConcurrent` (which never binds — the team total is the real ceiling), and a capped
 * team whose seams include one with no key (pi's default provider is unreadable, so that
 * seam cannot be capped). A config with no per-provider map or no caps is fine, and so is a
 * well-formed map; a broken config is reported by the init check. Takes `root` to read pi's
 * own default model (piSettingsPath), the same seam the orchestrator's admission uses, so a
 * bare no-model pi seam keys exactly as the team would key it. */
/** The warnings behind checkProviderConcurrency, as a pure function of the config and pi's
 * default model name: a cap key no seam resolves to (a typo, or a provider not in use), a cap
 * at or above `maxConcurrent` (which never binds), and a capped team whose seams include one
 * with no key (pi's default provider is unreadable, so that seam cannot be capped). The doctor's
 * `provider concurrency` row and the always-on `provider-caps` team alert both read this one
 * computation, so the row and the alert cannot drift on the trigger or the wording. `[]` for no
 * config, a map with no enforcedKeyCaps entries, or a map with no problem. `piDefault` is the
 * bare default model the orchestrator's admission seam carries, read once by the callers
 * through readPiDefaultModel(piSettingsPath(piModelsPath()), root). */
export function providerConcurrencyProblems(config: TumwaterConfig | undefined, piDefault: ModelSelector | null): string[] {
  if (!config) return [];
  const caps = config.maxConcurrentPerProvider;
  const capEntries = enforcedKeyCaps(caps);
  if (capEntries.length === 0) return [];
  const seams = seamsInUse(config);
  const keySet = new Set<string>();
  const keyless: string[] = [];
  for (const s of seams) {
    const k = seamConcurrencyKey(s, piDefault);
    if (k !== undefined) keySet.add(k);
    else keyless.push(s.label); // pi's default provider is unreadable, so this seam cannot be capped
  }
  const capKeys = capEntries.map(([k]) => k);
  const warnings: string[] = [];
  for (const key of capKeys) {
    if (!keySet.has(key)) warnings.push(`cap key "${key}" resolves to no model job (a typo, or a provider not in use)`);
  }
  for (const [key, cap] of capEntries) {
    if (cap >= config.maxConcurrent) warnings.push(`cap "${key}" ${cap} is at or above maxConcurrent ${config.maxConcurrent} — it never binds`);
  }
  const capSet = new Set(capKeys);
  if (capSet.size > 0 && keyless.length > 0) {
    warnings.push(`${plural(keyless.length, "model job")} ${agree(keyless.length, "resolves", "resolve")} to no provider key (pi's default provider is unreadable, so they cannot be capped): ${keyless.join(", ")}`);
  }
  return warnings;
}

export function checkProviderConcurrency(config: TumwaterConfig | undefined, root: string): CheckOutcome {
  if (!config) return okOutcome("no config to audit");
  const caps = config.maxConcurrentPerProvider;
  const capEntries = enforcedKeyCaps(caps);
  if (capEntries.length === 0) return okOutcome("no per-provider caps configured");
  // The pi default model the orchestrator's admission seam carries: a bare no-model pi seam
  // resolves its key only through it, so a team whose default is readable has keyed seams and
  // only an unreadable default leaves a key-less seam to warn about.
  const piDefault = readPiDefaultModel(piSettingsPath(piModelsPath()), root);
  const problems = providerConcurrencyProblems(config, piDefault);
  if (problems.length === 0) return okOutcome(`${plural(capEntries.length, "provider cap")} — all model jobs resolve`);
  return warnOutcome(problems.join("; "));
}
