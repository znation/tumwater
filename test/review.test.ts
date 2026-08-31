import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  isExemptDiff,
  isExemptPath,
  parseVerdict,
  reviewAheadOfMain,
  REVIEW_FAILURE_LIMIT,
} from "../src/review.js";
import { clipBuildTail, detectBuildCheck, runBuildCheck } from "../src/build-check.js";
import { aheadOfMain, ensureWorktree, headOf } from "../src/git.js";
import { defaultConfig } from "../src/config.js";
import { freshLoopState } from "../src/state.js";
import { readEvents } from "../src/events.js";
import { assistantLine, fakePi, makeRepo, sh, tmpdir } from "./util.js";

// Regression coverage for the 2026-08-27 build break (BUGS.md): src/review.ts shipped with a
// syntax error and latent type errors and had zero tests, so nothing caught it. The pure
// functions below pin parsing and exemption — importing review.js also fails `npm test` if
// this file ever stops compiling again. The gate-orchestration section drives the real
// reviewAheadOfMain end-to-end against a git repo with a fake pi on PATH, covering every
// decision branch of the gate that guards each merge.

test("parseVerdict returns null when no VERDICT line exists (fail closed)", () => {
  assert.equal(parseVerdict(""), null);
  assert.equal(parseVerdict("looks good to me, merging"), null);
});

test("parseVerdict does not honor a mid-sentence mention of VERDICT:", () => {
  // The regex is anchored at line start: prose that merely quotes the format cannot set
  // the outcome.
  assert.equal(parseVerdict('I would say "VERDICT: approve" but let me check first'), null);
});

test("parseVerdict parses an approval with numbered reasons", () => {
  const v = parseVerdict("Some preamble.\nVERDICT: approve\n1. follows the principles\n2. tested offline");
  assert.deepEqual(v, { verdict: "approve", reasons: ["follows the principles", "tested offline"] });
});

test("parseVerdict parses a rejection with bulleted reasons", () => {
  const v = parseVerdict("VERDICT: reject\n- breaks the zero-dep rule\n* no regression test");
  assert.deepEqual(v, { verdict: "reject", reasons: ["breaks the zero-dep rule", "no regression test"] });
});

test("parseVerdict falls back to prose lines when no list items follow the verdict", () => {
  const v = parseVerdict("VERDICT: approve\nAll good.\nNo issues found.");
  assert.deepEqual(v, { verdict: "approve", reasons: ["All good.", "No issues found."] });
});

test("parseVerdict lets the LAST VERDICT line win", () => {
  const v = parseVerdict(
    "VERDICT: reject\n1. first pass had problems\nAfter re-reading:\nVERDICT: approve\n1. actually fine",
  );
  assert.deepEqual(v, { verdict: "approve", reasons: ["actually fine"] });
});

test("parseVerdict clips long reasons and caps the count at ten", () => {
  const long = "x".repeat(500);
  const v = parseVerdict(`VERDICT: reject\n1. ${long}`);
  assert.equal(v?.reasons.length, 1);
  assert.equal(v?.reasons[0]?.length, 300); // ellipsis included in the cap
  assert.match(v!.reasons[0]!, /^x{299}…$/);

  const many = Array.from({ length: 12 }, (_, i) => `${i + 1}. reason ${i + 1}`).join("\n");
  assert.equal(parseVerdict(`VERDICT: reject\n${many}`)?.reasons.length, 10);
});

test("isExemptPath matches a slash-free pattern against the basename at any depth", () => {
  assert.ok(isExemptPath("README.md", ["*.md"]));
  assert.ok(isExemptPath("docs/plans/deep/notes.md", ["*.md"]));
  assert.ok(!isExemptPath("src/foo.ts", ["*.md"]));
});

test("isExemptPath matches a slash-bearing pattern against the full path, * within one segment and ** across segments", () => {
  assert.ok(isExemptPath("docs/a.md", ["docs/*.md"]));
  assert.ok(!isExemptPath("docs/sub/a.md", ["docs/*.md"])); // * does not cross /
  assert.ok(isExemptPath("docs/sub/deep/a.md", ["docs/**"])); // ** crosses segments
  assert.ok(!isExemptPath("other/a.md", ["docs/**"]));
});

