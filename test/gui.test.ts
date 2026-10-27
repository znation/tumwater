import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type os from "node:os";
import { loadConfig, saveConfig } from "../src/config/config.js";
import { lanAddresses } from "../src/gui/gui-command.js";
import { guiBindHost, startGui } from "../src/gui/gui-server.js";
import { statusPayload } from "../src/ui/status-payload.js";
import { initProject } from "../src/init/init.js";
import { enqueuePrompt, enqueueRolePrompt, inboxSize, dequeueRolePrompt, queuedFiles, queuedRolePromptRecords, queuedRolePrompts } from "../src/inbox/inbox.js";
import { roleInboxDir } from "../src/paths.js";
import { abortRequestPath } from "../src/paths.js";
import { orchestratorStatePath } from "../src/paths.js";
import { piLogPath } from "../src/paths.js";
import { runnerIds } from "../src/roles/runner-ids.js";
import { readJson } from "./helpers/json-read.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { spawnLiveChild, stopChild } from "./helpers/child-process.js";
import { DIRECTOR_ROLE } from "../src/roles/roles.js";
import { fetchLoopback, postJson, startLocalGui } from "./fixtures/gui-fixtures.js";
import { writeLogLines } from "./fixtures/log-fixtures.js";
import { makeRepo, tmpdir, writeBacklogFile, writeConfig } from "./fixtures/repo-fixtures.js";
import { writeModelsFile } from "./fixtures/models-fixtures.js";
import { clockOf, dayKey } from "./helpers/oracles.js";
import { setEnv } from "./helpers/env.js";

// The dashboard tests read JSON responses the way gui-client's own getJson guard does; this
// keeps each call site to one line instead of the double-await fetch idiom.
async function getJson<T>(base: string, path: string): Promise<T> {
  return (await (await fetch(base + path)).json()) as T;
}

// The --all-interfaces URL filter decides which addresses the dashboard advertises as
// reachable for an UNAUTHENTICATED server, so its inclusions/exclusions are pinned here
// against a synthetic interface table: the e2e test can only observe what this machine has,
// and on boxes without an external IPv4 (CI, containers) it passes vacuously.
// Full interface infos with the boilerplate fields (netmask/mac/cidr) filled in, so the
// tables below read as address/family/internal — the only fields the filter looks at.
const v4 = (address: string, internal: boolean): os.NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  mac: "aa:bb:cc:dd:ee:ff",
  cidr: null,
  family: "IPv4",
  internal,
});
const v6 = (address: string, internal: boolean): os.NetworkInterfaceInfo => ({
  address,
  netmask: "ffff:ffff:ffff:ffff::",
  mac: "aa:bb:cc:dd:ee:ff",
  cidr: null,
  scopeid: 7,
  family: "IPv6",
  internal,
});

test("lanAddresses keeps external IPv4 only — skips loopback, IPv6, and empty interfaces", () => {
  const table = {
    lo0: [v4("127.0.0.1", true)],
    en0: [
      v6("fe80::a%en0", false), // link-local IPv6
      v4("192.168.1.50", false),
    ],
    utun3: undefined, // an interface with no addresses — the live table's real shape
  };
  assert.deepEqual(lanAddresses(table), ["192.168.1.50"]);

  // Every external IPv4 counts (multiple interfaces), in table order; an IPv4-mapped
  // address is still family "IPv6", so it stays excluded.
  const multi = {
    eth0: [v4("10.0.0.2", false)],
    en0: [
      v6("::ffff:192.168.1.50", false),
      v4("192.168.1.50", false),
    ],
  };
  assert.deepEqual(lanAddresses(multi), ["10.0.0.2", "192.168.1.50"]);

  assert.deepEqual(lanAddresses({}), []);

  // The default (live) table: whatever it returns, every entry is a non-loopback IPv4 —
  // the property that makes printing them safe.
  for (const addr of lanAddresses()) {
    assert.match(addr, /^\d{1,3}(\.\d{1,3}){3}$/, `IPv4 dotted quad: ${addr}`);
    assert.notEqual(addr, "127.0.0.1", "loopback is never advertised");
  }
});

test("gui binds localhost by default and all interfaces on request", async () => {
  // The bind target is a pure function of the flag, so pin the mapping here rather than
  // reading it back off a live socket: the unspecified address is "::" on dual-stack hosts
  // and "0.0.0.0" on IPv4-only ones, so an address() string assertion measured the host's
  // address family, not the flag (the shape the gate's flake re-run waved through).
  assert.equal(guiBindHost(false), "127.0.0.1", "default is loopback-only");
  assert.equal(guiBindHost(true), undefined, "all interfaces is the unspecified address");

  const repo = makeRepo();
  await initProject(repo, "gui bind test");

  const local = await startGui(repo, 0);
  try {
    assert.equal(local.listening, true, "default server is listening");
    const localAddr = local.address();
    assert.ok(localAddr && typeof localAddr === "object");
    assert.equal(localAddr.address, "127.0.0.1", "default stays loopback-only");
  } finally {
    await new Promise((r) => local.close(r));
  }

  const open = await startGui(repo, 0, true);
  try {
    assert.equal(open.listening, true, "all-interfaces server is listening");
    const openAddr = open.address();
    assert.ok(openAddr && typeof openAddr === "object");
    const page = await (await fetchLoopback(`http://127.0.0.1:${openAddr.port}/`)).text();
    assert.match(page, /<title>tumwater<\/title>/, "still serves over loopback too");
  } finally {
    await new Promise((r) => open.close(r));
  }
});

test("fetchLoopback survives one transient refusal", async () => {
  // The regression guard for the host-sensitive GUI test: the old test's unbounded fetch
  // failed the tree on a single dropped first connection. One retry turns that into a pass,
  // while a server that stays down still throws on the second attempt.
  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    if (calls === 1) throw new Error("ECONNREFUSED");
    return new Response("ok");
  }) as unknown as typeof fetch;
  const res = await fetchLoopback("http://127.0.0.1:1/", flaky);
  assert.equal(await res.text(), "ok");
  assert.equal(calls, 2, "retried exactly once");
});

