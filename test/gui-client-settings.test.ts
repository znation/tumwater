import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_JS } from "../src/ui/gui/gui-client.js";
import { GUI_CLIENT_BOOT_JS } from "../src/ui/gui/gui-client-boot.js";
import { GUI_CLIENT_SETTINGS_JS } from "../src/ui/gui/gui-client-settings.js";
import { EDITABLE_CONFIG_KEYS } from "../src/config/config-editable-keys.js";
import { DEFAULT_INSTANCES } from "../src/roles/runner-ids.js";
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
  renderSalvage(d: unknown, armed: (key: string) => boolean, open: unknown, filter: string): string;
  fetchSalvage(): Promise<void>;
  setSalvageFilter(text: string): Promise<void>;
  salvageApplyClick(position: string): Promise<void>;
  salvageDropClick(position: string): Promise<void>;
  salvageViewClick(position: string): Promise<void>;
  paintSalvage(): void;
  renderRetirable(d: unknown, armed: (role: string) => boolean): string;
  renderIssues(d: unknown, open?: unknown, filter?: unknown): string;
  fetchIssues(): Promise<void>;
  setIssuesFilter(next: { state?: string; grep?: string }): Promise<void>;
  currentIssuesFilter(): { state: string; grep: string };
  issueViewClick(position: string): Promise<void>;
  paintIssues(): void;
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
    ["SETTINGS_KEYS", "renderSettings", "fetchSettings", "renderSettingsPanel", "saveSetting", "clearSetting", "renderDoctorReport", "fetchDoctor", "toggleDoctorProblems", "testNotify", "fetchBrief", "saveBrief", "renderSalvage", "fetchSalvage", "setSalvageFilter", "salvageApplyClick", "salvageDropClick", "salvageViewClick", "paintSalvage", "renderRetirable", "fetchRetirable", "enableRole", "confirmRetire", "renderIssues", "fetchIssues", "setIssuesFilter", "currentIssuesFilter", "issueViewClick", "paintIssues", "killOrphansClick", "dropBrokenPinsClick", "retireLeftoversClick", "commitBacklogClick", "archiveBacklogClick", "resyncInstallClick", "paintKillButton", "paintDropButton", "paintRetireLeftoversButton", "paintArchiveBacklogButton"],
    { confirmSlot: (_repaint: unknown) => ({ armed: () => false, disarm: () => {}, arm: () => {} }), ...inject },
  );
}

test("renderSettings renders one row per curated key, esc'd, with the key's config name shown", () => {
  const { renderSettings, SETTINGS_KEYS } = settingsScope();
  const html = renderSettings({ provider: "a&b", model: "gpt-5", fallback: "omlx/free", maxDailyCostUsd: 30, maxConcurrent: 6, "roles.feature.instances": 3, "roles.bugfix.instances": 2, worktreeSlots: 9, quietHours: null, notify: undefined, backends: { pi: { bin: "pi" } }, check: { command: "npm test" } });
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
  // The two instance-role rows render under their labels, beside the run-concurrency rows.
  assert.match(html, /<label for='set-roles\.feature\.instances'>Feature role instances<span class='settings-key'>roles\.feature\.instances<\/span><\/label>/);
  assert.match(html, /<label for='set-roles\.bugfix\.instances'>Bugfix role instances<span class='settings-key'>roles\.bugfix\.instances<\/span><\/label>/);
  assert.match(html, /id='set-roles\.feature\.instances' value='3'/);
  assert.match(html, /id='set-roles\.bugfix\.instances' value='2'/);
  // A count the file leaves unset arrives from GET /api/config as the resolved default
  // (DEFAULT_INSTANCES), so the field shows that number, not an empty box — the panel and the
  // scheduler read the same constant, so the row cannot drift when the default moves.
  const defaultRow = renderSettings({ "roles.feature.instances": DEFAULT_INSTANCES, "roles.bugfix.instances": DEFAULT_INSTANCES });
  assert.match(defaultRow, new RegExp(`id='set-roles\\.feature\\.instances' value='${DEFAULT_INSTANCES}'`));
  assert.match(defaultRow, new RegExp(`id='set-roles\\.bugfix\\.instances' value='${DEFAULT_INSTANCES}'`));
  assert.match(html, /id='set-quietHours' value=''/);
  assert.match(html, /id='set-notify' value=''/);
  // An object value renders as compact JSON (esc'd), so it can round-trip through the field.
  assert.match(html, /id='set-backends' value='\{&quot;pi&quot;:\{&quot;bin&quot;:&quot;pi&quot;\}\}'/);
  assert.match(html, /<label for='set-maxConcurrentChecks'>Max concurrent checks<span class='settings-key'>maxConcurrentChecks<\/span><\/label>/);
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
  // A dotted instance-role key posts its own dotted key with the parsed number.
  const postsInstances: Array<{ path: string; body: unknown }> = [];
  const { saveSetting: saveInstances } = settingsScope({
    postJson: async (path: string, body: unknown) => {
      postsInstances.push({ path, body });
      return { ok: true, key: "roles.feature.instances", value: 3, oldValue: 1 };
    },
    showFlash: () => {},
  });
  await saveInstances({ dataset: { key: "roles.feature.instances" }, querySelector: () => ({ value: "3" }) });
  assert.deepEqual(postsInstances, [{ path: "/api/config-set", body: { key: "roles.feature.instances", value: 3 } }]);
  // An exponent spelling on an instance row is refused in the browser, naming the key.
  const exponentFlashes: string[] = [];
  const { saveSetting: saveExponent } = settingsScope({
    postJson: async () => ({ ok: true }),
    showFlash: (msg: string) => void exponentFlashes.push(msg),
  });
  await saveExponent({ dataset: { key: "roles.feature.instances" }, querySelector: () => ({ value: "2e1" }) });
  assert.deepEqual(exponentFlashes, ["error: roles.feature.instances must be a plain integer — no exponent notation (got \"2e1\")"]);
  // An exponent spelling on the daily-cap row is refused in the browser with the dollar
  // wording: the browser's JSON.parse would turn "1e2" into the number 100 before it reaches
  // setConfigKey, whose exponent guard sees only the re-encoded "100" — so the refusal lives
  // here, where the shape is still visible.
  const dollarFlashes: string[] = [];
  const dollarPosts: Array<{ path: string; body: unknown }> = [];
  const { saveSetting: saveDollar } = settingsScope({
    postJson: async (path: string, body: unknown) => {
      dollarPosts.push({ path, body });
      return { ok: true };
    },
    showFlash: (msg: string) => void dollarFlashes.push(msg),
  });
  await saveDollar({ dataset: { key: "maxDailyCostUsd" }, querySelector: () => ({ value: "1e2" }) });
  assert.deepEqual(dollarFlashes, ["error: maxDailyCostUsd must be a plain dollar amount like 25, 12.50, or .5 — no +/-, exponent, or hex notation (got \"1e2\")"]);
  assert.deepEqual(dollarPosts, []);
  // A plain decimal on the cap row passes the browser screen and posts the parsed number.
  const dollarOkPosts: Array<{ path: string; body: unknown }> = [];
  const { saveSetting: saveDollarOk } = settingsScope({
    postJson: async (path: string, body: unknown) => {
      dollarOkPosts.push({ path, body });
      return { ok: true, unchanged: true };
    },
    showFlash: () => {},
  });
  await saveDollarOk({ dataset: { key: "maxDailyCostUsd" }, querySelector: () => ({ value: "12.50" }) });
  assert.deepEqual(dollarOkPosts, [{ path: "/api/config-set", body: { key: "maxDailyCostUsd", value: 12.5 } }]);
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
  assert.match(GUI_CLIENT_BOOT_JS, /if \(v === "settings"\) \{ fetchSettings\(\); fetchDoctor\(\); fetchSalvage\(\); fetchRetirable\(\); fetchBrief\(\); fetchIssues\(\); \}/);
  assert.match(GUI_CLIENT_BOOT_JS, /button\[data-action='retire'\]/);
  // The salvage card's per-patch buttons are delegated like the retire ones.
  assert.match(GUI_CLIENT_BOOT_JS, /button\[data-action='salvage-apply'\]/);
  assert.match(GUI_CLIENT_BOOT_JS, /button\[data-action='salvage-drop'\]/);
  assert.match(GUI_CLIENT_BOOT_JS, /button\[data-action='salvage-view'\]/);
  assert.match(GUI_CLIENT_BOOT_JS, /salvageViewClick\(salView\.dataset\.position\)/);
  // The card's search box rides the same document change delegate as the Health checkbox, and
  // hands its trimmed value to setSalvageFilter.
  assert.match(GUI_CLIENT_BOOT_JS, /input\[data-action='salvage-grep'\]/);
  assert.match(GUI_CLIENT_BOOT_JS, /setSalvageFilter\(grep\.value\.trim\(\)\)/);
  assert.match(clientRegion("settings-view"), /data-action='salvage-grep'/);
  // The issues card's per-row View button is delegated the same way, addressed by position.
  assert.match(GUI_CLIENT_BOOT_JS, /button\[data-action='issues-view'\]/);
  assert.match(GUI_CLIENT_BOOT_JS, /issueViewClick\(issView\.dataset\.position\)/);
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
  assert.match(GUI_CLIENT_BOOT_JS, /clickClosest\(ev, "form\.brief-form"\)[\s\S]*?saveBrief\(form\)/);
  assert.match(GUI_CLIENT_BOOT_JS, /clickClosest\(ev, "form\.settings-row"\)[\s\S]*?saveSetting\(form\)/);
  assert.doesNotMatch(clientRegion("settings-view").slice(clientRegion("settings-view").indexOf("async function fetchBrief")), /settings-row/);
});

