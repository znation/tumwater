import { PAUSE_REASON_MAX } from "../../team/team-state.js";

/** The dashboard's team-wide operator controls, browser-side, all living in the sidebar so
 * they are in reach from every view: the daily spend badge — today's spend against the cap
 * with a meter, a button that opens a small editor for the cap (POST /api/budget, the same
 * setter as the TUI's Ctrl+B) — the pause control, a menu of timed pauses with an
 * optional reason (POST /api/pause with `forSeconds` and `reason`, the CLI's
 * `pause --for`/`--reason`) that turns into a Resume button with the countdown while the
 * team is paused. Neither keeps optimistic state: after a successful
 * POST the next status poll re-renders them from the server's answer, and a failed one toasts
 * the error and leaves the editor open. Spliced into gui-client.ts's script, where it reaches
 * the other sections' shared plumbing through that concatenation: the DOM and HTML helpers
 * ($, esc, icon), the formatters (fmtUsd, fmtCap, humanSeconds), the slot painter and toast
 * (paintPanel, showFlash), the POST helper (postJson), the click hook (onClick), the menu
 * registry (closeMenus, openMenu), the poll re-render (refresh, hoisted from gui-client-boot.ts
 * later in the join), and the shared page state it reads and invalidates (lastStatus,
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
  // The bar under a spend/window readout: a span class='meter{tone}' wrapping a fill whose
  // width is the spent share. The one home of the markup both the claude-window line
  // (windowLinesHtml) and the budget card (budgetCardHtml) render, so the class/nesting
  // cannot drift between them; each call site shapes its own percent (an integer round for
  // the window, one decimal for the card).
  function meterBar(tone, pct) {
    return "<span class='meter" + tone + "'><span style='width:" + pct + "%'></span></span>";
  }
  // The subscription usage window (plans/agent-backends.md §8, PLANS.md part 6d/7): the
  // sidebar's spend card renders it beside the daily spend, or in its place for a
  // subscription-only team. The label/status/clock rules mirror badges.ts's
  // subscriptionWindowBadge — the preformatted header fragment the TUI uses cannot be reused here
  // because the card lists EVERY window of EVERY block, not just the most constrained one.
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
  function windowResets(ms) {
    const minutes = Math.floor((ms - Date.now()) / 60000);
    if (minutes < 1) return "resets now";
    if (minutes < 60) return "resets in " + minutes + "m";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return "resets in " + hours + "h " + (minutes % 60) + "m";
    return "resets in " + Math.floor(hours / 24) + "d " + (hours % 24) + "h";
  }
  // A window's consumed fraction as a whole-number percent, the same shape as node-side
  // utilizationPct - the browser script keeps its inline copy, so the text percentage and
  // the meter width share this one home instead of each rounding w.utilization by hand.
  function windowPct(w) {
    return Math.round(w.utilization * 100);
  }
  function chainMoved(chain) {
    return Object.values(chain || {}).some((t) => t.reason === "window" || t.reason === "reserve");
  }
  // One line per tier off its primary, the same text as badges.ts's chainFragments.
  function chainLinesHtml(chain) {
    return ["small", "default", "strong"].filter((tier) => chain && chain[tier]).map((tier) => {
      const t = chain[tier];
      const money = t.spentUsd !== undefined && t.capUsd !== undefined ? " " + fmtUsd(t.spentUsd) + "/" + fmtCap(t.capUsd) : "";
      const until = t.returnsAt !== undefined ? " until " + windowClock(t.returnsAt) : "";
      return "<span class='side-card-value window-line'>" + esc(tier + " → " + t.pair + money + until) + "</span>";
    }).join("");
  }
  function windowLine(w, block, chain) {
    const parts = [block.label + " " + windowLabel(w.type)];
    const word = windowWord(w.status);
    parts.push(typeof w.utilization === "number" ? windowPct(w) + "%" : word === "ok" ? "ok · usage not reported" : word);
    if (w.isUsingOverage) parts.push("overage");
    if (w.status === "rejected" && block.heldUntil != null) parts.push((chainMoved(chain) ? "on fallback until " : block.label + " model jobs wait until ") + windowClock(block.heldUntil));
    else if (w.status !== "reset" && typeof w.resetsAt === "number") parts.push(windowResets(w.resetsAt));
    return parts.join(" · ");
  }
  function windowLineTone(w) {
    if (w.status === "rejected") return " t-red";
    if (w.status === "allowed_warning") return " t-amber";
    return "";
  }
  function windowLinesHtml(blocks, only, chain) {
    if (!blocks || blocks.length === 0) return chainLinesHtml(chain);
    // One window line per block, its windows shortest-first (5h above 7d), whatever order
    // the server ranks severity in; an unlabelled type sorts last, then by type name. A copy,
    // so block.windows keeps its order.
    return blocks.map((block) => blockLinesHtml(block, chain)).join("") + chainLinesHtml(chain);
  }
  function blockLinesHtml(block, chain) {
    const hours = (w) => {
      const m = /^(\d+)([hdw])$/.exec(windowLabel(w.type));
      return m ? Number(m[1]) * (m[2] === "h" ? 1 : m[2] === "d" ? 24 : 168) : Infinity;
    };
    const shortestFirst = block.windows.slice().sort((a, b) => (hours(a) === hours(b) ? (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) : hours(a) < hours(b) ? -1 : 1));
    return shortestFirst.map((w) => {
      const line = "<span class='side-card-value window-line" + windowLineTone(w) + "'>" + esc(windowLine(w, block, chain)) + "</span>";
      if (typeof w.utilization !== "number") return line;
      const pct = Math.min(100, windowPct(w));
      return line + meterBar(windowLineTone(w), pct);
    }).join("");
  }
  // The sidebar's spend card for a payload's budget block: a plain card for an all-free team
  // (no spend a cap could bind, so no editor), otherwise the button that opens the cap editor,
  // with a meter while a cap is set. When the snapshot's budget.capHitAt stands (budget.ts's
  // projectCapHit), the card names the burn-rate cap forecast ~cap at HH:MM — the same clock
  // text budgetBadge prints — between the meter and any window lines, so the browser and the
  // terminal header cannot disagree. capHitAt is null (or absent) whenever no cap is set, so the
  // forecast never renders on a no-cap card.
  function budgetCardHtml(b, blocks, only, chain) {
    // A subscription-only team has no priced spend for a cap to bind, so the window card
    // stands in place of the spend card and carries no editor — but only while a window block
    // actually exists; an all-free subscription-only team (only and free, no windows) falls
    // through to the "Free models" spend card below so it never renders an empty window card.
    if (only && blocks && blocks.length > 0) {
      return "<div class='side-card' title='Subscription usage windows — a rejected window pauses model jobs on that backend until it resets'>" +
        "<span class='side-card-label'>" + icon("clock") + "subscription window</span>" + windowLinesHtml(blocks, only, chain) + "</div>";
    }
    if (b.free) {
      return "<div class='side-card' title='Every model the team can use is cost n/a, so there is nothing to cap'>" +
        "<span class='side-card-label'>" + icon("dollar") + "Spend</span><span class='side-card-value'>Free models</span>" + windowLinesHtml(blocks, only, chain) + "</div>";
    }
    const capped = b.capUsd > 0;
    const pct = capped ? Math.min(100, (b.spentUsd / b.capUsd) * 100) : 0;
    const tone = budgetTone(b);
    return "<button type='button' class='side-card' id='budgetbadge' aria-haspopup='dialog' title='" +
      esc(capped ? "Today's spend against the daily cap — click to change the cap" : "No daily cap — click to set one") + "'>" +
      "<span class='side-card-label'>" + icon("dollar") + "Spent today<span class='edit'>" + (capped ? "Edit cap" : "Set a cap") + "</span></span>" +
      "<span class='side-card-value'>" + esc(fmtUsd(b.spentUsd)) + " <small>" + esc(capped ? "of " + fmtCap(b.capUsd) : "no daily cap") + "</small></span>" +
      (capped ? meterBar(tone, pct.toFixed(1)) : "") + (b.capHitAt != null ? "<span class='side-card-value window-line'>~cap at " + esc(windowClock(b.capHitAt)) + "</span>" : "") + windowLinesHtml(blocks, only, chain) + "</button>";
  }
  function renderBudgetBadge(d) {
    if (budgetEditing) return; // the open editor owns the slot until save or cancel
    const b = d && d.budget;
    paintPanel("budgetwrap", b ? budgetCardHtml(b, d && d.subscriptionWindows, d && d.subscriptionOnly, d && d.chain) : "");
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
        "<p class='hint'>" + esc("Spent today: " + fmtUsd(b.spentUsd) + ". At the cap the roles " +
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
    // The two rejections are genuinely different rules, so they name their own one, mirroring
    // the TUI's parseBudgetInput: the shape rejection (a fine number like "1e2" or "0x10"
    // that is within the bound but that no one means as USD) names the plain-decimal rule,
    // while the bounds rejection names the bound because a 25-digit run IS "a number of 0 or
    // more". A single message would mislead: "1e2" is rejected as shape, yet would be told
    // it is not a number of 0 or more.
    if (!/^\d*\.?\d+$/.test(t)) {
      return {
        ok: false,
        error: "the cap must be a plain dollar amount like 25, 12.50, or .5 — no +/-, exponent, or hex notation — leave it empty for no cap",
      };
    }
    if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
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
    await postAction("/api/budget", { maxDailyCostUsd: value }, (d) => {
      if (d && d.unchanged) {
        return "Daily cap is already " + (value > 0 ? fmtCap(value) : "removed") + " — nothing saved";
      }
      return value > 0 ? "Daily cap set to " + fmtCap(value) : "Daily cap removed";
    });
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
  // How long a timed team pause has left (humanSeconds), or "" for a standing one.
  function pauseLeft(d) {
    return d.pausedUntil ? humanSeconds(secsUntil(d.pausedUntil, Date.now())) : "";
  }
  // The sidebar's pause control: Resume (with a timed pause's countdown) while the team is
  // paused, otherwise the button that opens the menu of timed pauses.
  function pauseControlHtml(d) {
    if (d.paused) {
      const left = pauseLeft(d);
      return "<button type='button' class='btn btn-warn' id='pausebadge' title='" + esc("The team is paused — click to resume it" + (d.pauseReason ? " (" + d.pauseReason + ")" : "")) + "'>" +
        icon("play") + "<span>Resume the team</span><span class='btn-note' id='pausenote'>" + (left ? esc(left) + " left" : "") + "</span></button>";
    }
    return "<button type='button' class='btn' id='pausebadge' aria-haspopup='menu' title='Pause the team — roles start no new runs'>" +
      icon("pause") + "<span>Pause the team</span><span class='btn-note'>" + icon("chev") + "</span></button>";
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
      html: "<div class='menu-title'>Pause the team</div>" +
        "<input type='text' id='pausereason' class='menu-input' maxlength=${PAUSE_REASON_MAX} placeholder='Reason (optional)' aria-label='Pause reason' style='margin:2px 10px 4px;width:calc(100% - 20px)'>" +
        PAUSE_CHOICES.map((c) => "<button type='button' class='menu-item' role='menuitem' data-pause='" + c[0] + "'>" +
          icon(c[0] ? "clock" : "pause") + esc(c[1]) + "</button>").join("") +
        "<p class='hint' style='margin:4px 10px 4px'>Current runs finish, and the director keeps running your messages.</p>",
      onClosed: () => {
        pauseMenuOpen = false;
        renderPauseBadge(lastStatus);
      },
    });
    pauseMenuOpen = true;
    const first = pop.querySelector("button");
    if (first) first.focus({ preventScroll: true });
  }
  async function setTeamPause(paused, forSeconds, reason) {
    const body = { paused: paused };
    if (paused && forSeconds > 0) body.forSeconds = forSeconds;
    const why = paused && reason ? String(reason).trim() : "";
    if (why) body.reason = why;
    // A failure changes nothing; the control still shows the real state.
    await postAction("/api/pause", body, paused
      ? "Team paused" + (forSeconds > 0 ? " for " + humanSeconds(forSeconds) : "") + " — current runs finish"
      : "Team resumed");
  }
  onClick((t, ev) => {
    if (t.closest("#pausebadge")) {
      ev.preventDefault();
      if (lastStatus && lastStatus.paused) setTeamPause(false);
      else if (pauseMenuOpen) closeMenus();
      else openPauseMenu();
      return;
    }
    const choice = t.closest("[data-pause]");
    if (choice) {
      const input = $("pausereason");
      setTeamPause(true, Number(choice.dataset.pause), input ? input.value : "");
    }
  });
  // pause-control:end

  // stop-control:start
  let stopMenuOpen = false;
  // The delays the menu offers for a scheduled graceful stop.
  const STOP_CHOICES = [[3600, "In 1 hour"], [7200, "In 2 hours"], [14400, "In 4 hours"], [28800, "In 8 hours"]];
  // The sidebar's scheduled-stop control: nothing while the team is stopped; Cancel while a
  // stop is scheduled; otherwise the button that opens the menu of delays. No immediate stop:
  // under run --gui it would take the page down mid-click.
  function stopControlHtml(d) {
    if (!d || !d.running) return "";
    if (d.scheduledStopAt) {
      return "<button type='button' class='btn btn-warn' id='stopbadge' title='A stop is scheduled — click to cancel it'>" +
        icon("stop") + "<span>Cancel scheduled stop</span></button>";
    }
    return "<button type='button' class='btn' id='stopbadge' aria-haspopup='menu' title='Stop the team later — current runs finish, then it stops'>" +
      icon("stop") + "<span>Stop the team later</span><span class='btn-note'>" + icon("chev") + "</span></button>";
  }
  function renderStopControl(d) {
    if (stopMenuOpen) return;
    paintPanel("stopwrap", stopControlHtml(d));
  }
  function openStopMenu() {
    const pop = openPopover("stopwrap", {
      menu: true,
      role: "menu",
      html: "<div class='menu-title'>Stop the team later</div>" +
        STOP_CHOICES.map((c) => "<button type='button' class='menu-item' role='menuitem' data-stopin='" + c[0] + "'>" +
          icon("clock") + esc(c[1]) + "</button>").join("") +
        "<p class='hint' style='margin:4px 10px 4px'>Current runs finish, then the team stops.</p>",
      onClosed: () => {
        stopMenuOpen = false;
        renderStopControl(lastStatus);
      },
    });
    stopMenuOpen = true;
    const first = pop.querySelector("button");
    if (first) first.focus({ preventScroll: true });
  }
  function postStopSchedule(body) {
    return postAction("/api/stop-schedule", body, (d) => d && typeof d.message === "string" ? d.message : "Stop schedule updated");
  }
  onClick((t, ev) => {
    if (t.closest("#stopbadge")) {
      ev.preventDefault();
      if (lastStatus && lastStatus.scheduledStopAt) postStopSchedule({ cancel: true });
      else if (stopMenuOpen) closeMenus();
      else openStopMenu();
      return;
    }
    const choice = t.closest("[data-stopin]");
    if (choice) postStopSchedule({ inSeconds: Number(choice.dataset.stopin) });
  });
  // stop-control:end
`;
