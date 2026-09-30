/** The dashboard's stylesheet, inlined into the page shell (gui-page.ts) as its only <style>.
 * A small neutral design system of tumwater's own: the platform's UI and monospace fonts, a
 * neutral gray scale, flat surfaces with hairline borders, and one accent — teal, for water —
 * for the primary action, links, focus, and progress. Status reads through a fixed set of
 * tones (blue working, violet reviewing, orange landing, green landed, amber held, red broken,
 * gray idle) that every chip, pill, and alert shares. Every color is a token on :root,
 * redefined for dark mode both for the OS preference (unless the viewer chose light) and for
 * an explicit `data-theme="dark"`, so the page follows the system until the theme toggle
 * picks a side. Nothing is fetched: the page makes no request off its own server. */

// The dark palette, shared by the prefers-color-scheme block and the explicit data-theme one.
const DARK_TOKENS = String.raw`
    color-scheme: dark;
    --bg: #0b0b0d;
    --surface: #131316;
    --surface-2: #18181b;
    --surface-3: #202024;
    --raised: #1a1a1e;
    --line: #27272a;
    --line-soft: #1f1f23;
    --text: #f4f4f5;
    --text-2: #d4d4d8;
    --text-3: #a1a1aa;
    --text-4: #71717a;
    --accent: #2dd4bf;
    --accent-bg: rgba(20, 184, 166, 0.12);
    --primary: #14b8a6;
    --primary-hover: #2dd4bf;
    --on-primary: #042f2e;
    --invert: #f4f4f5;
    --on-invert: #18181b;
    --focus: rgba(45, 212, 191, 0.55);
    --scrim: rgba(0, 0, 0, 0.55);
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
    --shadow-lg: 0 24px 48px -12px rgba(0, 0, 0, 0.7);
    --blue: #60a5fa; --blue-bg: rgba(59, 130, 246, 0.12); --blue-line: rgba(59, 130, 246, 0.32);
    --violet: #a78bfa; --violet-bg: rgba(139, 92, 246, 0.13); --violet-line: rgba(139, 92, 246, 0.34);
    --indigo: #818cf8; --indigo-bg: rgba(99, 102, 241, 0.13); --indigo-line: rgba(99, 102, 241, 0.34);
    --green: #4ade80; --green-bg: rgba(34, 197, 94, 0.11); --green-line: rgba(34, 197, 94, 0.3);
    --amber: #fbbf24; --amber-bg: rgba(245, 158, 11, 0.12); --amber-line: rgba(245, 158, 11, 0.34);
    --orange: #fb923c; --orange-bg: rgba(249, 115, 22, 0.12); --orange-line: rgba(249, 115, 22, 0.34);
    --red: #f87171; --red-bg: rgba(239, 68, 68, 0.12); --red-line: rgba(239, 68, 68, 0.34);
    --gray: #a1a1aa; --gray-bg: rgba(161, 161, 170, 0.1); --gray-line: rgba(161, 161, 170, 0.24);
`;