test("renderSalvage renders one row per patch with View, Apply and Drop, the empty sentence, and the confirm labels", () => {
  const { renderSalvage } = settingsScope();
  // An empty list is the CLI's empty sentence, no rows.
  assert.match(renderSalvage({ patches: [] }, () => false, null, ""), /no salvaged workspace patches are kept for you/);
  assert.doesNotMatch(renderSalvage({ patches: [] }, () => false, null, ""), /data-action='salvage-apply'/);
  // Two patches: each row carries its position, file, saved-ago, size, prune deadline and both
  // buttons.
  const now = Date.now();
  const d = { patches: [
    { position: 1, file: "a.patch", savedAt: now - 3 * 3600_000, bytes: 38, size: "38 B", prune: "prune deadline in 21h" },
    { position: 2, file: "b.patch", savedAt: now - 1000, bytes: 17, size: "17 B", prune: "retention is off, so this patch is never pruned" },
  ] };
  const html = renderSalvage(d, () => false, null, "");
  assert.match(html, /<strong>1\. a\.patch<\/strong>/);
  assert.match(html, /saved 3h ago, 38 B, prune deadline in 21h/);
  assert.match(html, /saved just now, 17 B, retention is off, so this patch is never pruned/);
  // Each clause sits in the same row element as that patch's own buttons — the operator reads
  // the deadline off the row they are about to act on, not off another row.
  const rows = html.split("<div class='settings-row'>").filter((r) => /data-action='salvage-(view|apply|drop)'/.test(r));
  assert.equal(rows.length, 2, "one row element per patch");
  assert.ok(rows[0]!.includes("prune deadline in 21h") && rows[0]!.includes("data-position='1'"));
  assert.ok(rows[1]!.includes("retention is off, so this patch is never pruned") && rows[1]!.includes("data-position='2'"));
  assert.match(html, /data-action='salvage-view' data-position='1'>View<\/button>/);
  assert.match(html, /data-action='salvage-apply' data-position='1'>Apply<\/button>/);
  assert.match(html, /data-action='salvage-drop' data-position='1'>Drop<\/button>/);
  assert.match(html, /data-action='salvage-apply' data-position='2'>Apply<\/button>/);
  // A file with HTML is esc'd, in its file name and in its prune clause.
  const bad = renderSalvage({ patches: [{ position: 1, file: "<x>.patch", savedAt: now, bytes: 5, size: "5 B", prune: "prune deadline in <7d>" }] }, () => false, null, "");
  assert.match(bad, /&lt;x&gt;\.patch/);
  assert.match(bad, /prune deadline in &lt;7d&gt;/);
  // A record with no prune field (an older server) renders the row with no clause and no
  // trailing separator.
  const older = renderSalvage({ patches: [{ position: 1, file: "a.patch", savedAt: now, bytes: 5, size: "5 B" }] }, () => false, null, "");
  assert.match(older, /saved just now, 5 B<\/span>/);
  // The armed apply key repaints only its own Apply button as a confirm; the same position's
  // Drop button stays un-armed.
  assert.match(renderSalvage(d, (k) => k === "apply:1", null, ""), /data-action='salvage-apply' data-position='1'>Confirm apply<\/button>/);
  assert.doesNotMatch(renderSalvage(d, (k) => k === "apply:1", null, ""), /data-position='1'>Confirm drop<\/button>/);
  assert.match(renderSalvage(d, (k) => k === "drop:2", null, ""), /data-action='salvage-drop' data-position='2'>Confirm drop<\/button>/);
  // No open slot means no row paints a body, and every View button reads "View".
  assert.doesNotMatch(html, /<pre class='mono/);
  assert.doesNotMatch(html, /Hide<\/button>/);
});

// The card's search box and the count line it drives. A filtered row keeps its whole-list
// number, so the buttons address the same patch as tumwater salvage --show/--apply/--drop.
test("renderSalvage paints the search box, the matching-filter count line, and the CLI's no-match sentence", () => {
  const { renderSalvage } = settingsScope();
  const now = Date.now();
  const filtered = {
    patches: [{ position: 3, file: "c.patch", savedAt: now, bytes: 5, size: "5 B", prune: "prune deadline in 7d" }],
    total: 9,
  };
  const html = renderSalvage(filtered, () => false, null, "c");
  // The box carries the filter back, so a repaint keeps what the operator typed.
  assert.match(html, /data-action='salvage-grep'[^>]*value='c'/);
  // The surviving row keeps its whole-list number on every button, plus its prune clause.
  assert.match(html, /<strong>3\. c\.patch<\/strong>/);
  assert.match(html, /data-action='salvage-view' data-position='3'>View<\/button>/);
  assert.match(html, /data-action='salvage-apply' data-position='3'>Apply<\/button>/);
  assert.match(html, /data-action='salvage-drop' data-position='3'>Drop<\/button>/);
  assert.match(html, /saved just now, 5 B, prune deadline in 7d/);
  assert.match(html, /Showing 1 of 9 patches matching this filter\./);
  // No filter: the box paints with an empty value and the count line is absent — the card reads
  // exactly as it did before the search existed.
  const plain = renderSalvage(filtered, () => false, null, "");
  assert.match(plain, /data-action='salvage-grep'[^>]*value=''/);
  assert.doesNotMatch(plain, /patches matching this filter/);
  // A filter that matched nothing reads the CLI's own no-match sentence, quoted with the text.
  assert.match(
    renderSalvage({ patches: [], total: 9 }, () => false, null, "zz"),
    /no salvaged workspace patches match "zz"/,
  );
  assert.match(renderSalvage({ patches: [], total: 9 }, () => false, null, "zz"), /Showing 0 of 9 patches matching this filter\./);
  // An unfiltered empty dir keeps the existing empty sentence, with no rows to act on.
  const empty = renderSalvage({ patches: [] }, () => false, null, "");
  assert.match(empty, /no salvaged workspace patches are kept for you/);
  assert.doesNotMatch(empty, /data-action='salvage-apply'/);
  // A payload with no total (an older server) still paints the sentence, with 0.
  assert.match(
    renderSalvage({ patches: [{ position: 1, file: "a.patch", savedAt: now, bytes: 5, size: "5 B" }] }, () => false, null, "a"),
    /Showing 1 of 0 patches matching this filter\./,
  );
});

// The search box's handler: repaint from the cached list at once, then refetch with the text as
// ?q=, encoded, and never a bare "?".
test("setSalvageFilter repaints from the cache at once and asks the endpoint with ?q=, empty text included", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard"]) els[id] = { innerHTML: "", dataset: {} };
  const paths: string[] = [];
  const { setSalvageFilter } = settingsScope({
    $: (id: string) => els[id],
    getJson: async (path: string) => {
      paths.push(path);
      return { patches: [{ position: 2, file: "b.patch", savedAt: Date.now(), bytes: 17, size: "17 B" }], total: 3 };
    },
  });
  await setSalvageFilter("a b");
  // The text reaches the endpoint encoded, and the painted card shows the filter and the row's
  // whole-list number.
  assert.deepEqual(paths, ["/api/salvage?q=a%20b"]);
  assert.match(els["salvagecard"]!.innerHTML, /value='a b'/);
  assert.match(els["salvagecard"]!.innerHTML, /<strong>2\. b\.patch<\/strong>/);
  assert.match(els["salvagecard"]!.innerHTML, /Showing 1 of 3 patches matching this filter\./);
  // Clearing it asks for the unfiltered list — never a trailing bare "?".
  await setSalvageFilter("");
  assert.deepEqual(paths, ["/api/salvage?q=a%20b", "/api/salvage"]);
  assert.doesNotMatch(els["salvagecard"]!.innerHTML, /patches matching this filter/);
});

