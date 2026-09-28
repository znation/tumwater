/** The GUI dashboard's operator controls, browser-side: the header's editable daily-cost
 * budget badge (the budget-edit region) and the fleet pause/resume badge (the
 * pause-control region), together with the shared showFlash notice and the lastStatus
 * payload holder both rely on. Inlined into gui-client.ts's GUI_CLIENT_JS by string
 * interpolation as a byte-exact splice: the constant carries the region's own indentation
 * and neither a leading nor a trailing newline, and it sits at the splice point between the
 * two blank lines the region used to own, so the assembled script is byte-for-byte the
 * pre-split single blob and the marked regions (budget-edit, pause-control) that
 * test/gui-operator.test.ts extracts from GUI_PAGE keep matching. It runs as part of the
 * page's only <script> and cannot import the harness modules — it reaches gui-client.ts's
 * core helpers (esc, postJson) through that concatenation, and the later fleet code reaches
 * back into this module's lastStatus/showFlash the same way. Edit here when the budget
 * editor or the pause control's client behavior changes. */
export const GUI_CLIENT_OPERATOR_JS = `  // budget-edit:start
  // The header's daily cost budget badge is editable: clicking swaps just that fragment for
  // an inline input + set/cancel; saving POSTs /api/budget, which writes tumwater.json through
  // the same shared setter as the TUI's Ctrl+B. No optimistic local state: on success the
  // badge re-renders from the next 1 s poll (the orchestrator picks the new cap up within ~2
  // s), and a failed save flashes the server's error and keeps the editor open so the operator
  // can fix it. lastStatus is the latest /api/status payload, kept so cancel can restore the
  // badge without waiting for the next poll.
  let lastStatus = null;
  // The serving process's startup build sha, remembered from the first successful poll so a
  // later change (a redeploy re-execs the server) reloads this page onto the new code.
  let serverBuildSha = null;
  let budgetEditing = false;
  function renderBudgetBadge(d) {
    if (budgetEditing) return; // keep the editor until set/cancel decides
    // An all-free fleet has no spend a cap could ever bind: its badge is plain text (no
    // link, no pointer) so it cannot open a cap editor that would never take effect. Every
    // other state keeps the clickable badge — the affordance for editing the cap.
    document.getElementById("budgetwrap").innerHTML = d.budget && d.budget.free
      ? "<span>" + esc(d.budgetBadge || "") + "</span>"
      : "<a href='#' id='budgetbadge'>" + esc(d.budgetBadge || "") + "</a>";
  }
  function openBudgetEditor() {
    budgetEditing = true;
    // Pre-filled with the current cap — empty when disabled (empty means "no cap" on save).
    const cap = lastStatus && lastStatus.budget && lastStatus.budget.capUsd > 0 ? String(lastStatus.budget.capUsd) : "";
    document.getElementById("budgetwrap").innerHTML =
      "<input type='number' min='0' step='0.01' id='budgetinput' value='" + esc(cap) + "' style='width:9em;padding:2px 6px'>"
      + " <button id='budgetset'>set</button> <button id='budgetcancel'>cancel</button>";
    const input = document.getElementById("budgetinput");
    input.focus();
    input.select();
  }
  function showFlash(msg) {
    const f = document.getElementById("flash");
    f.textContent = msg;
    setTimeout(() => (f.textContent = ""), 3000);
  }
  async function saveBudget() {
    const input = document.getElementById("budgetinput");
    if (!input) return;
    // A type=number input reports value "" both for a field the operator cleared on purpose
    // (post 0 = no cap, below) and for text the browser rejected ("$25", "5,000") — the two
    // look identical through .value. validity.badInput tells them apart, so a typo flashes an
    // error instead of silently disabling the spend cap; stay in edit mode so it can be fixed.
    if (input.validity && input.validity.badInput) {
      showFlash("budget must be a number of 0 or more (clear the field for no cap)");
      return;
    }
    // Empty means "no cap" (0 disables).
    const value = input.value === "" ? 0 : Number(input.value);
    try {
      await postJson("/api/budget", { maxDailyCostUsd: value });
      budgetEditing = false; // the next poll re-renders the badge from the payload
    } catch (e) {
      showFlash("error: " + e.message); // stay in edit mode so the operator can fix it
    }
  }
  document.addEventListener("click", (ev) => {
    if (ev.target.closest("#budgetbadge")) { ev.preventDefault(); openBudgetEditor(); return; }
    if (ev.target.id === "budgetset") { saveBudget(); return; }
    if (ev.target.id === "budgetcancel") { budgetEditing = false; renderBudgetBadge(lastStatus); }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && ev.target.id === "budgetinput") saveBudget(); // Enter saves, like set
  });
  // budget-edit:end

  // pause-control:start
  // The header's fleet pause/resume control: one click POSTs /api/pause, the same operator
  // gate "tumwater pause" / "resume" write, so a shell-less operator watching the dashboard
  // (e.g. over "gui --all-interfaces") can halt a runaway fleet. No optimistic state: the
  // badge re-renders from the next 1 s poll's d.paused (the marker is persistent state —
  // pausing before startup starts an already-paused fleet), and a failed POST flashes the
  // server's error so the operator knows the marker did not change.
  function renderPauseBadge(d) {
    document.getElementById("pausewrap").innerHTML = d.paused
      ? "<a href='#' id='pausebadge'> · paused — resume</a>"
      : "<a href='#' id='pausebadge'> · pause</a>";
  }
  async function togglePause() {
    // The opposite of the last server-reported state; the poll re-renders the badge after a
    // successful POST, so the control never paints a state the marker does not hold. Routes
    // through the shared apiFetch guard, like every other endpoint call.
    const target = !(lastStatus && lastStatus.paused);
    try {
      await postJson("/api/pause", { paused: target });
    } catch (e) {
      showFlash("error: " + e.message); // no optimistic state; fix and click again
    }
  }
  document.addEventListener("click", (ev) => {
    if (ev.target.closest("#pausebadge")) { ev.preventDefault(); togglePause(); }
  });
  // pause-control:end`;
