import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { okOutcome } from "../src/doctor/outcome.js";
import { runDoctor, runDoctorCheck } from "../src/doctor/doctor.js";
import { DOCTOR_CHECK_NAMES } from "../src/doctor/doctor-check-names.js";
import type { ProcessProbe } from "../src/process/process-table.js";
import { renderDoctor, renderDoctorProblems, problemsOnly } from "../src/doctor/doctor-render.js";
import { helpTopic } from "../src/cli/help.js";
import { initProject } from "../src/init/init.js";
import { gitOnlyBinDir, makeRepo, sh, tmpdir, writeMalformedJson, writeConfig } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { pathPrepend } from "./fakes/fake-commands.js";
import { cli, cliWithEnv, CLI_COMPLETION_TIMEOUT_MS } from "./helpers/cli-harness.js";
import { diskHermeticRepo, fakeBins, hermeticHostBins, noProcesses, readyRepo } from "./fixtures/doctor-fixtures.js";
import { BYTES_PER_GB } from "../src/gates/disk-gate.js";

// Composition and CLI-wiring coverage for src/doctor/doctor.ts: runDoctor's fixed check order,
// header,
// verdict counting, and corrupt-config resilience, renderDoctor's rendering, and the `tumwater
// doctor` CLI contract pinned through main() (no readiness gate, --json payload, exit codes).
// The individual checks' ok/fail/warn branches are unit-covered in test/doctor-checks.test.ts
// (it pins src/doctor/doctor-checks.ts, src/doctor/doctor-project-checks.ts and
// src/doctor/doctor-contention-checks.ts), the
// model-readiness checks in
// test/doctor-model-checks.test.ts, the orphan check in test/doctor-orphans.test.ts, and the
// fixtures all three files share live in test/fixtures/doctor-fixtures.ts.
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
  // A PRINCIPLES.md under the cap so the principles row reads ok like the rest (its warn
  // branch has its own test in doctor-checks.test.ts).
  fs.writeFileSync(path.join(root, "PRINCIPLES.md"), `# Principles\n- keep it simple\n`);
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.mkdirSync(path.join(root, ".tumwater"), { recursive: true });
  fs.writeFileSync(path.join(root, ".tumwater", "keep.txt"), "x\n");
  const before = fs.readdirSync(path.join(root, ".tumwater")).sort();

  const report = await runDoctor(root, fakeBins("git", "pi"), noProcesses);
  assert.equal(report.header, "tumwater doctor — not running");
  assert.deepEqual(
    report.checks.map((c) => c.name),
    ["node", "node binary", "git binary", "repo", "init", "config key names", "brief", "principles", "bootstrap", "pause", "quiet hours", "budget", "provider waits", "maintenance allowance", "provider concurrency", "provider contention", "check contention", "repeated failures", "main's check", "over-cap model", "fallback chain", "models for each tier", "claude auth", "claude api key", "claude version", "opencode version", "opencode", "backend binary", "claude transcripts", "pi extensions", "state dir", "event log", "notify", "merge lock", "workspaces", "parallel instances", "leftover role branches", "tumwater pins", "disk space", "check", "ci parity", "qa coverage", "role notes", "root install", "flaky checks", "post-merge churn", "claimed bugs", "validation gaps", "plans stuck in Planned", "backlog headings", "backlog archive", "refusals", "stalled entries", "plan dependencies", "stale questions", "stale bugs", "regressed fixes", "stale merge-queue entries", "merge-queue files", "post-merge reviews", "main diff rules", "dropped post-merge reviews", "stale prompts", "uncommitted backlog", "update", "orphans", "macOS port leak"],
  );
  // funes is absent: the fake PATH has no funes; and the two subscription-window rows are
  // conditional (a ready repo has no claude or codex subscription account, so both are omitted).
  // The feedback filing row is conditional on `roles.feedback.enabled`, off by default; and the
  // seven codex rows are conditional on a codex seam, absent here, so they are omitted too.
  assert.deepEqual(
    DOCTOR_CHECK_NAMES.filter(
      (n) =>
        n !== "funes" &&
        n !== "claude window" &&
        n !== "codex window" &&
        n !== "feedback filing" &&
        n !== "codex version" &&
        n !== "codex login" &&
        n !== "codex home" &&
        n !== "codex models" &&
        n !== "codex account" &&
        n !== "codex leaks" &&
        n !== "codex sessions" &&
        n !== "codex write guard",
    ),
    report.checks.map((c) => c.name),
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
  // No tumwater.json (init fails) plus an empty PATH (git and pi fail): three problems. The
  // disk sampler is injected (100 GB, the gate-polls tests' ample sample) so the host's real
  // free space cannot add a fourth — the config is absent by design, so the disk step would
  // fall back to the 10 GB default.
  const report = await runDoctor(makeRepo(), "", noProcesses, undefined, () => 100 * BYTES_PER_GB);
  assert.equal(report.verdict, "3 problems");
  assert.deepEqual(
    report.checks.filter((c) => c.level === "fail").map((c) => c.name),
    ["git binary", "init", "backend binary"],
  );

  // A ready repo whose PATH has git but no pi: exactly one problem (singular).
  const singular = await runDoctor(readyRepo(), fakeBins("git"), noProcesses, undefined, () => 100 * BYTES_PER_GB);
  assert.equal(singular.verdict, "1 problem");
});

