/** The dashboard's backlog card, browser-side: the questions/plans/bugs/queued tabs with
 * their text Search box, the Queued tab's in-place prompt editor, and the New plan / File a
 * bug forms. renderBacklog repaints it from each /api/status poll (renderTeam in
 * gui-client-team.ts calls it). Split out of gui-client-team.ts; spliced into gui-client.ts's
 * script right after it, reaching its helpers ($, esc, recall, store, getJson, postJson,
 * paintPanel, showFlash, clickClosest) and lastStatus through that concatenation. */
export const GUI_CLIENT_BACKLOG_JS = String.raw`
  // ---- backlog: questions, plans, bugs, and queued prompts ----
  let backlogTab = recall("backlog") || "";
  let backlogGrep = recall("backlog-grep") || "";
  let backlogBodyHits = null;
  // backlog:start
  // The Queued tab's in-place editor state, beside the tab choice its rows paint from:
  // backlogStatus is the last payload renderBacklog saw, queuedEdit is the open editor
  // ({ role, file, text } or null), and queuedEditPainted marks that its textarea is on
  // screen so the standing 1s poll cannot repaint over what the operator is typing.
  let backlogStatus = null;
  let backlogMatchAt = 0;
  let queuedEdit = null;
  let queuedEditPainted = false;
  // The Plans/Bugs tabs' New form: { kind: "plan" | "bug" } or null, with the same painted
  // guard so a poll does not repaint over the typed title.
  let backlogNew = null;
  let backlogNewPainted = false;
  // Names of the blocked series whose parts the Plans tab currently shows.
  let openSeries = new Set();
  function setBacklogTab(tab) {
    backlogTab = tab;
    store("backlog", tab);
    queuedEdit = null;
    queuedEditPainted = false;
    backlogNew = null;
    backlogNewPainted = false;
    if (lastStatus) renderBacklog(lastStatus);
  }
  // The Search box's text: trimmed, remembered, and the last payload repainted through it.
  function setBacklogGrep(text) {
    backlogGrep = text.trim();
    store("backlog-grep", backlogGrep);
    if (backlogStatus) renderBacklog(backlogStatus);
    fetchBacklogMatch();
  }
  // The server's body matches for the current Search text: { needle, plans: [index…], … } from
  // /api/backlog-match. A stale answer (the box changed meanwhile) is dropped, and a failed
  // fetch leaves the shown-text matching in place.
  async function fetchBacklogMatch() {
    if (!backlogGrep) { backlogBodyHits = null; return; }
    const needle = backlogGrep;
    backlogMatchAt = Date.now();
    try {
      const d = await getJson("/api/backlog-match?grep=" + encodeURIComponent(needle));
      if (backlogGrep !== needle) return;
      backlogBodyHits = { needle, ...d };
      if (backlogStatus) renderBacklog(backlogStatus);
    } catch (e) { /* keep shown-text matching */ }
  }
  function beginBacklogNew(kind) {
    backlogNew = { kind };
    backlogNewPainted = false;
    renderBacklog(backlogStatus);
  }
  function toggleBacklogSeries(name) {
    if (openSeries.has(name)) openSeries.delete(name); else openSeries.add(name);
    renderBacklog(backlogStatus);
  }
  function endBacklogNew() {
    backlogNew = null;
    backlogNewPainted = false;
    renderBacklog(backlogStatus);
  }
  function beginQueuedEdit(role, file, text) {
    backlogTab = "queued";
    queuedEdit = { role, file, text };
    queuedEditPainted = false;
    renderBacklog(backlogStatus);
  }
  function endQueuedEdit() {
    queuedEdit = null;
    queuedEditPainted = false;
    renderBacklog(backlogStatus);
  }
  const BACKLOG = [
    ["questions", "Questions", "question", "indigo", "No open questions", "Roles post here when they need a decision from you."],
    ["plans", "Plans", "plan", "blue", "Nothing planned", "The plan role files features in PLANS.md."],
    ["bugs", "Bugs", "bug", "red", "No open bugs", "Bugs filed in BUGS.md show up here."],
    ["queued", "Inbox", "chat", "gray", "Inbox empty", "Messages you send wait here until their role's next run."], // vocabulary-ok: internal tab key
  ];
  function renderBacklog(d) {
    backlogStatus = d;
    if (backlogGrep && Date.now() - backlogMatchAt > 5000) fetchBacklogMatch();
    if (queuedEdit && queuedEditPainted) return; // an open editor owns the panel until Save or Cancel
    if (backlogNew && backlogNewPainted) return; // likewise the New form
    const items = { questions: d.questions || [], plans: d.plans || [], bugs: d.bugs || [], queued: queuedPrompts(d) };
    if (!items[backlogTab]) backlogTab = items.questions.length ? "questions" : "plans";
    paintPanel("backlogtabs", BACKLOG.map(([k, label]) => "<button type='button' role='tab' data-tab='" + k + "' aria-selected='" + (k === backlogTab) + "'" +
      (k === backlogTab ? " class='active'" : "") + ">" + label + "<span class='badge" + (k === "questions" && items.questions.length ? " t-indigo" : "") + "'>" +
      items[k].length + "</span></button>").join(""));
    const [key, , ic, tone, emptyTitle, emptyText] = BACKLOG.find((s) => s[0] === backlogTab);
    const list = items[key];
    // Search narrows rows by the text each one shows, or by a body match from /api/backlog-match;
    // indexes stay the payload's own.
    const needle = backlogGrep.toLowerCase();
    const hit = (text, file, i) => !needle || String(text).toLowerCase().includes(needle) ||
      (!!file && !!backlogBodyHits && backlogBodyHits.needle === backlogGrep && (backlogBodyHits[file] || []).includes(i));
    let shown = 0;
    let html;
    if (!list.length) html = "<div class='empty'><strong>" + esc(emptyTitle) + "</strong>" + esc(emptyText) + "</div>";
    else if (key === "queued") {
      // Each role's queue head carries no Move to top (a no-op there); every later row of
      // that role does. The rows arrive grouped by role — director first, then each role in
      // id order — so a Set of roles already painted marks each group's first row.
      const paintedFirst = new Set();
      html = list.map((q) => {
        const addr = "data-file='" + esc(q.file) + "' data-role='" + esc(q.role) + "'";
        // Mark this role's group head before the edit-row early return, so an edited head row
        // still leaves the Move to top button on that role's later rows.
        const alreadyFirst = paintedFirst.has(q.role);
        paintedFirst.add(q.role);
        // The row being edited swaps its preview for a textarea and a Save/Cancel pair; the
        // address stays the queue-file basename, the same one /api/prompt-cancel uses.
        if (queuedEdit && q.file === queuedEdit.file && q.role === queuedEdit.role) {
          queuedEditPainted = true;
          shown++; // the open editor always shows, so a search never replaces it with "Nothing matches"
          return "<div class='list-item'><span class='li-icon'>" + icon("chat") + "</span>" +
            "<textarea id='queuedit' class='queuedit'>" + esc(queuedEdit.text) + "</textarea>" +
            "<button type='button' class='btn btn-sm rowaction' data-action='prompteditsave' " + addr + ">Save</button>" +
            "<button type='button' class='btn btn-sm rowaction' data-action='prompteditcancel' " + addr + ">Cancel</button></div>";
        }
        if (!hit(q.preview + " " + q.role)) return "";
        shown++;
        const topBtn = alreadyFirst
          ? "<button type='button' class='btn btn-sm rowaction' data-action='prompttop' " + addr + ">Move to top</button>"
          : "";
        return "<div class='list-item'><span class='li-icon'>" + icon("chat") + "</span><div class='li-main'><span class='li-title'>" + esc(q.preview) +
          "</span><span class='li-meta'>" + esc((q.role === "director" ? "for the director" : "for the " + roleLabel(q.role) + " role") +
            (q.notBeforeMs && q.notBeforeMs > Date.now() ? " · delivers in " + humanSeconds(Math.round((q.notBeforeMs - Date.now()) / 1000))
              : (q.queuedAtMs ? " · queued " + fmtAgo(q.queuedAtMs) : ""))) + "</span></div>" +
          topBtn +
          "<button type='button' class='btn btn-sm rowaction' data-action='promptcancel' " + addr + ">Cancel</button>" +
          "<button type='button' class='btn btn-sm rowaction' data-action='promptedit' " + addr + ">Edit</button></div>";
      }).join("");
    } else {
      const open = openEntryKey();
      // The eligibility holds beside the title, from the payload's parallel arrays (indexed by
      // the same tab position the click sends): empty for eligible rows so their markup is
      // unchanged, and the Questions tab carries no holds.
      const holds = key === "plans" ? (d.planHolds || []) : key === "bugs" ? (d.bugHolds || []) : [];
      // Blocked entries (a hold of any kind) paint after the pickable ones under one divider;
      // each row keeps its original data-index so the drawer and Answer still address it.
      const blocked = key === "plans" ? (d.planBlocked || []) : key === "bugs" ? (d.bugBlocked || []) : [];
      const rows = list.map((title, i) => {
        const t = splitTitle(title);
        const mark = holds[i] || "";
        if (!hit(t.title + " " + t.meta + " " + mark, key, i)) return "";
        shown++;
        return "<div class='list-item t-" + tone + (open === key + ":" + i ? " active" : "") + "'><span class='li-icon'>" + icon(ic) + "</span>" +
          "<button type='button' class='li-open backloglink' data-file='" + key + "' data-index='" + i + "'><span class='li-title'>" + esc(t.title) + "</span>" +
          (t.meta ? "<span class='li-meta'>" + esc(t.meta) + "</span>" : "") +
          (mark ? "<span class='li-meta'>" + esc(mark.trim()) + "</span>" : "") + "</button>" +
          (key === "questions" ? "<button type='button' class='btn btn-sm backloglink' data-file='questions' data-index='" + i + "'>Answer</button>" : "") + "</div>";
      });
      const ready = rows.filter((r, i) => r && !blocked[i]);
      const series = key === "plans" ? (d.planSeries || []) : [];
      let heldCount = 0;
      const held = [];
      const seen = new Set();
      rows.forEach((r, i) => {
        if (!blocked[i] || !r) return;
        heldCount++;
        const s = series[i];
        if (!s || needle) { held.push(r); return; }
        if (seen.has(s.name)) return;
        seen.add(s.name);
        held.push("<div class='list-item list-series'><button type='button' class='li-open' data-action='seriestoggle' data-series='" + esc(s.name) + "'><span class='li-title'>" + esc(s.label) + "</span><span class='li-meta'>blocked: each waits on an earlier part</span></button></div>");
        if (openSeries.has(s.name)) rows.forEach((r2, j) => { if (blocked[j] && series[j] && series[j].name === s.name) held.push(r2); });
      });
      html = ready.join("") + (heldCount ? "<div class='list-item list-divider'><span class='li-meta'>Blocked (" + heldCount + ")</span></div>" + held.join("") : "");
    }
    const answered = (key === "questions" ? (d.answeredQuestions || []) : []).map((a, i) => ({ a, i })).filter((x) => hit(x.a.title + " " + (x.a.decision || ""), "answered", x.i));
    shown += answered.length;
    if (answered.length) {
      html += "<div class='list-item list-divider'><span class='li-meta'>Answered recently</span></div>" + answered.map(({ a, i }) =>
        "<div class='list-item t-gray" + (openEntryKey() === "answered:" + i ? " active" : "") + "'><span class='li-icon'>" + icon("check") + "</span><button type='button' class='li-open backloglink' data-file='answered' data-index='" + i + "'><span class='li-title'>" + esc(a.title) + "</span>" +
        (a.decision ? "<span class='li-meta'>" + esc(a.decision) + "</span>" : "") + "</button></div>").join("");
    }
    const finished = (key === "plans" ? (d.donePlans || []) : key === "bugs" ? (d.fixedBugs || []) : []).map((f, i) => ({ f, i })).filter((x) => hit(x.f.title, key === "plans" ? "done" : "fixed", x.i));
    shown += finished.length;
    if (finished.length) {
      html += "<div class='list-item list-divider'><span class='li-meta'>" + (key === "plans" ? "Done recently" : "Fixed recently") + "</span></div>" + finished.map(({ f, i }) => {
        const doneFile = key === "plans" ? "done" : "fixed";
        return "<div class='list-item t-gray" + (openEntryKey() === doneFile + ":" + i ? " active" : "") + "'><span class='li-icon'>" + icon("check") + "</span>" +
          "<button type='button' class='li-open backloglink' data-file='" + doneFile + "' data-index='" + i + "'><span class='li-title'>" + esc(f.title) + "</span>" +
          (f.completedOn ? "<span class='li-meta'>" + esc((key === "plans" ? "done " : "fixed ") + f.completedOn) + "</span>" : "") + "</button></div>";
      }).join("");
    }
    if (needle && list.length && !shown) html = "<div class='empty'><strong>Nothing matches this search</strong>Clear the search box to see every entry.</div>";
    if (key === "plans" || key === "bugs") {
      const kind = key === "plans" ? "plan" : "bug";
      if (backlogNew && backlogNew.kind === kind) {
        backlogNewPainted = true;
        html = "<div class='list-item'><input id='backlognew' type='text' placeholder='" + (kind === "plan" ? "Plan title" : "Bug symptom") + "'>" +
          "<textarea id='backlognewbody' rows='6' placeholder='Details (optional, markdown)'></textarea>" +
          "<button type='button' class='btn btn-sm rowaction' data-action='backlognewsave' data-kind='" + kind + "'>Save</button>" +
          "<button type='button' class='btn btn-sm rowaction' data-action='backlognewcancel'>Cancel</button></div>" + html;
      } else {
        html = "<div class='list-item'><button type='button' class='btn btn-sm' data-action='backlognew' data-kind='" + kind + "'>" +
          (kind === "plan" ? "New plan" : "File a bug") + "</button></div>" + html;
      }
    }
    paintPanel("backlog", html);
  }
  // backlog:end
  $("backlogtabs").addEventListener("click", (ev) => {
    const b = clickClosest(ev, "button[data-tab]");
    if (b) setBacklogTab(b.dataset.tab);
  });
  // Like #feedgrep, the box is static markup set once at load: the 1s poll repaints only the rows,
  // never the box, so it cannot overwrite what the operator is typing.
  $("backloggrep").value = backlogGrep;
  $("backloggrep").addEventListener("input", (ev) => setBacklogGrep(ev.target.value));
  $("backlog").addEventListener("click", async (ev) => {
    const ser = clickClosest(ev, "button[data-action='seriestoggle']");
    if (ser) { toggleBacklogSeries(ser.dataset.series); return; }
    const fresh = clickClosest(ev, "button[data-action='backlognew']");
    if (fresh) { beginBacklogNew(fresh.dataset.kind); return; }
    if (clickClosest(ev, "button[data-action='backlognewcancel']")) { endBacklogNew(); return; }
    const freshSave = clickClosest(ev, "button[data-action='backlognewsave']");
    if (freshSave) {
      const input = $("backlognew");
      const title = input ? input.value.trim() : "";
      if (!title) return;
      const bodyBox = $("backlognewbody");
      await postAction("/api/backlog-file", { kind: freshSave.dataset.kind, title, body: bodyBox ? bodyBox.value : "" }, (d) => "Filed: " + d.title + uncommittedTail(d));
      endBacklogNew();
      return;
    }
    const top = clickClosest(ev, "button.rowaction[data-action='prompttop']");
    if (top) {
      await postAction("/api/prompt-top", { role: top.dataset.role, file: top.dataset.file }, (d) =>
        d && d.status === "topped"
          ? "Moved to the front: " + (d.preview || "")
          : d && d.status === "already_first"
            ? "Already first"
            : "No longer in the inbox — " + (top.dataset.role ? roleLabel(top.dataset.role) : "the director") + " already took it");
      return;
    }
    const cancel = clickClosest(ev, "button.rowaction[data-action='promptcancel']");
    if (cancel) {
      await postAction("/api/prompt-cancel", { role: cancel.dataset.role, file: cancel.dataset.file }, (d) =>
        d && d.status === "cancelled"
          ? "Cancelled: " + (d.preview || "")
          : "No longer in the inbox — " + (cancel.dataset.role ? roleLabel(cancel.dataset.role) : "the director") + " already took it");
      return;
    }
    const edit = clickClosest(ev, "button.rowaction[data-action='promptedit']");
    if (edit) {
      try {
        const d = await getJson("/api/prompt-text?role=" + encodeURIComponent(edit.dataset.role) + "&file=" + encodeURIComponent(edit.dataset.file));
        if (d && d.status === "gone") {
          showFlash("No longer in the inbox — " + (edit.dataset.role ? roleLabel(edit.dataset.role) : "the director") + " already took it");
          refresh();
        } else {
          beginQueuedEdit(edit.dataset.role, edit.dataset.file, (d && d.text) || "");
        }
      } catch (err) {
        showFlash("error: " + err.message);
      }
      return;
    }
    const save = clickClosest(ev, "button.rowaction[data-action='prompteditsave']");
    if (save) {
      const area = $("queuedit");
      const text = area ? area.value.trim() : "";
      if (!text) { showFlash("error: prompt text is empty"); return; }
      await postAction("/api/prompt-edit", { role: save.dataset.role, file: save.dataset.file, text }, (d) =>
        d && d.status === "edited"
          ? "Edited: " + (d.newText || "")
          : "No longer in the inbox — " + (save.dataset.role ? roleLabel(save.dataset.role) : "the director") + " already took it");
      endQueuedEdit();
      return;
    }
    const editCancel = clickClosest(ev, "button.rowaction[data-action='prompteditcancel']");
    if (editCancel) {
      endQueuedEdit();
      return;
    }
    const entry = clickClosest(ev, ".backloglink");
    if (entry) toggleEntry(entry.dataset.file, Number(entry.dataset.index));
  });
`;