export const GUI_STYLES = String.raw`
  :root {
    color-scheme: light;
    --font-sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial,
      "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
    --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    --bg: #f6f6f7;
    --surface: #ffffff;
    --surface-2: #fafafa;
    --surface-3: #f1f1f3;
    --raised: #ffffff;
    --line: #e4e4e7;
    --line-soft: #efeff1;
    --text: #18181b;
    --text-2: #3f3f46;
    --text-3: #71717a;
    --text-4: #a1a1aa;
    --accent: #0f766e;
    --accent-bg: #f0fdfa;
    --primary: #0d9488;
    --primary-hover: #0f766e;
    --on-primary: #ffffff;
    --invert: #18181b;
    --on-invert: #fafafa;
    --focus: rgba(13, 148, 136, 0.45);
    --scrim: rgba(24, 24, 27, 0.3);
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04);
    --shadow-lg: 0 24px 48px -12px rgba(0, 0, 0, 0.2);
    --blue: #2563eb; --blue-bg: #eff6ff; --blue-line: #bfdbfe;
    --violet: #7c3aed; --violet-bg: #f5f3ff; --violet-line: #ddd6fe;
    --indigo: #4f46e5; --indigo-bg: #eef2ff; --indigo-line: #c7d2fe;
    --green: #15803d; --green-bg: #f0fdf4; --green-line: #bbf7d0;
    --amber: #b45309; --amber-bg: #fffbeb; --amber-line: #fde68a;
    --orange: #c2410c; --orange-bg: #fff7ed; --orange-line: #fed7aa;
    --red: #dc2626; --red-bg: #fef2f2; --red-line: #fecaca;
    --gray: #52525b; --gray-bg: #f4f4f5; --gray-line: #e4e4e7;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {${DARK_TOKENS}}
  }
  :root[data-theme="dark"] {${DARK_TOKENS}}

  /* Tones: one class picks a status color; components read --t / --t-bg / --t-line. */
  .t-blue { --t: var(--blue); --t-bg: var(--blue-bg); --t-line: var(--blue-line); }
  .t-violet { --t: var(--violet); --t-bg: var(--violet-bg); --t-line: var(--violet-line); }
  .t-indigo { --t: var(--indigo); --t-bg: var(--indigo-bg); --t-line: var(--indigo-line); }
  .t-green { --t: var(--green); --t-bg: var(--green-bg); --t-line: var(--green-line); }
  .t-amber { --t: var(--amber); --t-bg: var(--amber-bg); --t-line: var(--amber-line); }
  .t-orange { --t: var(--orange); --t-bg: var(--orange-bg); --t-line: var(--orange-line); }
  .t-red { --t: var(--red); --t-bg: var(--red-bg); --t-line: var(--red-line); }
  .t-gray { --t: var(--gray); --t-bg: var(--gray-bg); --t-line: var(--gray-line); }

  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 var(--font-sans);
         -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
  button, input, select, textarea { font: inherit; color: inherit; }
  a { color: inherit; }
  svg.i { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.8;
          stroke-linecap: round; stroke-linejoin: round; }
  [hidden] { display: none !important; }
  .mono { font-family: var(--font-mono); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: var(--text-3); }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
             clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .skip { position: absolute; left: 12px; top: -48px; z-index: 100; padding: 8px 12px; border-radius: 8px;
          background: var(--invert); color: var(--on-invert); }
  .skip:focus { top: 12px; }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .spacer { flex: 1; }

  /* ---- shell: the sidebar (project, fleet status, views, fleet controls) beside the main column ---- */
  .shell { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100vh; }
  .sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 18px; padding: 16px 12px;
             border-right: 1px solid var(--line); background: var(--surface); overflow-y: auto; }
  .side-top { display: flex; align-items: center; justify-content: space-between; padding: 0 4px 0 6px; }
  .brand { display: inline-flex; align-items: center; gap: 9px; text-decoration: none; font-size: 15.5px; font-weight: 650;
           letter-spacing: -0.01em; }
  .logo { width: 26px; height: 26px; flex: none; }
  .side-label { padding: 0 8px; font-size: 11.5px; font-weight: 600; color: var(--text-4); }
  .side-project { display: flex; flex-direction: column; gap: 4px; padding: 12px 0 14px; border-top: 1px solid var(--line-soft);
                  border-bottom: 1px solid var(--line-soft); }
  .project { padding: 0 8px; font-weight: 600; font-size: 14.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .side-status { display: flex; flex-direction: column; gap: 2px; padding: 4px 0 0; }
  .side-status .row { display: flex; align-items: center; flex-wrap: wrap; gap: 0 8px; padding: 3px 8px; border-radius: 6px; font-size: 13px;
                      color: var(--t, var(--text-3)); overflow-wrap: anywhere; }
  .side-status .row .dot, .side-status .row svg.i { flex: none; }
  .side-status .row svg.i { width: 14px; height: 14px; }
  .side-status .row .mono { font-size: 12px; }
  .side-status .row.rowclickable { cursor: pointer; }
  .side-nav { display: flex; flex-direction: column; gap: 2px; }
  .tab { display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 10px; border-radius: 8px;
         color: var(--text-2); text-decoration: none; font-weight: 500; white-space: nowrap; }
  .tab svg.i { color: var(--text-4); }
  .tab:hover { color: var(--text); background: var(--surface-3); }
  .tab.active { color: var(--text); background: var(--accent-bg); font-weight: 600; }
  .tab.active svg.i { color: var(--accent); }
  .tab .badge { margin-left: auto; }
  .side-controls { margin-top: auto; display: flex; flex-direction: column; gap: 8px; }
  .side-card { display: block; width: 100%; padding: 11px 12px; border: 1px solid var(--line); border-radius: 10px;
               background: var(--surface-2); text-align: left; color: inherit; }
  button.side-card { cursor: pointer; }
  button.side-card:hover { border-color: var(--text-4); }
  .side-card-label { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--text-3); }
  .side-card-label svg.i { width: 14px; height: 14px; }
  .side-card-label .edit { margin-left: auto; color: var(--accent); font-weight: 600; }
  .side-card-value { display: block; margin-top: 3px; font-size: 18px; font-weight: 650; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
  .side-card-value small { font-size: 12.5px; font-weight: 500; letter-spacing: 0; color: var(--text-3); }
  .side-controls .btn { width: 100%; justify-content: flex-start; }
  .side-controls .btn .btn-note { margin-left: auto; }
  .menu-anchor.up .popover { top: auto; bottom: calc(100% + 8px); left: 0; right: auto; width: 100%; min-width: 0; }

  /* ---- chips, pills, tags, badges ---- */
  .chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border-radius: 999px;
          border: 1px solid var(--t-line, var(--line)); background: var(--t-bg, var(--surface)); color: var(--t, var(--text-2));
          font-size: 13px; font-weight: 500; white-space: nowrap; }
  .chip.mono { font-size: 12px; font-weight: 500; }
  .pill { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 999px;
          background: var(--t-bg); color: var(--t); font-size: 12px; font-weight: 600; white-space: nowrap; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
  .dot.live { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 45%, transparent); }
                     50% { box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 0%, transparent); } }
  .tag { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; font-size: 11.5px; font-weight: 500;
         background: var(--t-bg, var(--surface-3)); color: var(--t, var(--text-3)); white-space: nowrap; }
  .badge { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 18px; padding: 0 6px;
           border-radius: 999px; background: var(--t-bg, var(--surface-3)); color: var(--t, var(--text-3)); font-size: 11.5px;
           font-weight: 600; font-variant-numeric: tabular-nums; }
  .res { color: var(--t); font-weight: 600; white-space: nowrap; }
  .chip svg.i, .btn svg.i, .stat-label svg.i, .menu-item svg.i { width: 15px; height: 15px; }
  .tag svg.i { width: 12px; height: 12px; margin-right: 3px; }

  /* ---- buttons ---- */
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px;
         border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--text-2);
         font-weight: 500; cursor: pointer; white-space: nowrap; text-decoration: none; box-shadow: var(--shadow-sm); }
  .btn:hover { background: var(--surface-2); color: var(--text); border-color: var(--text-4); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-sm { height: 28px; padding: 0 10px; font-size: 13px; }
  .btn-primary { background: var(--primary); color: var(--on-primary); border-color: transparent; }
  .btn-primary:hover { background: var(--primary-hover); color: var(--on-primary); border-color: transparent; }
  .btn-warn { background: var(--amber-bg); color: var(--amber); border-color: var(--amber-line); }
  .btn-warn:hover { background: var(--amber-bg); color: var(--amber); border-color: var(--amber); }
  .btn-danger { color: var(--red); }
  .btn-note { font-weight: 400; opacity: 0.85; }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0;
              border-radius: 7px; border: 1px solid transparent; background: none; color: var(--text-3); cursor: pointer; }
  .icon-btn:hover { background: var(--surface-3); color: var(--text); }
  .icon-btn.confirming { width: auto; padding: 0 8px; gap: 5px; color: var(--red); background: var(--red-bg);
                         border-color: var(--red-line); font-size: 12px; font-weight: 600; }
  .icon-btn.danger:hover { color: var(--red); background: var(--red-bg); }
  .linkish { padding: 0; border: 0; background: none; cursor: pointer; text-align: left; }
  .linkish:hover { color: var(--accent); }
  .theme-sun { display: none; }
  :root[data-theme="dark"] .theme-sun { display: block; }
  :root[data-theme="dark"] .theme-moon { display: none; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .theme-sun { display: block; }
    :root:not([data-theme="light"]) .theme-moon { display: none; }
  }

  /* ---- menus and popovers ---- */
  .menu-anchor { position: relative; }
  .popover { position: absolute; top: calc(100% + 8px); right: 0; z-index: 40; min-width: 260px; padding: 14px;
             border: 1px solid var(--line); border-radius: 12px; background: var(--raised); box-shadow: var(--shadow-lg); }
  .popover.menu { padding: 6px; min-width: 220px; }
  .popover label { display: block; font-weight: 600; margin-bottom: 6px; }
  .popover .hint { margin: 8px 0 0; font-size: 12.5px; color: var(--text-3); }
  .popover-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .menu-title { padding: 6px 10px 4px; font-size: 12px; font-weight: 600; color: var(--text-3); }
  .menu-item { display: flex; width: 100%; align-items: center; gap: 8px; padding: 7px 10px; border: 0; border-radius: 7px;
               background: none; text-align: left; cursor: pointer; color: var(--text-2); }
  .menu-item:hover, .menu-item:focus-visible { background: var(--surface-3); color: var(--text); }
  .input-prefix { display: flex; align-items: center; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
  .input-prefix:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px var(--accent-bg); }
  .input-prefix span { padding: 0 2px 0 10px; color: var(--text-3); }
  .input-prefix input { flex: 1; min-width: 0; height: 34px; border: 0; background: none; padding: 0 10px 0 4px; outline: none; }
  select.field { height: 32px; border: 1px solid var(--line); border-radius: 8px; background-color: var(--surface); padding: 0 28px 0 10px;
                 color: var(--text-2); appearance: none; cursor: pointer; background-repeat: no-repeat;
                 background-image: linear-gradient(45deg, transparent 50%, var(--text-3) 50%), linear-gradient(-45deg, transparent 50%, var(--text-3) 50%);
                 background-size: 5px 5px, 5px 5px; background-position: right 14px center, right 9px center; }

  /* ---- main column ---- */
  .main { min-width: 0; padding: 24px 28px 72px; max-width: 1480px; }
  .alerts { display: grid; gap: 8px; }
  .alerts:empty { display: none; }
  .alert { display: flex; align-items: flex-start; gap: 12px; padding: 11px 14px; border-radius: 10px;
           border: 1px solid var(--t-line); background: var(--t-bg); }
  .alert-icon { color: var(--t); padding-top: 1px; }
  .alert-body { flex: 1; min-width: 0; }
  .alert-title { font-weight: 600; color: var(--text); }
  .alert-detail { color: var(--text-2); font-size: 13.5px; overflow-wrap: anywhere; }
  .alert-actions { display: flex; flex-wrap: wrap; gap: 6px; align-self: center; }

  /* ---- composer: the director prompt (or one loop's), always in reach ---- */
  .composer { padding: 8px; border: 1px solid var(--line); border-radius: 12px;
              background: var(--surface); box-shadow: var(--shadow-sm); }
  .composer:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px var(--accent-bg); }
  .composer-row { display: flex; align-items: flex-end; gap: 8px; }
  .composer-target select { height: 34px; max-width: 190px; background-color: var(--surface-2); font-weight: 600; color: var(--text); }
  .composer textarea { flex: 1; min-width: 0; min-height: 34px; max-height: 40vh; resize: none; border: 0; outline: none;
                       background: none; padding: 6px 4px; line-height: 1.45; font-size: 14.5px; }
  .composer textarea::placeholder { color: var(--text-4); }
  .composer .btn-primary { height: 34px; }
  .composer.dragover { border-color: var(--primary); background: var(--accent-bg); }
  #promptimages { padding: 6px 4px 0; }
  #promptimages .chip { font-size: 12px; }
  #promptimages .chip .dim { color: var(--text-3); }
  #promptimages .chip button { border: 0; background: none; color: var(--text-3); cursor: pointer; font-size: 14px;
                               line-height: 1; padding: 0 2px; }
  #promptimages .chip button:hover { color: var(--text); }
  .composer-foot { display: flex; align-items: center; gap: 12px; padding: 4px 4px 0; font-size: 12.5px; color: var(--text-3); }
  .composer-meta { display: inline-flex; gap: 12px; margin-left: auto; white-space: nowrap; }
  .composer-meta a { color: var(--accent); text-decoration: none; font-weight: 600; }
  kbd { font-family: var(--font-mono); font-size: 11px; padding: 1px 5px; border-radius: 4px; border: 1px solid var(--line);
        background: var(--surface-2); color: var(--text-3); }

  /* ---- stat tiles ---- */
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  .stats.six { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .stat { position: relative; display: block; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px;
          background: var(--surface); box-shadow: var(--shadow-sm); text-align: left; min-width: 0; }
  button.stat { cursor: pointer; font: inherit; color: inherit; width: 100%; }
  button.stat:hover { border-color: var(--text-4); }
  .stat-label { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 500; color: var(--text-3); }
  .stat-label svg.i { color: var(--accent); }
  .stat-value { display: block; margin-top: 4px; font-size: 24px; line-height: 1.2; font-weight: 650; letter-spacing: -0.02em;
                font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stat-value small { font-size: 13.5px; font-weight: 500; letter-spacing: 0; color: var(--text-3); }
  .stat-sub { display: block; margin-top: 2px; font-size: 12.5px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meter { display: block; height: 5px; margin-top: 9px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
  .meter > span { display: block; height: 100%; border-radius: inherit; background: var(--primary); }
  .meter.t-red > span, .meter.t-amber > span { background: var(--t); }

  /* ---- cards ---- */
  .card { border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow-sm); min-width: 0; }
  .card-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 10px 16px; min-height: 50px;
               border-bottom: 1px solid var(--line); }
  .card-head h2 { margin: 0; font-size: 14.5px; font-weight: 650; }
  .grid-2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr); gap: 20px; align-items: start; }
  .grid-2.even { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; }
  .seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: 9px; background: var(--surface-3); }
  .seg button { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border: 0; border-radius: 7px;
                background: none; color: var(--text-3); font-size: 13px; font-weight: 500; cursor: pointer; white-space: nowrap; }
  .seg button:hover { color: var(--text); }
  .seg button.active { background: var(--surface); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }

  /* ---- tables ---- */
  .table-wrap { overflow-x: auto; }
  table.table { width: 100%; border-collapse: separate; border-spacing: 0; }
  .table th { padding: 8px 12px; text-align: left; font-size: 12px; font-weight: 600; color: var(--text-3);
              background: var(--surface-2); border-bottom: 1px solid var(--line); white-space: nowrap; }
  .table td { padding: 10px 12px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
  .table th.num, .table td.num { text-align: right; }
  .table tbody tr:last-child td { border-bottom: 0; }
  .table th:first-child, .table td:first-child { padding-left: 16px; }
  .table th:last-child, .table td:last-child { padding-right: 16px; }
  .table tr.clickable { cursor: pointer; }
  .table tr.clickable:hover td { background: var(--surface-2); }
  .table tr.group td { padding: 6px 16px; background: var(--surface-2); border-bottom: 1px solid var(--line-soft);
                       font-size: 12px; font-weight: 600; color: var(--text-3); }
  .table tr.group:not(:first-child) td { border-top: 1px solid var(--line); }
  .table tr.group .badge { margin-left: 6px; }
  .sub { margin-top: 3px; font-size: 12.5px; color: var(--text-3); overflow-wrap: anywhere; }
  .sub.t-red, .sub.t-amber { color: var(--t); font-weight: 500; }
  .clamp2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .clamp1 { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  table.loops .c-loop { width: 15%; }
  table.loops .c-status { width: 24%; }
  table.loops .c-today { width: 110px; }
  table.loops .c-actions { width: 136px; }
  table.loops.free .c-today { display: none; }
  .loops tr.loop.selected td { background: var(--accent-bg); }
  .loops tr.loop.selected td:first-child { box-shadow: inset 3px 0 0 var(--primary); }
  .loops tr.loop.live td:first-child { box-shadow: inset 3px 0 0 var(--blue); }
  .loops tr.loop.live.selected td:first-child { box-shadow: inset 3px 0 0 var(--primary); }
  .loop-name { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .loop-name .role { font-family: var(--font-mono); font-weight: 600; font-size: 13.5px; }
  .now { color: var(--text); }
  .actions { display: flex; justify-content: flex-end; gap: 2px; }
  tr.loop .actions { opacity: 0.55; transition: opacity 0.12s; }
  tr.loop:hover .actions, tr.loop:focus-within .actions, tr.loop.selected .actions { opacity: 1; }
  @media (hover: none) { tr.loop .actions { opacity: 1; } }

  /* ---- backlog list ---- */
  .list { max-height: 460px; overflow-y: auto; }
  .list-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--line-soft); }
  .list-item:last-child { border-bottom: 0; }
  .list-item:hover { background: var(--surface-2); }
  .list-item.active { background: var(--accent-bg); }
  .li-icon { color: var(--t, var(--text-4)); padding-top: 2px; }
  .li-open { flex: 1; min-width: 0; display: block; padding: 0; border: 0; background: none; text-align: left; cursor: pointer; }
  .li-title { display: block; color: var(--text); overflow-wrap: anywhere; }
  .li-open:hover .li-title { color: var(--accent); }
  .li-meta { display: block; margin-top: 1px; font-size: 12px; color: var(--text-4); }
  .li-main { flex: 1; min-width: 0; }
  .empty { padding: 28px 16px; text-align: center; color: var(--text-4); list-style: none; }
  .empty strong { display: block; color: var(--text-3); font-weight: 600; margin-bottom: 2px; }

  /* ---- activity feed ---- */
  .feed { list-style: none; margin: 0; padding: 0; max-height: 460px; overflow-y: auto; }
  .feed-item { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 10px; align-items: start;
               padding: 8px 16px; border-bottom: 1px solid var(--line-soft); font-size: 13.5px; }
  .feed-item:last-child { border-bottom: 0; }
  .feed-icon { color: var(--t, var(--text-4)); padding-top: 2px; }
  .feed-icon svg.i { width: 15px; height: 15px; }
  .feed-msg { color: var(--text-2); overflow-wrap: anywhere; }
  .feed-item.k-routine .feed-msg { color: var(--text-3); }
  .feed-loop { font-family: var(--font-mono); font-size: 12.5px; font-weight: 600; color: var(--text); margin-right: 4px; }
  .feed-time { font-size: 12px; color: var(--text-4); white-space: nowrap; font-variant-numeric: tabular-nums; padding-top: 1px; }

  /* ---- drawer: a loop's detail and live transcript, or one backlog entry ---- */
  .drawer { position: fixed; top: 0; right: 0; bottom: 0; z-index: 50; width: min(660px, 100vw); display: flex;
            flex-direction: column; background: var(--bg); border-left: 1px solid var(--line); box-shadow: var(--shadow-lg);
            animation: slidein 0.16s ease-out; }
  @keyframes slidein { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
  .scrim { position: fixed; inset: 0; z-index: 45; background: var(--scrim); display: none; }
  .drawer-head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 20px 14px; border-bottom: 1px solid var(--line);
                 background: var(--surface); }
  .drawer-title { flex: 1; min-width: 0; }
  .drawer-head .kicker { font-size: 12px; font-weight: 600; color: var(--text-4); }
  .drawer-head h2 { margin: 2px 0 8px; font-size: 19px; line-height: 1.3; font-weight: 650; letter-spacing: -0.01em; overflow-wrap: anywhere; }
  .drawer-head h2.mono { font-size: 18px; letter-spacing: 0; }
  .drawer-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px 24px; display: flex; flex-direction: column; gap: 18px; }
  .drawer-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  #drawermeta, #entrybody { display: flex; flex-direction: column; gap: 18px; }
  .drawer-actions .confirming { color: var(--red); background: var(--red-bg); border-color: var(--red-line); }
  .sec-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .sec-head h3 { margin: 0; font-size: 12.5px; font-weight: 650; color: var(--text-3); }
  .kv { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin: 0; border: 1px solid var(--line);
        border-radius: 10px; overflow: hidden; background: var(--line); }
  .kv > div { padding: 9px 12px; background: var(--surface); min-width: 0; }
  .kv dt { font-size: 12px; color: var(--text-3); }
  .kv dd { margin: 1px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note { padding: 11px 13px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); overflow-wrap: anywhere; }
  .ticks { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--surface); }
  .ticks li { display: grid; grid-template-columns: 116px minmax(0, 1fr) auto; gap: 10px; padding: 8px 12px;
              border-bottom: 1px solid var(--line-soft); font-size: 13px; }
  .ticks li:last-child { border-bottom: 0; }
  .ticks .when { color: var(--text-4); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .transcript-sec { flex: 1; min-height: 320px; display: flex; flex-direction: column; }
  .transcript { flex: 1; min-height: 280px; margin: 0; overflow: auto; padding: 12px 14px; border-radius: 10px;
                border: 1px solid var(--line); background: var(--surface); font: 12.5px/1.6 var(--font-mono);
                color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; }
  .transcript .l-sep { color: var(--text-4); font-weight: 600; }
  .transcript .l-tool { color: var(--accent); }
  .transcript .l-think { color: var(--text-4); font-style: italic; }
  .transcript .l-warn { color: var(--amber); }

  /* ---- toast ---- */
  .toast { position: fixed; right: 20px; bottom: 20px; z-index: 60; max-width: min(460px, calc(100vw - 40px));
           padding: 11px 15px; border-radius: 10px; background: var(--invert); color: var(--on-invert);
           box-shadow: var(--shadow-lg); font-size: 13.5px; animation: toastin 0.16s ease-out; }
  .toast:empty { display: none; }
  .toast.error { box-shadow: var(--shadow-lg), inset 4px 0 0 #ef4444; padding-left: 19px; }
  @keyframes toastin { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }

  /* ---- secondary views: history, usage, failures ---- */
  .view { display: flex; flex-direction: column; gap: 20px; }
  #usagebody, #failbody { display: flex; flex-direction: column; gap: 20px; }
  .view-head { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 12px 16px; }
  .view-head h1 { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -0.01em; }
  .view-head p { margin: 2px 0 0; color: var(--text-3); }
  .window-note { margin: 0; font-size: 12.5px; }
  .toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-left: auto; }
  .chart-card .chart { padding: 12px 16px 14px; }
  .chart svg { display: block; width: 100%; height: auto; }
  .chart svg text { fill: var(--text-4); font: 11px var(--font-sans); }
  .chart svg .grid { stroke: var(--line-soft); }
  .chart svg .axis { stroke: var(--line); }
  #report svg rect:hover { opacity: .8; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 10px; font-size: 12.5px; color: var(--text-3); }
  .legend span { display: inline-flex; align-items: center; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; }
  #report-tip { position: fixed; pointer-events: none; display: none; z-index: 70; padding: 5px 9px; border-radius: 8px;
                background: var(--invert); color: var(--on-invert); font-size: 12.5px; white-space: nowrap; box-shadow: var(--shadow-lg); }
  .md { padding: 8px 24px 24px; overflow-wrap: anywhere; }
  .md h2 { margin: 22px 0 8px; font-size: 16px; font-weight: 650; }
  .md h3 { margin: 18px 0 6px; font-size: 14.5px; font-weight: 650; }
  .md h4, .md h5, .md h6 { margin: 14px 0 4px; font-size: 14px; }
  .md p { margin: 8px 0; color: var(--text-2); }
  .md ul, .md ol { margin: 6px 0; padding-left: 22px; color: var(--text-2); }
  .md li { margin: 3px 0; }
  .md blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid var(--line); color: var(--text-3); }
  .md code { font: 12.5px var(--font-mono); padding: 1px 5px; border-radius: 5px; background: var(--surface-3); }
  .md pre { margin: 10px 0; padding: 10px 12px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--line); overflow-x: auto; }
  .md pre code { padding: 0; background: none; }
  .md table { width: 100%; margin: 10px 0; border-collapse: collapse; font-size: 13px; }
  .md th, .md td { padding: 6px 10px; border-bottom: 1px solid var(--line-soft); text-align: left; }
  .md th { font-weight: 600; color: var(--text-3); background: var(--surface-2); border-bottom-color: var(--line); }
  .md td.r, .md th.r { text-align: right; font-variant-numeric: tabular-nums; }
  .drawer .md { padding: 0; }

  /* ---- responsive ---- */
  @media (max-width: 1180px) {
    .grid-2, .grid-2.even { grid-template-columns: minmax(0, 1fr); }
    .stats.six { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .scrim:not([hidden]) { display: block; }
  }
  @media (max-width: 900px) {
    /* The sidebar folds into a header: brand and project, then the views, then status and controls. */
    .shell { display: block; }
    .sidebar { position: static; height: auto; gap: 10px; padding: 12px 16px; border-right: 0; border-bottom: 1px solid var(--line); }
    .side-top { padding: 0; }
    .side-project { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 0; }
    .side-project .side-label { display: none; }
    .project { padding: 0; }
    .side-status { flex-direction: row; flex-wrap: wrap; gap: 2px 10px; padding: 0; }
    .side-status .row { padding: 0; }
    .side-status .row.rowclickable { padding: 3px 8px; }
    .side-nav { flex-direction: row; min-width: 0; overflow-x: auto; scrollbar-width: none; }
    .tab { flex: none; }
    .side-controls { flex-direction: row; flex-wrap: wrap; margin-top: 0; }
    .side-controls > * { flex: 1 1 180px; min-width: 0; }
    .menu-anchor.up .popover { top: calc(100% + 8px); bottom: auto; }
    .main { padding-left: 16px; padding-right: 16px; }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    table.loops .c-today { display: none; }
    .kv { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .history .c-usage, .history .c-dur { display: none; }
  }
  @media (max-width: 680px) {
    .stats.six { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .stat-value { font-size: 21px; }
    .composer-foot #prompthint { display: none; }
    table.loops thead { display: none; }
    table.loops, table.loops tbody { display: block; }
    table.loops tr.loop { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 12px;
                          padding: 10px 16px; border-bottom: 1px solid var(--line-soft); }
    table.loops tr.loop td { display: block; width: auto; padding: 0; border: 0; background: none !important; box-shadow: none !important; }
    table.loops tr.loop td.c-status, table.loops tr.loop td.c-activity { grid-column: 1 / -1; margin-top: 6px; }
    table.loops tr.loop td.c-actions { grid-row: 1; grid-column: 2; }
    table.loops tr.loop td.c-today { display: none; }
    .composer-row { flex-wrap: wrap; }
    .composer textarea { order: -1; flex-basis: 100%; }
    .composer-target { flex: 1; }
    .composer-target select { max-width: none; width: 100%; }
    table.loops tr.group, table.loops tr.group td { display: block; }
    .history .c-tick, .history .c-detail { display: none; }
    .ticks li { grid-template-columns: minmax(0, 1fr) auto; }
    .ticks .when:first-child { grid-column: 1 / -1; }
    .md { padding: 4px 16px 16px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.live, .drawer, .toast { animation: none; }
  }
`;
