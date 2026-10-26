import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_JS } from "../src/ui/gui/gui-client.js";
import { GUI_CLIENT_BOOT_JS } from "../src/ui/gui/gui-client-boot.js";
import { GUI_CLIENT_SETTINGS_JS } from "../src/ui/gui/gui-client-settings.js";
import { EDITABLE_CONFIG_KEYS } from "../src/config/config-editable-keys.js";
import { clientScope, clientRegion, ESC_LINE } from "./helpers/gui-client-scope.js";

// The dashboard's Settings panel, browser-side (src/ui/gui/gui-client-settings.ts): the curated
// keys rendered as one row per key with the current value in an inline field, and the Save
// wiring that posts the row's key to /api/config-set and flashes the outcome. The pattern
// gui-client-composer.test.ts uses: the script's own esc() and the settings blob, run in one
// function scope with stand-ins for the DOM and the server.

interface SettingsFns {
  SETTINGS_KEYS: ReadonlyArray<readonly [string, string]>;
  renderSettings(d: unknown): string;
  fetchSettings(): Promise<void>;
  renderSettingsPanel(d: unknown): void;
  saveSetting(form: { dataset: Record<string, string>; querySelector(sel: string): { value: string } }): Promise<void>;
  clearSetting(form: { dataset: Record<string, string> }): Promise<void>;
  renderDoctorReport(d: unknown, problems?: boolean): string;
  fetchDoctor(): Promise<void>;
  toggleDoctorProblems(checked: boolean): void;
  testNotify(): Promise<void>;
  fetchBrief(): Promise<void>;
  saveBrief(form: { querySelector(sel: string): { value: string } }): Promise<void>;
  renderRetirable(d: unknown, armed: (role: string) => boolean): string;
  fetchRetirable(): Promise<void>;
  enableRole(role: string): Promise<void>;
  confirmRetire(role: string): Promise<void>;
  killOrphansClick(): Promise<void>;
  dropBrokenPinsClick(): Promise<void>;
  retireLeftoversClick(): Promise<void>;
  commitBacklogClick(): Promise<void>;
  archiveBacklogClick(): Promise<void>;
  resyncInstallClick(): Promise<void>;
  paintKillButton(): void;
  paintDropButton(): void;
  paintRetireLeftoversButton(): void;
  paintArchiveBacklogButton(): void;
}

function settingsScope(inject: Record<string, unknown> = {}): SettingsFns {
  return clientScope<SettingsFns>(
    ["panel-build", "err-message", "settings-view", "format"],
    ["SETTINGS_KEYS", "renderSettings", "fetchSettings", "renderSettingsPanel", "saveSetting", "clearSetting", "renderDoctorReport", "fetchDoctor", "toggleDoctorProblems", "testNotify", "fetchBrief", "saveBrief", "renderRetirable", "fetchRetirable", "enableRole", "confirmRetire", "killOrphansClick", "dropBrokenPinsClick", "retireLeftoversClick", "commitBacklogClick", "archiveBacklogClick", "resyncInstallClick", "paintKillButton", "paintDropButton", "paintRetireLeftoversButton", "paintArchiveBacklogButton"],
    { confirmSlot: (_repaint: unknown) => ({ armed: () => false, disarm: () => {}, arm: () => {} }), ...inject },
  );
}

