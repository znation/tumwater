/** The standing doctor-twin team alerts, in emission order: no-check, no-brief,
 * brief-truncated, role-notes-truncated, salvage-patches, instance-pool, and the
 * config-problem alert. One of the per-domain builders split out of
 * src/ui/team-alerts.ts; the shared types and wording helpers live in team-alert-shared.ts.
 *
 * These seven are the standing amber alerts docs/cli.md promises on `tumwater status`, the
 * dashboard and the TUI — the always-on twins of their doctor rows. (An over-cap
 * PRINCIPLES.md raises none: the orchestrator instead queues the director a consolidation
 * prompt — src/prompt/principles-consolidation.ts — while the `principlesTruncated` key and
 * the doctor `principles` row stay the diagnostic.) The snapshot carries
 * their state as raw fields (noDeclaredCheck, noBrief, briefTruncated, roleNotesOverCap,
 * salvagePatches, configProblem) and this module raises each as its
 * alert when its flag stands, phrasing the detail from the same check or selector the
 * doctor row runs (doctor-project-checks.ts checkBuildCheck, doctor-checks.ts checkBrief,
 * doctor-role-notes.ts checkRoleNotes, doctor-salvage.ts checkSalvagePatches,
 * doctor-contention-checks.ts smallPoolProblems, or
 * the doctor `init` row's config-validity check for config-problem), so the alert and the
 * row cannot drift on the trigger, the caps, or the remedy. The raw fields stay the
 * machine-readable `--json` keys; the alert is the rendered half the docs name. */

import type { TeamAlert } from "./team-alert-shared.js";
import type { StatusSnapshot } from "../status/status-data.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import type { CheckOutcome } from "../doctor/doctor-outcome.js";
import { checkBuildCheck } from "../doctor/doctor-project-checks.js";
import { checkBrief } from "../doctor/doctor-checks.js";
import { checkRoleNotes } from "../doctor/doctor-role-notes.js";
import { checkSalvagePatches } from "../doctor/doctor-salvage.js";
import { smallPoolProblems } from "../doctor/doctor-contention-checks.js";
import { plural } from "../text/phrases.js";
import { ROLE_NOTES_MAX_BYTES } from "../roles/role-notes-write.js";

/** The standing-alert half of the snapshot: exactly the fields this builder reads. `config`
 * is the observer's config (configForStatus's last-known-good read) — instance-pool's
 * trigger is the CONFIGURED pool (worktreeSlots below maxConcurrent) and instance count
 * (an instance role's instances above 1), a state the running-only slotPool snapshot does
 * not carry at all for a stopped team, and the docs promise the alert there too. */
interface StandingAlertsInput {
  snap: Pick<
    StatusSnapshot,
    "noDeclaredCheck" | "noBrief" | "briefTruncated" | "roleNotesOverCap" | "salvagePatches" |
      "configProblem"
  >;
  config: TumwaterConfig;
  root: string;
}

// Each arm is gated by the snapshot's raw flag (the `--json` twin). The six arms whose
// trigger is a doctor row raise their amber alert through pushDoctorTwinAlert — whose doc
// states how the row's warn level is the trigger and its warn sentence the detail — so the
// alert and the row stay twins by construction. The instance-pool arm reads the
// smallPoolProblems selector instead of a doctor row and keeps its own body.

/** Push one standing amber alert off a doctor row that reads `warn`: the row's detail is the
 * alert's detail and its warn level the trigger, so the alert and the row stay twins by
 * construction — a row that reads ok is a state the snapshot flag's own read could not see
 * (a concurrent write between the flag's read and the row's), and it raises nothing. `key`
 * and `title` are the arm's own; the tone is fixed amber and the actions empty, as every
 * doctor-twin standing alert is. The five arms that read a CheckOutcome use it: no-check,
 * no-brief, brief-truncated, role-notes-truncated and salvage-patches.
 * instance-pool is not one — it reads the smallPoolProblems selector, not a doctor row, so it
 * keeps its own arm. */
function pushDoctorTwinAlert(out: TeamAlert[], row: CheckOutcome, key: string, title: string): void {
  if (row.level !== "warn") return;
  out.push({ key, tone: "amber", title, detail: row.detail, actions: [] });
}

