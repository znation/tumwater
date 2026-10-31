/** The standing doctor-twin team alerts, in emission order: no-check, no-brief,
 * brief-truncated, role-notes-truncated, instance-pool, principles-truncated. One of the
 * per-domain builders split out of src/ui/team-alerts.ts; the shared types and wording
 * helpers live in team-alert-shared.ts.
 *
 * These six are the standing amber alerts docs/cli.md promises on `tumwater status`, the
 * dashboard and the TUI — the always-on twins of their doctor rows. The snapshot carries
 * their state as raw fields (noDeclaredCheck, noBrief, briefTruncated, roleNotesOverCap,
 * principlesTruncated) and this module raises each as its alert when its flag stands,
 * phrasing the detail from the same check or selector the doctor row runs (doctor-project-
 * checks.ts checkBuildCheck, doctor-checks.ts checkBrief, doctor-role-notes.ts
 * checkRoleNotes, doctor-contention-checks.ts smallPoolProblems, doctor-principles.ts
 * checkPrinciples), so the alert and the row cannot drift on the trigger, the caps, or the
 * remedy. The raw fields stay the machine-readable `--json` keys; the alert is the rendered
 * half the docs name. */

import type { TeamAlert } from "./team-alert-shared.js";
import type { StatusSnapshot } from "../status/status-data.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { checkBuildCheck } from "../doctor/doctor-project-checks.js";
import { checkBrief } from "../doctor/doctor-checks.js";
import { checkRoleNotes } from "../doctor/doctor-role-notes.js";
import { checkPrinciples } from "../doctor/doctor-principles.js";
import { smallPoolProblems } from "../doctor/doctor-contention-checks.js";
import { plural } from "../text/phrases.js";
import { ROLE_NOTES_MAX_BYTES } from "../agent/role-notes-write.js";

/** The standing-alert half of the snapshot: exactly the fields this builder reads. `config`
 * is the observer's config (configForStatus's last-known-good read) — instance-pool's
 * trigger is the CONFIGURED pool (worktreeSlots below maxConcurrent) and instance count
 * (an instance role's instances above 1), a state the running-only slotPool snapshot does
 * not carry at all for a stopped team, and the docs promise the alert there too. */
export interface StandingAlertsInput {
  snap: Pick<
    StatusSnapshot,
    "noDeclaredCheck" | "noBrief" | "briefTruncated" | "roleNotesOverCap" | "principlesTruncated"
  >;
  config: TumwaterConfig;
  root: string;
}

// Each arm: the snapshot's raw flag (the `--json` twin) gates the alert, and the detail is
// the doctor row's own warn sentence, so alert and row stay twins by construction. A row
// that reads ok is a state the flag's own read could not see (a concurrent write between the
// flag's read and the row's) — the alert follows the flag, so it raises nothing.

function pushNoCheckAlert(out: TeamAlert[], config: TumwaterConfig, root: string): void {
  const row = checkBuildCheck(root, config.check ? { check: config.check } : null);
  if (row.level !== "warn") return;
  out.push({
    key: "no-check",
    tone: "amber",
    title: "No build check declared",
    detail: row.detail,
    actions: [],
  });
}

function pushNoBriefAlert(out: TeamAlert[], root: string): void {
  const row = checkBrief(root);
  if (row.level !== "warn") return;
  out.push({
    key: "no-brief",
    tone: "amber",
    title: "No project brief",
    detail: row.detail,
    actions: [],
  });
}

// checkBrief's warn for an over-cap block is only reachable with a non-empty prompt — the
// same state snap.briefTruncated names — so the row's detail is the over-cap sentence here.
function pushBriefTruncatedAlert(out: TeamAlert[], root: string): void {
  const row = checkBrief(root);
  if (row.level !== "warn") return;
  out.push({
    key: "brief-truncated",
    tone: "amber",
    title: "Brief over its read cap — every role sees only its head",
    detail: row.detail,
    actions: [],
  });
}

// The row's warn sentence names every over-bound role (capped, with "and N more") and the
// remedy, so the alert reuses it whole; the title's count is the snapshot array's length,
// which the row's named cap would undercount past three roles.
function pushRoleNotesAlert(
  out: TeamAlert[],
  over: NonNullable<StatusSnapshot["roleNotesOverCap"]>,
  root: string,
): void {
  const row = checkRoleNotes(root);
  if (row.level !== "warn") return;
  out.push({
    key: "role-notes-truncated",
    tone: "amber",
    title: `${plural(over.length, "role note", "role notes")} over the ${ROLE_NOTES_MAX_BYTES}-character read bound`,
    detail: row.detail,
    actions: [],
  });
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

function pushPrinciplesAlert(out: TeamAlert[], root: string): void {
  const row = checkPrinciples(root);
  if (row.level !== "warn") return;
  out.push({
    key: "principles-truncated",
    tone: "amber",
    title: "PRINCIPLES.md over its prompt cap — roles see only the head",
    detail: row.detail,
    actions: [],
  });
}

/** The standing doctor-twin alerts, in emission order: no-check, no-brief,
 * brief-truncated, role-notes-truncated, instance-pool, principles-truncated. The caller
 * pushes the returned alerts at the position this run used to occupy, so the emitted key
 * order is unchanged. */
export function buildStandingAlerts(input: StandingAlertsInput): TeamAlert[] {
  const { snap, config, root } = input;
  const out: TeamAlert[] = [];
  if (snap.noDeclaredCheck) pushNoCheckAlert(out, config, root);
  if (snap.noBrief) pushNoBriefAlert(out, root);
  if (snap.briefTruncated) pushBriefTruncatedAlert(out, root);
  if (snap.roleNotesOverCap && snap.roleNotesOverCap.length > 0)
    pushRoleNotesAlert(out, snap.roleNotesOverCap, root);
  pushInstancePoolAlert(out, config);
  if (snap.principlesTruncated) pushPrinciplesAlert(out, root);
  return out;
}
