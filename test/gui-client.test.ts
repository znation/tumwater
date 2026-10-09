import test from "node:test";
import assert from "node:assert/strict";
import { freshLoopState } from "../src/loop/loop-state.js";
import { loopPhase, loopRank, sortLoopsByState } from "../src/ui/status-model.js";
import { clientScope, iconStub } from "./helpers/gui-client-scope.js";
import { GUI_CLIENT_JS } from "../src/ui/gui/gui-client.js";
import { shortSha as tsShortSha, usd as tsUsd, usdCap as tsUsdCap } from "../src/text/format.js";

// The dashboard's browser logic, exercised region by region (see gui-client-scope.ts): the
// pure view model that turns a status payload into what the page shows, the Markdown
// renderer, the History table, and the operator actions with stand-ins for the DOM and the
// server.

type PhaseInfo = { key: string; label: string; tone: string; live: boolean; detail: string };
type Alert = { key: string; tone: string; title: string; detail?: string; actions?: Array<{ label: string; act: string; arg?: string }> };
type Model = {
  phaseInfo(phase: string): PhaseInfo;
  resultInfo(result: string | null): { label: string; tone: string };
  resultWhy(l: object): string;
  loopRank(phase: string): number;
  sortLoops<T extends { role: string; phase: string; lastTickEndedAt: number | null }>(loops: T[]): T[];
  pageAlerts(d: object | null, offline: boolean): Alert[];
  needsYou(alerts: Alert[]): number;
  eventKind(item: { type: string; result?: string }): string;
  splitTitle(t: string): { title: string; meta: string };
  queuedPrompts(d: object): Array<{ role: string; preview: string; file: string; queuedAtMs: number | null }>;
  LOOP_GROUPS: Array<Array<string | number>>;
};
const model = clientScope<Model>(["format", "view-model"],
  ["phaseInfo", "resultInfo", "resultWhy", "loopRank", "sortLoops", "pageAlerts", "needsYou", "eventKind", "splitTitle", "queuedPrompts", "LOOP_GROUPS"]);

test("every phase label loopPhase renders maps to a known status on the page", () => {
  const now = Date.now();
  const at = (patch: Partial<ReturnType<typeof freshLoopState>>, role = "clean") => ({ ...freshLoopState(role), ...patch });
  const cases: Array<[string, string, boolean]> = [
    [loopPhase(at({}), false), "stopped", false],
    [loopPhase(at({ running: true, lastTickStartedAt: now - 90_000 }), true), "working", true],
    [loopPhase(at({ running: true, lastTickStartedAt: now - 90_000 }, "director"), true), "working", true],
    [loopPhase(at({ running: true, phase: "review", lastTickStartedAt: now - 30_000 }), true), "reviewing", true],
    [loopPhase(at({}), true, undefined, false, null, false, { status: "landing", startedAt: now - 60_000, stage: "build-check" }), "landing", true],
    [loopPhase(at({}), true, undefined, false, null, false, { status: "vetted", startedAt: now }), "vetted", false],
    [loopPhase(at({ running: true, parkedSince: now - 5_000 }), true), "awaiting", false],
    [loopPhase(at({}, "director"), true), "waiting", false],
    [loopPhase(at({}), true, undefined, false, null, true), "paused", false],
    [loopPhase(at({}), true, undefined, true), "budget", false],
    [loopPhase(at({}), true, undefined, true, null, false, undefined, undefined, true), "cap", false],
    [loopPhase(at({}), true, undefined, false, null, false, undefined, undefined, true), "cap", false],
    [loopPhase(at({ lastResult: "main_red" }), true), "mainred", false],
    [loopPhase(at({ consecutiveErrors: 9 }), true), "failing", false],
    [loopPhase(at({ nextRunAt: now + 600_000 }), true), "sleeping", false],
    [loopPhase(at({ nextRunAt: now - 1_000 }), true), "queued", false],
  ];
  for (const [phase, key, live] of cases) {
    const info = model.phaseInfo(phase);
    assert.equal(info.key, key, `"${phase}" reads as ${key}`);
    assert.equal(info.live, live, `"${phase}" live flag`);
    assert.ok(info.label && info.label !== phase || key === "other", `"${phase}" gets a status word`);
  }
  // The label's tail rides along as the pill's detail line.
  assert.equal(model.phaseInfo("working 3m12s · turn 4 · ctx 18.2k · bash npm test").detail, "3m12s · turn 4 · ctx 18.2k · bash npm test");
  assert.equal(model.phaseInfo("landing 1m · build check").detail, "1m · build check");
  assert.equal(model.phaseInfo("awaiting slot 2m").detail, "for 2m");
  // The per-role cap's label reads with the other held states (amber) and its own detail.
  const cap = model.phaseInfo("cap paused");
  assert.deepEqual([cap.label, cap.tone, cap.live], ["Cap paused", "amber", false], "cap paused reads like budget paused");
  // An unknown label still renders — as itself, neutrally.
  assert.deepEqual([model.phaseInfo("molting").key, model.phaseInfo("molting").label, model.phaseInfo("molting").tone], ["other", "molting", "gray"]);
});