test("gui serves the dashboard, status JSON, and accepts prompts", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui test project");
  const { server, base } = await startLocalGui(repo);
  try {
    const page = await (await fetch(base + "/")).text();
    assert.match(page, /<title>tumwater<\/title>/);

    const status = await getJson<
      ReturnType<typeof statusPayload> & {
        running: boolean;
        roles: Array<{ role: string; phase: string }>;
      }
    >(base, "/api/status");
    assert.equal(status.running, false);
    assert.ok(status.roles.some((l) => l.role === "director"));

    // The served document is exactly the CLI's (`statusPayload`) plus one field only the server
    // can know — the serving process's own `serverBuildSha`, the page's cue to notice a newer
    // build and reload. Pin the relation so the two surfaces cannot silently drift, and the
    // README/help's "the GUI's payload minus serverBuildSha" promise stays true. Both sides go
    // through a JSON round-trip (the served side already has): that is exactly what the endpoint
    // and `status --json` emit, and `pid: undefined` must vanish from both.
    const { serverBuildSha, ...servedRest } = status as Record<string, unknown>;
    assert.ok("serverBuildSha" in status, "the served payload names the serving build");
    assert.ok(
      serverBuildSha === null || typeof serverBuildSha === "string",
      "serverBuildSha is the build sha or null",
    );
    assert.deepEqual(
      servedRest,
      JSON.parse(JSON.stringify(statusPayload(repo))),
      "served payload is the CLI's plus serverBuildSha",
    );

    const post = await postJson(base, "/api/prompt", { text: "hello from the browser" });
    assert.equal(post.status, 200);
    assert.equal(inboxSize(repo), 1);

    const bad = await postJson(base, "/api/prompt", { text: "  " });
    assert.equal(bad.status, 400);

    // Malformed or non-object bodies are client errors too: 400 with an actionable message,
    // not a 500 carrying Node's raw SyntaxError/TypeError.
    const malformed = await fetch(base + "/api/prompt", { method: "POST", body: "not json" });
    assert.equal(malformed.status, 400);
    assert.match(((await malformed.json()) as { error: string }).error, /JSON/);
    for (const body of ["null", "[1]", '"just a string"']) {
      const res = await fetch(base + "/api/prompt", { method: "POST", body });
      assert.equal(res.status, 400, body);
      // Valid JSON that is not an object names the fix (send the object shape) — not
      // "text required", which would point at a field of a body that has none.
      assert.match(((await res.json()) as { error: string }).error, /JSON object/);
    }
    // A present-but-wrong-typed text names the offending value.
    const nonStringText = await fetch(base + "/api/prompt", { method: "POST", body: '{"text": 42}' });
    assert.equal(nonStringText.status, 400);
    assert.match(((await nonStringText.json()) as { error: string }).error, /must be a string \(got 42\)/);
    assert.equal(inboxSize(repo), 1, "rejected bodies queue nothing");

    const nope = await fetch(base + "/nope");
    assert.equal(nope.status, 404);
    assert.match(await nope.text(), /\/nope/, "the 404 names the offending path");
  } finally {
    server.close();
  }
});

test("gui /api/abort-all writes one marker per enabled runner and 409s without a live team", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui abort all test");
  // With a live orchestrator the endpoint writes one marker per enabled runner and reports the
  // count, the same summary the CLI prints.
  const live = spawnLiveChild();
  { const { server, base } = await startLocalGui(repo);
    try {
      writeOrchestratorMarker(repo, [], { pid: live.child.pid });
      const ids = runnerIds(loadConfig(repo));
      const res = await postJson(base, "/api/abort-all", {});
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; message: string };
      assert.equal(body.ok, true);
      assert.match(body.message, new RegExp(`abort requested for ${ids.length} roles`));
      const marker = readJson<Record<string, unknown>>(abortRequestPath(repo, ids[0]!));
      assert.equal(typeof marker["at"], "number", "an abort marker is written");
    } finally {
      server.close();
    } }
  await stopChild(live);
  // Without a live orchestrator the same endpoint 409s, like per-role abort.
  { const { server, base } = await startLocalGui(repo);
    try {
      fs.rmSync(orchestratorStatePath(repo), { force: true });
      const res = await postJson(base, "/api/abort-all", {});
      assert.equal(res.status, 409);
      assert.match(((await res.json()) as { error: string }).error, /tumwater is not running/);
    } finally {
      server.close();
    } }
});

test("gui /api/prompt and /api/prompt-role accept a deferral the queues hold until its time", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui prompt defer");
  const { server, base } = await startLocalGui(repo);
  try {
    const later = await postJson(base, "/api/prompt", { text: "later", defer: "45m" });
    assert.equal(later.status, 200);
    assert.equal(inboxSize(repo), 0, "a deferred prompt is not yet deliverable");
    assert.equal(dequeueRolePrompt(repo, DIRECTOR_ROLE), null, "a deferred prompt cannot be dequeued");
    const record = queuedRolePromptRecords(repo, DIRECTOR_ROLE)[0]!;
    assert.ok(record.notBeforeMs !== null && record.notBeforeMs > Date.now(), "the not-before mark is in the future");

    const bad = await postJson(base, "/api/prompt", { text: "later", defer: "nonsense" });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /defer needs a duration/);
    const over = await postJson(base, "/api/prompt", { text: "later", defer: "100d" });
    assert.equal(over.status, 400);
    assert.match(((await over.json()) as { error: string }).error, /defer is capped at 90d/);
    assert.equal(inboxSize(repo), 0, "rejected deferrals queue nothing");

    const roleLater = await postJson(base, "/api/prompt-role", { role: "feature", text: "later", defer: "45m" });
    assert.equal(roleLater.status, 200);
    assert.equal(inboxSize(repo, "feature"), 0, "a deferred per-role prompt is not yet deliverable");

    // An absent defer still queues a deliverable prompt.
    const now = await postJson(base, "/api/prompt", { text: "now" });
    assert.equal(now.status, 200);
    assert.equal(inboxSize(repo), 1, "an absent defer queues a deliverable prompt");
  } finally {
    server.close();
  }
});

test("gui /api/prompt and /api/prompt-role save attached images beside the queued prompt and reject bad ones", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui image attachments");
  const { server, base } = await startLocalGui(repo);
  try {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const post = await postJson(base, "/api/prompt", {
      text: "look at this",
      images: [{ name: "shot.png", dataBase64: png.toString("base64") }],
    });
    assert.equal(post.status, 200);
    // The queued prompt ends with one reference line per image, pointing at an absolute path
    // that exists on disk, and the image sits beside the queue .md under the same stem.
    const queued = queuedRolePrompts(repo, "director")[0]!;
    const refs = queued.split("\n").filter((l) => l.startsWith("[image attached: "));
    assert.equal(refs.length, 1);
    const imagePath = refs[0]!.slice("[image attached: ".length, -1);
    assert.ok(path.isAbsolute(imagePath), "the reference is absolute");
    assert.ok(fs.existsSync(imagePath), "the referenced file exists");
    assert.deepEqual(fs.readFileSync(imagePath), png);
    const names = fs.readdirSync(roleInboxDir(repo, "director")).sort();
    assert.equal(names.length, 2);
    assert.ok(names[0]!.endsWith(".md") && names[1]!.endsWith(".png"));
    assert.equal(names[1]!.replace(/\.png$/, ""), names[0]!.replace(/\.md$/, ""), "same stem as the queue file");

    // The per-role endpoint shares the mechanics; the image lands in that role's own queue.
    const rolePost = await postJson(base, "/api/prompt-role", {
      role: "clean",
      text: "clean this shot",
      images: [{ name: "shot.png", dataBase64: png.toString("base64") }],
    });
    assert.equal(rolePost.status, 200);
    const roleQueued = queuedRolePrompts(repo, "clean")[0]!;
    assert.match(roleQueued, /\[image attached: .+\/clean\/[^/]+\.png\]/);
    assert.ok(fs.existsSync(roleQueued.split("[image attached: ")[1]!.split("]")[0]!));

    // Every rejected shape answers 400 naming the rule and writes nothing: no queue file,
    // no image.
    const before = fs.readdirSync(roleInboxDir(repo, "director")).length;
    const badExtension = await postJson(base, "/api/prompt", {
      text: "oops",
      images: [{ name: "notes.txt", dataBase64: png.toString("base64") }],
    });
    assert.equal(badExtension.status, 400);
    assert.match(((await badExtension.json()) as { error: string }).error, /unsupported image type/);
    const undecodable = await postJson(base, "/api/prompt", {
      text: "oops",
      images: [{ name: "shot.png", dataBase64: "not@base64!" }],
    });
    assert.equal(undecodable.status, 400);
    assert.match(((await undecodable.json()) as { error: string }).error, /valid base64/);
    const tooMany = await postJson(base, "/api/prompt", {
      text: "oops",
      images: Array.from({ length: 5 }, () => ({ name: "shot.png", dataBase64: png.toString("base64") })),
    });
    assert.equal(tooMany.status, 400);
    assert.match(((await tooMany.json()) as { error: string }).error, /at most 4 images/);
    assert.equal(fs.readdirSync(roleInboxDir(repo, "director")).length, before, "rejected bodies write nothing");
    assert.equal(inboxSize(repo, "director"), 1, "only the good prompt was queued");
  } finally {
    server.close();
  }
});

