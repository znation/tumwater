import { PAUSE_REASON_MAX } from "../../fleet/fleet-state.js";

/** The dashboard's fleet-wide operator controls, browser-side, all living in the sidebar so
 * they are in reach from every view: the daily spend badge — today's spend against the cap
 * with a meter, a button that opens a small editor for the cap (POST /api/budget, the same
 * setter as the TUI's Ctrl+B) — the pause control, a menu of timed pauses with an
 * optional reason (POST /api/pause with `forSeconds` and `reason`, the CLI's `pause --for`/`--reason`) that turns into a Resume button with
 * the countdown while the fleet is paused, and the sound toggle that mutes the alert cue (a
 * per-browser preference, no server call). Neither keeps optimistic state: after a successful
 * POST the next status poll re-renders them from the server's answer, and a failed one toasts
 * the error and leaves the editor open. Spliced into gui-client.ts's script, where it reaches
 * the other sections' shared plumbing through that concatenation: the DOM and HTML helpers
 * ($, esc, icon), the formatters (fmtUsd, fmtCap, humanSeconds), the slot painter and toast
 * (paintPanel, showFlash), the POST helper (postJson), the click hook (onClick), the menu
 * registry (closeMenus, openMenu), the poll re-render (refresh, hoisted from gui-client-boot.ts
 * later in the join), the sound state it flips (soundMuted, setSoundMuted — gui-client-sound.ts
 * earlier in the join), and the shared page state it reads and invalidates (lastStatus,
 * lastPaint). Its own two popovers share their scaffolding through openPopover (each
 * supplies the html plus an onClosed that resets its flag and re-renders the slot), and
 * its two POSTs share their send-toast-close-repaint tail through the core's postAction. */
