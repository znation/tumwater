import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runDoctor } from "../src/doctor/doctor.js";
import { renderDoctor } from "../src/doctor/doctor-render.js";
import { helpTopic } from "../src/cli/help.js";
import { initProject } from "../src/init/init.js";
import { gitOnlyBinDir, makeRepo, tmpdir, writeMalformedJson } from "./repo-fixtures.js";
import { writeOrchestratorMarker } from "./log-fixtures.js";
import { pathPrepend } from "./fake-commands.js";
import { cli, cliWithEnv } from "./cli-harness.js";
import { fakeBins, hermeticHostBins, noProcesses, readyRepo } from "./doctor-fixtures.js";

// Composition and CLI-wiring coverage for src/doctor/doctor.ts: runDoctor's fixed check order, header,
// verdict counting, and corrupt-config resilience, renderDoctor's rendering, and the `tumwater
// doctor` CLI contract pinned through main() (no readiness gate, --json payload, exit codes).
// The individual checks' ok/fail/warn branches are unit-covered in test/doctor-checks.test.ts
// (it pins src/doctor/doctor-checks.ts), the model-readiness checks in
// test/doctor-model-checks.test.ts, the orphan check in test/doctor-orphans.test.ts, and the
// fixtures all three files share live in test/doctor-fixtures.ts.
test("runDoctor composes the full report — fixed check order, not-running header, ready verdict", async () => {
  const root = readyRepo();
  // An npm check so the report's all-ok sweep below holds — a repo with neither a configured
  // check nor an npm script reads a project-check warn (the warn case has its own test).
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  // A marked brief so the report's all-ok sweep below holds — no brief file reads a brief warn
  // (the warn case has its own test).
  fs.writeFileSync(
    path.join(root, "README.md"),
    `# p\n\n<!-- tumwater:prompt:start -->\nbrief\n<!-- tumwater:prompt:end -->\n`,
  );
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.mkdirSync(path.join(root, ".tumwater"), { recursive: true });
  fs.writeFileSync(path.join(root, ".tumwater", "keep.txt"), "x\n");
  const before = fs.readdirSync(path.join(root, ".tumwater")).sort();

  const report = await runDoctor(root, fakeBins("git", "pi"), noProcesses);
  assert.equal(report.header, "tumwater doctor — harness not running");
  assert.deepEqual(
    report.checks.map((c) => c.name),
    ["node", "git binary", "repo", "init", "brief", "fallback", "tier models", "pi binary", "state dir", "merge lock", "disk space", "project check", "fix claims", "stranded plans", "backlog headings", "build", "orphans", "mach ports"],
  );
  // The node check reflects the runtime running the suite, which is at or above the declared
  // floor in practice; assert it is never a failure rather than pinning CI's Node version.
  for (const c of report.checks)
    if (c.name !== "node") assert.equal(c.level, "ok", `${c.name}: ${c.detail}`);
  const nodeCheck = report.checks.find((c) => c.name === "node");
  assert.ok(nodeCheck, "the node check is part of the report");
  assert.notEqual(nodeCheck.level, "fail");
  assert.equal(report.verdict, "ready to run");

  // Read-only guarantee: a full doctor run changes nothing under .tumwater/.
  const after = fs.readdirSync(path.join(root, ".tumwater")).sort();
  assert.deepEqual(after, before);
});

test("runDoctor counts failures in the verdict — plural and singular", async () => {
  // No tumwater.json (init fails) plus an empty PATH (git and pi fail): three problems.
  const report = await runDoctor(makeRepo(), "", noProcesses);
  assert.equal(report.verdict, "3 problems");
  assert.deepEqual(
    report.checks.filter((c) => c.level === "fail").map((c) => c.name),
    ["git binary", "init", "pi binary"],
  );

  // A ready repo whose PATH has git but no pi: exactly one problem (singular).
  const singular = await runDoctor(readyRepo(), fakeBins("git"), noProcesses);
  assert.equal(singular.verdict, "1 problem");
});

