/** The dashboard page shell served at `/` by `tumwater gui`: the markup of the zero-dependency
 * single-file app, with its stylesheet (gui-styles.ts) and browser logic (gui-client.ts)
 * inlined. The shell is a sidebar beside a main column. The sidebar is the fleet's frame on
 * every view: which project this is and whether its fleet is up (build, main check), the
 * views — Fleet's carrying a badge while something needs a human — and the fleet-wide
 * controls: today's spend against the cap, and pause. The main column shows one view: Fleet
 * (alerts for whatever needs a human, the composer that steers the director or one loop,
 * today's progress, every loop grouped by what it is doing, the backlog, and the notable
 * activity), History, Usage, or Failures. A drawer opens
 * any loop's detail and live transcript, or any backlog entry in full. Kept apart from gui.ts
 * so the server module stays about serving. */
import { GUI_CLIENT_JS } from "./gui-client.js";
import { GUI_STYLES } from "./gui-styles.js";
import { iconSvg, LOGO_SVG } from "./gui-icons.js";

const FAVICON = `data:image/svg+xml,${encodeURIComponent(LOGO_SVG.replace(' class="logo"', ""))}`;

export const GUI_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tumwater</title>
<link rel="icon" href="${FAVICON}">
<script>try{var t=localStorage.getItem("tumwater-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>
<style>${GUI_STYLES}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
<aside class="sidebar" aria-label="Fleet">
  <div class="side-top">
    <a class="brand" href="#fleet" aria-label="tumwater fleet">${LOGO_SVG}<span>tumwater</span></a>
    <div class="side-top-actions">
      <span id="soundwrap"></span>
      <button type="button" class="icon-btn" id="themetoggle" title="Switch between light and dark" aria-label="Switch between light and dark">${iconSvg("sun", "theme-sun")}${iconSvg("moon", "theme-moon")}</button>
    </div>
  </div>
  <div class="side-project">
    <div class="side-label">Project</div>
    <div class="project" id="project" title="Project directory">&nbsp;</div>
    <div class="side-status" id="statuschips" aria-live="polite"></div>
  </div>
  <nav class="side-nav" id="viewnav" aria-label="Views">
    <a href="#fleet" id="tab-fleet" class="tab active" aria-current="page">${iconSvg("grid")}<span>Fleet</span><span class="badge t-red" id="navbadge" hidden></span></a>
    <a href="#history" id="tab-history" class="tab">${iconSvg("list")}<span>History</span></a>
    <a href="#usage" id="tab-usage" class="tab">${iconSvg("bars")}<span>Usage</span></a>
    <a href="#failures" id="tab-failures" class="tab">${iconSvg("alert")}<span>Failures</span></a>
  </nav>
  <div class="side-controls">
    <div class="menu-anchor up" id="budgetwrap"></div>
    <div class="menu-anchor up" id="pausewrap"></div>
  </div>
</aside>
<main id="main" class="main">
  <section id="fleet-view" class="view" aria-labelledby="fleet-title">
    <div class="view-head">
      <div><h1 id="fleet-title">Fleet</h1><p id="fleetsub">&nbsp;</p></div>
    </div>
    <div id="alerts" class="alerts" aria-live="polite"></div>
    <form id="promptform" class="composer" autocomplete="off">
      <div class="composer-row">
        <label class="composer-target"><span class="sr-only">Send to</span><select id="prompttarget" class="field"><option value="director">Director</option></select></label>
        <textarea id="prompt" rows="1" placeholder="Tell the fleet what to do next…" aria-label="Prompt"></textarea>
        <button type="submit" class="btn btn-primary" id="promptsend" title="Send (Enter)">${iconSvg("send")}<span>Send</span></button>
      </div>
      <div id="promptimages" class="chips" hidden></div>
      <div class="composer-foot">
        <span id="prompthint"></span>
        <span class="composer-meta"><span id="promptcount"></span><a href="#" id="queuelink" hidden></a></span>
      </div>
    </form>
    <div id="stats" class="stats"></div>
    <section class="card" aria-labelledby="loops-title">
      <header class="card-head">
        <h2 id="loops-title">Loops</h2>
        <div class="spacer"></div>
        <button type="button" class="btn btn-sm" id="wakeall" title="Wake every loop now, skipping any sleep or backoff">${iconSvg("bolt")}<span>Wake all</span></button>
      </header>
      <div class="table-wrap">
        <table class="table loops" id="loopstable">
          <thead><tr><th class="c-loop">Loop</th><th class="c-status">Status</th><th class="c-activity">Now, or the last result</th><th class="c-today num">Spent today</th><th class="c-actions"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody id="loops"></tbody>
        </table>
      </div>
    </section>
    <div class="grid-2">
      <section class="card" id="backlogcard" aria-labelledby="backlog-title">
        <header class="card-head">
          <h2 id="backlog-title">Backlog</h2>
          <div class="spacer"></div>
          <div class="seg" id="backlogtabs" role="tablist" aria-label="Backlog sections"></div>
        </header>
        <div id="backlog" class="list"></div>
      </section>
      <section class="card" aria-labelledby="activity-title">
        <header class="card-head">
          <h2 id="activity-title">Activity</h2>
          <div class="spacer"></div>
          <div class="seg" id="feedfilter" role="tablist" aria-label="Activity filter">
            <button type="button" data-filter="notable" class="active">Notable</button><button type="button" data-filter="all">All events</button>
          </div>
        </header>
        <ol id="feed" class="feed"></ol>
      </section>
    </div>
  </section>
  <section id="history" class="view" aria-label="History" hidden></section>
  <section id="report" class="view" aria-label="Usage" hidden></section>
  <section id="failures" class="view" aria-label="Failures" hidden></section>
</main>
</div>
<aside id="drawer" class="drawer" role="dialog" aria-labelledby="drawertitle" hidden>
  <div class="drawer-head"><div id="drawerhead" class="drawer-title"></div><button type="button" class="icon-btn" data-act="close" title="Close (Esc)" aria-label="Close">${iconSvg("x")}</button></div>
  <div id="drawerbody" class="drawer-body"></div>
</aside>
<div id="scrim" class="scrim" hidden></div>
<div id="flash" class="toast" role="status" aria-live="polite"></div>
<script>
${GUI_CLIENT_JS}
</script>
</body>
</html>
`;
