import test from "node:test";
import assert from "node:assert/strict";
import {
  PAUSE_EXPIRED_SUFFIX,
  PREFILL_REASON,
  agree,
  backendKindPhrase,
  budgetPhrase,
  consecutiveFailuresWarning,
  describeToolCall,
  firstReason,
  holdPhrase,
  mainRedNotMine,
  mainRedPhrase,
  moreSuffix,
  orchestratorStopPhrase,
  pauseReasonSuffix,
  plural,
  rolePausePhrase,
  roleResumePhrase,
  rolesPhrase,
  shortSpanPhrase,
  teamPausePhrase,
  teamResumePhrase,
} from "../src/text/phrases.js";

// text/phrases.ts is the single home of the team's shared wording fragments (the tool-call label,
// the backend-hold kind phrasing, and their siblings). These tests pin the documented contracts
// of the two phrases whose arms the renderer tests' chosen kinds and shapes never exercise.

// --- describeToolCall (one-line labels for in-flight and stalled tool calls) ---

test("describeToolCall summarizes common arg shapes tersely", () => {
  assert.equal(describeToolCall("read", { path: "/a/b/runner.ts" }), "read runner.ts");
  assert.equal(describeToolCall("bash", { command: "npm run build" }), "bash npm run build");
  assert.equal(describeToolCall("edit", {}), "edit");
  assert.equal(describeToolCall("bash", { command: "x".repeat(100) }), `bash ${"x".repeat(31)}…`);
  assert.equal(describeToolCall("bash", { command: "a\n  b\tc" }), "bash a b c");
});

test("describeToolCall with an omitted toolName yields the bare detail, no leading space", () => {
  // pi omits toolName on some start events; the stall warning must still name the command.
  assert.equal(describeToolCall("", { command: "sleep 999" }), "sleep 999");
  assert.equal(describeToolCall("", { path: "/a/b/runner.ts" }), "runner.ts");
  assert.equal(describeToolCall("", {}), "", "no name and no recognizable arg — the caller falls back");
});

test("describeToolCall basenames path-like keys and shows the others verbatim", () => {
  // Both path spellings reduce to the file name, not the full directory.
  assert.equal(describeToolCall("read", { file_path: "/a/b/runner.ts" }), "read runner.ts");
  assert.equal(describeToolCall("write", { path: "relative/dir/file.md" }), "write file.md");
  // The remaining candidate keys are shown as-is (no basename), whitespace-collapsed.
  assert.equal(describeToolCall("bash", { cmd: "git status" }), "bash git status");
  assert.equal(describeToolCall("grep", { pattern: "foo\\.bar" }), "grep foo\\.bar");
  assert.equal(describeToolCall("web_fetch", { url: "https://example.com/a b" }), "web_fetch https://example.com/a b");
});

test("describeToolCall prefers the first present key in path, file_path, command, cmd, pattern, url order", () => {
  assert.equal(describeToolCall("t", { path: "/p/x.ts", file_path: "/f/y.ts" }), "t x.ts");
  assert.equal(describeToolCall("t", { file_path: "/f/y.ts", command: "run it" }), "t y.ts");
  assert.equal(describeToolCall("t", { command: "run it", cmd: "other" }), "t run it");
  assert.equal(describeToolCall("t", { cmd: "other", pattern: "p*" }), "t other");
  assert.equal(describeToolCall("t", { pattern: "p*", url: "https://x" }), "t p*");
});

test("describeToolCall falls back to the bare tool name for non-object or non-string args", () => {
  // No object to read keys from.
  assert.equal(describeToolCall("bash", null), "bash");
  assert.equal(describeToolCall("bash", undefined), "bash");
  assert.equal(describeToolCall("bash", "npm test"), "bash");
  assert.equal(describeToolCall("bash", 42), "bash");
  // Object present but the candidate value is not a string (or no known key at all).
  assert.equal(describeToolCall("read", { path: 123 }), "read");
  assert.equal(describeToolCall("grep", { pattern: ["a"] }), "grep");
  assert.equal(describeToolCall("edit", { unrelated: "/a/b.ts" }), "edit");
});

// --- firstReason (the first rejection reason, or the shared fallback) ---

test("firstReason returns the first string reason and falls back when there is none", () => {
  assert.equal(firstReason(["the tree is unverified", "second"]), "the tree is unverified");
  assert.equal(firstReason([]), "no reasons given");
  assert.equal(firstReason(undefined), "no reasons given");
  // A parsed event's reasons can be any JSON shape; a non-string first entry reads as absent.
  assert.equal(firstReason([42, "second"]), "no reasons given");
  // An empty reason *is* a string, so it survives rather than becoming the fallback.
  assert.equal(firstReason([""]), "");
});