test("runDoctor's header names the live orchestrator pid when the harness is running", async () => {
  const root = readyRepo();
  writeOrchestratorMarker(root, []);
  const report = await runDoctor(root, fakeBins("git", "pi"), noProcesses);
  assert.equal(report.header, `tumwater doctor — harness running (pid ${process.pid})`);
});

test("runDoctor's header carries the running build's sha, staleness, and restart block", async () => {
  // orchestrator.json's build field is what an operator reads to answer "why is doctor saying
  // STALE / restart blocked" — the header must surface all three states, not just the pid.
  const sha = "a".repeat(40);
  const writeInfo = (build: Record<string, unknown>) => {
    const root = readyRepo();
    writeOrchestratorMarker(root, [], { build });
    return root;
  };

  // Fresh, un-stale build: just the sha.
  const fresh = await runDoctor(writeInfo({ sha, builtAt: Date.now() }), fakeBins("git", "pi"), noProcesses);
  assert.match(fresh.header, new RegExp(`harness running \\(pid ${process.pid}, build ${sha.slice(0, 8)}\\)`));
  assert.doesNotMatch(fresh.header, /STALE|restart blocked/);

  // Stale build whose auto-restart is under way: STALE, no block note.
  const stale = await runDoctor(
    writeInfo({ sha, builtAt: Date.now(), stale: true, aheadCommits: 2 }),
    fakeBins("git", "pi"),
    noProcesses,
  );
  assert.match(stale.header, new RegExp(`build ${sha.slice(0, 8)} — STALE\\)`));

  // Stale build whose auto-restart was REFUSED: the block reason is the operator's answer.
  const blocked = await runDoctor(
    writeInfo({ sha, builtAt: Date.now(), stale: true, aheadCommits: 3, restartBlocked: "main deadbeef is red" }),
    fakeBins("git", "pi"),
    noProcesses,
  );
  assert.match(blocked.header, new RegExp(`build ${sha.slice(0, 8)} — STALE \\(restart blocked\\)`));
});

test("runDoctor survives a corrupt config and lets the init check report it", async () => {
  // loadConfig throwing must not take down the one command an operator runs to find out why
  // nothing works — doctor degrades to the init check's failure detail instead.
  const root = makeRepo();
  writeMalformedJson(path.join(root, "tumwater.json"));
  const report = await runDoctor(root, fakeBins("git", "pi"), noProcesses);
  assert.match(report.header, /harness not running/);
  const init = report.checks.find((c) => c.name === "init");
  assert.equal(init?.level, "fail");
  assert.ok(init && init.detail.length > 0, "the init check names the config problem");
});

test("renderDoctor prints one padded line per check between the header and the verdict", () => {
  const rendered = renderDoctor({
    header: "tumwater doctor — harness not running",
    checks: [
      { name: "git binary", level: "ok", detail: "/usr/bin/git" },
      { name: "merge lock", level: "warn", detail: "stale — will be broken on next merge" },
      { name: "repo", level: "fail", detail: "not a git repository (run `git init` first)" },
    ],
    verdict: "1 problem",
  });
  assert.equal(
    rendered,
    [
      "tumwater doctor — harness not running",
      "ok    git binary   /usr/bin/git",
      "warn  merge lock   stale — will be broken on next merge",
      "fail  repo         not a git repository (run `git init` first)",
      "1 problem",
    ].join("\n"),
  );
});

test("runDoctor includes the build check and never fails the exit on a stale build", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "tumwater.json"), "{}");
  const report = await runDoctor(repo, fakeBins("git", "pi"), noProcesses);
  const build = report.checks.find((c) => c.name === "build");
  assert.ok(build, "the build check is part of the report");
  assert.notEqual(build.level, "fail");
});

