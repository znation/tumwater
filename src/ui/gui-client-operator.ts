/** The dashboard's fleet-wide operator controls, browser-side, both living in the masthead so
 * they are in reach from every view: the daily spend badge — today's spend against the cap
 * with a meter, a button that opens a small editor for the cap (POST /api/budget, the same
 * setter as the TUI's Ctrl+B) — and the pause control, a menu of timed pauses (POST
 * /api/pause with `forSeconds`, the CLI's `pause --for`) that turns into a Resume button with
 * the countdown while the fleet is paused. Neither keeps optimistic state: after a successful
 * POST the next status poll re-renders them from the server's answer, and a failed one toasts
 * the error and leaves the editor open. Spliced into gui-client.ts's script, reaching its
 * helpers (esc, icon, postJson, paintPanel, showFlash, the menu registry) through that
 * concatenation. */
export const GUI_CLIENT_OPERATOR_JS = String.raw`  // budget-edit:start
  let budgetEditing = false;
  function budgetTone(b) {
    if (!(b.capUsd > 0)) return "";
    const pct = (b.spentUsd / b.capUsd) * 100;
    return pct >= 100 ? " t-red" : pct >= 85 ? " t-amber" : "";
  }
  // The sidebar's spend card for a payload's budget block: a plain card for an all-free fleet
  // (no spend a cap could bind, so no editor), otherwise the button that opens the cap editor,
  // with a meter while a cap is set.
  function budgetCardHtml(b) {
    if (b.free) {
      return "<div class='side-card' title='Every model the fleet can use is cost n/a, so there is nothing to cap'>" +
        "<span class='side-card-label'>" + icon("dollar") + "Spend</span><span class='side-card-value'>Free models</span></div>";
    }
    const capped = b.capUsd > 0;
    const pct = capped ? Math.min(100, (b.spentUsd / b.capUsd) * 100) : 0;
    const tone = budgetTone(b);
    return "<button type='button' class='side-card' id='budgetbadge' aria-haspopup='dialog' title='" +
      esc(capped ? "Today's spend against the daily cap — click to change the cap" : "No daily cap — click to set one") + "'>" +
      "<span class='side-card-label'>" + icon("dollar") + "Spent today<span class='edit'>" + (capped ? "Edit cap" : "Set a cap") + "</span></span>" +
      "<span class='side-card-value'>" + esc(fmtUsd(b.spentUsd)) + " <small>" + esc(capped ? "of " + fmtCap(b.capUsd) : "no daily cap") + "</small></span>" +
      (capped ? "<span class='meter" + tone + "'><span style='width:" + pct.toFixed(1) + "%'></span></span>" : "") + "</button>";
  }
  function renderBudgetBadge(d) {
    if (budgetEditing) return; // the open editor owns the slot until save or cancel
    const b = d && d.budget;
    paintPanel("budgetwrap", b ? budgetCardHtml(b) : "");
  }
  function openBudgetEditor() {
    const b = lastStatus && lastStatus.budget;
    if (!b || b.free) return;
    closeMenus();
    budgetEditing = true;
    const wrap = $("budgetwrap");
    const pop = document.createElement("div");
    pop.className = "popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Daily spend cap");
    // Pre-filled with the current cap; empty means no cap.
    pop.innerHTML = "<label for='budgetinput'>Daily spend cap</label>" +
      "<div class='input-prefix'><span>$</span><input type='number' min='0' step='0.01' id='budgetinput' value='" +
      esc(b.capUsd > 0 ? String(b.capUsd) : "") + "' placeholder='no cap'></div>" +
      "<p class='hint'>" + esc("Spent today: " + fmtUsd(b.spentUsd) + ". At the cap the loops " +
        (b.fallback ? "switch to the free fallback model" : "pause") + " until midnight. Leave it empty for no cap.") + "</p>" +
      "<div class='popover-actions'><button type='button' class='btn btn-sm' id='budgetcancel'>Cancel</button>" +
      "<button type='button' class='btn btn-sm btn-primary' id='budgetset'>Save</button></div>";
    wrap.appendChild(pop);
    openMenu = {
      root: wrap,
      close: () => {
        pop.remove();
        budgetEditing = false;
        delete lastPaint.budgetwrap;
        renderBudgetBadge(lastStatus);
      },
    };
    const input = $("budgetinput");
    input.focus({ preventScroll: true });
    input.select();
  }
  async function saveBudget() {
    const input = $("budgetinput");
    if (!input) return;
    // A type=number input reports "" both for a field cleared on purpose (no cap) and for text
    // the browser rejected ("$25"); validity.badInput tells them apart, so a typo is an error
    // instead of silently removing the cap.
    if (input.validity && input.validity.badInput) {
      showFlash("error: the cap must be a number of 0 or more — leave it empty for no cap");
      return;
    }
    const value = input.value === "" ? 0 : Number(input.value);
    try {
      await postJson("/api/budget", { maxDailyCostUsd: value });
    } catch (e) {
      showFlash("error: " + e.message); // the editor stays open so the value can be fixed
      return;
    }
    showFlash(value > 0 ? "Daily cap set to " + fmtCap(value) : "Daily cap removed");
    closeMenus();
    refresh();
  }
  document.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;
    if (t.closest("#budgetbadge")) {
      ev.preventDefault();
      if (budgetEditing) closeMenus();
      else openBudgetEditor();
      return;
    }
    if (t.closest("#budgetset")) { saveBudget(); return; }
    if (t.closest("#budgetcancel")) closeMenus();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && ev.target instanceof Element && ev.target.id === "budgetinput") {
      ev.preventDefault();
      saveBudget();
    }
  });
  // budget-edit:end

  // pause-control:start
  let pauseMenuOpen = false;
  // The timed pauses the menu offers; 0 is a standing pause that lasts until Resume.
  const PAUSE_CHOICES = [[1800, "For 30 minutes"], [3600, "For 1 hour"], [7200, "For 2 hours"], [28800, "For 8 hours"], [0, "Until I resume it"]];
  // How long a timed fleet pause has left (humanSeconds), or "" for a standing one.
  function pauseLeft(d) {
    return d.pausedUntil ? humanSeconds(Math.max(0, Math.round((d.pausedUntil - Date.now()) / 1000))) : "";
  }
  // The sidebar's pause control: Resume (with a timed pause's countdown) while the fleet is
  // paused, otherwise the button that opens the menu of timed pauses.
  function pauseControlHtml(d) {
    if (d.paused) {
      const left = pauseLeft(d);
      return "<button type='button' class='btn btn-warn' id='pausebadge' title='The fleet is paused — click to resume it'>" +
        icon("play") + "<span>Resume the fleet</span><span class='btn-note' id='pausenote'>" + (left ? esc(left) + " left" : "") + "</span></button>";
    }
    return "<button type='button' class='btn' id='pausebadge' aria-haspopup='menu' title='Pause the fleet — loops start no new ticks'>" +
      icon("pause") + "<span>Pause the fleet</span><span class='btn-note'>" + icon("chev") + "</span></button>";
  }
  function renderPauseBadge(d) {
    if (pauseMenuOpen) return;
    if (!d) { paintPanel("pausewrap", ""); return; }
    const note = $("pausenote");
    if (d.paused && note && (pauseLeft(d) !== "") === (note.textContent !== "")) {
      // Same control, new countdown: rewrite the text, keep the button under the pointer.
      note.textContent = pauseLeft(d) ? pauseLeft(d) + " left" : "";
      return;
    }
    paintPanel("pausewrap", pauseControlHtml(d));
  }
  function openPauseMenu() {
    closeMenus();
    pauseMenuOpen = true;
    const wrap = $("pausewrap");
    const pop = document.createElement("div");
    pop.className = "popover menu";
    pop.setAttribute("role", "menu");
    pop.innerHTML = "<div class='menu-title'>Pause the fleet</div>" +
      PAUSE_CHOICES.map((c) => "<button type='button' class='menu-item' role='menuitem' data-pause='" + c[0] + "'>" +
        icon(c[0] ? "clock" : "pause") + esc(c[1]) + "</button>").join("") +
      "<p class='hint' style='margin:4px 10px 4px'>In-flight ticks finish, and the director keeps running your prompts.</p>";
    wrap.appendChild(pop);
    openMenu = {
      root: wrap,
      close: () => {
        pop.remove();
        pauseMenuOpen = false;
        delete lastPaint.pausewrap;
        renderPauseBadge(lastStatus);
      },
    };
    const first = pop.querySelector("button");
    if (first) first.focus({ preventScroll: true });
  }
  async function setFleetPause(paused, forSeconds) {
    const body = { paused: paused };
    if (paused && forSeconds > 0) body.forSeconds = forSeconds;
    try {
      await postJson("/api/pause", body);
    } catch (e) {
      showFlash("error: " + e.message); // nothing changed; the control still shows the real state
      return;
    }
    showFlash(paused
      ? "Fleet paused" + (forSeconds > 0 ? " for " + humanSeconds(forSeconds) : "") + " — in-flight ticks finish"
      : "Fleet resumed");
    closeMenus();
    refresh();
  }
  document.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;
    if (t.closest("#pausebadge")) {
      ev.preventDefault();
      if (lastStatus && lastStatus.paused) setFleetPause(false);
      else if (pauseMenuOpen) closeMenus();
      else openPauseMenu();
      return;
    }
    const choice = t.closest("[data-pause]");
    if (choice) setFleetPause(true, Number(choice.dataset.pause));
  });
  // pause-control:end`;