test("setSalvageFilter repaints a cached card before it refetches, so the box keeps the typed text", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard"]) els[id] = { innerHTML: "", dataset: {} };
  const seen: Array<{ path: string; card: string }> = [];
  const { fetchSalvage, setSalvageFilter } = settingsScope({
    $: (id: string) => els[id],
    getJson: async (path: string) => {
      seen.push({ path, card: els["salvagecard"]!.innerHTML });
      return { patches: [{ position: 1, file: "a.patch", savedAt: Date.now(), bytes: 38, size: "38 B" }], total: 1 };
    },
  });
  await fetchSalvage();
  await setSalvageFilter("a");
  // The second read is the filtered one, and the card it was painted over already carries the
  // typed filter — the repaint from the cache happened before the request.
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.path, "/api/salvage?q=a");
  assert.match(seen[1]!.card, /value='a'/);
});

test("fetchSalvage loads GET /api/salvage and paints the card; a failure renders the error panel", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard", "retirecard", "briefcard", "doctorcard"]) els[id] = { innerHTML: "", dataset: {} };
  const { fetchSalvage } = settingsScope({
    $: (id: string) => els[id],
    getJson: async (path: string) => {
      assert.equal(path, "/api/salvage");
      return { patches: [{ position: 1, file: "a.patch", savedAt: Date.now(), bytes: 38, size: "38 B" }] };
    },
  });
  await fetchSalvage();
  assert.match(els["salvagecard"]!.innerHTML, /<strong>1\. a\.patch<\/strong>/);
  assert.match(els["salvagecard"]!.innerHTML, /data-action='salvage-apply' data-position='1'>Apply<\/button>/);
  // A GET that fails renders the card's error panel, not a crash.
  const els2: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard"]) els2[id] = { innerHTML: "", dataset: {} };
  const { fetchSalvage: fetchFail } = settingsScope({
    $: (id: string) => els2[id],
    getJson: async () => { throw { message: "salvage read failed" }; },
    errorPanel: () => "<div class='empty'>salvage error panel</div>",
  });
  await fetchFail();
  assert.equal(els2["salvagecard"]!.innerHTML, "<div class='empty'>salvage error panel</div>");
});

