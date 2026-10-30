/**
 * The dashboard's GET backlog and unmerged-change handlers (src/gui/gui-server.ts routes to
 * them): backlog, backlog-match, and diff. Each answers its request and touches no socket
 * beyond its own `res`; the domain work lives one layer down (backlog/backlog.ts,
 * inbox/inbox.ts, change/change-data.ts), so this module only adapts HTTP onto it. Barrelled
 * into gui/gui-endpoints.ts beside the other per-family GET endpoint modules.
 */
import { refusalNote } from "../backlog/backlog-eligibility.js";
import type { BacklogEntry } from "../backlog/backlog-md.js";
import { answeredQuestionEntries, entryMatches, donePlanEntries, fixedBugEntries, openBugEntries, openQuestionEntries, plannedPlanEntries } from "../backlog/backlog.js";
import { collectChangeOverlaps, scopeChangeOverlaps, scopeChangeOverlapsToPath, collectTeamChanges, collectRoleChange, normalizeDiffPath } from "../change/change-data.js";
import { listWideScope, queuedListRows } from "../inbox/inbox.js";
import { intQuery, rejectBadRole, roleListQuery } from "./gui-args.js";
import { badRequest, sendJson } from "./gui-http-body.js";
import { typoSuffix } from "../text/suggest.js";
import { gotSuffix } from "../text/text.js";
import type http from "node:http";
/** The /api/backlog `file` values and the open-section reader each addresses — one table so
 * the on-demand dispatch and the "valid values" list in both 400s cannot drift apart. A Map,
 * not an object literal, so no `file` spelling (`constructor`, `toString`, `__proto__`) can
 * reach an inherited member through the lookup. Insertion order is the list order. */
const BACKLOG_FILE_READERS = new Map<string, (root: string) => BacklogEntry[]>([
  ["plans", plannedPlanEntries],
  ["bugs", openBugEntries],
  ["questions", openQuestionEntries],
  ["done", donePlanEntries],
  ["fixed", fixedBugEntries],
  ["answered", (root) => answeredQuestionEntries(root).reverse()],
]);
const BACKLOG_FILE_NAMES = [...BACKLOG_FILE_READERS.keys()];
const BACKLOG_FILE_VALUES = BACKLOG_FILE_NAMES.join(", ");

/** Handle GET /api/backlog?file=<plans|bugs|questions|done|fixed|answered>&index=N: one
 * backlog entry's full text ({title, body}), fetched on demand so multi-KB bodies (long repros,
 * whole plans) never ride the 1-second /api/status poll. index addresses the Nth entry of that
 * file's section in the same order statusPayload lists its titles — plans: PLANS.md ## Planned,
 * bugs: BUGS.md ## Open, questions: QUESTIONS.md ## Open, done: PLANS.md ## Done and fixed:
 * BUGS.md ## Fixed (both newest first, the order of the dashboard's recent rows) and answered:
 * QUESTIONS.md ## Answered, newest first (the file is appended to, so the reverse of file
 * order, unlike done/fixed) — zero-based.
 * Unknown/missing file, missing or bad index, and out-of-range index
 * → 400 JSON error via sendJson.
 * The query arrives pre-parsed (gui/gui-server.ts's parseRequestTarget), like every
 * GET-data handler here. */
export function handleBacklog(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const file = q.get("file");
  if (file === null) {
    badRequest(res, `file required (valid values: ${BACKLOG_FILE_VALUES})`);
    return;
  }
  const reader = BACKLOG_FILE_READERS.get(file);
  if (!reader) {
    badRequest(res, `unknown file ${JSON.stringify(file)} (valid values: ${BACKLOG_FILE_VALUES})${typoSuffix(file, BACKLOG_FILE_NAMES)}`);
    return;
  }
  const entries = reader(root);
  const index = intQuery(q, res, "index", "non-negative");
  if (index === null) return;
  const entry = entries[index];
  if (!entry) {
    badRequest(res, `index ${index} out of range (${file} has ${entries.length} entries)`);
    return;
  }
  sendJson(res, 200, {
    title: entry.title,
    body: entry.body,
    refused: refusalNote(entry.body) !== null,
  });
}
/** Handle GET /api/backlog-match?grep=<text>: for each /api/backlog `file`, the ascending
 * indexes (the ones /api/backlog?file=…&index=N addresses) whose entry heading or body contains
 * the trimmed text, case-insensitively — the match `tumwater backlog --grep` and the TUI's `/`
 * use — so the dashboard's Search can find text bodies hold without bodies riding the status
 * poll. A `queued` key adds the queued messages whose full text (not only the 80-character
 * preview) contains the text, as `{ role, file }` with the queue-file basename, director first —
 * the match `tumwater prompt --list --grep` uses. Missing or blank grep → 400. */