// backendKindPhrase is the one home of a backend hold's kind wording, shared by the event
// feed (event-format.ts) and the failure digest (src/failure/failure-state-change.ts). The timeout
// arm
// and the unknown-kind fallback are the arms the renderer tests' chosen kinds never
// exercise: a "Request timed out" storm must render its own phrase (not a connection's),
// and an unreadable kind (a hand-edited or future kind value) must degrade to the generic
// wording rather than leak "undefined" into the feed or digest.
test("backendKindPhrase names each backend-failure kind and falls back on an unreadable kind", () => {
  assert.equal(backendKindPhrase("connection"), "connection error");
  assert.equal(backendKindPhrase("timeout"), "request timed out");
  assert.equal(backendKindPhrase("server"), "server error");
  assert.equal(backendKindPhrase("model-load"), "model load failure");
  assert.equal(backendKindPhrase("stream-severed"), "stream severed");
  assert.equal(backendKindPhrase("gateway-noon"), "backend failure");
  assert.equal(backendKindPhrase(undefined), "backend failure");
});

// --- budgetPhrase (the $<spent> of $<cap> fragment) ---

test("budgetPhrase reads a non-numeric or non-finite event field as $0.00, never $NaN", () => {
  assert.equal(budgetPhrase(12.5, 20), "$12.50 of $20.00");
  assert.equal(budgetPhrase("oops", null), "$0.00 of $0.00");
  assert.equal(budgetPhrase(Number.NaN, Number.POSITIVE_INFINITY), "$0.00 of $0.00");
  assert.equal(budgetPhrase(undefined, 50), "$0.00 of $50.00");
});

// --- shortSpanPhrase (the shared seconds/minutes duration) ---

test("shortSpanPhrase rounds a near-two-minute span into the minute arm, never 120s", () => {
  assert.equal(shortSpanPhrase(0), "0s");
  assert.equal(shortSpanPhrase(60_000), "60s", "the one-minute base hold reads 60s");
  assert.equal(shortSpanPhrase(119_000), "119s");
  assert.equal(shortSpanPhrase(119_500), "2m", "119.5s rounds up past the two-minute cutoff");
  assert.equal(shortSpanPhrase(119_999), "2m", "the seconds arm never prints the out-of-vocabulary 120s");
  assert.equal(shortSpanPhrase(120_000), "2m");
  assert.equal(shortSpanPhrase(130_000), "2m");
});

test("describeToolCall drops a leading cd so the label names the command", () => {
  const cmd = (command: string) => describeToolCall("bash", { command });
  assert.equal(
    cmd("cd /Users/zach/tumwater/.tumwater/worktrees/_slot-10 && npm run test:gate > x.log 2>&1"),
    "bash npm run test:gate > x.log 2>&1",
  );
  assert.equal(cmd(`cd /w && ${"x".repeat(40)}`), `bash ${"x".repeat(31)}…`);
  assert.equal(cmd('cd "/a b" && ls'), "bash ls");
  assert.equal(cmd("cd a; cd b && make"), "bash make");
  assert.equal(describeToolCall("bash", { cmd: "cd a && ls" }), "bash ls");
  assert.equal(cmd("cd /tmp"), "bash cd /tmp");
  assert.equal(cmd("cd a || exit 1"), "bash cd a || exit 1");
  assert.equal(describeToolCall("bash", { path: "/x/cd y && z" }), "bash cd y && z");
});

test("plural and agree treat exactly one as singular and every other count as plural", () => {
  assert.equal(plural(1, "run"), "1 run");
  assert.equal(plural(0, "run"), "0 runs");
  assert.equal(plural(2, "run"), "2 runs");
  assert.equal(plural(2, "role is", "roles are"), "2 roles are");
  assert.equal(agree(1, "is", "are"), "is");
  assert.equal(agree(0, "is", "are"), "are");
});

test("holdPhrase clamps an unreadable or negative hold to 0s and adds the relapse only past zero", () => {
  assert.equal(holdPhrase(60_000, 0), "for 60s");
  assert.equal(holdPhrase(180_000, 2), "for 3m (relapse 2)");
  assert.equal(holdPhrase(-5000, undefined), "for 0s");
  assert.equal(holdPhrase("x", "y"), "for 0s");
  assert.equal(holdPhrase(undefined, undefined), "for 0s");
});

// --- mainRedPhrase / mainRedNotMine (main's red-tip naming) ---

