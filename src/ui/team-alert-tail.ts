/** The tail team alerts, in emission order: a run of quiet hours holding the team, a maintenance
 * allowance held at its rolling cap, a standing provider failure hold, an operator pause with
 * its countdown, the last day's capacity contention, a stale workspace pin, a fixed test that
 * regressed, a stopped tumwater, and roles that cannot or may not read images. One of the
 * per-domain builders split out of src/ui/team-alerts.ts; the shared types and wording helpers
 * live in team-alert-shared.ts. */

import { listRoleIds, listRoles, openRoleActions, seeFailures, type TeamAlert, type AlertRole } from "./team-alert-shared.js";
import type { StatusSnapshot } from "../status/status-data.js";
import type { CapacityBottleneck, RegressedFixAlert } from "./status-payload.js";
import { stalePinPhrase, type StaleWorkspacePin } from "../doctor/doctor-contention-checks.js";
import { quietWindowEnd } from "../scheduling/quiet-hours.js";
import { pauseCountdown } from "./badges.js";
import { agree, pauseReasonSuffix, plural } from "../text/phrases.js";
import { humanUntil } from "../text/datetime.js";
import { squash } from "../text/text.js";

interface TailAlertsInput {
  snap: Pick<
    StatusSnapshot,
    | "inQuietHours"
    | "quietHours"
    | "maintenanceQuota"
    | "providerHolds"
    | "paused"
    | "pausedUntil"
    | "pauseReason"
    | "running"
  >;
  now: number;
  contention: readonly CapacityBottleneck[];
  regressedFixes: RegressedFixAlert | null;
  roles: readonly AlertRole[];
  workspacePins: readonly StaleWorkspacePin[];
  instancePool: readonly string[];
  providerCaps: readonly string[];
}

function pushQuietAlert(out: TeamAlert[], snap: TailAlertsInput["snap"]): void {
  // Quiet hours (plans: "Quiet hours … part 2/2, observability") informs rather than asks:
  // the team holding to a schedule is not a problem, but an operator watching idle roles
  // inside the window needs the same explanation the pause alert gives a paused team —
  // why nothing runs, and when it starts again. The window end comes from quiet-hours.ts's
  // quietWindowEnd, the same helper quietBadge uses for the header.
  if (snap.inQuietHours && snap.quietHours) {
    const end = quietWindowEnd(snap.quietHours);
    out.push({
      key: "quiet",
      tone: "blue",
      title: `Quiet hours — roles start no new runs until ${end}`,
      detail: `The schedule (${snap.quietHours} local time, quietHours in tumwater.json) holds them. Runs in progress finish, and the director still runs your prompts.`,
      actions: [],
    });
  }
}

function pushMaintenanceAlert(out: TeamAlert[], snap: TailAlertsInput["snap"]): void {
  // The maintenance allowance (plans/work-ratio.md, part 1b/4): by design and self-clearing —
  // the scheduler holds maintenance roles at the rolling 24 h allowance until merges free room,
  // then they run again on their own — so it informs (gray, no actions), the quiet alert's
  // tone, rather than amber like the failed/refused asks. An operator watching idle maintenance
  // roles gets the same explanation the hold's own row carries, team-wide.
  if (snap.maintenanceQuota.held.length > 0) {
    const mq = snap.maintenanceQuota;
    out.push({
      key: "maintenance",
      tone: "gray",
      title: "Maintenance is held at its rolling allowance",
      detail: `${mq.used} of ${mq.allowance} maintenance allowance used over the last 24 h; ${listRoleIds(mq.held)} ${agree(mq.held.length, "resumes", "resume")} as work merges.`,
      actions: [],
    });
  }
}

function pushProviderHoldAlert(out: TeamAlert[], snap: TailAlertsInput["snap"], now: number): void {
  // A standing provider failure hold (src/team/team-hold.ts `standingHolds`, published through
  // the orchestrator info file): a provider storm holds roles on that provider, so an operator
  // watching idle roles with no log open sees why nothing new starts there. Self-clearing by
  // design — the hold re-opens at its own deadline — so it informs (blue, no actions), the
  // quiet and maintenance alerts' tone, rather than asking. The snapshot carries the holds only
  // while a live orchestrator publishes one.
  if (snap.providerHolds && snap.providerHolds.length > 0) {
    const phrased = snap.providerHolds
      .map(
        (h) =>
          `${h.provider ?? "pi's default backend"} (${h.kind}) until it re-opens in ${humanUntil(h.until, now)}`,
      )
      .join("; ");
    out.push({
      key: "provider-hold",
      tone: "blue",
      title: agree(snap.providerHolds.length, "Provider limit is holding new runs", "Provider limits are holding new runs"),
      detail: `${phrased}. Runs in progress finish; roles on a held provider start no new runs until it re-opens.`,
      actions: [],
    });
  }
}