export function handleBacklogMatch(q: URLSearchParams, res: http.ServerResponse, root: string): void {
  const needle = (q.get("grep") ?? "").trim();
  if (!needle) {
    badRequest(res, "grep required");
    return;
  }
  const out: Record<string, number[] | Array<{ role: string; file: string }>> = {};
  for (const [file, reader] of BACKLOG_FILE_READERS) {
    out[file] = reader(root).flatMap((entry, i) => (entryMatches(entry, needle) ? [i] : []));
  }
  const lower = needle.toLowerCase();
  out.queued = queuedListRows(root, null, listWideScope(root))
    .filter((row) => row.text.toLowerCase().includes(lower))
    .map((row) => ({ role: row.role, file: row.file }));
  sendJson(res, 200, out);
}
/** Normalise an optional `?path=` query arg to `{ path }` (absent → `{ path: undefined }`),
 * answering the shared 400 when the raw value does not name a repo-relative path. Shared by
 * the `?overlaps` and `?role` arms; `null` means the 400 was sent, so the caller returns. */
function diffPathParam(res: http.ServerResponse, rawPath: string | null): { path: string | undefined } | null {
  if (rawPath === null) return { path: undefined };
  const path = normalizeDiffPath(rawPath);
  if (path === null) {
    badRequest(res, `path takes a repo-relative path such as src/cli.ts (as overlaps lists it)${gotSuffix(rawPath)}`);
    return null;
  }
  return { path };
}
/** The `?overlaps` view: refuse stat, normalise the path, resolve the comma-separated role
 * list, collect the overlaps and scope them by roles then by path, then send. */
async function handleDiffOverlaps(q: URLSearchParams, res: http.ServerResponse, root: string, rawPath: string | null, stat: boolean): Promise<void> {
  if (stat) {
    badRequest(res, "overlaps lists paths, not patches; drop stat");
    return;
  }
  const opath = diffPathParam(res, rawPath);
  if (opath === null) return;
  const roles = roleListQuery(q, res, root);
  if (roles === null) return;
  let view = await collectChangeOverlaps(root);
  if (roles !== undefined) view = scopeChangeOverlaps(view, roles);
  if (opath.path !== undefined) view = scopeChangeOverlapsToPath(view, opath.path);
  sendJson(res, 200, view);
}
/** The role-less team roster: refuse stat and path with their own 400s, then send
 * collectTeamChanges's document. */
async function handleDiffTeam(res: http.ServerResponse, root: string, rawPath: string | null, stat: boolean): Promise<void> {
  if (stat) {
    badRequest(res, "stat needs role (the team roster carries no patch)");
    return;
  }
  if (rawPath !== null) {
    badRequest(res, "path needs role (the team roster carries no patch)");
    return;
  }
  sendJson(res, 200, await collectTeamChanges(root));
}
/** The `?role=<id>` per-role view: validate through rejectBadRole, normalise the shared path,
 * then send collectRoleChange with its path and stat options. */
async function handleDiffRole(res: http.ServerResponse, root: string, role: string, rawPath: string | null, stat: boolean): Promise<void> {
  if (rejectBadRole(root, res, role)) return;
  const path = diffPathParam(res, rawPath);
  if (path === null) return;
  sendJson(res, 200, await collectRoleChange(root, role, { ...(path.path === undefined ? {} : { path: path.path }), ...(stat ? { stat: true } : {}) }));
}
/** Handle GET /api/diff[?role=<id>]: the unmerged-change view the CLI prints from the same
 * collectors — no `role` → collectTeamChanges (exactly `tumwater diff --json`'s document:
 * `{ mainBranch, roles }`, no per-role patch halves); `?role=<id>` → collectRoleChange (the
 * full per-role view with `diff`/`uncommittedDiff`, `tumwater diff --role <id> --json`). The
 * role is a target, not a filter, so it validates through rejectBadRole exactly like
 * /api/transcript and /api/run (unknown/missing → 400 naming the valid ids) — the same ids
 * `parseRoleFlag` accepts on the CLI, including disabled and user-defined roles. The
 * collectors degrade absent worktrees and missing base branches to their `state` instead of
 * throwing, so a fresh or half-built repo still answers 200. Reads git plumbing directly, so
 * it works whether or not the team is running. `?overlaps=1` serves collectChangeOverlaps
 * (exactly `tumwater diff --overlaps --json`'s `{ mainBranch, state, overlaps }`); with `role` (a
 * comma-separated list, each id validated) it keeps the files a listed role holds, exactly
 * `tumwater diff --overlaps --role <ids> --json`; `&path=<path>` keeps the files at or under that
 * path, exactly `tumwater diff --overlaps --path <path> --json`. `?role=<id>&stat=1` serves both
 * halves as the `git diff --stat` summary, exactly `tumwater diff --role <id> --stat --json`. */
export async function handleDiff(q: URLSearchParams, res: http.ServerResponse, root: string): Promise<void> {
  const rawPath = q.get("path");
  const stat = q.get("stat") !== null;
  if (q.get("overlaps") !== null) return handleDiffOverlaps(q, res, root, rawPath, stat);
  const role = q.get("role");
  if (role === null) return handleDiffTeam(res, root, rawPath, stat);
  return handleDiffRole(res, root, role, rawPath, stat);
}