test("salvageApplyClick arms on the first click and posts { position } to /api/salvage-apply on the second", async () => {
  const flashes: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  let refetched = 0;
  let armedKey: string | null = null;
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard", "retirecard", "briefcard"]) els[id] = { innerHTML: "", dataset: {} };
  const { salvageApplyClick, salvageDropClick } = settingsScope({
    confirmSlot: () => ({
      armed: (k: string) => armedKey === k,
      arm: (k: string) => { armedKey = k; },
      disarm: () => { armedKey = null; },
    }),
    $: (id: string) => els[id],
    getJson: async () => { refetched++; return { patches: [] }; },
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      const position = (body as { position: number }).position;
      return path === "/api/salvage-drop"
        ? { ok: true, message: `dropped salvaged workspace patch ${position}: a.patch` }
        : { ok: true, message: `applied salvaged workspace patch ${position}: a.patch` };
    },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await salvageApplyClick("1");
  assert.deepEqual(posts, [], "the first click only arms");
  assert.equal(armedKey, "apply:1");
  await salvageApplyClick("1");
  assert.deepEqual(posts, [{ path: "/api/salvage-apply", body: { position: 1 } }]);
  assert.deepEqual(flashes, ["applied salvaged workspace patch 1: a.patch"]);
  assert.equal(refetched, 1, "the card refetches after the apply");
  // A different position posts its own position, not the first's.
  posts.length = 0;
  await salvageApplyClick("2");
  await salvageApplyClick("2");
  assert.deepEqual(posts, [{ path: "/api/salvage-apply", body: { position: 2 } }]);
  // Drop posts to the drop endpoint with the same two-click shape.
  posts.length = 0;
  flashes.length = 0;
  await salvageDropClick("1");
  assert.deepEqual(posts, [], "the first drop click only arms");
  await salvageDropClick("1");
  assert.deepEqual(posts, [{ path: "/api/salvage-drop", body: { position: 1 } }]);
  assert.deepEqual(flashes, ["dropped salvaged workspace patch 1: a.patch"]);
});

test("salvageApplyClick flashes the server's error and still refetches when the post rejects", async () => {
  const flashes: string[] = [];
  let refetched = 0;
  let armedKey: string | null = null;
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard", "retirecard", "briefcard"]) els[id] = { innerHTML: "", dataset: {} };
  const { salvageApplyClick } = settingsScope({
    confirmSlot: () => ({
      armed: (k: string) => armedKey === k,
      arm: (k: string) => { armedKey = k; },
      disarm: () => { armedKey = null; },
    }),
    $: (id: string) => els[id],
    getJson: async () => { refetched++; return { patches: [] }; },
    postJson: async () => { throw { message: "salvage --apply needs a git checkout" }; },
    showFlash: (msg: string) => void flashes.push(msg),
  });
  await salvageApplyClick("1");
  await salvageApplyClick("1");
  assert.equal(flashes[flashes.length - 1]!, "error: salvage --apply needs a git checkout");
  assert.equal(refetched, 1, "a failed apply still refetches the card");
});

test("salvageViewClick fetches the row's patch once, opens only that row, and a second click closes it without refetching", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard", "retirecard", "briefcard"]) els[id] = { innerHTML: "", dataset: {} };
  const now = Date.now();
  const fetched: string[] = [];
  const { fetchSalvage, salvageViewClick } = settingsScope({
    $: (id: string) => els[id],
    getJson: async (path: string) => {
      fetched.push(path);
      if (path === "/api/salvage") {
        return { patches: [
          { position: 1, file: "a.patch", savedAt: now - 3 * 3600_000, bytes: 38, size: "38 B" },
          { position: 2, file: "b.patch", savedAt: now - 1000, bytes: 17, size: "17 B" },
        ] };
      }
      // The show endpoint's reply for the position asked for, built from the seeded files: the
      // position in the query decides which patch comes back, so a swapped field would land the
      // wrong text under the row.
      const n = Number(new URL("http://x" + path).searchParams.get("position"));
      return n === 2
        ? { position: 2, file: "b.patch", savedAt: now - 1000, bytes: 17, size: "17 B", stat: null, patch: "+second\n" }
        : { position: 1, file: "a.patch", savedAt: now - 3 * 3600_000, bytes: 38, size: "38 B",
            stat: " f | 2 +-\n1 file changed",
            patch: "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n<script>gone</script>\n" };
    },
  });
  await fetchSalvage();
  // Row 2's View: the read is a read-only GET on that position, and the text reaches the card
  // escaped — the <script> in patch 1's text must stay text when row 1 is opened below.
  await salvageViewClick("2");
  assert.deepEqual(fetched.slice(1), ["/api/salvage-show?position=2"]);
  assert.match(els["salvagecard"]!.innerHTML, /<pre class='mono diff'>\+second\n<\/pre>/);
  assert.match(els["salvagecard"]!.innerHTML, /<div class='sub'>2\. b\.patch — saved just now, 17 B<\/div>/);
  // A stat-less patch paints no stat block.
  assert.equal(els["salvagecard"]!.innerHTML.match(/<pre class='mono'>/g), null, "a null stat paints no stat block");
  // The open row's View button is a collapse; the other row's is still View.
  assert.match(els["salvagecard"]!.innerHTML, /data-action='salvage-view' data-position='2'>Hide<\/button>/);
  assert.match(els["salvagecard"]!.innerHTML, /data-action='salvage-view' data-position='1'>View<\/button>/);
  // A second click on the open row collapses it, asking the server nothing.
  await salvageViewClick("2");
  assert.deepEqual(fetched.slice(1), ["/api/salvage-show?position=2"], "collapsing never refetches");
  assert.doesNotMatch(els["salvagecard"]!.innerHTML, /<pre class='mono diff'>/);
  // Opening row 1 closes row 2 and paints its own header, stat block and escaped text.
  await salvageViewClick("1");
  assert.deepEqual(fetched.slice(1), ["/api/salvage-show?position=2", "/api/salvage-show?position=1"]);
  const card = els["salvagecard"]!.innerHTML;
  assert.equal(card.match(/<pre class='mono diff'>/g)!.length, 1, "one row is open at a time");
  assert.match(card, /<pre class='mono'> f \| 2 \+-<\/pre>|<pre class='mono'> f \| 2 \+-/);
  assert.match(card, /1 file changed<\/pre>/);
  assert.match(card, /&lt;script&gt;gone&lt;\/script&gt;/);
  assert.doesNotMatch(card, /<script>/, "the patch text never reaches the DOM as markup");
  assert.match(card, /<div class='sub'>1\. a\.patch — saved 3h ago, 38 B<\/div>/);
  assert.doesNotMatch(card, /<div class='sub'>2\. b\.patch/);
});

test("a salvage View read that fails shows the server's sentence in that row and leaves Apply and Drop working", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard", "retirecard", "briefcard"]) els[id] = { innerHTML: "", dataset: {} };
  const now = Date.now();
  const posts: Array<{ path: string; body: unknown }> = [];
  let armedKey: string | null = null;
  const scope = settingsScope({
    confirmSlot: () => ({ armed: (k: string) => armedKey === k, arm: (k: string) => { armedKey = k; }, disarm: () => { armedKey = null; } }),
    $: (id: string) => els[id],
    getJson: async (path: string) => {
      if (path === "/api/salvage") {
        return { patches: [{ position: 1, file: "a.patch", savedAt: now, bytes: 38, size: "38 B" }] };
      }
      // The endpoint answers an off-list position 200 { ok: false, message }.
      return { ok: false, message: "no salvaged workspace patch at position 7 (salvage holds 1 patch) — valid: 1-1" };
    },
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { ok: true, message: "applied salvaged workspace patch 1: a.patch" };
    },
    showFlash: () => {},
  });
  await scope.fetchSalvage();
  await scope.salvageViewClick("1");
  // The row holds the server's sentence, no patch body, and its buttons intact.
  const card = els["salvagecard"]!.innerHTML;
  assert.doesNotMatch(card, /<pre class='mono diff'>/);
  assert.match(card, /<div class='empty'>no salvaged workspace patch at position 7 \(salvage holds 1 patch\) — valid: 1-1<\/div>/);
  assert.match(card, /data-action='salvage-apply' data-position='1'>Apply<\/button>/);
  // Apply still arms and posts the same { position } body after a failed read.
  await scope.salvageApplyClick("1");
  assert.deepEqual(posts, [], "the first click only arms");
  await scope.salvageApplyClick("1");
  assert.deepEqual(posts, [{ path: "/api/salvage-apply", body: { position: 1 } }]);
});