test("gui /api/transcript serves rendered lines and validates role/n", async () => {
  const repo = makeRepo();
  await initProject(repo, "transcript gui test");
  const { server, base } = await startLocalGui(repo);
  try {
    // No log yet: friendly empty state.
    const empty = await getJson<{ lines: string[] }>(base, "/api/transcript?role=feature");
    assert.deepEqual(empty, { lines: [] });

    // With a log: same rendered lines as the CLI transcript.
    const file = piLogPath(repo, "feature");
    writeLogLines(file, [
        JSON.stringify({ type: "agent_start" }),
        JSON.stringify({
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: "run prompt" }], timestamp: 1787222691956 },
        }),
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "did the thing" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "/a/PLANS.md" } }],
          },
        }),
      ]);
    const ok = await getJson<{ lines: string[] }>(base, "/api/transcript?role=feature&n=10");
    assert.ok(ok.lines.some((l) => l.startsWith("── run @ ")));
    assert.ok(ok.lines.includes("  did the thing"));
    assert.ok(ok.lines.includes("→ read PLANS.md"));
    assert.ok(!ok.lines.some((l) => l.includes("run prompt")));
    const withPrompt = await getJson<{ lines: string[] }>(base, "/api/transcript?role=feature&n=10&prompt=1");
    const promptAt = withPrompt.lines.findIndex((l) => l.includes("run prompt"));
    assert.ok(promptAt !== -1, "prompt=1 renders the run's prompt");
    assert.ok(promptAt < withPrompt.lines.indexOf("  did the thing"));
    const grepped = await getJson<{ lines: string[] }>(base, "/api/transcript?role=feature&n=10&grep=THING");
    assert.deepEqual(grepped.lines, ok.lines);
    const none = await getJson<{ lines: string[] }>(base, "/api/transcript?role=feature&n=10&grep=nomatch");
    assert.deepEqual(none, { lines: [] });
    const blank = await getJson<{ lines: string[] }>(base, "/api/transcript?role=feature&n=10&grep=");
    assert.deepEqual(blank.lines, ok.lines);

    // Validation: unknown role, missing role, and bad n all → 400. Each 400 names the
    // offending value (or says it is required) so a client can tell which input was bad.
    for (const url of ["/api/transcript?role=nosuch", "/api/transcript", "/api/transcript?role=feature&n=abc", "/api/transcript?role=feature&n=0"]) {
      const res = await fetch(base + url);
      assert.equal(res.status, 400, url);
    }
    const unknownRole = await getJson<{ error: string }>(base, "/api/transcript?role=nosuch");
    assert.match(unknownRole.error, /unknown role "nosuch"/);
    const missingRole = await getJson<{ error: string }>(base, "/api/transcript");
    assert.match(missingRole.error, /role required/);

    // Routing is by exact path: a path merely prefixing /api/transcript is not that route —
    // the old startsWith on the raw URL answered these with 200 transcript data.
    for (const url of ["/api/transcripts?role=feature", "/api/transcriptx"]) {
      const res = await fetch(base + url);
      assert.equal(res.status, 404, url);
    }
  } finally {
    server.close();
  }
});

// User-defined roles (tumwater.json's customRoles) are first-class transcript targets: the
// GUI marks them with an asterisk, so clicking one must open its panel — /api/transcript
// validates against catalog + customRoles when the config parses.
test("gui /api/transcript accepts user-defined roles listed in tumwater.json", async () => {
  const repo = makeRepo();
  await initProject(repo, "custom transcript test");
  const cfg = loadConfig(repo);
  cfg.customRoles.push({ name: "nightly", task: "do the nightly thing" });
  saveConfig(repo, cfg);
  // A log for the custom role — same shape as a built-in's.
  writeLogLines(piLogPath(repo, "nightly"), [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "did the nightly thing" }],
        },
      }),
    ]);
  const { server, base } = await startLocalGui(repo);
  try {
    // The custom id is accepted and serves its transcript like any built-in's…
    const ok = await getJson<{ lines: string[] }>(base, "/api/transcript?role=nightly");
    assert.ok(ok.lines.some((l) => l.includes("did the nightly thing")));

    // …and an unknown id still 400s — listing customs among the valid ids it accepts.
    const bad = await fetch(base + "/api/transcript?role=nosuch");
    assert.equal(bad.status, 400);
    const body = (await bad.json()) as { error: string };
    assert.match(body.error, /nightly/, "the 400 message lists the custom ids it accepts");
  } finally {
    server.close();
  }
});