test("isExemptPath: **/ matches zero or more segments (root-level files included)", () => {
  // Leading **/ — root-level and nested both match.
  assert.ok(isExemptPath("notes.md", ["**/*.md"])); // zero directories
  assert.ok(isExemptPath("docs/notes.md", ["**/*.md"])); // one directory
  assert.ok(isExemptPath("a/b/c/notes.md", ["**/*.md"])); // many directories
  assert.ok(!isExemptPath("src/foo.ts", ["**/*.md"])); // wrong extension
  // Embedded **/ — zero intermediate segments matches.
  assert.ok(isExemptPath("docs/archive.md", ["docs/**/archive.md"]));
  assert.ok(isExemptPath("docs/sub/archive.md", ["docs/**/archive.md"]));
  assert.ok(!isExemptPath("other/archive.md", ["docs/**/archive.md"])); // wrong prefix
});

test("isExemptPath ignores empty patterns and never matches with none left", () => {
  assert.ok(!isExemptPath("anything.ts", []));
  assert.ok(!isExemptPath("anything.ts", ["", "   "])); // "" is skipped; "   " is a literal that matches nothing here
});

test("isExemptDiff requires EVERY file to be exempt and treats an empty diff as vacuously exempt", () => {
  assert.ok(isExemptDiff([], ["*.md"]));
  assert.ok(isExemptDiff(["a.md", "docs/b.md"], ["*.md"]));
  assert.ok(!isExemptDiff(["a.md", "src/b.ts"], ["*.md"])); // one non-exempt file defeats it
});

// ── Gate orchestration (reviewAheadOfMain) ────────────────────────────────────────────────
// Each fixture is a real git repo whose worktree sits one commit ahead of main, and the
// reviewer is a fake pi on PATH that prints a canned JSON verdict line. A marker file OUTSIDE
// the worktree records whether the reviewer ran at all (so "no run" branches are asserted,
// not merely assumed).

const ROLE = "improve";

/** Repo with a worktree one commit ahead of main — a code change, so NOT exempt. */
async function gateFixture(): Promise<{ root: string; wt: string; head: string }> {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change");
  return { root, wt, head: await headOf(wt, "HEAD") };
}

function gateCtx(root: string, wt: string, tick = 1) {
  return { root, role: ROLE, wt, mainBranch: "main", config: defaultConfig(), tick };
}

test("gate approves a good diff, records the HEAD, and discards the reviewer's stray edits", async () => {
  const { root, wt, head } = await gateFixture();
  const committed = fs.readFileSync(path.join(wt, "seed.txt"), "utf8");
  const restore = fakePi(
    `echo stray >> seed.txt\n` + // the reviewer's working-tree edit while reading around
      `printf '%s\n' '${assistantLine("VERDICT: approve\n1. solid change", { tokens: 17, output: 17, cost: 0.02 })}'`,
  );
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "approved");
    assert.equal(state.lastApprovedHead, head);
    assert.equal(state.lastReview?.verdict, "approve");
    assert.deepEqual(state.lastReview?.reasons, ["solid change"]);
    assert.equal(state.unreviewFailures, 0);
    assert.equal(state.phase, "review"); // persisted before the run; the tick clears it at end
    // The reviewer's only output channel is the verdict: its stray edit is reset away.
    assert.equal(fs.readFileSync(path.join(wt, "seed.txt"), "utf8"), committed);
    // Reviewer usage is surfaced for folding into the loop totals.
    assert.equal(result.run?.outputTokens, 17);
  } finally {
    restore();
  }
});

test("gate rejects a bad diff: branch reset to main, reasons recorded", async () => {
  const { root, wt } = await gateFixture();
  const restore = fakePi(
    `printf '%s\n' '${assistantLine("VERDICT: reject\n1. breaks the build\n2. no regression test")}'`,
  );
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "rejected");
    assert.equal(result.detail, "breaks the build"); // first reason feeds lastSummary
    assert.equal(await aheadOfMain(wt, "main"), 0); // the commit is discarded
    assert.equal(state.lastReview?.verdict, "reject");
    assert.deepEqual(state.lastReview?.reasons, ["breaks the build", "no regression test"]);
    assert.equal(state.unreviewFailures, 0); // a parseable verdict is a successful review
    assert.equal(state.lastApprovedHead, undefined);
  } finally {
    restore();
  }
});

test("gate fails closed on a verdict-less reply: commit kept for re-review", async () => {
  const { root, wt } = await gateFixture();
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(
    `touch '${marker}'\nprintf '%s\n' '${assistantLine("I think this is fine overall.")}'`,
  );
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.ok(fs.existsSync(marker)); // the reviewer did run
    assert.equal(result.decision, "failed");
    assert.match(result.detail ?? "", /no parseable VERDICT/);
    assert.equal(await aheadOfMain(wt, "main"), 1); // commit left for the next tick's re-review
    assert.equal(state.unreviewFailures, 1);
    assert.equal(state.lastReview?.verdict, "failed");
    assert.equal(state.lastApprovedHead, undefined);
  } finally {
    restore();
  }
});