test("runDoctor's header names the live orchestrator pid when the harness is running", async () => {
  const root = readyRepo();
  writeOrchestratorMarker(root, []);
  const report = await runDoctor(root, fakeBins("git", "pi"), noProcesses);
  assert.equal(report.header, `tumwater doctor — running (pid ${process.pid})`);
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
  assert.match(fresh.header, new RegExp(`running \\(pid ${process.pid}, version ${sha.slice(0, 8)}\\)`));
  assert.doesNotMatch(fresh.header, /update available|restart blocked/);

  // Stale build whose auto-restart is under way: STALE, no block note.
  const stale = await runDoctor(
    writeInfo({ sha, builtAt: Date.now(), stale: true, aheadCommits: 2 }),
    fakeBins("git", "pi"),
    noProcesses,
  );
  assert.match(stale.header, new RegExp(`version ${sha.slice(0, 8)} — update available\\)`));

  // Stale build whose auto-restart was REFUSED: the block reason is the operator's answer.
  const blocked = await runDoctor(
    writeInfo({ sha, builtAt: Date.now(), stale: true, aheadCommits: 3, restartBlocked: "main deadbeef is red" }),
    fakeBins("git", "pi"),
    noProcesses,
  );
  assert.match(blocked.header, new RegExp(`version ${sha.slice(0, 8)} — update available \\(restart blocked\\)`));
});

test("runDoctor survives a corrupt config and lets the init check report it", async () => {
  // loadConfig throwing must not take down the one command an operator runs to find out why
  // nothing works — doctor degrades to the init check's failure detail instead.
  const root = makeRepo();
  writeMalformedJson(path.join(root, "tumwater.json"));
  const report = await runDoctor(root, fakeBins("git", "pi"), noProcesses);
  assert.match(report.header, /not running/);
  const init = report.checks.find((c) => c.name === "init");
  assert.equal(init?.level, "fail");
  assert.ok(init && init.detail.length > 0, "the init check names the config problem");
});

test("renderDoctor prints one padded line per check between the header and the verdict", () => {
  const rendered = renderDoctor({
    header: "tumwater doctor — not running",
    checks: [
      { name: "git binary", level: "ok", detail: "/usr/bin/git" },
      { name: "merge lock", level: "warn", detail: "stale — will be broken on next merge" },
      { name: "repo", level: "fail", detail: "not a git repository (run `git init` first)" },
    ],
    routing: [],
    verdict: "1 problem",
  });
  assert.equal(
    rendered,
    [
      "tumwater doctor — not running",
      "ok    git binary   /usr/bin/git",
      "warn  merge lock   stale — will be broken on next merge",
      "fail  repo         not a git repository (run `git init` first)",
      "1 problem",
    ].join("\n"),
  );
});