test("salvageViewClick shows the transport error in the row when the read rejects", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard", "retirecard", "briefcard"]) els[id] = { innerHTML: "", dataset: {} };
  const { fetchSalvage, salvageViewClick } = settingsScope({
    $: (id: string) => els[id],
    getJson: async (path: string) => {
      if (path === "/api/salvage") return { patches: [{ position: 1, file: "a.patch", savedAt: Date.now(), bytes: 38, size: "38 B" }] };
      throw { message: "could not read salvaged patch a.patch" };
    },
  });
  await fetchSalvage();
  await salvageViewClick("1");
  assert.match(els["salvagecard"]!.innerHTML, /<div class='empty'>could not read salvaged patch a\.patch<\/div>/);
});

test("renderSalvage splices the open body only into the row its file still matches", () => {
  const { renderSalvage } = settingsScope();
  const now = Date.now();
  // A refetch after a drop renumbers the list: the kept patch is now position 1, and the body
  // fetched for it must land under that row, never under another patch's row.
  const d = { patches: [
    { position: 1, file: "b.patch", savedAt: now - 1000, bytes: 17, size: "17 B" },
    { position: 2, file: "c.patch", savedAt: now - 1000, bytes: 5, size: "5 B" },
  ] };
  const open = { position: 1, file: "b.patch", body: { position: 1, file: "b.patch", savedAt: now - 1000, size: "17 B", stat: null, patch: "+kept\n" } };
  const html = renderSalvage(d, () => false, open, "");
  // The patch text reaches the pre verbatim, its trailing newline intact.
  assert.match(html, /<pre class='mono diff'>\+kept\n<\/pre>/);
  // The body sits inside the b.patch row, not the c.patch row.
  const bRow = html.slice(html.indexOf("b.patch"), html.indexOf("c.patch"));
  assert.match(bRow, /<pre class='mono diff'>\+kept\n<\/pre>/);
  assert.doesNotMatch(html.slice(html.indexOf("c.patch")), /<pre class='mono diff'>/);
  // A body whose file no longer matches any listed row is dropped: a patch read never appears
  // under a different patch's header.
  assert.doesNotMatch(renderSalvage(d, () => false, { position: 1, file: "gone.patch", body: open.body }, ""), /<pre class='mono diff'>/);
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


// The GitHub issues card (the fifth Settings card): the mirror read the dashboard serves at
// GET /api/issues, painted here. The expectations are worked out from the document the endpoint
// is pinned to answer by test/gui-issues.test.ts — positions, counts and the age inputs — never
// read back out of renderIssues, so a wrong count source or a swapped age segment fails.

const ISSUES_DOC = (now: number) => ({
  read: true,
  empty: false,
  repo: "znation/proj",
  branch: "main",
  checkedAt: now - 3 * 3_600_000,
  gh: "ok",
  openCount: 2,
  closedCount: 1,
  upstreamClosedCount: 0,
  issues: [
    {
      position: 1, number: 4, title: "Fourth & <b>bold</b>",
      url: "https://github.com/znation/proj/issues/4",
      author: "zach", trusted: true, mirrored: true, labels: [],
      updatedAt: new Date(now - 3 * 3_600_000).toISOString(),
    },
    {
      position: 2, number: 7, title: "Seventh", url: "",
      author: "bot", trusted: false, mirrored: false, labels: [],
      updatedAt: new Date(now - 2 * 86_400_000).toISOString(),
    },
    {
      position: 3, number: 2, title: "Second",
      url: "https://github.com/znation/proj/issues/2",
      author: "zach", trusted: true, mirrored: true, labels: [], wasClosed: true,
      updatedAt: new Date(now - 30 * 60_000).toISOString(),
    },
  ],
});

test("renderIssues states the mirror's counts in tumwater issues' words and numbers every row", () => {
  const now = Date.now();
  const { renderIssues } = settingsScope();
  const html = renderIssues(ISSUES_DOC(now));
  // The card's own header row, in the CLI's counting words over the whole mirror: two open, one
  // closed by tumwater, no upstream clause while that count is 0. The controls row sits above it.
  assert.match(html, /^<div class='settings-row'><label><span class='sr-only'>State<\/span><select class='field' data-action='issues-state'><option value='' selected>All states<\/option><option value='open'>Open<\/option><option value='closed'>Closed<\/option><option value='lost'>Lost<\/option><\/select><\/label><label><span class='sr-only'>Search<\/span><input class='field' data-action='issues-grep' type='search' placeholder='Search issues…' autocomplete='off' value=''><\/label><\/div><div class='settings-row'><strong>GitHub issues<\/strong><span>znation\/proj \(main\): 2 open, 1 closed by tumwater, checked 3h ago<\/span><\/div>/);
  assert.equal(html.match(/closed upstream/g), null, "a zero upstream-close count keeps its clause out");
  // Each row: its whole-list position and issue number, the title linked to GitHub and escaped.
  assert.match(html, /<strong>1\. #4 <a rel='noopener' target='_blank' href='https:\/\/github\.com\/znation\/proj\/issues\/4'>Fourth &amp; &lt;b&gt;bold&lt;\/b&gt;<\/a><\/strong>/);
  // A row with no url paints plain escaped text, no anchor.
  assert.match(html, /<strong>2\. #7 Seventh<\/strong>/);
  // The mirror state and the trust marker, in tumwater issues' words.
  assert.match(html, /<span>mirrored<\/span><span>trusted<\/span>/);
  assert.match(html, /<span>not mirrored<\/span><span class='pill t-amber'>untrusted<\/span>/);
  // The age segment: `updated <ago>` for a live row, `closed <ago>` for the row tumwater closed.
  // Each row ends with its own View button, addressed by its whole-list position — the twin of
  // tumwater issues --show <n> — and every listed row gets one, closed and lost rows included.
  assert.match(html, /<span>updated 3h ago<\/span><button type='button' class='btn btn-sm' data-action='issues-view' data-position='1'>View<\/button><\/div>/);
  assert.match(html, /<span>updated 2d ago<\/span><button type='button' class='btn btn-sm' data-action='issues-view' data-position='2'>View<\/button><\/div>/);
  assert.match(html, /<span>closed 30m ago<\/span><button type='button' class='btn btn-sm' data-action='issues-view' data-position='3'>View<\/button><\/div>/);
  assert.equal((html.match(/data-action='issues-view'/g) || []).length, 3, "one View button per listed row, none for the header");
  // An ok gate state paints no gate line.
  assert.doesNotMatch(html, /gh /);
});

test("renderIssues keeps the header counts at the whole mirror whatever rows arrived, and says an empty mirror in words", () => {
  const { renderIssues } = settingsScope();
  const now = Date.now();
  // A mirror with nothing on record but a scan: read, empty lists, no rows.
  const read = renderIssues({ ...ISSUES_DOC(now), openCount: 0, closedCount: 0, issues: [] });
  assert.match(read, /<div class='empty'>no issues to show<\/div>/);
  assert.match(read, /: 0 open, checked 3h ago<\/span><\/div>/);
  // No ledger at all: the card says the state in words and names no repo and no counts, so a
  // never-read mirror never reads as an empty mirror.
  const unread = renderIssues({ read: false, empty: true, openCount: 0, closedCount: 0, upstreamClosedCount: 0, issues: [] });
  assert.match(unread, /<div class='empty'>the GitHub issues mirror has not been read yet<\/div>/);
  assert.match(unread, /<strong>GitHub issues<\/strong><span><\/span><\/div>/);
  assert.doesNotMatch(unread, /znation/, "an unread mirror names no repo");
  // The picker's own option values name states, so the counts guard reads the counts' shape — a
  // number before "open," — never the bare word.
  assert.doesNotMatch(unread, /\d+ open,/, "an unread mirror names no counts");
  assert.doesNotMatch(unread, /Showing/, "an unread mirror names no matching-issues sentence");
  // A filtered frame that keeps nothing still states the whole mirror's counts (INV-DE3). The
  // filter is the card's own, never the payload's echoed `state`: an endpoint reply that carries
  // state="closed" but reaches the card with no filter set still says All states, names no
  // matching-issues sentence, and keeps the unfiltered empty copy.
  const filtered = renderIssues({ ...ISSUES_DOC(now), issues: [], state: "closed" });
  assert.match(filtered, /: 2 open, 1 closed by tumwater, checked 3h ago<\/span>/);
  assert.match(filtered, /<div class='empty'>no issues to show<\/div>/);
  assert.match(filtered, /<option value='' selected>All states<\/option>/, "the payload's echoed state never preselects the picker");
  assert.doesNotMatch(filtered, /Showing/, "an unfiltered read names no matching-issues sentence");
});

test("renderIssues prints a not-ok gh gate line with the ledger's reason, and the CLI's unknown-age words", () => {
  const { renderIssues } = settingsScope();
  const now = Date.now();
  const gated = renderIssues({ ...ISSUES_DOC(now), gh: "unauthenticated", reason: "gh auth status failed", issues: [] });
  assert.match(gated, /^<div class='settings-row'>.*<\/div><p class='empty'>gh unauthenticated: gh auth status failed<\/p>/);
  // A ledger row with no usable timestamp has no age to name, so the card says so rather than
  // printing NaN — the CLI's issueAge rule.
  const undated = renderIssues({
    ...ISSUES_DOC(now),
    issues: [
      { position: 1, number: 4, title: "Fourth", url: "", author: "zach", trusted: true, mirrored: true, labels: [], updatedAt: "not a date" },
      { position: 2, number: 2, title: "Second", url: "", author: "zach", trusted: true, mirrored: true, labels: [], wasClosed: true, updatedAt: "not a date" },
      { position: 3, number: 9, title: "Lost", url: "", author: "zach", trusted: true, mirrored: false, labels: [], upstreamClosed: true, updatedAt: "not a date" },
    ],
  });
  assert.match(undated, /<span>updated unknown<\/span>/);
  assert.match(undated, /<span>closed unknown<\/span>/);
  // An issue GitHub lost is never phrased as a close tumwater made.
  assert.match(undated, /<span>last seen unknown<\/span>/);
  assert.equal((undated.match(/data-action='issues-view'/g) || []).length, 3, "a lost row gets its View button too");
  const lost = renderIssues({
    ...ISSUES_DOC(now),
    upstreamClosedCount: 1,
    issues: [{ position: 1, number: 9, title: "Lost", url: "", author: "zach", trusted: true, mirrored: false, labels: [], upstreamClosed: true, updatedAt: new Date(now - 2 * 86_400_000).toISOString() }],
  });
  assert.match(lost, /: 2 open, 1 closed by tumwater, 1 closed upstream, checked 3h ago<\/span>/);
  assert.match(lost, /<span>last seen open 2d ago<\/span>/);
  assert.doesNotMatch(lost, /closed 2d ago/, "a lost issue is never printed as closed by tumwater");
});

test("issueViewClick fetches the row's detail once, opens only that row, and a second click closes it without refetching", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard", "retirecard", "briefcard", "issuescard"]) els[id] = { innerHTML: "", dataset: {} };
  const now = Date.now();
  const fetched: string[] = [];
  const { fetchIssues, issueViewClick } = settingsScope({
    $: (id: string) => els[id],
    getJson: async (path: string) => {
      fetched.push(path);
      if (path === "/api/issues") return ISSUES_DOC(now);
      // The show endpoint's reply for the position asked for, built from ISSUES_DOC's rows: the
      // position in the query decides which issue comes back, so a swapped field would land the
      // wrong detail under the row.
      const n = Number(new URL("http://x" + path).searchParams.get("position"));
      return n === 2
        ? { position: 2, number: 7, title: "Seventh", text: "issue 2: #7 — Seventh\n  url: \n  updated: x\n  declined 2d ago: not mirrored" }
        : { position: 1, number: 4, title: "Fourth", text: "issue 1: #4 — Fourth & <b>bold</b>\n  body excerpt:\n    the lock file survives\n    <script>gone</script>" };
    },
  });
  await fetchIssues();
  // Row 2's View: a read-only GET on that position, and the CLI's detail text reaches the card.
  await issueViewClick("2");
  assert.deepEqual(fetched.slice(1), ["/api/issues-show?position=2"]);
  assert.match(els["issuescard"]!.innerHTML, /<pre class='mono'>issue 2: #7 — Seventh[\s\S]*declined 2d ago: not mirrored<\/pre>/);
  // The open row's View button is a collapse; the other rows' are still View.
  assert.match(els["issuescard"]!.innerHTML, /data-action='issues-view' data-position='2'>Hide<\/button>/);
  assert.match(els["issuescard"]!.innerHTML, /data-action='issues-view' data-position='1'>View<\/button>/);
  // A second click on the open row collapses it, asking the server nothing.
  await issueViewClick("2");
  assert.deepEqual(fetched.slice(1), ["/api/issues-show?position=2"], "collapsing never refetches");
  assert.doesNotMatch(els["issuescard"]!.innerHTML, /<pre class='mono'>issue 2/);
  // Opening row 1 closes row 2, and the detail text is escaped — the <script> in its excerpt stays
  // text, and so does the markup in the title the server names.
  await issueViewClick("1");
  assert.deepEqual(fetched.slice(1), ["/api/issues-show?position=2", "/api/issues-show?position=1"]);
  const card = els["issuescard"]!.innerHTML;
  assert.equal(card.match(/<pre class='mono'>issue /g)!.length, 1, "one row is open at a time");
  assert.match(card, /Fourth &amp; &lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(card, /&lt;script&gt;gone&lt;\/script&gt;/);
  assert.doesNotMatch(card, /<script>/, "an issue's text never reaches the DOM as markup");
});

test("an issues View read the endpoint refused shows that sentence in the row and leaves the card intact", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard", "retirecard", "briefcard", "issuescard"]) els[id] = { innerHTML: "", dataset: {} };
  const { fetchIssues, issueViewClick } = settingsScope({
    $: (id: string) => els[id],
    getJson: async (path: string) => {
      if (path === "/api/issues") return ISSUES_DOC(Date.now());
      // The endpoint answers a position the fresh ledger does not hold 200 { ok: false, message }.
      return { ok: false, message: "no GitHub issue at position 3 (github issues mirror holds 2 issues) — valid: 1-2" };
    },
  });
  await fetchIssues();
  // A row the card listed but the fresh ledger no longer holds at that position (the mirror scan
  // ran again between the two reads): the detail read misses, and its sentence lands in that row.
  await issueViewClick("3");
  const card = els["issuescard"]!.innerHTML;
  assert.match(card, /<div class='empty'>no GitHub issue at position 3 \(github issues mirror holds 2 issues\) — valid: 1-2<\/div>/);
  assert.doesNotMatch(card, /<pre class='mono'>/, "a refused read paints no detail body");
  assert.match(card, /data-action='issues-view' data-position='3'>Hide<\/button>/, "the open row still offers its collapse");
  // The card stays listed and every row keeps its View button, so a miss is readable, not a break.
  assert.equal((card.match(/data-action='issues-view'/g) || []).length, 3);
});

test("issueViewClick shows the transport error in the row when the detail read rejects", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard", "retirecard", "briefcard", "issuescard"]) els[id] = { innerHTML: "", dataset: {} };
  const { fetchIssues, issueViewClick } = settingsScope({
    $: (id: string) => els[id],
    getJson: async (path: string) => {
      if (path === "/api/issues") return ISSUES_DOC(Date.now());
      throw { message: "GET /api/issues-show failed: HTTP 500 — broken ledger" };
    },
  });
  await fetchIssues();
  await issueViewClick("1");
  assert.match(els["issuescard"]!.innerHTML, /<div class='empty'>GET \/api\/issues-show failed: HTTP 500 — broken ledger<\/div>/);
});

test("renderIssues splices the open body only into the row its position still matches", () => {
  const { renderIssues } = settingsScope();
  const now = Date.now();
  // The mirror's positions are the whole list's, so a refetch of the same ledger keeps them; the
  // slot keyed on position 3 lands under that row and nowhere else.
  const open = { position: 3, body: { position: 3, number: 2, title: "Second", text: "issue 3: #2 — Second\n  closed 30m ago: abc1234" } };
  const html = renderIssues(ISSUES_DOC(now), open);
  assert.match(html, /<pre class='mono'>issue 3: #2 — Second[\s\S]*closed 30m ago: abc1234<\/pre><\/div>/);
  assert.equal(html.match(/<pre class='mono'>/g)!.length, 1, "the body is spliced into one row");
  assert.match(html, /data-action='issues-view' data-position='3'>Hide<\/button><pre/);
  assert.match(html, /data-action='issues-view' data-position='1'>View<\/button><\/div>/);
  // A slot whose position no longer arrives (the mirror was re-scanned and the issue was dropped)
  // paints no body at all, rather than leaving an orphan panel under another row.
  const gone = renderIssues({ ...ISSUES_DOC(now), issues: ISSUES_DOC(now).issues.slice(0, 2) }, open);
  assert.doesNotMatch(gone, /<pre class='mono'>/);
});

test("fetchIssues builds the card and fills it from GET /api/issues; a failed fetch is the error panel", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard", "retirecard", "briefcard", "issuescard"]) els[id] = { innerHTML: "", dataset: {} };
  const now = Date.now();
  const fetched: string[] = [];
  const { fetchIssues } = settingsScope({
    $: (id: string) => els[id],
    errorPanel: (title: string, err: { message: string }) => "<div>" + title + " " + err.message + "</div>",
    getJson: async (path: string) => {
      fetched.push(path);
      return ISSUES_DOC(now);
    },
  });
  await fetchIssues();
  assert.deepEqual(fetched, ["/api/issues"], "the card reads the mirror endpoint once, read-only");
  // The card exists in the built panel, so the boot's scroll and the card's own id are real.
  assert.match(els["settings-view"]!.innerHTML, /id='issuescard'/);
  const card = els.issuescard!.innerHTML;
  assert.match(card, /<strong>GitHub issues<\/strong>/);
  assert.match(card, /<strong>3\. #2 <a rel='noopener' target='_blank'/);
  assert.match(card, /<span>closed 30m ago<\/span>/);
  // A failed fetch: the named error panel with the message, never a bare code or a blank card.
  const { fetchIssues: fetchFail } = settingsScope({
    $: (id: string) => els[id],
    errorPanel: (title: string, err: { message: string }) => "<div>" + title + " " + err.message + "</div>",
    getJson: async () => {
      throw new Error("/api/issues failed: HTTP 500 — broken ledger");
    },
  });
  await fetchFail();
  assert.equal(els.issuescard!.innerHTML, "<div>GitHub issues could not load /api/issues failed: HTTP 500 — broken ledger</div>");
});

// The card's two filter controls (the search box and the state picker): the card paints them from
// its own issuesFilter, and setIssuesFilter is the one entry point both controls go through. The
// expectations come from what GET /api/issues is pinned to answer for ?state= and ?q= in
// test/gui-issues.test.ts — the denominators are the whole mirror's counts (INV-DE3) and the
// positions stay the whole list's (INV-DE6) — never read back out of the code under test.

test("renderIssues paints the state picker and search box from the filter it is given, never from the payload", () => {
  const { renderIssues } = settingsScope();
  const now = Date.now();
  // The filter's own halves decide every control: the picker marks the asked state, the search box
  // carries the typed text, and the counts sentence names the kept rows over the whole mirror
  // (2 open + 1 closed by tumwater + 0 closed upstream = 3).
  const html = renderIssues({ ...ISSUES_DOC(now), issues: [], state: "lost" }, null, { state: "lost", grep: "login" });
  assert.match(html, /<option value='lost' selected>Lost<\/option>/);
  assert.doesNotMatch(html, /<option value='' selected>/, "only one option is selected");
  assert.match(html, /data-action='issues-grep' type='search' placeholder='Search issues…' autocomplete='off' value='login'/);
  assert.match(html, /<span>Showing 0 of 3 issues matching this filter\.<\/span>/);
  // The whole-mirror counts stay beside it, untouched by the filter (INV-DE3).
  assert.match(html, /<strong>GitHub issues<\/strong><span>znation\/proj \(main\): 2 open, 1 closed by tumwater, checked 3h ago<\/span>/);
  // Two kept rows of the same mirror count 2 of 3, and each keeps its whole-list position: the
  // filter never renumbers (INV-DE6), so a row's View still addresses the same issue.
  const kept = renderIssues({ ...ISSUES_DOC(now), issues: ISSUES_DOC(now).issues.slice(0, 2) }, null, { state: "", grep: "e" });
  assert.match(kept, /<span>Showing 2 of 3 issues matching this filter\.<\/span>/);
  assert.match(kept, /<strong>2\. #7 Seventh<\/strong>/);
  assert.match(kept, /<option value='' selected>All states<\/option>/, "a grep-only filter selects All states");
  // Search text reaching the DOM is escaped, so a quote or a tag cannot end the value attribute.
  const quote = renderIssues(ISSUES_DOC(now), null, { state: "", grep: `a"b<c` });
  assert.match(quote, /value='a&quot;b&lt;c'/);
});

test("an empty list under a filter says the filter missed, and no-filter and unread keep their own copies", () => {
  const { renderIssues } = settingsScope();
  const now = Date.now();
  // A filter that kept nothing: the header row still paints, and the empty sentence names the
  // filter, not an empty mirror.
  const missed = renderIssues({ ...ISSUES_DOC(now), issues: [] }, null, { state: "closed", grep: "nope" });
  assert.match(missed, /<div class='empty'>no issues match this filter<\/div>/);
  assert.match(missed, /<strong>GitHub issues<\/strong>/, "the header row stays under a filtered empty list");
  // The same document with no filter keeps today's copy.
  const clear = renderIssues({ ...ISSUES_DOC(now), issues: [] }, null, { state: "", grep: "" });
  assert.match(clear, /<div class='empty'>no issues to show<\/div>/);
  assert.doesNotMatch(clear, /no issues match this filter/);
  // A mirror never read names that state whatever the filter holds — it wins over both sentences,
  // and an unread mirror has no whole-mirror counts to divide, so no matching-issues sentence.
  const unread = renderIssues({ read: false, empty: true, openCount: 0, closedCount: 0, upstreamClosedCount: 0, issues: [] }, null, { state: "open", grep: "x" });
  assert.match(unread, /<div class='empty'>the GitHub issues mirror has not been read yet<\/div>/);
  assert.doesNotMatch(unread, /no issues match this filter/);
  assert.doesNotMatch(unread, /Showing/);
});

test("setIssuesFilter repaints the cached document before the narrowed read settles, then requests it", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard", "retirecard", "briefcard", "issuescard"]) els[id] = { innerHTML: "", dataset: {} };
  const now = Date.now();
  const fetched: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { fetchIssues, setIssuesFilter, currentIssuesFilter } = settingsScope({
    $: (id: string) => els[id],
    getJson: async (path: string) => {
      fetched.push(path);
      // Only the narrowed read is held open, so the card's immediate repaint is observable.
      if (path === "/api/issues?state=closed") await gate;
      return ISSUES_DOC(now);
    },
  });
  await fetchIssues();
  // The narrowed read is held open: the card must already hold the filter it typed.
  const pending = setIssuesFilter({ state: "closed", grep: "" });
  const card = els.issuescard!.innerHTML;
  assert.match(card, /<option value='closed' selected>Closed<\/option>/, "the picker repaints from the cached document at once");
  assert.deepEqual(currentIssuesFilter(), { state: "closed", grep: "" });
  release();
  await pending;
  assert.deepEqual(fetched, ["/api/issues", "/api/issues?state=closed"], "one narrowed read follows the repaint");
  // Each half alone, both halves, and an empty filter: the path carries only the non-empty halves,
  // and never a bare "?". q is encoded because grepIssueRows takes the raw substring.
  await setIssuesFilter({ state: "", grep: "a b" });
  await setIssuesFilter({ state: "open", grep: "x" });
  await setIssuesFilter({});
  assert.deepEqual(fetched.slice(1), [
    "/api/issues?state=closed",
    "/api/issues?q=a%20b",
    "/api/issues?state=open&q=x",
    "/api/issues",
  ]);
  // The controls hold what was typed, across the read that followed it.
  assert.match(els.issuescard!.innerHTML, /data-action='issues-grep'[\s\S]*?value=''/);
});

test("setIssuesFilter on a card that has never fetched refetches only, and the boot routes both controls through it", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "issuescard"]) els[id] = { innerHTML: "", dataset: {} };
  const fetched: string[] = [];
  const { setIssuesFilter } = settingsScope({
    $: (id: string) => els[id],
    getJson: async (path: string) => {
      fetched.push(path);
      return { read: false, empty: true, openCount: 0, closedCount: 0, upstreamClosedCount: 0, issues: [] };
    },
  });
  await setIssuesFilter({ state: "lost", grep: "gone" });
  assert.deepEqual(fetched, ["/api/issues?state=lost&q=gone"], "no cached document means no repaint before the read");
  // The boot's change delegate already carries the Health card's checkbox; the two filter controls
  // are its siblings in the same listener, each keeping the other half of the filter.
  assert.match(GUI_CLIENT_BOOT_JS, /input\[data-action='doctor-problems'\][\s\S]*?select\[data-action='issues-state'\][\s\S]*?input\[data-action='issues-grep'\]/);
  assert.match(GUI_CLIENT_BOOT_JS, /setIssuesFilter\(\{ state: issState\.value, grep: currentIssuesFilter\(\)\.grep \}\)/);
  assert.match(GUI_CLIENT_BOOT_JS, /setIssuesFilter\(\{ state: currentIssuesFilter\(\)\.state, grep: issGrep\.value\.trim\(\) \}\)/);
});

test("a filtered card's View button still reads its whole-list position", async () => {
  const els: Record<string, { innerHTML: string; dataset: Record<string, string> }> = {};
  for (const id of ["settings-view", "salvagecard", "retirecard", "briefcard", "issuescard"]) els[id] = { innerHTML: "", dataset: {} };
  const now = Date.now();
  const fetched: string[] = [];
  const { setIssuesFilter, issueViewClick } = settingsScope({
    $: (id: string) => els[id],
    getJson: async (path: string) => {
      fetched.push(path);
      if (path.startsWith("/api/issues-show")) return { position: 3, number: 2, title: "Second", text: "issue 3: #2 — Second\n  closed 30m ago: abc1234" };
      // The narrowed reply: only the closed row survives the server's filter, still numbered 3.
      return { ...ISSUES_DOC(now), issues: ISSUES_DOC(now).issues.slice(2), state: "closed" };
    },
  });
  await setIssuesFilter({ state: "closed", grep: "" });
  assert.equal(fetched[0], "/api/issues?state=closed");
  const card = els.issuescard!.innerHTML;
  assert.match(card, /<span>Showing 1 of 3 issues matching this filter\.<\/span>/);
  assert.match(card, /<strong>3\. #2 /, "a filtered row keeps its whole-list position");
  await issueViewClick("3");
  assert.deepEqual(fetched.slice(1), ["/api/issues-show?position=3"]);
  assert.match(els.issuescard!.innerHTML, /<pre class='mono'>issue 3: #2 — Second[\s\S]*closed 30m ago: abc1234<\/pre>/);
  assert.match(els.issuescard!.innerHTML, /Showing 1 of 3 issues matching this filter\./, "the detail opens above the filtered list");
});