test("runDoctor reports a phantom fix record as a warn that never fails the verdict", async () => {
  const root = readyRepo();
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "# Bugs\n\n## Open\n\n## Fixed\n\n### A phantom (found by qa 2026-09-22, fixed 2026-09-22)\n\n**Fix:** `runScriptGroup` signals the tree.\n",
  );
  const report = await runDoctor(root, fakeBins("git", "pi"), noProcesses);
  const claims = report.checks.find((c) => c.name === "fix claims");
  assert.equal(claims?.level, "warn");
  assert.match(claims?.detail ?? "", /runScriptGroup/);
  assert.equal(report.verdict, "ready to run");
});

// --- doctor through the real CLI entry point: main()'s wiring the in-process pins above
// cannot see — doctor runs WITHOUT a readiness gate (it must report why the environment
// isn't ready, not refuse like status), renders the full report to stdout, rejects unknown
// arguments, and honors the exit-code contract that makes it scriptable: 0 when no check
// fails, 1 otherwise. Warnings never fail.

test("doctor runs outside a git repo — reports every problem instead of gating", async () => {
  // A bare directory with a PATH holding only git (no pi): every check's outcome is
  // deterministic, and the command must not refuse to run like status does. Without the
  // missing-gate regression this would print "not a git repository" to stderr and exit 1
  // without ever showing the other checks.
  const binDir = gitOnlyBinDir();

  const r = await cliWithEnv(tmpdir(), { PATH: binDir }, ["doctor"]);
  assert.equal(r.code, 1, `expected exit 1 with failing checks:\n${r.stdout}\n${r.stderr}`);
  // The full report is printed — one line per check in fixed order, not the first error.
  assert.match(r.stdout, /tumwater doctor — harness not running/);
  assert.match(r.stdout, /ok\s+git binary/);
  assert.match(r.stdout, /fail\s+repo\s+not a git repository/);
  assert.match(r.stdout, /fail\s+init\s+not initialized/);
  assert.match(r.stdout, /fail\s+pi binary\s+pi not found on PATH/);
  assert.match(r.stdout, /ok\s+state dir/);
  assert.match(r.stdout, /ok\s+merge lock/);
  assert.match(r.stdout, /warn\s+project check/);
  // No ps on this PATH either: the orphan scan degrades to a warn instead of crashing doctor.
  assert.match(r.stdout, /warn\s+orphans\s+could not scan the process table/);
  // The verdict counts the fails (repo + init + pi) and nothing else.
  assert.match(r.stdout, /3 problems/);
});