function pushProviderCapsAlert(out: TeamAlert[], providerCaps: readonly string[]): void {
  // A `maxConcurrentPerProvider` map that cannot do its job — the always-on twin of the doctor's
  // `provider concurrency` row (doctor-contention-checks.ts checkProviderConcurrency): a cap key
  // no seam resolves to, a cap at or above maxConcurrent, or a keyless seam in a capped team.
  // The provider-hold and contention alerts cover a cap that is merely too small; this one
  // names the static misconfiguration itself, which the doctor row is the only other surface
  // that exposes. alert-feeds.ts's providerCapProblems feeds it the row's own warning strings,
  // so the alert and the row cannot drift on the trigger or the wording.
  if (providerCaps.length > 0) {
    out.push({
      key: "provider-caps",
      tone: "amber",
      title: "maxConcurrentPerProvider is misconfigured",
      detail: `${providerCaps.join("; ")} — fix the map in tumwater.json (each key must name a provider the team runs on, and each cap must sit below maxConcurrent); the provider-hold and contention alerts cover a cap that is merely too small.`,
      actions: [],
    });
  }
}

function pushPausedAlert(out: TeamAlert[], snap: TailAlertsInput["snap"], now: number): void {
  if (snap.paused) {
    const left = pauseCountdown(snap.pausedUntil, now);
    out.push({
      key: "paused",
      tone: "amber",
      // The operator's pause reason (`pause --reason <text>`) states verbatim, so an
      // operator returning to a paused team knows why without digging through history.
      title: left
        ? `The team is paused and resumes in ${left}${pauseReasonSuffix(snap.pauseReason)}`
        : `The team is paused${pauseReasonSuffix(snap.pauseReason)}`,
      detail: "Roles start no new runs. Runs in progress finish, and the director still runs your prompts.",
      actions: [{ label: "Resume now", act: "resume" }],
    });
  }
}

function pushContentionAlert(out: TeamAlert[], contention: readonly CapacityBottleneck[]): void {
  // Last day's capacity contention — the always-on twin of the doctor's `workspaces`,
  // `provider contention` and `check contention` rows (doctor-contention-checks.ts). The
  // instantaneous badges show only current waits, and the 24 h total is the tuning signal that
  // says a cap is too small; alert-feeds.ts's capacityContention feeds it from the same
  // `*_wait` events and ten-minute thresholds the doctor sums, so the alert and the doctor
  // cannot drift on the trigger or the knob-raising advice.
  if (contention.length > 0) {
    out.push({
      key: "contention",
      tone: "amber",
      title: plural(contention.length, "capacity bottleneck in the last day", "capacity bottlenecks in the last day"),
      detail: contention.map((c) => `${c.name}: ${squash(c.detail, 200)}`).join(" · "),
      actions: [],
    });
  }
}

function pushWorkspacePinsAlert(out: TeamAlert[], workspacePins: readonly StaleWorkspacePin[]): void {
  // A stale workspace pin — the always-on twin of the doctor's `worktree pool` row's stuck-pin
  // clause (doctor-contention-checks.ts checkWorktreePool): a slot pinned past a day by a run
  // that never resumed silently shrinks the pool, and no other observer surface names it until
  // an operator runs `tumwater doctor`. alert-feeds.ts feeds it the same staleWorkspacePins
  // predicate the doctor's row uses, so the alert and the row cannot drift on what is stale;
  // the "Open <role>" buttons reach the role drawer like the other role alerts.
  if (workspacePins.length > 0) {
    out.push({
      key: "workspace-pins",
      tone: "amber",
      title: plural(workspacePins.length, "workspace pinned past a day", "workspaces pinned past a day"),
      detail: `${workspacePins
        .map(stalePinPhrase)
        .join("; ")} — a pinned workspace is held out of the pool; resume the role, or retire its leftovers and run \`tumwater doctor\``,
      actions: openRoleActions(workspacePins),
    });
  }
}

function pushInstancePoolAlert(out: TeamAlert[], instancePool: readonly string[]): void {
  // An enabled multi-instance role sharing a workspace pool smaller than the run cap — the
  // always-on twin of the doctor `parallel instances` row's pool-mismatch clause
  // (doctor-contention-checks.ts smallPoolProblems): instances then contend for the same
  // pooled checkouts, unseen until an operator runs `tumwater doctor`. alert-feeds.ts feeds
  // it the same smallPoolProblems selector the row uses, so the alert and the row cannot
  // drift on the trigger, the role list, or the wording.
  if (instancePool.length > 0) {
    out.push({
      key: "instance-pool",
      tone: "amber",
      title: "Parallel instances share a workspace pool smaller than the run cap",
      detail: `${instancePool.join("; ")} — runs wait for a pooled checkout; raise worktreeSlots to at least maxConcurrent, or lower maxConcurrent.`,
      actions: [],
    });
  }
}