export const GUI_CLIENT_OPERATOR_JS = String.raw`  // shared-operator:start
  // The scaffolding both sidebar popovers share (the cap editor, the pause menu): close
  // whatever is open, build the popover element into the slot's wrap, and register the
  // global close that outside clicks and Esc route through — remove the popover, drop the
  // slot's paint cache so the next poll repaints from scratch, and run onClosed, which
  // resets the opener's flag and re-renders the slot from the last status.
  function openPopover(wrapId, opts) {
    closeMenus();
    const wrap = $(wrapId);
    const pop = document.createElement("div");
    pop.className = "popover" + (opts.menu ? " menu" : "");
    pop.setAttribute("role", opts.role);
    if (opts.label) pop.setAttribute("aria-label", opts.label);
    pop.innerHTML = opts.html;
    wrap.appendChild(pop);
    openMenu = {
      root: wrap,
      close: () => {
        pop.remove();
        delete lastPaint[wrapId];
        opts.onClosed();
      },
    };
    return pop;
  }
  // The tail both operator POSTs share: postAction (the core's one POST-and-toast step —
  // an error leaves the control showing what the server last reported, a success toasts the
  // ok message, closes any open popover, and repaints from the next status poll) does that
  // work; these handlers only build the body and message.
  // shared-operator:end

  // budget-edit:start
  let budgetEditing = false;
  function budgetTone(b) {
    if (!(b.capUsd > 0)) return "";
    const pct = (b.spentUsd / b.capUsd) * 100;
    return pct >= 100 ? " t-red" : pct >= 85 ? " t-amber" : "";
  }
  // The subscription usage window (plans/agent-backends.md §8, PLANS.md part 6d/7): the
  // sidebar's spend card renders it beside the daily spend, or in its place for a
  // subscription-only fleet. The label/status/clock rules mirror badges.ts's
  // claudeWindowBadge — the preformatted header fragment the TUI uses cannot be reused here
  // because the card lists EVERY window, not just the most constrained one.
  function windowLabel(type) {
    const m = /^(\w+)_(hour|day|week)$/.exec(String(type));
    if (!m) return String(type).replace(/_/g, " ");
    const words = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
    const unit = m[2] === "hour" ? "h" : m[2] === "day" ? "d" : "w";
    return (words[m[1]] || m[1]) + unit;
  }
  function windowWord(status) {
    if (status === "allowed_warning") return "near limit";
    if (status === "rejected") return "limited";
    return status === "reset" ? "reset" : "ok";
  }
  function windowClock(ms) {
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function windowLine(w, cw) {
    const parts = ["Claude " + windowLabel(w.type)];
    const word = windowWord(w.status);
    parts.push(typeof w.utilization === "number" ? Math.round(w.utilization * 100) + "%" : word === "ok" ? "ok · usage not reported" : word);
    if (w.isUsingOverage) parts.push("overage");
    if (w.status === "rejected" && cw.heldUntil != null) parts.push("held until " + windowClock(cw.heldUntil));
    else if (w.status !== "reset" && typeof w.resetsAt === "number") parts.push("resets " + windowClock(w.resetsAt));
    return parts.join(" · ");
  }
  function windowLineTone(w) {
    if (w.status === "rejected") return " t-red";
    if (w.status === "allowed_warning") return " t-amber";
    return "";
  }
  function windowLinesHtml(cw) {
    if (!cw) return "";
    // Shortest window first (5h above 7d), whatever order the server ranks severity in; an
    // unlabelled type sorts last, then by type name. A copy, so cw.windows keeps its order.
    const hours = (w) => {
      const m = /^(\d+)([hdw])$/.exec(windowLabel(w.type));
      return m ? Number(m[1]) * (m[2] === "h" ? 1 : m[2] === "d" ? 24 : 168) : Infinity;
    };
    const shortestFirst = cw.windows.slice().sort((a, b) => (hours(a) === hours(b) ? (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) : hours(a) < hours(b) ? -1 : 1));
    return shortestFirst.map((w) => {
      const line = "<span class='side-card-value window-line" + windowLineTone(w) + "'>" + esc(windowLine(w, cw)) + "</span>";
      if (typeof w.utilization !== "number") return line;
      const pct = Math.min(100, Math.round(w.utilization * 100));
      return line + "<span class='meter" + windowLineTone(w) + "'><span style='width:" + pct + "%'></span></span>";
    }).join("");
  }
  // The sidebar's spend card for a payload's budget block: a plain card for an all-free fleet
  // (no spend a cap could bind, so no editor), otherwise the button that opens the cap editor,
  // with a meter while a cap is set.
  function budgetCardHtml(b, cw) {
    // A subscription-only fleet has no priced spend for a cap to bind, so the window card
    // stands in place of the spend card and carries no editor.
    if (cw && cw.only) {
      return "<div class='side-card' title='Claude.ai subscription usage windows — a rejected window holds the claude seams until it resets'>" +
        "<span class='side-card-label'>" + icon("clock") + "Claude window</span>" + windowLinesHtml(cw) + "</div>";
    }
    if (b.free) {
      return "<div class='side-card' title='Every model the fleet can use is cost n/a, so there is nothing to cap'>" +
        "<span class='side-card-label'>" + icon("dollar") + "Spend</span><span class='side-card-value'>Free models</span>" + windowLinesHtml(cw) + "</div>";
    }
    const capped = b.capUsd > 0;
    const pct = capped ? Math.min(100, (b.spentUsd / b.capUsd) * 100) : 0;
    const tone = budgetTone(b);
    return "<button type='button' class='side-card' id='budgetbadge' aria-haspopup='dialog' title='" +
      esc(capped ? "Today's spend against the daily cap — click to change the cap" : "No daily cap — click to set one") + "'>" +
      "<span class='side-card-label'>" + icon("dollar") + "Spent today<span class='edit'>" + (capped ? "Edit cap" : "Set a cap") + "</span></span>" +
      "<span class='side-card-value'>" + esc(fmtUsd(b.spentUsd)) + " <small>" + esc(capped ? "of " + fmtCap(b.capUsd) : "no daily cap") + "</small></span>" +
      (capped ? "<span class='meter" + tone + "'><span style='width:" + pct.toFixed(1) + "%'></span></span>" : "") + windowLinesHtml(cw) + "</button>";
  }
  function renderBudgetBadge(d) {
    if (budgetEditing) return; // the open editor owns the slot until save or cancel
    const b = d && d.budget;
    paintPanel("budgetwrap", b ? budgetCardHtml(b, d && d.claudeWindow) : "");
  }
  function openBudgetEditor() {
    const b = lastStatus && lastStatus.budget;
    if (!b || b.free) return;
    openPopover("budgetwrap", {
      role: "dialog",
      label: "Daily spend cap",
      // Pre-filled with the current cap; empty means no cap.
      html: "<label for='budgetinput'>Daily spend cap</label>" +
        "<div class='input-prefix'><span>$</span><input type='number' min='0' step='0.01' id='budgetinput' value='" +
        esc(b.capUsd > 0 ? String(b.capUsd) : "") + "' placeholder='no cap'></div>" +
        "<p class='hint'>" + esc("Spent today: " + fmtUsd(b.spentUsd) + ". At the cap the loops " +
          (b.fallback ? "switch to the free fallback model" : "pause") + " until midnight. Leave it empty for no cap.") + "</p>" +
        "<div class='popover-actions'><button type='button' class='btn btn-sm' id='budgetcancel'>Cancel</button>" +
        "<button type='button' class='btn btn-sm btn-primary' id='budgetset'>Save</button></div>",
      onClosed: () => {
        budgetEditing = false;
        renderBudgetBadge(lastStatus);
      },
    });
    budgetEditing = true;
    const input = $("budgetinput");
    input.focus({ preventScroll: true });
    input.select();
  }
  // The cap editor's plain-decimal rule, the same one the TUI's Ctrl+B editor applies: empty
  // means no cap, otherwise a plain decimal of 0 or more, at most Number.MAX_SAFE_INTEGER.
  // Number() alone would read hex ("0x10" → 16) and finite exponent notation ("1e2" → 100) as
  // dollar amounts no operator meant, and a long digit run stays finite (1e24) yet is no longer
  // an exactly representable dollar amount — the setter's own checkDailyBudgetUsd bounds the
  // same way, so this keeps the editor's inline error and the write path in agreement.
  function parseBudgetField(raw) {
    const t = String(raw).trim();
    if (t === "") return { ok: true, value: 0 };
    const n = Number(t);
    if (!/^\d*\.?\d+$/.test(t) || !Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
      return {
        ok: false,
        error: "the cap must be a number of 0 or more, at most " + Number.MAX_SAFE_INTEGER + " — leave it empty for no cap",
      };
    }
    return { ok: true, value: n };
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
    const parsed = parseBudgetField(input.value);
    if (!parsed.ok) {
      showFlash("error: " + parsed.error);
      return;
    }
    const value = parsed.value;
    // A failure leaves the editor open so the value can be fixed.
    await postAction("/api/budget", { maxDailyCostUsd: value },
      value > 0 ? "Daily cap set to " + fmtCap(value) : "Daily cap removed");
  }
  onClick((t, ev) => {
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
      return "<button type='button' class='btn btn-warn' id='pausebadge' title='" + esc("The fleet is paused — click to resume it" + (d.pauseReason ? " (" + d.pauseReason + ")" : "")) + "'>" +
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
    const pop = openPopover("pausewrap", {
      menu: true,
      role: "menu",
      html: "<div class='menu-title'>Pause the fleet</div>" +
        "<input type='text' id='pausereason' class='menu-input' maxlength=${PAUSE_REASON_MAX} placeholder='Reason (optional)' aria-label='Pause reason' style='margin:2px 10px 4px;width:calc(100% - 20px)'>" +
        PAUSE_CHOICES.map((c) => "<button type='button' class='menu-item' role='menuitem' data-pause='" + c[0] + "'>" +
          icon(c[0] ? "clock" : "pause") + esc(c[1]) + "</button>").join("") +
        "<p class='hint' style='margin:4px 10px 4px'>In-flight ticks finish, and the director keeps running your prompts.</p>",
      onClosed: () => {
        pauseMenuOpen = false;
        renderPauseBadge(lastStatus);
      },
    });
    pauseMenuOpen = true;
    const first = pop.querySelector("button");
    if (first) first.focus({ preventScroll: true });
  }
  async function setFleetPause(paused, forSeconds, reason) {
    const body = { paused: paused };
    if (paused && forSeconds > 0) body.forSeconds = forSeconds;
    const why = paused && reason ? String(reason).trim() : "";
    if (why) body.reason = why;
    // A failure changes nothing; the control still shows the real state.
    await postAction("/api/pause", body, paused
      ? "Fleet paused" + (forSeconds > 0 ? " for " + humanSeconds(forSeconds) : "") + " — in-flight ticks finish"
      : "Fleet resumed");
  }
  onClick((t, ev) => {
    if (t.closest("#pausebadge")) {
      ev.preventDefault();
      if (lastStatus && lastStatus.paused) setFleetPause(false);
      else if (pauseMenuOpen) closeMenus();
      else openPauseMenu();
      return;
    }
    const choice = t.closest("[data-pause]");
    if (choice) {
      const input = $("pausereason");
      setFleetPause(true, Number(choice.dataset.pause), input ? input.value : "");
    }
  });
  // pause-control:end

  // sound-control:start
  // The sidebar's sound control, beside the theme toggle: a speaker icon that flips between
  // the unmuted and muted glyph. A per-browser preference (setSoundMuted stores it), not fleet
  // state — no server call; the choice takes effect on the next cue.
  function soundControlHtml() {
    return "<button type='button' class='icon-btn' id='soundtoggle' title='" +
      (soundMuted ? "Sound is muted — click to unmute the alert cue" : "Sound is on — click to mute the alert cue") +
      "' aria-label='" + (soundMuted ? "Unmute" : "Mute") + " the alert cue'>" +
      icon(soundMuted ? "mute" : "sound") + "</button>";
  }
  function renderSoundBadge() {
    paintPanel("soundwrap", soundControlHtml());
  }
  function toggleSound() {
    setSoundMuted(!soundMuted);
    renderSoundBadge();
  }
  onClick((t) => {
    if (t.closest("#soundtoggle")) toggleSound();
  });
  // sound-control:end`;