test("renderDoctor widens the name column to the longest check name so details align", () => {
  const rendered = renderDoctor({
    header: "h",
    checks: [
      { name: "repo", level: "ok", detail: "D1" },
      { name: "backlog headings", level: "warn", detail: "D2" },
      { name: "update", level: "ok", detail: "D3" },
    ],
    routing: [],
    verdict: "v",
  });
  const lines = rendered.split("\n");
  const detailCol = lines[1]!.indexOf("D1");
  assert.equal(lines[2]!.indexOf("D2"), detailCol);
  assert.equal(lines[3]!.indexOf("D3"), detailCol);
  assert.ok(lines[1]!.startsWith("ok    repo"), `expected the short row to keep its historical shape, got ${JSON.stringify(lines[1])}`);
});

test("renderDoctor prints the routing table and runDoctor lists a fallback seam", async () => {
  // plans/provider-concurrency.md §9 part 1/4's routing table: runDoctor derives every seam
  // (including a fallback-only claude) from the one seamsInUse list, and renderDoctor shows it.
  const rendered = renderDoctor({
    header: "h",
    checks: [],
    routing: [{ label: "fallback:default", selector: "claude/claude-sonnet-5-5", backend: "claude" }],
    verdict: "v",
  });
  assert.match(rendered, /routing:/);
  assert.match(rendered, /fallback:default/);
  assert.match(rendered, /claude\/claude-sonnet-5-5/);
  assert.match(rendered, /\(claude\)/);

  const root = readyRepo();
  writeConfig(root, { model: "local/free-model", fallback: [{ backend: "claude", model: "claude-sonnet-5-5" }] });
  const report = await runDoctor(root, fakeBins("git", "pi"), noProcesses);
  assert.ok(
    report.routing.some((s) => s.label === "fallback:default" && s.backend === "claude"),
    `the routing table lists the fallback claude seam: ${JSON.stringify(report.routing)}`,
  );
});

test("runDoctor includes the build check and never fails the exit on a stale build", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "tumwater.json"), "{}");
  const report = await runDoctor(repo, fakeBins("git", "pi"), noProcesses);
  const build = report.checks.find((c) => c.name === "update");
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
  const claims = report.checks.find((c) => c.name === "claimed bugs");
  assert.equal(claims?.level, "warn");
  assert.match(claims?.detail ?? "", /runScriptGroup/);
  assert.equal(report.verdict, "ready to run");
});

test("runDoctor composes a validation-gaps row that warns but never fails the verdict", async () => {
  const root = readyRepo();
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    "# Bugs\n\n## Open\n\n## Fixed\n\n### A typo (found by qa 2026-09-22, fixed 2026-09-22)\n\n**Symptom:** it broke.\n\n- **Validation gap:** no-reprod — could not reproduce it.\n",
  );
  const report = await runDoctor(root, fakeBins("git", "pi"), noProcesses);
  const gaps = report.checks.find((c) => c.name === "validation gaps");
  assert.ok(gaps, "the validation-gaps check is part of the report");
  assert.equal(gaps.level, "warn");
  assert.match(gaps.detail ?? "", /no-reprod/);
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
  // without ever showing the other checks. The dir carries a config with both disk
  // thresholds off: the CLI child reads the host's real free space, and a hosted runner
  // under the 10 GB default floor would add a disk fail the fixture cannot control (CI's
  // ubuntu-26.04 image, 2026-10-22). The init check's fail case keeps its own coverage in
  // the runDoctor counts test above, which injects its disk sample.
  const binDir = gitOnlyBinDir();
  const dir = tmpdir();
  writeConfig(dir, { diskHoldGB: 0, diskReclaimGB: 0 });

  const r = await cliWithEnv(dir, { PATH: binDir }, ["doctor"]);
  assert.equal(r.code, 1, `expected exit 1 with failing checks:\n${r.stdout}\n${r.stderr}`);
  // The full report is printed — one line per check in fixed order, not the first error.
  assert.match(r.stdout, /tumwater doctor — not running/);
  assert.match(r.stdout, /ok\s+git binary/);
  assert.match(r.stdout, /fail\s+repo\s+not a git repository/);
  assert.match(r.stdout, /ok\s+init/);
  assert.match(r.stdout, /fail\s+backend binary\s+pi not found on PATH/);
  assert.match(r.stdout, /ok\s+state dir/);
  assert.match(r.stdout, /ok\s+merge lock/);
  assert.match(r.stdout, /warn\s+check/);
  // No ps on this PATH either: the orphan scan degrades to a warn instead of crashing doctor.
  assert.match(r.stdout, /warn\s+orphans\s+could not scan the process table/);
  // The verdict counts the fails (repo + pi) and nothing else.
  assert.match(r.stdout, /2 problems/);
});