test("the page's loop order is status-model's, rank by rank", () => {
  const t = (min: number) => Date.parse("2026-09-11T00:00:00Z") + min * 60_000;
  const loops = [
    { role: "sleepy", phase: "sleeping (for 5m)", lastTickEndedAt: t(3) },
    { role: "working-b", phase: "working 2m", lastTickEndedAt: t(1) },
    { role: "reviewing-a", phase: "reviewing 1m", lastTickEndedAt: null },
    { role: "queued-z", phase: "queued", lastTickEndedAt: t(5) },
    { role: "landing-x", phase: "landing 2m · merging", lastTickEndedAt: t(0) },
    { role: "director", phase: "director working 1m", lastTickEndedAt: t(7) },
    { role: "vetted-v", phase: "vetted, awaiting merge", lastTickEndedAt: t(4) },
    { role: "parked-p", phase: "awaiting slot 10s", lastTickEndedAt: t(6) },
    { role: "never-ticked", phase: "stopped", lastTickEndedAt: null },
    { role: "main-red", phase: "main red", lastTickEndedAt: t(0) },
    { role: "broken", phase: "failing", lastTickEndedAt: t(2) },
    { role: "held", phase: "paused", lastTickEndedAt: t(9) },
    { role: "broke", phase: "budget paused", lastTickEndedAt: t(1) },
    { role: "capped", phase: "cap paused", lastTickEndedAt: t(2) },
  ];
  const order = model.sortLoops(loops).map((l) => l.role);
  assert.deepEqual(order, [
    "director", // its own live work, outside the permit-holder group
    "working-b", "landing-x", "reviewing-a", // live work, newest tick first, never-ticked last
    "parked-p", "vetted-v", // waiting in the pipeline
    "broken", "main-red", // needs attention
    "held", "capped", "broke", // paused, newest tick first
    "queued-z", "sleepy", "never-ticked", // idle
  ]);
  // Lockstep with the TUI/status comparator and its rank function.
  assert.deepEqual(sortLoopsByState(loops).map((l) => l.role), order);
  for (const l of loops) assert.equal(model.loopRank(l.phase), loopRank(l.phase), l.phase);
  // Ties break on the name, and the input is left alone.
  const tied = [
    { role: "zeta", phase: "queued", lastTickEndedAt: t(4) },
    { role: "alpha", phase: "queued", lastTickEndedAt: t(4) },
  ];
  assert.deepEqual(model.sortLoops(tied).map((l) => l.role), ["alpha", "zeta"]);
  assert.deepEqual(tied.map((l) => l.role), ["zeta", "alpha"], "sortLoops returns a new array");
});

// The running director buckets into its own group so it does not join the In-progress rows an
// operator scans against maxConcurrent (BUGS.md 2026-10-06). In progress still holds the
// pipeline waiters (rank 1), which the page labels `Waiting for a slot`.
test("the running director buckets outside the In-progress group", () => {
  const groupOf = (phase: string): string | number | undefined => {
    const rank = model.loopRank(phase);
    return model.LOOP_GROUPS[model.LOOP_GROUPS.findIndex((g) => g.slice(1).includes(rank))]?.[0];
  };
  assert.equal(groupOf("director working 1m"), "Director");
  assert.equal(groupOf("working 5s"), "In progress");
  assert.equal(groupOf("landing 5s"), "In progress");
  assert.equal(groupOf("awaiting slot 5s"), "In progress");
});