function pushRegressedFixesAlert(out: TeamAlert[], regressedFixes: RegressedFixAlert | null): void {
  // A Fixed record whose quoted test failed again in the trailing day — the always-on twin of
  // the doctor's `regressed fixes` row (doctor-backlog-bugs.ts checkRegressedFixes).
  // alert-feeds.ts's regressedFixesAlert feeds it the same candidate selection, failureMentions
  // match and verbatim sentence, so the alert and the doctor cannot drift on the trigger or the
  // wording; the Failures view shows the naming events.
  if (regressedFixes) {
    out.push({
      key: "regressed-fixes",
      tone: "amber",
      title: plural(regressedFixes.count, "Fixed test has regressed", "Fixed tests have regressed"),
      detail: regressedFixes.detail,
      actions: seeFailures(),
    });
  }
}

function pushStoppedAlert(out: TeamAlert[], snap: TailAlertsInput["snap"]): void {
  if (!snap.running) {
    out.push({
      key: "stopped",
      tone: "gray",
      title: "tumwater is not running — start it with `tumwater start`",
      detail: "Start it with tumwater start in the project directory; the dashboards pick it up on their own.",
      actions: [{ label: "Copy the command", act: "copy", arg: "tumwater start" }],
    });
  }
}

function pushImagesAlert(out: TeamAlert[], roles: readonly AlertRole[]): void {
  // Image input (plans/image-input.md "Surfaces", part 5/5): a role whose model cannot read
  // images. Blue when every text-only role has a reroute target (a run that reads an image
  // stops and reruns — nothing fails); amber when some text-only role has none (a blind read
  // fails and image submissions are refused). No alert
  // when every enabled role reads images (imageInput true or unknown — an unknown seam is not
  // counted as text-only, mirroring the submit gate and the doctor's `tier models` stance).
  const textOnly = roles.filter((l) => l.imageInput === false);
  const noTarget = textOnly.filter((l) => l.imageReroute == null || l.imageReroute === "");
  if (noTarget.length > 0) {
    out.push({
      key: "images",
      tone: "amber",
      title: `No configured model can read images for ${listRoles(noTarget)}`,
      detail: "A run that reads an image fails, and image attachments to these roles are refused. Declare image input on a vision model in pi's models.json, or point a tier at one.",
      actions: openRoleActions(noTarget),
    });
  } else if (textOnly.length > 0) {
    const targets = [...new Set(textOnly.map((l) => l.imageReroute ?? ""))].filter(Boolean);
    out.push({
      key: "images",
      tone: "blue",
      title: `${listRoles(textOnly)} ${agree(textOnly.length, "runs", "run")} on models that can't read images`,
      detail: `A run that reads an image stops and reruns on ${targets.join(", ")}.`,
      actions: [],
    });
  }
}

/** The quiet-hours, maintenance, provider-hold, pause, capacity-contention, provider-cap,
 * instance-pool, stale-workspace-pin, regressed-fix, stopped and image-input alerts, in
 * emission order: a run of quiet hours
 * holding the team, a
 * maintenance allowance held at its rolling cap, a standing provider failure hold, an operator
 * pause with its countdown, the last day's capacity contention, a stale workspace pin, a
 * fixed test that regressed, a
 * stopped tumwater, and roles that cannot or may not read images. Extracted from teamAlerts
 * (part 5/5 of the teamAlerts split) so the shared module stays small; the input names exactly
 * the fields this run reads, including `now`, which the pause countdown and provider-hold
 * re-open time need. The caller pushes the returned alerts at the position this run used to
 * occupy, so the emitted key order is unchanged. */
export function buildTailAlerts(input: TailAlertsInput): TeamAlert[] {
  const out: TeamAlert[] = [];
  const { snap, now, contention, regressedFixes, roles, workspacePins, instancePool, providerCaps } = input;

  pushQuietAlert(out, snap);
  pushMaintenanceAlert(out, snap);
  pushProviderHoldAlert(out, snap, now);
  pushProviderCapsAlert(out, providerCaps);
  pushPausedAlert(out, snap, now);
  pushContentionAlert(out, contention);
  pushWorkspacePinsAlert(out, workspacePins);
  pushInstancePoolAlert(out, instancePool);
  pushRegressedFixesAlert(out, regressedFixes);
  pushStoppedAlert(out, snap);
  pushImagesAlert(out, roles);
  return out;
}
