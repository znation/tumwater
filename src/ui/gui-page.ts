/** The dashboard page shell served at `/` by `tumwater gui`: the markup and CSS for the
 * zero-dependency single-file app, with its browser-side logic inlined from gui-client.ts
 * as the page's only <script>. Kept in its own module so gui.ts stays focused on serving
 * logic and the API payload; edit this template when the page's layout or styles change. */
import { GUI_CLIENT_JS } from "./gui-client.js";
export const GUI_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>tumwater</title>
<style>
  :root { color-scheme: dark; }
  body { background:#101418; color:#d6dde4; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
         max-width:1100px; margin:2rem auto; padding:0 1rem; }
  h1 { font-size:16px; font-weight:600; } h1 .muted, .muted { color:#7a8794; font-weight:400; }
  table { border-collapse:collapse; width:100%; margin:1rem 0; font-size:12px; }
  th,td { text-align:left; padding:4px 10px 4px 0; border-bottom:1px solid #1e2831; white-space:nowrap; }
  td.wide { white-space:normal; }
  th { color:#7a8794; font-weight:500; }
  .working { color:#7ec8ff; } .changed { color:#7fd88f; } .error, .merge_conflict { color:#ff9a8a; }
  #feed { background:#0b0e12; border:1px solid #1e2831; border-radius:6px; padding:10px 14px;
          height:16em; overflow-y:auto; font-size:13px; color:#9fb0bf; }
  #transcript, #failures { background:#0b0e12; border:1px solid #1e2831; border-radius:6px; padding:10px 14px;
          max-height:16em; overflow-y:auto; font-size:13px; color:#9fb0bf; white-space:pre-wrap;
          margin-bottom:1rem; }
  #backlog { background:#0b0e12; border:1px solid #1e2831; border-radius:6px; padding:10px 14px;
          max-height:16em; overflow-y:auto; font-size:13px; color:#9fb0bf; white-space:pre-wrap;
          margin-bottom:1rem; }
  a { color:#7ec8ff; text-decoration:none; cursor:pointer; } a.active { color:#d6dde4; font-weight:600; }
  form { display:flex; gap:8px; margin:1rem 0; }
  input { flex:1; background:#0b0e12; color:#d6dde4; border:1px solid #2a3642; border-radius:6px;
          padding:8px 10px; font:inherit; }
  button { background:#20303e; color:#d6dde4; border:1px solid #2a3642; border-radius:6px;
           padding:8px 16px; font:inherit; cursor:pointer; }
  #flash { color:#7fd88f; margin-left:8px; }
  #viewnav { margin:0.5rem 0; }
  .stats { display:flex; gap:12px; flex-wrap:wrap; margin:1rem 0; }
  .stat { background:#0b0e12; border:1px solid #1e2831; border-radius:6px; padding:8px 14px; min-width:9em; }
  .stat b { display:block; font-size:15px; margin-top:2px; }
  .chartblock { margin:1rem 0; }
  .charttitle { color:#7a8794; font-weight:500; margin-bottom:6px; }
  #report svg text { fill:#7a8794; font-size:10px; }
  #report svg rect:hover { opacity:.8; }
  #report-tip { position:fixed; pointer-events:none; display:none; background:#0b0e12; border:1px solid #2a3642;
          border-radius:6px; padding:4px 8px; font-size:12px; color:#d6dde4; white-space:nowrap; z-index:10; }
  .legend { display:flex; gap:12px; flex-wrap:wrap; margin-top:6px; color:#9fb0bf; font-size:12px; }
  .swatch { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; }
</style>
<h1>tumwater <span class="muted" id="header">connecting…</span><span id="budgetwrap"></span></h1>
<nav id="viewnav"><a href="#" id="tab-fleet" class="active">fleet</a><span class="muted"> | </span><a href="#" id="tab-report">report</a><span class="muted"> | </span><a href="#" id="tab-failures">failures</a></nav>
<form id="promptform">
  <input id="prompt" placeholder="type a prompt for the project — it runs immediately via the director loop" autocomplete="off">
  <button>send</button><span id="flash"></span>
</form>
<div id="fleet-view">
<table>
  <thead><tr><th>loop</th><th>state</th><th>current</th><th>ticks</th><th>commits</th><th>gen</th><th>peak ctx</th><th>cost</th><th>today</th><th>last tick</th><th>last result</th></tr></thead>
  <tbody id="loops"></tbody>
</table>
<div id="transcript" hidden></div>
<div id="backlog"></div>
<div id="feed"></div>
</div>
<div id="report" hidden></div>
<div id="failures" hidden></div>
<script>
${GUI_CLIENT_JS}
</script>
`;
