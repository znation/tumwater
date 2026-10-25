/**
 * The dashboard's POST flake-quarantine command handler (barrelled into
 * gui/gui-endpoint-commands.ts, which routes to it from src/gui/gui-server.ts):
 * quarantine-release — the twin of `tumwater quarantine --release <n>`. The dashboard Failures
 * view's per-entry "Release" button and the CLI predicate run the same releaseQuarantinedTest
 * core, so the operator who decides a quarantined test's filed bug is fixed can retire it from
 * the card without opening a terminal. The handler adapts HTTP onto that domain work and
 * touches no socket beyond its own `res`.
 */
import { releaseQuarantinedTest } from "../review/known-flakes.js";
import { readPostBody } from "./gui-endpoint-common.js";
import { badRequest, sendJson } from "./http-body.js";
import type http from "node:http";

/** Handle POST /api/quarantine-release: release one quarantined test (the body's `test`), so
 * the review gate no longer excuses its failures. A missing/empty `test` 400s (nothing
 * written); a name not currently quarantined answers ok:false (nothing written); a hit removes
 * it from .tumwater/state/quarantine.json and answers ok:true naming the test. */
export async function handleQuarantineRelease(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  root: string,
): Promise<void> {
  const body = await readPostBody(req, res, "{}");
  if (!body) return;
  const test = typeof body.test === "string" ? body.test : "";
  if (test === "") {
    badRequest(res, "a quarantined test name is required");
    return;
  }
  const ok = releaseQuarantinedTest(root, test);
  sendJson(
    res,
    200,
    ok
      ? { ok: true, message: `released quarantined test: ${test} — the gate no longer excuses it` }
      : { ok: false, message: `not in the flake quarantine: ${test}` },
  );
}