test("tick results read as words with the tone of their outcome", () => {
  const all = ["changed", "queued", "refused", "no_change", "merge_conflict", "merge_blocked", "rejected", "review_error", "error",
    "aborted", "quiet_killed", "user_aborted", "main_red", "skipped"];
  for (const r of all) {
    const info = model.resultInfo(r);
    assert.ok(info.label && !info.label.includes("_"), `${r} has a label`);
    assert.ok(["green", "indigo", "gray", "amber", "red"].includes(info.tone), `${r} has a tone`);
  }
  assert.deepEqual(model.resultInfo("changed"), { label: "Landed", tone: "green" });
  assert.deepEqual(model.resultInfo("error"), { label: "Error", tone: "red" });
  assert.deepEqual(model.resultInfo("some_future_result"), { label: "some future result", tone: "gray" });
  // A problem without a summary explains itself with the loop's last error; a success never
  // borrows a stale one.
  assert.equal(model.resultWhy({ lastResult: "error", lastSummary: null, lastError: "429 Rate limit exceeded", phase: "queued" }), "429 Rate limit exceeded");
  assert.equal(model.resultWhy({ lastResult: "changed", lastSummary: "Add --watch", lastError: "old failure", phase: "queued" }), "Add --watch");
  assert.equal(model.resultWhy({ lastResult: "no_change", lastSummary: null, lastError: "old failure", phase: "queued" }), "");
});

test("the page shows the payload's alerts, led by its own offline notice", () => {
  const alerts = [{ key: "failing", tone: "red", title: "qa is failing tick after tick", detail: "", actions: [] }];
  assert.deepEqual(model.pageAlerts({ alerts }, false), alerts, "the server's alerts, as sent");
  assert.deepEqual(model.pageAlerts({ alerts }, true).map((a) => a.key), ["offline", "failing"], "a lost server comes first");
  assert.deepEqual(model.pageAlerts(null, true).map((a) => a.key), ["offline"], "even before any payload");
  assert.deepEqual(model.pageAlerts({}, false), [], "an older server without alerts shows none");
  assert.equal(model.needsYou([...alerts, { key: "stopped", tone: "gray", title: "", actions: [] }]), 1, "information does not count");
});
test("activity items sort into landings, problems, questions, notices, and routine", () => {
  const kind = (type: string, result?: string) => model.eventKind({ type, ...(result === undefined ? {} : { result }) });
  assert.equal(kind("merged"), "landing");
  assert.equal(kind("question_posted"), "attention");
  assert.equal(kind("tick_end", "error"), "problem");
  assert.equal(kind("tick_end", "rejected"), "problem");
  assert.equal(kind("tick_end", "queued"), "routine", "a queued change's landing is the notable part");
  assert.equal(kind("tick_end", "no_change"), "routine");
  assert.equal(kind("build_check", "passed"), "routine");
  assert.equal(kind("build_check", "failed"), "problem");
  assert.equal(kind("land_failed"), "problem");
  assert.equal(kind("tick_start"), "routine");
  assert.equal(kind("fleet_paused"), "info");
  assert.equal(kind("some_new_event"), "info", "an unknown event type is shown, not hidden");
});