// mainRedPhrase is the spine of every "main <short-sha> is red" warning, shared by the team-wide
// red-main banner (main-red.ts), the review gate, the merge check (merge-check-failures.ts), and
// the redeploy hold (redeployer.ts). shortSha slices to at most 8 chars and a non-string reads as
// the "?" textOr fallback.
test("mainRedPhrase names main by its short sha", () => {
  assert.equal(mainRedPhrase("0123456789abcdef"), "main 01234567 is red");
  assert.equal(mainRedPhrase(undefined), "main ? is red", "an unreadable sha degrades, never undefined");
});

test("mainRedNotMine appends the not-this-change's-failure consequence", () => {
  assert.equal(
    mainRedNotMine("0123456789abcdef"),
    "main 01234567 is red — not this change's failure",
  );
});

// --- pauseReasonSuffix (the quoted reason on a pause line) ---

test("pauseReasonSuffix quotes the reason only when one is given", () => {
  assert.equal(pauseReasonSuffix("budget spent"), ' — "budget spent"');
  assert.equal(pauseReasonSuffix(undefined), "");
  assert.equal(pauseReasonSuffix(""), "");
});

// --- consecutiveFailuresWarning (the crossing-the-streak warning) ---

test("consecutiveFailuresWarning counts the failing runs in a row", () => {
  assert.equal(consecutiveFailuresWarning(3, "a review rejection"), "3 runs failed in a row: a review rejection");
  assert.equal(consecutiveFailuresWarning(1, "recovery failure"), "1 runs failed in a row: recovery failure");
});

// --- team/role pause and resume base lines (event feed and failure digest wording) ---

test("team pause/resume phrases hold the shared base wording", () => {
  assert.equal(teamPausePhrase(), "team paused — roles start no new runs");
  assert.equal(teamResumePhrase(), "team resumed — roles run again");
  assert.equal(PAUSE_EXPIRED_SUFFIX, " (its timed pause ran out)");
});

test("role pause/resume phrases coerce any role value, never undefined", () => {
  assert.equal(rolePausePhrase("bugfix #2"), "role bugfix #2 paused — it starts no new runs");
  assert.equal(roleResumePhrase("bugfix #2"), "role bugfix #2 resumed — it runs again");
  // The digest byte-slices role fields, so a raw (non-string) value must still render.
  assert.equal(rolePausePhrase(42), "role 42 paused — it starts no new runs");
  assert.equal(roleResumePhrase(undefined), "role undefined resumed — it runs again");
});

// --- orchestratorStopPhrase (the shutdown line and its cause) ---

test("orchestratorStopPhrase names each cause and falls back to the bare line", () => {
  assert.equal(orchestratorStopPhrase("restart"), "tumwater stopped to restart onto the new build");
  assert.equal(orchestratorStopPhrase("once"), "tumwater stopped — the --once round settled");
  assert.equal(orchestratorStopPhrase("signal"), "tumwater stopped on a stop signal");
  assert.equal(orchestratorStopPhrase("error"), "tumwater stopped — its polling failed");
  // A missing or unknown cause (any event logged before the field existed) renders the bare line.
  assert.equal(orchestratorStopPhrase(undefined), "tumwater stopped");
  assert.equal(orchestratorStopPhrase("reboot"), "tumwater stopped");
});

// --- rolesPhrase (the A, B, C roles list) ---

test("rolesPhrase joins string roles, falls back, drops foreign entries, and caps the tail", () => {
  assert.equal(rolesPhrase(["a", "b", "c"], "none"), "a, b, c");
  assert.equal(rolesPhrase(undefined, "none"), "none");
  assert.equal(rolesPhrase("not an array", "none"), "none");
  // A hand-edited field's foreign entry must never join as "[object Object]" or leak undefined.
  assert.equal(rolesPhrase(["a", 42, "b"], "none"), "a, b");
  assert.equal(rolesPhrase([], "none"), "none");
});

test("rolesPhrase caps extra roles with max and renders through format when given", () => {
  assert.equal(rolesPhrase(["a", "b", "c"], "none", 2), "a, b");
  assert.equal(rolesPhrase(["a", "b"], "none", 0), "none", "an exhausted cap reads as the fallback");
  const slice = (r: unknown) => String(r).slice(0, 3);
  assert.equal(rolesPhrase(["role-1", "role-2"], "none", undefined, slice), "rol, rol");
});

// --- moreSuffix (the capped-list remainder) ---

test("moreSuffix is empty at zero and appends the parenthesized remainder past it", () => {
  assert.equal(moreSuffix(0), "");
  assert.equal(moreSuffix(3), " (+3 more)");
});

// --- PREFILL_REASON (the over-long value's prefill note) ---

test("PREFILL_REASON is the shared over-long-prompt/prefill note", () => {
  assert.equal(PREFILL_REASON, "it rides into every run's prefill");
});
