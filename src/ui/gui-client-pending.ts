/** The dashboard's Pending view, browser-side: every loop's unlanded change as /api/diff
 * serves it (the same document `tumwater diff` prints from the shared change collectors). The
 * roster shows each role's branch, state, commits ahead of main with their subjects, and its
 * uncommitted-file count; a row opens that loop's drawer, whose Pending change section fetches
 * the full patch (`/api/diff?role=<id>`). It refetches when the view opens and when its
 * Refresh button is pressed — never on a timer of its own. Spliced into gui-client.ts's
 * script, reaching its helpers (esc, getJson, icon, errorPanel) through that concatenation. */
export const GUI_CLIENT_PENDING_JS = String.raw`  let pendingFleet = null;
  // pending-table:start
  // One role's state cell: the collector's three states, with "ready" split into pending vs
  // idle work. Never colors a degraded state as an active one.
  function pendingStateHtml(r) {
    if (r.state === "absent") return "<span class='muted'>no worktree</span>";
    if (r.state === "no-base") return "<span class='muted'>no base</span>";
    if (r.state !== "ready") return "<span class='muted'>unknown</span>";
    if (r.ahead === 0 && (!r.dirtyFiles || r.dirtyFiles.length === 0)) return "<span class='muted'>no unlanded work</span>";
    return "<span class='res t-indigo'>pending</span>";
  }
  // One role's ahead cell: the commit count plus each unlanded commit's sha and subject, or a
  // dash for a degraded/empty role.
  function pendingAheadHtml(r) {
    if (r.state !== "ready" || !r.ahead) return "<span class='muted'>—</span>";
    return "<span class='num'>" + esc(plural(r.ahead, "commit")) + "</span>" + commitRowsHtml(r.commits);
  }
  // One role's uncommitted cell: the dirty-file count, with the file list in its title.
  function pendingDirtyHtml(r) {
    const files = r.state === "ready" && Array.isArray(r.dirtyFiles) ? r.dirtyFiles : [];
    if (files.length === 0) return "<span class='muted'>—</span>";
    return "<span class='num' title='" + esc(files.join(", ")) + "'>" + esc(plural(files.length, "file")) + "</span>";
  }
  // The Pending roster: one clickable row per known role (the collector's config order), each
  // opening that loop's drawer. Pure — the view paints what this returns.
  function pendingTableHtml(fleet) {
    if (!fleet || !Array.isArray(fleet.roles) || fleet.roles.length === 0)
      return "<div class='empty'><strong>No loops yet</strong>Loops appear here once the fleet is configured.</div>";
    if (fleet.roles.every((r) => r.state === "no-base"))
      return "<div class='empty'><strong>Main branch " + esc(fleet.mainBranch) + " does not exist</strong>There is no base to compare unlanded work against.</div>";
    const rows = fleet.roles.map((r) =>
      "<tr class='clickable' data-open='" + esc(r.role) + "'>" +
      "<td class='mono'>" + esc(r.role) + "</td>" +
      "<td class='mono muted'>" + esc(r.branch) + "</td>" +
      "<td>" + pendingStateHtml(r) + "</td>" +
      "<td>" + pendingAheadHtml(r) + "</td>" +
      "<td class='num'>" + pendingDirtyHtml(r) + "</td></tr>",
    ).join("");
    return "<div class='table-wrap'><table class='table pending'><thead><tr><th class='c-loop'>Loop</th><th>Branch</th>" +
      "<th>State</th><th>Ahead of " + esc(fleet.mainBranch) + "</th><th class='c-dirty num'>Uncommitted</th></tr></thead><tbody>" + rows + "</tbody></table></div>";
  }
  // pending-table:end
  function buildPendingView() {
    const panel = $("pending");
    if (!panel || panel.dataset.built) return;
    panel.dataset.built = "1";
    panel.innerHTML = "<div class='view-head'><div><h1>Pending</h1><p>Every loop's unlanded change — its branch, commits ahead of main, and uncommitted files. Open a row for the full diff.</p></div>" +
      "<div class='toolbar'><button type='button' class='btn btn-sm' id='pendingrefresh'>" + icon("refresh") + "Refresh</button></div></div>" +
      "<div class='card' id='pendingbody'><div class='empty'>Loading…</div></div>";
    $("pendingrefresh").addEventListener("click", () => fetchPending());
  }
  // Load the fleet-wide change roster. Called when the view opens and by the Refresh button;
  // no timer of its own, and the roster only changes when a loop lands or edits its worktree.
  async function fetchPending() {
    buildPendingView();
    try {
      pendingFleet = await getJson("/api/diff");
    } catch (e) {
      const body = $("pendingbody");
      if (body) body.innerHTML = errorPanel("Pending unavailable", e);
      return;
    }
    renderPending();
  }
  function renderPending() {
    const body = $("pendingbody");
    if (!body) return;
    body.innerHTML = pendingTableHtml(pendingFleet);
  }
`;