test("renderSettings renders one row per curated key, esc'd, with the key's config name shown", () => {
  const { renderSettings, SETTINGS_KEYS } = settingsScope();
  const html = renderSettings({ provider: "a&b", model: "gpt-5", fallback: "omlx/free", maxDailyCostUsd: 30, maxConcurrent: 6, maxConcurrentPerProvider: { anthropic: 4 }, worktreeSlots: 9, quietHours: null, notify: undefined, backends: { pi: { bin: "pi" } }, check: { command: "npm test" } });
  // The browser list is a hand copy of the server constant; pin key and order to it so the
  // two cannot drift — an added editable key must appear here too.
  assert.deepEqual(SETTINGS_KEYS.map(([key]) => key), [...EDITABLE_CONFIG_KEYS]);
  // Each curated key has its row, field, and Save button.
  for (const key of EDITABLE_CONFIG_KEYS) {
    assert.match(html, new RegExp(`data-key='${key}'`));
    assert.match(html, new RegExp(`id='set-${key}'`));
  }
  assert.equal((html.match(/data-action='notify-test'/g) || []).length, 1);
  assert.match(html, /data-key='notify'[^]*?data-action='notify-test'[^]*?<\/form>/);
  assert.equal((html.match(/<form class='settings-row'/g) || []).length, EDITABLE_CONFIG_KEYS.length);
  assert.equal((html.match(/type='submit'/g) || []).length, EDITABLE_CONFIG_KEYS.length);
  // One Clear button per curated key, beside the Save counts.
  assert.equal((html.match(/data-action='unset'/g) || []).length, EDITABLE_CONFIG_KEYS.length);
  assert.match(html, /data-action='unset'>Clear<\/button>/);
  // Values are escaped; null and undefined render as an empty field.
  assert.match(html, /value='a&amp;b'/);
  assert.match(html, /id='set-model' value='gpt-5'/);
  assert.match(html, /id='set-maxDailyCostUsd' value='30'/);
  // The run-concurrency rows render beside the existing keys, the number keys as numbers and
  // the object key as compact JSON (esc'd), exactly as backends does.
  assert.match(html, /id='set-maxConcurrent' value='6'/);
  assert.match(html, /id='set-worktreeSlots' value='9'/);
  assert.match(html, /id='set-maxConcurrentPerProvider' value='\{&quot;anthropic&quot;:4\}'/);
  assert.match(html, /id='set-quietHours' value=''/);
  assert.match(html, /id='set-notify' value=''/);
  // An object value renders as compact JSON (esc'd), so it can round-trip through the field.
  assert.match(html, /id='set-backends' value='\{&quot;pi&quot;:\{&quot;bin&quot;:&quot;pi&quot;\}\}'/);
  assert.match(html, /<label for='set-maxConcurrentChecks'>Max concurrent checks<span class='settings-key'>maxConcurrentChecks<\/span><\/label>/);
  // The claudeWindowReserve row renders under its curated label.
  assert.match(html, /<label for='set-claudeWindowReserve'>Claude window reserve \(backends\.claude\.windowReserve\)<span class='settings-key'>claudeWindowReserve<\/span><\/label>/);
  // The check row (the no-check alert's surfaced remedy): an object value renders as compact
  // JSON, exactly as backends does, under its Declared check label.
  assert.match(html, /<label for='set-check'>Declared check \(JSON\)<span class='settings-key'>check<\/span><\/label>/);
  assert.match(html, /id='set-check' value='\{&quot;command&quot;:&quot;npm test&quot;\}'/);
});

test("fetchSettings builds the panel and fills it from GET /api/config; a failure renders the error panel", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {
    "settings-view": { innerHTML: "", dataset: {} },
    settingscard: { innerHTML: "", dataset: {} },
  };
  const { fetchSettings } = settingsScope({
    errorPanel: (title: string, err: { message: string }) => "<div>" + title + " " + err.message + "</div>",
    $: (id: string) => els[id],
    getJson: async () => ({ model: "gpt-5", provider: null, maxDailyCostUsd: 25, quietHours: null, notify: null }),
  });
  await fetchSettings();
  assert.match(els["settings-view"]!.innerHTML, /<h1>Settings<\/h1>/);
  assert.match(els["settings-view"]!.innerHTML, /id='settingscard'/);
  assert.match(els.settingscard!.innerHTML, /id='set-model' value='gpt-5'/);
  // A failed GET: the standard error panel, not a silent blank card.
  const { fetchSettings: fetchFail } = settingsScope({
    errorPanel: (title: string, err: { message: string }) => "<div>" + title + " " + err.message + "</div>",
    $: (id: string) => els[id],
    getJson: async () => {
      throw new Error("/api/config failed: HTTP 500 — broken file");
    },
  });
  els["settings-view"]!.dataset.built = "1";
  await fetchFail();
  assert.match(els.settingscard!.innerHTML, /Settings could not load/);
  assert.match(els.settingscard!.innerHTML, /broken file/);
});

