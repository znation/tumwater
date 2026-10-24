/** The dashboard's Pending view, browser-side: every role's unmerged change as /api/diff
 * serves it (the same document `tumwater diff` prints from the shared change collectors). The
 * roster shows each role's branch, state, commits ahead of main with their subjects, and its
 * uncommitted-file count; a row opens that role's drawer, whose Pending change section fetches
 * the full patch (`/api/diff?role=<id>`). It refetches when the view opens and when its
 * Refresh button is pressed — never on a timer of its own. It also paints the overlapping-files
 * card from `/api/diff?overlaps=1`, with Role and Folder pickers that narrow it client-side,
 * and the Merge queue card from the status payload, with a Role picker that keeps only the
 * chosen role's waiting merges under their whole-queue positions (the tumwater queue --role
 * twin) and a per-row Move to top / two-click Cancel pair on every non-first entry, and the
 * Post-merge reviews card from the status payload, with a Role picker that keeps only
 * the chosen role's entries (`tumwater reviews --role` twin). Spliced
 * into gui-client.ts's script, reaching its helpers (esc, getJson, icon,
 * errorPanel) through that concatenation. */
export const GUI_CLIENT_PENDING_JS = String.raw`  let pendingTeam = null;
  let pendingOverlaps = null;
  let pendingOverlapOpen = null;
  let pendingOverlapRole = "";
  let pendingOverlapDir = "";
  let pendingQueueRole = "";
  let pendingReviewRole = "";
  let pendingReviewState = "";
  let pendingCancelSha = "";
  // The Merge queue card's per-row cancel, armed by a first click and fired by a second within
  // 5 s — the same confirmSlot two-click factory the drawer's note-clear/entry-cancel use, so a
  // stray click cannot remove an entry. Repaints the card (an armed row reads Confirm cancel).
  const queueCancelSlot = confirmSlot(() => renderPendingQueue(lastStatus));
  let pendingAcceptCommit = "";
  // The Post-merge reviews card's per-row accept, armed by a first click and fired by a second
  // within 5 s — the same confirmSlot two-click factory, so a stray click cannot accept an
  // entry unreviewed. Repaints the card (an armed row reads Confirm accept).
  const reviewAcceptSlot = confirmSlot(() => renderPendingReviews(lastStatus));
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
  // opening that role's drawer. Pure — the view paints what this returns.
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
    return "<div class='table-wrap'><table class='table pending'><thead><tr><th class='c-role'>Role</th><th>Branch</th>" +
      "<th>State</th><th>Ahead of " + esc(team.mainBranch) + "</th><th class='c-dirty num'>Uncommitted</th></tr></thead><tbody>" + rows + "</tbody></table></div>";
  }
  // One queued merge's line: the 1-based whole-queue position, role, run, short sha, age, an
  // optional merge label, and summary. Shared by the Merge queue card and the role drawer so
  // the two cannot drift; a malformed entry renders stand-ins rather than undefined/NaN.
  function queueEntryLineHtml(e, position, now, label, cancel, top) {
    const sec = Number.isFinite(e.enqueuedAt) ? Math.max(0, Math.round((now - e.enqueuedAt) / 1000)) : 0;
    const run = Number.isFinite(e.run) ? e.run : "?";
    const note = Number.isFinite(e.revisionRound) ? " · revision " + e.revisionRound + (Number.isFinite(e.priorObjections) && e.priorObjections > 0 ? " · " + plural(e.priorObjections, "prior objection") : "") : "";
    const retry = typeof e.retry === "string" ? " · re-queued after " + e.retry + (Number.isFinite(e.retryCount) && e.retryCount > 1 ? " · ×" + e.retryCount : "") + (Number.isFinite(e.notBefore) && e.notBefore > now ? " · eligible in " + humanSeconds(Math.max(0, Math.round((e.notBefore - now) / 1000))) : "") : "";
    let line = "<div class='mono clamp1' style='padding:3px 0'>" + position + ". " + esc(e.role ? roleLabel(e.role) : "?") +
      " run #" + esc(run) + " · " + esc(shortSha(e.sha)) + " · " + esc(humanSeconds(sec)) +
      " ago" + (label && typeof label === "string" ? " · [" + esc(label) + "]" : "") +
      (e.highFriction === true ? " · high friction" : "") +
      retry +
      note +
      " · " + esc(e.summary || "—") + "</div>";
    // A reorder button (Move to top) on every non-first row of the Merge queue card, before
    // the two-click cancel: the move is reversible and non-destructive, so a single click is
    // enough (unlike Cancel's two-click arm). The drawer (this role's merges) passes no top,
    // so its rows carry no reorder.
    if (top && position > 1 && typeof e.sha === "string") {
      line = "<button type='button' class='btn btn-sm' data-top='" + esc(e.sha) + "'>Move to top</button>" + line;
    }
    // A two-click cancel: armed by the first click, fired by the second within 5 s (the
    // confirmSlot guard), so a stray click cannot remove an entry. A malformed entry carries
    // no sha, so it renders no button.
    if (cancel && typeof cancel.sha === "string") {
      return line + "<button type='button' class='btn btn-sm' data-cancel='" + esc(cancel.sha) + "'>" + (cancel.armed ? "Confirm cancel" : "Cancel") + "</button>";
    }
    return line;
  }
  // The todo/queued merge entries of a status merge queue document, or [] when the document
  // is null/absent or its entries are missing or malformed — so callers never guard the shape.
  function mergeQueueEntries(mergeQueue) {
    return mergeQueue && Array.isArray(mergeQueue.entries) ? mergeQueue.entries : [];
  }
  // The role drawer's Merge queue section: only this role's waiting merges, each under its
  // whole-queue position (labels run parallel to the whole queue). "" when it has none.
  function drawerQueueHtml(mergeQueue, role, now, labels) {
    const entries = mergeQueueEntries(mergeQueue);
    let kept = 0;
    const lines = entries.map((e, i) => {
      if (!e || e.role !== role) return "";
      kept++;
      return queueEntryLineHtml(e, i + 1, now, Array.isArray(labels) ? labels[i] : undefined);
    }).join("");
    if (!kept) return "";
    return "<section><div class='sec-head'><h3>Merge queue</h3><span class='muted' style='font-size:13px'>" +
      esc(kept + " of " + entries.length + " waiting") + "</span></div><div style='padding:4px 0'>" + lines + "</div></section>";
  }
  // The Merge queue card's body: every queued merge in execution order (oldest first), one
  // line each mirroring tumwater queue's renderMergeQueue — 1-based position, role, run,
  // short sha, age, summary — so the page and the CLI cannot drift. Painted from the status
  // payload the page already polls; depth counts the unreadable queue files the status reader
  // skips, so a positive depth with no readable list states the count instead of inventing rows.
  // Pure: the age comes from the passed now, and a malformed entry renders a stand-in rather
  // than undefined/NaN. Null/absent/zero-depth reads as empty. Its Role picker keeps only the
  // chosen role's waiting merges, each under its position in the whole queue (the
  // tumwater queue --role twin); "All roles" (the default) shows every line.
  function pendingQueueHtml(mergeQueue, now, labels, role = "", cancelArmedSha = "") {
    const depth = mergeQueue && Number.isFinite(mergeQueue.depth) ? mergeQueue.depth : 0;
    const entries = mergeQueueEntries(mergeQueue);
    const roles = [...new Set(entries.map((e) => e && e.role).filter((r) => typeof r === "string"))].sort();
    const active = role && roles.includes(role) ? role : "";
    let head = "<div class='card-head'><h2>Merge queue</h2></div>";
    let body;
    if (depth === 0) {
      body = "<div class='empty'>Merge queue empty</div>";
    } else if (entries.length === 0) {
      body = "<div class='empty'>merge queue: " + esc(depth) + " waiting</div>";
    } else {
      if (roles.length) {
        head = "<div class='card-head'><h2>Merge queue</h2><label><span class='sr-only'>Role</span><select class='field' id='pendingqueuerole'><option value=''>All roles</option>" +
          roles.map((id) => "<option value='" + esc(id) + "'" + (id === active ? " selected" : "") + ">" + esc(roleLabel(id)) + "</option>").join("") + "</select></label></div>";
      }
      body = "<div style='padding:10px 16px 12px'>" + entries.map((e, i) => ({ e, i })).filter(({ e }) => !active || (e && e.role === active)).map(({ e, i }) =>
        queueEntryLineHtml(e, i + 1, now, Array.isArray(labels) ? labels[i] : undefined, { sha: e && e.sha, armed: e && e.sha === cancelArmedSha }, true)).join("") + "</div>";
    }
    return head + body;
  }
  // The Overlapping files card: one "path: role, role" line per file two or more pending changes
  // touch (tumwater diff --overlaps). Pure; a malformed document reads as no overlaps. Its Role
  // picker keeps only the lines the chosen role holds (diff --overlaps --role), each line still
  // naming every holder and keeping its index in the unfiltered list. Its Folder picker keeps only
  // the lines at or under the chosen directory (diff --overlaps --path).
  // The expanded detail under one overlap line: each holding role's path-scoped change, or its
  // loading / error row. Pure.
  function overlapDetailHtml(rows) {
    return (Array.isArray(rows) ? rows : []).map((r) => {
      let body;
      if (r.state === "loading") body = "<p class='muted'>Loading…</p>";
      else if (r.state === "error") body = "<p class='muted'>" + esc(r.message || "Pending change unavailable") + "</p>";
      else body = drawerChangeHtml(r.view);
      return "<h3 class='mono'>" + esc(roleLabel(r.role)) + "</h3>" + body;
    }).join("");
  }
  // The sorted, de-duplicated role ids any overlap names; empty for a malformed document.
  function pendingOverlapHolders(view) {
    if (!view || typeof view !== "object" || !Array.isArray(view.overlaps)) return [];
    const ids = new Set();
    for (const o of view.overlaps) {
      if (o && Array.isArray(o.roles)) for (const id of o.roles) if (typeof id === "string") ids.add(id);
    }
    return [...ids].sort();
  }
  // The sorted, de-duplicated directories holding any overlap path; empty for a malformed
  // document. A trailing-slash path (an untracked directory) also adds itself.
  function pendingOverlapDirs(view) {
    if (!view || typeof view !== "object" || !Array.isArray(view.overlaps)) return [];
    const dirs = new Set();
    for (const o of view.overlaps) {
      if (!o || typeof o.path !== "string") continue;
      const dir = o.path.endsWith("/");
      const parts = (dir ? o.path.slice(0, -1) : o.path).split("/");
      const n = dir ? parts.length : parts.length - 1;
      for (let k = 1; k <= n; k++) dirs.add(parts.slice(0, k).join("/"));
    }
    return [...dirs].sort();
  }
  function pendingOverlapsHtml(view, open, role, dir) {
    const ok = view && typeof view === "object";
    let body;
    let head = "<div class='card-head'><h2>Overlapping files</h2></div>";
    if (ok && view.state === "no-base") {
      body = "<div class='empty'>Main branch " + esc(view.mainBranch) + " does not exist</div>";
    } else if (!ok || !Array.isArray(view.overlaps) || view.overlaps.length === 0) {
      body = "<div class='empty'>No file is touched by two pending changes</div>";
    } else {
      const holders = pendingOverlapHolders(view);
      const active = role && holders.includes(role) ? role : "";
      const dirs = pendingOverlapDirs(view);
      const activeDir = dir && dirs.includes(dir) ? dir : "";
      head = "<div class='card-head'><h2>Overlapping files</h2><label><span class='sr-only'>Role</span><select class='field' id='pendingoverlaprole'><option value=''>All roles</option>" +
        holders.map((id) => "<option value='" + esc(id) + "'" + (id === active ? " selected" : "") + ">" + esc(roleLabel(id)) + "</option>").join("") + "</select></label>" +
        (dirs.length ? "<label><span class='sr-only'>Folder</span><select class='field' id='pendingoverlapdir'><option value=''>All folders</option>" +
          dirs.map((d) => "<option value='" + esc(d) + "'" + (d === activeDir ? " selected" : "") + ">" + esc(d + "/") + "</option>").join("") + "</select></label>" : "") + "</div>";
      const lines = view.overlaps.map((o, i) => {
        const roles = o && Array.isArray(o.roles) ? o.roles : [];
        if (active && !roles.includes(active)) return "";
        const path = o && typeof o.path === "string" ? o.path : "?";
        if (activeDir && !path.startsWith(activeDir + "/")) return "";
        const line = "<button type='button' class='li-open mono clamp1' data-overlap='" + i + "'>" + esc(path) + ": " + esc(roles.map(roleLabel).join(", ")) + "</button>";
        return open && open.path === path ? line + "<div class='overlap-detail'>" + overlapDetailHtml(open.rows) + "</div>" : line;
      }).join("");
      body = lines ? "<div style='padding:10px 16px 12px'>" + lines + "</div>" : "<div class='empty'>No overlapping file matches the filters</div>";
    }
    return head + body;
  }
  // The Post-merge reviews card: every well-formed entry in .tumwater/state/post-review.json
  // in FIFO order, one line each mirroring 'tumwater reviews' renderPostReviews — role, short
  // commit, summary, and the status suffix from the browser twin of postReviewStatusLabel — so
  // the page and the CLI cannot drift on order or wording. Painted from the status payload the
  // page already polls. Empty (or a missing/malformed list) shows the empty line. A malformed
  // entry renders a stand-in rather than undefined/NaN.
  // The status suffix — the browser twin of postReviewStatusLabel
  // (src/review/post-merge-review-render.ts):
  // the reviewer's recorded rejected reasons when 'rejected' is set, else the
  // verdict-less failed-review-run count when positive, else "". Hand-kept copy because the
  // script cannot import the server renderer; pinned by the client test against the CLI wording.
  const squashText = (s, max) => {
    const t = String(s).replace(/\s+/g, " ").trim();
    if (t.length <= max) return t;
    return t.slice(0, max - 1).trimEnd() + "…";
  };
  // The states the Post-merge reviews card's State picker lists, in the order 'tumwater reviews
  // --status' names them — the browser twin of POST_REVIEW_STATES
  // (src/review/post-merge-review-render.ts), so the page and the CLI cannot drift on what a
  // state means. Hand-kept because the inline script cannot import the server renderer.
  const POST_REVIEW_STATE_ORDER = ["waiting", "failing", "rejected", "fixed"];
  // One post-merge review entry's state — the browser twin of the server's 'postReviewState'
  // (src/review/post-merge-review-render.ts), literal in its 'rejected' branch: 'fixed' when
  // the repair already merged (the terminal Forward-never-back 1a/6 record — naming both shas,
  // it is not pending anything), 'rejected' when 'rejected' is set (an empty array still
  // counts; statusPayload's entries come from readPostReviews, which only ever stores an array
  // or leaves it off), else 'failing' when the review runs keep ending without a verdict
  // ('failures' positive), else 'waiting'. The precedence matches postReviewStatusLabel and
  // 'tumwater reviews --status'; pinned against the server predicate by test so the browser and
  // the server cannot disagree on what fixed/rejected/failing/waiting mean.
  function postReviewState(e) {
    if (e && e.fixed !== undefined) return "fixed";
    if (e && e.rejected !== undefined) return "rejected";
    if (e && typeof e.failures === "number" && e.failures > 0) return "failing";
    return "waiting";
  }
  function postReviewStatusLabel(e) {
    switch (postReviewState(e)) {
      case "fixed":
        return "[fixed — the repair " + shortSha(e.fixed) + " already merged on main]";
      case "rejected":
        return "[rejected — " + e.rejected.map((r) => squashText(r, 60)).join("; ") + "]";
      case "failing":
        if (e && typeof e.lastFailure === "string" && e.lastFailure.length > 0) {
          return "[" + plural(e.failures, "failed review run") + " — last: " + squashText(e.lastFailure, 80) + "]";
        }
        return "[" + plural(e.failures, "failed review run") + "]";
      default:
        return "";
    }
  }
  function postReviewsHtml(entries, armed = "", role = "", state = "", now = 0) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return "<div class='card-head'><h2>Post-merge reviews</h2></div><div class='empty'>No merged commit is waiting for a post-merge review</div>";
    }
    const roles = [...new Set(entries.map((e) => e && e.role).filter((r) => typeof r === "string"))].sort();
    const active = role && roles.includes(role) ? role : "";
    const present = new Set(entries.map(postReviewState));
    const states = POST_REVIEW_STATE_ORDER.filter((s) => present.has(s));
    const activeState = state && states.includes(state) ? state : "";
    let head = "<div class='card-head'><h2>Post-merge reviews</h2></div>";
    if (roles.length) {
      head = "<div class='card-head'><h2>Post-merge reviews</h2><label><span class='sr-only'>Role</span><select class='field' id='pendingreviewrole'><option value=''>All roles</option>" +
        roles.map((id) => "<option value='" + esc(id) + "'" + (id === active ? " selected" : "") + ">" + esc(roleLabel(id)) + "</option>").join("") + "</select></label>" +
        (states.length ? "<label><span class='sr-only'>State</span><select class='field' id='pendingreviewstate'><option value=''>All states</option>" +
          states.map((s) => "<option value='" + s + "'" + (s === activeState ? " selected" : "") + ">" + s + "</option>").join("") + "</select></label>" : "") + "</div>";
    }
    const kept = entries.filter((e) => (!active || (e && e.role === active)) && (!activeState || postReviewState(e) === activeState));
    const lines = kept.map((e) => {
      const label = postReviewStatusLabel(e);
      const age = typeof e.enqueuedAt === "number" && Number.isFinite(now)
        ? " · " + esc(humanSeconds(Math.max(0, Math.round((now - e.enqueuedAt) / 1000)))) + " ago"
        : "";
      let line = "<div class='queue-entry mono clamp1'>" + esc(e.role ? roleLabel(e.role) : "?") + " " + esc(shortSha(e.commit)) +
        age +
        " · " + esc(e.summary || "—") +
        (label ? " · <span class='mono'>" + esc(label) + "</span>" : "") + "</div>";
      // A two-click Accept on every well-formed entry not already settled fixed (the server
      // refuses a fixed entry, so it renders no button): armed by the first
      // click, fired by the second within 5 s (the confirmSlot guard), so a stray click cannot
      // accept an entry unreviewed. Threaded the way pendingQueueHtml threads cancelArmedSha.
      if (e && e.fixed === undefined && typeof e.commit === "string") {
        line += "<button type='button' class='btn btn-sm' data-accept='" + esc(e.commit) + "'>" + (armed === e.commit ? "Confirm accept" : "Accept") + "</button>";
      }
      return line;
    }).join("");
    if (kept.length === 0) {
      return head + "<div class='queue-head'>post-merge reviews (0 of " + entries.length + "):</div><div class='empty'>No post-merge review matches the filters</div>";
    }
    return head +
      "<div class='queue-head'>post-merge reviews (" + esc(active || activeState ? kept.length + " of " + entries.length : entries.length) + "):</div>" + lines;
  }
  // Paint the Post-merge reviews card from the polled status payload — the dashboard twin of
  // 'tumwater reviews', driven by the raw postReviews list statusPayload already carries.
  function renderPendingReviews(status) {
    const card = $("pendingreviews");
    if (!card) return;
    const entries = status && Array.isArray(status.postReviews) ? status.postReviews : [];
    const roles = new Set(entries.map((e) => e && e.role).filter((r) => typeof r === "string"));
    if (!roles.has(pendingReviewRole)) pendingReviewRole = "";
    const states = new Set(entries.map(postReviewState));
    if (!states.has(pendingReviewState)) pendingReviewState = "";
    card.innerHTML = postReviewsHtml(entries, reviewAcceptSlot.armed(pendingAcceptCommit) ? pendingAcceptCommit : "", pendingReviewRole, pendingReviewState, Date.now());
  }
  // pending-table:end
  // Paint the Merge queue card from the polled status payload, at paint-time age; no fetch of
  // its own (the entries ride /api/status, unlike the roster's /api/diff).
  function renderPendingQueue(status) {
    const card = $("pendingqueue");
    if (!card) return;
    const entries = mergeQueueEntries(status && status.mergeQueue);
    const roles = new Set(entries.map((e) => e && e.role).filter((r) => typeof r === "string"));
    if (!roles.has(pendingQueueRole)) pendingQueueRole = "";
    card.innerHTML = pendingQueueHtml(status && status.mergeQueue, Date.now(), status && status.mergeQueueLabels, pendingQueueRole, queueCancelSlot.armed(pendingCancelSha) ? pendingCancelSha : "");
  }
  function paintPendingOverlaps() {
    const card = $("pendingoverlaps");
    if (card) card.innerHTML = pendingOverlapsHtml(pendingOverlaps, pendingOverlapOpen, pendingOverlapRole, pendingOverlapDir);
  }
  // Toggle one overlap line's detail: fetch each holding role's change scoped to the path. A
  // reply is dropped once another line (or a Refresh) replaced the open detail.
  async function togglePendingOverlap(index) {
    const o = pendingOverlaps && Array.isArray(pendingOverlaps.overlaps) ? pendingOverlaps.overlaps[index] : null;
    if (!o || typeof o.path !== "string") return;
    const path = o.path;
    if (pendingOverlapOpen && pendingOverlapOpen.path === path) {
      pendingOverlapOpen = null;
      paintPendingOverlaps();
      return;
    }
    const roles = Array.isArray(o.roles) ? o.roles : [];
    const open = { path, rows: roles.map((role) => ({ role, state: "loading" })) };
    pendingOverlapOpen = open;
    paintPendingOverlaps();
    await Promise.all(roles.map(async (role, k) => {
      let row;
      try {
        const view = await getJson("/api/diff?role=" + encodeURIComponent(role) + "&path=" + encodeURIComponent(path));
        row = { role, state: "ok", view };
      } catch (err) {
        row = { role, state: "error", message: errMessage(err, "Pending change unavailable") };
      }
      if (pendingOverlapOpen !== open) return;
      open.rows[k] = row;
      paintPendingOverlaps();
    }));
  }
  function buildPendingView() {
    if (!buildOnce("pending", "<div class='view-head'><div><h1>Pending</h1><p>Every role's unmerged change — its branch, commits ahead of main, and uncommitted files. Open a row for the full diff.</p></div>" +
      "<div class='toolbar'><button type='button' class='btn btn-sm' id='pendingrefresh'>" + icon("refresh") + "Refresh</button></div></div>" +
      "<div class='card' id='pendingqueue'><div class='empty'>Loading…</div></div>" +
      "<div class='card' id='pendingreviews'><div class='empty'>Loading…</div></div>" +
      "<div class='card' id='pendingoverlaps'><div class='empty'>Loading…</div></div>" +
      "<div class='card' id='pendingbody'><div class='empty'>Loading…</div></div>")) return;
    $("pendingrefresh").addEventListener("click", () => fetchPending());
    // A Merge queue row's Cancel: the first click on an unarmed sha arms it (repainting the
    // button as Confirm cancel), a second on the armed sha within 5 s posts /api/queue-cancel
    // then clears the arm and refetches so the removed row disappears at once.
    $("pendingqueue").addEventListener("click", async (e) => {
      // A Merge queue row's Move to top: a single click posts /api/queue-top by sha, moving
      // that entry to the head of the queue and refetching (the move is reversible and
      // non-destructive, so it needs no two-step arm).
      const t = e.target.closest("[data-top]");
      if (t) {
        const sha = t.getAttribute("data-top");
        if (sha) {
          await postAction("/api/queue-top", { sha }, (d) => d && d.status === "topped" ? "moved the merge of " + shortSha(d.commit) + " to the front" : d && d.status === "already-first" ? "that merge is already at the front" : "that merge already left the queue");
          fetchPending();
        }
        return;
      }
      const b = e.target.closest("[data-cancel]");
      if (!b) return;
      const sha = b.getAttribute("data-cancel");
      if (!sha) return;
      if (queueCancelSlot.armed(sha)) {
        await postAction("/api/queue-cancel", { sha }, (d) => d && d.status === "cancelled" ? "cancelled the merge of " + shortSha(d.commit) : "that merge already left the queue");
        pendingCancelSha = "";
        queueCancelSlot.disarm();
        fetchPending();
      } else {
        pendingCancelSha = sha;
        queueCancelSlot.arm(sha);
      }
    });
    // A Post-merge reviews row's Accept: the first click on an unarmed commit arms it
    // (repainting that button as Confirm accept), a second on the armed commit within 5 s posts
    // /api/post-review-accept then clears the arm and refetches so the removed row disappears.
    $("pendingreviews").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-accept]");
      if (!b) return;
      const commit = b.getAttribute("data-accept");
      if (!commit) return;
      if (reviewAcceptSlot.armed(commit)) {
        await postAction("/api/post-review-accept", { sha: commit }, (d) => d && d.status === "accepted" ? "accepted the post-merge review of " + shortSha(d.commit) + " unreviewed — " + d.summary : "that review already left the queue");
        pendingAcceptCommit = "";
        reviewAcceptSlot.disarm();
        fetchPending();
      } else {
        pendingAcceptCommit = commit;
        reviewAcceptSlot.arm(commit);
      }
    });
    $("pendingqueue").addEventListener("change", (e) => {
      if (e.target.id === "pendingqueuerole") {
        pendingQueueRole = e.target.value;
        renderPendingQueue(lastStatus);
      }
    });
    $("pendingreviews").addEventListener("change", (e) => {
      if (e.target.id === "pendingreviewrole") {
        pendingReviewRole = e.target.value;
        renderPendingReviews(lastStatus);
      } else if (e.target.id === "pendingreviewstate") {
        pendingReviewState = e.target.value;
        renderPendingReviews(lastStatus);
      }
    });
    $("pendingoverlaps").addEventListener("click", (e) => {
      const b = e.target.closest("[data-overlap]");
      if (b) togglePendingOverlap(Number(b.dataset.overlap));
    });
    $("pendingoverlaps").addEventListener("change", (e) => {
      if (e.target.id === "pendingoverlapdir") pendingOverlapDir = e.target.value;
      else if (e.target.id === "pendingoverlaprole") pendingOverlapRole = e.target.value;
      else return;
      pendingOverlapOpen = null;
      paintPendingOverlaps();
    });
  }
  // Load the team-wide change roster. Called when the view opens and by the Refresh button;
  // no timer of its own, and the roster only changes when a role merges or edits its worktree.
  // Load the overlapping-files card on its own, so neither read can blank the other's card.
  async function fetchPendingOverlaps() {
    pendingOverlapOpen = null;
    try {
      pendingOverlaps = await getJson("/api/diff?overlaps=1");
    } catch (err) {
      const card = $("pendingoverlaps");
      if (card) card.innerHTML = errorPanel("Overlaps unavailable", err);
      return;
    }
    if (!pendingOverlapHolders(pendingOverlaps).includes(pendingOverlapRole)) pendingOverlapRole = "";
    if (!pendingOverlapDirs(pendingOverlaps).includes(pendingOverlapDir)) pendingOverlapDir = "";
    paintPendingOverlaps();
  }
  async function fetchPending() {
    buildPendingView();
    fetchPendingOverlaps();
    try {
      pendingTeam = await getJson("/api/diff");
    } catch (err) {
      const body = $("pendingbody");
      if (body) body.innerHTML = errorPanel("Pending unavailable", err);
      return;
    }
    renderPending();
    renderPendingQueue(lastStatus);
    renderPendingReviews(lastStatus);
  }
  function renderPending() {
    const body = $("pendingbody");
    if (!body) return;
    body.innerHTML = pendingTableHtml(pendingTeam);
  }
`;
