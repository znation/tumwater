/** The dashboard page served at `/` by `tumwater gui`: a zero-dependency single-file app
 * that polls /api/status every second, renders the loop table and event feed, and posts
 * prompts to /api/prompt. Kept in its own module so gui.ts stays focused on serving logic
 * and the API payload; edit this template when the dashboard's UI changes. */
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
  form { display:flex; gap:8px; margin:1rem 0; }
  input { flex:1; background:#0b0e12; color:#d6dde4; border:1px solid #2a3642; border-radius:6px;
          padding:8px 10px; font:inherit; }
  button { background:#20303e; color:#d6dde4; border:1px solid #2a3642; border-radius:6px;
           padding:8px 16px; font:inherit; cursor:pointer; }
  #flash { color:#7fd88f; margin-left:8px; }
</style>
<h1>tumwater <span class="muted" id="header">connecting…</span></h1>
<form id="promptform">
  <input id="prompt" placeholder="type a prompt for the project — it runs immediately via the director loop" autocomplete="off">
  <button>send</button><span id="flash"></span>
</form>
<table>
  <thead><tr><th>loop</th><th>state</th><th>ticks</th><th>commits</th><th>tokens</th><th>cost</th><th>last result</th></tr></thead>
  <tbody id="loops"></tbody>
</table>
<div id="feed"></div>
<script>
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  async function refresh() {
    try {
      const r = await fetch("/api/status");
      const d = await r.json();
      document.getElementById("header").textContent =
        (d.running ? "running (pid " + d.pid + ")" : "orchestrator not running") +
        (d.inbox ? " · inbox: " + d.inbox : "");
      document.getElementById("loops").innerHTML = d.loops.map((l) => {
        const cls = l.phase.startsWith("working") ? "working" : (l.lastResult || "");
        const last = l.lastResult ? l.lastResult + (l.lastSummary ? " — " + l.lastSummary : "") : "-";
        return "<tr><td>" + esc(l.role) + "</td><td class='wide " + cls + "'>" + esc(l.phase) +
          "</td><td>" + l.ticks + "</td><td>" + l.commits + "</td><td>" + l.tokens +
          "</td><td>$" + l.costUsd.toFixed(2) + "</td><td class='wide'>" + esc(last) + "</td></tr>";
      }).join("");
      const feed = document.getElementById("feed");
      const stick = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 4;
      feed.innerHTML = d.events.map(esc).join("<br>");
      if (stick) feed.scrollTop = feed.scrollHeight;
    } catch {
      document.getElementById("header").textContent = "connection lost";
    }
  }
  document.getElementById("promptform").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const input = document.getElementById("prompt");
    const text = input.value.trim();
    if (!text) return;
    await fetch("/api/prompt", { method: "POST", headers: { "content-type": "application/json" },
                                 body: JSON.stringify({ text }) });
    input.value = "";
    const flash = document.getElementById("flash");
    flash.textContent = "queued";
    setTimeout(() => (flash.textContent = ""), 3000);
    refresh();
  });
  refresh();
  setInterval(refresh, 1000);
</script>
`;
