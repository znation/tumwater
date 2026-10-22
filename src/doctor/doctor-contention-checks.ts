/** The worktree/process contention checks, split out of doctor-checks.ts (the project's
 * largest module, ~6x the file-size median, holding four unrelated check domains): the merge
 * lock, the worktree pool, the three `_wait` contention rows (slot, provider, check), and the
 * parallel-work-instance, tumwater-pin, leftover-role-branch and provider-concurrency audits.
 * Read-only like every doctor check; they share the wait fold (sumWaits) and the pin/worktree
 * leftovers helpers, all of which live here beside the checks that use them. The environment,
 * repo and build checks stay in doctor-checks.ts; model readiness lives in
 * doctor-model-checks.ts; the backlog-document checks in doctor-backlog.ts; doctor.ts remains
 * the composition layer that calls each check in fixed order. */
import path from "node:path";
import { defaultConfig, knownRoleIds, slotCount } from "../config/config.js";
import { CUSTOM_NAME_RE, type TumwaterConfig } from "../config/config-schema.js";
import { subdirectoryNames } from "../files/files.js";
import { finiteNumber, stringList } from "../files/json-object.js";
import { commitExists, listBranches, refsUnder } from "../git/git.js";
import { readSlotsState } from "../git/slots-state.js";
import { eventsSince } from "../events/event-window.js";
import type { HarnessEvent } from "../events/events.js";
import { DAY_MS } from "../text/datetime.js";
import { shortSha } from "../text/format.js";
import { errorMessage, joinParts, textOr } from "../text/text.js";
import { rankCountEntries } from "../collections.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { INSTANCE_ROLES, runnerEnabled, runnerIds } from "../roles/runner-ids.js";
import { CLAIM_IDLE_MAX_MS, listedKeys } from "../scheduling/claims.js";
import { piModelsPath } from "../pi/pi-models.js";
import { piSettingsPath, readPiDefaultModel } from "../pi/pi-settings.js";
import { seamConcurrencyKey } from "../config/config-views.js";
import { seamsInUse } from "../config/config-fallbacks.js";
import { enforcedKeyCaps } from "../concurrency/semaphore.js";
import { classifyLock, readLockPid } from "../concurrency/lock.js";
import { branchName, mergeLockDir, worktreesDir } from "../paths.js";
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
const SLOT_WAIT_CHECK_WINDOW_MS = DAY_MS;
const SLOT_WAIT_WARN_TOTAL_MS = 10 * 60_000;

const PROVIDER_WAIT_CHECK_WINDOW_MS = DAY_MS;
const PROVIDER_WAIT_WARN_TOTAL_MS = 10 * 60_000;

const CHECK_WAIT_CHECK_WINDOW_MS = DAY_MS;
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

/** Worktree pool (plans/worktree-pool.md, part 5/5): report the pooled slots and warn on the
 * states an operator should act on — a legacy `<role>` or `_land-*` checkout the pool migration
 * left behind, a pin older than PIN_STALE_MS (a paused role holding a checkout), and the last
 * 24 h of `slot_wait` events totalling SLOT_WAIT_WARN_TOTAL_MS (the pool is too small). Read-only,
 * like every doctor check; `now` is a test seam for the pin-age arithmetic. */