test("doctor exits 0 on a ready repo; a stale merge lock warns without failing", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli doctor test");

  // A stale merge lock (dead pid) is a warning: it self-heals on the next merge, so it must
  // not flip the exit code — scripts key off 0/1 for real problems only.
  const lockDir = path.join(repo, ".tumwater", "merge.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "pid"), String(2_000_000_000)); // beyond any pid space

  // The orphan scan reads a fake table, not the host's: a real orphan anywhere on the machine
  // (a leaked test victim carrying a dead run's mark) would fail doctor's exit and with it
  // this suite, naming an unrelated commit as the cause (BUGS.md 2026-09-30). The marker file
  // pins the hermeticity below — a revert to the host probe fails here, not at the next leak.
  const psRan = path.join(tmpdir("doctor-ps-"), "ran");
  const restore = pathPrepend(hermeticHostBins(psRan));
  try {
    const r = await cli(repo, "doctor");
    assert.equal(r.code, 0, `expected exit 0 on a ready repo:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /tumwater doctor — harness not running/);
    for (const line of [
      /ok\s+git binary/,
      /ok\s+repo\s+repo at \S+ — on branch main/,
      /ok\s+init/,
      /ok\s+pi binary/,
      /ok\s+state dir/,
      /warn\s+merge lock\s+stale — will be broken on next merge/,
      /warn\s+project check/,
      // The real process-table scan: a fresh repo has no worktree, so no orphan either.
      /ok\s+orphans\s+none/,
    ]) {
      assert.match(r.stdout, line);
    }
    assert.match(r.stdout, /ready to run/);
    assert.ok(
      fs.existsSync(psRan),
      "the orphan scan never ran the fake ps — the CLI probe fell through to the host's real process table",
    );
  } finally {
    restore();
  }
});

test("doctor --json prints the collector's own payload, matching the plain render", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli doctor json");

  // Same hermetic PATH as the plain-render wiring test above: the orphan scan reads the fake
  // empty table (psRan marks that it ran), never the host's real one (BUGS.md 2026-09-30).
  const psRan = path.join(tmpdir("doctor-ps-"), "ran");
  const restore = pathPrepend(hermeticHostBins(psRan));
  try {
    const plain = await cli(repo, "doctor");
    assert.equal(plain.code, 0, `expected exit 0:\n${plain.stdout}\n${plain.stderr}`);
    const json = await cli(repo, "doctor", "--json");
    assert.equal(json.code, 0, `expected exit 0:\n${json.stdout}\n${json.stderr}`);

    // The flag never emits prose: the whole stdout is one JSON.parse-able document carrying
    // the DoctorReport object itself — header, the checks array, and the verdict.
    const report = JSON.parse(json.stdout);
    assert.equal(typeof report.header, "string");
    assert.match(report.header, /tumwater doctor/);
    assert.equal(typeof report.verdict, "string");
    assert.ok(Array.isArray(report.checks) && report.checks.length > 0, "checks array missing");
    for (const c of report.checks) {
      assert.ok(["ok", "warn", "fail"].includes(c.level), `unexpected level: ${c.level}`);
      assert.equal(typeof c.name, "string");
      assert.equal(typeof c.detail, "string");
    }

    // The two forms cannot drift: the JSON tuples equal, in order, the check lines the
    // plain render prints for the same fixture — rendering the parsed payload must match
    // the plain run's prose byte-for-byte (header, every check line in order, verdict),
    // with say()'s final newline added. Two details are host-volatile between two back-to-back
    // invocations — the mach-port count and the free-disk-space figure — so both are masked
    // before the comparison; every other byte must agree, the harness build stamp included: no
    // test writes the running checkout's dist/build-info.json any more (the gui-reload test
    // used to swap it mid-suite; BUGS.md 2026-09-29). The disk figure is read fresh by each
    // `doctor` invocation, so on a busy host the second run can see 0.1 GB less free than the
    // first and the byte comparison flakes without this mask.
    const maskVolatile = (text: string): string =>
      text.replace(/holds \d+/g, "holds <n>").replace(/\d+\.\d+ GB free/g, "<n> GB free");
    assert.equal(maskVolatile(renderDoctor(report) + "\n"), maskVolatile(plain.stdout));

    // The help topic derives from the same stanza and names the new flag.
    assert.match(helpTopic("doctor")!, /--json/);
    assert.ok(
      fs.existsSync(psRan),
      "the orphan scan never ran the fake ps — the CLI probe fell through to the host's real process table",
    );
  } finally {
    restore();
  }
});

test("doctor --json keeps the exit-code contract: fail checks exit 1 with no prose", async () => {
  // The same broken-environment fixture the plain-render test uses: a bare directory whose
  // PATH holds only git. The JSON form must exit 1 exactly when the prose form does, and its
  // checks must carry the failing levels a script keys off.
  const binDir = gitOnlyBinDir();

  const r = await cliWithEnv(tmpdir(), { PATH: binDir }, ["doctor", "--json"]);
  assert.equal(r.code, 1, `expected exit 1 with failing checks:\n${r.stdout}\n${r.stderr}`);
  const report = JSON.parse(r.stdout); // no prose around the document, even on failure
  assert.ok(report.checks.some((c: { level: string }) => c.level === "fail"));
  assert.ok(report.checks.some((c: { level: string }) => c.level === "warn"));
  assert.ok(!report.checks.some((c: { level: string }) => c.level !== c.level.toLowerCase()));
  assert.match(report.verdict, /3 problems/);
});

test("doctor rejects unknown arguments", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli doctor args");

  // --json is now the one accepted flag; --verbose is still unknown beside it, named by the
  // shared rejector the same way status names an unknown flag beside its own --json.
  const r = await cli(repo, "doctor", "--verbose");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument: --verbose/);
});