test("the dashboard page's inline script is syntactically valid JavaScript", async () => {
  // Regression: the page is authored inside a TS template literal, where a bare \n becomes a
  // REAL newline in the served page — splitting the page's own string literals and killing the
  // whole script with a syntax error ("Unexpected EOF"). Parse every <script> body for real.
  const { GUI_PAGE } = await import("../src/ui/gui/gui-page.js");
  const scripts = [...GUI_PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
  assert.ok(scripts.length >= 1, "page has an inline script");
  for (const body of scripts) {
    assert.doesNotThrow(() => new Function(body), "inline script must parse");
  }
  assert.doesNotMatch(scripts.join("\n"), /AudioContext/, "the dashboard plays no sound");
});

test("the GUI last run cell shows absolute time plus relative age, mirroring the TUI", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui/gui-page.js");
  const { lastRunCell } = await import("../src/ui/status-render.js");

  // Extract the marked region — same regex-extract + new Function pattern as the esc test and
  // sortRoles. fmtLastRun is pure (no DOM), so nothing is injected.
  const m = /\/\/ last-run-fmt:start\n([\s\S]*?)\n  \/\/ last-run-fmt:end/.exec(GUI_PAGE);
  assert.ok(m, "last-run-fmt region found in the page");
  // fmtLastRun now formats its age through the page's shared humanSeconds helper, so the
  // helper's marked region is spliced into the sandbox too (same extraction pattern).
  const hs = /\/\/ human-seconds-fmt:start\n([\s\S]*?)\n  \/\/ human-seconds-fmt:end/.exec(GUI_PAGE);
  assert.ok(hs, "human-seconds-fmt region found in the page");
  const fmtLastRun = new Function(`${hs[1]}\n${m[1]}\nreturn fmtLastRun;`)() as (ts: number | null) => string;

  // The cell renders client-side from the payload's existing lastRunEndedAt field.
  assert.match(GUI_PAGE, /fmtLastRun\(l\.lastRunEndedAt\)/);

  const now = Date.now();
  // The absolute part derives from the fixed ts, so it is stable across the test's own clock
  // drift; only the relative age reads Date.now() at call time. The raw-parts clock is
  // oracles.ts's clockOf, the same builder the status fixtures' stampOf uses.
  const abs = (ts: number) => clockOf(new Date(ts));

  // Never ran.
  assert.equal(fmtLastRun(null), "-");
  assert.equal(fmtLastRun(0), "-");

  // Timestamps sit well inside each bucket so Date.now() drift between the call and the
  // assertion cannot flip a result: 45 s (not near 60); 190 s → 3m (far from the 2.5/3.5 m
  // rounding edges); 7500 s → 2h; ~3 d + 2 h → 3d with the MM-DD prefix.
  const t45 = now - 45_000;
  assert.equal(fmtLastRun(t45), `${abs(t45)} · 45s ago`);

  const t190 = now - 190_000;
  assert.equal(fmtLastRun(t190), `${abs(t190)} · 3m ago`);

  const t2h = now - 7_500_000;
  assert.equal(fmtLastRun(t2h), `${abs(t2h)} · 2h ago`);

  const t3d = now - (3 * 86_400_000 + 7_200_000);
  const day3 = dayKey(t3d).slice(5); // MM-DD, dropped from the raw-parts day key.
  assert.equal(fmtLastRun(t3d), `${day3} ${abs(t3d)} · 3d ago`);

  // The whole cell — absolute stamp and age bucketing — must stay byte-identical to the TUI's
  // lastRunCell, so a drift in either surface fails here.
  for (const ts of [t45, t190, t2h, t3d]) assert.equal(fmtLastRun(ts), lastRunCell(ts));
});

// Full backlog entries:
// /api/backlog serves one entry's title + body on demand, so multi-KB bodies never ride the
// 1-second /api/status poll — and statusPayload keeps carrying titles only.

