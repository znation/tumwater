// vocabulary: plain
/** The dashboard's Pending view, browser-side: every loop's unmerged change as /api/diff
 * serves it (the same document `tumwater diff` prints from the shared change collectors). The
 * roster shows each role's branch, state, commits ahead of main with their subjects, and its
 * uncommitted-file count; a row opens that loop's drawer, whose Pending change section fetches
 * the full patch (`/api/diff?role=<id>`). It refetches when the view opens and when its
 * Refresh button is pressed — never on a timer of its own. Spliced into gui-client.ts's
 * script, reaching its helpers (esc, getJson, icon, errorPanel) through that concatenation. */
export const GUI_CLIENT_PENDING_JS = String.raw`  let pendingTeam = null;
  // pending-table:start
  // One role's state cell: the collector's three states, with "ready" split into pending vs
  // idle work. Never colors a degraded state as an active one.
  function pendingStateHtml(r) {
    if (r.state === "absent") return "<span class='muted'>no worktree</span>";
    if (r.state === "no-base") return "<span class='muted'>no base</span>";
    if (r.state !== "ready") return "<span class='muted'>unknown</span>";
    if (r.ahead === 0 && (!r.dirtyFiles || r.dirtyFiles.length === 0)) return "<span class='muted'>no unmerged work</span>";
    return "<span class='res t-indigo'>pending</span>";
  }
  // One role's ahead cell: the commit count plus each unmerged commit's sha and subject, or a
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
  function pendingTableHtml(team) {
    if (!team || !Array.isArray(team.roles) || team.roles.length === 0)
      return "<div class='empty'><strong>No roles yet</strong>Roles appear here once the team is configured.</div>";
    if (team.roles.every((r) => r.state === "no-base"))
      return "<div class='empty'><strong>Main branch " + esc(team.mainBranch) + " does not exist</strong>There is no base to compare unmerged work against.</div>";
    const rows = team.roles.map((r) =>
      "<tr class='clickable' data-open='" + esc(r.role) + "'>" +
      "<td class='mono'>" + esc(roleLabel(r.role)) + "</td>" +
      "<td class='mono muted'>" + esc(r.branch) + "</td>" +
      "<td>" + pendingStateHtml(r) + "</td>" +
      "<td>" + pendingAheadHtml(r) + "</td>" +
      "<td class='num'>" + pendingDirtyHtml(r) + "</td></tr>",
    ).join("");
    return "<div class='table-wrap'><table class='table pending'><thead><tr><th class='c-loop'>Role</th><th>Branch</th>" + // vocabulary-ok: CSS class the stylesheet matches
      "<th>State</th><th>Ahead of " + esc(team.mainBranch) + "</th><th class='c-dirty num'>Uncommitted</th></tr></thead><tbody>" + rows + "</tbody></table></div>";
  }
  // The Merge queue card's body: every queued merge in execution order (oldest first), one
  // line each mirroring tumwater queue's renderMergeQueue — 1-based position, loop, tick,
  // short sha, age, summary — so the page and the CLI cannot drift. Painted from the status
  // payload the page already polls; depth counts the unreadable queue files the status reader
  // skips, so a positive depth with no readable list states the count instead of inventing rows.
  // Pure: the age comes from the passed now, and a malformed entry renders a stand-in rather
  // than undefined/NaN. Null/absent/zero-depth reads as empty.
  function pendingQueueHtml(mergeQueue, now, labels) {
    const depth = mergeQueue && Number.isFinite(mergeQueue.depth) ? mergeQueue.depth : 0;
    const entries = mergeQueue && Array.isArray(mergeQueue.entries) ? mergeQueue.entries : [];
    let body;
    if (depth === 0) {
      body = "<div class='empty'>Merge queue empty</div>";
    } else if (entries.length === 0) {
      body = "<div class='empty'>merge queue: " + esc(depth) + " waiting</div>";
    } else {
      body = "<div style='padding:10px 16px 12px'>" + entries.map((e, i) => {
        const sec = Number.isFinite(e.enqueuedAt) ? Math.max(0, Math.round((now - e.enqueuedAt) / 1000)) : 0;
        const run = Number.isFinite(e.run) ? e.run : "?";
        return "<div class='mono clamp1' style='padding:3px 0'>" + (i + 1) + ". " + esc(e.role ? roleLabel(e.role) : "?") +
          " run #" + esc(run) + " · " + esc(shortSha(e.sha)) + " · " + esc(humanSeconds(sec)) +
          " ago" + (Array.isArray(labels) && labels[i] && typeof labels[i] === "string" ? " · [" + esc(labels[i]) + "]" : "") +
          " · " + esc(e.summary || "—") + "</div>";
      }).join("") + "</div>";
    }
    return "<div class='card-head'><h2>Merge queue</h2></div>" + body;
  }
  // pending-table:end
  // Paint the Merge queue card from the polled status payload, at paint-time age; no fetch of
  // its own (the entries ride /api/status, unlike the roster's /api/diff).
  function renderPendingQueue(status) {
    const card = $("pendingqueue");
    if (!card) return;
    card.innerHTML = pendingQueueHtml(status && status.mergeQueue, Date.now(), status && status.mergeQueueLabels);
  }
  function buildPendingView() {
    if (!buildOnce("pending", "<div class='view-head'><div><h1>Pending</h1><p>Every role's unmerged change — its branch, commits ahead of main, and uncommitted files. Open a row for the full diff.</p></div>" +
      "<div class='toolbar'><button type='button' class='btn btn-sm' id='pendingrefresh'>" + icon("refresh") + "Refresh</button></div></div>" +
      "<div class='card' id='pendingqueue'><div class='empty'>Loading…</div></div>" +
      "<div class='card' id='pendingbody'><div class='empty'>Loading…</div></div>")) return;
    $("pendingrefresh").addEventListener("click", () => fetchPending());
  }
  // Load the team-wide change roster. Called when the view opens and by the Refresh button;
  // no timer of its own, and the roster only changes when a loop merges or edits its worktree.
  async function fetchPending() {
    buildPendingView();
    try {
      pendingTeam = await getJson("/api/diff");
    } catch (err) {
      const body = $("pendingbody");
      if (body) body.innerHTML = errorPanel("Pending unavailable", err);
      return;
    }
    renderPending();
    renderPendingQueue(lastStatus);
  }
  function renderPending() {
    const body = $("pendingbody");
    if (!body) return;
    body.innerHTML = pendingTableHtml(pendingTeam);
  }
`;