test("testNotify posts to /api/notify-test and flashes the outcome", async () => {
  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let reply: () => Promise<unknown> = async () => ({ passed: true, message: "notify hook exited 0" });
  const { testNotify } = settingsScope({
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return reply();
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await testNotify();
  assert.deepEqual(posts, [{ path: "/api/notify-test", body: {} }]);
  assert.deepEqual(flashes, ["Sending a test notification…", "notify hook exited 0"]);
  flashes.length = 0;
  reply = async () => ({ passed: false, message: "notify hook exited with code 3" });
  await testNotify();
  assert.equal(flashes[1], "error: notify hook exited with code 3");
  flashes.length = 0;
  reply = async () => { throw { message: "notify is not configured (set `notify` in tumwater.json)" }; };
  await testNotify();
  assert.equal(flashes[1], "error: notify is not configured (set `notify` in tumwater.json)");
});

test("saveSetting posts the row's key and value and flashes the outcome", async () => {
  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const { saveSetting } = settingsScope({
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { ok: true, key: "model", value: "gpt-5", oldValue: null };
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  const form = { dataset: { key: "model" }, querySelector: () => ({ value: "gpt-5" }) };
  await saveSetting(form);
  assert.deepEqual(posts, [{ path: "/api/config-set", body: { key: "model", value: "gpt-5" } }]);
  assert.deepEqual(flashes, ["Saved model (was unset)"]);
  // A reply flagged unchanged flashes the no-op wording.
  const { saveSetting: saveSame } = settingsScope({
    postJson: async () => ({ ok: true, key: "model", value: "gpt-5", oldValue: "gpt-5", unchanged: true }),
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await saveSame(form);
  assert.equal(flashes[flashes.length - 1], "model is already that value — nothing saved");
  // A JSON object field (agents) posts the parsed object, not its text.
  let agentBody: unknown;
  const { saveSetting: saveAgents } = settingsScope({
    postJson: async (_path: string, body: unknown) => {
      agentBody = body;
      return { ok: true, key: "backends", value: "ok", oldValue: null };
    },
    showFlash: () => {},
  });
  await saveAgents({ dataset: { key: "backends" }, querySelector: () => ({ value: '{"pi":{"bin":"pi"}}' }) });
  assert.deepEqual(agentBody, { key: "backends", value: { pi: { bin: "pi" } } });
  // A server-side refusal: the flash is the error pattern, with the server's message.
  const { saveSetting: saveFail } = settingsScope({
    postJson: async () => {
      throw new Error("/api/config-set failed: HTTP 400 — quietHours: invalid quiet hours window");
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await saveFail({ dataset: { key: "quietHours" }, querySelector: () => ({ value: "25:00-07:00" }) });
  assert.match(flashes[flashes.length - 1]!, /^error: .*quietHours/);
});

test("clearSetting posts the row's key to /api/config-unset, flashes the retraction, and refetches", async () => {
  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let refetched = 0;
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {
    "settings-view": { innerHTML: "", dataset: { built: "1" } },
    settingscard: { innerHTML: "", dataset: {} },
  };
  const { clearSetting } = settingsScope({
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { ok: true, key: "model", oldValue: "gpt-5" };
    },
    getJson: async () => { refetched++; return { model: null }; },
    $: (id: string) => els[id],
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await clearSetting({ dataset: { key: "model" } });
  assert.deepEqual(posts, [{ path: "/api/config-unset", body: { key: "model" } }]);
  assert.deepEqual(flashes, ['Unset model (was "gpt-5")']);
  // The resolved value is refetched so the field repaints with the reverted default.
  assert.equal(refetched, 1);
  // A response with no oldValue is the no-op message, and a file value of null still counts
  // as a real retraction (only `undefined` means the file never held the key).
  const { clearSetting: clearNull } = settingsScope({
    postJson: async () => ({ ok: true, key: "model", oldValue: null }),
    getJson: async () => ({}),
    $: (id: string) => els[id],
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await clearNull({ dataset: { key: "model" } });
  assert.equal(flashes[flashes.length - 1], "Unset model (was null)");
  const { clearSetting: clearNoop } = settingsScope({
    postJson: async () => ({ ok: true, key: "model" }),
    getJson: async () => ({}),
    $: (id: string) => els[id],
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await clearNoop({ dataset: { key: "model" } });
  assert.match(flashes[flashes.length - 1]!, /^Nothing to unset for model/);
  // A server-side refusal flashes the error pattern, with the server's message.
  const { clearSetting: clearFail } = settingsScope({
    postJson: async () => {
      throw new Error("/api/config-unset failed: HTTP 400 — quietHours: invalid quiet hours window");
    },
    getJson: async () => ({}),
    $: (id: string) => els[id],
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await clearFail({ dataset: { key: "quietHours" } });
  assert.match(flashes[flashes.length - 1]!, /^error: .*quietHours/);
});

test("the settings region is spliced into the served script, and the boot routes #settings to it", () => {
  // The GUI page inlines GUI_CLIENT_JS, which must carry the settings blob…
  assert.equal(GUI_CLIENT_JS.includes(clientRegion("settings-view")), true);
  // …and the boot's view table and switchView must fetch it.
  assert.match(GUI_CLIENT_BOOT_JS, /settings: "settings-view"/);
  assert.match(GUI_CLIENT_BOOT_JS, /if \(v === "settings"\) \{ fetchSettings\(\); fetchDoctor\(\); fetchRetirable\(\); fetchBrief\(\); \}/);
  assert.match(GUI_CLIENT_BOOT_JS, /button\[data-action='retire'\]/);
  assert.match(GUI_CLIENT_BOOT_JS, /data-action='doctor-rerun'/);
  // …and the boot carries the Clear click selector beside the Save submit wiring.
  assert.match(GUI_CLIENT_BOOT_JS, /button\[data-action='unset'\]/);
  assert.match(GUI_CLIENT_BOOT_JS, /clearSetting\(form\)/);
  assert.match(ESC_LINE, /const esc = /);
});

test("renderDoctorReport esc's every field and maps levels to tones; a missing checks array renders no rows", () => {
  const { renderDoctorReport } = settingsScope();
  const html = renderDoctorReport({
    header: "<h>",
    checks: [
      { name: "a", level: "ok", detail: "<b>&" },
      { name: "b", level: "warn", detail: "x" },
      { name: "c", level: "fail", detail: "y" },
    ],
    verdict: "<v>",
  });
  assert.doesNotMatch(html, /<b>&|<h>|<v>/);
  assert.match(html, /t-green'>ok/);
  assert.match(html, /t-amber'>warn/);
  assert.match(html, /t-red'>fail/);
  const bare = renderDoctorReport({ header: "h", verdict: "v" });
  assert.match(bare, /h/);
  assert.match(bare, /v/);
});

test("fetchDoctor paints the error panel into doctorbody when the fetch rejects", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {
    "settings-view": { innerHTML: "", dataset: {} },
    doctorbody: { innerHTML: "", dataset: {} },
  };
  const { fetchDoctor } = settingsScope({
    errorPanel: (title: string, err: { message: string }) => "<div>" + title + " " + err.message + "</div>",
    $: (id: string) => els[id],
    getJson: async () => {
      throw new Error("boom");
    },
  });
  await fetchDoctor();
  assert.match(els.doctorbody!.innerHTML, /Health checks could not run/);
  assert.match(els.doctorbody!.innerHTML, /boom/);
});

test("renderDoctorReport filters to problems with the flag, and toggleDoctorProblems repaints the cached report", async () => {
  const report = {
    header: "h",
    checks: [
      { name: "ok-hold", level: "ok", detail: "x" },
      { name: "warn-crypto", level: "warn", detail: "y" },
      { name: "fail-free", level: "fail", detail: "z" },
    ],
    verdict: "v",
  };
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {
    "settings-view": { innerHTML: "", dataset: {} },
    doctorbody: { innerHTML: "", dataset: {} },
  };
  const { renderDoctorReport, fetchDoctor, toggleDoctorProblems } = settingsScope({
    errorPanel: (title: string, err: { message: string }) => "<div>" + title + " " + err.message + "</div>",
    $: (id: string) => els[id],
    getJson: async () => report,
  });
  // The default view renders every row; the problems view keeps only the warn and fail rows
  // and appends the hidden-count line, mirroring `--problems`.
  const full = renderDoctorReport(report);
  assert.match(full, /ok-hold/);
  assert.match(full, /warn-crypto/);
  assert.match(full, /fail-free/);
  const problems = renderDoctorReport(report, true);
  assert.doesNotMatch(problems, /ok-hold/);
  assert.match(problems, /warn-crypto/);
  assert.match(problems, /fail-free/);
  assert.match(problems, /1 ok check hidden/);
  // After a fetch the card paints the full view; toggling the flag repaints it filtered.
  await fetchDoctor();
  assert.match(els.doctorbody!.innerHTML, /ok-hold/);
  toggleDoctorProblems(true);
  assert.doesNotMatch(els.doctorbody!.innerHTML, /ok-hold/);
  assert.match(els.doctorbody!.innerHTML, /1 ok check hidden/);
  assert.match(els.doctorbody!.innerHTML, /warn-crypto/);
  assert.match(els.doctorbody!.innerHTML, /fail-free/);
});

test("the Brief card: built by the view, filled esc'd, saved with the textarea's text", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {
    "settings-view": { innerHTML: "", dataset: {} },
    briefcard: { innerHTML: "", dataset: {} },
  };
  const errorPanel = (title: string, err: { message: string }) => "<div>" + title + " " + err.message + "</div>";
  const { fetchBrief } = settingsScope({
    errorPanel,
    $: (id: string) => els[id],
    getJson: async () => ({ file: "README.md", prompt: "a <b> & c" }),
  });
  await fetchBrief();
  assert.match(els["settings-view"]!.innerHTML, /id='briefcard'/);
  assert.match(els.briefcard!.innerHTML, /<form class='brief-form'>/);
  assert.match(els.briefcard!.innerHTML, /id='brief-text'[^>]*>a &lt;b&gt; &amp; c<\/textarea>/);
  assert.match(els.briefcard!.innerHTML, /README\.md/);
  const { fetchBrief: fetchFail } = settingsScope({
    errorPanel,
    $: (id: string) => els[id],
    getJson: async () => {
      throw new Error("no brief");
    },
  });
  els["settings-view"]!.dataset.built = "1";
  await fetchFail();
  assert.match(els.briefcard!.innerHTML, /Brief could not load no brief/);

  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let reply: unknown = { changed: false, committed: false };
  const { saveBrief } = settingsScope({
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      if (reply instanceof Error) throw reply;
      return reply;
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  const form = { querySelector: () => ({ value: "new text" }) };
  for (const r of [{ changed: false, committed: false }, { changed: true, committed: true }, { changed: true, committed: false }, new Error("empty")]) {
    reply = r;
    await saveBrief(form);
  }
  assert.deepEqual(posts[0], { path: "/api/brief", body: { prompt: "new text" } });
  assert.deepEqual(flashes, ["Brief unchanged", "Brief saved (committed to main)", "Brief saved", "error: empty"]);
});

test("a submit on form.brief-form routes to saveBrief, and the settings listener is scoped to form.settings-row", () => {
  assert.match(GUI_CLIENT_BOOT_JS, /closest\("form\.brief-form"\)[\s\S]*?saveBrief\(form\)/);
  assert.match(GUI_CLIENT_BOOT_JS, /closest\("form\.settings-row"\)[\s\S]*?saveSetting\(form\)/);
  assert.doesNotMatch(clientRegion("settings-view").slice(clientRegion("settings-view").indexOf("async function fetchBrief")), /settings-row/);
});

test("renderRetirable renders an Enable button for every row, a Retire button only for the leftover row, and esc's ids", () => {
  const { renderRetirable } = settingsScope();
  assert.match(renderRetirable({ roles: [] }, () => false), /No role is disabled\./);
  // A role with leftovers: the Enable and two-click Retire buttons, and the would-remove
  // phrases.
  const leftover = { role: "a&b", wouldRemove: ["branch"], phrases: ["the branch (<x>)"], objections: [] };
  const html = renderRetirable({ roles: [leftover] }, () => false);
  assert.match(html, /data-action='enable' data-role='a&amp;b'>Enable<\/button>/);
  assert.match(html, /data-action='retire' data-role='a&amp;b'>Retire<\/button>/);
  assert.match(html, /would remove the branch \(&lt;x&gt;\)/);
  assert.match(renderRetirable({ roles: [leftover] }, (r) => r === "a&b"), />Confirm retire<\/button>/);
  // A clean disabled role (nothing to retire): still the Enable button, no Retire button,
  // and the no-leftovers copy.
  const clean = { role: "improve", wouldRemove: [], phrases: [], objections: [] };
  const cleanHtml = renderRetirable({ roles: [clean] }, () => false);
  assert.match(cleanHtml, /data-action='enable' data-role='improve'>Enable<\/button>/);
  assert.match(cleanHtml, /no leftovers to remove/);
  assert.doesNotMatch(cleanHtml, /data-action='retire'/);
  assert.doesNotMatch(cleanHtml, /would remove/);
  // A row with objections keeps Enable beside the objections and the CLI --force command,
  // no Retire button.
  const blocked = { role: "improve", wouldRemove: ["worktree"], phrases: ["the worktree"], objections: ["the worktree has <b>changes</b>"] };
  const bad = renderRetirable({ roles: [blocked] }, () => false);
  assert.match(bad, /&lt;b&gt;changes&lt;\/b&gt;/);
  assert.doesNotMatch(bad, /<b>/);
  assert.match(bad, /tumwater retire --role improve --force/);
  assert.match(bad, /data-action='enable' data-role='improve'>Enable<\/button>/);
  assert.doesNotMatch(bad, /data-action='retire'/);
});

test("enableRole posts /api/role-enable, flashes the server's message, and refetches", async () => {
  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let refetched = 0;
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "retirecard", "settingscard", "doctorbody", "briefcard"]) els[id] = { innerHTML: "", dataset: {} };
  const { enableRole } = settingsScope({
    $: (id: string) => els[id],
    getJson: async () => { refetched++; return { roles: [] }; },
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { ok: true, message: "improve: enabled" };
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await enableRole("improve");
  assert.deepEqual(posts, [{ path: "/api/role-enable", body: { role: "improve" } }]);
  assert.deepEqual(flashes, ["improve: enabled"]);
  // The card is refetched so the enabled role drops off.
  assert.equal(refetched, 1);
  // A rejected post flashes the error pattern and still refetches.
  const { enableRole: enableFail } = settingsScope({
    $: (id: string) => els[id],
    getJson: async () => ({ roles: [] }),
    postJson: async () => {
      throw { message: "refusing to enable role improve" };
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await enableFail("improve");
  assert.equal(flashes[flashes.length - 1]!, "error: refusing to enable role improve");
});

test("confirmRetire arms on the first click and posts /api/retire on the second", async () => {
  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let armedRole: string | null = null;
  let fail = false;
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "retirecard", "settingscard", "doctorbody", "briefcard"]) els[id] = { innerHTML: "", dataset: {} };
  const { confirmRetire } = settingsScope({
    confirmSlot: () => ({
      armed: (r: string) => armedRole === r,
      arm: (r: string) => { armedRole = r; },
      disarm: () => { armedRole = null; },
    }),
    $: (id: string) => els[id],
    getJson: async () => ({ roles: [] }),
    errorPanel: () => "",
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      if (fail) throw { message: "refusing to retire role improve" };
      return { ok: true, message: "removed the branch (tumwater/improve)" };
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await confirmRetire("improve");
  assert.deepEqual(posts, []);
  await confirmRetire("improve");
  assert.deepEqual(posts, [{ path: "/api/retire", body: { role: "improve" } }]);
  assert.deepEqual(flashes, ["removed the branch (tumwater/improve)"]);
  fail = true;
  await confirmRetire("improve");
  await confirmRetire("improve");
  assert.equal(flashes[1], "error: refusing to retire role improve");
});

test("killOrphansClick arms on the first click and posts /api/kill-orphans on the second", async () => {
  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let armed = false;
  let doctorFetches = 0;
  const button = { textContent: "" };
  const { killOrphansClick, paintKillButton } = settingsScope({
    confirmSlot: () => ({
      armed: () => armed,
      arm: () => { armed = true; },
      disarm: () => { armed = false; },
    }),
    document: { querySelector: () => button },
    $: () => ({ innerHTML: "", dataset: {} }),
    getJson: async () => {
      doctorFetches++;
      return { checks: [] };
    },
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { ok: true, message: "killed pid 4242 node x" };
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await killOrphansClick();
  assert.deepEqual(posts, []);
  paintKillButton();
  assert.equal(button.textContent, "Confirm kill");
  await killOrphansClick();
  assert.deepEqual(posts, [{ path: "/api/kill-orphans", body: {} }]);
  assert.deepEqual(flashes, ["Killing orphaned processes…", "killed pid 4242 node x"]);
  assert.equal(button.textContent, "Kill orphans");
  assert.equal(doctorFetches, 1);
});

test("dropBrokenPinsClick arms on the first click and posts /api/doctor-drop-broken-pins on the second", async () => {
  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let armed = false;
  let doctorFetches = 0;
  const button = { textContent: "" };
  const { dropBrokenPinsClick, paintDropButton } = settingsScope({
    confirmSlot: () => ({
      armed: () => armed,
      arm: () => { armed = true; },
      disarm: () => { armed = false; },
    }),
    document: { querySelector: () => button },
    $: () => ({ innerHTML: "", dataset: {} }),
    getJson: async () => {
      doctorFetches++;
      return { checks: [] };
    },
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { ok: true, message: "1 dropped broken pin: refs/tumwater/merge/broken names 22222222" };
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await dropBrokenPinsClick();
  assert.deepEqual(posts, []);
  paintDropButton();
  assert.equal(button.textContent, "Confirm drop");
  await dropBrokenPinsClick();
  assert.deepEqual(posts, [{ path: "/api/doctor-drop-broken-pins", body: {} }]);
  assert.deepEqual(flashes, ["Dropping broken pins…", "1 dropped broken pin: refs/tumwater/merge/broken names 22222222"]);
  assert.equal(button.textContent, "Drop broken pins");
  assert.equal(doctorFetches, 1);
});

test("retireLeftoversClick arms on the first click and posts /api/doctor-retire-leftovers on the second", async () => {
  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let armed = false;
  let doctorFetches = 0;
  const button = { textContent: "" };
  const { retireLeftoversClick, paintRetireLeftoversButton } = settingsScope({
    confirmSlot: () => ({
      armed: () => armed,
      arm: () => { armed = true; },
      disarm: () => { armed = false; },
    }),
    document: { querySelector: () => button },
    $: () => ({ innerHTML: "", dataset: {} }),
    getJson: async () => {
      doctorFetches++;
      return { checks: [] };
    },
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { ok: true, message: "retired clean: branch" };
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await retireLeftoversClick();
  assert.deepEqual(posts, []);
  paintRetireLeftoversButton();
  assert.equal(button.textContent, "Confirm retire");
  await retireLeftoversClick();
  assert.deepEqual(posts, [{ path: "/api/doctor-retire-leftovers", body: {} }]);
  assert.deepEqual(flashes, ["Retiring every disabled role's leftovers…", "retired clean: branch"]);
  assert.equal(button.textContent, "Retire leftovers");
  assert.equal(doctorFetches, 1);
});

test("retireLeftoversClick flashes `no leftover roles to retire` when the reap retires nothing", async () => {
  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let armed = false;
  const button = { textContent: "" };
  const { retireLeftoversClick, paintRetireLeftoversButton } = settingsScope({
    confirmSlot: () => ({
      armed: () => armed,
      arm: () => { armed = true; },
      disarm: () => { armed = false; },
    }),
    document: { querySelector: () => button },
    $: () => ({ innerHTML: "", dataset: {} }),
    getJson: async () => ({ checks: [] }),
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { ok: true, message: "" };
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await retireLeftoversClick();
  paintRetireLeftoversButton();
  await retireLeftoversClick();
  assert.deepEqual(flashes, ["Retiring every disabled role's leftovers…", "no leftover roles to retire"]);
});

test("archiveBacklogClick arms on the first click and posts /api/doctor-archive-backlog on the second", async () => {
  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let armed = false;
  let doctorFetches = 0;
  const button = { textContent: "" };
  const { archiveBacklogClick, paintArchiveBacklogButton } = settingsScope({
    confirmSlot: () => ({
      armed: () => armed,
      arm: () => { armed = true; },
      disarm: () => { armed = false; },
    }),
    document: { querySelector: () => button },
    $: () => ({ innerHTML: "", dataset: {} }),
    getJson: async () => {
      doctorFetches++;
      return { checks: [] };
    },
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { ok: true, message: "PLANS.md → PLANS-DONE.md: 1 entry; committed aaaaaaaa" };
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await archiveBacklogClick();
  assert.deepEqual(posts, []);
  paintArchiveBacklogButton();
  assert.equal(button.textContent, "Confirm archive");
  await archiveBacklogClick();
  assert.deepEqual(posts, [{ path: "/api/doctor-archive-backlog", body: {} }]);
  assert.deepEqual(flashes, ["Archiving the finished backlog entries…", "PLANS.md → PLANS-DONE.md: 1 entry; committed aaaaaaaa"]);
  assert.equal(button.textContent, "Archive backlog");
  assert.equal(doctorFetches, 1);
});

test("the Health card renders the Archive backlog button with its doctor-archive-backlog action", () => {
  assert.match(GUI_CLIENT_SETTINGS_JS, /data-action='doctor-archive-backlog'/);
  assert.match(GUI_CLIENT_SETTINGS_JS, /Confirm archive/);
  assert.match(GUI_CLIENT_BOOT_JS, /button\[data-action='doctor-archive-backlog'\]/);
});

test("commitBacklogClick posts /api/doctor-commit-backlog and reruns the doctor", async () => {
  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let doctorFetches = 0;
  const { commitBacklogClick } = settingsScope({
    $: () => ({ innerHTML: "", dataset: {} }),
    getJson: async () => {
      doctorFetches++;
      return { checks: [] };
    },
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { ok: true, message: "committed PLANS.md on main" };
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await commitBacklogClick();
  assert.deepEqual(posts, [{ path: "/api/doctor-commit-backlog", body: {} }]);
  assert.deepEqual(flashes, ["Committing the uncommitted backlog/brief files…", "committed PLANS.md on main"]);
  assert.equal(doctorFetches, 1);
});

test("resyncInstallClick posts /api/doctor-resync-install, flashes the re-sync line and reruns the doctor", async () => {
  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let doctorFetches = 0;
  const { resyncInstallClick } = settingsScope({
    $: () => ({ innerHTML: "", dataset: {} }),
    getJson: async () => {
      doctorFetches++;
      return { checks: [] };
    },
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { ok: true, message: "re-synced the root install (a, b) in 1s" };
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await resyncInstallClick();
  assert.deepEqual(posts, [{ path: "/api/doctor-resync-install", body: {} }]);
  assert.deepEqual(flashes, ["Re-syncing the root install…", "re-synced the root install (a, b) in 1s"]);
  assert.equal(doctorFetches, 1);
});