test("gui /api/backlog-match lists the indexes whose heading or body matches", async () => {
  const repo = makeRepo();
  await initProject(repo, "backlog match gui test");
  writeBacklogFile(repo, "PLANS.md", [
    { heading: "## Planned", body: "### Alpha (planned 2026-09-05)\n\nNothing.\n\n### Bravo (planned 2026-09-05)\n\n**Goal.** Feed the zebra.\n\n### Charlie (planned 2026-09-05)\n\nNothing." },
  ]);
  writeBacklogFile(repo, "BUGS.md", [
    { heading: "## Open", body: "### Zebra crashes (reported 2026-09-05)\n\n**Symptom.** It breaks." },
  ]);
  const { server, base } = await startLocalGui(repo);
  try {
    const d = await getJson<Record<string, unknown>>(base, "/api/backlog-match?grep=ZEBRA");
    assert.deepEqual(d, { plans: [1], bugs: [0], questions: [], done: [], fixed: [], answered: [], queued: [] });
    // Queued messages match on full text, past the 80-character preview; director first.
    const pad = "x".repeat(90);
    const roleFile = enqueueRolePrompt(repo, "feature", `${pad} Zebra role`);
    const dirFile = enqueuePrompt(repo, `${pad} zebra director`);
    enqueuePrompt(repo, `${pad} nothing here`);
    const q = await getJson<{ queued: unknown }>(base, "/api/backlog-match?grep=ZEBRA");
    assert.deepEqual(q.queued, [{ role: "director", file: path.basename(dirFile) }, { role: "feature", file: path.basename(roleFile) }]);
    for (const url of ["/api/backlog-match?grep=%20", "/api/backlog-match"]) {
      assert.equal((await fetch(base + url)).status, 400, url);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("gui /api/backlog serves an entry's title and body and validates file/index", async () => {
  const repo = makeRepo();
  await initProject(repo, "backlog gui test");
  // The second plan is a bare heading: empty body.
  writeBacklogFile(repo, "PLANS.md", [
    {
      heading: "## Planned",
      body: "### First plan (planned 2026-09-05)\n\n**Goal.** The first goal.\n\nA second body line, kept verbatim.\n\n### Second plan (planned 2026-09-04)",
    },
    { heading: "## Done", body: "### Newer plan (done 2026-09-03)\n\n**Goal.** Newer goal.\n\nSecond line.\n\n### Older plan (done 2026-09-02)\n\nOlder body." },
  ]);
  writeBacklogFile(repo, "BUGS.md", [
    { heading: "## Open", body: "### One bug (reported 2026-09-05)\n\n**Symptom.** It breaks.\n\n### Held bug (reported 2026-09-05)\n\n**Refused 2026-10-16 by bugfix: x**" },
    { heading: "## Fixed", body: "### Fixed bug (fixed 2026-09-03)\n\nRoot cause: x." },
  ]);
  writeBacklogFile(repo, "QUESTIONS.md", [
    { heading: "## Open", body: "### Q1: which database?\n\n**Context:** the storage layer is undecided." },
    { heading: "## Answered", body: "### Old Q\n\nOld context.\n\n**Answered 2026-09-01 by user: old**\n\n### New Q\n\nNew context.\n\n**Answered 2026-09-02 by user: new**" },
  ]);

  const { server, base } = await startLocalGui(repo);
  try {
    // index 0 of plans: the first entry's title and full body — interior blank lines kept,
    // leading/trailing blanks trimmed, Done entries never leaking in.
    let res = await fetch(base + "/api/backlog?file=plans&index=0");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      title: "First plan (planned 2026-09-05)",
      body: "**Goal.** The first goal.\n\nA second body line, kept verbatim.",
      refused: false,
    });

    // index 1: a bare heading has an empty body — and it is the LAST planned entry (the Done
    // placeholder never counts), so index 2 is already out of range.
    res = await fetch(base + "/api/backlog?file=plans&index=1");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { title: "Second plan (planned 2026-09-04)", body: "", refused: false });

    // The other files address their own open sections in the same payload order.
    res = await fetch(base + "/api/backlog?file=bugs&index=0");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { title: "One bug (reported 2026-09-05)", body: "**Symptom.** It breaks.", refused: false });
    res = await fetch(base + "/api/backlog?file=bugs&index=1");
    assert.equal(((await res.json()) as { refused: boolean }).refused, true);
    res = await fetch(base + "/api/backlog?file=questions&index=0");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { title: "Q1: which database?", body: "**Context:** the storage layer is undecided.", refused: false });

    // done/fixed address the finished sections, newest first, titles verbatim.
    let fin = await getJson<{ title: string; body: string }>(base, "/api/backlog?file=done&index=0");
    assert.deepEqual([fin.title, fin.body], ["Newer plan (done 2026-09-03)", "**Goal.** Newer goal.\n\nSecond line."]);
    fin = await getJson<{ title: string; body: string }>(base, "/api/backlog?file=done&index=1");
    assert.deepEqual([fin.title, fin.body], ["Older plan (done 2026-09-02)", "Older body."]);
    fin = await getJson<{ title: string; body: string }>(base, "/api/backlog?file=fixed&index=0");
    assert.deepEqual([fin.title, fin.body], ["Fixed bug (fixed 2026-09-03)", "Root cause: x."]);
    // answered is appended to in file order, so index 0 is the newest.
    fin = await getJson<{ title: string; body: string }>(base, "/api/backlog?file=answered&index=0");
    assert.deepEqual([fin.title, fin.body], ["New Q", "New context.\n\n**Answered 2026-09-02 by user: new**"]);
    fin = await getJson<{ title: string; body: string }>(base, "/api/backlog?file=answered&index=1");
    assert.equal(fin.title, "Old Q");
    const ansRange = await getJson<{ error: string }>(base, "/api/backlog?file=answered&index=2");
    assert.match(ansRange.error, /\(answered has 2 entries\)$/);
    const doneRange = await getJson<{ error: string }>(base, "/api/backlog?file=done&index=2");
    assert.match(doneRange.error, /\(done has 2 entries\)$/);

    // Validation: unknown/missing file, missing or bad index, and out-of-range → 400 with a
    // JSON error body (the page's fetch treats any non-2xx as a failed poll).
    for (const url of [
      "/api/backlog?file=notes&index=0",
      "/api/backlog?index=0",
      "/api/backlog?file=plans",
      "/api/backlog?file=plans&index=-1",
      "/api/backlog?file=plans&index=abc",
      "/api/backlog?file=plans&index=2", // only two planned entries
      // Inherited Object.prototype names must not satisfy the file lookup: an object-literal
      // dispatch table would call them (returning 200 `{}` or throwing 500) instead of 400.
      "/api/backlog?file=constructor&index=0",
      "/api/backlog?file=toString&index=0",
      "/api/backlog?file=hasOwnProperty&index=0",
      "/api/backlog?file=__proto__&index=0",
    ]) {
      const r = await fetch(base + url);
      assert.equal(r.status, 400, url);
      assert.match(((await r.json()) as { error: string }).error, /\S/, `${url} carries an error message`);
    }
    // The 400s name the offending value (or say the input is required), so a client can tell
    // a missing file from an unknown one and see which index was out of range.
    const unknownFile = await getJson<{ error: string }>(base, "/api/backlog?file=notes&index=0");
    assert.match(unknownFile.error, /unknown file "notes"/);
    // A near-miss file spelling carries the shared did-you-mean hint, like every other
    // unknown-X error; a value that is no candidate's near-miss (notes) carries none.
    const typoFile = await getJson<{ error: string }>(base, "/api/backlog?file=plnas&index=0");
    assert.match(typoFile.error, /did you mean `plans`/);
    assert.doesNotMatch(unknownFile.error, /did you mean/);
    const missingFile = await getJson<{ error: string }>(base, "/api/backlog?index=0");
    assert.match(missingFile.error, /file required/);
    const outOfRange = await getJson<{ error: string }>(base, "/api/backlog?file=plans&index=2");
    assert.match(outOfRange.error, /index 2 out of range/);

    // Routing is by exact path: a path merely prefixing /api/backlog is not that route.
    for (const url of ["/api/backlogs?file=plans&index=0", "/api/backlogx"]) {
      const r = await fetch(base + url);
      assert.equal(r.status, 404, url);
    }

    // An empty section is out of range at index 0 (seeded placeholders are not entries).
    writeBacklogFile(repo, "BUGS.md", [{ heading: "## Open" }, { heading: "## Fixed" }]);
    res = await fetch(base + "/api/backlog?file=bugs&index=0");
    assert.equal(res.status, 400);

    // The status payload is unchanged by this endpoint: titles only, no bodies.
    const status = await getJson<{ plans: string[] }>(base, "/api/status");
    assert.deepEqual(status.plans, ["First plan (planned 2026-09-05)", "Second plan (planned 2026-09-04)"]);
  } finally {
    server.close();
  }
});

