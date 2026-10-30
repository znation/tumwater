/** The dashboard role drawer's Configuration section, browser-side: what the role runs on and
 * carries, with the editors' open/closed rows, built from the same /api/role payload the CLI's
 * `tumwater role <id>` renders. Split from gui-client-drawer.ts, which owns the drawer's
 * open/close, the role and entry bodies, and the editing state this section reads. Spliced into
 * gui-client.ts's script straight after the drawer, reaching its helpers (esc, kvRow, the
 * *Editing state) through that concatenation. */
export const GUI_CLIENT_DRAWER_CONFIG_JS = String.raw`
  // A Configuration section built from the same /api/role payload the CLI's tumwater role
  // <id> renders (rolePayload), so the drawer's and the terminal's rows read one document and
  // cannot drift: what the role RUNS ON (model/tier, image reading, the
  // fallback pairs, billing, min run interval) and CARRIES (queued prompts, the instructions
  // override, find text). Each row is guarded by a present/own check so an absent field
  // renders no row — no fallback shows no fallback rows, and a notes-only payload adds an
  // empty (omitted) section. Labels and wording mirror
  // role-render.ts's family; no backticks allowed here (this whole script is one big
  // String.raw template).
  function drawerConfigHtml(view, role) {
    const pair = (p, m) => [p, m].filter(Boolean).join("/");
    // A fallback pair's label, mirroring role-render.ts's fallbackPairLabel so the drawer's
    // Budget fallback row names a non-pi backend's namespace the same way the CLI's fallback
    // lines do: a non-pi backend with a model reads <backend>/<model>, else <provider>/<model>,
    // else the model, else the provider, else the pair-less default. A budget pair's provider
    // already holds the backend, so its row stays byte-identical.
    // Local wall-clock HH:MM for the role-cap forecast's ~cap at stamp — the drawer is browser
    // code and cannot import ../text/datetime.js (the quietWindowEnd precedent's own note), so
    // it routes through the bundle's shared clockHm in FORMAT_JS, the same helper the operator
    // view's window clock uses.
    const fallbackLabel = (fb, fbDefault) => {
      const agentBackend = fb.backend !== undefined && fb.backend !== "pi" ? fb.backend : undefined;
      if (fb.model !== undefined) {
        if (agentBackend !== undefined) return agentBackend + "/" + fb.model;
        return fb.provider !== undefined ? fb.provider + "/" + fb.model : fb.model;
      }
      if (fb.provider !== undefined) return fb.provider;
      return fbDefault;
    };
    // A verbatim value's single-line clamped rendering (80 chars + ellipsis) with the full
    // text riding the title tooltip — the same clamp+tooltip idiom the run summaries use.
    // The single-line squash rides the shared format-region squash (text.ts's browser twin).
    const clamp = (t) => { const one = squash(t); return one.length > 80 ? one.slice(0, 80) + "…" : one; };
    const rows = [];
    // A role that runs on pi's own saved default carries no provider/model but a piDefault
    // selector (rolePayload's resolvedModelFields leaves both undefined), and the CLI's
    // Model line names that default (<agent> default (<selector>), backendDefault). Mirror
    // that branch so the drawer names the model a default pi team actually runs on.
    const agentLabel = view.backend && view.backend !== "pi" ? view.backend : "pi";
    const defaultLine = typeof view.piDefault === "string"
      ? agentLabel + " default (" + view.piDefault + ")"
      : "";
    // A seam that resolves neither half (an opencode role with no model, a pi role with no
    // readable default) names the backend default. Gated on a tier so a role with neither
    // model nor tier still omits the row entirely (the guard below stays the sole decider
    // for the wholly-absent case), matching role-render.ts's backendDefault no-pair branch.
    // The resolved thinking level the role runs at (rolePayload's thinking): the drawer's
    // Model row names it exactly as role-render.ts's Model line does, so the two surfaces
    // agree. Guarded on defaultLine being empty (a piDefault selector already embeds the
    // winning level, so appending would duplicate it), mirroring role-render.ts's guard.
    const thinking = defaultLine === "" && typeof view.thinking === "string" && view.thinking !== "" ? " (thinking: " + view.thinking + ")" : "";
    const modelLine = defaultLine !== "" ? defaultLine : (pair(view.provider, view.model) || (view.modelTier !== undefined ? agentLabel + " default" : ""));
    if (modelLine !== "" || view.modelTier !== undefined) {
      rows.push(kvRow("Model", (modelLine !== "" ? modelLine + thinking + " " : "") + (view.modelTier !== undefined ? "(" + view.modelTier + " tier)" : "").trim()));
    }
    // The per-role model set (roles.<base>.provider/.model/.thinking/.backend, the file's own
    // raw overrides rolePayload's providerOverride/modelOverride/thinkingOverride/backendOverride
    // carry) — the one per-role write the Model row above still renders read-only, the
    // dashboard half of the CLI's --provider/--model/--thinking/--backend. An always-shown row
    // (every role, the director included, since the CLI writes its set too) whose body names
    // the payload's raw overrides, or no overrides, and whose control is a model-edit button
    // (Edit/Set model); while the editor is open for this role, four text inputs prefilled
    // with the raw overrides (empty when unset) plus Save/Discard replace the body, mirroring
    // the interval editor's markup.
    const rawTriple = [];
    if (typeof view.providerOverride === "string" && view.providerOverride !== "") rawTriple.push("provider: " + view.providerOverride);
    if (typeof view.modelOverride === "string" && view.modelOverride !== "") rawTriple.push("model: " + view.modelOverride);
    if (typeof view.thinkingOverride === "string" && view.thinkingOverride !== "") rawTriple.push("thinking: " + view.thinkingOverride);
    if (typeof view.backendOverride === "string" && view.backendOverride !== "") rawTriple.push("backend: " + view.backendOverride);
    const modelBody = rawTriple.length ? rawTriple.join(" · ") : "no overrides";
    const editModel = modelEditing && modelEditing.role === role;
    const modelControl = editModel
      ? "<input id='modeleditprovider' type='text' placeholder='provider' value='" + esc(modelEditing.provider) + "'>" +
        "<input id='modeleditmodel' type='text' placeholder='model' value='" + esc(modelEditing.model) + "'>" +
        "<input id='modeleditthinking' type='text' placeholder='thinking' value='" + esc(modelEditing.thinking) + "'>" +
        "<input id='modeleditbackend' type='text' placeholder='backend' value='" + esc(modelEditing.backend) + "'>" +
        "<div><button type='button' class='btn btn-sm btn-primary' data-act='model-save' data-arg='" + esc(role) + "'>Save</button> " +
        "<button type='button' class='btn btn-sm' data-act='model-discard' data-arg='" + esc(role) + "'>Discard</button></div>"
      : "<button type='button' class='btn btn-sm' data-act='model-edit' data-arg='" + esc(role) + "'>" + (rawTriple.length ? "Edit" : "Set model") + "</button>";
    rows.push("<div><dt>Model overrides</dt><dd title='" + esc(modelBody) + "'>" + esc(modelBody) + modelControl + "</dd></div>");
    // Context window: the resolved primary seam's declared window - the same seam '- Next run:'
    // previews. Guard optional to keep an older payload that lacks the field rendering as before.
    if (view.contextWindow !== undefined) {
      rows.push(kvRow("Context window", view.contextWindow === null ? "unknown" : fmtTokens(view.contextWindow) + " tokens"));
    }
    if (view.imageInput !== undefined) {
      const images = view.imageInput === true ? "yes"
        : view.imageInput === false ? (view.imageReroute ? "no — reruns on " + view.imageReroute : "no")
        : "unknown";
      rows.push(kvRow("Images", images));
    }
    if (view.fallback && typeof view.fallback === "object" && view.fallback.model !== undefined) {
      rows.push(kvRow("Budget fallback", fallbackLabel(view.fallback, "") + " (" + (view.fallbackFree ? "free" : "priced") + ")"));
    }
    if (view.billing !== undefined) {
      rows.push(kvRow("Billing", view.billing === "api" ? "API" : view.billing));
    }
    // The min run interval (rolePayload's minRunIntervalSeconds), worded like role-render.ts's
    // Min run interval line, plus a control to set/clear the per-role override — the last
    // per-role hold the drawer edits. Shown whenever the payload names an interval (always —
    // the effective value is the role's override or the team default); the body tags whether
    // the shown value is the role's own override or the team default. While the editor is open
    // for this role, an input prefilled with the override (empty when none) and Save/Discard
    // replace the sentence, mirroring the daily-cap editor's markup; a role with no override
    // still seeds an empty input, so an empty buffer on Save clears.
    if (typeof view.minRunIntervalSeconds === "number") {
      const editing = intervalEditing && intervalEditing.role === role;
      const intervalBody = String(view.minRunIntervalSeconds) + "s" +
        (typeof view.minRunIntervalOverride === "number" ? " (override)" : " (team default)");
      const seed = intervalEditing ? intervalEditing.value : null;
      const intervalControl = editing
        ? "<input id='intervaleditinput' type='number' min='0' step='1' value='" + (seed === "" || seed == null ? "" : String(seed)) + "' placeholder='team default'>" +
          "<div><button type='button' class='btn btn-sm btn-primary' data-act='interval-save' data-arg='" + esc(role) + "'>Save</button> " +
          "<button type='button' class='btn btn-sm' data-act='interval-discard' data-arg='" + esc(role) + "'>Discard</button></div>"
        : "<button type='button' class='btn btn-sm' data-act='interval-edit' data-arg='" + esc(role) + "'>" + (typeof view.minRunIntervalOverride === "number" ? "Edit" : "Set interval") + "</button>";
      rows.push("<div><dt>Min run interval</dt><dd title='" + esc(intervalBody) + "'>" + esc(intervalBody) + intervalControl + "</dd></div>");
    }
    // The parallel-runner count (roles.<base>.instances), worded like role-render.ts's
    // Instances line — the last per-role hold the drawer edits. Rendered only for a role that
    // may split (its base, an instance strip, is feature or bugfix): the count is meaningless
    // for any other role, which role-view never carries. The body reads the payload's numeric
    // count (roles.<base>.instances) tagged (set) or falls back to 1 tagged (default) when the
    // file leaves it unset — role-view carries instances only when the file sets it. While the
    // editor is open for this role, an input prefilled with the count (empty when none) and
    // Save/Discard
    // replace the sentence, mirroring the interval editor's markup; a role with no count still
    // seeds an empty input, so an empty buffer on Save clears.
    const splitBase = role.replace(/-\d+$/, "");
    if (splitBase === "feature" || splitBase === "bugfix") {
      const hasInstances = typeof view.instances === "number";
      const instCount = hasInstances ? view.instances : 1;
      const instBody = String(instCount) + (hasInstances ? " (set)" : " (default)");
      const editingInst = instancesEditing && instancesEditing.role === role;
      const seed = instancesEditing ? instancesEditing.value : null;
      const instControl = editingInst
        ? "<input id='instanceseditinput' type='number' min='1' max='8' step='1' value='" + (seed === "" || seed == null ? "" : String(seed)) + "' placeholder='default 1'>" +
          "<div><button type='button' class='btn btn-sm btn-primary' data-act='instances-save' data-arg='" + esc(role) + "'>Save</button> " +
          "<button type='button' class='btn btn-sm' data-act='instances-discard' data-arg='" + esc(role) + "'>Discard</button></div>"
        : "<button type='button' class='btn btn-sm' data-act='instances-edit' data-arg='" + esc(role) + "'>" + (hasInstances ? "Edit" : "Set instances") + "</button>";
      rows.push("<div><dt>Instances</dt><dd title='" + esc(instBody) + "'>" + esc(instBody) + instControl + "</dd></div>");
    }
    // The windows governing the role, worded like role-render.ts's Quiet hours line; the end time
    // mirrors quietWindowEnd (browser code cannot import it). A non-director role's own window
    // is an always-shown editable row (the Daily cap row's rationale: the control sits where
    // the hold is shown) — including when the payload carries no role-scope window ("no own
    // window"); any other window stays a read-only row worded exactly as before ("team window").
    const own = Array.isArray(view.quietHours) ? view.quietHours.find(function (w) { return w && w.scope === "role"; }) : undefined;
    const ownWindow = own && typeof own.window === "string" ? own.window : "";
    if (role !== "director") {
      const ownEnd = String(ownWindow).split("-")[1];
      const ownState = own && own.inWindow
        ? "holding now — quiet until " + (ownEnd ? ownEnd.trim() : "")
        : "not holding now";
      const editQuiet = quietEditing && quietEditing.role === role;
      const quietBody = ownWindow !== "" ? ownWindow + " (own window; " + ownState + ")" : "no own window";
      const quietControl = editQuiet
        ? "<input id='quieteditinput' type='text' placeholder='23:00-07:00' value='" + esc(quietEditing.window) + "'>" +
          "<div><button type='button' class='btn btn-sm btn-primary' data-act='quiet-save' data-arg='" + esc(role) + "'>Save</button> " +
          "<button type='button' class='btn btn-sm' data-act='quiet-discard' data-arg='" + esc(role) + "'>Discard</button></div>"
        : "<button type='button' class='btn btn-sm' data-act='quiet-edit' data-arg='" + esc(role) + "'>" + (ownWindow !== "" ? "Edit" : "Set quiet hours") + "</button>";
      rows.push("<div><dt>Quiet hours</dt><dd title='" + esc(quietBody) + "'>" + esc(quietBody) + quietControl + "</dd></div>");
    }
    if (Array.isArray(view.quietHours)) view.quietHours.forEach(function (w) {
      if (!w || w.scope === "role" || typeof w.window !== "string") return;
      const end = String(w.window).split("-")[1];
      const state = w.inWindow ? "holding now — quiet until " + (end ? end.trim() : "") : "not holding now";
      rows.push(kvRow("Quiet hours", w.window + " (team window; " + state + ")"));
    });
    if (typeof view.inboxCount === "number") rows.push(kvRow("Queued prompts", String(view.inboxCount)));
    // The role's own spend over its retained event window (rolePayload's usage, summed from the
    // same run_end events recentOutcomes reads): how much the role burned on tokens and cost,
    // with a notional suffix only when a claude-subscription seam burned non-zero notional spend
    // — mirroring role-render.ts's Spend line, so the drawer and tumwater role <id> read one
    // role's spend identically. Each numeric field is coerced (foreign shapes read as 0) and an
    // all-zero usage is absent on the payload, so this row never renders for a never-costly role.
    if (view.usage && typeof view.usage === "object") {
      const u = view.usage;
      const real = Number(u.costUsd) || 0;
      const tokens = Number(u.tokens) || 0;
      const notional = Number(u.notionalCostUsd) || 0;
      let spend = fmtUsd(real) + " · " + fmtTokens(tokens) + " tokens";
      if (notional !== 0) spend += " · " + fmtUsd(notional) + " notional";
      rows.push(kvRow("Spend", spend));
    }
    // The per-role daily cap (rolePayload's dailyCap), worded like role-render.ts's Daily cap line.
    // The per-role daily cap (rolePayload's dailyCap), worded like role-render.ts's Daily cap
    // line. Shown for every non-director role — always, cap or not — because the "Set a cap"/
    // "Edit cap" control is the end of the amber role-cap alert's path: the alert's remedy
    // leads here. A director shows no row (role-view.ts's guard exempts it from a cap). While
    // the cap editor is open for this role, an input prefilled with the current cap (empty for
    // none) and Save/Discard replace the sentence, mirroring the notes editor's markup.
    if (role !== "director") {
      const dc = view.dailyCap && typeof view.dailyCap === "object" ? view.dailyCap : null;
      const editing = capEditing && capEditing.role === role;
      const capBody = dc
        ? fmtUsd(Number(dc.spentUsd) || 0) + " of " + fmtUsd(Number(dc.capUsd) || 0) + " spent today (" + (dc.over ? "holding now — no new runs until local midnight" : "not holding") + ")" +
          (Array.isArray(dc.roleIds) && dc.roleIds.length > 1 ? " · shared by " + dc.roleIds.join(", ") : "") +
          (typeof view.dailyCapHitAt === "number" ? " · ~cap at " + clockHm(view.dailyCapHitAt) : "")
        : "no cap";
      const capControl = editing
        ? "<input id='capeditinput' type='number' min='0' step='0.01' value='" + (capEditing.value ? String(capEditing.value) : "") + "' placeholder='no cap'>" +
          "<div><button type='button' class='btn btn-sm btn-primary' data-act='cap-save' data-arg='" + esc(role) + "'>Save</button> " +
          "<button type='button' class='btn btn-sm' data-act='cap-discard' data-arg='" + esc(role) + "'>Discard</button></div>"
        : "<button type='button' class='btn btn-sm' data-act='cap-edit' data-arg='" + esc(role) + "'>" + (dc ? "Edit cap" : "Set a cap") + "</button>";
      rows.push("<div><dt>Daily cap</dt><dd title='" + esc(capBody) + "'>" + esc(capBody) + capControl + "</dd></div>");
    }
    // The standing instructions (roles.<base>.instructions, resolved through the base role),
    // worded like role-render.ts's Instructions override. Shown for every role — always,
    // override or not — because the Edit/Save control is how the director's and instance
    // runs' instructions get written from the dashboard: the same always-shown rationale as
    // the Daily cap row above. While the editor is open for this role, a textarea prefilled
    // with the current text and Save/Discard replace the sentence, mirroring the notes
    // editor's markup; a role with no override still seeds an empty textarea, so an empty
    // buffer on Save clears.
    const instEditing = instructionsEditing && instructionsEditing.role === role;
    const instText = typeof view.instructions === "string" ? view.instructions : "";
    const instBody = instText.trim() !== "" ? clamp(instText) : "No standing instructions.";
    const instControl = instEditing
      ? "<textarea id='instructionsedittext' rows='10' class='mono' style='width:100%'>" + esc(instructionsEditing.text) + "</textarea>" +
        "<div><button type='button' class='btn btn-sm btn-primary' data-act='instructions-save' data-arg='" + esc(role) + "'>Save</button> " +
        "<button type='button' class='btn btn-sm' data-act='instructions-discard' data-arg='" + esc(role) + "'>Discard</button></div>"
      : "<button type='button' class='btn btn-sm' data-act='instructions-edit' data-arg='" + esc(role) + "'>Edit</button>";
    rows.push("<div><dt>Instructions override</dt><dd title='" + esc(instText) + "'>" + esc(instBody) + instControl + "</dd></div>");
    if (typeof view.find === "string" && view.find.trim() !== "") rows.push(kvRow("Find text", clamp(view.find), view.find));
    return rows.length ? "<section><div class='sec-head'><h3>Configuration</h3></div><dl class='kv'>" + rows.join("") + "</dl></section>" : "";
  }
`;