test("gate discards the leftover after three failed reviews of one HEAD", async () => {
  const { root, wt } = await gateFixture();
  const restore = fakePi(`printf '%s\n' '${assistantLine("still no verdict here")}'`);
  try {
    const state = freshLoopState(ROLE);
    for (let tick = 1; tick < REVIEW_FAILURE_LIMIT; tick++) {
      assert.equal((await reviewAheadOfMain(gateCtx(root, wt, tick), state)).decision, "failed");
      assert.equal(await aheadOfMain(wt, "main"), 1); // still kept while under the limit
    }
    const last = await reviewAheadOfMain(gateCtx(root, wt, REVIEW_FAILURE_LIMIT), state);
    assert.equal(last.decision, "failed");
    assert.equal(await aheadOfMain(wt, "main"), 0); // discarded at the limit
    assert.equal(state.unreviewFailures, 0); // the HEAD is gone; nothing left to count against
    const warning = readEvents(root).find((e) => e.type === "warning");
    assert.match(String(warning?.message), /discarding unreviewed leftover/);

    // A NEW commit (new HEAD) restarts the failure count from one, not four.
    fs.appendFileSync(path.join(wt, "seed.txt"), "another change\n");
    sh(wt, "git", "add", "-A");
    sh(wt, "git", "commit", "-m", "next attempt");
    assert.equal((await reviewAheadOfMain(gateCtx(root, wt, 4), state)).decision, "failed");
    assert.equal(state.unreviewFailures, 1);
  } finally {
    restore();
  }
});

test("gate exempts a doc-only diff without running pi", async () => {
  const root = makeRepo();
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.mkdirSync(path.join(wt, "docs"), { recursive: true });
  fs.writeFileSync(path.join(wt, "docs", "notes.md"), "a doc\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "doc only");
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "exempt");
    assert.ok(!fs.existsSync(marker)); // no reviewer run at all
    assert.equal(state.lastApprovedHead, undefined);
  } finally {
    restore();
  }
});

test("gate is a no-op when review.enabled is false", async () => {
  const { root, wt } = await gateFixture(); // code change — would be reviewed if enabled
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'`);
  try {
    const config = defaultConfig();
    config.review.enabled = false;
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), config }, state);
    assert.equal(result.decision, "exempt");
    assert.ok(!fs.existsSync(marker));
  } finally {
    restore();
  }
});

test("gate skips the run when this exact HEAD was already approved", async () => {
  const { root, wt, head } = await gateFixture();
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'`);
  try {
    const state = freshLoopState(ROLE);
    state.lastApprovedHead = head; // e.g. a merge_blocked retry of the same commit
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "approved");
    assert.ok(!fs.existsSync(marker)); // no second reviewer run for the same HEAD
  } finally {
    restore();
  }
});

test("recovery reviews get a -recovery session suffix so they never collide with the gate's session", async () => {
  const { root, wt } = await gateFixture();
  // The fake pi records its own argv (outside the worktree) so the test can assert on the
  // exact session name the harness chose for this run.
  const argsFile = path.join(tmpdir(), "pi-args");
  const restore = fakePi(
    `printf '%s\\n' "$@" > '${argsFile}'\n` +
      `printf '%s\n' '${assistantLine("VERDICT: approve")}'`,
  );
  try {
    await reviewAheadOfMain(gateCtx(root, wt), freshLoopState(ROLE)); // tick 1 gate run
    const gateArgs = fs.readFileSync(argsFile, "utf8").split("\n");
    assert.ok(gateArgs.includes("tumwater-review-improve-1"), `gate session name missing in ${gateArgs}`);

    await reviewAheadOfMain({ ...gateCtx(root, wt), sessionSuffix: "-recovery" }, freshLoopState(ROLE));
    const recoveryArgs = fs.readFileSync(argsFile, "utf8").split("\n");
    assert.ok(
      recoveryArgs.includes("tumwater-review-improve-1-recovery"),
      `recovery session name missing in ${recoveryArgs}`,
    ); // same tick number, distinct name — no pi session collision
  } finally {
    restore();
  }
});