test("gui /api/backlog carries no heldForOperator key for a held-for-operator plan", async () => {
  const repo = makeRepo();
  await initProject(repo, "backlog held-for-operator gui test");
  // A plain planned entry and one carrying a held-for-operator Needs-review note
  // ((held 3)) plus its **Previously held 2** line.
  writeBacklogFile(repo, "PLANS.md", [
    {
      heading: "## Planned",
      body: "### Plain plan (planned 2026-10-05)\n\nbody\n\n### Held plan (planned 2026-10-01)\n\n**Needs review 2026-10-16 by feature: too large for one run (held 3)**\n\n**Previously held 2**",
    },
  ]);
  const { server, base } = await startLocalGui(repo);
  try {
    // The held plan's payload carries no heldForOperator key at all.
    let res = await fetch(base + "/api/backlog?file=plans&index=1");
    assert.equal(res.status, 200);
    const held = (await res.json()) as {
      title: string;
      body: string;
      refused: boolean;
      heldForOperator?: boolean;
    };
    assert.match(held.body, /\*\*Needs review/);
    assert.equal(("heldForOperator" in held), false);
    // The plain plan's payload carries no heldForOperator key at all.
    res = await fetch(base + "/api/backlog?file=plans&index=0");
    const plain = (await res.json()) as Record<string, unknown>;
    assert.equal(("heldForOperator" in plain), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("apiError renders the operator-facing message for every error-body shape", async () => {
  // The guard above is pinned by source shape; this pins its BEHAVIOR — endpoint, HTTP
  // status, and the server's error text joined by the same separator — for every body shape
  // the server sends: JSON {error}, plain text (the 404's "not found"), and an empty body.
  // Extracted like the esc test: the client script's header region up to fmtTokens holds
  // esc/apiError/apiFetch/getJson/postJson, whose only external dependency is fetch.
  const { GUI_PAGE } = await import("../src/ui/gui/gui-page.js");
  const script = GUI_PAGE.slice(GUI_PAGE.indexOf("<script>\n") + "<script>\n".length);
  const head = script.slice(0, script.indexOf("const fmtTokens"));
  let respond: (path: string, init?: unknown) => unknown = () => ({ ok: true, status: 200 });
  const fetchStub = (path: string, init: unknown) => respond(path, init);
  const { apiError, apiFetch, getJson } = new Function(
    "fetch",
    `${head}\nreturn { apiError, apiFetch, getJson };`,
  )(fetchStub) as {
    apiError: (path: string, r: { status: number; text: () => Promise<string> }) => Promise<Error>;
    apiFetch: (path: string, init?: unknown) => Promise<{ json: () => Promise<unknown> }>;
    getJson: (path: string) => Promise<unknown>;
  };

  // JSON {error} body — the common failure: the error text joins the endpoint and status.
  let err = await apiError("/api/budget", {
    status: 400,
    text: async () => '{"error":"maxDailyCostUsd must be a number of 0 or more"}',
  });
  assert.ok(err instanceof Error);
  assert.equal(err.message, "/api/budget failed: HTTP 400 — maxDailyCostUsd must be a number of 0 or more");

  // Plain text (the 404's "not found", or a proxy's HTML error page): the raw body surfaces
  // verbatim instead of being swallowed by the JSON parse.
  err = await apiError("/api/nope", { status: 404, text: async () => "not found" });
  assert.equal(err.message, "/api/nope failed: HTTP 404 — not found");
  err = await apiError("/api/status", { status: 502, text: async () => "<html>bad gateway</html>" });
  assert.equal(err.message, "/api/status failed: HTTP 502 — <html>bad gateway</html>");

  // Empty body: the status alone names the failure, with no dangling separator.
  err = await apiError("/api/status", { status: 500, text: async () => "   ", });
  assert.equal(err.message, "/api/status failed: HTTP 500");

  // apiFetch throws that message on a non-2xx and hands a 2xx response through — so
  // getJson never parses an error body as data.
  respond = () => ({ ok: false, status: 404, text: async () => "not found" });
  await assert.rejects(apiFetch("/api/backlog"), /\/api\/backlog failed: HTTP 404 — not found/);
  await assert.rejects(getJson("/api/backlog"), /HTTP 404/);
  const payload = { paused: false };
  respond = () => ({ ok: true, status: 200, json: async () => payload });
  assert.equal(await getJson("/api/status"), payload, "a 2xx response flows through to the caller");
});

test("the dashboard's periodic fetches ride a bounded wait — pollSignal bounds the poll", async () => {
  // A server that accepts the connection but never answers would otherwise hold the poll open
  // forever (fetch has no default timeout), freezing the page on stale data with no offline
  // alert. The periodic fetches pass pollSignal()'s AbortSignal.timeout through getJson's init
  // into fetch; this pins the thread-through and the bound without waiting real time.
  const { GUI_PAGE } = await import("../src/ui/gui/gui-page.js");
  const script = GUI_PAGE.slice(GUI_PAGE.indexOf("<script>\n") + "<script>\n".length);
  const head = script.slice(0, script.indexOf("const fmtTokens"));
  // A stub AbortSignal whose timeout() records the requested bound and returns a plain marker.
  const requested: number[] = [];
  const fakeAbortSignal = { timeout: (ms: number) => { requested.push(ms); return { aborted: false }; } };
  let lastInit: unknown;
  const fetchStub = (_path: string, init: unknown) => {
    lastInit = init;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
  const { getJson, pollSignal, postJson } = new Function(
    "fetch",
    "AbortSignal",
    `${head}\nreturn { getJson, pollSignal, postJson };`,
  )(fetchStub, fakeAbortSignal) as {
    getJson: (path: string, init?: unknown) => Promise<unknown>;
    pollSignal: () => unknown;
    postJson: (path: string, payload: unknown) => Promise<unknown>;
  };
  await getJson("/api/status", pollSignal());
  assert.deepEqual(requested, [15000], "the periodic fetches are bounded at 15 s");
  // apiFetch merges its own headers in beside the caller's init, so the init that reaches
  // fetch carries the signal plus that (empty) Headers instance.
  const sent = lastInit as { signal?: { aborted: boolean }; headers?: unknown };
  assert.equal(sent.signal?.aborted, false, "the signal rides into fetch as init.signal");
  assert.ok(sent.headers instanceof Headers, "the caller's init still reaches apiFetch's header merge");
  // An operator action passes no signal of its own, so apiFetch supplies its generous default
  // bound: the request still fails loudly on a server that never answers instead of hanging.
  await postJson("/api/pause", { paused: true });
  assert.deepEqual(requested, [15000, 120000], "a signal-less action fetch is bounded by apiFetch's default");
  const actionInit = lastInit as { signal?: { aborted?: boolean } };
  assert.equal(actionInit.signal?.aborted, false, "the default signal rides into the action's fetch");
  // A browser without AbortSignal.timeout keeps the old unbounded fetch instead of crashing.
  const plain = new Function("fetch", "AbortSignal", `${head}\nreturn pollSignal();`)(fetchStub, {});
  assert.deepEqual(plain, {}, "no AbortSignal.timeout means no signal, not a crash");
});

test("the poll chain survives a rejected refresh — pollLoop always reschedules", async () => {
  // The chained poll replaced a setInterval, which fired on schedule no matter what the
  // previous poll did — so its one contract is liveness: even if refresh() rejects (a render
  // bug, a malformed frame), the next poll must still be scheduled, or the page freezes
  // exactly like the wedged server the bounded wait exists to survive. This runs the page's
  // own pollLoop body against a refresh that rejects on its first call and succeeds on its
  // second, with setTimeout captured so no real time passes.
  const { GUI_PAGE } = await import("../src/ui/gui/gui-page.js");
  const src = (/\/\/ One poll in flight[\s\S]*?setTimeout\(pollLoop, 1000\);\n  \}/.exec(GUI_PAGE))?.[0];
  assert.ok(src, "the poll chain is present in the page script");
  const scheduled: Array<{ fn: () => unknown; ms: number }> = [];
  let calls = 0;
  const refresh = () => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("render blew up"));
    return Promise.resolve();
  };
  const errors: string[] = [];
  const { pollLoop } = new Function(
    "refresh",
    "setTimeout",
    "console",
    `${src}\nreturn { pollLoop };`,
  )(refresh, (fn: () => unknown, ms: number) => { scheduled.push({ fn, ms }); return 0; }, { error: (...a: unknown[]) => errors.push(a.map(String).join(" ")) }) as {
    pollLoop: () => Promise<void>;
  };
  await pollLoop();
  assert.equal(calls, 1);
  assert.equal(scheduled.length, 1, "a rejected refresh still schedules the next poll");
  const first = scheduled[0];
  assert.ok(first, "the reschedule is captured");
  assert.equal(first.ms, 1000);
  await first.fn();
  assert.equal(calls, 2, "the chain keeps polling after the failure");
  assert.equal(scheduled.length, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /render blew up/, "the escape is reported, not swallowed silently");
});

// Backlog bodies, plans, and bugs are model-written Markdown the roles edit; with
// --all-interfaces the dashboard is reachable network-wide without auth, so nothing they carry
// may execute in the operator's browser. The page escapes every dynamic value through its own
// esc() (the drawer renders bodies through renderMarkdown, which escapes first — pinned in
// gui-client.test.ts); the server hands the raw text over unchanged.
test("the dashboard page escapes dynamic text, and /api/backlog serves bodies raw", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui/gui-page.js");
  // The capture anchors at the statement's terminating semicolon (end of line), not the first
  // `;` — the replacement map contains one inside its "&amp;" string literal.
  const m = /const esc = \((\w+)\) => (.+);$/m.exec(GUI_PAGE);
  assert.ok(m, "esc definition found in the page");
  const esc = new Function(m[1]!, `return (${m[2]});`) as (s: string) => string;
  assert.equal(esc("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;", "tags are neutralized");
  assert.equal(esc("a & b < c > d"), "a &amp; b &lt; c &gt; d", "ampersands and angle brackets escape");
  // Quotes escape too: esc is interpolated inside single-quoted attribute contexts
  // (data-role='…', title='…'), where an unescaped quote would break out of the attribute.
  assert.equal(esc("' onmouseover='x"), "&#39; onmouseover=&#39;x", "single quotes escape (attribute context)");
  assert.equal(esc('a "b"'), "a &quot;b&quot;", "double quotes escape");

  const repo = makeRepo();
  await initProject(repo, "backlog esc test");
  writeBacklogFile(repo, "BUGS.md", [
    {
      heading: "## Open",
      body: "### A bug with HTML in its body (reported 2026-09-06)\n\n<img src=x onerror=alert(1)>",
    },
    { heading: "## Fixed" },
  ]);
  const { server, base } = await startLocalGui(repo);
  try {
    const res = await fetch(base + "/api/backlog?file=bugs&index=0");
    assert.equal(res.status, 200);
    const d = (await res.json()) as { title: string; body: string };
    assert.equal(d.body, "<img src=x onerror=alert(1)>", "the API serves the raw markdown body");
  } finally {
    server.close();
  }
});

test("the dashboard page reloads itself when the serving build sha changes", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui/gui-page.js");
  // The serving process's own startup sha is remembered beside lastStatus (first non-null wins).
  assert.match(GUI_PAGE, /let lastStatus = null;[\s\S]{0,200}let serverBuildSha = null;/);
  // A later successful poll whose sha differs reloads before any render; the failed-poll catch
  // never touches the variable, so it survives the gap while the server restarts.
  assert.match(
    GUI_PAGE,
    /lastStatus = d;[\s\S]{0,500}d\.serverBuildSha !== serverBuildSha[\s\S]{0,60}location\.reload\(\)/,
  );
});

test("the GUI next run cell mirrors the TUI's nextRunCell rules", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui/gui-page.js");
  const { nextRunCell } = await import("../src/ui/status-render.js");
  const { freshRunnerState } = await import("../src/runner/runner-state.js");
  const { yieldMultiplierFor } = await import("../src/scheduling/backoff.js");
  type RunnerState = ReturnType<typeof freshRunnerState>;

  // The status pill's "wakes in 12m" line and the drawer's Next run both render from the
  // payload's raw nextRunAt/backoffSeconds through this helper.
  assert.match(GUI_PAGE, /fmtNextRun\(l, d\.running\)/);

  // Extract the marked region — same regex-extract + new Function pattern as the esc, sortRoles,
  // and fmtLastRun tests. fmtNextRun is pure (no DOM), so nothing is injected.
  const m = /\/\/ next-run-fmt:start\n([\s\S]*?)\n  \/\/ next-run-fmt:end/.exec(GUI_PAGE);
  assert.ok(m, "next-run-fmt region found in the page");
  // fmtNextRun's countdown goes through the page's shared humanSeconds helper too, so its
  // marked region is spliced in alongside (same extraction pattern as the fmtLastRun test).
  const hs = /\/\/ human-seconds-fmt:start\n([\s\S]*?)\n  \/\/ human-seconds-fmt:end/.exec(GUI_PAGE);
  assert.ok(hs, "human-seconds-fmt region found in the page");
  // …and through the page's shared isActivePhase helper, spliced in alongside (the same
  // extraction pattern).
  const ap = /\/\/ active-phase-fmt:start\n([\s\S]*?)\n  \/\/ active-phase-fmt:end/.exec(GUI_PAGE);
  assert.ok(ap, "active-phase-fmt region found in the page");
  const fmtNextRun = new Function(`${hs[1]}\n${ap[1]}\n${m[1]}\nreturn fmtNextRun;`)() as
    (l: { phase: string; nextRunAt: number; backoffSeconds: number; yieldMultiplier?: number }, teamRunning: boolean) => string;

  const now = Date.now();
  // Each case pins the TUI helper and the GUI twin to the same output, so the two copies
  // cannot drift (the sortRoles/fmtLastRun lockstep precedent).
  const cases: Array<{
    state: Partial<RunnerState>;
    phase: string;
    team: boolean;
    want: string;
  }> = [
    { state: { nextRunAt: now + 180_000, backoffSeconds: 0 }, phase: "queued", team: true, want: "3m" },
    { state: { nextRunAt: now + 180_000, backoffSeconds: 240 }, phase: "queued", team: true, want: "sleeping 3m" },
    { state: { nextRunAt: now - 5_000, backoffSeconds: 0 }, phase: "queued", team: true, want: "now" },
    { state: { nextRunAt: now + 180_000, backoffSeconds: 0, running: true }, phase: "working 3m", team: true, want: "-" },
    { state: { nextRunAt: now + 180_000, backoffSeconds: 0 }, phase: "merging 1m · checking", team: true, want: "-" },
    // A parked waiter: reserved (running) but holding no permit, rendered "waiting to start" —
    // an INACTIVE phase prefix, so the phase-prefix check alone misclassifies it. The TUI
    // catches it via s.running; the GUI copy must too, or a parked role reads "1h" (or
    // "backoff 1h") while it is actually queued behind a slot and may run at any moment.
    { state: { nextRunAt: now + 3_600_000, backoffSeconds: 0, running: true, parkedSince: now - 5_000 }, phase: "waiting to start 5s", team: true, want: "-" },
    { state: { nextRunAt: now + 3_600_000, backoffSeconds: 900, running: true, parkedSince: now - 5_000 }, phase: "waiting to start 5s", team: true, want: "-" },
    { state: { nextRunAt: now + 180_000, backoffSeconds: 0 }, phase: "queued", team: false, want: "-" },
    // Yield-scaled clocks: the payload's yieldMultiplier rides the cell as ×N, the same
    // rule nextRunCell applies — a quiet role's effective gap is longer than the countdown.
    { state: { nextRunAt: now - 5_000, backoffSeconds: 0, recentOutcomes: "n".repeat(16) }, phase: "queued", team: true, want: "now ×4" },
    { state: { nextRunAt: now + 180_000, backoffSeconds: 240, recentOutcomes: "n".repeat(20) }, phase: "queued", team: true, want: "sleeping 3m ×8" },
  ];
  for (const c of cases) {
    const s = { ...freshRunnerState("clean"), ...c.state } as RunnerState;
    const label = `${c.phase} / team ${c.team ? "running" : "stopped"}`;
    assert.equal(nextRunCell(s, c.phase, now, c.team), c.want, `TUI: ${label}`);
    assert.equal(
      fmtNextRun({ phase: c.phase, nextRunAt: s.nextRunAt, backoffSeconds: s.backoffSeconds, yieldMultiplier: yieldMultiplierFor(s) }, c.team),
      c.want,
      `GUI: ${label}`,
    );
  }
  // A torn role object — a payload missing `phase` — must not throw and blank the whole roles
  // table (roleCells runs fmtNextRun for every row). phaseInfo and roleRank already coerce a bad
  // phase with `String(x || "")`; the untyped browser copy here does too, so the field reads as
  // the empty (inactive) phase instead of `undefined.startsWith` throwing.
  assert.equal(
    fmtNextRun(
      { phase: undefined as unknown as string, nextRunAt: now + 180_000, backoffSeconds: 0 },
      true,
    ),
    "3m",
    "GUI: a missing phase reads as text, not a throw",
  );
});