test("backlog titles split off their date notes; queued prompts list in execution order", () => {
  assert.deepEqual(model.splitTitle("Add --watch (planned 2026-09-28)"), { title: "Add --watch", meta: "planned 2026-09-28" });
  assert.deepEqual(model.splitTitle("Crash on (empty) input (reported 2026-09-29)"), { title: "Crash on (empty) input", meta: "reported 2026-09-29" });
  assert.deepEqual(model.splitTitle("No note here (really)"), { title: "No note here (really)", meta: "" });
  assert.deepEqual(model.queuedPrompts({
    inboxPrompts: ["first", "second"],
    inboxFiles: ["a.md", "b.md"],
    inboxQueuedAt: [1000, null],
    inboxNotBefore: [null, null],
    roleInboxPrompts: { qa: [{ file: "q.md", preview: "qa one", queuedAtMs: 2000 }], feature: [{ file: "f.md", preview: "feature one" }] },
  }), [
    { role: "director", preview: "first", file: "a.md", queuedAtMs: 1000, notBeforeMs: null },
    { role: "director", preview: "second", file: "b.md", queuedAtMs: null, notBeforeMs: null },
    { role: "feature", preview: "feature one", file: "f.md", queuedAtMs: null, notBeforeMs: null },
    { role: "qa", preview: "qa one", file: "q.md", queuedAtMs: 2000, notBeforeMs: null },
  ]);
  // An older payload without the stamps at all must not break the render — everything
  // defaults to null (the age is omitted, not an error).
  assert.deepEqual(model.queuedPrompts({ inboxPrompts: ["only"], inboxFiles: ["c.md"] }), [
    { role: "director", preview: "only", file: "c.md", queuedAtMs: null, notBeforeMs: null },
  ]);
});

