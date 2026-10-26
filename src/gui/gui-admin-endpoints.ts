/**
 * The dashboard's GET settings/admin handlers (src/gui/gui-server.ts routes to them):
 * prompt-text, doctor, config, retire-list, and brief. Each answers its request and touches no
 * socket beyond its own `res`; the domain work lives one layer down (doctor/doctor.js,
 * config/config.js, operator/retire.js), so this module only adapts HTTP onto it. Barrelled
 * into gui/gui-endpoints.ts beside the other per-family GET endpoint modules.
 */
import { runDoctor } from "../doctor/doctor.js";
import type { DoctorReport } from "../doctor/doctor-checks.js";
import { knownRoleIds, loadConfigSafe } from "../config/config.js";
import { runnerEnabled } from "../roles/runner-ids.js";
import { artifactPhrase, previewRetire } from "../operator/retire.js";
import { EDITABLE_CONFIG_KEYS } from "../config/config-editable-keys.js";
import { readBrief } from "../brief/brief.js";
import { readQueuedPromptBody } from "../inbox/inbox-edit.js";
import { rejectBadQueueFileName, rejectBadRole } from "./gui-args.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { okGone, sendJson } from "./gui-http-body.js";
import type http from "node:http";
/** Handle GET /api/prompt-text?file=<name>[&role=<id>]: one queued prompt's editable body —
 * the text an edit replaces, for the dashboard's per-row edit affordance (PLANS.md
 * 2026-10-11). The prompt is addressed by its queue-file basename (the /api/prompt-cancel
 * address), so a stale poll's snapshot can never read the wrong entry; the not-before deferral
 * marker and the `[image attached: …]` reference block are stripped, both plumbing the edit
 * carries over unchanged. The role is optional (absent reads the director's queue) and
 * validates exactly like /api/transcript; a file name failing the shared
 * rejectBadQueueFileName guard is a user-input error answered 400 with nothing read. A
 * vanished file answers 200 { ok: true, status: "gone" } — the role already dequeued
 * it, which is data for the UI, not a server fault. Reads one file directly, so it works
 * whether or not the team is running. */
export function handlePromptText(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const roleParam = q.get("role");
  if (roleParam !== null && rejectBadRole(root, res, roleParam)) return;
  const role = roleParam ?? DIRECTOR_ROLE;
  const file = q.get("file");
  if (rejectBadQueueFileName(res, file)) return;
  const text = readQueuedPromptBody(root, role, file as string);
  if (text === null) {
    okGone(res);
    return;
  }
  sendJson(res, 200, { ok: true, text });
}
/** Handle GET /api/doctor: the same DoctorReport `tumwater doctor --json` prints, so the
 * Settings view's Health check card and the CLI cannot disagree. Read-only — the checks write
 * nothing (runDoctor's own contract) — and it works whether or not the team is running. `run`
 * exists so tests can skip the host probes; it never probes images ("never") — the explicit
 * re-probe is POST /api/doctor-reprobe; a throw reaches the server's outer 500. */
export async function handleDoctor(
  res: http.ServerResponse,
  root: string,
  run: (root: string) => Promise<DoctorReport> = (r: string) => runDoctor(r, undefined, undefined, "never"),
): Promise<void> {
  sendJson(res, 200, await run(root));
}
/** Handle GET /api/config: the Settings view's resolved values for exactly
 * EDITABLE_CONFIG_KEYS — read through the same load path `tumwater config get` uses
 * (loadConfigSafe, defaults merged in), so the page shows what the team would actually
 * load. A broken or invalid tumwater.json answers 500 with validateConfig's message instead
 * of serving a half-empty panel. */
export function handleConfig(res: http.ServerResponse, root: string): void {
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) {
    sendJson(res, 500, { error });
    return;
  }
  const record = config as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE_CONFIG_KEYS) out[key] = record[key] ?? null;
  sendJson(res, 200, out);
}
/** Handle GET /api/retire: the Settings view's "Disabled roles" card — every configured,
 * disabled, non-director role, with what `tumwater retire` would remove (previewRetire, so the
 * rails and wording are the CLI's) and the rails' objections. `wouldRemove` is empty when there
 * is nothing to retire (a role disabled with a clean checkout), so the card can also re-enable
 * a role via POST /api/role-enable. Read-only (previewRetire's contract) and works whether or
 * not the team runs; a throw reaches the server's outer 500, an unreadable tumwater.json
 * answers 500 like /api/config. */
export async function handleRetireList(res: http.ServerResponse, root: string): Promise<void> {
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) {
    sendJson(res, 500, { error });
    return;
  }
  const roles = [];
  for (const role of knownRoleIds(config).filter((id) => id !== DIRECTOR_ROLE && !runnerEnabled(config, id))) {
    const { wouldRemove, objections } = await previewRetire(root, role);
    roles.push({ role, wouldRemove, phrases: wouldRemove.map((a) => artifactPhrase(a, role)), objections });
  }
  sendJson(res, 200, { roles });
}
/** Handle GET /api/brief: the brief file's name and the current brief text (what
 * `tumwater brief --json` prints), or 404 when no brief carries a prompt block. */
export function handleBrief(res: http.ServerResponse, root: string): void {
  const brief = readBrief(root);
  if (brief === null) return sendJson(res, 404, { error: "no project brief with a prompt block found — run `tumwater init` first" });
  sendJson(res, 200, { file: brief.file, prompt: brief.prompt });
}
