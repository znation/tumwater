import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { nativeLogPath, roleNotesPath, sessionDir } from "../src/paths.js";
import { recordSession } from "../src/agent/session-ledger.js";
import { agentSessionResumable } from "../src/agent/agent-backend.js";
import { claudeTranscriptPath } from "../src/agent/claude/claude-backend.js";
import { defaultConfig } from "../src/config/config.js";
import { configForRole } from "../src/config/config-views.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { withPi } from "./fakes/fake-pi.js";
import { withClaudeReplay } from "./fakes/fake-claude.js";
import { claudeInit, claudeResult } from "./fixtures/claude-events.js";
import { assistantLine, errorLine } from "./fixtures/pi-events.js";
import { makeHost, recordingFakePi, runArgs } from "./fixtures/loop-pi-fixtures.js";

// LoopPi's one-reply follow-up turns (src/loop/loop-pi.ts): requestSummary asks the tick's
// own session for the missing SUMMARY block, and requestStageFix asks it to address review
// findings. Both resume the authoring session through the shared transient retry, carry the
// role notebook like the authoring run, and fold their spend into the tick's counters.
// Tested through a fake pi on PATH.
test("requestSummary returns null when the role has no resumable session", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args);
  try {
    const { loopPi } = makeHost(root);
    const result = await loopPi.requestSummary(root);
    assert.equal(result, null);
    assert.ok(!fs.existsSync(args), "no pi run is spawned when there is no session to continue");
  } finally {
    restore();
  }
});

test("requestSummary refuses a session whose newest ledger line names another agent", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args);
  try {
    const dir = sessionDir(root, "feature");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "s.jsonl"), "{}\n");
    recordSession(dir, {
      agent: "claude",
      id: "c",
      kind: "author",
      name: "n",
      cwd: root,
      at: Date.now(),
    });
    const { loopPi } = makeHost(root);
    const result = await loopPi.requestSummary(root);
    assert.equal(result, null, "another agent's session is not ours to --continue");
    assert.ok(!fs.existsSync(args), "no pi run for another agent's session");
  } finally {
    restore();
  }
});

test("requestSummary resumes the tick's session and folds its usage", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    firstRun: `printf '%s\\n' '${assistantLine("SUMMARY: tidied the parser")}'`,
  });
  try {
    fs.mkdirSync(sessionDir(root, "feature"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(root, "feature"), "session.jsonl"), "{}\n");
    const { loopPi, usage } = makeHost(root);
    const result = await loopPi.requestSummary(root);
    assert.ok(result, "a resumable session produces a run");
    assert.equal(result!.ok, true);
    assert.match(result!.finalText, /tidied the parser/);
    assert.equal(usage.length, 1);
    assert.match(runArgs(args)[0]!, /--continue/, "the follow-up continues the authoring session");
    assert.match(fs.readFileSync(args, "utf8"), /required closing block/, "the run asks for the SUMMARY block, not a free-form reply");
  } finally {
    restore();
  }
});

test("requestSummary carries the role notebook path, like the authoring run", async () => {
  // The SUMMARY/stage-fix follow-ups continue the authoring session, so they must run with
  // the same notes wiring: the shared wiring fills PiRunOptions.notesPath exactly as
  // runAuthoringPi does, and the `tumwater-notes` command reaches the same file through
  // TUMWATER_NOTES_PATH. The director keeps no notebook.
  const root = tmpdir();
  const envFile = path.join(root, "notes-env");
  await withPi(
    `printf '[%s]' "$TUMWATER_NOTES_PATH" >> "${envFile}"\nprintf '%s\\n' '${assistantLine("SUMMARY: tidied src")}'`,
    async () => {
      fs.mkdirSync(sessionDir(root, "feature"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir(root, "feature"), "session.jsonl"), "{}\n");
      const { loopPi } = makeHost(root);
      const result = await loopPi.requestSummary(root);
      assert.ok(result);
      assert.equal(
        fs.readFileSync(envFile, "utf8"),
        `[${roleNotesPath(root, "feature")}]`,
        "the follow-up runs with the role's notebook path in its environment",
      );
    },
  );
});