test("renderMarkdown renders the backlog's and digest's Markdown without ever passing markup through", () => {
  const { renderMarkdown } = clientScope<{ renderMarkdown(src: string, breaks?: boolean): string }>(["markdown"], ["renderMarkdown"]);
  assert.equal(renderMarkdown("# Title\n\nSome **bold** and `code`."), "<h2>Title</h2><p>Some <strong>bold</strong> and <code>code</code>.</p>");
  // Lists fold their indented continuation lines into the item.
  assert.equal(renderMarkdown("1. **Parser** — one\n   continued\n2. two"), "<ol><li><strong>Parser</strong> — one continued</li><li>two</li></ol>");
  assert.equal(renderMarkdown("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  // Pipe tables, with right alignment from the separator row.
  const table = renderMarkdown("| role | errors |\n| --- | ---: |\n| qa | 3 |");
  assert.match(table, /<th>role<\/th><th class='r'>errors<\/th>/);
  assert.match(table, /<td>qa<\/td><td class='r'>3<\/td>/);
  // A pipe inside inline code is cell content, not a delimiter (the digest's tables quote
  // shell pipelines): the row keeps its two cells and the code span stays whole.
  const piped = renderMarkdown("| command | count |\n| --- | ---: |\n| \x60grep a|b | tail\x60 | 3 |\n| `x` | `p|q` |");
  assert.match(piped, /<td><code>grep a\|b \| tail<\/code><\/td><td class='r'>3<\/td>/);
  assert.match(piped, /<td><code>x<\/code><\/td><td class='r'><code>p\|q<\/code><\/td>/);
  // A doubled-backtick span (the markdown form that quotes a literal backtick) is ONE span:
  // its inner run neither breaks the span nor swallows the row's remaining cells — the span
  // closes at its own second doubled run, so the pipe after it still delimits.
  const doubled = renderMarkdown("| lit | n |\n| --- | ---: |\n| \x60\x60 \x60 \x60\x60 | 3 |");
  assert.match(doubled, /<td><code>\x60<\/code><\/td><td class='r'>3<\/td>/);
  assert.equal(renderMarkdown("quote \x60\x60 \x60 \x60\x60 here"), "<p>quote <code>\x60</code> here</p>");
  // Fenced code stays verbatim and escaped.
  assert.equal(renderMarkdown("\x60\x60\x60\n<b>x</b> **y**\n\x60\x60\x60"), "<pre><code>&lt;b&gt;x&lt;/b&gt; **y**</code></pre>");
  // Model-written HTML is text, never markup; links keep their text and drop the URL.
  const hostile = renderMarkdown("<img src=x onerror=alert(1)> [click](javascript:void) <script>alert(1)</script>");
  assert.doesNotMatch(hostile, /<img|<script|javascript:/);
  assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt; click &lt;script&gt;/);
  // Code spans are literal, and an unmatched backtick is plain text (a lone run — or a run
  // of a different length than the opener's — never closes a span, so neither opens one).
  assert.equal(renderMarkdown("\x60**not bold**\x60 and \x60 alone"), "<p><code>**not bold**</code> and \x60 alone</p>");
  assert.equal(renderMarkdown("pair \x60\x60not a span\x60 here"), "<p>pair \x60\x60not a span\x60 here</p>");
  assert.equal(renderMarkdown("Render \x60\x60\x60python fences"), "<p>Render \x60\x60\x60python fences</p>", "a backtick run in prose stays text");
  // One fact per line (the failure digest) keeps its line breaks when asked.
  assert.equal(renderMarkdown("Window: 14 days\npartial: log starts 09-29", true), "<p>Window: 14 days<br>partial: log starts 09-29</p>");
  assert.equal(renderMarkdown("wrapped\nprose"), "<p>wrapped prose</p>");
});

test("a loop's controls post explicit states, and an abort needs a confirming second click", async () => {
  const posts: Array<{ path: string; body: unknown }> = [];
  const flashes: string[] = [];
  const calls: string[] = [];
  const answers: Record<string, unknown> = {
    "/api/wake": { ok: true, message: "wake requested for feature — a running fleet applies it within ~2s" },
    "/api/pause-role": { ok: true, changed: true },
    "/api/abort": { ok: true, message: "abort requested for feature" },
  };
  const scope = clientScope<{ rowAction(action: string, role: string): Promise<void>; abortConfirming(role: string): boolean }>(
    ["post-action", "row-actions"], ["rowAction", "abortConfirming"], {
      closeMenus: () => {},
      postJson: async (path: string, body: unknown) => {
        posts.push({ path, body });
        if (path === "/api/abort" && (body as { role: string }).role === "offline") throw new Error("/api/abort failed: HTTP 409 — no harness is running");
        return answers[path];
      },
      showFlash: (m: string) => flashes.push(m),
      refresh: () => calls.push("refresh"),
      rerender: () => calls.push("rerender"),
      setTarget: (role: string) => calls.push("target " + role),
      focusComposer: () => calls.push("focus"),
      setTimeout: () => 0,
    });

  await scope.rowAction("wake", "feature");
  assert.deepEqual(posts.shift(), { path: "/api/wake", body: { role: "feature" } });
  assert.match(flashes.shift() ?? "", /wake requested for feature/, "the server's own confirmation is shown");

  // Pause and resume always name the state they want — the endpoint rejects a body without it.
  await scope.rowAction("pause", "docs");
  assert.deepEqual(posts.shift(), { path: "/api/pause-role", body: { role: "docs", paused: true } });
  assert.equal(flashes.shift(), "docs paused — it starts no new ticks");
  await scope.rowAction("resume", "docs");
  assert.deepEqual(posts.shift(), { path: "/api/pause-role", body: { role: "docs", paused: false } });
  assert.equal(flashes.shift(), "docs resumed");
  answers["/api/pause-role"] = { ok: true, changed: false };
  await scope.rowAction("pause", "docs");
  posts.shift();
  assert.equal(flashes.shift(), "docs was already paused");

  // The first abort click only arms it; the second fires.
  await scope.rowAction("abort", "feature");
  assert.equal(posts.length, 0, "an armed abort posts nothing yet");
  assert.equal(scope.abortConfirming("feature"), true);
  assert.equal(scope.abortConfirming("qa"), false, "arming is per loop");
  await scope.rowAction("abort", "feature");
  assert.deepEqual(posts.shift(), { path: "/api/abort", body: { role: "feature" } });
  assert.equal(scope.abortConfirming("feature"), false, "firing disarms");
  // A failed POST says why.
  await scope.rowAction("abort", "offline");
  await scope.rowAction("abort", "offline");
  posts.shift();
  assert.match(flashes.pop() ?? "", /^error: \/api\/abort failed: HTTP 409/);

  // Prompt aims the composer at the loop instead of posting.
  calls.length = 0;
  await scope.rowAction("prompt", "qa");
  assert.deepEqual(calls, ["target qa", "focus"]);
  assert.equal(posts.length, 0);
});

test("the composer queues for the director or one loop through the CLI's endpoints", async () => {
  const posts: Array<{ path: string; body: unknown }> = [];
  let fail = false;
  const { sendPrompt } = clientScope<{ sendPrompt(target: string, text: string): Promise<string> }>(["composer-send"], ["sendPrompt"], {
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body });
      if (fail) throw new Error(path + " failed: HTTP 400 — the prompt is 5000 chars");
      return { ok: true };
    },
  });
  assert.equal(await sendPrompt("director", "prefer the stdlib"), "Queued for the director — it runs next");
  assert.deepEqual(posts.shift(), { path: "/api/prompt", body: { text: "prefer the stdlib" } });
  assert.equal(await sendPrompt("qa", "retest --watch"), "Queued for the qa loop's next tick — it wakes now");
  assert.deepEqual(posts.shift(), { path: "/api/prompt-role", body: { role: "qa", text: "retest --watch" } });
  fail = true;
  await assert.rejects(sendPrompt("director", "too long"), /HTTP 400/, "a refused prompt rejects, so the page keeps the text");
});