function pushNoCheckAlert(out: TeamAlert[], config: TumwaterConfig, root: string): void {
  pushDoctorTwinAlert(
    out,
    checkBuildCheck(root, config.check ? { check: config.check } : null),
    "no-check",
    "No build check declared",
  );
}

function pushNoBriefAlert(out: TeamAlert[], root: string): void {
  pushDoctorTwinAlert(out, checkBrief(root), "no-brief", "No project brief");
}

// checkBrief's warn for an over-cap block is only reachable with a non-empty prompt — the
// same state snap.briefTruncated names — so the row's detail is the over-cap sentence here.
function pushBriefTruncatedAlert(out: TeamAlert[], root: string): void {
  pushDoctorTwinAlert(out, checkBrief(root), "brief-truncated", "Brief over its read cap — every role sees only its head");
}

// The row's warn sentence names every over-bound role (capped, with "and N more") and the
// remedy, so the alert reuses it whole; the title's count is the snapshot array's length,
// which the row's named cap would undercount past three roles.
function pushRoleNotesAlert(
  out: TeamAlert[],
  over: NonNullable<StatusSnapshot["roleNotesOverCap"]>,
  root: string,
): void {
  pushDoctorTwinAlert(
    out,
    checkRoleNotes(root),
    "role-notes-truncated",
    `${plural(over.length, "role note", "role notes")} over the ${ROLE_NOTES_MAX_BYTES}-character read bound`,
  );
}

// The doctor's `parallel instances` row carries more than the pool clause (stale and gone
// claims), so the alert reads the shared selector itself — the same smallPoolProblems the
// row uses — and names only the pool clause.
function pushInstancePoolAlert(out: TeamAlert[], config: TumwaterConfig): void {
  const clauses = smallPoolProblems(config);
  if (clauses.length === 0) return;
  out.push({
    key: "instance-pool",
    tone: "amber",
    title: "Workspace pool below the run cap — instances contend",
    detail: clauses.join("; "),
    actions: [],
  });
}

// The doctor `init` row's config-validity failure is the sibling of configProblem (both
// read the live tumwater.json), but the standing surface cannot wait on a doctor run, so
// this arm raises from the snapshot string itself — the same trigger the `--json` key names.
function pushConfigProblemAlert(out: TeamAlert[], problem: string): void {
  out.push({
    key: "config-problem",
    tone: "amber",
    title: "tumwater.json cannot be loaded — the team keeps its last good config",
    detail: `${problem} — fix or restore tumwater.json; the running team keeps its last good config until it loads again`,
    actions: [],
  });
}

// The doctor `salvage patches` row's warn detail names the count, the oldest patch's age
// and the remedy, so the alert reuses it whole through the six shared doctor-twin arms.
function pushSalvagePatchesAlert(out: TeamAlert[], root: string): void {
  pushDoctorTwinAlert(
    out,
    checkSalvagePatches(root),
    "salvage-patches",
    "Salvaged workspace patches kept for you",
  );
}

/** The standing doctor-twin alerts, in emission order: no-check, no-brief,
 * brief-truncated, role-notes-truncated, salvage-patches, instance-pool, config-problem.
 * The caller pushes the returned alerts at the position this run used to
 * occupy, so the emitted key order is unchanged. */
export function buildStandingAlerts(input: StandingAlertsInput): TeamAlert[] {
  const { snap, config, root } = input;
  const out: TeamAlert[] = [];
  if (snap.noDeclaredCheck) pushNoCheckAlert(out, config, root);
  if (snap.noBrief) pushNoBriefAlert(out, root);
  if (snap.briefTruncated) pushBriefTruncatedAlert(out, root);
  if (snap.roleNotesOverCap && snap.roleNotesOverCap.length > 0)
    pushRoleNotesAlert(out, snap.roleNotesOverCap, root);
  if (snap.salvagePatches && snap.salvagePatches.length > 0)
    pushSalvagePatchesAlert(out, root);
  pushInstancePoolAlert(out, config);
  if (snap.configProblem) pushConfigProblemAlert(out, snap.configProblem);
  return out;
}