test("doctor exits 0 on a ready repo; a stale merge lock warns without failing", async () => {
  const repo = await diskHermeticRepo("cli doctor test");

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
  const topRan = `${psRan}-top`;
  const restore = pathPrepend(hermeticHostBins(psRan));
  try {
    const r = await cli(repo, "doctor");
    assert.equal(r.code, 0, `expected exit 0 on a ready repo:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /tumwater doctor — not running/);
    for (const line of [
      /ok\s+git binary/,
      /ok\s+repo\s+repo at \S+ — on branch main/,
      /ok\s+init/,
      /ok\s+backend binary/,
      /ok\s+state dir/,
      /warn\s+merge lock\s+stale — will be broken on next merge/,
      /warn\s+check/,
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
    if (process.platform === "darwin")
      assert.ok(
        fs.existsSync(topRan),
        "the port check never ran the fake top — the CLI fell through to the host's live top sample",
      );
  } finally {
    restore();
  }
});

test("doctor --json prints the collector's own payload, matching the plain render", async () => {
  const repo = await diskHermeticRepo("cli doctor json");

  // Same hermetic PATH as the plain-render wiring test above: the orphan scan reads the fake
  // empty table (psRan marks that it ran), never the host's real one (BUGS.md 2026-09-30).
  const psRan = path.join(tmpdir("doctor-ps-"), "ran");
  const topRan = `${psRan}-top`;
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
    // with say()'s final newline added. One detail is host-volatile between two back-to-back
    // invocations — the free-disk-space figure — so it is masked before the comparison; every
    // other byte must agree, the harness build stamp included: no test writes the running
    // checkout's dist/build-info.json any more (the gui-reload test used to swap it mid-suite;
    // BUGS.md 2026-09-29). The disk figure is read fresh by each `doctor` invocation, so on a
    // busy host the second run can see 0.1 GB less free than the first and the byte comparison
    // flakes without this mask. The mach-port count needs no mask: the fake `top` on the
    // hermetic PATH answers both invocations with the same canned sample, so the port line is
    // part of the byte comparison and can no longer time out under load in one run and not the
    // other (BUGS.md 2026-10-07).
    const maskVolatile = (text: string): string => text.replace(/\d+\.\d+ GB free/g, "<n> GB free");
    assert.equal(maskVolatile(renderDoctor(report) + "\n"), maskVolatile(plain.stdout));

    // The help topic derives from the same stanza and names the new flag.
    assert.match(helpTopic("doctor")!, /--json/);
    assert.ok(
      fs.existsSync(psRan),
      "the orphan scan never ran the fake ps — the CLI probe fell through to the host's real process table",
    );
    if (process.platform === "darwin")
      assert.ok(
        fs.existsSync(topRan),
        "the port check never ran the fake top — the CLI fell through to the host's live top sample",
      );
  } finally {
    restore();
  }
});

test("doctor --json keeps the exit-code contract: fail checks exit 1 with no prose", async () => {
  // The same broken-environment fixture the outside-a-git-repo test above uses: a bare
  // directory whose PATH holds only git, carrying the disk-off config so the CLI child's
  // disk row cannot read the host's real free space. The JSON form must exit 1 exactly
  // when the prose form does, and its checks must carry the failing levels a script keys off.
  const binDir = gitOnlyBinDir();
  const dir = tmpdir();
  writeConfig(dir, { diskHoldGB: 0, diskReclaimGB: 0 });

  const r = await cliWithEnv(dir, { PATH: binDir }, ["doctor", "--json"]);
  assert.equal(r.code, 1, `expected exit 1 with failing checks:\n${r.stdout}\n${r.stderr}`);
  const report = JSON.parse(r.stdout); // no prose around the document, even on failure
  assert.ok(report.checks.some((c: { level: string }) => c.level === "fail"));
  assert.ok(report.checks.some((c: { level: string }) => c.level === "warn"));
  assert.ok(!report.checks.some((c: { level: string }) => c.level !== c.level.toLowerCase()));
  assert.match(report.verdict, /2 problems/);
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

const problemsReport = (checks: Array<{ name: string; level: "ok" | "warn" | "fail"; detail: string }>) => ({
  header: "tumwater doctor — not running",
  checks,
  routing: [{ label: "director", selector: "m", backend: "pi" }],
  verdict: "2 problems",
});

test("renderDoctorProblems prints header, warn and fail rows, the hidden count, and the verdict", () => {
  const out = renderDoctorProblems(
    problemsReport([
      { name: "okone", level: "ok", detail: "fine" },
      { name: "warny", level: "warn", detail: "hmm" },
      { name: "oktwo", level: "ok", detail: "fine" },
      { name: "faily", level: "fail", detail: "bad" },
      { name: "okthree", level: "ok", detail: "fine" },
    ]),
  );
  const lines = out.split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines[0]!, /^tumwater doctor/);
  assert.match(lines[1]!, /^warn\s+warny/);
  assert.match(lines[2]!, /^fail\s+faily/);
  assert.match(lines[3]!, /^3 ok checks hidden/);
  assert.equal(lines[4], "2 problems");
  assert.doesNotMatch(out, /routing:|okone|oktwo|okthree/);
});

test("renderDoctorProblems with only ok rows, and with none", () => {
  const ok = { name: "a", level: "ok" as const, detail: "x" };
  assert.deepEqual(renderDoctorProblems(problemsReport([ok])).split("\n"), [
    "tumwater doctor — not running",
    "1 ok check hidden — run tumwater doctor for the full report",
    "2 problems",
  ]);
  assert.equal(renderDoctorProblems(problemsReport([])).split("\n").length, 2);
});

test("problemsOnly keeps header, routing and verdict and drops only the ok checks", () => {
  const r = problemsReport([
    { name: "a", level: "ok", detail: "x" },
    { name: "b", level: "warn", detail: "y" },
  ]);
  assert.deepEqual(problemsOnly(r), { ...r, checks: [r.checks[1]] });
});

test("doctor --problems is accepted and wired — hides ok rows, JSON holds none, help lists it", async () => {
  const repo = await diskHermeticRepo("cli doctor problems");
  // The same hermetic PATH the plain-render wiring test above uses: a fake `pi` so the
  // backend-binary check passes on a host without one (CI), keeping the ready-repo exit-0
  // contract a property of the fixture rather than of the machine.
  const psRan = path.join(tmpdir("doctor-ps-"), "ran");
  const restore = pathPrepend(hermeticHostBins(psRan));
  try {
    const r = await cli(repo, "doctor", "--problems");
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /ready to run/);
    assert.doesNotMatch(r.stdout, /^ok\s+git binary/m);
    const json = await cli(repo, "doctor", "--problems", "--json");
    const report = JSON.parse(json.stdout);
    assert.ok(!report.checks.some((c: { level: string }) => c.level === "ok"));
    assert.match(helpTopic("doctor") ?? "", /--problems/);
  } finally {
    restore();
  }
});

test("doctor --problems keeps the exit-code contract on a failing environment", async () => {
  const r = await cliWithEnv(tmpdir(), { PATH: gitOnlyBinDir() }, ["doctor", "--problems"]);
  assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
});

test("runDoctor with only runs just the named checks, in report order", async () => {
  const ready = await runDoctor(readyRepo(), fakeBins("git", "pi"), noProcesses, ["orphans", "repo"]);
  assert.deepEqual(ready.checks.map((c) => c.name), ["repo", "orphans"]);
  assert.equal(ready.verdict, "ready to run");

  const failing = await runDoctor(makeRepo(), "", noProcesses, ["git binary"]);
  assert.deepEqual(failing.checks.map((c) => [c.name, c.level]), [["git binary", "fail"]]);
  assert.equal(failing.verdict, "1 problem");

  // A skipped check is never evaluated: the orphan and port checks are the only readers.
  let listed = 0;
  let cwdsRead = 0;
  const counting: ProcessProbe = {
    async list() {
      listed++;
      return [];
    },
    async cwds() {
      cwdsRead++;
      return new Map();
    },
    runMarkers: async () => new Map(),
    launchServicesPorts: async () => 1_000,
  };
  await runDoctor(readyRepo(), fakeBins("git", "pi"), counting, ["node"]);
  assert.equal(listed, 0);
  assert.equal(cwdsRead, 0);
});

test("doctor <check>... runs the named checks and rejects an unknown name", async () => {
  const repo = await diskHermeticRepo("cli doctor check names");
  const one = await cli(repo, "doctor", "Orphans", "--json");
  assert.equal(one.code, 0, `${one.stdout}\n${one.stderr}`);
  assert.deepEqual(JSON.parse(one.stdout).checks.map((c: { name: string }) => c.name), ["orphans"]);

  const two = await cli(repo, "doctor", "claude auth", "repo");
  assert.ok(two.stdout.indexOf("repo") < two.stdout.indexOf("claude auth"), two.stdout);
  assert.doesNotMatch(two.stdout, /orphans/);

  const typo = await cli(repo, "doctor", "orphan");
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /unknown check "orphan" — did you mean `orphans`\?/);
});

test("doctor --kill-orphans reports an unreadable process table, then the report; with --json it is the report's orphanKill field", async () => {
  // The no-ps PATH keeps the scan off the host's real table: a real scan could kill another
  // agent's leaked process.
  const env = { PATH: gitOnlyBinDir() };
  const r = await cliWithEnv(tmpdir(), env, ["doctor", "--kill-orphans"]);
  assert.match(r.stdout, /^could not scan the process table — .*; nothing killed\n\n/);
  assert.match(r.stdout, /warn\s+orphans\s+could not scan the process table/);
  assert.equal(r.code, 1, "exit follows the report's verdict");
  const json = await cliWithEnv(tmpdir(), env, ["doctor", "--kill-orphans", "--json"]);
  assert.equal(json.code, 1);
  const doc = JSON.parse(json.stdout);
  assert.ok(typeof doc.orphanKill.error === "string" && doc.orphanKill.error.length > 0);
  assert.equal(doc.checks.find((c: { name: string }) => c.name === "orphans").level, "warn");
  const prob = JSON.parse((await cliWithEnv(tmpdir(), env, ["doctor", "--kill-orphans", "--problems", "--json"])).stdout);
  assert.ok(prob.orphanKill.error);
  assert.ok(!prob.checks.some((c: { level: string }) => c.level === "ok"));
  const plain = JSON.parse((await cliWithEnv(tmpdir(), env, ["doctor", "--json"])).stdout);
  assert.ok(!("orphanKill" in plain));
});

test("doctor --commit-backlog commits a dirty backlog file before the report; with --json it is the report's backlogCommit field", async () => {
  const repo = await diskHermeticRepo("cli doctor commit backlog");
  fs.appendFileSync(path.join(repo, "PLANS.md"), "edit\n");
  const json = await cli(repo, "doctor", "--commit-backlog", "--json");
  const doc = JSON.parse(json.stdout);
  assert.deepEqual(doc.backlogCommit.committed, ["PLANS.md"]);
  assert.equal(doc.checks.find((c: { name: string }) => c.name === "uncommitted backlog").level, "ok");
  assert.equal(sh(repo, "git", "status", "--porcelain", "--", "PLANS.md"), "");
  fs.appendFileSync(path.join(repo, "PLANS.md"), "edit2\n");
  const r = await cli(repo, "doctor", "--commit-backlog");
  assert.match(r.stdout, /^committed PLANS\.md on main\n/m);
  assert.ok(r.stdout.indexOf("committed PLANS.md on main") < r.stdout.indexOf("uncommitted backlog"));
  const plain = JSON.parse((await cli(repo, "doctor", "--json")).stdout);
  assert.ok(!("backlogCommit" in plain));
});

test("the cli() completion timeout is not tighter than the 60 s cold-start readiness budget", () => {
  // doctor defers its whole report until every check finishes, so on a loaded host it can
  // produce no stdout for a long stretch; when the readiness waitFor already allows 60 s for
  // a cold CLI start under team load (BUGS.md 2026-09-30), the run-to-completion deadline must
  // not kill the child earlier or it returns an empty captured stdout (BUGS.md 2026-10-26).
  assert.ok(CLI_COMPLETION_TIMEOUT_MS >= 60_000, `completion timeout ${CLI_COMPLETION_TIMEOUT_MS} < 60000`);
});

test("doctor --resync-install is accepted and reports nothing to do without a lockfile", async () => {
  // A bare repo (no package-lock.json) pins nothing, so the re-sync has nothing to do; a
  // `.tumwater` dir lets the merge lock acquire (a real project always has one).
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".tumwater"), { recursive: true });
  const json = await cli(repo, "doctor", "--resync-install", "--json");
  const doc = JSON.parse(json.stdout);
  assert.equal(doc.resyncInstall.attempted, false);
  assert.equal(doc.resyncInstall.ok, true);
  assert.deepEqual(doc.resyncInstall.packages, []);
  assert.equal(doc.resyncInstall.pinned, false);
  const r = await cli(repo, "doctor", "--resync-install");
  assert.match(r.stdout, /^no package-lock\.json to match — nothing to re-sync\n/m);
  assert.ok(r.stdout.indexOf("nothing to re-sync") < r.stdout.indexOf("tumwater doctor — not running"));
  // Without the flag the doctor payload is unchanged — no resyncInstall field.
  const plain = JSON.parse((await cli(repo, "doctor", "--json")).stdout);
  assert.ok(!("resyncInstall" in plain));
});

test("doctor --resync-install on a matched root says the tree already matches the lockfile", async () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".tumwater"), { recursive: true });
  fs.mkdirSync(path.join(repo, "node_modules", "ink"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "proj", dependencies: { ink: "7.1.1" } }, "node_modules/ink": { version: "7.1.1" } } }));
  fs.writeFileSync(path.join(repo, "node_modules/ink/package.json"), JSON.stringify({ name: "ink", version: "7.1.1" }));
  const json = await cli(repo, "doctor", "--resync-install", "--json");
  const doc = JSON.parse(json.stdout);
  assert.equal(doc.resyncInstall.attempted, false);
  assert.equal(doc.resyncInstall.pinned, true);
  const r = await cli(repo, "doctor", "--resync-install");
  assert.match(r.stdout, /^node_modules already matches package-lock\.json — nothing to re-sync\n/m);
});

test("doctor --drop-broken-pins starts the report without a blank line when no pins are broken", async () => {
  const r = await cli(makeRepo(), "doctor", "--drop-broken-pins");
  assert.doesNotMatch(r.stdout, /^\n/);
});

test("doctor --drop-broken-pins drops the row's broken pins before the report", async () => {
  const seed = () => {
    const repo = makeRepo();
    writeFileDeep(path.join(repo, ".git", "refs", "tumwater", "merge", "broken"), `${"2".repeat(40)}\n`);
    return repo;
  };
  const repo = seed();
  const r = await cli(repo, "doctor", "--drop-broken-pins");
  assert.match(r.stdout, /^1 dropped broken pin: refs\/tumwater\/merge\/broken names [0-9a-f]{8}\n\n/);
  assert.equal(fs.existsSync(path.join(repo, ".git", "refs", "tumwater", "merge", "broken")), false, "the broken pin's ref is gone");
  const repoJson = seed();
  const json = await cli(repoJson, "doctor", "--drop-broken-pins", "--json");
  const doc = JSON.parse(json.stdout);
  assert.deepEqual(doc.brokenPinDrop, { dropped: [{ ref: "refs/tumwater/merge/broken", sha: "2".repeat(40) }], failed: [] });
  assert.equal(doc.checks.find((c: { name: string }) => c.name === "tumwater pins").level, "ok");
  // Without the flag the ref and the row stay as the check found them, and no drop is printed.
  const repoPlain = seed();
  const plain = await cli(repoPlain, "doctor");
  assert.doesNotMatch(plain.stdout, /^1 dropped broken pin/);
  assert.equal(fs.existsSync(path.join(repoPlain, ".git", "refs", "tumwater", "merge", "broken")), true);
  const plainJson = JSON.parse((await cli(repoPlain, "doctor", "--json")).stdout);
  assert.equal(plainJson.checks.find((c: { name: string }) => c.name === "tumwater pins").level, "fail");
  assert.ok(!("brokenPinDrop" in plainJson));
});

test("doctor --retire-leftovers retires before the report and --json carries leftoverRetire", async () => {
  const seed = () => {
    const repo = makeRepo();
    writeConfig(repo, { roles: { feature: { enabled: false } } });
    sh(repo, "git", "branch", "tumwater/feature");
    return repo;
  };
  const repo = seed();
  const r = await cli(repo, "doctor", "--retire-leftovers");
  assert.match(r.stdout, /^retired feature: the branch \(tumwater\/feature\)\n\n/);
  assert.equal(sh(repo, "git", "branch").includes("tumwater/feature"), false, "feature's branch is gone");
  const repoJson = seed();
  const json = await cli(repoJson, "doctor", "--retire-leftovers", "--json");
  const doc = JSON.parse(json.stdout);
  assert.deepEqual(doc.leftoverRetire, { retired: [{ role: "feature", removed: ["branch"] }], failed: [] });
  // Without the flag the branch and the row stay as found, and no retire line prints.
  const repoPlain = seed();
  const plain = await cli(repoPlain, "doctor");
  assert.doesNotMatch(plain.stdout, /^retired feature/);
  assert.equal(sh(repoPlain, "git", "branch").includes("tumwater/feature"), true, "the branch stays without the flag");
  const plainJson = JSON.parse((await cli(repoPlain, "doctor", "--json")).stdout);
  assert.equal(plainJson.checks.find((c: { name: string }) => c.name === "leftover role branches").level, "warn");
  assert.ok(!("leftoverRetire" in plainJson));
});

test("runDoctorCheck turns a throwing or rejecting check into a fail row and passes other outcomes through", async () => {
  assert.deepEqual(
    await runDoctorCheck(() => {
      throw new Error("boom");
    }),
    { level: "fail", detail: "the check threw: boom" },
  );
  const late = await runDoctorCheck(async () => {
    throw new Error("late");
  });
  assert.equal(late?.detail, "the check threw: late");
  assert.equal(late?.level, "fail");
  assert.equal(await runDoctorCheck(() => null), null);
  assert.deepEqual(await runDoctorCheck(() => okOutcome("fine")), okOutcome("fine"));
});