// The sidebar's operator controls. Their regions register document-level click/key handlers
// at load, so they run against a document stand-in; everything else is injected directly.
function operatorScope(state: { lastStatus?: object | null } = {}) {
  const panels: Record<string, string> = {};
  const posts: Array<{ path: string; body: unknown }> = [];
  const flashes: string[] = [];
  const els: Record<string, unknown> = {};
  const scope = clientScope<{
    budgetCardHtml(b: object): string;
    saveBudget(): Promise<void>;
    pauseControlHtml(d: object): string;
    setFleetPause(paused: boolean, forSeconds?: number): Promise<void>;
  }>(["format", "post-action", "click-delegate", "shared-operator", "budget-edit", "pause-control"], ["budgetCardHtml", "saveBudget", "pauseControlHtml", "setFleetPause"], {
    document: { addEventListener: () => {}, createElement: () => ({ setAttribute() {}, remove() {} }) },
    $: (id: string) => els[id] ?? null,
    paintPanel: (id: string, html: string) => { panels[id] = html; return true; },
    lastPaint: {},
    icon: iconStub,
    postJson: async (path: string, body: unknown) => { posts.push({ path, body }); return { ok: true }; },
    showFlash: (m: string) => flashes.push(m),
    closeMenus: () => {},
    refresh: () => {},
    openMenu: null,
    lastStatus: state.lastStatus ?? null,
  });
  return { scope, panels, posts, flashes, els };
}

test("the assembled script declares postAction exactly once — both operator and fleet callers go through it", () => {
  // Two `async function postAction` declarations in one concatenated script scope: the later
  // declaration wins everywhere, so the operator's string-typed calls went through the fleet
  // variant that invokes its third argument as a function ("message is not a function") even
  // though the POST itself succeeded.
  const declarations = GUI_CLIENT_JS.match(/async function postAction/g) ?? [];
  assert.equal(declarations.length, 1, "one postAction definition serves every caller");
});

test("the spend card is an editor button unless every model is free", () => {
  const { scope } = operatorScope();
  const free = scope.budgetCardHtml({ spentUsd: 0, capUsd: 50, free: true, fallback: null });
  assert.doesNotMatch(free, /id='budgetbadge'|<button/, "an all-free fleet has no cap editor to open");
  assert.match(free, /Free models/);
  const priced = scope.budgetCardHtml({ spentUsd: 4.09, capUsd: 15, free: false, fallback: null });
  assert.match(priced, /<button type='button' class='side-card' id='budgetbadge'/);
  assert.match(priced, /\$4\.09 <small>of \$15<\/small>/, "spend against the cap, whole-dollar caps bare");
  assert.match(priced, /<span class='meter'><span style='width:27\.3%'>/);
  assert.match(scope.budgetCardHtml({ spentUsd: 13, capUsd: 15, free: false }), /class='meter t-amber'/, "85% of the cap turns amber");
  assert.match(scope.budgetCardHtml({ spentUsd: 16, capUsd: 15, free: false }), /class='meter t-red'><span style='width:100\.0%'/, "a spent cap is red and full");
  const uncapped = scope.budgetCardHtml({ spentUsd: 2, capUsd: 0, free: false, fallback: null });
  assert.match(uncapped, /id='budgetbadge'/, "a fleet without a cap can still set one");
  assert.match(uncapped, /Set a cap/);
  assert.doesNotMatch(uncapped, /meter/);
});