export function checkWorktreePool(root: string, now = Date.now()): CheckOutcome {
  const slots = readSlotsState(root).slots;
  const leased = slots.filter((slot) => slot.lease !== null);
  const pins = slots.filter((slot) => slot.pinnedFor !== null);
  const stale = pins.filter(
    (slot) => slot.pinnedAt != null && now - slot.pinnedAt > PIN_STALE_MS,
  );
  const leftover = leftoverWorktreeDirs(root);
  const parts = [`${plural(slots.length, "workspace")}, ${leased.length} leased, ${pins.length} pinned`];
  if (leftover.length > 0) parts.push(`legacy worktrees still present: ${leftover.join(", ")}`);
  if (stale.length > 0) {
    parts.push(
      stale
        .map(
          (slot) =>
            `${textOr(slot.pinnedFor)} pinned on ${path.basename(slot.dir)} for ${Math.round(
              (now - (slot.pinnedAt ?? now)) / 3_600_000,
            )}h`,
        )
        .join("; "),
    );
  }
  let contended = false;
  try {
    const waits = eventsSince(root, SLOT_WAIT_CHECK_WINDOW_MS, now, (ev) => ev.type === "slot_wait");
    if (waits.length > 0) {
      const { count, totalMs, longestMs, longest } = sumWaits(waits);
      contended = totalMs >= SLOT_WAIT_WARN_TOTAL_MS;
      const purpose = longest.purpose === "verify" ? "check" : "run";
      parts.push(
        `${plural(count, "wait")} to start in the last 24h, ${shortSpanPhrase(totalMs)} total, longest ${shortSpanPhrase(
          longestMs,
        )} (${textOr(longest.role)} ${purpose})${contended ? ` — raise worktreeSlots above ${slots.length}` : ""}`,
      );
    }
  } catch (err) {
    parts.push(`could not read the event log for waits to start: ${errorMessage(err)}`);
  }
  const warn = leftover.length > 0 || stale.length > 0 || contended;
  return (warn ? warnOutcome : okOutcome)(parts.join(" — "));
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
  const perKey = new Map<string, number>();
  let count = 0;
  let totalMs = 0;
  let longestMs = 0;
  try {
    const waits = eventsSince(root, PROVIDER_WAIT_CHECK_WINDOW_MS, now, (ev) => ev.type === "provider_wait");
    const sum = sumWaits(waits);
    count = sum.count;
    totalMs = sum.totalMs;
    longestMs = sum.longestMs;
    for (const ev of waits) {
      const waited = finiteNumber(ev.waitedMs, 0);
      const key = ev.cap !== "team" && typeof ev.key === "string" && ev.key.length > 0 ? ev.key : "";
      perKey.set(key, (perKey.get(key) ?? 0) + waited);
    }
  } catch (err) {
    // A read error leaves the level ok, exactly like the slot-wait branch's own read: the
    // check cannot measure, so it says so rather than crying wolf.
    return okOutcome(`could not read the event log for provider waits: ${errorMessage(err)}`);
  }
  if (count === 0) return okOutcome("no provider waits");
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
  return (contended ? warnOutcome : okOutcome)(detail);
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
  const perKind = new Map<string, number>();
  let count = 0;
  let totalMs = 0;
  let longestMs = 0;
  try {
    const waits = eventsSince(root, CHECK_WAIT_CHECK_WINDOW_MS, now, (e) => e.type === "check_wait");
    const sum = sumWaits(waits);
    count = sum.count;
    totalMs = sum.totalMs;
    longestMs = sum.longestMs;
    for (const ev of waits) {
      const waited = finiteNumber(ev.waitedMs, 0);
      for (const kind of new Set(stringList(ev.heldBy).map(checkHolderKind))) {
        perKind.set(kind, (perKind.get(kind) ?? 0) + waited);
      }
    }
  } catch (err) {
    return okOutcome(`could not read the event log for check waits: ${errorMessage(err)}`);
  }
  if (count === 0) return okOutcome("no check waits");
  let detail = `${plural(count, "wait")} for a check slot in the last 24h, ${shortSpanPhrase(totalMs)} total, longest ${shortSpanPhrase(longestMs)}`;
  if (perKind.size > 0) {
    const ranked = rankCountEntries(perKind);
    detail += ` (behind ${ranked.map(([kind, ms]) => `${kind} ${shortSpanPhrase(ms)}`).join(", ")})`;
  }
  if (totalMs < CHECK_WAIT_WARN_TOTAL_MS) return okOutcome(detail);
  detail += ` — raise maxConcurrentChecks above ${config?.maxConcurrentChecks ?? defaultConfig().maxConcurrentChecks}`;
  return warnOutcome(detail);
}

/** The "leftover role branches" row: `tumwater/<id>` branches whose role is no longer enabled
 * (disabled in tumwater.json, or an instance above the configured count). Retirable ids are
 * the ones `tumwater retire --role <id>` accepts (knownRoleIds, or any well-formed custom-role name
 * with a leftover branch); any other id is listed by
 * full branch name with a manual-delete hint. The director and enabled roles are skipped.
 * Read-only, like every check: it only lists refs; an unreadable tumwater.json skips it. */