test("a follow-up that runs on a claude seam writes its native log under that seam's name", async () => {
  // PLANS.md "Mixed claude + pi fleets, part 2/4", gap 4: the follow-up (requestFollowUp)
  // must pass its effective config to loopPiOpts, so a SUMMARY turn running on the claude
  // fallback during a model-failure episode writes its native log (and computes its
  // authoring budget) under the claude seam, never the pi primary.
  const root = tmpdir();
  await withClaudeReplay(
    [
      claudeInit({ sessionId: "c1" }),
      claudeResult({ totalCostUsd: 0.01 }),
    ],
    async () => {
      // The role's own config is a PI seam; the follow-up we hand it runs on the claude seam
      // (a model-failure fallback to the other backend). Resolving that seam through
      // configForRole gives a well-formed run config.
      const roleCfg = defaultConfig();
      roleCfg.agent = "pi";
      const claudeCfg = defaultConfig();
      claudeCfg.agent = "claude";
      claudeCfg.model = "claude-sonnet-5-5";
      const claudeSeam = configForRole(claudeCfg, "feature");
      const { loopPi } = makeHost(root, roleCfg);
      // Seed a resumable claude author session exactly as a real claude authoring run would
      // leave one: the ledger record plus its transcript file under the temp $HOME (the fake
      // claude writes the transcript; seeding it ourselves keeps this test focused on the
      // follow-up wiring rather than the claude resume mechanics already pinned elsewhere).
      const dir = sessionDir(root, "feature");
      recordSession(dir, { agent: "claude", id: "followup-session", kind: "author", name: "n", cwd: root, at: Date.now() });
      fs.mkdirSync(path.dirname(claudeTranscriptPath(root, "followup-session")), { recursive: true });
      fs.writeFileSync(claudeTranscriptPath(root, "followup-session"), "{}");
      assert.equal(agentSessionResumable(dir, { kind: "author", agent: "claude" }), true, "the seeded claude session is resumable");
      // The SUMMARY follow-up now continues that claude session.
      const result = await loopPi.requestSummary(root, claudeSeam);
      assert.ok(result, "a resumable claude session produces a run");
      assert.match(fs.readFileSync(nativeLogPath(root, "feature", "claude"), "utf8"), /"type":"result"/, "the follow-up's native log lands at the claude seam path");
      assert.ok(!fs.existsSync(nativeLogPath(root, "feature", "pi")), "no pi native log for a claude follow-up");
    },
  );
});

test("requestSummary's 429 takes the shared transient retry: warns, waits the hint out, resumes, folds both", async () => {
  // BUGS.md 2026-10-01: the SUMMARY follow-up called bare runPi while the shared retry's own
  // doc claimed it wires EVERY pi run the loop makes — so a 429 on the follow-up turn failed
  // it on first contact with no retry, no per-run warning, and no team-wide rate-limit hold
  // stamp, exactly the gate bypass the reviewer side fixed the same day. The follow-up now
  // takes the same runWithTransientRetry wiring (its capped budget applies to both attempts).
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    firstRun: `printf '%s\\n' '${errorLine('429 "Rate limit exceeded" — retry after 3s')}'`,
  });
  try {
    fs.mkdirSync(sessionDir(root, "feature"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(root, "feature"), "session.jsonl"), "{}\n");
    const { loopPi, warns, usage, sleeps } = makeHost(root);
    const result = await loopPi.requestSummary(root);
    assert.ok(result, "a resumable session produces a run");
    assert.equal(result!.ok, true, "the retry succeeds on the warm session");
    assert.match(result!.finalText, /SUMMARY: tidied src/, "the retry delivers the SUMMARY block");
    assert.equal(usage.length, 2, "both attempts fold — the failed 429 before the wait");
    assert.match(warns[0]!, /rate-limited the request \(429, retry after 3s\)/);
    assert.deepEqual(sleeps, [3000], "the hint is waited out before the retry");
    // The SUMMARY request prompt is multi-line, so the argv log (one `$*` line per run,
    // split at the prompt's newlines) cannot be read per line — count the resume flags over
    // the whole recording instead: both attempts continue the authoring session, and the
    // follow-up never re-names it.
    const recorded = fs.readFileSync(args, "utf8");
    assert.ok(!recorded.includes('-n '), "the follow-up never re-names the session");
    assert.equal((recorded.match(/--continue/g) ?? []).length, 2, "both attempts continue the authoring session");
    assert.match(recorded, /required closing block/, "both attempts ask for the SUMMARY block");
  } finally {
    restore();
  }
});

