/**
 * The dashboard's salvaged workspace patch endpoints (barrelled into
 * gui/gui-endpoint-commands.ts, which routes to them from src/gui/gui-server.ts):
 * GET /api/salvage lists every kept patch and POST /api/salvage-apply and
 * POST /api/salvage-drop act on one by its list position — the browser twins of
 * `tumwater salvage`'s list, `--apply <n>` and `--drop <n>`. The dashboard's Settings
 * "Salvaged patches" card renders the list and posts the two actions per row, so an
 * operator can apply or drop a patch from the dashboard without a shell. Every handler
 * runs the same domain functions the CLI runs (collectSalvagePatches,
 * applySalvagePatchForOperator, dropSalvagePatch), so the positions, wording and
 * safety rules cannot drift between the two surfaces. The apply and drop handlers take
 * an injectable operation function (omitted by the production routes) so a test need
 * not apply a real patch into a checkout or delete a real patch file.
 */
import { isGitRepo } from "../git/git.js";
import { applySalvagePatchForOperator } from "../git/slot-salvage.js";
import {
  collectSalvagePatches,
  dropSalvagePatch,
} from "../status/status-salvage.js";
import { formatBytes } from "../text/format.js";
import { readPostBody } from "./gui-endpoint-common.js";
import { badRequest, sendJson } from "./gui-http-body.js";
import type http from "node:http";

/** The one position check both action handlers share: the body must carry an integer
 * `position` >= 1; a missing, non-integer or below-1 value answers 400 (nothing
 * written) and yields null. */
function requirePosition(
  res: http.ServerResponse,
  body: Record<string, unknown>,
): number | null {
  const position = body.position;
  if (typeof position !== "number" || !Number.isInteger(position) || position < 1) {
    badRequest(res, "a whole-number patch position of at least 1 is required");
    return null;
  }
  return position;
}

/** Handle GET /api/salvage: every operator-kept workspace patch under `.tumwater/salvage/`
 * oldest first (collectSalvagePatches, the same walk the status snapshot's `salvagePatches`
 * and the doctor `salvage patches` row use), each row carrying the list's own `position`,
 * `file`, `savedAt`, `bytes` and a display `size` (formatBytes) for the card to render.
 * A missing or unreadable salvage dir answers the empty list, and pending patches under
 * `salvage/<role>/` wait for their role's next run, so they are never listed here. */
export function handleSalvageList(res: http.ServerResponse, root: string): void {
  const patches = collectSalvagePatches(root).map((p) => ({
    position: p.position,
    file: p.file,
    savedAt: p.savedAt,
    bytes: p.bytes,
    size: formatBytes(p.bytes),
  }));
  sendJson(res, 200, { patches });
}

/** Handle POST /api/salvage-apply: apply the Nth kept patch to the dashboard's checkout
 * (applySalvagePatchForOperator, the same operation as `tumwater salvage --apply <n>`):
 * the body's `position` must be a whole number >= 1 (400 otherwise); an out-of-range
 * position answers 200 ok:false naming how many patches the list holds, without writing;
 * a root that is not a git checkout answers 409 with the CLI's checkout sentence; a clean
 * apply answers ok:true naming the position and file (the patch file is kept, and nothing
 * is committed); a patch the tree rejects answers ok:false with the CLI's refusal and
 * changes no file. `apply` defaults to the domain function and exists only so a test can
 * inject one. */
export async function handleSalvageApply(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  root: string,
  apply: (root: string, file: string) => Promise<boolean> = applySalvagePatchForOperator,
): Promise<void> {
  const body = await readPostBody(req, res, '{"position": 1}');
  if (!body) return;
  const position = requirePosition(res, body);
  if (position === null) return;
  const patches = collectSalvagePatches(root);
  if (position > patches.length) {
    sendJson(res, 200, {
      ok: false,
      message: `no salvaged workspace patch at position ${position} (salvage holds ${patches.length} patches)`,
    });
    return;
  }
  const patch = patches[position - 1]!;
  if (!(await isGitRepo(root))) {
    sendJson(res, 409, {
      ok: false,
      message: "salvage --apply needs a git checkout (run it from the checkout the patch should apply to)",
    });
    return;
  }
  const applied = await apply(root, patch.file);
  if (!applied) {
    sendJson(res, 200, {
      ok: false,
      message: `salvaged workspace patch ${patch.file} does not apply cleanly to this checkout — no files were changed (run tumwater salvage --show ${position} to print it for a manual apply)`,
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    applied: { position, file: patch.file },
    message: `applied salvaged workspace patch ${position}: ${patch.file}`,
  });
}

/** Handle POST /api/salvage-drop: delete the Nth kept patch (dropSalvagePatch, the same
 * operation as `tumwater salvage --drop <n>`), leaving every other patch and `pending/<role>/`
 * alone. The body's `position` must be a whole number >= 1 (400 otherwise); an
 * out-of-range position answers 200 ok:false naming how many patches the list holds,
 * deleting nothing; a successful drop answers ok:true naming the position and file, and
 * an unremovable patch answers ok:false naming it. `drop` defaults to the domain function
 * and exists only so a test can inject one. */
export async function handleSalvageDrop(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  root: string,
  drop: (root: string, file: string) => boolean = dropSalvagePatch,
): Promise<void> {
  const body = await readPostBody(req, res, '{"position": 1}');
  if (!body) return;
  const position = requirePosition(res, body);
  if (position === null) return;
  const patches = collectSalvagePatches(root);
  if (position > patches.length) {
    sendJson(res, 200, {
      ok: false,
      message: `no salvaged workspace patch at position ${position} (salvage holds ${patches.length} patches)`,
    });
    return;
  }
  const patch = patches[position - 1]!;
  if (!drop(root, patch.file)) {
    sendJson(res, 200, {
      ok: false,
      message: `could not drop salvaged patch ${patch.file}`,
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    dropped: { position, file: patch.file },
    message: `dropped salvaged workspace patch ${position}: ${patch.file}`,
  });
}
