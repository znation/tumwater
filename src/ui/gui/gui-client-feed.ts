// vocabulary: plain
/** The dashboard's Activity card, browser-side: the notable/all feed with its Role picker,
 * text box and tally chips, and the debounced /api/logs search that reaches past the carried
 * window. renderFeed repaints it from each /api/status poll (renderTeam in
 * gui-client-team.ts calls it). Split out of gui-client-team.ts; spliced into gui-client.ts's
 * script right after the backlog card, reaching its helpers through that concatenation. */
export const GUI_CLIENT_FEED_JS = String.raw`
  // activity:start
  // The Activity card's own narrowing, beside the Notable/All segmented choice: a Role picker
  // and a text box filter the events the card carries, and — once a filter is set — a debounced
  // /api/logs search reaches past that carried window into the log's recent slice (the same
  // loop/match rule 'tumwater logs --role'/'--grep' apply to the CLI feed), while the tally
  // chips select one exact event type the way 'tumwater logs --type <type>' does. All persist
  // like the Notable/All choice, so a reload keeps the operator's scope.
  let feedFilter = recall("feed") === "all" ? "all" : "notable";
  let feedRole = recall("feed-role") || "";
  let feedType = recall("feed-type") || "";
  let feedText = recall("feed-grep") || "";
  const KINDS = { landing: ["merge", "green"], problem: ["fail", "red"], attention: ["question", "indigo"], info: ["info", "blue"], routine: ["dot", "gray"] }; // retired-name-ok: event kind key, renamed with the status model
  // Server-backed search state. feedResults is the /api/logs slice once it answers (newest
  // first, the shape renderFeed consumes), null while the card paints its carried window; the
  // debounce feedTimer keeps each keystroke from firing a request; feedSeq numbers requests
  // so a stale answer (a later filter issued a newer one) never paints; feedError names a
  // fetch failure so the empty state can explain it; and feedQueryKey tracks which filter the
  // last search was for, so renderFeed re-arms exactly when the filter changes (never per poll).
  let feedResults = null;
  let feedSeq = 0;
  let feedTimer = null;
  let feedError = "";
  let feedQueryKey = "";
  // Only the non-empty filters ride the query: an absent grep/role means unfiltered server-side,
  // exactly as handleLogs reads them. The type is deliberately NOT carried: the server slice must
  // still deliver every type so the tally chips can be built from it — the type is a local
  // narrowing on the rows in hand, like the Role picker, not a query narrowing.
  function feedLogsQuery() {
    const params = [];
    if (feedText) params.push("grep=" + encodeURIComponent(feedText));
    if (feedRole) params.push("role=" + encodeURIComponent(feedRole));
    return "/api/logs?" + params.join("&");
  }
  // Re-arm the debounced search for the current filter. An empty filter drops any slice and
  // invalidates an in-flight request; otherwise renderFeed has already repainted the locally
  // narrowed window and this waits out the typing pause before asking the server to reach
  // past it. The 250 ms pause is the point: a keystroke narrows at once, the request follows.
  function searchFeed() {
    if (feedTimer) clearTimeout(feedTimer);
    feedResults = null;
    feedError = "";
    const seq = ++feedSeq;
    if (!feedRole && !feedText) return;
    feedTimer = setTimeout(() => { feedTimer = null; void fetchFeedSearch(seq); }, 250);
  }
  async function fetchFeedSearch(seq) {
    try {
      const d = await getJson(feedLogsQuery(), pollSignal());
      if (seq !== feedSeq) return; // a later filter change issued a newer request
      feedResults = (d && d.events ? d.events : []).slice().reverse(); // newest first
    } catch (err) {
      if (seq !== feedSeq) return;
      feedResults = null;
      feedError = err && err.message ? err.message : "Search unavailable";
    }
    if (lastStatus) renderFeed(lastStatus);
  }
  // The Role picker's options follow the team's role list (custom roles included), keyed so a
  // poll with no roster change repaints nothing. A role the team dropped falls back to All
  // roles and persists, exactly as syncRolePicker does for the report and History pickers.
  function syncFeedRoles(d) {
    if (!d) return;
    feedRole = syncRolePicker("feedrole", (d.roles || []).map((l) => l.role), feedRole, "feed-role");
  }
  // An empty feed state: a li.empty with a bold head, a body, and the shared Clear-filter
  // button that ends all three search/error/filter-empty rows — one home for the button's
  // markup so the three cannot drift. The last empty state (nothing notable / no events yet)
  // carries no Clear-filter action, so it stays literal.
  const emptyFeedRow = (head, body) => "<li class='empty'><strong>" + head + "</strong>" + body +
    "<button type='button' class='linkish' data-action='feedclear'>Clear filter</button></li>";
  // A per-type tally for the Activity feed, mirroring the CLI's logs --count display rule
  // (read-only from src/cli/log-commands.ts's sayTally): one N × <type> chip per present event
  // type, count-descending then type-name ascending. A pure function of the rows in hand, so the
  // chips and the <li> rows below cannot drift on which events count; "" for an empty array so
  // empty and empty-state feeds paint no stray chips. Each chip is a button: clicking the
  // currently-selected type clears it, otherwise it selects that type (the active one carries
  // the active class and aria-pressed), the browser twin of 'logs --type <type>'.
  function tallyChips(events, activeType) {
    if (!events.length) return "";
    const counts = new Map();
    for (const e of events) counts.set(e.type, (counts.get(e.type) || 0) + 1);
    const chip = (type, n) => "<button type='button' class='chip mono" + (type === activeType ? " active" : "") +
      "' data-type='" + esc(type) + "' title='" + esc(type) + "'" + (type === activeType ? " aria-pressed='true'" : "") +
      ">" + n + " × " + esc(eventTypeLabel(type)) + "</button>";
    return "<div class='feed-tally chips'>" + [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([type, n]) => chip(type, n)).join("") + "</div>";
  }
  function renderFeed(d) {
    syncFeedRoles(d);
    // Re-arm the debounced server search whenever the filter changed since the last paint (so a
    // recalled filter searches once at load, and no poll refetches an unchanged one).
    const key = feedRole + "\u0000" + feedText;
    if (key !== feedQueryKey) {
      feedQueryKey = key;
      searchFeed();
    }
    const items = (d.eventItems || []).slice().reverse(); // newest first
    const notable = feedFilter === "all" ? items : items.filter((it) => eventKind(it) !== "routine");
    const needle = feedText.toLowerCase();
    const local = notable.filter((it) =>
      (!feedRole || it.source === feedRole) &&
      (!needle || (it.source + " " + it.type + " " + it.message).toLowerCase().includes(needle)));
    // The server's /api/logs slice replaces the carried window once it answers; the Notable/All
    // choice still culls it. A failed fetch paints the search-empty state, never a misleading
    // partial window.
    const serverRows = feedResults !== null
      ? (feedFilter === "all" ? feedResults : feedResults.filter((it) => eventKind(it) !== "routine"))
      : null;
    // The type chip narrows whichever slice is in hand (carried window or server slice), so it
    // composes after the Notable/All cull and the role/grep narrowing. The chips are built from
    // the pre-type rows so every present type stays one click away even when the filter empties
    // the feed.
    const preType = feedError ? [] : serverRows !== null ? serverRows : local;
    const shown = feedType ? preType.filter((it) => it.type === feedType) : preType;
    markActive($("feedfilter"), "filter", feedFilter);
    const roles = new Set((d.roles || []).map((l) => l.role));
    paintPanel("feed", (preType.length ? tallyChips(preType, feedType) : "") + (shown.length
      ? shown.map((it) => {
        const kind = eventKind(it);
        const tone = it.type === "run_end" && kind === "problem" ? resultInfo(it.result).tone : KINDS[kind][1];
        const whoLabel = it.source === "harness" ? "tumwater" : roleLabel(it.source); // vocabulary-ok: the harness event source
        const who = roles.has(it.source) // vocabulary-ok: event field name
          ? "<button type='button' class='linkish feed-loop' data-open='" + esc(it.source) + "'>" + esc(whoLabel) + "</button>" // vocabulary-ok: CSS class and event field
          : "<span class='feed-loop'>" + esc(whoLabel) + "</span>"; // vocabulary-ok: CSS class
        return "<li class='feed-item k-" + kind + "'><span class='feed-icon t-" + tone + "'>" + icon(KINDS[kind][0]) + "</span>" +
          "<div class='feed-msg clamp2' title='" + esc(it.message) + "'>" + who + esc(it.message) + "</div>" +
          "<time class='feed-time' title='" + esc(fmtClock(it.ts)) + "'>" + esc(fmtAgo(it.ts)) + "</time></li>";
      }).join("")
      : feedResults !== null
        ? emptyFeedRow("No events match this filter in the log's recent slice", "Widen the Search or Role picker, or clear the type chip, to look further back. ")
        : feedError
          ? emptyFeedRow("Search unavailable", esc(feedError) + " — the running server may predate the /api/logs endpoint. ")
          : notable.length || preType.length
            ? emptyFeedRow("No recent events match this filter", "Clear the Role, Search, or type chip to see the recent feed again. ")
            : "<li class='empty'><strong>" + (items.length ? "Nothing notable lately" : "No events yet") + "</strong>" +
              (items.length ? "Merges, failures, and questions show up here. All events has every run start and check." : "Events appear here as the roles work.") + "</li>"));
  }
  // The single state change both the chip click and Clear filter use: select a type (stored so
  // a reload keeps the scope), or clear it by passing "".
  function setFeedType(type) {
    feedType = type;
    store("feed-type", type);
    if (lastStatus) renderFeed(lastStatus);
  }
  function clearFeedFilter() {
    feedRole = "";
    feedText = "";
    feedType = "";
    store("feed-role", "");
    store("feed-grep", "");
    store("feed-type", "");
    if ($("feedrole")) $("feedrole").value = "";
    if ($("feedgrep")) $("feedgrep").value = "";
    if (lastStatus) renderFeed(lastStatus);
  }
  $("feedfilter").addEventListener("click", (ev) => {
    const b = clickClosest(ev, "button[data-filter]");
    if (!b) return;
    feedFilter = b.dataset.filter;
    store("feed", feedFilter);
    if (lastStatus) renderFeed(lastStatus);
  });
  $("feedrole").addEventListener("change", (ev) => {
    feedRole = ev.target.value;
    store("feed-role", feedRole);
    if (lastStatus) renderFeed(lastStatus);
  });
  // The box's value is restored once at load and otherwise left untouched: renderFeed repaints
  // the feed on every status poll, so writing feedText back into the box there would wipe the
  // operator's in-progress typing before the committed text caught up. Filter on input so the
  // feed narrows as the operator types.
  $("feedgrep").value = feedText;
  $("feedgrep").addEventListener("input", (ev) => {
    feedText = ev.target.value.trim();
    store("feed-grep", feedText);
    if (lastStatus) renderFeed(lastStatus);
  });
  // The empty state's #feed is static markup, so its delegated listener registers at load like
  // the #feedfilter one above. A chip click whose type matches the current feedType clears it
  // (toggle off), otherwise it selects that type — the same toggle the Notable/All control uses.
  $("feed").addEventListener("click", (ev) => {
    if (clickClosest(ev, "button[data-action='feedclear']")) { clearFeedFilter(); return; }
    const b = clickClosest(ev, "button[data-type]");
    if (b) setFeedType(b.dataset.type === feedType ? "" : b.dataset.type);
  });
  // activity:end
`;