test("requestSummary returns the run even when it failed and still folds its usage", async () => {
  // The follow-up asks the tick's own session for the missing SUMMARY block; the run can
  // fail like any other (provider error, nonzero exit). The doc'd contract says the caller
  // gets the run back regardless — it must be able to honor a shutdown abort on it — and
  // the failed attempt's spend is folded into the tick's counters like every other run.
  const root = tmpdir();
  const args = path.join(root, "args");
  await withPi(`printf '%s\\n' "$*" >> "${args}"\nprintf '%s\\n' 'model exploded' >&2\nexit 1`, async () => {
    fs.mkdirSync(sessionDir(root, "feature"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(root, "feature"), "session.jsonl"), "{}\n");
    const { loopPi, usage } = makeHost(root);
    const result = await loopPi.requestSummary(root);
    assert.ok(result, "a failed run is returned, not null — null means there was no session to ask");
    assert.equal(result!.ok, false);
    assert.match(result!.errorMessage ?? "", /model exploded/, "the failure's stderr names the cause");
    assert.equal(usage.length, 1, "one run, one foldUsage — failures included");
    assert.equal(usage[0], result, "the foldUsage'd run IS the returned run");
    const recorded = fs.readFileSync(args, "utf8");
    assert.match(recorded, /--continue/, "the failure still continued the authoring session");
    assert.match(recorded, /required closing block/, "the failed run asked for the SUMMARY block");
  });
});

test("requestStageFix returns null when the role has no resumable session", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args);
  try {
    const { loopPi } = makeHost(root);
    const result = await loopPi.requestStageFix(root, ["task id is missing"]);
    assert.equal(result, null);
    assert.ok(!fs.existsSync(args), "no pi run is spawned when there is no session to continue");
  } finally {
    restore();
  }
});

test("requestStageFix resumes the tick's session with the findings and folds its usage", async () => {
  const root = tmpdir();
  const args = path.join(root, "args");
  const restore = recordingFakePi(args, {
    firstRun: `printf '%s\\n' '${assistantLine("addressed both faults")}'`,
  });
  try {
    fs.mkdirSync(sessionDir(root, "feature"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(root, "feature"), "session.jsonl"), "{}\n");
    const { loopPi, usage } = makeHost(root);
    const result = await loopPi.requestStageFix(root, [
      "task id is missing",
      "stray file in the diff",
    ]);
    assert.ok(result, "a resumable session produces a run");
    assert.equal(result!.ok, true);
    assert.match(result!.finalText, /addressed both faults/);
    assert.equal(usage.length, 1, "one run, one foldUsage");
    assert.equal(usage[0], result, "the foldUsage'd run IS the returned run");
    // The stage-fix prompt is multi-line, so the argv log (one `$*` line per run, split at the
    // prompt's newlines) cannot be read per line — assert over the whole recording instead.
    const recorded = fs.readFileSync(args, "utf8");
    assert.match(recorded, /--continue/, "the fix-up continues the authoring session");
    assert.ok(!recorded.includes('-n '), "the fix-up never re-names the session");
    assert.match(recorded, /task id is missing/, "the first finding is in the prompt");
    assert.match(recorded, /stray file in the diff/, "the second finding is in the prompt");
    assert.match(recorded, /closing block again/, "the run asks for the closing block again");
  } finally {
    restore();
  }
});
