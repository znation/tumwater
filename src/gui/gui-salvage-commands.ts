/**
 * The dashboard's salvaged workspace patch endpoints (barrelled into
 * gui/gui-endpoint-commands.ts, which routes to them from src/gui/gui-server.ts):
 * GET /api/salvage lists every kept patch, optionally narrowed by a `q` filter the way
 * `tumwater salvage --grep <text>` narrows the CLI list, GET /api/salvage-show reads one back
 * for reading,
 * and POST /api/salvage-apply and POST /api/salvage-drop act on one by its list position — the
 * browser twins of `tumwater salvage`'s list, `--show <n>`, `--apply <n>` and `--drop <n>`. The
 * dashboard's Settings "Salvaged patches" card renders the list and posts the actions per row,
 * so an operator can read, apply or drop a patch from the dashboard without a shell. Every
 * handler runs the same domain functions the CLI runs (collectSalvagePatches, readSalvagePatch,
 * salvagePatchStat, applySalvagePatchForOperator, dropSalvagePatch), so the positions, wording
 * and safety rules cannot drift between the two surfaces. The apply and drop handlers take
 * an injectable operation function (omitted by the production routes) so a test need
 * not apply a real patch into a checkout or delete a real patch file.
 */
import { isGitRepo } from "../git/git.js";
import { applySalvagePatchForOperator, salvagePatchStat } from "../git/slot-salvage.js";
import {
  collectSalvagePatches,
  dropSalvagePatch,
  grepSalvagePatches,
  readSalvagePatch,
  salvagePatchAt,
} from "../status/status-salvage.js";
import { formatBytes } from "../text/format.js";
import { prunePhrase } from "../text/datetime.js";
import { liveConfig } from "../config/config.js";
import { intQuery } from "./gui-args.js";
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
 * `file`, `savedAt`, `bytes`, a display `size` (formatBytes) for the card to render, and a
 * `prune` clause — the session-retention deadline phrase for that patch (prunePhrase over
 * `sessionRetentionDays`), the same clause the CLI's list prints so the card names the
 * deadline from the patch's own row. The window is read live per request, not cached with the
 * stat-cached listing, so a retention edit shows on the card's next refresh.
 * A `q` parameter narrows the listing the way `tumwater salvage --grep <text>` does, through
 * the same `grepSalvagePatches` call the CLI's list makes, so the card searches patch *text*
 * case-insensitively and not only file names; each kept copy carries its own `position` from
 * the unfiltered list, so a filtered row is still addressed by `--show`/`--apply`/`--drop` and
 * by this file's own show/apply/drop handlers (INV-SV1). An absent or empty `q` means no
 * filter — the endpoint never searches the empty pattern. The payload carries `total`, the
 * whole-list count, filtered or not, so the card can say how many rows it hid; `grep` is not
 * echoed. A missing or unreadable salvage dir answers the empty list, and pending patches under
 * `salvage/<role>/` wait for their role's next run, so they are never listed here. */
export function handleSalvageList(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const retentionDays = liveConfig(root).sessionRetentionDays;
  const now = Date.now();
  const full = collectSalvagePatches(root);
  const pattern = q.get("q");
  const kept = pattern ? grepSalvagePatches(root, full, pattern) : full;
  const patches = kept.map((p) => ({
    position: p.position,
    file: p.file,
    savedAt: p.savedAt,
    bytes: p.bytes,
    size: formatBytes(p.bytes),
    prune: prunePhrase(p.savedAt, retentionDays, now),
  }));
  sendJson(res, 200, { patches, total: full.length });
}

/** Handle GET /api/salvage-show?position=<n>: read one kept patch back for the operator to look
 * at, with the same fields `tumwater salvage --show <n> --json` prints plus the card's display
 * size — `position`, `file`, `savedAt`, `bytes`, `size` (formatBytes, exactly what
 * handleSalvageList answers for that row), the `git apply --stat` summary (`stat`, null when the
 * file is not a diff git can parse) and the raw diff `patch`. Read-only: it writes nothing and
 * touches no workspace, so opening a patch never risks a file. The position is the list
 * position, parsed by the dashboard's shared positive-integer query rule (missing or malformed
 * → 400); a position the list does not hold, and a file that vanished between the scan and the
 * read, answer the same `{ ok: false, message }` shape handleSalvageApply/handleSalvageDrop
 * answer for an off-list position, with the domain's own sentence — the CLI's out-of-range
 * wording and its `could not read salvaged patch <file>` wording — so all three handlers state
 * one rule and the card shows that sentence rather than an empty panel. */
export async function handleSalvageShow(
  q: URLSearchParams,
  res: http.ServerResponse,
  root: string,
): Promise<void> {
  const position = intQuery(q, res, "position", "positive");
  if (position === null) return;
  const at = salvagePatchAt(collectSalvagePatches(root), position);
  if ("message" in at) {
    sendJson(res, 200, { ok: false, message: at.message });
    return;
  }
  const patch = at.patch;
  const text = readSalvagePatch(root, patch.file);
  if (text === null) {
    sendJson(res, 200, { ok: false, message: `could not read salvaged patch ${patch.file}` });
    return;
  }
  sendJson(res, 200, {
    position: patch.position,
    file: patch.file,
    savedAt: patch.savedAt,
    bytes: patch.bytes,
    size: formatBytes(patch.bytes),
    stat: await salvagePatchStat(root, patch.file),
    patch: text,
  });
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
  const at = salvagePatchAt(collectSalvagePatches(root), position);
  if ("message" in at) {
    sendJson(res, 200, { ok: false, message: at.message });
    return;
  }
  const patch = at.patch;
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
  const at = salvagePatchAt(collectSalvagePatches(root), position);
  if ("message" in at) {
    sendJson(res, 200, { ok: false, message: at.message });
    return;
  }
  const patch = at.patch;
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