test("the dashboard page is one self-contained document: sidebar, views, composer, drawer, one poll", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui/gui-page.js");
  // The sidebar carries the four views as #fragment links, so Back/Forward and bookmarks work.
  for (const [id, href] of [["tab-team", "#team"], ["tab-history", "#history"], ["tab-usage", "#usage"], ["tab-failures", "#failures"]]) {
    assert.match(GUI_PAGE, new RegExp(`<a href="${href}" id="${id}" class="tab`), `${id} links to ${href}`);
  }
  // Each view's container, the composer (with its target picker), the alerts, and the drawer.
  for (const id of ["team-view", "history", "report", "failures", "promptform", "prompttarget", "prompt", "alerts", "rolerows", "backlog", "feed", "drawer", "budgetwrap", "pausewrap"]) {
    assert.match(GUI_PAGE, new RegExp(`id="${id}"`), `#${id} is in the shell`);
  }
  // The page makes no request off its own server: no remote scripts, styles, fonts, or images.
  assert.doesNotMatch(GUI_PAGE, /(?:src|href)=["']https?:|url\(\s*["']?https?:|@import/, "nothing is fetched from elsewhere");
  // The only timer is the 1 s status poll; everything else refetches on events or on demand.
  // The poll is chained — the next poll starts one interval after the previous settles, and
  // its reschedule sits outside the try, so no two polls can ever be in flight at once.
  assert.equal(GUI_PAGE.match(/setTimeout\(pollLoop, 1000\)/g)?.length ?? 0, 1, "one poll timer");
  assert.doesNotMatch(GUI_PAGE, /setInterval\(/, "no stacked polls");
});

// Image input (plans/image-input.md "Attachments"): the GUI submit gate. An image to a role
// whose seam reads no images answers 400 naming the fix and queues nothing — the peer-tier
// reroute was subtracted (part 5g/6), so even a vision peer tier does not accept a blind role's
// image. The server reads the config per request, so one running server serves both refusals as
// the config changes.
test("gui /api/prompt-role refuses an image for a blind role, even with a vision peer tier", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui image gate");
  const modelsDir = tmpdir("gui-image-");
  writeModelsFile(
    modelsDir,
    JSON.stringify({ providers: { local: { models: [{ id: "text" }, { id: "vision", input: ["text", "image"] }] } } }),
  );
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const image = { name: "shot.png", dataBase64: png.toString("base64") };
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", modelsDir);
  const { server, base } = await startLocalGui(repo);
  try {
    // No configured model can read images → 400 naming the fix, nothing queued.
    writeConfig(repo, { model: { default: "local/text", strong: "local/text" } });
    const refused = await postJson(base, "/api/prompt-role", { role: "feature", text: "look", images: [image] });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /no configured model reads images for it/);
    assert.equal(queuedRolePrompts(repo, "feature").length, 0);

    // A vision strong tier no longer reroutes a blind read (part 5g/6): still refused.
    writeConfig(repo, { model: { default: "local/text", strong: "local/vision" } });
    const refused2 = await postJson(base, "/api/prompt-role", { role: "feature", text: "look", images: [image] });
    assert.equal(refused2.status, 400);
    assert.match(((await refused2.json()) as { error: string }).error, /no configured model reads images for it/);
    assert.equal(queuedRolePrompts(repo, "feature").length, 0, "nothing queued even with a vision peer");
  } finally {
    restoreAgentDir();
    server.close();
  }
});