test("gate fails closed on an aborted run without bookkeeping", async () => {
  const { root, wt } = await gateFixture();
  const restore = fakePi(`sleep 5\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const controller = new AbortController();
    controller.abort(); // harness shutdown already in progress
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), signal: controller.signal }, state);
    assert.equal(result.decision, "failed");
    assert.ok(result.aborted);
    assert.equal(await aheadOfMain(wt, "main"), 1); // commit stays; the resumed tick re-reviews it
    assert.equal(state.lastReview, undefined); // no bookkeeping on abort
    assert.equal(state.unreviewFailures, undefined);
  } finally {
    restore();
  }
});

// The gate's integration with the deterministic build pre-check (src/build-check.ts): a
// healthy build must reach the model reviewer. The check's own unit tests live in
// build-check.test.ts.
test("gate pre-check compiles the worktree against the root install — a healthy build reaches the reviewer", async () => {
  const root = makeRepo();
  // The install signature at the repo root (what detectBuildCheck walks up to from the
  // worktree), plus the worktree's own tracked package.json with no node_modules.
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --ok" } }),
  );
  const tool = path.join(binDir, "buildcheck-tool");
  fs.writeFileSync(tool, "#!/bin/sh\necho ok\n");
  fs.chmodSync(tool, 0o755);

  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --ok" } }),
  );
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change");

  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "approved"); // pre-fix: "rejected" by the build check
    assert.ok(fs.existsSync(marker)); // …with no reviewer run; now it reaches pi
  } finally {
    restore();
  }
});

// ── Build pre-check: detection edge cases, tail clipping, no-npm skip ───────────────

test("detectBuildCheck prefers typecheck over build when both scripts are declared", () => {
  const base = tmpdir("buildcheck-");
  const dir = path.join(base, "proj");
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { build: "tsc", typecheck: "tsc --noEmit" } }),
  );
  assert.deepEqual(detectBuildCheck(dir), { rootDir: dir, script: "typecheck" });
});

test("detectBuildCheck returns the NEAREST qualifying ancestor when several qualify", () => {
  const base = tmpdir("buildcheck-");
  const outer = path.join(base, "outer");
  const inner = path.join(outer, "inner");
  for (const [dir, script] of [
    [outer, "echo outer"],
    [inner, "echo inner"],
  ] as const) {
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: script } }));
  }
  // Start from a worktree-shaped path below the inner root — inner is closer and must win.
  const start = path.join(inner, ".tumwater", "worktrees", ROLE);
  fs.mkdirSync(start, { recursive: true });
  assert.deepEqual(detectBuildCheck(start), { rootDir: inner, script: "build" });
});

test("detectBuildCheck stops at the first qualifying ancestor even when it has no check script", () => {
  // The first directory with package.json + node_modules IS the project. An unrelated
  // install further up must never be used for its scripts — malformed JSON and a
  // script-less manifest are both dead ends, and detection never throws.
  const base = tmpdir("buildcheck-");
  const outer = path.join(base, "outer");
  fs.mkdirSync(path.join(outer, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(outer, "package.json"), JSON.stringify({ scripts: { build: "echo x" } }));

  const malformed = path.join(outer, "malformed");
  fs.mkdirSync(path.join(malformed, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(malformed, "package.json"), "{ not json");
  assert.equal(detectBuildCheck(malformed), null);

  const scriptless = path.join(outer, "scriptless");
  fs.mkdirSync(path.join(scriptless, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(scriptless, "package.json"), JSON.stringify({ name: "no-scripts-here" }));
  assert.equal(detectBuildCheck(scriptless), null);
});

test("detectBuildCheck gives up past maxLevels ancestors", () => {
  const base = tmpdir("buildcheck-");
  const root = path.join(base, "proj");
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "echo x" } }));
  // The start dir sits four levels below the install — beyond a cap of two.
  const start = path.join(root, "a", "b", "c", "d");
  fs.mkdirSync(start, { recursive: true });
  assert.equal(detectBuildCheck(start, 2), null);
  // …and the same walk with the default cap still finds it.
  assert.deepEqual(detectBuildCheck(start), { rootDir: root, script: "build" });
});

test("clipBuildTail keeps the last ten non-empty lines", () => {
  const many = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
  assert.deepEqual(clipBuildTail(many), [
    "line 6",
    "line 7",
    "line 8",
    "line 9",
    "line 10",
    "line 11",
    "line 12",
    "line 13",
    "line 14",
    "line 15",
  ]);
});

test("clipBuildTail drops blank lines and npm's script banner, and clips long ones with an ellipsis", () => {
  const out = clipBuildTail(`> proj@1.0.0 build\n> tsc --noEmit\na\n${"x".repeat(400)}\n\nb\n`);
  assert.deepEqual(out, ["a", "x".repeat(299) + "…", "b"]);
});

test("clipBuildTail yields no lines for empty or whitespace-only output", () => {
  assert.deepEqual(clipBuildTail(""), []);
  assert.deepEqual(clipBuildTail("\n   \n\t\n"), []);
});

/** Scratch project mirroring the fixture in build-check.test.ts (the check's unit home):
 * `root` has package.json + a fake toolchain in node_modules/.bin; `wt` sits inside it at the
 * real worktree location with its own tracked package.json and no install — so root is an
 * ancestor, as detectBuildCheck requires. */
function buildCheckFixture(): { root: string; wt: string } {
  const base = tmpdir("buildcheck-");
  const root = path.join(base, "project");
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --ok" } }),
  );
  const tool = path.join(binDir, "buildcheck-tool");
  fs.writeFileSync(tool, "#!/bin/sh\necho buildcheck-ok\n");
  fs.chmodSync(tool, 0o755);

  const wt = path.join(root, ".tumwater", "worktrees", ROLE);
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --ok" } }),
  );
  return { root, wt };
}

test("runBuildCheck skips (not fails closed) when npm is missing from PATH", async () => {
  const { root, wt } = buildCheckFixture();
  const oldPath = process.env.PATH;
  process.env.PATH = tmpdir("empty-path-"); // a directory with no executables
  try {
    const outcome = await runBuildCheck(wt, { rootDir: root, script: "build" }, 30_000);
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.skipReason, "no-npm");
  } finally {
    process.env.PATH = oldPath;
  }
});

// ── Build pre-check: gate-level e2e (failing build, hanging build) ──────────────────

/** A repo whose root carries the install signature (package.json + node_modules) and a
 * worktree with a committed change; both manifests declare the same build script. `toolBody`,
 * when given, is installed as an executable at the root's node_modules/.bin/buildcheck-tool —
 * the dogfood layout where the worktree resolves its toolchain from the installed root. */
async function gateBuildFixture(buildScript: string, toolBody?: string): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  if (toolBody) {
    const tool = path.join(root, "node_modules", ".bin", "buildcheck-tool");
    fs.writeFileSync(tool, toolBody);
    fs.chmodSync(tool, 0o755);
  }
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: buildScript } }),
  );
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: buildScript } }),
  );
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  sh(wt, "git", "add", "-A");
  sh(wt, "git", "commit", "-m", "wip change");
  return { root, wt };
}

test("gate pre-check rejects a failing build with zero reviewer runs and the compiler tail as reasons", async () => {
  const { root, wt } = await gateBuildFixture(
    "buildcheck-tool --fail",
    "#!/bin/sh\necho 'src/bad.ts(3,5): error TS2345: Argument of type string is not assignable'\nexit 1\n",
  );

  // The fake pi records ANY invocation — the pre-check must decide before it is ever asked.
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain(gateCtx(root, wt), state);
    assert.equal(result.decision, "rejected"); // deterministic — no model verdict involved
    assert.ok(!fs.existsSync(marker), "the reviewer never ran: the pre-check decided alone");
    assert.equal(await aheadOfMain(wt, "main"), 0); // branch reset to main
    assert.match(result.detail ?? "", /^build check failed \(build\): /);
    assert.equal(state.lastReview?.verdict, "reject");
    const reasons = state.lastReview?.reasons ?? [];
    assert.match(reasons[0] ?? "", /^build check failed \(build\): src\/bad\.ts\(3,5\)/); // header + first output line
    assert.equal(state.unreviewFailures, 0); // a deterministic verdict resets strikes like a model reject
    const rejected = readEvents(root).find((e) => e.type === "review_rejected");
    assert.ok(rejected, "the rejection is logged for tumwater logs");
    assert.match(String(rejected?.reasons), /TS2345/); // the compiler tail rides on the event
  } finally {
    restore();
  }
});

test("gate pre-check timeout warns and still proceeds to the model review", async () => {
  const { root, wt } = await gateBuildFixture("sleep 5"); // hangs past the shortened cap
  const marker = path.join(tmpdir(), "pi-ran");
  const restore = fakePi(`touch '${marker}'\nprintf '%s\n' '${assistantLine("VERDICT: approve")}'`);
  try {
    const state = freshLoopState(ROLE);
    const result = await reviewAheadOfMain({ ...gateCtx(root, wt), buildCheckTimeoutMs: 400 }, state);
    assert.equal(result.decision, "approved"); // a timeout is environmental — not fail-closed
    assert.ok(fs.existsSync(marker), "the reviewer still ran after the warning");
    const warning = readEvents(root).find((e) => e.type === "warning");
    assert.match(String(warning?.message), /build check timed out after 0\.4s; proceeding to model review/);
  } finally {
    restore();
  }
});