test("the cap editor refuses text the browser rejected instead of silently removing the cap", async () => {
  const { scope, posts, flashes, els } = operatorScope();
  const input = { value: "", validity: { badInput: true } };
  els.budgetinput = input;
  await scope.saveBudget();
  assert.equal(posts.length, 0, "rejected text must not change the cap");
  assert.match(flashes.shift() ?? "", /^error: the cap must be a number/);
  input.validity.badInput = false;
  await scope.saveBudget();
  assert.deepEqual(posts.shift(), { path: "/api/budget", body: { maxDailyCostUsd: 0 } }, "a cleared field means no cap");
  assert.equal(flashes.shift(), "Daily cap removed");
  input.value = "25";
  await scope.saveBudget();
  assert.deepEqual(posts.shift(), { path: "/api/budget", body: { maxDailyCostUsd: 25 } });
  assert.equal(flashes.shift(), "Daily cap set to $25");
});

test("the pause control offers timed pauses and shows a timed pause's countdown", async () => {
  const { scope, posts, flashes } = operatorScope();
  assert.match(scope.pauseControlHtml({ paused: false }), /aria-haspopup='menu'[^>]*>.*Pause the fleet/);
  const standing = scope.pauseControlHtml({ paused: true });
  assert.match(standing, /Resume the fleet/);
  assert.match(standing, /<span class='btn-note' id='pausenote'><\/span>/, "a standing pause has no countdown");
  assert.match(scope.pauseControlHtml({ paused: true, pausedUntil: Date.now() + 12 * 60_000 }), /id='pausenote'>12m left</);
  await scope.setFleetPause(true, 3600);
  assert.deepEqual(posts.shift(), { path: "/api/pause", body: { paused: true, forSeconds: 3600 } });
  assert.match(flashes.shift() ?? "", /^Fleet paused for 1h/);
  await scope.setFleetPause(true, 0);
  assert.deepEqual(posts.shift(), { path: "/api/pause", body: { paused: true } }, "until-resumed sends no deadline");
  await scope.setFleetPause(false);
  assert.deepEqual(posts.shift(), { path: "/api/pause", body: { paused: false } });
  assert.equal(flashes.pop(), "Fleet resumed");
});

test("the page's shortSha abbreviates like format.ts's 8-character rule", () => {
  // The land-queue drawer and the running-build row both render sha cells through the page's
  // shortSha; it must stay byte-identical to the TypeScript single home it mirrors.
  const { shortSha } = clientScope<{ shortSha(sha: unknown): string }>(["format"], ["shortSha"]);

  for (const sha of ["abcdef1234567890", "abc", 12345678901234, null, undefined]) {
    assert.equal(shortSha(sha), tsShortSha(sha), `sha ${String(sha)}`);
  }
});

test("the page's money formatters match format.ts's usd/usdCap rules", () => {
  // The usage report and the fleet tiles render money through the page's fmtUsd/fmtCap; the
  // browser runtime cannot import text/format.ts, so the copies must stay byte-identical to
  // the TypeScript single home they mirror.
  const { fmtUsd, fmtCap } = clientScope<{ fmtUsd(n: number): string; fmtCap(n: number): string }>(["format"], ["fmtUsd", "fmtCap"]);

  for (const n of [0, 12.34, 50, 12.5, 12.999, 1_000_000, -3, NaN]) {
    assert.equal(fmtUsd(n), tsUsd(n), `usd on ${String(n)}`);
    assert.equal(fmtCap(n), tsUsdCap(n), `usdCap on ${String(n)}`);
  }
});

test("the page's workSplit names the work/maintenance commit split", () => {
  // The sidebar's "Landed today" tile and the report's "Commits landed" tile both render this
  // phrase; a totals payload from an older fold omits the counts and must read 0, not undefined.
  const { workSplit } = clientScope<{ workSplit(t: { workCommits?: number; maintenanceCommits?: number }): string }>(["format"], ["workSplit"]);

  assert.equal(workSplit({ workCommits: 2, maintenanceCommits: 3 }), "2 work / 3 maintenance");
  assert.equal(workSplit({}), "0 work / 0 maintenance", "a missing split reads zero, not undefined");
});