// The same gate on the edit path (/api/prompt-edit): editing an image into a queued prompt
// whose target role reads no images answers 400 naming the fix and leaves the file untouched —
// the reroute (part 5g/6) no longer accepts it even with a vision peer tier. The queue file is
// addressed by its name, so the refused edit must not rewrite it.
test("gui /api/prompt-edit refuses an image for a blind role, even with a vision peer tier", async () => {
  const repo = makeRepo();
  await initProject(repo, "gui edit image gate");
  const modelsDir = tmpdir("gui-edit-image-");
  writeModelsFile(
    modelsDir,
    JSON.stringify({ providers: { local: { models: [{ id: "text" }, { id: "vision", input: ["text", "image"] }] } } }),
  );
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const image = { name: "shot.png", dataBase64: png.toString("base64") };
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", modelsDir);
  const { server, base } = await startLocalGui(repo);
  try {
    enqueueRolePrompt(repo, "feature", "first body");
    const fileName = path.basename(queuedFiles(repo, "feature")[0] as string);

    // No configured model can read images → 400 naming the fix, the file untouched.
    writeConfig(repo, { model: { default: "local/text", strong: "local/text" } });
    const refused = await postJson(base, "/api/prompt-edit", { role: "feature", file: fileName, text: "edited", images: [image] });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /no configured model reads images for it/);
    assert.equal(fs.readFileSync(path.join(roleInboxDir(repo, "feature"), fileName), "utf8"), "first body", "the refused edit leaves the file untouched");

    // A vision strong tier no longer reroutes (part 5g/6): still refused, the file untouched.
    writeConfig(repo, { model: { default: "local/text", strong: "local/vision" } });
    const refused2 = await postJson(base, "/api/prompt-edit", { role: "feature", file: fileName, text: "edited", images: [image] });
    assert.equal(refused2.status, 400);
    assert.equal(fs.readFileSync(path.join(roleInboxDir(repo, "feature"), fileName), "utf8"), "first body", "still untouched after the reroute-free refusal");
  } finally {
    restoreAgentDir();
    server.close();
  }
});

test("the page shell uses the team, role and inbox words but keeps the old ids and hashes", async () => {
  const { GUI_PAGE } = await import("../src/ui/gui/gui-page.js");
  assert.match(GUI_PAGE, /<span>Team<\/span>/);
  assert.match(GUI_PAGE, /<h2 id="roles-title">Roles<\/h2>/);
  assert.match(GUI_PAGE, /<th class="c-role">Role<\/th>/);
  assert.match(GUI_PAGE, /placeholder="Tell the team what to do next…"/);
  assert.match(GUI_PAGE, /<option value="">All roles<\/option>/);
  assert.match(GUI_PAGE, /href="#team" id="tab-team"/, "the hash and ids stay for later series");
});