export async function checkLeftoverRoleBranches(root: string, config?: TumwaterConfig | null): Promise<CheckOutcome> {
  if (!config) return okOutcome("no readable tumwater.json — nothing to verify");
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

/** The "tumwater pins" row: fails when a `refs/tumwater/` pin (merge, rejected or legacy landing)
 * names a commit that is gone. It fails rather than warns because such a pin stops `git gc`
 * (and the `gc --auto` commits trigger), and a slot reset or leftover recovery only drops one
 * when it reaches it. Read-only: it lists refs and names the `git update-ref -d` fix. */
export async function checkTumwaterPins(root: string): Promise<CheckOutcome> {
  const pins = await refsUnder(root, "refs/tumwater/");
  const broken: { ref: string; sha: string }[] = [];
  for (const pin of pins) if (!(await commitExists(root, pin.sha))) broken.push(pin);
  if (broken.length === 0) {
    return okOutcome(pins.length === 0 ? "no tumwater pins" : `${plural(pins.length, "tumwater pin")}, each naming a commit that exists`);
  }
  const n = broken.length;
  return failOutcome(
    `${broken.map((p) => `${p.ref} names ${shortSha(p.sha)}, which is gone`).join("; ")} — git gc and a detached checkout abort on ${agree(n, "it", "them")}; \`git update-ref -d <ref>\` drops each (the work ${agree(n, "it", "they")} pinned is already lost)`,
  );
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
 * stays out of that warning.
 * Read-only, like every check; `now` is the claim-age test seam, and an unreadable
 * tumwater.json (config undefined) skips the walk — checkInit reports the config itself. */
export function checkWorkInstances(
  root: string,
  config?: TumwaterConfig | null,
  now = Date.now(),
): CheckOutcome {
  if (!config) return okOutcome("no readable tumwater.json — nothing to verify");
  const claims: Array<{ id: string; title: string; key: string; at: number; file: string }> = [];
  for (const id of runnerIds(config)) {
    const claim = loadRunnerState(root, id).claim;
    if (claim) claims.push({ id, title: claim.title, key: claim.key, at: claim.at, file: claim.file });
  }
  const gone = claims.filter((c) => !listedKeys(root, c.id).has(c.key));
  const stale = claims.filter((c) => !gone.includes(c) && now - c.at > CLAIM_IDLE_MAX_MS);
  const multi = Object.entries(config.roles)
    .filter(
      ([id, role]) => INSTANCE_ROLES.has(id) && role.enabled && (role.instances ?? 1) > 1,
    )
    .map(([id]) => id);
  const slots = slotCount(config);
  const smallPool = multi.length > 0 && slots < config.maxConcurrent;
  if (gone.length === 0 && stale.length === 0 && !smallPool)
    return okOutcome(claimCounts(claims));
  const noun = (c: { file: string }) => (c.file === "BUGS.md" ? "bug" : "plan");
  const parts: string[] = [
    ...gone.map((c) => `claimed ${noun(c)} "${c.title}" (${c.id}) names an entry no longer listed`),
    ...stale.map(
      (c) =>
        `claimed ${noun(c)} "${c.title}" (${c.id}) has been idle ${Math.round((now - c.at) / 3_600_000)}h`,
    ),
  ];
  if (smallPool)
    parts.push(
      `${multi.join(", ")} run instances but worktreeSlots ${slots} is below maxConcurrent ${config.maxConcurrent}`,
    );
  return warnOutcome(parts.join("; "));
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
export function checkProviderConcurrency(config: TumwaterConfig | undefined, root: string): CheckOutcome {
  if (!config) return okOutcome("no config to audit");
  const caps = config.maxConcurrentPerProvider;
  const capEntries = enforcedKeyCaps(caps);
  if (capEntries.length === 0) return okOutcome("no per-provider caps configured");
  // The pi default model the orchestrator's admission seam carries: a bare no-model pi seam
  // resolves its key only through it, so a team whose default is readable has keyed seams and
  // only an unreadable default leaves a key-less seam to warn about.
  const piDefault = readPiDefaultModel(piSettingsPath(piModelsPath()), root);
  const seams = seamsInUse(config);
  const keyed: string[] = [];
  for (const s of seams) {
    const k = seamConcurrencyKey(s, piDefault);
    if (k !== undefined && !keyed.includes(k)) keyed.push(k);
  }
  const keySet = new Set(keyed);
  const capKeys = capEntries.map(([k]) => k);
  const warnings: string[] = [];
  for (const key of capKeys) {
    if (!keySet.has(key)) warnings.push(`cap key "${key}" resolves to no model job (a typo, or a provider not in use)`);
  }
  for (const [key, cap] of capEntries) {
    if (cap >= config.maxConcurrent) warnings.push(`cap "${key}" ${cap} is at or above maxConcurrent ${config.maxConcurrent} — it never binds`);
  }
  const capSet = new Set(capKeys);
  const keyless = seams.filter((s) => seamConcurrencyKey(s, piDefault) === undefined);
  if (capSet.size > 0 && keyless.length > 0) {
    warnings.push(`${keyless.length} model job(s) resolve to no provider key (pi's default provider is unreadable, so they cannot be capped): ${keyless.map((s) => s.label).join(", ")}`);
  }
  if (warnings.length === 0) return okOutcome(`${plural(capEntries.length, "provider cap")} — all model jobs resolve`);
  return warnOutcome(warnings.join("; "));
}
