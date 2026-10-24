/** The framework-free keypress factory (src/ui/tui/tui-keys.ts) driven directly — no terminal, no
 * readline event emitter, no ink: the factory only needs a root for its disk actions, a quit
 * callback, a render-request recorder, and (for the flash-expiry case) an injectable clock.
 * One case per handler family, per PLANS.md "TUI moves to ink, part 2a/3": prompt editing,
 * budget mode open/save/cancel, role-prompt mode, history recall, view cycling and paging,
 * and flash expiry. The full-TUI key behavior keeps its coverage in tui-operator-keys.test.ts
 * and tui.test.ts through the same dispatch. */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { renderDoctor, renderDoctorProblems } from "../src/doctor/doctor-render.js";
import type { DoctorReport } from "../src/doctor/doctor-checks.js";
import { arrowDir, inkKeyToReadline, pageDir } from "../src/ui/tui/tui-keymap.js";
import { createTuiKeys } from "../src/ui/tui/tui-keys.js";
import type { previewRevert } from "../src/operator/revert.js";
import { overlapDrillHeading, overlapHolders, mergeQueueRoles, postReviewRoles } from "../src/ui/tui/tui-pane-pending.js";
import { historyWindowBounds } from "../src/ui/tui/tui-pane-history.js";
import { promptLineFree, type TuiPaneEditorState } from "../src/ui/tui/tui-pane-ctx.js";
import { renderRoleChange, renderRoleChanges } from "../src/change/change-render.js";
import { enqueueMerge, queuedMergeFiles, queuedMerges, readMergeQueue, type MergeQueueView } from "../src/merge/merge-queue.js";
import { renderMergeQueue } from "../src/merge/merge-queue-render.js";
import { readPostReviews, type PostReview } from "../src/review/post-merge-review.js";
import { renderPostReviews } from "../src/review/post-merge-review-render.js";
import { shortSha } from "../src/text/format.js";
import { writeMergeMarker } from "../src/merge/merge-slot.js";
import { enqueuePrompt, enqueueRolePrompt, listWideScope, queuedListRows, renderQueuedList } from "../src/inbox/inbox.js";
import { notBeforeMs } from "../src/inbox/prompt-not-before.js";
import { readQueuedPromptBody } from "../src/inbox/inbox-edit.js";
import { abortRequestPath, branchName, mergeRefName, piLogPath, postReviewPath, reclaimRequestPath, roleNotesPath, wakeRequestPath } from "../src/paths.js";
import { eventsOfType, writeEvents, writeOrchestratorMarker } from "./fixtures/log-fixtures.js";
import { refSha, setRef } from "../src/git/git.js";
import { readRunDetail } from "../src/run/run-detail-data.js";
import { renderRunDetail, runTranscriptLines } from "../src/run/run-detail-render.js";
import { initializedRepo, initializedWorktree, makeRepo, pinOffMain, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { PROMPT_START, readBrief, renderBrief } from "../src/brief/brief.js";
import { readJson } from "./helpers/json-read.js";
import { disableRole } from "./helpers/disable-role.js";
import { errnoError, patchFsMethod } from "./helpers/fs-faults.js";
import { waitFor, waitForFile, sleep } from "./helpers/wait.js";
import { entryKey } from "../src/backlog/backlog-parts.js";
import { saveRunnerState } from "../src/runner/runner-state.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { setConfigKey } from "../src/config/config-write.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { steppedWindowBounds } from "../src/ui/tui/tui-pane-session.js";
import { pendingOverlapsText } from "../src/ui/tui/tui-pane-pending.js";
import { writeJsonFile } from "../src/files/json-files.js";

/** A throwaway root for the factory's disk actions (config write, prompt inbox, backlog). */
const makeRoot = (): string => tmpdir("tui-keys-");

/** A handler wired to a controllable clock, a quit recorder, and a render-request recorder. */
/** Poll `flash` until it matches `re`, with a hard deadline — retire runs git spawns, so the
 * flash lands after the async core its Enter arm awaits. */
async function untilFlash(flash: () => string, re: RegExp, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!re.test(flash())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${re}`);
    await sleep(20);
  }
}

function makeKeys(root: string, now: () => number, runStat?: () => Promise<string>, seams: Partial<Parameters<typeof createTuiKeys>[0]> = {}) {
  const quit = (): number => (quit.count += 1);
  quit.count = 0;
  let renders = 0;
  const keys = createTuiKeys({ root, quit, requestRender: () => (renders += 1), now, runDoctor: () => new Promise<DoctorReport>(() => {}), runStat, ...seams }); // Health never resolves: no real probes
  return { keys, quitCount: () => quit.count, renders: () => renders };
}

test("applyKey edits the prompt line: typing, backspace, and cursor position flow through", () => {
  const root = makeRoot();
  const { keys, renders } = makeKeys(root, () => 0);
  for (const ch of "hi") keys.handleKey(ch, { name: ch });
  assert.equal(keys.state().input, "hi");
  assert.equal(keys.state().cursor, 2);
  keys.handleKey(undefined, { name: "backspace" });
  assert.equal(keys.state().input, "h");
  assert.equal(keys.state().cursor, 1);
  assert.ok(renders() >= 3, "every dispatched keypress requests a render");
});

test("budget mode opens pre-filled, saves the cap on Enter, and Esc cancels unchanged", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(50, false, []); // cap $50 visible to the handler
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  assert.equal(keys.state().input, "50");
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().budgetMode, false, "a saved cap leaves edit mode");
  assert.equal(keys.state().flash, "budget is already $50, so tumwater.json was not written");
  // The cap already resolves to the default 50, so no tumwater.json is created.
  assert.equal(fs.existsSync(path.join(root, "tumwater.json")), false);

  // Esc cancels: the pre-filled value never reaches config.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().budgetMode, false);
  assert.equal(fs.existsSync(path.join(root, "tumwater.json")), false);

  // An invalid value flashes and STAYS in edit mode.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  keys.handleKey(undefined, { ctrl: true, name: "u" }); // clear the pre-filled cap
  for (const ch of "abc") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().budgetMode, true, "invalid input keeps edit mode open");
  assert.match(keys.state().flash!, /plain dollar amount/);
});

test("Ctrl+B on a role's Transcript edits that role's daily cap, not the team budget", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(50, false, ["feature", "director", "clean"]); // team cap $50, roster {feature, director, clean}
  // Seed one role's cap through the dotted write the editor itself will use, so the
  // pre-fill has something to read (and a non-feature entry to leave untouched).
  const seed = setConfigKey(root, "maxDailyCostUsdPerRole.clean", "25");
  assert.equal(seed.ok, true);
  const setRoleCap = (): Record<string, number> =>
    (readJson(path.join(root, "tumwater.json")) as { maxDailyCostUsdPerRole?: Record<string, number> })
      .maxDailyCostUsdPerRole ?? {};

  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature's transcript
  assert.equal(keys.state().view, 1);
  assert.equal(keys.state().roleIds[keys.state().view - 1], "feature");

  // Open: no pre-fill when the role has no cap yet (the team's $50 snapshot is out of
  // scope), and the saved draft is restored on Esc with nothing written.
  for (const ch of "pending draft") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  assert.equal(keys.state().input, "", "a cap-less role pre-fills an empty line");
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().budgetMode, false);
  assert.equal(keys.state().input, "pending draft", "Esc restores the saved draft");
  assert.equal(setRoleCap().feature, undefined, "Esc writes nothing");

  // Enter writes the dotted key, leaving the team maxDailyCostUsd and the other role's
  // entry untouched, then flashes the role's own wording.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  for (const ch of "60") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().budgetMode, false, "a saved cap leaves edit mode");
  assert.equal(keys.state().flash, "feature: cap set to $60");
  const afterSet = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");
  const cfg = readJson(path.join(root, "tumwater.json")) as {
    maxDailyCostUsd?: number;
    maxDailyCostUsdPerRole?: Record<string, number>;
  };
  assert.equal(cfg.maxDailyCostUsdPerRole?.feature, 60, "the viewed role's cap is written");
  assert.equal(cfg.maxDailyCostUsdPerRole?.clean, 25, "another role's entry is untouched");
  assert.equal(cfg.maxDailyCostUsd, 50, "the team budget default is untouched");

  // A re-open pre-fills the file's cap value (the snapshot's $50 team figure is not read).
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().input, "60", "the role's own cap pre-fills the line");
  // Enter on the pre-filled value is a no-op: says so and leaves the file alone.
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().budgetMode, false);
  assert.equal(keys.state().flash, "feature: cap is already $60, so tumwater.json was not written");
  assert.equal(fs.readFileSync(path.join(root, "tumwater.json"), "utf8"), afterSet);
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  // An empty line removes the cap.
  keys.handleKey(undefined, { ctrl: true, name: "u" });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().flash, "feature: cap removed");
  assert.equal(
    (readJson(path.join(root, "tumwater.json")) as { maxDailyCostUsdPerRole?: Record<string, number> })
      .maxDailyCostUsdPerRole?.feature,
    0,
    "an empty line writes 0 (the cap-off value)",
  );
  const afterRemove = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  keys.handleKey(undefined, { ctrl: true, name: "u" });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().budgetMode, false);
  assert.equal(keys.state().flash, "feature: cap is already removed, so tumwater.json was not written");
  assert.equal(fs.readFileSync(path.join(root, "tumwater.json"), "utf8"), afterRemove);

  // An invalid value flashes and STAYS open.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  for (const ch of "abc") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().budgetMode, true, "invalid input keeps edit mode open");
  assert.match(keys.state().flash!, /plain dollar amount/);
  keys.handleKey(undefined, { name: "escape" });

  // On the director's Transcript, Ctrl+B opens nothing and names the exemption.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → director's transcript
  assert.equal(keys.state().view, 2);
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, false, "the director's cap editor never opens");
  assert.equal(keys.state().flash, "the director has no daily cap");

  // Ctrl+T (exitAll) leaves the role-cap editor and restores the draft, as the team editor does.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → clean's transcript (back to a role)
  assert.equal(keys.state().view, 3);
  keys.handleKey(undefined, { ctrl: true, name: "u" }); // clear the carried-over prompt line
  for (const ch of "another draft") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().budgetMode, false, "Ctrl+T leaves the role-cap editor");
  assert.equal(keys.state().input, "another draft", "Ctrl+T restores the saved draft");
});

test("role-prompt mode opens for the viewed role, submits, and Esc restores the draft", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean"]);
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // events → transcript
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().rolePromptFor, "clean");
  assert.equal(keys.state().input, "");
  for (const ch of "fix it") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().rolePromptFor, null, "submitting leaves role-prompt mode");
  const queue = path.join(root, ".tumwater", "inbox", "clean");
  assert.equal(fs.readdirSync(queue).filter((f) => f.endsWith(".md")).length, 1);

  // Esc cancels and restores the saved director draft.
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().rolePromptFor, null);
  assert.equal(fs.readdirSync(queue).length, 1, "a cancelled role prompt queues nothing");
});

test("notes edit mode reads a role's notes replacement from a typed file path", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean"]);
  // Seed a note so the notes view renders it, and a replacement file to type into the editor.
  const notePath = roleNotesPath(root, "clean");
  writeFileDeep(notePath, "stale note\n");
  const replacement = path.join(root, "replacement.md");
  fs.writeFileSync(replacement, "the fresh note\n");

  keys.handleKey(undefined, { ctrl: true, name: "t" }); // events → transcript
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // → notes
  keys.handleKey(undefined, { ctrl: true, name: "e" }); // open the notes editor
  assert.equal(keys.state().notesEditFor, "clean");
  assert.equal(keys.state().input, "");
  for (const ch of replacement) keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().notesEditFor, null, "a successful save leaves the notes editor");
  assert.equal(fs.readFileSync(notePath, "utf8"), "the fresh note\n");
  assert.match(keys.state().flash!, /notes saved/);

  // Esc cancels, restores the prompt draft, and writes nothing.
  for (const ch of "a director draft") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().input, "");
  for (const ch of "other/path.md") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().notesEditFor, null);
  assert.equal(keys.state().input, "a director draft", "Esc restores the saved prompt draft");
  assert.equal(keys.state().flash, "notes edit cancelled");
  assert.equal(fs.readFileSync(notePath, "utf8"), "the fresh note\n");

  // An empty path and a missing file flash and keep the editor open.
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().notesEditFor, "clean", "an empty path keeps the editor open");
  assert.match(keys.state().flash!, /a file path is required/);
  for (const ch of path.join(root, "nope.md")) keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().notesEditFor, "clean", "a missing file keeps the editor open");
  assert.match(keys.state().flash!, /no such file/);

  // An over-cap note flashes and keeps the editor open, writing nothing.
  const big = path.join(root, "big.md");
  fs.writeFileSync(big, "x".repeat(5000));
  keys.handleKey(undefined, { ctrl: true, name: "u" }); // clear the typed path
  for (const ch of big) keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().notesEditFor, "clean", "an over-cap note keeps the editor open");
  assert.match(keys.state().flash!, /shorten it to at most 4096 bytes/);
  assert.equal(fs.readFileSync(notePath, "utf8"), "the fresh note\n");

  // Ctrl+X during the edit must not clear the note mid-edit, and Ctrl+N must not cycle the
  // notes view away from the open editor (either would desync noteMode from the held line).
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().notesEditFor, "clean", "Ctrl+N does not close the notes editor");
  assert.equal(keys.state().noteMode, true, "Ctrl+N does not cycle the notes view away while editing");
  assert.equal(keys.state().changeMode, false, "Ctrl+N does not switch to the change view while editing");
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().notesEditFor, "clean", "Ctrl+X does not close the notes editor");
  assert.equal(keys.state().noteMode, true, "Ctrl+X does not exit the notes view while editing");
  assert.equal(fs.readFileSync(notePath, "utf8"), "the fresh note\n", "Ctrl+X does not clear the note mid-edit");

  // Ctrl+B while the notes editor holds the line refuses.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().notesEditFor, "clean", "notes keeps the line; budget does not open");
  assert.equal(keys.state().budgetMode, false);
  assert.match(keys.state().flash!, /finish or cancel the notes edit first/);
});

test("notes edit mode keeps Up/Down from recalling history into the typed path field", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean"]);
  // Seed the recall history with a submitted prompt, so Up would paste it if it reached the field.
  for (const ch of "run the tests") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().input, "", "submitting clears the line");

  keys.handleKey(undefined, { ctrl: true, name: "t" }); // events → transcript
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // → notes
  keys.handleKey(undefined, { ctrl: true, name: "e" }); // open the notes editor
  for (const ch of "notes/path.md") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "up" });
  assert.equal(keys.state().notesEditFor, "clean", "Up does not close the notes editor");
  assert.equal(keys.state().input, "notes/path.md", "Up does not recall the submitted prompt into the path field");
  keys.handleKey(undefined, { name: "down" });
  assert.equal(keys.state().input, "notes/path.md", "Down does not recall into the path field either");
});

test("history recall: a submitted prompt comes back on Up", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  for (const ch of "run the tests") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().input, "", "submitting clears the line");
  keys.handleKey(undefined, { name: "up" });
  assert.equal(keys.state().input, "run the tests");
  keys.handleKey(undefined, { name: "down" });
  assert.equal(keys.state().input, "", "Down past the newest entry returns to the blank line");
});

test("Ctrl+T cycles the views and PgDn/PgUp page a selected backlog entry's body", () => {
  const root = makeRoot();
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    "## Planned\n\n### A plan (planned 2026-10-02 by test)\n\n" +
      Array.from({ length: 20 }, (_, i) => `body line ${i + 1}`).join("\n") + "\n",
  );
  const { keys, renders } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  keys.setLineBudgets(5, 4); // the render-fed activity-pane budget
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → backlog (roleIds.length+1 = 1)
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { name: "down" });
  assert.equal(keys.state().selectedEntry, 0, "Down opens the first entry in full");
  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().entryScroll, 4, "PgDn advances the body window by the entry budget");
  keys.handleKey(undefined, { name: "pageup" });
  assert.equal(keys.state().entryScroll, 0, "PgUp clamps back to the head");
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().selectedEntry, null, "cycling away drops the selection");
  assert.ok(renders() > 0);
});

/** A root with two planned entries, two open bugs, and one open question, the keys on the
 * backlog view. */
function backlogCancelRig(seed?: string) {
  const root = makeRoot();
  const plans = seed ?? "## Planned\n\n### Plan one (planned 2026-10-02 by test)\n\nbody\n\n### Plan two (planned 2026-10-02 by test)\n\nbody\n";
  const bugs = "## Open\n\n### Bug one (found by test 2026-10-02)\n\nbody\n\n### Bug two (found by test 2026-10-02)\n\nbody\n";
  fs.writeFileSync(path.join(root, "PLANS.md"), plans);
  fs.writeFileSync(path.join(root, "BUGS.md"), bugs);
  fs.writeFileSync(path.join(root, "QUESTIONS.md"), "## Open\n\n### A question (asked by test 2026-10-02)\n\nbody\n");
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  const down = (n: number): void => {
    for (let i = 0; i < n; i++) keys.handleKey(undefined, { name: "down" });
  };
  const ctrlX = (): void => keys.handleKey(undefined, { ctrl: true, name: "x" });
  const ctrlV = (): void => keys.handleKey(undefined, { ctrl: true, name: "v" });
  const read = (f: string): string => fs.readFileSync(path.join(root, f), "utf8");
  return { root, keys, down, ctrlX, ctrlV, read, plans, bugs };
}

test("backlog Ctrl+X cancel of a claimed plan flashes who is still working on it", () => {
  const { root, keys, down, ctrlX } = backlogCancelRig();
  const title = "Plan one (planned 2026-10-02 by test)";
  saveRunnerState(root, {
    ...loadRunnerState(root, "feature-2"),
    claim: { file: "PLANS.md", key: entryKey(title), title, at: 1, source: "assigned" },
  });
  down(1);
  ctrlX();
  ctrlX();
  assert.match(keys.state().flash ?? "", /cancelled plan #1: .*is still working on it/);
});

test("backlog Ctrl+X cancel of a required series part flashes the parts that no longer wait", () => {
  const { root, keys, down, ctrlX } = backlogCancelRig();
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    "## Planned\n\n### S, part 1/2: a (planned 2026-10-02 by test)\n\nbody\n\n### S, part 2/2: b (planned 2026-10-02 by test; requires part 1/2 landed)\n\nbody\n",
  );
  keys.syncSnapshot(0, false, []);
  down(1);
  ctrlX();
  ctrlX();
  assert.match(keys.state().flash ?? "", /required it/);
});

test("backlog Ctrl+X arms, then a second Ctrl+X cancels the selected bug", () => {
  const { keys, down, ctrlX, read, plans, bugs } = backlogCancelRig();
  down(4); // plan 1, plan 2, bug 1, bug 2
  ctrlX();
  assert.deepEqual(keys.state().cancelArmed, {
    kind: "bug",
    position: 2,
    title: "Bug two (found by test 2026-10-02)",
  });
  assert.equal(read("BUGS.md"), bugs);
  assert.match(keys.state().flash ?? "", /press Ctrl\+X again/);
  ctrlX();
  assert.ok(!read("BUGS.md").includes("Bug two") && read("BUGS.md").includes("Bug one"));
  assert.equal(read("PLANS.md"), plans);
  assert.equal(keys.state().cancelArmed, null);
  assert.equal(keys.state().selectedEntry, null);
  assert.match(keys.state().flash ?? "", /cancelled bug #2/);
});

test("backlog Ctrl+X disarms on any other key, and refuses questions and list mode", () => {
  const { keys, down, ctrlX, read, plans } = backlogCancelRig();
  ctrlX(); // list mode
  assert.equal(keys.state().cancelArmed, null);
  down(1);
  ctrlX();
  assert.notEqual(keys.state().cancelArmed, null);
  keys.handleKey("a", { name: "a" });
  assert.equal(keys.state().cancelArmed, null);
  ctrlX();
  assert.equal(read("PLANS.md"), plans, "a re-arm writes nothing");
  down(4); // → the question
  ctrlX();
  assert.equal(keys.state().cancelArmed, null);
  assert.match(keys.state().flash ?? "", /only a plan or open bug can be cancelled here/);
  assert.equal(read("PLANS.md"), plans);
});

test("a done plan, fixed bug or answered question selected in the backlog pane is read-only to Ctrl+X, Ctrl+E and Ctrl+A", () => {
  const { root, keys, down, ctrlX, read, plans } = backlogCancelRig();
  const withDone = plans + "\n## Done\n\n### Shipped (planned 2026-09-01, done 2026-10-06)\n\nbody\n";
  fs.writeFileSync(path.join(root, "PLANS.md"), withDone);
  const withAnswered =
    read("QUESTIONS.md") + "\n## Answered\n\n### Decided (asked by test 2026-10-01)\n\nbody\n\n**Answered 2026-10-02 by operator:** go\n";
  fs.writeFileSync(path.join(root, "QUESTIONS.md"), withAnswered);
  down(6); // five open entries, then the answered row
  assert.equal(keys.state().selectedEntry, 5);
  ctrlX();
  assert.match(keys.state().flash ?? "", /a done plan, fixed bug or answered question is read-only/);
  assert.equal(keys.state().cancelArmed, null);
  ctrlX();
  assert.equal(read("PLANS.md"), withDone);
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.match(keys.state().flash ?? "", /a done plan, fixed bug or answered question is read-only/);
  assert.equal(keys.state().entryEditFor, null);
  keys.handleKey(undefined, { ctrl: true, name: "a" });
  assert.match(keys.state().flash ?? "", /only an open question can be answered here/);
  assert.equal(read("QUESTIONS.md"), withAnswered);
  down(1); // onto the done row
  assert.equal(keys.state().selectedEntry, 6);
  ctrlX();
  assert.match(keys.state().flash ?? "", /a done plan, fixed bug or answered question is read-only/);
  keys.handleKey(undefined, { name: "up" });
  keys.handleKey(undefined, { name: "up" }); // onto the open question
  keys.handleKey(undefined, { ctrl: true, name: "a" });
  assert.match(keys.state().flash ?? "", /answering question #1/);
});

test("backlog Ctrl+X on a moved entry cancels nothing, and the budget editor blocks it", () => {
  const { root, keys, down, ctrlX, read } = backlogCancelRig();
  down(1);
  ctrlX();
  const rewritten = "## Planned\n\n### Other (planned 2026-10-02 by test)\n\nbody\n";
  fs.writeFileSync(path.join(root, "PLANS.md"), rewritten);
  ctrlX();
  assert.equal(read("PLANS.md"), rewritten);
  assert.match(keys.state().flash ?? "", /already removed or moved/);
  assert.equal(keys.state().selectedEntry, null);
  down(1);
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  ctrlX();
  assert.equal(keys.state().cancelArmed, null);
  assert.equal(read("PLANS.md"), rewritten);
});

test("backlog Ctrl+V moves the selected bug to the head of its section", () => {
  const { keys, down, ctrlV, read, plans } = backlogCancelRig();
  down(4); // plan 1, plan 2, bug 1, bug 2
  ctrlV();
  assert.ok(read("BUGS.md").indexOf("Bug two") < read("BUGS.md").indexOf("Bug one"));
  assert.equal(read("PLANS.md"), plans);
  assert.equal(keys.state().selectedEntry, null);
  assert.match(keys.state().flash ?? "", /moved bug #2/);
});

test("backlog Ctrl+V moves the selected plan to the head of its section", () => {
  const { keys, down, ctrlV, read, bugs } = backlogCancelRig();
  down(2); // plan 1, plan 2
  ctrlV();
  assert.ok(read("PLANS.md").indexOf("Plan two") < read("PLANS.md").indexOf("Plan one"));
  assert.equal(read("BUGS.md"), bugs);
  assert.match(keys.state().flash ?? "", /moved plan #2/);
});

test("backlog Ctrl+V on the first entry, an answered row, or a question refuses, and budget mode blocks it", () => {
  const { root, keys, down, ctrlV, read, plans, bugs } = backlogCancelRig();
  down(1); // the first plan is already at the head
  ctrlV();
  assert.equal(read("PLANS.md"), plans);
  assert.equal(read("BUGS.md"), bugs);
  assert.match(keys.state().flash ?? "", /already at the top/);
  // an answered question row is read-only
  const withDone = plans + "\n## Done\n\n### Shipped (planned 2026-09-01, done 2026-10-06)\n\nbody\n";
  fs.writeFileSync(path.join(root, "PLANS.md"), withDone);
  const withAnswered =
    read("QUESTIONS.md") + "\n## Answered\n\n### Decided (asked by test 2026-10-01)\n\nbody\n\n**Answered 2026-10-02 by operator:** go\n";
  fs.writeFileSync(path.join(root, "QUESTIONS.md"), withAnswered);
  down(6); // 5 open entries, then the answered row
  assert.equal(keys.state().selectedEntry, 5);
  ctrlV();
  assert.match(keys.state().flash ?? "", /a done plan, fixed bug or answered question is read-only/);
  assert.equal(read("PLANS.md"), withDone);
  keys.handleKey(undefined, { name: "up" }); // back onto the open question
  ctrlV();
  assert.match(keys.state().flash ?? "", /only a plan or open bug can be moved here/);
  assert.equal(read("PLANS.md"), withDone);
  // the budget editor blocks the move through the promptLineFree guard
  keys.handleKey(undefined, { name: "down" }); // back onto the answered row
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  ctrlV();
  assert.equal(read("PLANS.md"), withDone);
  assert.equal(read("BUGS.md"), bugs);
});

const HELD_PLANS =
  "## Planned\n\n### Export series, part 1/2: a (planned 2026-10-01)\n\nbody\n\n" +
  "### Export series, part 2/2: b (planned 2026-10-02; requires part 1/2 landed)\n\nbody\n";

function backlogReleaseRig(seed?: string) {
  const root = makeRoot();
  const plans =
    seed ?? "## Planned\n\n### Plan one (planned 2026-10-02 by test)\n\nbody\n\n### Plan two (planned 2026-10-02 by test)\n\nbody\n";
  const bugs =
    "## Open\n\n### Bug one (found by test 2026-10-02)\n\nbody\n\n### Bug two (found by test 2026-10-02)\n\nbody\n\n**Refused 2026-10-02 by feature: no**\n";
  fs.writeFileSync(path.join(root, "PLANS.md"), plans);
  fs.writeFileSync(path.join(root, "BUGS.md"), bugs);
  fs.writeFileSync(path.join(root, "QUESTIONS.md"), "## Open\n\n### A question (asked by test 2026-10-02)\n\nbody\n");
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  const down = (n: number): void => {
    for (let i = 0; i < n; i++) keys.handleKey(undefined, { name: "down" });
  };
  const ctrlR = (): void => keys.handleKey(undefined, { ctrl: true, name: "r" });
  const read = (f: string): string => fs.readFileSync(path.join(root, f), "utf8");
  return { root, keys, down, ctrlR, read, plans, bugs };
}

test("backlog Ctrl+R arms, then a second Ctrl+R releases the selected refused bug", () => {
  const { root, keys, down, ctrlR, read, plans, bugs } = backlogReleaseRig();
  down(4); // plan 1, plan 2, bug 1, bug 2
  ctrlR();
  assert.deepEqual(keys.state().releaseArmed, {
    kind: "bug",
    position: 2,
    title: "Bug two (found by test 2026-10-02)",
  });
  assert.equal(read("BUGS.md"), bugs);
  assert.match(keys.state().flash ?? "", /press Ctrl\+R again/);
  ctrlR();
  assert.ok(!read("BUGS.md").includes("Refused") && read("BUGS.md").includes("Bug two"));
  assert.equal(read("PLANS.md"), plans);
  const marker = readJson(wakeRequestPath(root)) as { roles: string[] };
  assert.deepEqual(marker.roles, ["bugfix"]);
  assert.equal(keys.state().releaseArmed, null);
  assert.equal(keys.state().selectedEntry, null);
  assert.match(keys.state().flash ?? "", /released bug #2/);
});

test("backlog Ctrl+R on a still-held plan says so and wakes no role", () => {
  const { root, keys, down, ctrlR, read } = backlogReleaseRig(HELD_PLANS + "\n**Refused 2026-10-02 by feature: no**\n");
  down(2); // plan 1, plan 2
  ctrlR();
  ctrlR();
  assert.ok(!read("PLANS.md").includes("Refused"));
  assert.match(keys.state().flash ?? "", /released plan #2: .* — still held \[blocked: requires Export series 1\/2\]/);
  assert.ok(!fs.existsSync(wakeRequestPath(root)));
});

test("backlog Ctrl+R twice releases a held-for-operator plan and wakes the plan role", () => {
  const { root, keys, down, ctrlR, read } = backlogReleaseRig(
    "## Planned\n\n### Held plan (planned 2026-10-01)\n\n**Needs review 2026-10-16 by feature: too large for one run (held 3)**\n\n**Previously held 2**\n",
  );
  down(1); // the held plan
  ctrlR();
  assert.deepEqual(keys.state().releaseArmed, {
    kind: "plan",
    position: 1,
    title: "Held plan (planned 2026-10-01)",
  });
  assert.match(keys.state().flash ?? "", /press Ctrl\+R again/);
  ctrlR();
  const after = read("PLANS.md");
  assert.ok(!after.includes("Needs review") && !after.includes("Previously held 2"));
  assert.match(keys.state().flash ?? "", /released plan #1/);
  const marker = readJson(wakeRequestPath(root)) as { roles: string[] };
  assert.deepEqual(marker.roles, ["feature"]);
});

test("backlog Ctrl+R on a below-threshold Needs-review plan still says so and writes nothing", () => {
  const { root, keys, down, ctrlR, read } = backlogReleaseRig(
    "## Planned\n\n### Held plan (planned 2026-10-01)\n\n**Needs review 2026-10-16 by feature: too large for one run (held 2)**\n\n**Previously held 1**\n",
  );
  down(1); // the below-threshold plan
  ctrlR();
  assert.equal(keys.state().releaseArmed, null);
  assert.match(keys.state().flash ?? "", /carries no Refused, Waiting for the next failure, or held-for-operator note/);
  assert.ok(read("PLANS.md").includes("Needs review") && read("PLANS.md").includes("Previously held 1"));
  assert.ok(!fs.existsSync(wakeRequestPath(root)));
});

test("backlog Ctrl+V on a still-held plan says so", () => {
  const { keys, down, ctrlV } = backlogCancelRig(HELD_PLANS);
  down(2);
  ctrlV();
  assert.match(keys.state().flash ?? "", /to the top: .* — still held \[blocked: requires/);
});

test("backlog Ctrl+R on a note-less entry, question, or done row refuses, and budget mode blocks it", () => {
  const { root, keys, down, ctrlR, read, plans, bugs } = backlogReleaseRig();
  down(3); // plan 1, plan 2, bug 1 — bug #1 carries no note
  ctrlR();
  assert.equal(keys.state().releaseArmed, null);
  assert.match(keys.state().flash ?? "", /carries no Refused, Waiting for the next failure, or held-for-operator note/);
  assert.equal(read("BUGS.md"), bugs);
  down(2); // → the open question
  ctrlR();
  assert.equal(keys.state().releaseArmed, null);
  assert.match(keys.state().flash ?? "", /only a plan or open bug can be released here/);
  assert.equal(read("BUGS.md"), bugs);
  // the budget editor blocks release through the promptLineFree guard
  keys.handleKey(undefined, { name: "up" }); // back onto bug #2 (refused)
  ctrlR(); // arm
  assert.notEqual(keys.state().releaseArmed, null);
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  ctrlR();
  assert.equal(keys.state().releaseArmed, null);
  assert.equal(read("BUGS.md"), bugs);
  keys.handleKey(undefined, { ctrl: true, name: "b" }); // close the budget editor
  // a done plan row is read-only
  const withDone = plans + "\n## Done\n\n### Shipped (planned 2026-09-01, done 2026-10-06)\n\nbody\n";
  fs.writeFileSync(path.join(root, "PLANS.md"), withDone);
  keys.handleKey(undefined, { name: "down" });
  keys.handleKey(undefined, { name: "down" }); // → the done row
  ctrlR();
  assert.equal(keys.state().releaseArmed, null);
  assert.match(keys.state().flash ?? "", /a done plan, fixed bug or answered question is read-only/);
  assert.equal(read("PLANS.md"), withDone);
});

test("PgUp/PgDn page the Activity feed and return to the live tail", () => {
  const root = makeRoot();
  // 20 events; the 5-line budget leaves a 16-event page window — the feed shows rows =
  // eventBudget − 1 = 4 events under its tally line, so each page steps by 4.
  writeEvents(
    root,
    Array.from({ length: 20 }, (_, i) => ({
      ts: 1_700_000_000_000 + i * 60_000,
      loop: "clean", // retired-name-ok: legacy event field in a fixture
      type: "run_start",
      run: i + 1,
    })),
  );
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  keys.setLineBudgets(5, 4);
  assert.equal(keys.state().view, 0, "starts on Activity");
  assert.equal(keys.state().activityScroll, null, "Activity follows the live tail by default");

  keys.handleKey(undefined, { name: "pageup" });
  assert.equal(keys.state().activityScroll, 12, "PgUp pauses follow and pages back one page");
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { name: "pageup" });
  assert.equal(keys.state().activityScroll, 0, "PgUp clamps at the oldest loaded event");

  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().activityScroll, 4, "PgDn advances one page");
  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().activityScroll, 8);
  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().activityScroll, 12);
  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().activityScroll, null, "reaching the tail re-enables follow");

  // Cycling away and back starts at the live tail again.
  keys.handleKey(undefined, { name: "pageup" });
  assert.equal(keys.state().activityScroll, 12);
  for (let i = 0; i < 9; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 0, "nine cycles with no roles wrap back to Activity");
  assert.equal(keys.state().activityScroll, null, "re-entering Activity follows the live tail");
});

test("the Activity feed pages nowhere when the log fits the pane", () => {
  const root = makeRoot();
  writeEvents(
    root,
    Array.from({ length: 3 }, (_, i) => ({ ts: 1_700_000_000_000 + i, type: "run_start", run: i + 1 })),
  );
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  keys.setLineBudgets(5, 4);
  keys.handleKey(undefined, { name: "pageup" });
  assert.equal(keys.state().activityScroll, null, "PgUp with no older events stays on the tail");
  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().activityScroll, null, "PgDn likewise");
});

test("Ctrl+G on the Activity view cycles the raw roster ids and filters the paging total", () => {
  const root = makeRoot();
  // Twelve events per role: the unfiltered tail pages, and so does each role's own set.
  writeEvents(root, [
    ...Array.from({ length: 12 }, (_, i) => ({ ts: 1_700_000_000_000 + i * 60_000, loop: "feature", type: "run_start", run: i + 1 })), // retired-name-ok: legacy event field in a fixture
    ...Array.from({ length: 12 }, (_, i) => ({ ts: 1_700_000_700_000 + i * 60_000, loop: "clean", type: "run_start", run: i + 1 })), // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "clean"]);
  keys.setLineBudgets(5, 4);
  assert.equal(keys.state().activityRole, null, "Activity opens team-wide");

  // The unfiltered total is 24 and each role's own is 12, so PgUp's clamped offset proves
  // which filtered list the handler paged over (24 − 4 = 20 vs 12 − 4 = 8): the feed shows
  // rows = eventBudget − 1 = 4 events under its tally line, so each page steps by 4 too.
  keys.handleKey(undefined, { name: "pageup" });
  assert.equal(keys.state().activityScroll, 16, "the team-wide read pages over all 24 events");
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().activityRole, "feature", "the first Ctrl+G scopes to the first raw roster id");
  assert.equal(keys.state().activityScroll, null, "a filter change resets the pane to the live tail");
  keys.handleKey(undefined, { name: "pageup" });
  assert.equal(keys.state().activityScroll, 4, "paging now clamps over feature's 12 events only");

  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().activityRole, "clean", "the cycle walks each raw roster id in turn");
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().activityRole, null, "the cycle wraps back to the team");

  // A roster that drops the scoped id clears the scope; the scroll resets with it.
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // → feature
  keys.handleKey(undefined, { name: "pageup" });
  keys.syncSnapshot(0, false, ["clean"]);
  assert.equal(keys.state().activityRole, null, "a roster drop clears the stale activity scope");
  assert.equal(keys.state().activityScroll, null, "...and the offset over the old filtered list");
});

test("Ctrl+O on the Activity view cycles the present event types and filters the paging total", () => {
  const root = makeRoot();
  // Two roles, three present types: `feature` carries run_start and run_end, `clean` only
  // wake, so a team-wide cycle turns over all three while the feature scope holds two.
  writeEvents(root, [
    ...Array.from({ length: 12 }, (_, i) => ({ ts: 1_700_000_000_000 + i * 60_000, loop: "feature", type: "run_start", run: i + 1 })), // retired-name-ok: legacy event field in a fixture
    ...Array.from({ length: 12 }, (_, i) => ({ ts: 1_700_000_700_000 + i * 60_000, loop: "feature", type: "run_end", run: i + 1, result: "changed" })), // retired-name-ok: legacy event field in a fixture
    ...Array.from({ length: 12 }, (_, i) => ({ ts: 1_700_001_400_000 + i * 60_000, loop: "clean", type: "wake", run: i + 1 })), // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "clean"]);
  keys.setLineBudgets(5, 4);
  assert.equal(keys.state().activityType, null, "Activity opens on every type");

  // The unfiltered total is 36 and each type's own is 12, so PgUp's clamped offset proves
  // which filtered list the handler paged over (36 − 4 = 32 → pages back to 28 vs 12 − 4 = 8
  // → back to 4): the feed shows rows = eventBudget − 1 = 4 events under its tally line, so
  // each page steps by 4 too.
  keys.handleKey(undefined, { name: "pageup" });
  assert.equal(keys.state().activityScroll, 28, "every-type read pages over all 36 events");
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().activityType, "run_end", "the first Ctrl+O selects the first present type in the sorted cycle");
  assert.equal(keys.state().activityScroll, null, "a type change resets the pane to the live tail");
  keys.handleKey(undefined, { name: "pageup" });
  assert.equal(keys.state().activityScroll, 4, "paging now clamps over run_end's 12 events only");
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().activityType, "run_start", "the cycle walks each present type in turn");
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().activityType, "wake", "the cycle keeps walking once a type is selected");
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().activityType, null, "the cycle wraps back to every type");

  // The present-type cycle is built from the pre-type scope: scoping to feature (run_start
  // and run_end only) drops wake from the slots.
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // → feature
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().activityType, "run_end", "inside the feature scope the first present type is run_end");
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().activityType, "run_start", "then run_start");
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().activityType, null, "then wrap back to every type, still scoped to feature");

  // A type survives a Ctrl+G scope change (the composed filter, like CLI --role+--type).
  keys.handleKey(undefined, { ctrl: true, name: "o" }); // → run_end within feature
  assert.equal(keys.state().activityType, "run_end");
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // → clean
  assert.equal(keys.state().activityType, "run_end", "the type survives a role-scope change");
  assert.equal(keys.state().activityScroll, null, "the scope change still resets the tail");
});

test("the `/` search filters the Activity feed and clears on an empty line", () => {
  const root = makeRoot();
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "feature", type: "run_end", run: 1, result: "changed", summary: "widget landed" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_060_000, loop: "clean", type: "run_end", run: 2, result: "changed", summary: "gizmo swept" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "clean"]);
  keys.setLineBudgets(5, 4);
  assert.equal(keys.state().view, 0, "starts on Activity");
  assert.equal(keys.state().activityGrep, null, "Activity opens unsearched");

  // `/` opens on the empty line and Enter applies the typed text.
  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "", "an empty search opens blank");
  for (const ch of "widget") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().activityGrep, "widget");
  assert.equal(keys.state().input, "", "a successful apply restores the director draft");
  assert.equal(keys.state().flash, 'search: "widget"');
  assert.equal(keys.state().activityScroll, null, "applying a search resets the pane to the live tail");

  // Re-opening pre-fills the applied pattern; Esc cancels without changing it.
  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "widget", "re-opening pre-fills the applied pattern");
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().activityGrep, "widget", "Esc leaves the applied pattern unchanged");
  assert.equal(keys.state().input, "", "Esc restores the pre-search draft");

  // An empty line clears the search.
  keys.handleKey("/", { name: "/" });
  keys.handleKey(undefined, { ctrl: true, name: "u" });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().activityGrep, null, "an empty line clears the search");
  assert.equal(keys.state().flash, "search cleared");
});

test("the Activity and History `/` searches are independent, and `/` elsewhere types into the prompt", () => {
  const root = makeRoot();
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "feature", type: "run_end", run: 1, result: "changed", summary: "widget landed" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature"]);
  keys.setLineBudgets(5, 4);

  // Off Activity and History, `/` types into the prompt as before.
  for (let i = 0; i < 3; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage (roleIds.length + 2 = 3)
  assert.equal(keys.state().view, 3);
  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "/", "`/` on Usage types into the prompt");
  keys.handleKey(undefined, { ctrl: true, name: "u" });

  // Search History; the target is the History pattern, not Activity's.
  for (let i = 0; i < 2; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history (roleIds.length + 4 = 5)
  assert.equal(keys.state().view, 5, "History is roleIds.length + 4");
  keys.handleKey("/", { name: "/" });
  for (const ch of "clean") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().historyGrep, "clean");
  assert.equal(keys.state().activityGrep, null, "the History search does not touch the Activity filter");

  // Back on Activity, `/` opens Activity's own pattern, not History's.
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → pending → queued → health → brief → activity
  assert.equal(keys.state().view, 0);
  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "", "the Activity search opens with no Activity pattern yet");
  for (const ch of "widget") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().activityGrep, "widget");
  assert.equal(keys.state().historyGrep, "clean", "the Activity search does not touch the History filter");
});

test("the `/` search filters the viewed role's live transcript, stays off the notes step, and clears on Ctrl+T", () => {
  const root = makeRoot();
  writeFileDeep(roleNotesPath(root, "feature"), "a note\n");
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "clean"]);
  keys.setLineBudgets(5, 4);
  const key = (str: string | undefined, k: { ctrl?: boolean; name?: string }) => keys.handleKey(str, k);
  key(undefined, { ctrl: true, name: "t" }); // → feature transcript (view 1)
  assert.equal(keys.state().view, 1);
  assert.equal(keys.state().transcriptGrep, null);

  key("/", { name: "/" });
  assert.equal(keys.state().input, "", "the Transcript search opens blank");
  for (const ch of "Turn") key(ch, { name: ch });
  key(undefined, { name: "return" });
  assert.equal(keys.state().transcriptGrep, "Turn");
  assert.equal(keys.state().flash, 'search: "Turn"');
  assert.equal(keys.state().input, "");

  key("/", { name: "/" });
  assert.equal(keys.state().input, "Turn", "reopening pre-fills the applied pattern");
  key(undefined, { name: "escape" });
  assert.equal(keys.state().transcriptGrep, "Turn");

  key(undefined, { ctrl: true, name: "n" }); // → notes
  assert.equal(keys.state().noteMode, true);
  key("/", { name: "/" });
  assert.equal(keys.state().input, "/", "`/` on the notes step types into the prompt");
  assert.equal(keys.state().transcriptGrep, "Turn");
  key(undefined, { ctrl: true, name: "u" });
  key(undefined, { ctrl: true, name: "n" }); // → change
  key(undefined, { ctrl: true, name: "n" }); // → transcript
  assert.equal(keys.state().noteMode, false);
  assert.equal(keys.state().changeMode, false);
  assert.equal(keys.state().transcriptGrep, "Turn");

  key("/", { name: "/" });
  key(undefined, { ctrl: true, name: "u" });
  key(undefined, { name: "return" });
  assert.equal(keys.state().transcriptGrep, null);
  assert.equal(keys.state().flash, "search cleared");

  key("/", { name: "/" });
  key("x", { name: "x" });
  key(undefined, { name: "return" });
  assert.equal(keys.state().transcriptGrep, "x");
  key(undefined, { ctrl: true, name: "t" }); // → clean (view 2)
  assert.equal(keys.state().view, 2);
  assert.equal(keys.state().transcriptGrep, null);
});

test("the `/` search filters the Backlog pane's active entries, clears, and persists across view cycling", () => {
  const root = makeRoot();
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    "## Planned\n\n### Volume slider (planned 2026-10-02 by test)\n\nbody\n\n### Widget (planned 2026-10-02 by test)\n\nbody\n",
  );
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  keys.setLineBudgets(10, 4);
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → backlog (roleIds.length+1 = 1)
  assert.equal(keys.state().view, 1);
  assert.equal(keys.state().backlogGrep, null, "the Backlog pane opens unsearched");

  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "", "an empty Backlog search opens blank");
  for (const ch of "volume") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().backlogGrep, "volume");
  assert.equal(keys.state().selectedEntry, null, "applying a search clears the selection to list mode");
  assert.equal(keys.state().flash, 'search: "volume"');

  // Up/down step only through the matching entry (Volume slider is the only match).
  keys.handleKey(undefined, { name: "down" });
  assert.equal(keys.state().selectedEntry, 0, "Down opens the first matching entry");
  keys.handleKey(undefined, { name: "down" });
  assert.equal(keys.state().selectedEntry, 0, "a single match steps nowhere");

  // Re-opening pre-fills the applied pattern; Esc leaves it unchanged.
  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "volume", "re-opening pre-fills the applied pattern");
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().backlogGrep, "volume", "Esc leaves the applied pattern unchanged");
  assert.equal(keys.state().input, "", "Esc restores the pre-search draft");

  // Cycling away and back keeps the applied search (the selection drops, the pattern stays).
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage (view 2)
  assert.equal(keys.state().selectedEntry, null, "cycling away drops the selection");
  assert.equal(keys.state().backlogGrep, "volume", "cycling away keeps the applied pattern");
  for (let i = 0; i < 8; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → back to backlog (view 1)
  assert.equal(keys.state().view, 1);
  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "volume", "returning reopens the search pre-filled");
  keys.handleKey(undefined, { name: "escape" });

  // An empty line clears the search.
  keys.handleKey("/", { name: "/" });
  keys.handleKey(undefined, { ctrl: true, name: "u" });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().backlogGrep, null, "an empty line clears the search");
  assert.equal(keys.state().flash, "search cleared");

  // Off Backlog, `/` types into the prompt: it is not a search view.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage (view 2)
  assert.equal(keys.state().view, 2);
  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "/", "`/` on a non-search view types into the prompt");
});

test("Ctrl+T cycles on through Usage and Failures to History, which caches and pages the run rows", () => {
  const root = makeRoot();
  // Twelve completed runs so the history pane's rows overflow the pane budget and page.
  writeEvents(
    root,
    Array.from({ length: 12 }, (_, i) => ({
      ts: 1_700_000_000_000 + i * 60_000,
      loop: "feature", // retired-name-ok: legacy event field in a fixture
      type: "run_end",
      run: i + 1,
      result: "changed",
    })),
  );
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  keys.setLineBudgets(5, 4);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage → failures → history
  assert.equal(keys.state().view, 4, "History is the last view (roleIds.length + 4)");
  assert.match(keys.state().paneCache ?? "", /feature #12/, "the newest run's row is cached for the pane");
  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().paneScroll, 5, "PgDn advances the history window by the event budget");
  keys.handleKey(undefined, { name: "pageup" });
  assert.equal(keys.state().paneScroll, 0, "PgUp clamps back to the head");
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 5, "Pending follows History (roleIds.length + 5)");
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 6, "Queued follows Pending (roleIds.length + 6)");
  assert.equal(keys.state().paneCache, "", "an empty queue caches the empty list, not null");
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 7, "Health follows Queued (roleIds.length + 7)");
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 8, "Brief follows Health (roleIds.length + 8)");
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 0, "cycling past Brief wraps to Activity");
  assert.equal(keys.state().paneCache, null, "leaving History, Pending, and Queued drops the cache");
});

test("Ctrl+N on the History pane swaps the rows for the newest completed run's trail", () => {
  const root = makeRoot();
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "clean", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_060_000, loop: "clean", type: "run_end", run: 1, result: "changed", summary: "work" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean"]);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history (roleIds.length + 4)
  assert.equal(keys.state().view, 5);
  assert.equal(keys.state().trailMode, false, "History opens on the rows");
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().trailMode, true);
  assert.equal(keys.state().trailCache, renderRunDetail(readRunDetail(root, "clean", 1)!));
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().trailMode, false, "a second Ctrl+N returns to the rows");
  assert.equal(keys.state().trailCache, null);

  // Cycling the view away drops the trail snapshot too.
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().trailMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().trailMode, false);
  assert.equal(keys.state().trailCache, null);
});

function historyTrailRoot(): string {
  const root = makeRoot();
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "clean", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_060_000, loop: "clean", type: "run_end", run: 1, result: "changed", summary: "work" }, // retired-name-ok: legacy event field in a fixture
  ]);
  return root;
}

function openHistory(keys: ReturnType<typeof makeKeys>["keys"]): void {
  keys.syncSnapshot(0, false, ["clean"]);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
}

function writeTrailPiLog(root: string): void {
  const lines = [
    { type: "tumwater_run", kind: "author", agent: "pi", ts: 1_700_000_010_000 },
    { type: "agent_start" },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "asked-one" }], timestamp: 1_700_000_010_000 } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "said-one" }], timestamp: 1_700_000_010_000 } },
  ];
  writeFileDeep(piLogPath(root, "clean"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("Ctrl+R on the History trail cycles the agent transcript off, plain, prompts, off", () => {
  const root = historyTrailRoot();
  writeTrailPiLog(root);
  const { keys } = makeKeys(root, () => 0, () => new Promise<string>(() => {}));
  openHistory(keys);
  const rows = keys.state();
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.deepEqual(keys.state(), rows, "Ctrl+R on the rows changes nothing");
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  const detail = readRunDetail(root, "clean", 1)!;
  const bare = renderRunDetail(detail);
  assert.equal(keys.state().trailTranscript, "off");
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().trailTranscript, "plain");
  const plain = runTranscriptLines(root, "clean", 1, detail).found;
  assert.ok(plain.length > 0 && plain.join("\n").includes("said-one"));
  assert.equal(keys.state().trailCache, `${bare}\n\n${plain.join("\n")}`);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().trailTranscript, "prompts");
  const withPrompts = runTranscriptLines(root, "clean", 1, detail, { includePrompts: true }).found;
  assert.equal(keys.state().trailCache, `${bare}\n\n${withPrompts.join("\n")}`);
  assert.ok(withPrompts.length > plain.length);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().trailTranscript, "off");
  assert.equal(keys.state().trailCache, bare);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().trailTranscript, "off", "leaving and re-entering the trail starts bare");
});

const REVERT_SHA = "a".repeat(40);

function revertRoot(result: "merged" | "changed"): string {
  const root = makeRoot();
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "clean", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_050_000, source: "clean", type: "merge_done", run: 1, commit: REVERT_SHA },
    { ts: 1_700_000_060_000, loop: "clean", type: "run_end", run: 1, result, summary: "work" }, // retired-name-ok: legacy event field in a fixture
  ]);
  return root;
}

type PreviewResult = Awaited<ReturnType<typeof previewRevert>>;

/** Keys on a History trail with preview/revert fakes that record calls and resolve on demand. */
function revertRig(result: "merged" | "changed" = "merged", trail = true) {
  const root = revertRoot(result);
  const previews: Array<(r: PreviewResult) => void> = [];
  const previewCalls: string[] = [];
  const revertCalls: string[] = [];
  const reverts: Array<() => void> = [];
  const { keys } = makeKeys(root, () => 0, undefined, {
    previewRevert: (_root, ref) => new Promise((resolve) => { previewCalls.push(ref); previews.push(resolve); }),
    revertCommit: (_root, ref) => new Promise((resolve) => {
      revertCalls.push(ref);
      reverts.push(() => resolve({ ok: true, headSha: "b".repeat(40), beforeSha: "c".repeat(40), subject: "tumwater(clean): Tidy" }));
    }),
  });
  openHistory(keys);
  if (trail) keys.handleKey(undefined, { ctrl: true, name: "n" });
  const ctrlV = (): void => keys.handleKey(undefined, { ctrl: true, name: "v" });
  const okPreview = (over: Record<string, unknown> = {}): PreviewResult =>
    ({ ok: true, sha: REVERT_SHA, subject: "tumwater(clean): Tidy", paths: ["a.txt"], head: "d".repeat(40), primary: "main", applies: true, dirty: false, ...over });
  return { keys, previews, previewCalls, revertCalls, reverts, ctrlV, okPreview };
}

test("Ctrl+V twice on a History trail previews then reverts the run's merged commit", async () => {
  const r = revertRig();
  r.ctrlV();
  assert.deepEqual(r.previewCalls, [REVERT_SHA]);
  assert.match(r.keys.state().flash ?? "", /previewing/);
  r.previews[0]!(r.okPreview());
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(r.keys.state().flash ?? "", /press Ctrl\+V again/);
  r.ctrlV();
  assert.deepEqual(r.revertCalls, [REVERT_SHA]);
  r.reverts[0]!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(r.keys.state().flash ?? "", /main is now/);
});

test("a key between the two Ctrl+V presses disarms the revert", async () => {
  const r = revertRig();
  r.ctrlV();
  r.previews[0]!(r.okPreview());
  await new Promise((resolve) => setImmediate(resolve));
  r.keys.handleKey(undefined, { name: "pagedown" });
  r.ctrlV();
  assert.equal(r.previewCalls.length, 2);
  assert.deepEqual(r.revertCalls, []);
});

test("a conflicting or dirty preview never arms", async () => {
  const r = revertRig();
  r.ctrlV();
  r.previews[0]!(r.okPreview({ applies: false }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(r.keys.state().flash ?? "", /would conflict/);
  r.ctrlV();
  r.previews[1]!(r.okPreview({ dirty: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(r.keys.state().flash ?? "", /staged or unstaged/);
  r.ctrlV();
  assert.equal(r.previewCalls.length, 3);
  assert.deepEqual(r.revertCalls, []);
});

test("Ctrl+V on an unmerged run's trail flashes the CLI's refusal", () => {
  const r = revertRig("changed");
  r.ctrlV();
  assert.match(r.keys.state().flash ?? "", /did not merge/);
  assert.deepEqual([r.previewCalls, r.revertCalls], [[], []]);
});

test("Ctrl+V off a History trail never reverts", () => {
  const r = revertRig("merged", false);
  r.ctrlV();
  assert.match(r.keys.state().flash ?? "", /Ctrl\+N/);
  assert.deepEqual([r.previewCalls, r.revertCalls], [[], []]);
});

test("Ctrl+R on a run with no transcript segment shows the note", () => {
  const root = historyTrailRoot();
  const { keys } = makeKeys(root, () => 0, () => new Promise<string>(() => {}));
  openHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  const note = runTranscriptLines(root, "clean", 1, readRunDetail(root, "clean", 1)!).note;
  assert.ok((keys.state().trailCache ?? "").endsWith(`\n\n${note}`));
});

test("the History trail composes detail, stat, then transcript whichever finishes first", async () => {
  const root = historyTrailRoot();
  writeTrailPiLog(root);
  let resolve!: (s: string) => void;
  const { keys } = makeKeys(root, () => 0, () => new Promise<string>((r) => (resolve = r)));
  openHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  resolve(" a.ts | 1 +");
  await new Promise((r) => setImmediate(r));
  const detail = readRunDetail(root, "clean", 1)!;
  const plain = runTranscriptLines(root, "clean", 1, detail).found.join("\n");
  assert.equal(keys.state().trailCache, `${renderRunDetail(detail)}\n\n a.ts | 1 +\n\n${plain}`);
});

test("the History trail appends the run commit's stat once it resolves", async () => {
  const root = historyTrailRoot();
  let resolve!: (s: string) => void;
  const { keys, renders } = makeKeys(root, () => 0, () => new Promise<string>((r) => (resolve = r)));
  openHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  const plain = renderRunDetail(readRunDetail(root, "clean", 1)!);
  assert.equal(keys.state().trailCache, plain, "the trail shows at once, before the stat");
  const before = renders();
  resolve(" a.ts | 1 +");
  await new Promise((r) => setImmediate(r));
  assert.equal(keys.state().trailCache, `${plain}\n\n a.ts | 1 +`);
  assert.ok(renders() > before, "the resolution requests a render");
});

test("a late stat never overwrites a trail that was exited or re-read", async () => {
  const root = historyTrailRoot();
  const resolves: Array<(s: string) => void> = [];
  const { keys } = makeKeys(root, () => 0, () => new Promise<string>((r) => resolves.push(r)));
  openHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // exit
  resolves[0]!("late");
  await new Promise((r) => setImmediate(r));
  assert.equal(keys.state().trailCache, null);

  keys.handleKey(undefined, { ctrl: true, name: "n" }); // re-enter
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // re-read
  const plain = keys.state().trailCache;
  resolves[1]!("stale");
  await new Promise((r) => setImmediate(r));
  assert.equal(keys.state().trailCache, plain, "the first read's stat is dropped");
  resolves[2]!("fresh");
  await new Promise((r) => setImmediate(r));
  assert.match(keys.state().trailCache ?? "", /fresh$/);
});

test("a rejecting stat leaves the plain trail and flashes", async () => {
  const root = historyTrailRoot();
  const { keys } = makeKeys(root, () => 0, () => Promise.reject(new Error("git exploded")));
  openHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  await new Promise((r) => setImmediate(r));
  assert.equal(keys.state().trailMode, true);
  assert.equal(keys.state().trailCache, renderRunDetail(readRunDetail(root, "clean", 1)!));
  assert.match(keys.state().flash!, /git exploded/);
});

test("Ctrl+N on an empty History flashes and leaves the rows shown", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean"]);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().trailMode, false);
  assert.match(keys.state().flash!, /no completed runs to inspect/);
});

test("Ctrl+G while a trail is shown re-reads the new scope's newest run", () => {
  const root = makeRoot();
  // clean's run is newer than qa's, so the team read and the qa-scoped read differ.
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "qa", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_060_000, loop: "qa", type: "run_end", run: 1, result: "changed", summary: "qa work" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_120_000, loop: "clean", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_180_000, loop: "clean", type: "run_end", run: 1, result: "changed", summary: "clean work" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean", "qa"]);
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history (roleIds.length + 4)
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // team → clean
  assert.equal(keys.state().historyRole, "clean");
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.match(keys.state().trailCache ?? "", /clean work/);
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // clean → qa
  assert.equal(keys.state().historyRole, "qa");
  assert.match(keys.state().trailCache ?? "", /qa work/, "the trail follows the new scope");
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // qa → team
  assert.equal(keys.state().historyRole, null);
  assert.match(keys.state().trailCache ?? "", /clean work/, "the team trail is the newest run of any role");
});

function steppingRoot(): string {
  const root = makeRoot();
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "clean", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_060_000, loop: "clean", type: "run_end", run: 1, result: "changed", summary: "clean one" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_120_000, loop: "qa", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_180_000, loop: "qa", type: "run_end", run: 1, result: "changed", summary: "qa work" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_240_000, loop: "clean", type: "run_start", run: 2 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_300_000, loop: "clean", type: "run_end", run: 2, result: "changed", summary: "clean two" }, // retired-name-ok: legacy event field in a fixture
  ]);
  return root;
}

function openSteppingHistory(keys: ReturnType<typeof makeKeys>["keys"]): void {
  keys.syncSnapshot(0, false, ["clean", "qa"]);
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
}

test("Ctrl+P steps the trail back through the scope's runs and wraps to the newest", () => {
  const root = steppingRoot();
  const { keys } = makeKeys(root, () => 0);
  openSteppingHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // team → clean
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.match(keys.state().trailCache ?? "", /clean two/);
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  assert.equal(keys.state().trailCache, renderRunDetail(readRunDetail(root, "clean", 1)!));
  assert.equal(keys.state().trailIndex, 1);
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  assert.equal(keys.state().trailIndex, 0);
  assert.match(keys.state().trailCache ?? "", /clean two/);
  assert.match(keys.state().flash!, /oldest run reached/);
});

test("Ctrl+P on a team-scoped trail steps from the newest run to the next one", () => {
  const { keys } = makeKeys(steppingRoot(), () => 0);
  openSteppingHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.match(keys.state().trailCache ?? "", /clean two/);
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  assert.match(keys.state().trailCache ?? "", /qa work/);
});

test("Ctrl+P with the trail off does nothing, and Ctrl+N or Ctrl+G after it start from the newest", () => {
  const { keys } = makeKeys(steppingRoot(), () => 0);
  openSteppingHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  assert.equal(keys.state().trailMode, false);
  assert.equal(keys.state().trailCache, null);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // off
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // on again
  assert.equal(keys.state().trailIndex, 0);
  assert.match(keys.state().trailCache ?? "", /clean two/);
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // team → clean
  assert.equal(keys.state().trailIndex, 0);
  assert.match(keys.state().trailCache ?? "", /clean two/);
});

function filterRoot(): string {
  const root = makeRoot();
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "clean", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_060_000, loop: "clean", type: "run_end", run: 1, result: "failed", summary: "clean broke" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_120_000, loop: "qa", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_180_000, loop: "qa", type: "run_end", run: 1, result: "changed", summary: "qa work" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_240_000, loop: "clean", type: "run_start", run: 2 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_300_000, loop: "clean", type: "run_end", run: 2, result: "changed", summary: "clean two" }, // retired-name-ok: legacy event field in a fixture
  ]);
  return root;
}

function pressResultUntil(keys: ReturnType<typeof makeKeys>["keys"], label: string): void {
  for (let i = 0; i < 6 && keys.state().historyResult !== label; i++) keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().historyResult, label);
}

test("Ctrl+N under a result filter opens the newest matching run, and Ctrl+P wraps within them", () => {
  const root = filterRoot();
  const { keys } = makeKeys(root, () => 0);
  openSteppingHistory(keys);
  pressResultUntil(keys, "problems");
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().trailCache, renderRunDetail(readRunDetail(root, "clean", 1)!));
  assert.equal(keys.state().trailIndex, 0);
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  assert.equal(keys.state().trailCache, renderRunDetail(readRunDetail(root, "clean", 1)!));
  assert.match(keys.state().flash!, /oldest run reached/);
});

test("changing the result filter with the trail on re-reads it, and an empty class clears it", () => {
  const root = filterRoot();
  const { keys } = makeKeys(root, () => 0);
  openSteppingHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.match(keys.state().trailCache ?? "", /clean two/);
  pressResultUntil(keys, "problems");
  assert.equal(keys.state().trailCache, renderRunDetail(readRunDetail(root, "clean", 1)!));
  pressResultUntil(keys, "refused");
  assert.equal(keys.state().trailMode, true);
  assert.equal(keys.state().trailCache, null);
});

test("a History search with the trail on narrows the trail and Ctrl+P stays inside it", () => {
  const root = filterRoot();
  const { keys } = makeKeys(root, () => 0);
  openSteppingHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey("/", { name: "/" });
  for (const ch of "qa work") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.match(keys.state().trailCache ?? "", /qa work/);
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  assert.match(keys.state().trailCache ?? "", /qa work/);
  assert.doesNotMatch(keys.state().trailCache ?? "", /clean/);
});

test("Ctrl+N on a filter that matches nothing flashes the filter note and leaves the rows", () => {
  const { keys } = makeKeys(filterRoot(), () => 0);
  openSteppingHistory(keys);
  pressResultUntil(keys, "refused");
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().trailMode, false);
  assert.match(keys.state().flash!, /match the pane's filters/);
});

test("a late stat from the run Ctrl+P left does not overwrite the stepped-to trail", async () => {
  const root = steppingRoot();
  const resolves: Array<(s: string) => void> = [];
  const { keys } = makeKeys(root, () => 0, () => new Promise<string>((r) => resolves.push(r)));
  openSteppingHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  const stepped = keys.state().trailCache;
  resolves[0]!("stale");
  await new Promise((r) => setImmediate(r));
  assert.equal(keys.state().trailCache, stepped);
  resolves[1]!("fresh");
  await new Promise((r) => setImmediate(r));
  assert.match(keys.state().trailCache ?? "", /fresh$/);
});

test("a roster change that retires the trail's scope re-reads it from the team", () => {
  const root = makeRoot();
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "qa", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_060_000, loop: "qa", type: "run_end", run: 1, result: "changed", summary: "qa work" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_120_000, loop: "clean", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_180_000, loop: "clean", type: "run_end", run: 1, result: "changed", summary: "clean work" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean", "qa"]);
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history (roleIds.length + 4)
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // team → clean
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // clean → qa
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.match(keys.state().trailCache ?? "", /qa work/);
  keys.syncSnapshot(0, false, ["clean"]); // qa retires
  assert.equal(keys.state().historyRole, null, "the retired scope drops to the team");
  assert.equal(keys.state().trailMode, true, "the trail stays on screen");
  assert.match(keys.state().trailCache ?? "", /clean work/, "the trail follows the retired scope's drop");
});

test("Ctrl+G cycles the report scope and recomputes the Usage and Failures cache", () => {
  const root = makeRoot();
  // One failed feature run with tokens: it lands in the usage report's totals and the
  // failure digest's per-role table, so scoping to clean changes both renders.
  writeEvents(root, [
    { ts: Date.now(), loop: "feature", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: Date.now(), loop: "feature", type: "run_end", run: 1, result: "error", tokens: 500, costUsd: 0.5 }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "clean"]);
  assert.equal(keys.state().scopeRole, null, "a fresh TUI starts team-wide");

  // Off a report view the key only moves the scope; no cache is computed. (View 0 and a
  // role's Transcript now own their Ctrl+G — the Activity feed scope and the instances editor —
  // so start from a Backlog view, where Ctrl+G still falls through to the report scope.)
  for (let i = 0; i < 3; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → backlog (view 3)
  assert.equal(keys.state().view, 3);
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().scopeRole, "feature");
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().scopeRole, "clean");
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().scopeRole, null, "the cycle wraps back to the team");

  // Usage: each press recomputes the cached Markdown, and the scoped text differs.
  for (let i = 0; i < 1; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage
  assert.equal(keys.state().view, 4);
  const teamUsage = keys.state().paneCache;
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // → feature
  assert.equal(keys.state().scopeRole, "feature");
  const featureUsage = keys.state().paneCache;
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // → clean
  assert.equal(keys.state().scopeRole, "clean");
  const cleanUsage = keys.state().paneCache;
  assert.notEqual(featureUsage, teamUsage, "the feature-scoped usage cache differs from the team-wide one");
  assert.notEqual(cleanUsage, teamUsage, "the clean-scoped usage cache differs from the team-wide one");

  // Failures under the same clean scope caches a digest unlike the team-wide one.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → failures (view 5), scope clean
  assert.equal(keys.state().view, 5);
  const cleanFailures = keys.state().paneCache;
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // clean → team
  assert.equal(keys.state().scopeRole, null);
  assert.notEqual(cleanFailures, keys.state().paneCache, "the scoped failure digest differs from the team-wide one");
});

test("Ctrl+G cycles base roles only, so an instance id never labels another scope's body", () => {
  const root = makeRoot();
  // One failed feature run with tokens, so the Usage body carries the collected `role` line.
  writeEvents(root, [
    { ts: Date.now(), loop: "feature", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: Date.now(), loop: "feature", type: "run_end", run: 1, result: "error", tokens: 500, costUsd: 0.5 }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  // The roster names an instance; the scoped collectors fold it into `feature`.
  keys.syncSnapshot(0, false, ["feature", "feature-2"]);

  // Off a report view the key only moves the scope. (View 0 and a role's Transcript now own
  // their Ctrl+G — the Activity feed scope and the instances editor — so start from a Backlog
  // view, where Ctrl+G still falls through to the report scope.)
  for (let i = 0; i < 3; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → backlog (view 3)
  assert.equal(keys.state().view, 3);
  const seen: Array<string | null> = [];
  for (let i = 0; i < 2; i++) {
    keys.handleKey(undefined, { ctrl: true, name: "g" });
    seen.push(keys.state().scopeRole);
  }
  assert.deepEqual(seen, ["feature", null], "feature-2 collects feature's body, so the cycle skips it");

  // On the Usage pane the tab-strip scope and the collected body's own `role:` name agree.
  for (let i = 0; i < 1; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage
  assert.equal(keys.state().view, 4);
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // team → feature
  assert.equal(keys.state().scopeRole, "feature");
  assert.match(keys.state().paneCache ?? "", /^role: feature$/m, "the scoped body names the role the scope shows");
});

test("Ctrl+G on the History view cycles the raw roster ids and recomputes the scoped cache", () => {
  const root = makeRoot();
  // One completed run per role, so each exact-role scope has its own row set: feature-2 is
  // a distinct scope, unlike the report panes' base-role aggregation.
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "feature", type: "run_end", run: 1, result: "changed" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_060_000, loop: "feature-2", type: "run_end", run: 1, result: "none" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_120_000, loop: "clean", type: "run_end", run: 1, result: "changed" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "feature-2", "clean"]);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history (roleIds.length + 4)
  assert.equal(keys.state().view, 7);
  assert.equal(keys.state().historyRole, null, "History opens team-wide");

  const team = keys.state().paneCache;
  assert.match(team ?? "", /feature #1/, "the team-wide read holds feature's row");
  assert.match(team ?? "", /feature-2 #1/, "...and the instance's row");

  const seen: Array<string | null> = [];
  const caches: Array<string | null> = [];
  for (let i = 0; i < 4; i++) {
    keys.handleKey(undefined, { ctrl: true, name: "g" });
    seen.push(keys.state().historyRole);
    caches.push(keys.state().paneCache);
  }
  assert.deepEqual(seen, ["feature", "feature-2", "clean", null], "the raw roster ids each get their own slot");
  assert.match(caches[0] ?? "", /^role: feature$/m, "the scoped cache names its role");
  assert.match(caches[0] ?? "", /feature #1/);
  assert.doesNotMatch(caches[0] ?? "", /feature-2/, "an instance's rows stay out of its base role's scope");
  assert.match(caches[1] ?? "", /feature-2 #1/);
  assert.notEqual(caches[0], team, "the feature-scoped cache differs from the team-wide one");
  assert.notEqual(caches[1], caches[0], "feature-2 is its own scope, unlike the report cycle");

  // Budget mode owns the prompt line: the History scope must not move.
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // → feature again
  assert.equal(keys.state().historyRole, "feature");
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().historyRole, "feature", "Ctrl+G is inert in budget mode");
  keys.handleKey(undefined, { name: "escape" });

  // Role-prompt mode owns it the same way; it opens from a transcript view, scope kept.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // history → pending
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // pending → queued
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // queued → health
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // health → brief
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // brief → activity
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // activity → transcript feature
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().rolePromptFor, "feature");
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().historyRole, "feature", "Ctrl+G is inert in role-prompt mode");
  keys.handleKey(undefined, { name: "escape" });

  // A roster that drops the scoped role clears the History scope.
  keys.syncSnapshot(0, false, ["clean"]);
  assert.equal(keys.state().historyRole, null, "a roster drop clears the stale history scope");
});

test("Ctrl+G on a Transcript is inert while an editor holds the prompt line, and opens once it is free", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(50, false, ["feature", "clean"]);
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature transcript
  assert.equal(keys.state().view, 1);

  // Budget mode owns the prompt line: Ctrl+G must not open the instances editor.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().instancesMode, false, "Ctrl+G is inert in budget mode");
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { name: "escape" });

  // Role-prompt mode owns it the same way.
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().rolePromptFor, "feature");
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().instancesMode, false, "Ctrl+G is inert in role-prompt mode");
  keys.handleKey(undefined, { name: "escape" });

  // With the line free, Ctrl+G opens the instances editor on the Transcript.
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().instancesMode, true, "Ctrl+G opens the instances editor once the line is free");
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().instancesMode, false);
});

test("syncSnapshot recomputes an on-screen report pane when it clears a retired scope", () => {
  const root = makeRoot();
  // A failed feature run with tokens: scoping to the team and to feature render differently.
  writeEvents(root, [
    { ts: Date.now(), loop: "feature", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: Date.now(), loop: "feature", type: "run_end", run: 1, result: "error", tokens: 500, costUsd: 0.5 }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "clean"]);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage
  const teamUsage = keys.state().paneCache;
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // → feature
  assert.notEqual(keys.state().paneCache, teamUsage, "the feature-scoped body differs from the team one");

  // A rename keeps the roster length but retires the scoped name: the scope drops and the
  // still-visible pane body must recompute team-wide to match the tab strip and hint.
  keys.syncSnapshot(0, false, ["feat", "clean"]);
  assert.equal(keys.state().scopeRole, null);
  assert.equal(keys.state().paneCache, teamUsage, "the pane body follows the cleared scope");
});

test("Ctrl+S cycles the History pane's trailing window, re-reads the rows, and resets the scroll", () => {
  const root = makeRoot();
  const now = Date.now();
  // One run 30 minutes old (inside 1h) and one three days old (only inside 7d).
  writeEvents(root, [
    { ts: now - 30 * 60_000, loop: "feature", type: "run_end", run: 1, result: "changed" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 3 * 24 * 60 * 60_000, loop: "feature", type: "run_end", run: 2, result: "changed" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => now);
  keys.syncSnapshot(0, false, []);
  keys.setLineBudgets(1, 1); // a one-line budget so the two rows can scroll
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  assert.equal(keys.state().view, 4, "History is roleIds.length + 4");
  assert.equal(keys.state().historySince, null, "History opens on the default window");
  assert.match(keys.state().paneCache ?? "", /feature #1/);
  assert.match(keys.state().paneCache ?? "", /feature #2/, "the default newest-N read carries both");
  assert.doesNotMatch(keys.state().paneCache ?? "", /window: last/);

  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().paneScroll, 1, "the seeded rows overflow the one-line budget");

  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, "1h");
  assert.match(keys.state().paneCache ?? "", /window: last 1h/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /result:/, "a window without an outcome filter names no result header");
  assert.match(keys.state().paneCache ?? "", /feature #1/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /feature #2/, "the 1h window drops the three-day-old run");
  assert.equal(keys.state().paneScroll, 0, "a window change re-enters the body at its head");

  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, "6h");
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, "1d");
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, "7d");
  assert.match(keys.state().paneCache ?? "", /feature #2/, "7d reaches the three-day-old run");
  assert.match(keys.state().paneCache ?? "", /oldest retained event/, "the 7d read hedges its coverage with the sparse-window note");
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, null, "the cycle wraps to the default window");
  assert.match(keys.state().paneCache ?? "", /feature #2/, "the default read carries both rows again");
});

test("Ctrl+S is inert in the prompt-line modes and off the History view only moves the label", () => {
  const root = makeRoot();
  writeEvents(root, [{ ts: Date.now() - 60_000, loop: "feature", type: "run_end", run: 1, result: "changed" }]); // retired-name-ok: legacy event field in a fixture
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean"]);

  // Activity (view 0) now owns Ctrl+S as the team-wide quiet-hours editor (docs/cli.md), so it
  // consumes Ctrl+S rather than advancing the History window.
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().quietTeam, true, "Ctrl+S on Activity opens the team quiet editor");
  assert.equal(keys.state().historySince, null, "the team editor consumed Ctrl+S, not the window");
  keys.handleKey(undefined, { name: "escape" }); // close the team editor

  // Role-prompt mode holds it too: open it on a transcript view and try Ctrl+S.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // events → transcript clean
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().rolePromptFor, "clean");
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, null, "Ctrl+S does nothing in role-prompt mode");
  keys.handleKey(undefined, { name: "escape" });

  // Off the History view, Ctrl+S advances the window without computing a cache — the pane arm
  // runs on any non-Activity, non-Transcript view; use the Backlog (view 2).
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // transcript → backlog
  assert.equal(keys.state().view, 2, "on the Backlog view");
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, "1h");
  assert.equal(keys.state().paneCache, null, "no History pane is showing");

  // Budget mode holds the prompt line: Ctrl+S leaves the window alone.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, "1h", "Ctrl+S does nothing in budget mode");
  keys.handleKey(undefined, { name: "escape" });
});

test("Ctrl+E cycles the Usage and Failures panes' trailing report window and resets the scroll", () => {
  const root = makeRoot();
  const now = Date.now();
  // One feature run 30 minutes old (inside 1h) and one three days old (only inside 7d), with
  // distinct token counts so the windowed usage totals name which runs they aggregated. Both
  // are errors so the failure digest's window run count names the same split.
  writeEvents(root, [
    { ts: now - 30 * 60_000, loop: "feature", type: "run_end", run: 1, result: "error", tokens: 100 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 3 * 24 * 60 * 60_000, loop: "feature", type: "run_end", run: 2, result: "error", tokens: 1_000_000 }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => now);
  keys.syncSnapshot(0, false, []);
  keys.setLineBudgets(1, 1); // a one-line budget so the report body can scroll
  for (let i = 0; i < 2; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage
  assert.equal(keys.state().view, 2, "Usage is roleIds.length + 2");
  assert.equal(keys.state().reportSince, null, "the report pane opens on the default day window");
  assert.match(keys.state().paneCache ?? "", /1\.0M/, "the default day report aggregates both runs");
  assert.match(keys.state().paneCache ?? "", /2 runs/);

  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().paneScroll, 1, "the usage body overflows the one-line budget");

  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, "1h");
  assert.match(keys.state().paneCache ?? "", /window: last 1h/);
  assert.match(keys.state().paneCache ?? "", /100 output tokens/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /1\.0M/, "the 1h window drops the three-day-old run's tokens");
  assert.equal(keys.state().paneScroll, 0, "a window change re-enters the body at its head");

  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, "6h");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, "1d");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, "7d");
  assert.match(keys.state().paneCache ?? "", /window: last 7d/);
  assert.match(keys.state().paneCache ?? "", /1\.0M/, "7d reaches the three-day-old run");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, null, "the cycle wraps to the default window");
  assert.match(keys.state().paneCache ?? "", /1\.0M/, "the default read aggregates both runs again");

  // Failures: the same Ctrl+E cycle over the digest, whose window line names its run count.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → failures
  assert.equal(keys.state().view, 3, "Failures is roleIds.length + 3");
  assert.equal(keys.state().reportSince, null, "the digest opens on the default day window");
  assert.match(keys.state().paneCache ?? "", /· 2 runs/, "the default digest aggregates both error runs");
  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().paneScroll, 1, "the digest body overflows the one-line budget");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, "1h");
  assert.match(keys.state().paneCache ?? "", /window: last 1h/);
  assert.match(keys.state().paneCache ?? "", /· 1 runs/, "the 1h digest drops the three-day-old error run");
  assert.equal(keys.state().paneScroll, 0, "a window change re-enters the digest at its head");
});

const CTRL = (name: string) => ({ ctrl: true, name });

function seedStepRoot(now: number) {
  const root = makeRoot();
  writeEvents(root, [
    { ts: now - 30 * 60_000, loop: "feature", type: "run_end", run: 1, result: "error", tokens: 100 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 90 * 60_000, loop: "feature", type: "run_end", run: 2, result: "error", tokens: 200 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 2.5 * 24 * 60 * 60_000, loop: "feature", type: "run_end", run: 3, result: "error", tokens: 300 }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => now);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 2; i++) keys.handleKey(undefined, CTRL("t")); // → usage
  return keys;
}

test("Ctrl+P on Usage steps the report window back one window length, and Ctrl+E resets it", () => {
  const keys = seedStepRoot(Date.now());
  keys.handleKey(undefined, CTRL("e")); // 1h
  keys.handleKey(undefined, CTRL("p"));
  assert.equal(keys.state().reportStep, 1);
  assert.match(keys.state().paneCache ?? "", /window: 2h to 1h ago/);
  assert.match(keys.state().paneCache ?? "", /200 output tokens/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /100 output tokens/);

  for (let i = 0; i < 4; i++) keys.handleKey(undefined, CTRL("e")); // 6h, 1d, 7d, default
  assert.equal(keys.state().reportStep, 0);
  assert.equal(keys.state().reportSince, null);
  for (let i = 0; i < 3; i++) keys.handleKey(undefined, CTRL("e")); // 1h, 6h, 1d
  assert.equal(keys.state().reportSince, "1d");
  keys.handleKey(undefined, CTRL("p"));
  keys.handleKey(undefined, CTRL("p"));
  assert.equal(keys.state().reportStep, 2);
  assert.match(keys.state().paneCache ?? "", /window: 3d to 2d ago/);
  assert.match(keys.state().paneCache ?? "", /300 output tokens/);

  keys.handleKey(undefined, CTRL("t")); // → failures
  assert.equal(keys.state().reportStep, 2);
  assert.match(keys.state().paneCache ?? "", /window: 3d to 2d ago/);
  assert.match(keys.state().paneCache ?? "", /· 1 runs/);
});

test("Ctrl+P wraps the stepped report window after the 7-day cap", () => {
  const keys = seedStepRoot(Date.now());
  for (let i = 0; i < 3; i++) keys.handleKey(undefined, CTRL("e")); // 1h, 6h, 1d
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, CTRL("p"));
  assert.equal(keys.state().reportStep, 6);
  assert.match(keys.state().paneCache ?? "", /window: 7d to 6d ago/);
  keys.handleKey(undefined, CTRL("p"));
  assert.equal(keys.state().reportStep, 0);
  assert.match(keys.state().flash ?? "", /oldest window reached; back to the last 1d/);
  keys.handleKey(undefined, CTRL("e")); // 7d
  keys.handleKey(undefined, CTRL("p"));
  assert.equal(keys.state().reportStep, 0);
  assert.match(keys.state().flash ?? "", /oldest window reached; back to the last 7d/);
});

test("Ctrl+P on the default report window only flashes the Ctrl+E hint", () => {
  const keys = seedStepRoot(Date.now());
  const before = keys.state().paneCache;
  keys.handleKey(undefined, CTRL("p"));
  assert.equal(keys.state().reportStep, 0);
  assert.equal(keys.state().paneCache, before);
  assert.match(keys.state().flash ?? "", /Ctrl\+E/);
});

test("steppedWindowBounds maps a step to the --since/--until pair", () => {
  assert.deepEqual(steppedWindowBounds(3_600_000, 0), { sinceMs: 3_600_000, untilMs: undefined });
  assert.deepEqual(steppedWindowBounds(86_400_000, 2), { sinceMs: 259_200_000, untilMs: 172_800_000 });
  assert.deepEqual(steppedWindowBounds(null, 3), { sinceMs: null, untilMs: undefined });
});

test("Ctrl+E is inert in the prompt-line modes and off the report views only moves the label", () => {
  const root = makeRoot();
  writeEvents(root, [{ ts: Date.now() - 60_000, loop: "feature", type: "run_end", run: 1, result: "error", tokens: 100 }]); // retired-name-ok: legacy event field in a fixture
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean"]);

  // On the Activity view (0) Ctrl+E opens the notify-hook editor (its new arm) rather than
  // moving the report window, so reportSince stays null.
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().notifyMode, true, "Ctrl+E on Activity opens the notify editor");
  assert.equal(keys.state().budgetMode, false);
  assert.equal(keys.state().reportSince, null, "Ctrl+E does not move the report window on Activity");
  keys.handleKey(undefined, { name: "escape" });

  // Budget mode holds the prompt line: Ctrl+E (blocked by the busy guard) leaves the line
  // and the window alone.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().notifyMode, false, "the notify editor cannot open over the budget editor");
  assert.equal(keys.state().reportSince, null, "Ctrl+E does nothing in budget mode");
  keys.handleKey(undefined, { name: "escape" });

  // Role-prompt mode holds it too: open it on a transcript view and try Ctrl+E.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // events → transcript clean
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().rolePromptFor, "clean");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, null, "Ctrl+E does nothing in role-prompt mode");
  keys.handleKey(undefined, { name: "escape" });

  // Retire-edit mode holds it too (the report window-cycle arm previously ran over the
  // retire modal): open it on the Health view and try Ctrl+E.
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health (roleIds.length + 7 = 8)
  assert.equal(keys.state().view, 8, "Health is roleIds.length + 7");
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().retireMode, true, "the retire editor holds the line");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, null, "Ctrl+E does nothing in retire-edit mode");
  keys.handleKey(undefined, { name: "escape" });
});

test("Ctrl+E on Activity opens the notify editor; on Usage it still cycles the report window", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);

  // Activity (view 0): Ctrl+E opens the notify editor, not the report window.
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().notifyMode, true, "Ctrl+E on Activity opens the notify editor");
  assert.equal(keys.state().budgetMode, false);
  assert.equal(keys.state().reportSince, null);
  keys.handleKey(undefined, { name: "escape" });

  // Usage (roleIds.length + 2): the notify arm returns false off view 0, so Ctrl+E still
  // cycles the report window.
  for (let i = 0; i < 2; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage
  assert.equal(keys.state().view, 2, "Usage is roleIds.length + 2");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().reportSince, "1h", "on Usage Ctrl+E still cycles the trailing window");
  assert.equal(keys.state().notifyMode, false);
});

test("Ctrl+O cycles the History pane's outcome class, filters rows by historyClass, and resets the scroll", () => {
  const root = makeRoot();
  const now = Date.now();
  writeEvents(root, [
    { ts: now - 60_000, loop: "feature", type: "run_end", run: 1, result: "changed" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 50_000, loop: "feature", type: "run_end", run: 2, result: "no_change" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 40_000, loop: "feature", type: "run_end", run: 3, result: "error" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 30_000, loop: "feature", type: "run_end", run: 4, result: "refused" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => now);
  keys.syncSnapshot(0, false, []);
  keys.setLineBudgets(1, 1); // a one-line budget so the three rows can scroll
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  assert.equal(keys.state().historyResult, "all", "History opens unfiltered");
  const all = keys.state().paneCache ?? "";
  assert.match(all, /feature #1/);
  assert.match(all, /feature #2/);
  assert.match(all, /feature #3/);
  assert.doesNotMatch(all, /result:/);

  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().paneScroll, 1, "the seeded rows overflow the one-line budget");

  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().historyResult, "merged");
  assert.match(keys.state().paneCache ?? "", /^result: merged\n/, "the header names the class");
  assert.match(keys.state().paneCache ?? "", /feature #1/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /feature #2/, "the no-change row is filtered out");
  assert.doesNotMatch(keys.state().paneCache ?? "", /feature #3/, "the error row is filtered out");
  assert.equal(keys.state().paneScroll, 0, "a class change re-enters the body at its head");

  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().historyResult, "none");
  assert.match(keys.state().paneCache ?? "", /feature #2/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /feature #1/);

  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().historyResult, "refused");
  assert.match(keys.state().paneCache ?? "", /^result: refused\n/, "the header names the refused class");
  assert.match(keys.state().paneCache ?? "", /feature #4/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /feature #1/);

  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().historyResult, "problems");
  assert.match(keys.state().paneCache ?? "", /feature #3/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /feature #1/);

  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().historyResult, "all", "the cycle wraps to no filter");
  assert.match(keys.state().paneCache ?? "", /feature #1/);
  assert.match(keys.state().paneCache ?? "", /feature #3/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /result:/);
});

test("Ctrl+O composes with the Ctrl+S window and names an emptied filter", () => {
  const root = makeRoot();
  const now = Date.now();
  // The only "changed" run is three days old; a "no_change" run sits inside 1h.
  writeEvents(root, [
    { ts: now - 30 * 60_000, loop: "feature", type: "run_end", run: 1, result: "no_change" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 3 * 24 * 60 * 60_000, loop: "feature", type: "run_end", run: 2, result: "changed" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => now);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  keys.handleKey(undefined, { ctrl: true, name: "o" }); // → merged
  assert.match(keys.state().paneCache ?? "", /feature #2/);
  keys.handleKey(undefined, { ctrl: true, name: "s" }); // → 1h
  assert.equal(keys.state().historySince, "1h");
  const cache = keys.state().paneCache ?? "";
  assert.match(cache, /window: last 1h/);
  assert.match(cache, /result: merged/);
  assert.match(cache, /no runs with result "merged"/);
  assert.doesNotMatch(cache, /feature #/);
});

test("Ctrl+O over a zero-row read keeps the pane's no-runs note, not a filter-empty claim", () => {
  const root = makeRoot();
  writeEvents(root, []);
  const { keys } = makeKeys(root, () => Date.now());
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  assert.equal(keys.state().paneCache, "", "an empty log opens on the pane's own no-runs note");
  keys.handleKey(undefined, { ctrl: true, name: "o" }); // → merged
  assert.equal(keys.state().historyResult, "merged");
  assert.equal(keys.state().paneCache, "", "an empty log is not blamed on the outcome filter");
});

test("Ctrl+O cycles the Activity type on view 0, opens the quiet editor on a Transcript, and is inert in the prompt-line modes", () => {
  const root = makeRoot();
  writeEvents(root, [{ ts: Date.now() - 60_000, loop: "feature", type: "run_end", run: 1, result: "changed" }]); // retired-name-ok: legacy event field in a fixture
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean"]);

  // On the Activity view (0), Ctrl+O now cycles the event type, not the History label.
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().activityType, "run_end", "view 0 routes Ctrl+O to the Activity type cycle");
  assert.equal(keys.state().historyResult, "all", "the History label is untouched on Activity");
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().activityType, null, "the Activity type wraps");

  // On a role's Transcript view, Ctrl+O opens the quiet-hours editor (the terminal twin of
  // the dashboard drawer's `Quiet hours` row), not the History class cycle.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // events → transcript clean
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().quietMode, true, "Ctrl+O on a role's Transcript opens the quiet editor");
  assert.equal(keys.state().historyResult, "all", "the History class is untouched on a transcript");
  keys.handleKey(undefined, { name: "escape" });

  // Budget mode holds the prompt line: Ctrl+O leaves the class alone.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().quietMode, false, "the busy guard keeps quiet mode closed");
  assert.equal(keys.state().historyResult, "all", "Ctrl+O does nothing in budget mode");
  keys.handleKey(undefined, { name: "escape" });

  // Role-prompt mode holds it too: open it on a transcript view and try Ctrl+O.
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().rolePromptFor, "clean");
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().quietMode, false, "the busy guard keeps quiet mode closed");
  assert.equal(keys.state().historyResult, "all", "Ctrl+O does nothing in role-prompt mode");
  keys.handleKey(undefined, { name: "escape" });
});

test("Ctrl+Y cycles the History pane through the run rows, the per-role Summary table and the per-model one", () => {
  const root = makeRoot();
  writeEvents(root, [
    { ts: 1_699_999_990_000, loop: "feature", type: "run_start", run: 1, model: "m-a" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_050_000, loop: "qa", type: "run_start", run: 1, model: "m-b" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_000_000, loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 100, costUsd: 0.1 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_060_000, loop: "qa", type: "run_end", run: 1, result: "none", tokens: 50, costUsd: 0.05 }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  assert.equal(keys.state().historySummary, null, "History opens in the row view");
  const rows = keys.state().paneCache ?? "";
  assert.match(rows, /feature #1/, "the row view holds a #-run row");
  assert.match(rows, /qa #1/);

  keys.handleKey(undefined, { ctrl: true, name: "y" });
  assert.equal(keys.state().historySummary, "role", "Ctrl+Y turns the role summary on");
  const summary = keys.state().paneCache ?? "";
  const first = summary.split("\n")[0] ?? "";
  assert.match(first, /role/);
  assert.match(first, /runs/);
  assert.match(first, /tokens/);
  assert.match(first, /cost/);
  assert.match(summary, /^feature\b/m, "the summary has one line per role");
  assert.match(summary, /^qa\b/m);
  assert.match(summary, /^total\b/m, "plus a total line");
  assert.doesNotMatch(summary, /#1/, "the summary holds no #-run row");

  keys.handleKey(undefined, { ctrl: true, name: "y" });
  assert.equal(keys.state().historySummary, "model", "a second Ctrl+Y shows the model summary");
  const models = keys.state().paneCache ?? "";
  const mfirst = models.split("\n")[0] ?? "";
  assert.match(mfirst, /model/);
  assert.match(mfirst, /runs/);
  assert.match(mfirst, /cost/);
  assert.match(models, /^m-a\b/m);
  assert.match(models, /^m-b\b/m);
  assert.match(models, /^total\b/m);
  assert.doesNotMatch(models, /#1/);

  keys.handleKey(undefined, { ctrl: true, name: "y" });
  assert.equal(keys.state().historySummary, null, "a third Ctrl+Y restores the rows");
  assert.match(keys.state().paneCache ?? "", /feature #1/);
});

test("Ctrl+Y is inert while budget mode holds the prompt line", () => {
  const root = makeRoot();
  writeEvents(root, [{ ts: 1_700_000_000_000, loop: "feature", type: "run_end", run: 1, result: "changed" }]); // retired-name-ok: legacy event field in a fixture
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  keys.handleKey(undefined, { ctrl: true, name: "y" });
  assert.equal(keys.state().historySummary, "role");
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "y" });
  assert.equal(keys.state().historySummary, "role", "Ctrl+Y does nothing in budget mode");
  keys.handleKey(undefined, { name: "escape" });
});

test("Ctrl+Y opens the claude-reserve editor on Activity, flashes the busy message in budget mode, and keeps the History Summary toggle off Activity", () => {
  const root = makeRoot();
  writeEvents(root, [{ ts: 1_700_000_000_000, loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 100, costUsd: 0.1 }]); // retired-name-ok: legacy event field in a fixture
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);

  // Activity (view 0): Ctrl+Y is the claude-reserve editor; the History Summary flag is
  // untouched (it names a different view's toggle).
  keys.handleKey(undefined, { ctrl: true, name: "y" });
  assert.equal(keys.state().claudeReserveMode, true, "Ctrl+Y on Activity opens the claude-reserve editor");
  assert.equal(keys.state().historySummary, null, "the History Summary flag is unchanged");
  assert.equal(keys.state().input, "", "unset claudeWindowReserve pre-fills empty");
  assert.match(keys.state().flash!, /backends\.claude\.windowReserve/);
  keys.handleKey(undefined, { ctrl: true, name: "y" });
  assert.equal(keys.state().claudeReserveMode, false, "Ctrl+Y again cancels the claude-reserve editor");

  // With the budget editor holding the line, Ctrl+Y flashes the busy message, not a toggle.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "y" });
  assert.equal(keys.state().claudeReserveMode, false, "Ctrl+Y does not open under the budget editor");
  assert.match(keys.state().flash!, /finish or cancel the budget edit first/);
  keys.handleKey(undefined, { name: "escape" });

  // On History (view 4), Ctrl+Y still toggles the per-role Summary table: the new arm returns
  // false off view 0, so the History arm runs.
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  keys.handleKey(undefined, { ctrl: true, name: "y" });
  assert.equal(keys.state().historySummary, "role", "on History Ctrl+Y still toggles the Summary table");
  assert.equal(keys.state().claudeReserveMode, false, "the claude-reserve editor does not open on History");
});

test("Ctrl+Y's summary folds the History pane's exact-role scope, not the team read", () => {
  const root = makeRoot();
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "feature", type: "run_end", run: 1, result: "changed" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_060_000, loop: "qa", type: "run_end", run: 1, result: "none" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "qa"]);
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history (roleIds.length + 4 = 6)
  keys.handleKey(undefined, { ctrl: true, name: "g" }); // → feature
  assert.equal(keys.state().historyRole, "feature");
  keys.handleKey(undefined, { ctrl: true, name: "y" });
  const summary = keys.state().paneCache ?? "";
  assert.match(summary, /^feature\b/m, "the scoped summary lists the scoped role");
  assert.match(summary, /^total\b/m);
  assert.doesNotMatch(summary, /^qa\b/m, "and no other role");
});

test("the `/` search filters the History pane through runRowGrepHaystack and clears on an empty line", () => {
  const root = makeRoot();
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "feature", type: "run_end", run: 1, result: "changed" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_060_000, loop: "clean", type: "run_end", run: 2, result: "changed" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  assert.equal(keys.state().view, 4, "History is roleIds.length + 4");
  assert.equal(keys.state().historyGrep, null, "History opens unsearched");
  assert.match(keys.state().paneCache ?? "", /feature #1/);
  assert.match(keys.state().paneCache ?? "", /clean #2/);

  // `/` enters search on the empty line, and Enter applies the typed pattern.
  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "", "an empty search opens blank");
  for (const ch of "clean") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().historyGrep, "clean");
  assert.match(keys.state().paneCache ?? "", /^search: clean$/m, "the header names the pattern");
  assert.match(keys.state().paneCache ?? "", /clean #2/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /feature #1/, "the non-matching row is filtered out");

  // Re-opening pre-fills the applied pattern; Esc cancels without changing it.
  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "clean", "re-opening pre-fills the applied pattern");
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().historyGrep, "clean", "Esc leaves the applied pattern unchanged");
  assert.equal(keys.state().input, "", "Esc restores the pre-search draft");

  // Re-open, clear the line, and submit: the search lifts and the full rows return.
  keys.handleKey("/", { name: "/" });
  keys.handleKey(undefined, { ctrl: true, name: "u" });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().historyGrep, null, "an empty line clears the search");
  assert.match(keys.state().paneCache ?? "", /feature #1/);
  assert.match(keys.state().paneCache ?? "", /clean #2/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /search:/);
});

test("`/` opens a search on Activity and History with an empty line, types elsewhere, and search mode owns the line", () => {
  const root = makeRoot();
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "feature", type: "run_end", run: 1, result: "changed" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_060_000, loop: "clean", type: "run_end", run: 2, result: "changed" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(50, false, ["clean"]);

  // On a view without a search, `/` types into the prompt line. Activity and the transcript
  // own a search themselves, so step onto Usage first.
  for (let i = 0; i < 3; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → usage
  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "/", "`/` on Usage types into the prompt");
  keys.handleKey(undefined, { ctrl: true, name: "u" }); // clear the draft
  for (let i = 0; i < 2; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  assert.equal(keys.state().view, 5, "History is roleIds.length + 4");

  // On History with a non-empty line, `/` types instead of entering search.
  for (const ch of "draft") keys.handleKey(ch, { name: ch });
  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "draft/", "`/` on a non-empty line leaves the draft alone");
  keys.handleKey(undefined, { ctrl: true, name: "u" });

  // Budget mode owns the line on History too: `/` edits the cap, it does not enter search.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  assert.equal(keys.state().input, "50", "budget mode pre-fills the cap");
  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "50/", "`/` in budget mode edits the cap, not the search");
  keys.handleKey(undefined, { name: "escape" });

  // While search holds the line, the pane-cycle keys and prompt recall are inert.
  keys.handleKey(undefined, { ctrl: true, name: "s" }); // window → 1h before searching
  keys.handleKey(undefined, { ctrl: true, name: "o" }); // result → changes
  const since = keys.state().historySince;
  const result = keys.state().historyResult;
  const role = keys.state().historyRole;
  keys.handleKey("/", { name: "/" });
  for (const ch of "clean") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  keys.handleKey(undefined, { name: "up" });
  assert.equal(keys.state().historySince, since, "Ctrl+S is inert in search mode");
  assert.equal(keys.state().historyResult, result, "Ctrl+O is inert in search mode");
  assert.equal(keys.state().historyRole, role, "Ctrl+G is inert in search mode");
  assert.equal(keys.state().input, "clean", "Up/Down do not recall while search holds the line");
  keys.handleKey(undefined, { name: "escape" });
});

test("the Pending pane caches the rendered team roster when collectPending resolves, and a cycle away drops it", async () => {
  const root = makeRoot();
  const team = {
    mainBranch: "main",
    roles: [
      { role: "feature", branch: "tumwater/feature", state: "ready" as const, ahead: 2, behind: 0, commits: [], dirtyFiles: [] },
      { role: "clean", branch: "tumwater/clean", state: "ready" as const, ahead: 0, behind: 0, commits: [], dirtyFiles: ["a.ts"] },
    ],
  };
  let resolvePending!: (view: typeof team) => void;
  const pending = new Promise<typeof team>((resolve) => (resolvePending = resolve));
  let renders = 0;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => (renders += 1),
    now: () => 0,
    collectOverlaps: () => Promise.resolve({ mainBranch: "main", state: "no-base" as const, overlaps: [] }),
    collectPending: () => pending,
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  assert.equal(keys.state().view, 5);
  assert.equal(
    keys.state().paneCache,
    "merge queue empty",
    "the cache holds the queue (empty here) before the collector resolves",
  );
  const before = renders;

  resolvePending(team);
  await new Promise((r) => setImmediate(r));
  assert.equal(
    keys.state().paneCache,
    "merge queue empty\n\nfeature: 2 commits ahead of main\nclean: 0 commits ahead of main, 1 uncommitted file",
    "the pane caches the queue above renderTeamChange's roster text",
  );
  assert.ok(renders > before, "a resolution repaints the pane");
});

test("the Pending pane renders the durable merge queue on entry, above the resolved team roster", async () => {
  const root = makeRoot();
  enqueueMerge(root, { role: "feature", sha: "a".repeat(40), run: 3, summary: "add a thing", enqueuedAt: 0 });
  const team = {
    mainBranch: "main",
    roles: [
      { role: "feature", branch: "tumwater/feature", state: "ready" as const, ahead: 2, behind: 0, commits: [], dirtyFiles: [] },
      { role: "clean", branch: "tumwater/clean", state: "ready" as const, ahead: 0, behind: 0, commits: [], dirtyFiles: ["a.ts"] },
    ],
  };
  let resolvePending!: (view: typeof team) => void;
  const pending = new Promise<typeof team>((resolve) => (resolvePending = resolve));
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectOverlaps: () => Promise.resolve({ mainBranch: "main", state: "no-base" as const, overlaps: [] }),
    collectPending: () => pending,
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  assert.equal(keys.state().view, 5);
  // The queue needs no git read, so it is already rendered when the collector is still in flight.
  assert.equal(keys.state().paneCache, renderMergeQueue(readMergeQueue(root), 0));

  resolvePending(team);
  await new Promise((r) => setImmediate(r));
  assert.equal(
    keys.state().paneCache,
    renderMergeQueue(readMergeQueue(root), 0) +
      "\n\nfeature: 2 commits ahead of main\nclean: 0 commits ahead of main, 1 uncommitted file",
    "the two-role roster is appended below the same queue text",
  );
});

test("the Pending pane shows the post-merge review queue above the roster", async () => {
  const root = makeRoot();
  enqueueMerge(root, { role: "feature", sha: "a".repeat(40), run: 3, summary: "add a thing", enqueuedAt: 0 });
  writeJsonFile(postReviewPath(root), { pending: [{ commit: "b".repeat(40), role: "feature", summary: "review me", failures: 2 }] });
  const team = { mainBranch: "main", roles: [] };
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectOverlaps: () => Promise.resolve({ mainBranch: "main", state: "no-base" as const, overlaps: [] }),
    collectPending: () => new Promise<typeof team>(() => {}),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  const queued = renderMergeQueue(readMergeQueue(root), 0);
  const reviews = renderPostReviews(readPostReviews(root));
  const cache = keys.state().paneCache ?? "";
  assert.equal(cache, queued + "\n\n" + reviews);
  assert.match(cache, /post-merge review queue \(1 entry\):/);
  assert.match(cache, /feature bbbbbbbb · review me · \[2 failed review runs\]/);
});

test("a Pending collector resolution after the operator cycled away does not cache onto the new view", async () => {
  const root = makeRoot();
  const team = { mainBranch: "main", roles: [] };
  let resolveLate!: (view: typeof team) => void;
  let renders = 0;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => (renders += 1),
    now: () => 0,
    collectOverlaps: () => Promise.resolve({ mainBranch: "main", state: "no-base" as const, overlaps: [] }),
    collectPending: () => new Promise<typeof team>((resolve) => (resolveLate = resolve)),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  assert.equal(keys.state().view, 5);
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Queued
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Brief
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // cycle away to Activity before it resolves
  assert.equal(keys.state().view, 0);
  resolveLate(team);
  await new Promise((r) => setImmediate(r));
  assert.equal(keys.state().paneCache, null, "a late resolution does not cache onto Activity");
});

test("a Pending collector resolution after the roster size changed caches onto the still-selected Pending pane", async () => {
  const root = makeRoot();
  const team = { mainBranch: "main", roles: [] };
  let resolveLate!: (view: typeof team) => void;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectOverlaps: () => Promise.resolve({ mainBranch: "main", state: "no-base" as const, overlaps: [] }),
    collectPending: () => new Promise<typeof team>((resolve) => (resolveLate = resolve)),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending (index 5, no roles)
  assert.equal(keys.state().view, 5);
  const queueText = keys.state().paneCache; // the immediate queue set, before the collector resolves
  // A role appears while the collector is in flight: the relative panes shift with the
  // roster, so Pending keeps its selection at its new index 6 rather than silently becoming
  // History under the same raw index.
  keys.syncSnapshot(0, false, ["feature"], false);
  assert.equal(keys.state().view, 6, "Pending keeps its selection when the roster grows");
  resolveLate(team);
  await new Promise((r) => setImmediate(r));
  assert.equal(
    keys.state().paneCache,
    queueText + "\n\nno pending changes",
    "the still-selected Pending pane caches the resolved roster",
  );
});

test("the Pending pane refreshes in place with Ctrl+R: a counting collector re-reads the fresh queue and roster", async () => {
  const root = makeRoot();
  const teamA = {
    mainBranch: "main",
    roles: [
      { role: "feature", branch: "tumwater/feature", state: "ready" as const, ahead: 2, behind: 0, commits: [], dirtyFiles: [] },
    ],
  };
  const teamB = { mainBranch: "main", roles: [] };
  let calls = 0;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectOverlaps: () => Promise.resolve({ mainBranch: "main", state: "no-base" as const, overlaps: [] }),
    collectPending: () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? teamA : teamB);
    },
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  assert.equal(keys.state().view, 5);
  assert.equal(calls, 1, "entering Pending starts the collector once");
  await new Promise((r) => setImmediate(r));
  assert.equal(
    keys.state().paneCache,
    "merge queue empty\n\nfeature: 2 commits ahead of main",
    "the first collector resolution paints teamA's roster",
  );
  // One Ctrl+R starts the collector a second time, and its resolution paints teamB's roster.
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(calls, 2, "a single Ctrl+R starts the collector a second time");
  await new Promise((r) => setImmediate(r));
  assert.equal(
    keys.state().paneCache,
    "merge queue empty\n\nno pending changes",
    "the second collector resolution paints the refreshed roster",
  );
  // Ctrl+R on another view never re-reads Pending: this view has no backlog selection, so
  // the key falls through to no arm at all and no collector re-runs.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Queued
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Brief
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Activity
  assert.equal(keys.state().view, 0);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(calls, 2, "Ctrl+R off Pending does not re-read the collector");
});

test("the Pending pane lists overlapping files below the roster, through the CLI's renderChangeOverlaps", async () => {
  const keys = createTuiKeys({
    root: makeRoot(),
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectPending: () =>
      Promise.resolve({
        mainBranch: "main",
        roles: [{ role: "feature", branch: "tumwater/feature", state: "ready" as const, ahead: 1, behind: 0, commits: [], dirtyFiles: [] }],
      }),
    collectOverlaps: () =>
      Promise.resolve({ mainBranch: "main", state: "ready" as const, overlaps: [{ path: "src/a.ts", roles: ["feature", "feature-2"] }] }),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  await new Promise((r) => setImmediate(r));
  assert.equal(
    keys.state().paneCache,
    "merge queue empty\n\nfeature: 1 commit ahead of main\n\noverlapping files (1):\nsrc/a.ts: feature, feature-2",
  );
});

function drillKeys(overlaps: { path: string; roles: string[] }[], calls: [string, { path?: string } | undefined][] = []) {
  const keys = createTuiKeys({
    root: makeRoot(),
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectPending: () => Promise.resolve({ mainBranch: "main", roles: [] }),
    collectOverlaps: () => Promise.resolve({ mainBranch: "main", state: "ready" as const, overlaps }),
    collectChange: (_root, role, opts) => {
      calls.push([role, opts]);
      return Promise.resolve({ role, branch: `tumwater/${role}`, mainBranch: "main", state: "ready" as const, ahead: 0, behind: 0, commits: [], diff: "", dirtyFiles: [], uncommittedDiff: "", path: opts?.path });
    },
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  return keys;
}
const stubView = (role: string, path: string) => ({ role, branch: `tumwater/${role}`, mainBranch: "main", state: "ready" as const, ahead: 0, behind: 0, commits: [], diff: "", dirtyFiles: [], uncommittedDiff: "", path });
const settle = () => new Promise((r) => setImmediate(r));

test("Ctrl+N on the Pending pane steps through each overlap's path-scoped change, then back", async () => {
  const calls: [string, { path?: string } | undefined][] = [];
  const keys = drillKeys([{ path: "src/a.ts", roles: ["feature", "feature-2"] }, { path: "src/b.ts", roles: ["feature", "qa"] }], calls);
  await settle();
  const before = keys.state().paneCache;
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  await settle();
  assert.equal(
    keys.state().paneCache,
    overlapDrillHeading(0, 2, "src/a.ts") + "\n\n" + renderRoleChanges({ mainBranch: "main", roles: [stubView("feature", "src/a.ts"), stubView("feature-2", "src/a.ts")] }),
  );
  assert.deepEqual(calls, [["feature", { path: "src/a.ts" }], ["feature-2", { path: "src/a.ts" }]]);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  await settle();
  assert.equal(
    keys.state().paneCache,
    overlapDrillHeading(1, 2, "src/b.ts") + "\n\n" + renderRoleChanges({ mainBranch: "main", roles: [stubView("feature", "src/b.ts"), stubView("qa", "src/b.ts")] }),
  );
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().paneCache, before);
});

test("Ctrl+N on the Pending pane with no overlaps flashes and keeps the pane", async () => {
  const keys = drillKeys([]);
  await settle();
  const before = keys.state().paneCache;
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().paneCache, before);
  assert.equal(keys.state().flash, "no overlapping files to step through");
});

test("Ctrl+R on the Pending pane closes an open overlap drill-down", async () => {
  const keys = drillKeys([{ path: "src/a.ts", roles: ["feature", "feature-2"] }]);
  await settle();
  const before = keys.state().paneCache;
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  await settle();
  await settle();
  assert.equal(keys.state().paneCache, before);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.match(keys.state().paneCache ?? "", /^overlap 1\/1: src\/a\.ts/);
});

test("Ctrl+N returning to the base pane drops a drill-down still loading", async () => {
  const keys = drillKeys([{ path: "src/a.ts", roles: ["feature", "feature-2"] }]);
  await settle();
  const before = keys.state().paneCache;
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // drill-down starts loading
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // back to base before it resolves
  await settle();
  await settle();
  assert.equal(keys.state().paneCache, before);
});

const scopeOverlaps = [{ path: "src/a.ts", roles: ["feature", "feature-2"] }, { path: "src/b.ts", roles: ["feature", "qa"] }];
const ctrlG = (keys: ReturnType<typeof drillKeys>) => keys.handleKey(undefined, { ctrl: true, name: "g" });

test("pendingOverlapsText narrows to one holding role", () => {
  const view = { mainBranch: "main", state: "ready" as const, overlaps: scopeOverlaps };
  assert.equal(pendingOverlapsText(view), "overlapping files (2):\nsrc/a.ts: feature, feature-2\nsrc/b.ts: feature, qa");
  assert.equal(pendingOverlapsText(view, "qa"), "overlapping files held by qa (1):\nsrc/b.ts: feature, qa");
  assert.equal(pendingOverlapsText(view, "bugfix"), "no file held by bugfix is touched by another pending change");
  assert.equal(pendingOverlapsText({ mainBranch: "trunk", state: "no-base", overlaps: [] }, "qa"), "");
});

test("overlapHolders lists each holding role once in first-seen order", () => {
  assert.deepEqual(overlapHolders({ mainBranch: "main", state: "ready", overlaps: scopeOverlaps }), ["feature", "feature-2", "qa"]);
  assert.deepEqual(overlapHolders({ mainBranch: "trunk", state: "no-base", overlaps: [] }), []);
});

test("Ctrl+G on the Pending pane cycles the overlap scope through each holder and back", async () => {
  const keys = drillKeys(scopeOverlaps);
  await settle();
  const before = keys.state().paneCache;
  ctrlG(keys);
  assert.ok(keys.state().paneCache!.endsWith("overlapping files held by feature (2):\nsrc/a.ts: feature, feature-2\nsrc/b.ts: feature, qa"));
  ctrlG(keys);
  assert.ok(keys.state().paneCache!.endsWith("held by feature-2 (1):\nsrc/a.ts: feature, feature-2"));
  ctrlG(keys);
  assert.ok(keys.state().paneCache!.endsWith("held by qa (1):\nsrc/b.ts: feature, qa"));
  ctrlG(keys);
  assert.equal(keys.state().paneCache, before);
});

test("Ctrl+N under a Pending overlap scope steps through only the scoped files", async () => {
  const calls: [string, { path?: string } | undefined][] = [];
  const keys = drillKeys(scopeOverlaps, calls);
  await settle();
  for (let i = 0; i < 3; i++) ctrlG(keys);
  const scoped = keys.state().paneCache;
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  await settle();
  assert.ok(keys.state().paneCache!.startsWith(overlapDrillHeading(0, 1, "src/b.ts")));
  assert.deepEqual(calls, [["feature", { path: "src/b.ts" }], ["qa", { path: "src/b.ts" }]]);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().paneCache, scoped);
});

test("Ctrl+G on the Pending pane closes an open drill-down and survives Ctrl+R", async () => {
  const keys = drillKeys(scopeOverlaps);
  await settle();
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  ctrlG(keys);
  const tail = "overlapping files held by feature (2):\nsrc/a.ts: feature, feature-2\nsrc/b.ts: feature, qa";
  assert.ok(keys.state().paneCache!.endsWith(tail));
  assert.ok(!keys.state().paneCache!.startsWith("overlap "));
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  await settle();
  await settle();
  assert.ok(keys.state().paneCache!.endsWith(tail));
});

test("Ctrl+G on the Pending pane with empty queue and no overlaps flashes", async () => {
  const keys = drillKeys([]);
  await settle();
  const before = keys.state().paneCache;
  ctrlG(keys);
  assert.equal(keys.state().paneCache, before);
  assert.equal(keys.state().flash, "no queued merges, post-merge reviews or overlapping files to scope");
});

test("mergeQueueRoles lists each queued role once in queue order", () => {
  const view: MergeQueueView = {
    entries: [
      { role: "feature", sha: "a".repeat(40), run: 1, summary: "", enqueuedAt: 0 },
      { role: "clean", sha: "b".repeat(40), run: 1, summary: "", enqueuedAt: 1 },
      { role: "feature", sha: "c".repeat(40), run: 2, summary: "", enqueuedAt: 2 },
    ],
    unreadable: 0,
  };
  assert.deepEqual(mergeQueueRoles(view), ["feature", "clean"]);
  assert.deepEqual(mergeQueueRoles({ entries: [], unreadable: 0 }), []);
});

test("postReviewRoles lists each review role once in first-seen order", () => {
  const r = (role: string, commit: string): PostReview => ({ role, commit, summary: "" });
  assert.deepEqual(postReviewRoles([r("feature", "a".repeat(40)), r("clean", "b".repeat(40)), r("feature", "c".repeat(40))]), ["feature", "clean"]);
  assert.deepEqual(postReviewRoles([]), []);
});

test("Ctrl+G on the Pending pane scopes the post-merge review block to each review role under its whole-queue position", async () => {
  const root = makeRoot();
  writeJsonFile(postReviewPath(root), {
    pending: [
      { role: "feature", commit: "a".repeat(40), summary: "feature first" },
      { role: "clean", commit: "b".repeat(40), summary: "clean second" },
      { role: "feature", commit: "c".repeat(40), summary: "feature third" },
    ],
  });
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectPending: () => Promise.resolve({ mainBranch: "main", roles: [] }),
    collectOverlaps: () => Promise.resolve({ mainBranch: "main", state: "no-base" as const, overlaps: [] }),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  assert.equal(keys.state().view, 5);
  await settle();
  const cache = () => keys.state().paneCache ?? "";
  const whole = renderPostReviews(readPostReviews(root));
  assert.ok(cache().includes(whole), "the unscoped pane paints the whole review block");
  ctrlG(keys);
  assert.ok(cache().includes("post-merge review queue (2 of 3, --role feature):"), "the first scope is the first review role");
  assert.ok(cache().includes(" 1. feature "), "the scoped block keeps the first entry under its whole-queue position");
  assert.ok(cache().includes(" 3. feature "), "and the second feature entry under whole-queue position 3");
  assert.ok(!cache().includes("clean second"), "the other roles' entries are dropped");
  assert.ok(cache().includes("merge queue empty"), "the scoped empty queue still paints the empty line");
  ctrlG(keys);
  assert.ok(cache().includes("post-merge review queue (1 of 3, --role clean):"), "the second scope is the next review role");
  assert.ok(cache().includes(" 2. clean "), "clean keeps its whole-queue position 2");
  assert.ok(cache().includes("merge queue empty"), "the review-only role's queue still paints");
  assert.ok(keys.state().flash === null || keys.state().flash === "", "a reachable role never flashes the empty scope");
  ctrlG(keys);
  assert.ok(cache().includes(whole), "the third press returns to the whole review block byte-for-byte");
  assert.ok(cache().includes("merge queue empty"), "and to the whole merge queue");
});

test("Ctrl+G on the Pending pane narrows the merge queue to each queued role under its whole-queue position", async () => {
  const root = makeRoot();
  enqueueMerge(root, { role: "feature", sha: "a".repeat(40), run: 1, summary: "feature first", enqueuedAt: 0 });
  enqueueMerge(root, { role: "feature-2", sha: "b".repeat(40), run: 2, summary: "feature2 second", enqueuedAt: 1 });
  enqueueMerge(root, { role: "clean", sha: "c".repeat(40), run: 3, summary: "clean third", enqueuedAt: 2 });
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectPending: () => Promise.resolve({ mainBranch: "main", roles: [] }),
    collectOverlaps: () => Promise.resolve({ mainBranch: "main", state: "no-base" as const, overlaps: [] }),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  assert.equal(keys.state().view, 5);
  await settle();
  const cache = () => keys.state().paneCache ?? "";
  assert.ok(cache().startsWith("merge queue (3):"), "the unscoped queue lists all three entries");
  ctrlG(keys);
  assert.ok(cache().startsWith("merge queue (1 of 3, --role feature):"), "the first scope is the first queued role");
  assert.ok(cache().includes(" 1. feature run #1 "), "the scoped view keeps the first entry under its whole-queue position");
  assert.ok(!cache().includes(" 2. "), "the other entries' lines are dropped");
  assert.ok(!cache().includes(" 3. "));
  ctrlG(keys);
  assert.ok(cache().startsWith("merge queue (1 of 3, --role feature-2):"), "the second scope is the second queued role");
  assert.ok(cache().includes(" 2. feature #2 run #2 "), "feature-2 keeps its position 2");
  ctrlG(keys);
  assert.ok(cache().startsWith("merge queue (1 of 3, --role clean):"), "the third scope is the third queued role");
  assert.ok(cache().includes(" 3. clean run #3 "), "clean keeps its position 3");
  ctrlG(keys);
  assert.ok(cache().startsWith("merge queue (3):"), "the fourth press returns to the whole queue");
  assert.ok(cache().includes(" 1. feature run #1 "));
});

test("the Pending pane's Ctrl+G scope filters the queue and the overlapping files from one cycle set", async () => {
  const root = makeRoot();
  enqueueMerge(root, { role: "clean", sha: "a".repeat(40), run: 1, summary: "clean run", enqueuedAt: 0 });
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectPending: () => Promise.resolve({ mainBranch: "main", roles: [] }),
    collectOverlaps: () => Promise.resolve({ mainBranch: "main", state: "ready" as const, overlaps: [{ path: "src/a.ts", roles: ["feature", "clean"] }] }),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  assert.equal(keys.state().view, 5);
  await settle();
  const cache = () => keys.state().paneCache ?? "";
  ctrlG(keys);
  assert.ok(cache().startsWith("merge queue (1 of 1, --role clean):"), "the queue role (clean) scopes the queue first");
  assert.ok(cache().includes("overlapping files held by clean (1):\nsrc/a.ts: feature, clean"));
  ctrlG(keys);
  assert.ok(cache().startsWith("no queued merges for feature (merge queue holds 1)"), "a holder with no queued merge keeps its queue block under the whole depth");
  assert.ok(cache().includes("overlapping files held by feature (1):\nsrc/a.ts: feature, clean"));
  ctrlG(keys);
  assert.ok(cache().startsWith("merge queue (1):"), "the third press returns to the whole queue");
  assert.ok(cache().includes("overlapping files (1):\nsrc/a.ts: feature, clean"), "and to all overlaps");
});

// The Pending pane's row cancel (PLANS.md's TUI Pending pane Ctrl+X twice entry)
// needs a real git repo: cancelQueuedMerge deletes the role's merge pin with `git update-ref`.
// Seed the same pinned-entry shape merge-cancel.test.ts does — enqueueMerge + setRef off main —
// so the pane's removal path shares the CLI's core and honors the pin.
async function pendingCancelRoot(): Promise<{ root: string; featureSha: string; cleanSha: string }> {
  // Pins first, then enqueues — pinOffMain's `git add -A` would otherwise commit an earlier
  // enqueued .tumwater queue file into a detached commit and its `git checkout main` delete it
  // (the same ordering merge-cancel.test.ts's threeQueued pins down).
  const root = makeRepo();
  let n = 0;
  const featureSha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, `f${n++}.txt`), "one\n"), "add one");
  assert.ok(await setRef(root, mergeRefName("feature"), featureSha));
  const cleanSha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, `f${n++}.txt`), "two\n"), "add two");
  assert.ok(await setRef(root, mergeRefName("clean"), cleanSha));
  enqueueMerge(root, { role: "feature", sha: featureSha, run: 1, summary: "add one", enqueuedAt: Date.now() });
  enqueueMerge(root, { role: "clean", sha: cleanSha, run: 2, summary: "add two", enqueuedAt: Date.now() + 1 });
  return { root, featureSha, cleanSha };
}

/** A Pending-pane handler on a repo whose queue and roster resolve immediately. */
function openPending(root: string): ReturnType<typeof createTuiKeys> {
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectPending: () => Promise.resolve({ mainBranch: "main", roles: [] }),
    collectOverlaps: () => Promise.resolve({ mainBranch: "main", state: "no-base" as const, overlaps: [] }),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  assert.equal(keys.state().view, 5);
  return keys;
}

test("the Pending pane selects a queued merge in full and Esc returns to the list", async () => {
  const { root } = await pendingCancelRoot();
  const keys = openPending(root);
  assert.equal(keys.state().selectedQueue, null, "the pane opens in list mode");
  assert.equal(keys.state().queueDetail, "", "no detail while in list mode");

  keys.handleKey(undefined, { name: "down" });
  assert.equal(keys.state().selectedQueue, 0, "Down selects the first (oldest) entry");
  assert.match(keys.state().queueDetail, /^merge #1 \(Ctrl\+X to cancel, Ctrl\+V to top\): feature run #1 · /);
  assert.ok(keys.state().queueDetail.includes("add one"), "the detail shows the summary");

  keys.handleKey(undefined, { name: "down" });
  assert.equal(keys.state().selectedQueue, 1, "Down wraps to the second");
  assert.match(keys.state().queueDetail, /^merge #2 \(Ctrl\+X to cancel, Ctrl\+V to top\): clean run #2 · /);
  assert.ok(keys.state().queueDetail.includes("add two"), "the detail shows the second summary");

  keys.handleKey(undefined, { name: "up" });
  assert.equal(keys.state().selectedQueue, 0, "Up returns to the first");

  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().selectedQueue, null, "Esc returns to list mode");
  assert.equal(keys.state().queueDetail, "", "Esc clears the detail");
});

test("the Pending pane names why a selected re-queued merge is back", async () => {
  const root = makeRepo();
  const sha = pinOffMain(root, (d) => fs.writeFileSync(path.join(d, `fq.txt`), "one\n"), "add one");
  assert.ok(await setRef(root, mergeRefName("feature"), sha));
  enqueueMerge(root, { role: "feature", sha, run: 1, summary: "add one", enqueuedAt: Date.now(), retry: "review_error", notBefore: Date.now() + 60_000 });
  const keys = openPending(root);
  keys.handleKey(undefined, { name: "down" }); // select the single queued merge
  assert.ok(keys.state().queueDetail.includes("re-queued after review_error"), "the selected-row detail names why it is back");
});

test("the Pending pane cancels the selected merge with Ctrl+X twice, deleting its pin and logging merge_cancelled", async () => {
  const { root, featureSha } = await pendingCancelRoot();
  const keys = openPending(root);
  // Ctrl+X with no selection just tells the operator how to select; the queue is untouched.
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().flash, "select a merge with ↑↓ first");
  assert.equal(queuedMerges(root).length, 2, "no selection leaves the queue");

  keys.handleKey(undefined, { name: "down" }); // select feature (#1)
  keys.handleKey(undefined, { ctrl: true, name: "x" }); // first press arms
  assert.match(keys.state().flash!, /press Ctrl\+X again to cancel merge #1/);
  assert.equal(queuedMerges(root).length, 2, "the first press changes nothing");

  keys.handleKey(undefined, { ctrl: true, name: "x" }); // second press confirms (async)
  await untilFlash(() => keys.state().flash ?? "", /cancelled queue entry 1: feature /);
  assert.deepEqual(queuedMerges(root).map((e) => e.role), ["clean"], "only the selected entry is removed");
  assert.equal(await refSha(root, mergeRefName("feature")), null, "the cancelled role's pin is deleted");
  assert.ok(await refSha(root, mergeRefName("clean")), "the other entry's pin is intact");
  assert.equal(keys.state().selectedQueue, null, "a cancel returns to list mode");
  assert.equal(keys.state().queueDetail, "", "a cancel clears the detail");
  const cancelled = eventsOfType(root, "merge_cancelled");
  assert.equal(cancelled.length, 1, "exactly one merge_cancelled event");
  assert.equal(cancelled[0]!.commit, featureSha);
  assert.equal(cancelled[0]!.summary, "add one");
});

test("a key between the two Pending Ctrl+X presses disarms the cancel", async () => {
  const { root } = await pendingCancelRoot();
  const keys = openPending(root);
  keys.handleKey(undefined, { name: "down" }); // select feature (#1)
  keys.handleKey(undefined, { ctrl: true, name: "x" }); // arm
  assert.match(keys.state().flash!, /press Ctrl\+X again to cancel merge #1/);
  keys.handleKey(undefined, { name: "down" }); // an intermediate key moves the arming; also selects clean (#2)
  keys.handleKey(undefined, { ctrl: true, name: "x" }); // now re-arms on the newly selected row, changing nothing
  assert.equal(queuedMerges(root).length, 2, "the intermediate key disarmed the second press");
  assert.match(keys.state().flash!, /press Ctrl\+X again to cancel merge #2/, "the press re-arms the now-selected row");
});

test("a Pending cancel whose queue shifted between arm and confirm refuses without removing", async () => {
  const { root } = await pendingCancelRoot();
  const keys = openPending(root);
  keys.handleKey(undefined, { name: "down" }); // select feature (#1)
  keys.handleKey(undefined, { ctrl: true, name: "x" }); // arm #1
  // Drop feature's queue file externally so the queue shifts: clean is now position 1, so the
  // armed entry no longer sits at the armed position — the confirm must refuse, not remove.
  fs.unlinkSync(queuedMergeFiles(root)[0]!.file);
  keys.handleKey(undefined, { ctrl: true, name: "x" }); // confirm
  await untilFlash(() => keys.state().flash ?? "", /the merge queue changed — try again/);
  assert.deepEqual(queuedMerges(root).map((e) => e.role), ["clean"], "the shifted queue cancels nothing");
  assert.ok(await refSha(root, mergeRefName("clean")), "clean's pin is intact");
});

test("a Pending cancel of a merge the running team is mid-merging is refused with the wait-then-revert wording", async () => {
  const { root, featureSha } = await pendingCancelRoot();
  // A live team (process.pid is alive) whose merge marker names the queued feature entry.
  writeOrchestratorMarker(root, ["feature"]);
  writeMergeMarker(root, { role: "feature", sha: featureSha, summary: "add one", startedAt: Date.now() - 120_000, stage: "reviewing" });
  const keys = openPending(root);
  keys.handleKey(undefined, { name: "down" }); // select feature (#1)
  keys.handleKey(undefined, { ctrl: true, name: "x" }); // arm
  keys.handleKey(undefined, { ctrl: true, name: "x" }); // confirm → in-flight guard
  await untilFlash(() => keys.state().flash ?? "", /is being merged right now — wait for it to land, then `tumwater revert /);
  assert.equal(queuedMerges(root).length, 2, "the in-flight entry is not removed");
  assert.ok(await refSha(root, mergeRefName("feature")), "the pin is intact");
});

test("a Pending cancel is refused when the queued entry is a merge record name but not the marker's own sha", async () => {
  const { root, featureSha } = await pendingCancelRoot();
  // A live team whose marker's own sha differs from the queued feature entry, but whose changes
  // record names it: only the mergeChanges(...).some branch can refuse, not the inFlight.sha match.
  writeOrchestratorMarker(root, ["feature"]);
  writeMergeMarker(root, {
    role: "feature",
    sha: "f".repeat(40),
    summary: "add one",
    startedAt: Date.now() - 120_000,
    stage: "reviewing",
    changes: [{ role: "feature", sha: featureSha, summary: "add one", status: "merging", startedAt: Date.now() - 120_000, stage: "reviewing" }],
  });
  const keys = openPending(root);
  keys.handleKey(undefined, { name: "down" }); // select feature (#1)
  keys.handleKey(undefined, { ctrl: true, name: "x" }); // arm
  keys.handleKey(undefined, { ctrl: true, name: "x" }); // confirm → record-name in-flight guard
  await untilFlash(() => keys.state().flash ?? "", /is being merged right now — wait for it to land, then `tumwater revert /);
  assert.equal(queuedMerges(root).length, 2, "the recorded in-flight entry is not removed");
  assert.ok(await refSha(root, mergeRefName("feature")), "the pin is intact");
});

test("a Pending top of a merge the running team is mid-merging is refused with the wait-then-revert wording", async () => {
  const { root, cleanSha } = await pendingCancelRoot();
  // A live team whose merge marker names the queued clean entry (#2), so the top passes the
  // already-first and shifted-queue checks and reaches the in-flight guard.
  writeOrchestratorMarker(root, ["clean"]);
  writeMergeMarker(root, { role: "clean", sha: cleanSha, summary: "add two", startedAt: Date.now() - 120_000, stage: "reviewing" });
  const keys = openPending(root);
  keys.handleKey(undefined, { name: "down" }); // feature (#1)
  keys.handleKey(undefined, { name: "down" }); // clean (#2)
  keys.handleKey(undefined, { ctrl: true, name: "v" }); // → in-flight guard
  await untilFlash(() => keys.state().flash ?? "", /is being merged right now — wait for it to land, then `tumwater revert /);
  assert.deepEqual(queuedMerges(root).map((e) => e.role), ["feature", "clean"], "the in-flight entry is not topped");
  assert.equal(eventsOfType(root, "merge_topped").length, 0, "no event for a refused top");
});

test("the Pending pane moves the selected queued merge to the front with Ctrl+V", async () => {
  const { root, cleanSha } = await pendingCancelRoot();
  const keys = openPending(root);
  // Ctrl+V with no selection just tells the operator how to select; the queue is untouched.
  keys.handleKey(undefined, { ctrl: true, name: "v" });
  assert.equal(keys.state().flash, "select a merge with ↑↓ first");
  assert.deepEqual(queuedMerges(root).map((e) => e.role), ["feature", "clean"], "no selection leaves the queue");

  keys.handleKey(undefined, { name: "down" }); // select feature (#1)
  keys.handleKey(undefined, { name: "down" }); // select clean (#2)
  keys.handleKey(undefined, { ctrl: true, name: "v" });
  await untilFlash(() => keys.state().flash ?? "", /moved merge #2 to the front: clean /);
  const after = queuedMerges(root);
  assert.deepEqual(
    after.map((e) => e.role),
    ["clean", "feature"],
    "the selected entry is now the head and the rest keep their order",
  );
  assert.equal(after[0]!.sha, cleanSha, "every entry field rides the renamed file");
  assert.equal(after[0]!.run, 2);
  assert.equal(keys.state().selectedQueue, null, "a top returns to list mode");
  assert.equal(keys.state().queueDetail, "", "a top clears the detail");
  const topped = eventsOfType(root, "merge_topped");
  assert.equal(topped.length, 1, "exactly one merge_topped event is logged");
  assert.equal(topped[0]!.source, "clean");
  assert.equal(topped[0]!.commit, cleanSha);
});

test("the Pending pane's Ctrl+V on position 1 flashes already-first and changes nothing", async () => {
  const { root } = await pendingCancelRoot();
  const keys = openPending(root);
  keys.handleKey(undefined, { name: "down" }); // select feature (#1)
  keys.handleKey(undefined, { ctrl: true, name: "v" });
  await untilFlash(() => keys.state().flash ?? "", /merge #1 is already at the front/);
  assert.deepEqual(queuedMerges(root).map((e) => e.role), ["feature", "clean"], "the queue is untouched");
  assert.equal(eventsOfType(root, "merge_topped").length, 0, "no event for a no-op");
});

test("the Pending pane's Ctrl+V still opens the attach editor on the Activity view", async () => {
  const { root } = await pendingCancelRoot();
  const keys = openPending(root);
  // openPending ends on Pending (view 5). Cycle back to Activity (view 0), where Ctrl+V must
  // still open the attach editor rather than be swallowed by the new Pending arm.
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 0, "we are back on Activity");
  assert.equal(keys.state().attachMode, false, "sanity: no attach editor open yet");
  keys.handleKey(undefined, { ctrl: true, name: "v" });
  assert.equal(keys.state().attachMode, true, "Ctrl+V on Activity opens the attach editor");
  assert.deepEqual(queuedMerges(root).map((e) => e.role), ["feature", "clean"], "the queue is untouched");
});

/** A single non-rejected post-merge review entry on a repo, so the Pending pane has a review
 * row to select below its merge rows. */
function seedReview(root: string, commit: string, role: string, summary: string, extra: Record<string, unknown> = {}): void {
  writeJsonFile(postReviewPath(root), { pending: [{ commit, role, summary, ...extra }] });
}

test("the Pending pane selects a post-merge review after the merge rows and Ctrl+A twice accepts it", async () => {
  const { root } = await pendingCancelRoot();
  const commit = "b".repeat(40);
  seedReview(root, commit, "feature", "review me", { failures: 1 });
  const keys = openPending(root);
  // ↓ over the two merges to the single review row (position 1 in the review list).
  keys.handleKey(undefined, { name: "down" });
  keys.handleKey(undefined, { name: "down" });
  keys.handleKey(undefined, { name: "down" });
  assert.equal(keys.state().selectedQueue, 2, "the review is the pane's third row");
  assert.match(keys.state().queueDetail, /^review #1 \(Ctrl\+A to accept\): feature /);
  assert.ok(keys.state().queueDetail.includes("[1 failed review run]"), "the review detail carries the status suffix");

  keys.handleKey(undefined, { ctrl: true, name: "a" }); // first press arms
  assert.match(keys.state().flash!, /press Ctrl\+A again to accept review #1/);
  assert.equal(readPostReviews(root).length, 1, "the first press changes nothing");

  keys.handleKey(undefined, { ctrl: true, name: "a" }); // second press confirms (async)
  await untilFlash(() => keys.state().flash ?? "", /accepted post-merge review of /);
  assert.ok(keys.state().flash!.includes(shortSha(commit)), "the flash names the accepted short sha");
  assert.deepEqual(readPostReviews(root), [], "the accepted entry is gone from the queue");
  const warnings = eventsOfType(root, "warning").filter((e) => String(e.message).includes(shortSha(commit)));
  assert.equal(warnings.length, 1, "exactly one warning names the accepted sha");
  assert.equal(keys.state().selectedQueue, null, "an accept returns to list mode");
});

test("a rejected Pending review row cannot be accepted with Ctrl+A", async () => {
  const { root } = await pendingCancelRoot();
  const commit = "b".repeat(40);
  seedReview(root, commit, "feature", "bad change", { rejected: ["no tests"] });
  const keys = openPending(root);
  keys.handleKey(undefined, { name: "down" }); // feature (#1)
  keys.handleKey(undefined, { name: "down" }); // clean (#2)
  keys.handleKey(undefined, { name: "down" }); // review #1
  keys.handleKey(undefined, { ctrl: true, name: "a" }); // arm
  keys.handleKey(undefined, { ctrl: true, name: "a" }); // confirm → refused
  await untilFlash(() => keys.state().flash ?? "", /rejected and waiting on its revert/);
  assert.equal(readPostReviews(root).length, 1, "the rejected entry is not removed");
  assert.equal(eventsOfType(root, "warning").filter((e) => String(e.message).includes(shortSha(commit))).length, 0, "no accept warning for a rejected entry");
});

test("Ctrl+A on a Pending merge row and Ctrl+X on a review row name the right action and change nothing", async () => {
  const { root } = await pendingCancelRoot();
  const commit = "b".repeat(40);
  seedReview(root, commit, "feature", "review me");
  const keys = openPending(root);
  keys.handleKey(undefined, { name: "down" }); // select merge #1 (feature)
  keys.handleKey(undefined, { ctrl: true, name: "a" });
  assert.match(keys.state().flash!, /queued merge — Ctrl\+X/);
  assert.deepEqual(queuedMerges(root).map((e) => e.role), ["feature", "clean"], "the merge queue is untouched");
  assert.equal(readPostReviews(root).length, 1, "the review queue is untouched");
  keys.handleKey(undefined, { name: "down" }); // clean (#2)
  keys.handleKey(undefined, { name: "down" }); // review #1
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.match(keys.state().flash!, /post-merge review — Ctrl\+A/);
  assert.deepEqual(queuedMerges(root).map((e) => e.role), ["feature", "clean"], "the merge queue is still untouched");
  assert.equal(readPostReviews(root).length, 1, "the review queue is still untouched");
});

test("a key between the two Pending Ctrl+A presses disarms the accept", async () => {
  const { root } = await pendingCancelRoot();
  const first = "b".repeat(40);
  const second = "c".repeat(40);
  writeJsonFile(postReviewPath(root), { pending: [{ commit: first, role: "feature", summary: "one" }, { commit: second, role: "clean", summary: "two" }] });
  const keys = openPending(root);
  keys.handleKey(undefined, { name: "down" }); // feature (#1)
  keys.handleKey(undefined, { name: "down" }); // clean (#2)
  keys.handleKey(undefined, { name: "down" }); // review #1
  keys.handleKey(undefined, { ctrl: true, name: "a" }); // arm review #1
  assert.match(keys.state().flash!, /press Ctrl\+A again to accept review #1/);
  keys.handleKey(undefined, { name: "down" }); // an intermediate key moves the arming; now on review #2
  keys.handleKey(undefined, { ctrl: true, name: "a" }); // now re-arms on the newly selected row, changing nothing
  assert.equal(readPostReviews(root).length, 2, "the intermediate key disarmed the second press");
  assert.match(keys.state().flash!, /press Ctrl\+A again to accept review #2/, "the press re-arms the now-selected row");
});

test("pendingOverlapsText states an empty overlap list and omits a no-base one", () => {
  assert.equal(
    pendingOverlapsText({ mainBranch: "main", state: "ready", overlaps: [] }),
    "no file is touched by two pending changes",
  );
  assert.equal(pendingOverlapsText({ mainBranch: "trunk", state: "no-base", overlaps: [] }), "");
});

test("a rejecting overlaps collector keeps the Pending queue and flashes the error", async () => {
  const keys = createTuiKeys({
    root: makeRoot(),
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectPending: () => Promise.resolve({ mainBranch: "main", roles: [] }),
    collectOverlaps: () => Promise.reject(new Error("boom")),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 5; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending
  await new Promise((r) => setImmediate(r));
  assert.equal(keys.state().paneCache, "merge queue empty");
  assert.equal(keys.state().flash, "error: boom");
});

test("Ctrl+N cycles transcript → notes → change and back, caching the collector's render", async () => {
  const root = makeRoot();
  const view = {
    role: "clean",
    branch: "tumwater/clean",
    mainBranch: "main",
    state: "ready" as const,
    ahead: 2,
    behind: 0,
    commits: [{ sha: "abc1234", subject: "add a thing" }],
    diff: "",
    dirtyFiles: ["a.ts"],
    uncommittedDiff: "",
  };
  let resolveChange!: (v: typeof view) => void;
  const pending = new Promise<typeof view>((resolve) => (resolveChange = resolve));
  let renders = 0;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => (renders += 1),
    now: () => 0,
    collectChange: () => pending,
  });
  keys.syncSnapshot(0, false, ["clean"], false);
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → transcript
  assert.equal(keys.state().view, 1);

  keys.handleKey(undefined, { ctrl: true, name: "n" }); // transcript → notes
  assert.equal(keys.state().noteMode, true);
  assert.equal(keys.state().changeMode, false);

  keys.handleKey(undefined, { ctrl: true, name: "n" }); // notes → change
  assert.equal(keys.state().noteMode, false, "the notes mode and snapshot drop");
  assert.equal(keys.state().noteCache, null);
  assert.equal(keys.state().changeMode, true);
  assert.equal(keys.state().changeCache, null, "the loading state until the collector resolves");

  const before = renders;
  resolveChange(view);
  await pending;
  assert.equal(keys.state().changeCache, renderRoleChange(view));
  assert.ok(renders > before, "the resolution repaints the pane");

  keys.handleKey(undefined, { ctrl: true, name: "n" }); // change → transcript
  assert.equal(keys.state().changeMode, false);
  assert.equal(keys.state().changeCache, null);
  assert.equal(keys.state().noteMode, false);
  assert.equal(keys.state().noteCache, null);
});

test("Ctrl+T leaves change mode, and a resolution after a cycle away does not cache", async () => {
  const root = makeRoot();
  const view = {
    role: "clean",
    branch: "tumwater/clean",
    mainBranch: "main",
    state: "ready" as const,
    ahead: 0,
    behind: 0,
    commits: [],
    diff: "",
    dirtyFiles: [],
    uncommittedDiff: "",
  };
  let resolveLate!: (v: typeof view) => void;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectChange: () => new Promise<typeof view>((resolve) => (resolveLate = resolve)),
  });
  keys.syncSnapshot(0, false, ["clean"], false);
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → transcript
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // → notes
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // → change
  assert.equal(keys.state().changeMode, true);

  keys.handleKey(undefined, { ctrl: true, name: "t" }); // cycle away, still in flight
  assert.equal(keys.state().changeMode, false, "Ctrl+T drops the change mode");
  assert.equal(keys.state().changeCache, null);

  resolveLate(view);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(keys.state().changeCache, null, "a late resolution does not write the dropped cache");
});

test("Ctrl+Y on the Transcript change step toggles the diffstat, and a cycle away starts on the full patch", async () => {
  const root = makeRoot();
  const view = {
    role: "clean",
    branch: "tumwater/clean",
    mainBranch: "main",
    state: "ready" as const,
    ahead: 2,
    behind: 0,
    commits: [{ sha: "abc1234", subject: "add a thing" }],
    diff: "a.ts | 3 +--",
    dirtyFiles: ["a.ts"],
    uncommittedDiff: "",
  };
  const statView = { ...view, diff: "a.ts | 1 +", uncommittedDiff: "" };
  // The collector stub records every call's opts and returns a fresh pending promise per call, so
  // the test controls resolution order — the same shape the superseded-load test below relies on.
  const calls: Array<{ opts?: { stat?: boolean } }> = [];
  const resolvers: Array<(v: typeof view) => void> = [];
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectChange: (_r, _role, opts) => {
      calls.push({ opts });
      return new Promise<typeof view>((resolve) => resolvers.push(resolve));
    },
  });
  keys.syncSnapshot(0, false, ["clean"], false);
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → transcript
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // → notes
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // → change
  assert.equal(keys.state().changeMode, true);
  assert.equal(keys.state().changeStat, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.opts, undefined, "the first change-step load asks for the full patch");

  keys.handleKey(undefined, { ctrl: true, name: "y" }); // → stat
  assert.equal(keys.state().changeStat, true, "Ctrl+Y flips the diffstat on");
  assert.equal(keys.state().changeCache, null, "the toggle clears the cached render for the loading note");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.opts, { stat: true }, "the second load asks for the diffstat");

  resolvers[1]!(statView);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(keys.state().changeCache, renderRoleChange(statView));

  // Leave the change step while the diffstat is shown: the pane resets on the way out, so a
  // fresh entry starts on the full patch again.
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // change → transcript, leaves while stat is on
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // transcript → notes
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // notes → change
  assert.equal(keys.state().changeStat, false, "leaving the change step while the diffstat is shown resets the toggle");
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.opts, undefined, "the fresh entry's load asks for the full patch");

  // Ctrl+Y still flips the diffstat on and back off on a live change step, starting each
  // fresh entry from the full patch.
  keys.handleKey(undefined, { ctrl: true, name: "y" }); // → stat
  assert.equal(keys.state().changeStat, true, "Ctrl+Y on the fresh entry flips the diffstat on");
  keys.handleKey(undefined, { ctrl: true, name: "y" }); // back to the full patch
  assert.equal(keys.state().changeStat, false, "a later Ctrl+Y flips the diffstat back off");
  assert.equal(calls.length, 5);
  assert.equal(calls[4]!.opts, undefined, "a later Ctrl+Y asks for the full patch");
});

test("a superseded change-step load never paints over the newer one", async () => {
  const root = makeRoot();
  const view = {
    role: "clean",
    branch: "tumwater/clean",
    mainBranch: "main",
    state: "ready" as const,
    ahead: 2,
    behind: 0,
    commits: [{ sha: "abc1234", subject: "add a thing" }],
    diff: "a.ts | 3 +--",
    dirtyFiles: ["a.ts"],
    uncommittedDiff: "",
  };
  const statView = { ...view, diff: "a.ts | 1 +", uncommittedDiff: "" };
  const calls: Array<{ opts?: { stat?: boolean } }> = [];
  const resolvers: Array<(v: typeof view) => void> = [];
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectChange: (_r, _role, opts) => {
      calls.push({ opts });
      return new Promise<typeof view>((resolve) => resolvers.push(resolve));
    },
  });
  keys.syncSnapshot(0, false, ["clean"], false);
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → transcript
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // → notes
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // → change, full-patch load held
  assert.equal(calls.length, 1);

  keys.handleKey(undefined, { ctrl: true, name: "y" }); // → stat, supersedes the full load
  assert.equal(calls.length, 2);
  assert.equal(keys.state().changeStat, true);

  resolvers[1]!(statView); // the newer stat load resolves first
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(keys.state().changeCache, renderRoleChange(statView));
  resolvers[0]!(view); // the older full-patch load resolves late
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(keys.state().changeCache, renderRoleChange(statView), "the stale full patch does not paint over the stat view");
  assert.equal(keys.state().changeStat, true);
});

test("Ctrl+Y off the change step falls through to History: inert on the live transcript, cycling the Summary there", async () => {
  const root = makeRoot();
  const calls: Array<{ opts?: { stat?: boolean } }> = [];
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    collectChange: (_r, _role, opts) => {
      calls.push({ opts });
      return new Promise<never>(() => {});
    },
  });
  keys.syncSnapshot(0, false, ["clean"], false);
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → transcript (live)
  keys.handleKey(undefined, { ctrl: true, name: "y" });
  assert.equal(keys.state().changeStat, false, "Ctrl+Y on the live transcript does not flip the diffstat");
  assert.equal(calls.length, 0, "no change collector runs off the change step");
  assert.equal(keys.state().historySummary, "role", "the History fallthrough still toggles the Summary label off-view");
  // Reach History (view roleIds.length + 4 = 5) and cycle its Summary: the router still reaches it.
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // backlog → usage → failures → history
  assert.equal(keys.state().view, 5);
  keys.handleKey(undefined, { ctrl: true, name: "y" });
  assert.equal(keys.state().historySummary, "model", "on History Ctrl+Y still cycles the Summary table");
  assert.equal(calls.length, 0, "still no change collector ran");
});

test("the Queued pane caches the CLI's rendered queue list on entry and drops it on a cycle away", () => {
  const root = makeRoot();
  enqueuePrompt(root, "director text");
  enqueueRolePrompt(root, "clean", "clean text");
  const t = Date.now();
  const { keys } = makeKeys(root, () => t);
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Queued
  assert.equal(keys.state().view, 6);
  assert.equal(
    keys.state().paneCache,
    renderQueuedList(queuedListRows(root, null, listWideScope(root)), t),
    "the pane caches the same director-first list the CLI prints",
  );
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Brief
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Activity
  assert.equal(keys.state().view, 0);
  assert.equal(keys.state().paneCache, null, "leaving Queued drops the cache");
});

test("PgDn in a searched Inbox pane reaches the last row despite the search line", () => {
  const root = makeRoot();
  for (let i = 1; i <= 8; i++) enqueuePrompt(root, `director widget ${i}`);
  const t = Date.now();
  const { keys } = makeKeys(root, () => t);
  keys.setLineBudgets(5, 4);
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Inbox
  keys.handleKey("/", { name: "/" });
  for (const ch of "widget") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { name: "pagedown" });
  const total = (keys.state().paneCache ?? "").split("\n").length;
  assert.equal(keys.state().paneScroll, total - 4, "the window pages by the list budget (budget 5 less the search line)");
});

test("the `/` search filters the Inbox pane's queued prompts under their unfiltered numbers, clears, and persists across view cycling", () => {
  const root = makeRoot();
  enqueuePrompt(root, "director alpha");
  enqueuePrompt(root, "director widget");
  enqueueRolePrompt(root, "clean", "clean widget");
  const t = Date.now();
  const { keys } = makeKeys(root, () => t);
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Inbox
  assert.equal(keys.state().view, 6);
  assert.equal(keys.state().queuedGrep, null, "the Inbox pane opens unsearched");

  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "", "an empty Inbox search opens blank");
  for (const ch of "widget") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().queuedGrep, "widget");
  assert.deepEqual(keys.state().queuedRows.map((r) => `${r.role}#${r.position}`), ["director#2", "clean#1"]);
  assert.ok(keys.state().paneCache?.includes("2. director widget"));
  assert.ok(!keys.state().paneCache?.includes("director alpha"));
  assert.equal(keys.state().flash, 'search: "widget"');

  // Ctrl+X on the first kept row cancels the director's #2 file; alpha stays queued.
  keys.handleKey(undefined, { name: "down" });
  assert.equal(keys.state().selectedQueued, 0);
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.deepEqual(
    queuedListRows(root, null, listWideScope(root)).map((r) => r.text),
    ["director alpha", "clean widget"],
  );

  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "widget", "re-opening pre-fills the applied pattern");
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().queuedGrep, "widget", "Esc leaves the applied pattern");

  for (let i = 0; i < 9; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // away and back
  assert.equal(keys.state().view, 6);
  assert.equal(keys.state().queuedGrep, "widget", "cycling keeps the applied pattern");
  assert.deepEqual(keys.state().queuedRows.map((r) => r.text), ["clean widget"]);

  keys.handleKey("/", { name: "/" });
  keys.handleKey(undefined, { ctrl: true, name: "u" });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().queuedGrep, null, "an empty line clears the search");
  assert.equal(keys.state().queuedRows.length, 2, "every remaining row shows again");
});

test("the Queued pane selects rows, cancels through cancelRolePrompt, and clamps the selection", () => {
  const root = makeRoot();
  enqueuePrompt(root, "director text");
  enqueueRolePrompt(root, "clean", "clean one");
  enqueueRolePrompt(root, "clean", "clean two");
  const t = Date.now();
  const { keys } = makeKeys(root, () => t);
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Queued
  assert.equal(keys.state().view, 6);
  assert.equal(keys.state().selectedQueued, null, "the pane opens in list mode");
  assert.equal(keys.state().queuedRows.length, 3, "the rows carry the whole queue");

  // Ctrl+X with no selection leaves the queue untouched.
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(queuedListRows(root, null, listWideScope(root)).length, 3);

  keys.handleKey(undefined, { name: "down" });
  assert.equal(keys.state().selectedQueued, 0, "Down selects the first row");
  keys.handleKey(undefined, { name: "down" });
  keys.handleKey(undefined, { name: "down" });
  assert.equal(keys.state().selectedQueued, 2, "Down wraps through the rows");

  // Esc returns to list mode without touching the queue.
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().selectedQueued, null, "Esc returns to list mode");
  assert.equal(queuedListRows(root, null, listWideScope(root)).length, 3);

  // Cycling away and back starts in list mode with no selection.
  keys.handleKey(undefined, { name: "down" });
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Brief
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Activity
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Queued
  assert.equal(keys.state().selectedQueued, null, "re-entering the pane drops the selection");

  // Select the director row (index 0) and cancel its per-role position 1.
  keys.handleKey(undefined, { name: "down" });
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.match(keys.state().flash!, /cancelled inbox message #1 for director/);
  assert.equal(keys.state().queuedRows.length, 2);
  assert.deepEqual(keys.state().queuedRows.map((r) => r.role), ["clean", "clean"]);
  assert.equal(keys.state().selectedQueued, 0, "the selection clamps to the remaining rows");
  assert.equal(
    keys.state().paneCache,
    renderQueuedList(queuedListRows(root, null, listWideScope(root)), t),
    "the cached list refreshes to the CLI's remaining list",
  );

  // Move to the second clean prompt (now position 2) and cancel it.
  keys.handleKey(undefined, { name: "down" });
  assert.equal(keys.state().selectedQueued, 1);
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.match(keys.state().flash!, /cancelled inbox message #2 for clean/);
  assert.deepEqual(keys.state().queuedRows.map((r) => r.text), ["clean one"]);

  // Cancelling the last prompt empties the queue and clears the selection.
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().queuedRows.length, 0);
  assert.equal(keys.state().selectedQueued, null, "an emptied queue clears the selection");
  assert.equal(keys.state().paneCache, "");
});

test("the Queued pane moves the selected prompt to the head of its role's queue with Ctrl+V", () => {
  const root = makeRoot();
  enqueuePrompt(root, "director text");
  enqueueRolePrompt(root, "clean", "clean one");
  enqueueRolePrompt(root, "clean", "clean two");
  const t = Date.now();
  const { keys } = makeKeys(root, () => t);
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Queued
  assert.equal(keys.state().view, 6);
  assert.equal(keys.state().selectedQueued, null, "the pane opens in list mode");

  // Ctrl+V with no selection leaves the queue untouched (the backlog pane shares the key).
  keys.handleKey(undefined, { ctrl: true, name: "v" });
  assert.deepEqual(queuedListRows(root, null, listWideScope(root)).map((r) => r.text), ["director text", "clean one", "clean two"]);

  // Select the second clean row (position 2 of clean's queue) and promote it to the head.
  keys.handleKey(undefined, { name: "down" }); // director
  keys.handleKey(undefined, { name: "down" }); // clean one
  keys.handleKey(undefined, { name: "down" }); // clean two
  assert.equal(keys.state().selectedQueued, 2);
  keys.handleKey(undefined, { ctrl: true, name: "v" });
  const movedRows = queuedListRows(root, null, listWideScope(root));
  assert.deepEqual(movedRows.map((r) => [`${r.role}#${r.position}`, r.text]), [
    ["director#1", "director text"],
    ["clean#1", "clean two"],
    ["clean#2", "clean one"],
  ], "the second clean prompt moves to the head of clean's queue; the director's queue is untouched");
  assert.equal(movedRows[1]!.text, "clean two", "the moved prompt's text is byte-identical");
  assert.match(keys.state().flash!, /moved inbox message #2 for clean to the top: clean two/);
  assert.equal(keys.state().selectedQueued, null, "a move returns the pane to list mode");
  assert.equal(
    keys.state().paneCache,
    renderQueuedList(queuedListRows(root, null, listWideScope(root)), t),
    "the cached list refreshes to the CLI's reordered list",
  );

  // Ctrl+V on a role's position-1 row flashes "already first" and leaves every order unchanged.
  keys.handleKey(undefined, { name: "escape" });
  keys.handleKey(undefined, { name: "down" }); // director row (position 1 of its queue)
  keys.handleKey(undefined, { ctrl: true, name: "v" });
  assert.match(keys.state().flash!, /inbox message #1 for director is already first/);
  assert.deepEqual(queuedListRows(root, null, listWideScope(root)).map((r) => r.text), ["director text", "clean two", "clean one"]);

  // A row whose file vanishes between listing and reading (the concurrent-dequeue race
  // inbox-top's own gone test injects) flashes the gone notice, leaves every order unchanged,
  // and returns the pane to list mode. The read inside movePromptToTop faults once and then
  // falls through, so the refreshing list still reads normally.
  keys.handleKey(undefined, { name: "escape" });
  keys.handleKey(undefined, { name: "down" }); // director
  keys.handleKey(undefined, { name: "down" }); // clean two (now position 1)
  keys.handleKey(undefined, { name: "down" }); // clean one (position 2)
  assert.equal(keys.state().selectedQueued, 2);
  let undo = () => {};
  undo = patchFsMethod("readFileSync", (_orig) => (_args) => {
    undo(); // restore before the first read fails, so the refreshed list still reads
    throw errnoError("ENOENT");
  });
  keys.handleKey(undefined, { ctrl: true, name: "v" });
  assert.match(keys.state().flash!, /inbox message #2 for clean was already gone/);
  assert.deepEqual(queuedListRows(root, null, listWideScope(root)).map((r) => r.text), ["director text", "clean two", "clean one"]);
  assert.equal(keys.state().selectedQueued, null, "a gone move returns the pane to list mode");
});

test("the Queued pane edits the selected prompt in place through editQueuedFile", () => {
  const root = makeRoot();
  const deferral = Date.now() + 3_600_000;
  enqueuePrompt(root, "director text");
  const file = enqueueRolePrompt(root, "clean", "clean first", deferral);
  const base = path.basename(file);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, [], false);
  for (const ch of "draft") keys.handleKey(ch, { name: ch });
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Queued
  keys.handleKey(undefined, { name: "down" }); // the director row
  keys.handleKey(undefined, { name: "down" }); // the deferred clean row
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.deepEqual(keys.state().queuedEditFor, { role: "clean", file: base });
  assert.equal(keys.state().input, "clean first", "the line is prefilled with the body minus the marker");
  assert.equal(keys.state().cursor, "clean first".length);
  assert.match(keys.state().flash!, /editing inbox message #1 for clean/);

  // Whitespace-only input flashes and stays in the editor.
  keys.handleKey(undefined, { ctrl: true, name: "u" });
  keys.handleKey(" ", { name: " " });
  keys.handleKey(undefined, { name: "return" });
  assert.deepEqual(keys.state().queuedEditFor, { role: "clean", file: base }, "an empty body stays in the editor");
  assert.match(keys.state().flash!, /prompt text is empty/);

  // Enter writes the new body back to the same file; the deferral marker survives.
  keys.handleKey(undefined, { ctrl: true, name: "u" });
  for (const ch of "clean edited") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().queuedEditFor, null, "a saved edit leaves the editor");
  assert.match(keys.state().flash!, /edited inbox message for clean/);
  const row = keys.state().queuedRows.find((r) => r.role === "clean")!;
  assert.equal(row.file, base, "the same queue file was rewritten in place");
  assert.equal(row.position, 1, "the entry keeps its position");
  assert.equal(row.text, "clean edited");
  const raw = fs.readFileSync(path.join(root, ".tumwater", "inbox", "clean", base), "utf8");
  assert.equal(notBeforeMs(raw), deferral, "the deferral marker survives the rewrite");

  // Re-enter and Esc restores the saved director draft without writing.
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().input, "clean edited");
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().queuedEditFor, null);
  assert.equal(keys.state().input, "draft", "Esc restores the saved director draft");
  assert.equal(readQueuedPromptBody(root, "clean", base), "clean edited", "Esc writes nothing");
});

test("the Queued edit editor is inert to Ctrl+T and a gone file flashes on save", () => {
  const root = makeRoot();
  const file = enqueueRolePrompt(root, "clean", "keep me");
  const base = path.basename(file);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Queued
  assert.equal(keys.state().reportSince, null);
  keys.handleKey(undefined, { ctrl: true, name: "e" }); // list mode: the report window advances
  assert.equal(keys.state().reportSince, "1h", "Ctrl+E with no selection advances the report window");

  keys.handleKey(undefined, { name: "down" }); // select the clean row
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.deepEqual(keys.state().queuedEditFor, { role: "clean", file: base });

  // Ctrl+T leaves the editor without writing; the queued body is untouched.
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().queuedEditFor, null, "Ctrl+T leaves the queued editor");
  assert.equal(readQueuedPromptBody(root, "clean", base), "keep me", "Ctrl+T writes nothing");

  // Re-enter (Ctrl+T left for Health, so one more lap), remove the file from disk, and Enter
  // flashes the gone notice.
  for (let i = 0; i < 8; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Queued
  keys.handleKey(undefined, { name: "down" });
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  fs.unlinkSync(path.join(root, ".tumwater", "inbox", "clean", base));
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().queuedEditFor, null, "a gone file leaves the editor");
  assert.match(keys.state().flash!, /the inbox message was already gone/);
});

test("the Queued pane resets the selected row's within-body scroll when the selection moves", () => {
  const root = makeRoot();
  // Two prompts each taller than the entry budget, so the body is scrolled before the move.
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  enqueueRolePrompt(root, "clean", `${lines}\nfirst`);
  enqueueRolePrompt(root, "clean", `${lines}\nsecond`);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, [], false);
  keys.setLineBudgets(5, 4);
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Queued
  keys.handleKey(undefined, { name: "down" }); // select the first row
  keys.handleKey(undefined, { name: "pagedown" }); // scroll into its body
  assert.equal(keys.state().paneScroll, 5, "PgDn advances the body by the event budget");
  keys.handleKey(undefined, { name: "down" }); // move to the second row
  assert.equal(keys.state().selectedQueued, 1);
  assert.equal(keys.state().paneScroll, 0, "the newly selected row opens at its head");
  // Esc back to list mode drops the body offset with the selection.
  keys.handleKey(undefined, { name: "pagedown" });
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().paneScroll, 0, "leaving selection mode resets the body offset");

  // A cancel that clamps the selection onto the previous row also opens it at its head:
  // scroll into the last row, cancel it, and the clamped-in row must not inherit the offset.
  keys.handleKey(undefined, { name: "down" }); // select the first row
  keys.handleKey(undefined, { name: "down" }); // select the second (last) row
  keys.handleKey(undefined, { name: "pagedown" });
  assert.equal(keys.state().paneScroll, 5, "PgDn advances the last row's body");
  keys.handleKey(undefined, { ctrl: true, name: "x" }); // cancel the last row
  assert.equal(keys.state().selectedQueued, 0, "the cancel clamps the selection to the first row");
  assert.equal(keys.state().paneScroll, 0, "the clamped-in row opens at its head");
});

test("a roster-size change shifts the relative panes by the same delta, keeping the selected pane kind", () => {
  const root = makeRoot();
  enqueuePrompt(root, "director text");
  const { keys } = makeKeys(root, () => 0);
  // Empty roster: Queued is 6, Pending 5.
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Queued
  assert.equal(keys.state().view, 6);
  const queuedBody = keys.state().paneCache;
  // The roster grows by one. Queued moves to 7; leaving the view unadjusted makes index 6
  // name Pending while the cached body is still the queued list.
  keys.syncSnapshot(0, false, ["clean"], false);
  assert.equal(keys.state().view, 7, "Queued stays selected when the roster grows");
  assert.equal(keys.state().paneCache, queuedBody, "the cached queued body still matches the selected pane");
  // Pending shifts with it: from 6 (1 role) to 7 (2 roles), not to History at 6.
  keys.syncSnapshot(0, false, ["clean", "feature"], false);
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Brief
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → wrap to Activity
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Pending (2+5)
  assert.equal(keys.state().view, 7);
  keys.syncSnapshot(0, false, ["clean"], false);
  assert.equal(keys.state().view, 6, "Pending stays selected when the roster shrinks");
});

test("a flash notice expires on the injected clock", () => {
  const root = makeRoot();
  let t = 1_000_000;
  const { keys } = makeKeys(root, () => t);
  keys.syncSnapshot(0, true, []); // budget-free: Ctrl+B flashes instead of opening the editor
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().flash, "budget n/a — all models free");
  assert.equal(keys.state().budgetMode, false, "the notice replaces the editor, line untouched");
  t += 3000; // FLASH_MS has passed
  assert.equal(keys.state().flash, null, "the expired notice drops out of the rendered state");
  t -= 1500; // …and a mid-life read still shows it (expiry is a clock comparison, not a timer)
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().flash, "budget n/a — all models free");
});

test("Ctrl+D quits through the dep, Ctrl+C flashes a no-task notice, and the modes are mutually exclusive", () => {
  const root = makeRoot();
  const { keys, quitCount } = makeKeys(root, () => 0);
  keys.handleKey(undefined, { ctrl: true, name: "c" });
  assert.equal(quitCount(), 0, "Ctrl+C never quits");
  assert.equal(keys.state().flash, "no director task in flight");
  keys.handleKey(undefined, { ctrl: true, name: "d" });
  assert.equal(quitCount(), 1, "Ctrl+D calls the quit dep and nothing else");

  keys.syncSnapshot(0, false, ["clean"]);
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → transcript
  keys.handleKey(undefined, { ctrl: true, name: "r" }); // role-prompt mode open
  keys.handleKey(undefined, { ctrl: true, name: "b" }); // budget refused
  assert.equal(keys.state().rolePromptFor, "clean", "Ctrl+B does not steal the line");
  assert.match(keys.state().flash!, /finish or cancel the prompt for clean first/);
  keys.handleKey(undefined, { name: "escape" }); // leave role mode
  keys.handleKey(undefined, { ctrl: true, name: "b" }); // budget opens now
  assert.equal(keys.state().budgetMode, true);
});

test("Ctrl+C interrupts the director's in-flight run: abort marker when in flight, notice when not", () => {
  const root = makeRoot();
  const { keys, quitCount } = makeKeys(root, () => 0);
  // A live harness marker (this process's pid) so requestAbort passes its liveness gate.
  writeOrchestratorMarker(root, ["director"]);
  keys.syncSnapshot(0, false, ["director"], false);
  keys.handleKey(undefined, { ctrl: true, name: "c" });
  assert.equal(quitCount(), 0, "Ctrl+C quits nothing");
  assert.equal(keys.state().flash, "no director task in flight");
  assert.ok(!fs.existsSync(abortRequestPath(root, "director")), "no marker without a run in flight");

  keys.syncSnapshot(0, false, ["director"], true);
  keys.handleKey(undefined, { ctrl: true, name: "c" });
  assert.equal(quitCount(), 0);
  assert.match(keys.state().flash!, /abort requested for director/);
  assert.ok(fs.existsSync(abortRequestPath(root, "director")), "the abort marker is written");
});

// The ink bridge (PLANS.md "TUI moves to ink, part 2b/3"): ink's useInput hands the
// dispatch an (input, key) pair, the adapter maps it to the readline (str, key) shape
// handleKey was extracted with. One case per mapping family.
test("inkKeyToReadline maps ink's parsed keys to the readline shape the dispatch consumes", () => {
  // Printable text — single chars and whole composed strings — flows through as `str`.
  assert.deepEqual(inkKeyToReadline("x", {}), { str: "x", key: {} });
  assert.deepEqual(inkKeyToReadline(" ", {}), { str: " ", key: {} });
  assert.deepEqual(inkKeyToReadline("check the queue", {}), { str: "check the queue", key: {} });
  // Named keys map to their readline names with no str.
  assert.deepEqual(inkKeyToReadline("", { escape: true }), { str: undefined, key: { name: "escape" } });
  assert.deepEqual(inkKeyToReadline("\r", { return: true }), { str: undefined, key: { name: "return" } });
  assert.deepEqual(inkKeyToReadline("", { backspace: true }), { str: undefined, key: { name: "backspace" } });
  assert.deepEqual(inkKeyToReadline("", { backspace: true, meta: true }), { str: undefined, key: { name: "backspace", meta: true } });
  assert.deepEqual(inkKeyToReadline("", { delete: true }), { str: undefined, key: { name: "delete" } });
  assert.deepEqual(inkKeyToReadline("", { tab: true }), { str: undefined, key: { name: "tab" } });
  assert.deepEqual(inkKeyToReadline("", { upArrow: true }), { str: undefined, key: { name: "up" } });
  assert.deepEqual(inkKeyToReadline("", { downArrow: true }), { str: undefined, key: { name: "down" } });
  assert.deepEqual(inkKeyToReadline("", { leftArrow: true }), { str: undefined, key: { name: "left" } });
  assert.deepEqual(inkKeyToReadline("", { rightArrow: true }), { str: undefined, key: { name: "right" } });
  assert.deepEqual(inkKeyToReadline("", { pageUp: true }), { str: undefined, key: { name: "pageup" } });
  assert.deepEqual(inkKeyToReadline("", { pageDown: true }), { str: undefined, key: { name: "pagedown" } });
  assert.deepEqual(inkKeyToReadline("", { home: true }), { str: undefined, key: { name: "home" } });
  assert.deepEqual(inkKeyToReadline("", { end: true }), { str: undefined, key: { name: "end" } });
  // Ctrl+letter arrives as the bare letter in `input` with `ctrl` set — the dispatch's
  // Ctrl+C/Ctrl+B/Ctrl+T family reads key.ctrl + key.name.
  assert.deepEqual(inkKeyToReadline("c", { ctrl: true }), { str: undefined, key: { ctrl: true, name: "c" } });
  assert.deepEqual(inkKeyToReadline("T", { ctrl: true }), { str: undefined, key: { ctrl: true, name: "t" } });
  // Named keys win before ctrl: ink sets ctrl alongside ctrl+arrows too, and the arrow
  // must still map to its name, not to an empty ctrl+letter.
  assert.deepEqual(inkKeyToReadline("", { ctrl: true, upArrow: true }), { str: undefined, key: { name: "up" } });
  // Alt+letter maps to the meta shape applyKey's kill keys read (and stays out of the
  // printable-insert branch, which excludes meta).
  assert.deepEqual(inkKeyToReadline("x", { meta: true }), { str: undefined, key: { meta: true, name: "x" } });
  // An empty non-key input (ink suppresses text for unrecognized sequences) is inert.
  assert.deepEqual(inkKeyToReadline("", {}), { str: undefined, key: {} });
});

test("arrowDir and pageDir name the vertical direction the dispatch branches steer by", () => {
  // Arrows map to up/down; the other named keys and an undefined name are inert.
  assert.equal(arrowDir("up"), "up");
  assert.equal(arrowDir("down"), "down");
  assert.equal(arrowDir("pageup"), null);
  assert.equal(arrowDir("left"), null);
  assert.equal(arrowDir(undefined), null);
  // PgUp walks up and PgDn walks down — the inversion the scroll branches used to hand-roll.
  assert.equal(pageDir("pageup"), "up");
  assert.equal(pageDir("pagedown"), "down");
  assert.equal(pageDir("up"), null);
  assert.equal(pageDir(undefined), null);
});

// The adapter's output drives the real dispatch: one round-trip case per shape, through
// the same factory the readline path was tested with.
test("the adapter's output drives the dispatch exactly like the readline pairs did", () => {
  const root = makeRoot();
  const { keys, quitCount } = makeKeys(root, () => 0);
  const dispatch = (input: string, key: Parameters<typeof inkKeyToReadline>[1]) => {
    const mapped = inkKeyToReadline(input, key);
    keys.handleKey(mapped.str, mapped.key);
  };
  dispatch("h", {}); // typing
  dispatch("", { escape: true }); // escape outside any mode is inert
  assert.equal(keys.state().input, "h");
  dispatch("", { ctrl: true, upArrow: true }); // ctrl+arrow never moves the prompt cursor
  assert.equal(keys.state().cursor, 1);
  dispatch("", { backspace: true }); // backspace deletes
  assert.equal(keys.state().input, "");
  dispatch("i", {});
  dispatch("", { return: true }); // return submits into the inbox
  assert.equal(keys.state().input, "", "return submits and clears the prompt line");
  dispatch("", { ctrl: true }); // ctrl with empty input maps to an empty ctrl+letter: inert
  dispatch("c", { ctrl: true }); // Ctrl+C is the director interrupt, not a quit
  assert.equal(quitCount(), 0);
  assert.equal(keys.state().flash, "no director task in flight");
  dispatch("d", { ctrl: true }); // Ctrl+D quits through the mapped shape
  assert.equal(quitCount(), 1);
});

test("the backlog pane answers the selected open question through tryAnswerQuestion", () => {
  const root = makeRoot();
  const qPath = path.join(root, "QUESTIONS.md");
  const questions = (a: string, b: string) =>
    `# Questions\n\n## Open\n\n### ${a}\n\nbody a\n\n### ${b}\n\nbody b\n\n## Answered\n\n_None yet._\n`;
  fs.writeFileSync(qPath, questions("First?", "Second?"));
  fs.writeFileSync(path.join(root, "PLANS.md"), "# Plans\n\n## Planned\n\n### A plan\n\nbody\n\n## Done\n\n_None yet._\n");
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, [], false);
  for (const ch of "draft") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { ctrl: true, name: "a" });
  assert.equal(keys.state().answerFor, null, "list mode does not open the editor");
  // With no roles the backlog pane is the second view: one Ctrl+T from Activity.
  const backlogView = (): void => {
    for (let i = 0; i < 12 && keys.state().view !== 1; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
    assert.equal(keys.state().view, 1);
    keys.handleKey(undefined, { name: "down" });
  };
  backlogView();
  assert.notEqual(keys.state().selectedEntry, null, "reached the backlog pane with an entry selected");
  // The plan is first: Ctrl+A flashes and keeps the line.
  for (let i = 0; i < 5 && keys.state().selectedEntry !== 0; i++) keys.handleKey(undefined, { name: "down" });
  const draft = keys.state().input;
  keys.handleKey(undefined, { ctrl: true, name: "a" });
  assert.equal(keys.state().answerFor, null);
  assert.equal(keys.state().flash, "only an open question can be answered here");
  assert.equal(keys.state().input, draft);

  keys.handleKey(undefined, { name: "down" });
  keys.handleKey(undefined, { name: "down" });
  keys.handleKey(undefined, { ctrl: true, name: "a" });
  assert.deepEqual(keys.state().answerFor, { position: 2, title: "Second?" });
  assert.equal(keys.state().input, "");

  // Whitespace-only stays; Ctrl+B and arrows are inert.
  keys.handleKey(" ", { name: "space" });
  keys.handleKey(undefined, { name: "return" });
  assert.match(keys.state().flash!, /needs a decision/);
  assert.notEqual(keys.state().answerFor, null);
  const sel = keys.state().selectedEntry;
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  keys.handleKey(undefined, { name: "up" });
  assert.notEqual(keys.state().answerFor, null);
  assert.equal(keys.state().budgetMode, false);
  assert.equal(keys.state().selectedEntry, sel);

  // Esc restores the draft and writes nothing.
  const before = fs.readFileSync(qPath, "utf8");
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().answerFor, null);
  assert.equal(keys.state().input, draft);
  assert.equal(fs.readFileSync(qPath, "utf8"), before);

  // A question that moved under the editor writes nothing and leaves the editor.
  keys.handleKey(undefined, { ctrl: true, name: "a" });
  fs.writeFileSync(qPath, questions("Other?", "Different?"));
  const moved = fs.readFileSync(qPath, "utf8");
  for (const ch of "go") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(fs.readFileSync(qPath, "utf8"), moved);
  assert.match(keys.state().flash!, /already answered or moved/);
  assert.equal(keys.state().answerFor, null);
  assert.equal(keys.state().selectedEntry, null);
  assert.equal(keys.state().input, draft);

  // Ctrl+T clears an open editor and restores the draft; Enter records the answer.
  fs.writeFileSync(qPath, questions("First?", "Second?"));
  backlogView();
  for (let i = 0; i < 5 && keys.state().selectedEntry !== 2; i++) keys.handleKey(undefined, { name: "down" });
  keys.handleKey(undefined, { ctrl: true, name: "a" });
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().answerFor, null);
  assert.equal(keys.state().input, draft);
  backlogView();
  for (let i = 0; i < 5 && keys.state().selectedEntry !== 2; i++) keys.handleKey(undefined, { name: "down" });
  keys.handleKey(undefined, { ctrl: true, name: "a" });
  for (const ch of "yes") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  const after = fs.readFileSync(qPath, "utf8");
  assert.match(after, /## Answered[\s\S]*### Second\?[\s\S]*\*\*Answered \d{4}-\d{2}-\d{2} by the user:\*\* yes/);
  assert.match(after, /## Open[\s\S]*### First\?[\s\S]*## Answered/);
  assert.equal(keys.state().answerFor, null);
  assert.equal(keys.state().selectedEntry, null);
  assert.match(keys.state().flash!, /answered question #2/);
  assert.equal(keys.state().input, draft);
});

function entryEditRig(bugBody = "line a\n\n  indented line b\n\nline c\n") {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "PLANS.md"), "## Planned\n\n### Plan one (planned 2026-10-02 by test)\n\nbody\n");
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    `## Open\n\n### Bug one (found by test 2026-10-02)\n\n${bugBody}`,
  );
  fs.writeFileSync(path.join(root, "QUESTIONS.md"), "## Open\n\n### A question (asked by test 2026-10-02)\n\nbody\n");
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  const down = (n: number): void => {
    for (let i = 0; i < n; i++) keys.handleKey(undefined, { name: "down" });
  };
  const ctrlE = (): void => keys.handleKey(undefined, { ctrl: true, name: "e" });
  const read = (f: string): string => fs.readFileSync(path.join(root, f), "utf8");
  return { root, keys, down, ctrlE, read };
}

test("backlog Ctrl+E edits the selected bug's title, keeping its stamp and body", () => {
  const { keys, down, ctrlE, read } = entryEditRig();
  down(2); // plan 1, bug 1
  const before = read("BUGS.md");
  ctrlE();
  assert.deepEqual(keys.state().entryEditFor, { kind: "bug", position: 1, title: "Bug one (found by test 2026-10-02)" });
  assert.equal(keys.state().input, "Bug one");
  for (const ch of " renamed") keys.handleKey(ch, { name: ch === " " ? "space" : ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().entryEditFor, null);
  assert.equal(keys.state().input, "");
  assert.match(keys.state().flash ?? "", /edited bug #1/);
  assert.doesNotMatch(keys.state().flash ?? "", /still held/);
  assert.equal(read("BUGS.md"), before.replace("### Bug one (", "### Bug one renamed ("));
});

test("backlog Ctrl+E on a refused bug flashes that it is still held", () => {
  const { keys, down, ctrlE } = entryEditRig("**Refused 2026-10-01 by bugfix: not reproducible**\n");
  down(2);
  ctrlE();
  for (const ch of " renamed") keys.handleKey(ch, { name: ch === " " ? "space" : ch });
  keys.handleKey(undefined, { name: "return" });
  assert.match(keys.state().flash ?? "", /edited bug #1: .* — still held \[blocked: refused\]/);
});

test("backlog Ctrl+E refuses a question, Esc restores the draft, and a blank title stays open", () => {
  const { keys, down, ctrlE, read } = entryEditRig();
  down(3); // plan 1, bug 1, question 1
  const bugs = read("BUGS.md");
  ctrlE();
  assert.equal(keys.state().entryEditFor, null);
  assert.equal(keys.state().flash, "only a plan or open bug can be edited here");
  keys.handleKey(undefined, { name: "up" });
  ctrlE();
  assert.notEqual(keys.state().entryEditFor, null);
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().flash, "finish or cancel the entry edit first (Esc cancels)");
  assert.equal(keys.state().budgetMode, false);
  while (keys.state().input) keys.handleKey(undefined, { name: "backspace" });
  keys.handleKey(" ", { name: "space" });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().flash, "an entry needs a title");
  assert.notEqual(keys.state().entryEditFor, null);
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().entryEditFor, null);
  assert.equal(keys.state().input, "");
  assert.equal(keys.state().flash, "edit cancelled");
  assert.equal(read("BUGS.md"), bugs);
});

test("backlog Ctrl+E on an entry rewritten since the editor opened edits nothing", () => {
  const { root, keys, down, ctrlE, read } = entryEditRig();
  down(2);
  ctrlE();
  const moved = read("BUGS.md").replace("Bug one", "Bug uno");
  fs.writeFileSync(path.join(root, "BUGS.md"), moved);
  keys.handleKey("x", { name: "x" });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().entryEditFor, null);
  assert.equal(keys.state().selectedEntry, null);
  assert.match(keys.state().flash ?? "", /already removed or moved — nothing edited/);
  assert.equal(read("BUGS.md"), moved);
});

test("backlog Ctrl+E saving the pre-filled title says unchanged and commits nothing", async () => {
  const { keys, down, ctrlE, read } = entryEditRig();
  down(2); // plan 1, bug 1
  const before = read("BUGS.md");
  ctrlE();
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().entryEditFor, null);
  assert.match(keys.state().flash ?? "", /unchanged bug #1: Bug one/);
  assert.equal(read("BUGS.md"), before);
  // A commit attempt would flash "NOT committed" once its git call settles (the rig is no repo).
  await sleep(300);
  assert.match(keys.state().flash ?? "", /unchanged bug #1/);
});

test("backlog Ctrl+E twice replaces a bug's title and body from a file, keeping its stamp", () => {
  const { root, keys, down, ctrlE, read } = entryEditRig();
  const type = (text: string): void => {
    for (const ch of text) keys.handleKey(ch, { name: ch === " " ? "space" : ch });
  };
  const rep = path.join(root, "replacement.md");
  fs.writeFileSync(rep, "Bug one rewritten (found by test 2026-10-02)\n\nline a\n\nline b\n");
  const before = read("BUGS.md");
  down(2); // plan 1, bug 1
  ctrlE(); // title editor
  assert.deepEqual(keys.state().entryEditFor, { kind: "bug", position: 1, title: "Bug one (found by test 2026-10-02)" });
  ctrlE(); // second Ctrl+E: the file field
  assert.deepEqual(keys.state().entryEditFor, { kind: "bug", position: 1, title: "Bug one (found by test 2026-10-02)" });
  assert.equal(keys.state().input, "");
  assert.match(keys.state().flash ?? "", /from a file/);
  type(rep);
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().entryEditFor, null);
  assert.match(keys.state().flash ?? "", /edited bug #1/);
  const after = read("BUGS.md");
  assert.match(after, /### Bug one rewritten \(found by test 2026-10-02\)\n\nline a\n\nline b\n$/);
  assert.equal(after.includes("Bug one ("), false);
  assert.notEqual(after, before);
});

test("backlog Ctrl+E file mode: a missing or empty path and a bad body write nothing", () => {
  const { root, keys, down, ctrlE, read } = entryEditRig();
  const type = (text: string): void => {
    for (const ch of text) keys.handleKey(ch, { name: ch === " " ? "space" : ch });
  };
  down(2); // plan 1, bug 1
  ctrlE();
  ctrlE(); // file field
  // Empty path flashes and stays in the file mode.
  keys.handleKey(undefined, { name: "return" });
  assert.match(keys.state().flash ?? "", /a file path is required/);
  assert.notEqual(keys.state().entryEditFor, null);
  // A nonexistent path flashes and writes nothing, leaving the editor open.
  type(path.join(root, "missing.md"));
  const before = read("BUGS.md");
  keys.handleKey(undefined, { name: "return" });
  assert.match(keys.state().flash ?? "", /no such file/);
  assert.notEqual(keys.state().entryEditFor, null);
  assert.equal(read("BUGS.md"), before);
});

test("backlog Ctrl+E file mode refuses a heading-line body and a blank title line", () => {
  const { root, keys, down, ctrlE, read } = entryEditRig();
  const type = (text: string): void => {
    for (const ch of text) keys.handleKey(ch, { name: ch === " " ? "space" : ch });
  };
  down(2);
  ctrlE();
  ctrlE();
  // A body with a `## ` line outside a code fence is refused.
  const bad = path.join(root, "bad.md");
  fs.writeFileSync(bad, "New title\n\n## A fresh section\n");
  type(bad);
  const before = read("BUGS.md");
  keys.handleKey(undefined, { name: "return" });
  assert.match(keys.state().flash ?? "", /heading line/);
  assert.notEqual(keys.state().entryEditFor, null);
  assert.equal(read("BUGS.md"), before);
  // A file whose only line is blank has no title line.
  const blank = path.join(root, "blank.md");
  fs.writeFileSync(blank, "\n");
  while (keys.state().input) keys.handleKey(undefined, { name: "backspace" });
  type(blank);
  keys.handleKey(undefined, { name: "return" });
  assert.match(keys.state().flash ?? "", /needs a title line/);
  assert.notEqual(keys.state().entryEditFor, null);
  assert.equal(read("BUGS.md"), before);
});

test("backlog Ctrl+E a third time returns to the title draft unchanged", () => {
  const { keys, down, ctrlE } = entryEditRig();
  down(2);
  ctrlE();
  for (const ch of " renamed") keys.handleKey(ch, { name: ch === " " ? "space" : ch });
  const draft = keys.state().input;
  ctrlE();
  assert.equal(keys.state().input, "");
  ctrlE();
  assert.equal(keys.state().input, draft);
  assert.match(keys.state().flash ?? "", /title — Enter to save/);
});

test("backlog Ctrl+E with no selection still advances the report window", () => {
  const { keys, ctrlE } = entryEditRig();
  ctrlE();
  assert.equal(keys.state().entryEditFor, null);
});

test("backlog Ctrl+N files a plan by title and wakes the feature role; Ctrl+N again files a bug", () => {
  const { root, keys, read } = entryEditRig();
  const ctrlN = (): void => keys.handleKey(undefined, { ctrl: true, name: "n" });
  const type = (text: string): void => {
    for (const ch of text) keys.handleKey(ch, { name: ch === " " ? "space" : ch });
  };
  const queued = (role: string): string => {
    const dir = path.join(root, ".tumwater", "inbox", role);
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  };
  ctrlN();
  assert.deepEqual(keys.state().entryEditFor, { kind: "plan", position: null, title: "" });
  assert.equal(keys.state().input, "");
  type("brand new");
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().entryEditFor, null);
  assert.match(read("PLANS.md"), /## Planned\n[\s\S]*### brand new \(/);
  assert.equal(keys.state().flash, "filed plan: brand new — woke feature");
  assert.match(queued("feature"), /brand new/);

  ctrlN();
  ctrlN();
  assert.equal(keys.state().entryEditFor?.kind, "bug");
  type("it broke");
  keys.handleKey(undefined, { name: "return" });
  assert.match(read("BUGS.md"), /## Open\n[\s\S]*### it broke \(/);
  assert.match(queued("bugfix"), /it broke/);
});

test("backlog Ctrl+N blank title stays open, Esc cancels and writes nothing", () => {
  const { keys, read } = entryEditRig();
  const plans = read("PLANS.md");
  const bugs = read("BUGS.md");
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().flash, "an entry needs a title");
  assert.notEqual(keys.state().entryEditFor, null);
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().entryEditFor, null);
  assert.equal(keys.state().flash, "new entry cancelled");
  assert.equal(read("PLANS.md"), plans);
  assert.equal(read("BUGS.md"), bugs);
});

test("Ctrl+N off the Backlog view does not open the new-entry editor", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().entryEditFor, null);
});

test("Ctrl+N opens the run-cap editor on Activity, and still files a new entry on the Backlog view", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  // Activity (view 0): Ctrl+N opens the run-cap editor, not the new-entry form.
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().concurrencyMode, true, "Ctrl+N on Activity opens the run-cap editor");
  assert.equal(keys.state().entryEditFor, null);
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().concurrencyMode, false, "Esc closes the run-cap editor");
  // One Ctrl+T (no roles) reaches the Backlog view: Ctrl+N files a new plan there.
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.deepEqual(keys.state().entryEditFor, { kind: "plan", position: null, title: "" }, "on Backlog, Ctrl+N still opens the new-entry form");
  assert.equal(keys.state().concurrencyMode, false, "the backlog Ctrl+N does not open the run-cap editor");
});

test("the Health tab caches renderDoctor of the seam's report, ignores a late resolution, and flashes a rejection", async () => {
  const root = makeRoot();
  const report: DoctorReport = { header: "doctor", checks: [{ level: "ok", name: "node", detail: "fine" }], routing: [], verdict: "healthy" } as DoctorReport;
  let resolveDoctor!: (r: DoctorReport) => void;
  let reject = false;
  let renders = 0;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => (renders += 1),
    now: () => 0,
    runDoctor: () => (reject ? Promise.reject(new Error("boom")) : new Promise<DoctorReport>((resolve) => (resolveDoctor = resolve))),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 7);
  assert.equal(keys.state().paneCache, null, "the loading note shows until the checks resolve");
  const before = renders;
  resolveDoctor(report);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(keys.state().paneCache, renderDoctor(report));
  assert.ok(renders > before);
  // A resolution after cycling away leaves the pane untouched.
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 0);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 0, "a tenth press wraps");
  resolveDoctor(report);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(keys.state().paneCache, null);
  // A rejection flashes and leaves the loading note.
  reject = true;
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(keys.state().paneCache, null);
  assert.match(keys.state().flash ?? "", /boom/);
});

test("Ctrl+O on the Health tab toggles the problems-only view; History keeps its outcome cycle", async () => {
  const root = makeRoot();
  const report: DoctorReport = {
    header: "doctor",
    checks: [
      { level: "ok", name: "node", detail: "fine" },
      { level: "warn", name: "free-disk", detail: "low" },
    ],
    routing: [],
    verdict: "warnings",
  } as DoctorReport;
  let resolveDoctor!: (r: DoctorReport) => void;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    runDoctor: () => new Promise<DoctorReport>((resolve) => (resolveDoctor = resolve)),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  assert.equal(keys.state().view, 7);
  assert.equal(keys.state().healthProblems, false);
  resolveDoctor(report);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(keys.state().paneCache, renderDoctor(report), "Health enters on the full view");
  // One Ctrl+O paints only the warn row and counts the hidden ok row, without its name.
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().healthProblems, true);
  assert.equal(keys.state().paneCache, renderDoctorProblems(report));
  assert.match(keys.state().paneCache ?? "", /free-disk/);
  assert.match(keys.state().paneCache ?? "", /ok check/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /node/);
  // A second Ctrl+O restores the full view.
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().healthProblems, false);
  assert.equal(keys.state().paneCache, renderDoctor(report));
});

test("the Health pane re-runs the doctor checks in place with Ctrl+R, honoring the problems-only toggle", async () => {
  const root = makeRoot();
  const reportA: DoctorReport = {
    header: "doctor",
    checks: [
      { level: "ok", name: "node", detail: "fine" },
      { level: "warn", name: "free-disk", detail: "low" },
    ],
    routing: [],
    verdict: "warnings",
  } as DoctorReport;
  const reportB: DoctorReport = {
    header: "doctor",
    checks: [{ level: "warn", name: "free-disk", detail: "lower" }],
    routing: [],
    verdict: "warnings",
  } as DoctorReport;
  let calls = 0;
  let reject = false;
  let renders = 0;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => (renders += 1),
    now: () => 0,
    runDoctor: () => {
      calls += 1;
      return reject
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(calls === 1 ? reportA : reportB);
    },
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  assert.equal(keys.state().view, 7);
  assert.equal(calls, 1, "entering Health runs the doctor once");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(keys.state().paneCache, renderDoctor(reportA));
  // Ctrl+O first so healthProblems is true: Ctrl+R's resolution paints the problems view.
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().healthProblems, true);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(calls, 2, "a single Ctrl+R re-runs the doctor a second time");
  assert.equal(keys.state().paneCache, null, "a refresh shows the loading note until it resolves");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    keys.state().paneCache,
    renderDoctorProblems(reportB),
    "the refreshed report paints through the problems-only toggle",
  );
  // A rejecting Ctrl+R flashes the error and leaves the loading note.
  reject = true;
  const before = renders;
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(calls, 3, "Ctrl+R re-runs again even after a change");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(keys.state().paneCache, null, "a rejecting refresh leaves the loading note up");
  assert.match(keys.state().flash ?? "", /boom/);
  assert.ok(renders > before);
});

test("Ctrl+P on the Health view re-runs the doctor with every image-input model re-probed", async () => {
  const root = makeRoot();
  const report = { header: "doctor", checks: [{ level: "ok", name: "node", detail: "fine" }], routing: [], verdict: "ok" } as DoctorReport;
  const probes: string[] = [];
  let resolveDoctor: (r: DoctorReport) => void = () => {};
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    runDoctor: (_root, probe) => {
      probes.push(probe);
      return new Promise<DoctorReport>((resolve) => (resolveDoctor = resolve));
    },
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.deepEqual(probes, ["never"]);
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  assert.equal(probes.at(-1), "all");
  assert.equal(probes.length, 2);
  assert.equal(keys.state().paneCache, null);
  assert.match(keys.state().flash ?? "", /re-probing image-input models/);
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  assert.equal(probes.length, 2, "a second Ctrl+P adds no call");
  assert.match(keys.state().flash ?? "", /already running/);
  resolveDoctor(report);
  await settle();
  assert.equal(keys.state().paneCache, renderDoctor(report));
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  assert.deepEqual(probes.slice(2), ["all"]);
  resolveDoctor(report);
  await settle();
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(probes.at(-1), "never");
});

test("Ctrl+P off the Health view never re-probes", () => {
  const root = makeRoot();
  const probes: string[] = [];
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    runDoctor: (_root, probe) => {
      probes.push(probe);
      return new Promise<DoctorReport>(() => {});
    },
  });
  keys.syncSnapshot(0, false, [], false);
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 4);
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  assert.ok(!probes.includes("all"));
});

test("the Brief tab caches renderBrief of the brief file on entry, and holds null with no prompt block", async () => {
  const root = await initializedRepo();
  const { keys } = makeKeys(root, () => 0);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  assert.equal(keys.state().view, 7);
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 8);
  assert.equal(keys.state().paneCache, renderBrief(readBrief(root)!));
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 0);
  assert.equal(keys.state().paneCache, null);

  const bare = makeRoot();
  fs.writeFileSync(path.join(bare, "README.md"), "no prompt block here\n");
  const bareKeys = makeKeys(bare, () => 0).keys;
  for (let i = 0; i < 9; i++) bareKeys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(bareKeys.state().view, 0);
  for (let i = 0; i < 8; i++) bareKeys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(bareKeys.state().view, 8);
  assert.equal(bareKeys.state().paneCache, null);
});

// Ctrl+E on the Brief view replaces the brief from a typed file path — the terminal twin of
// `tumwater brief --file <path>` and the dashboard's Brief card, all through the same
// editBriefText core (and its commit). The open arm is guarded to the Brief view, so the
// Health reclaim and Report window-cycle arms keep Ctrl+E on their own views.
test("the Brief view's Ctrl+E replaces the brief from a typed file path", async () => {
  const root = await initializedRepo();
  const replacement = path.join(root, "replacement.md");
  fs.writeFileSync(replacement, "the replacement brief\n");
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 8; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Brief
  assert.equal(keys.state().view, 8);
  keys.handleKey(undefined, { ctrl: true, name: "e" }); // open the brief editor
  assert.equal(keys.state().briefEditMode, true);
  assert.match(keys.state().flash!, /replace the brief from a file/);
  assert.equal(keys.state().input, "");
  for (const ch of replacement) keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  // The replace commits asynchronously; poll until the editor leaves (the outcome flash only
  // fires once the commit lands, a microtask later, so the git-log read below is safe).
  await waitFor(() => !keys.state().briefEditMode, "the brief editor exits after a successful replace");
  assert.equal(keys.state().briefEditMode, false);
  assert.match(keys.state().flash!, /brief updated in README\.md/);
  assert.equal(readBrief(root)!.prompt, "the replacement brief");
  assert.equal(sh(root, "git", "log", "-1", "--format=%s"), "tumwater(operator): Edit brief");
  // Every refusal and the escape below must leave this (replaced) README byte-identical.
  const replacedReadme = fs.readFileSync(path.join(root, "README.md"), "utf8");

  // An empty path and a missing file flash and keep the editor open (both synchronous, before
  // the core's async write).
  keys.handleKey(undefined, { ctrl: true, name: "e" }); // reopen (the editor exited after success)
  assert.equal(keys.state().briefEditMode, true);
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().briefEditMode, true, "an empty path stays in the brief editor");
  assert.match(keys.state().flash!, /a file path is required/);
  keys.handleKey(undefined, { name: "escape" });

  keys.handleKey(undefined, { ctrl: true, name: "e" });
  for (const ch of path.join(root, "nope.md")) keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().briefEditMode, true, "a missing file stays in the brief editor");
  assert.match(keys.state().flash!, /no such file/);
  keys.handleKey(undefined, { name: "escape" });

  // A whitespace-only replacement, an over-cap one, and one carrying the prompt marker are all
  // refused by editBriefText with the core's wording, staying in the editor. Each refusal
  // flashes asynchronously (inside the core's promise), so await the wording.
  const blank = path.join(root, "blank.md");
  fs.writeFileSync(blank, "   \n");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  for (const ch of blank) keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().briefEditMode, true, "an empty brief stays in the editor");
  await waitFor(() => (keys.state().flash ?? "").includes("the new brief is empty"), "the empty-brief refusal flash");
  keys.handleKey(undefined, { name: "escape" });

  const bigFile = path.join(root, "big.md");
  fs.writeFileSync(bigFile, "x".repeat(5000));
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  for (const ch of bigFile) keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().briefEditMode, true, "an over-cap brief stays in the editor");
  await waitFor(() => (keys.state().flash ?? "").includes("shorten it to at most 4096"), "the over-cap refusal flash");
  keys.handleKey(undefined, { name: "escape" });

  const marker = path.join(root, "marker.md");
  fs.writeFileSync(marker, `contains ${PROMPT_START} marker\n`);
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  for (const ch of marker) keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().briefEditMode, true, "a marker brief stays in the editor");
  await waitFor(() => (keys.state().flash ?? "").includes("contains a tumwater:prompt marker"), "the marker refusal flash");
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), replacedReadme, "every refusal leaves README byte-identical");

  // Esc cancels: restores the saved prompt draft, flashes, and writes nothing.
  for (const ch of "a director draft") keys.handleKey(ch, { name: ch });
  assert.equal(keys.state().input, "a director draft");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(keys.state().input, "", "entering the brief editor blanks the line");
  for (const ch of "other/path.md") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().briefEditMode, false);
  assert.equal(keys.state().input, "a director draft", "Esc restores the saved prompt draft");
  assert.match(keys.state().flash!, /brief edit cancelled/);
  assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), replacedReadme, "Esc writes nothing");
});

// Ctrl+E on the Health view runs one manual reclaim pass — the terminal twin of the dashboard
// disk row's reclaim button, both through the same runManualReclaim (src/operator/
// operator-intent.ts). A live team is asked through the marker it consumes within one poll; with
// none running the pass runs in-process. Every other view keeps Ctrl+E's trailing-window cycle.
test("Ctrl+E on the Health view requests a manual reclaim from a live team", async () => {
  const root = makeRoot();
  writeOrchestratorMarker(root, ["clean"]); // default pid makes the marker live
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health (roleIds.length + 7)
  assert.equal(keys.state().view, 7, "Health is roleIds.length + 7");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fs.existsSync(reclaimRequestPath(root)), true, "the marker a live team consumes is on disk");
  assert.match(keys.state().flash!, /reclaim requested/);
});

test("Ctrl+E on the Health view runs an in-process reclaim with no live team", async () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  await Promise.resolve();
  await Promise.resolve();
  assert.match(keys.state().flash!, /nothing to reclaim/);
  assert.equal(fs.existsSync(reclaimRequestPath(root)), false, "no live team, so no marker is written");
});

test("Ctrl+E on the Activity view writes no reclaim marker", async () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  assert.equal(keys.state().view, 0, "starts on Activity");
  keys.handleKey(undefined, { ctrl: true, name: "e" });
  assert.equal(fs.existsSync(reclaimRequestPath(root)), false, "Activity's Ctrl+E writes no reclaim marker");
});

// Ctrl+N on the Health view runs the saved notify hook once with the synthetic test event — the
// terminal twin of `tumwater notify --test` and the dashboard Settings card's Send test, both
// reached through the same testNotifyHook (src/cli/notify-command.ts). The hook's stdio is
// "ignore" (the dashboard's choice) so a chatty hook's output cannot corrupt the alternate
// screen; the running notice flashes first, then the outcome once the hook exits.
test("Ctrl+N on the Health view runs the notify hook once and flashes the outcome", async () => {
  const root = makeRoot();
  const out = path.join(root, "notify-out.txt");
  const set = setConfigKey(
    root,
    "notify",
    `echo "$TUMWATER_EVENT_TYPE|$TUMWATER_EVENT_SOURCE|$TUMWATER_EVENT_MESSAGE" >> ${out}`,
  );
  assert.ok(set.ok, `setConfigKey failed: ${set.ok ? "" : set.error}`);
  const report: DoctorReport = {
    header: "doctor",
    checks: [{ level: "ok", name: "node", detail: "fine" }],
    routing: [],
    verdict: "ok",
  } as DoctorReport;
  let resolveDoctor!: (r: DoctorReport) => void;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    runDoctor: () => new Promise<DoctorReport>((resolve) => (resolveDoctor = resolve)),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  assert.equal(keys.state().view, 7);
  resolveDoctor(report);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(keys.state().paneCache, renderDoctor(report));
  // Ctrl+N flashes the running notice first, then the outcome when the spawned hook exits.
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.match(keys.state().flash!, /running the notify hook/);
  await waitForFile(out); // let the spawned hook write the recorder file
  await waitFor(() => (keys.state().flash ?? "").includes("notify hook exited 0"), "the notify hook outcome flash");
  assert.match(keys.state().flash!, /notify hook exited 0/);
  const lines = fs.readFileSync(out, "utf8").split("\n").filter((l) => l !== "");
  assert.deepEqual(lines, ["merge_failed|tumwater|tumwater notify --test"]);
});

function killOrphansHarness(onView: number) {
  const root = makeRoot();
  const report: DoctorReport = {
    header: "doctor",
    checks: [{ level: "ok", name: "node", detail: "fine" }],
    routing: [],
    verdict: "ok",
  } as DoctorReport;
  let kills = 0;
  let doctors = 0;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    runDoctor: () => {
      doctors += 1;
      return Promise.resolve(report);
    },
    killOrphans: () => {
      kills += 1;
      return Promise.resolve({ killed: [{ pid: 4242, command: "node x", descendants: 0 }], failed: [] });
    },
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < onView; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
  return { keys, kills: () => kills, doctors: () => doctors };
}

test("Ctrl+K twice on the Health view kills the orphans and flashes the lines", async () => {
  const h = killOrphansHarness(7);
  assert.equal(h.keys.state().view, 7);
  await Promise.resolve();
  const before = h.doctors();
  h.keys.handleKey(undefined, { ctrl: true, name: "k" });
  assert.equal(h.kills(), 0);
  assert.match(h.keys.state().flash!, /press Ctrl\+K again to kill the orphaned processes/);
  h.keys.handleKey(undefined, { ctrl: true, name: "k" });
  assert.equal(h.kills(), 1);
  await waitFor(() => (h.keys.state().flash ?? "").includes("killed pid 4242 node x"), "the kill flash");
  assert.equal(h.keys.state().flash, "killed pid 4242 node x");
  assert.equal(h.doctors(), before + 1);
});

test("a key between two Ctrl+K presses on the Health view disarms the kill", () => {
  const h = killOrphansHarness(7);
  h.keys.handleKey(undefined, { ctrl: true, name: "k" });
  h.keys.handleKey(undefined, { ctrl: true, name: "o" });
  h.keys.handleKey(undefined, { ctrl: true, name: "k" });
  assert.equal(h.kills(), 0);
});

test("Ctrl+K on the Health view with text typed on the prompt line kills no orphans", () => {
  const h = killOrphansHarness(7);
  h.keys.handleKey("x", { name: "x" });
  assert.equal(h.keys.state().input, "x");
  h.keys.handleKey(undefined, { ctrl: true, name: "k" });
  h.keys.handleKey(undefined, { ctrl: true, name: "k" });
  assert.equal(h.kills(), 0);
});

test("Ctrl+K off the Health view never kills", () => {
  const h = killOrphansHarness(0);
  h.keys.handleKey(undefined, { ctrl: true, name: "k" });
  h.keys.handleKey(undefined, { ctrl: true, name: "k" });
  assert.equal(h.kills(), 0);
});

test("Ctrl+A on the Health view commits the dirty backlog and flashes the lines", async () => {
  const root = makeRoot();
  const report: DoctorReport = {
    header: "doctor",
    checks: [{ level: "ok", name: "node", detail: "fine" }],
    routing: [],
    verdict: "ok",
  } as DoctorReport;
  let commits = 0;
  let doctors = 0;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    runDoctor: () => {
      doctors += 1;
      return Promise.resolve(report);
    },
    commitBacklog: () => {
      commits += 1;
      return Promise.resolve({ base: "main", committed: ["PLANS.md"], failed: [], skipped: null });
    },
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health (roleIds.length + 7)
  assert.equal(keys.state().view, 7);
  await Promise.resolve();
  const before = doctors;
  keys.handleKey(undefined, { ctrl: true, name: "a" });
  assert.equal(commits, 1);
  await waitFor(() => (keys.state().flash ?? "").includes("committed PLANS.md on main"), "the commit flash");
  assert.equal(keys.state().flash, "committed PLANS.md on main");
  assert.equal(doctors, before + 1, "the checks re-run after the commit");
});

test("Ctrl+A on the Health view with a clean backlog flashes the nothing-to-commit line", async () => {
  const root = makeRoot();
  const report: DoctorReport = {
    header: "doctor",
    checks: [],
    routing: [],
    verdict: "ok",
  } as DoctorReport;
  let commits = 0;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    runDoctor: () => Promise.resolve(report),
    commitBacklog: () => {
      commits += 1;
      return Promise.resolve({ base: "main", committed: [], failed: [], skipped: null });
    },
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  keys.handleKey(undefined, { ctrl: true, name: "a" });
  await waitFor(() => (keys.state().flash ?? "").includes("nothing to commit"), "the nothing-to-commit flash");
  assert.equal(commits, 1);
});

test("Ctrl+A off the Health view commits nothing", () => {
  const root = makeRoot();
  let commits = 0;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    runDoctor: () => new Promise<DoctorReport>(() => {}),
    commitBacklog: () => {
      commits += 1;
      return Promise.resolve({ base: "main", committed: [], failed: [], skipped: null });
    },
  });
  keys.syncSnapshot(0, false, [], false);
  assert.equal(keys.state().view, 0);
  keys.handleKey(undefined, { ctrl: true, name: "a" });
  assert.equal(commits, 0);
});

test("Ctrl+U on the Health view re-syncs the root install and flashes the lines", async () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, ".tumwater"), { recursive: true }); // the merge lock dir
  const report: DoctorReport = {
    header: "doctor",
    checks: [],
    routing: [],
    verdict: "ok",
  } as DoctorReport;
  let doctors = 0;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    runDoctor: () => {
      doctors += 1;
      return Promise.resolve(report);
    },
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health (roleIds.length + 7)
  assert.equal(keys.state().view, 7);
  await Promise.resolve();
  const before = doctors;
  keys.handleKey(undefined, { ctrl: true, name: "u" });
  await waitFor(() => (keys.state().flash ?? "").includes("nothing to re-sync"), "the nothing-to-re-sync flash");
  assert.equal(keys.state().flash, "no package-lock.json to match — nothing to re-sync");
  assert.equal(doctors, before + 1, "the checks re-run after the re-sync");
});

test("Ctrl+U off the Health view re-syncs nothing", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, ".tumwater"), { recursive: true });
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    runDoctor: () => new Promise<DoctorReport>(() => {}),
  });
  keys.syncSnapshot(0, false, [], false);
  assert.equal(keys.state().view, 0);
  keys.handleKey(undefined, { ctrl: true, name: "u" });
  // Activity keeps the prompt-line editor's Ctrl+U (kill-to-start), so no re-sync flash lands.
  assert.equal(keys.state().flash, null);
});

test("Ctrl+N on the Health view with no notify configured flashes the missing-setting wording and leaves the report", async () => {
  const root = makeRoot();
  const report: DoctorReport = {
    header: "doctor",
    checks: [{ level: "ok", name: "node", detail: "fine" }],
    routing: [],
    verdict: "ok",
  } as DoctorReport;
  let resolveDoctor!: (r: DoctorReport) => void;
  const keys = createTuiKeys({
    root,
    quit: () => {},
    requestRender: () => {},
    now: () => 0,
    runDoctor: () => new Promise<DoctorReport>((resolve) => (resolveDoctor = resolve)),
  });
  keys.syncSnapshot(0, false, [], false);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  assert.equal(keys.state().view, 7);
  resolveDoctor(report);
  await Promise.resolve();
  await Promise.resolve();
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(keys.state().flash!, /notify is not configured/);
  assert.equal(keys.state().paneCache, renderDoctor(report), "the cached doctor report is unchanged");
});

test("Ctrl+N off the Health view never runs the notify hook", async () => {
  const root = makeRoot();
  const out = path.join(root, "notify-out.txt");
  const set = setConfigKey(root, "notify", `echo out >> ${out}`);
  assert.ok(set.ok, `setConfigKey failed: ${set.ok ? "" : set.error}`);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  assert.equal(keys.state().view, 0, "starts on Activity");
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  // Off Health the view guard must keep the hook from ever being spawned. A spawned hook
  // writes asynchronously, so an immediate synchronous assert would pass even without the
  // guard; wait a real-time budget so a wrongly-spawned hook (even under load) has time to
  // write the recorder file before we assert it stayed absent.
  for (let i = 0; i < 40 && !fs.existsSync(out); i++) await sleep(25);
  assert.equal(fs.existsSync(out), false, "off Health, Ctrl+N never runs the hook");
});

// Ctrl+X on the Health view retires a disabled role's leftovers — the terminal twin of
// `tumwater retire --role <id>` and the dashboard Settings card's Retire button, all through
// the same retireRole core (src/operator/retire.ts). An empty id flashes and stays; a
// safety-rail refusal flashes --force's naming and stays; success exits edit mode and flashes
// the dashboard's own outcome wording. Every other view keeps Ctrl+X for its own arm.
test("Ctrl+X on the Health view retires a disabled role's leftovers", async () => {
  const { root } = await initializedWorktree();
  disableRole(root, "improve");
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  assert.equal(keys.state().view, 7, "Health is roleIds.length + 7");
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.match(keys.state().flash!, /type the role id/);
  assert.equal(keys.state().input, "", "the retire editor blanks the prompt line");
  for (const ch of "improve") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  await untilFlash(() => keys.state().flash ?? "", /removed the branch/);
  assert.equal(sh(root, "git", "branch", "--list", branchName("improve")).trim(), "", "the branch is removed");
  assert.equal(keys.state().retireMode, false, "success leaves the retire editor");
});

test("Ctrl+X retire on the Health view: an empty id stays and Esc restores the draft", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  for (const ch of "draft") keys.handleKey(ch, { name: ch }); // a prompt draft
  assert.equal(keys.state().input, "draft", "a prompt draft sits on the line");
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().input, "", "opening retire blanks the prompt line");
  keys.handleKey(undefined, { name: "return" }); // empty id
  assert.match(keys.state().flash!, /a role id is required/);
  assert.equal(keys.state().retireMode, true, "the retire editor stays open");
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().retireMode, false, "Esc leaves the retire editor");
  assert.equal(keys.state().input, "draft", "Esc restores the saved prompt draft");
});

test("promptLineFree is false while retire-edit mode holds the line, so the Health pane's own arms stay off it", () => {
  const es: TuiPaneEditorState = { budgetMode: false, rolePromptFor: null, searchMode: false, pauseEditMode: false, queuedEditFor: null, answerFor: null, entryEditFor: null, notesEditFor: null, briefEditMode: false, retireMode: true, quietMode: false, intervalMode: false, roleModelMode: false, instructionsEditFor: null, claudeReserveMode: false };
  // Ctrl+E (reclaim), Ctrl+R (doctor re-run) and Ctrl+O (problems toggle) are the Health
  // pane's own arms; while the retire editor holds the line they must see it busy, the same
  // exclusion every other mode enforces, or they would run over the retire modal.
  assert.equal(promptLineFree(es), false, "the retire editor blocks the Health pane's own arms");
  es.retireMode = false;
  assert.equal(promptLineFree(es), true, "the line frees once retire-edit mode leaves");
  es.quietMode = true;
  assert.equal(promptLineFree(es), false, "the quiet editor blocks the Transcript pane's own arms");
  es.quietMode = false;
  es.intervalMode = true;
  assert.equal(promptLineFree(es), false, "the interval editor blocks the Transcript pane's own arms");
  es.intervalMode = false;
  es.roleModelMode = true;
  assert.equal(promptLineFree(es), false, "the role-model editor blocks the pane arms while it holds the line");
  es.roleModelMode = false;
  es.claudeReserveMode = true;
  assert.equal(promptLineFree(es), false, "the claude-reserve editor blocks the pane arms while it holds the line");
  es.claudeReserveMode = false;
  es.instructionsEditFor = "clean";
  assert.equal(promptLineFree(es), false, "the instructions editor blocks the pane arms while it holds the line");
});

test("Ctrl+O on a role's Transcript edits that role's quiet-hours window, not another's or the team's", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "director", "clean"]); // roster {feature, director, clean}
  // Seed one role's window through the dotted write the editor itself will use, so the
  // pre-fill and the untouched-entry claim have something to check against.
  const seed = setConfigKey(root, "quietHoursPerRole.clean", '"23:00-07:00"');
  assert.equal(seed.ok, true);
  const setWindow = (): Record<string, string> =>
    (readJson(path.join(root, "tumwater.json")) as { quietHoursPerRole?: Record<string, string> })
      .quietHoursPerRole ?? {};

  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature's transcript
  assert.equal(keys.state().view, 1);
  assert.equal(keys.state().roleIds[keys.state().view - 1], "feature");

  // Open: the window-less role pre-fills an empty line (no draft saved), and Esc restores
  // the saved draft byte-for-byte with nothing written.
  for (const ch of "pending draft") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().quietMode, true);
  assert.equal(keys.state().input, "", "a window-less role pre-fills an empty line");
  assert.match(keys.state().flash!, /edit feature's quiet hours/);
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().quietMode, false);
  assert.equal(keys.state().input, "pending draft", "Esc restores the saved draft");
  assert.equal(setWindow().feature, undefined, "Esc writes nothing");

  // Enter on a valid window writes the dotted key for the VIEWED role, leaving the other
  // role's entry and the team-wide quietHours untouched.
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  for (const ch of "23:00-07:00") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().quietMode, false, "a saved window leaves edit mode");
  assert.equal(keys.state().input, "pending draft", "Enter restores the saved draft");
  assert.match(keys.state().flash!, /feature: quiet hours set to 23:00-07:00/);
  assert.equal(setWindow().feature, "23:00-07:00");
  assert.equal(setWindow().clean, "23:00-07:00", "the other role's window is untouched");

  // Re-entering pre-fills the just-saved window; Esc cancels the re-edit with no further
  // write (the invalid-window retry path is pinned in test/tui-quiet.test.ts).
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.equal(keys.state().input, "23:00-07:00", "re-entering pre-fills the saved window");
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().quietMode, false);
  assert.equal(keys.state().input, "pending draft");

  // Ctrl+O on the director's Transcript refuses — its quietHoursPerRole.director entry is
  // inert — and opens nothing, leaving the prompt line unchanged.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → director's transcript (view 2)
  assert.equal(keys.state().roleIds[keys.state().view - 1], "director");
  keys.handleKey(undefined, { ctrl: true, name: "o" });
  assert.match(keys.state().flash!, /the director has no quiet hours/);
  assert.equal(keys.state().quietMode, false, "the director opens nothing");
});

test("Ctrl+O on an instance's Transcript writes the base role's quiet-hours key", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "feature-2"]);

  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature (view 1)
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature-2 (view 2)
  assert.equal(keys.state().roleIds[keys.state().view - 1], "feature-2");

  keys.handleKey(undefined, { ctrl: true, name: "o" });
  for (const ch of "23:00-07:00") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  const setWindow = (): Record<string, string> =>
    (readJson(path.join(root, "tumwater.json")) as { quietHoursPerRole?: Record<string, string> })
      .quietHoursPerRole ?? {};
  assert.equal(
    setWindow().feature,
    "23:00-07:00",
    "an instance id writes its base role's key (quietHoursPerRole.feature, not feature-2)",
  );
  assert.equal(Object.keys(setWindow()).length, 1, "no per-instance entry is left behind");
});

test("Ctrl+W on Activity edits the pool size; Ctrl+W on a role's Transcript still opens the wake editor", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "director", "clean"]);

  // On the Activity view (0), Ctrl+W opens the worktree-slots editor — the team scope has a
  // pool size to edit, and a role's wake editor is not in play.
  keys.handleKey(undefined, { ctrl: true, name: "w" });
  assert.equal(keys.state().slotsMode, true, "Activity routes Ctrl+W to the worktree-slots editor");
  assert.equal(keys.state().pauseEditWake, false, "the wake editor stays closed on Activity");
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().slotsMode, false);

  // On a role's Transcript, Ctrl+W still opens the wake editor (not the slots editor), so the
  // new Activity arm does not swallow the wake key.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature's transcript (view 1)
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { ctrl: true, name: "w" });
  assert.equal(keys.state().pauseEditWake, true, "a role's Transcript routes Ctrl+W to the wake editor");
  assert.equal(keys.state().slotsMode, false, "the slots editor stays closed on a Transcript");
});

test("Ctrl+X retire refuses a role the safety rails object to and removes nothing", async () => {
  const { root } = await initializedWorktree();
  // improve is still enabled (not disabled), so retire's enabled-role rail objects.
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → Health
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  for (const ch of "improve") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  await untilFlash(() => keys.state().flash ?? "", /refusing to retire/);
  assert.match(keys.state().flash!, /--force/);
  assert.equal(keys.state().retireMode, true, "a refusal stays in the editor");
  assert.notEqual(sh(root, "git", "branch", "--list", branchName("improve")).trim(), "", "the branch survives");
  keys.handleKey(undefined, { name: "escape" });
});

test("Ctrl+S on a role's Transcript edits that role's min run interval; instance and director write the base key", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "feature-2", "director"]);
  const intervalOf = (role: string): number | undefined => {
    const file = path.join(root, "tumwater.json");
    if (!fs.existsSync(file)) return undefined;
    return (readJson(file) as { roles?: Record<string, { minRunIntervalSeconds?: number }> })
      .roles?.[role]?.minRunIntervalSeconds;
  };

  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature's transcript
  assert.equal(keys.state().view, 1);
  assert.equal(keys.state().roleIds[keys.state().view - 1], "feature");

  // Open: an override-less role pre-fills an empty line (no draft saved), and Esc restores the
  // saved draft byte-for-byte with nothing written.
  for (const ch of "pending draft") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().intervalMode, true);
  assert.equal(keys.state().input, "", "an override-less role pre-fills an empty line");
  assert.match(keys.state().flash!, /edit feature's min run interval/);
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().intervalMode, false);
  assert.equal(keys.state().input, "pending draft", "Esc restores the saved draft");
  assert.equal(intervalOf("feature"), undefined, "Esc writes nothing");

  // Enter on a valid number writes the dotted key for the VIEWED role through setConfigKey.
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  for (const ch of "90") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().intervalMode, false, "a saved interval leaves edit mode");
  assert.equal(keys.state().input, "pending draft", "Enter restores the saved draft");
  assert.match(keys.state().flash!, /feature: min run interval set to 90s/);
  assert.equal(intervalOf("feature"), 90, "the override is written as a JSON number");

  // An instance id writes its base role's key — roles.feature, not roles.feature-2 — and the
  // director (which has no exemption) writes roles.director.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature-2's transcript (view 2)
  assert.equal(keys.state().roleIds[keys.state().view - 1], "feature-2");
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().input, "90", "an instance re-opening pre-fills its base role's override");
  for (let i = 0; i < 2; i++) keys.handleKey(undefined, { name: "backspace" });
  for (const ch of "45") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(intervalOf("feature"), 45, "an instance id writes its base role's key");
  assert.equal(intervalOf("feature-2"), undefined, "no per-instance entry is left behind");

  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → director's transcript (view 3)
  assert.equal(keys.state().roleIds[keys.state().view - 1], "director");
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().input, "", "the director opens pre-filled empty when its file sets nothing");
  for (const ch of "30") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.match(keys.state().flash!, /director: min run interval set to 30s/);
  assert.equal(intervalOf("director"), 30, "the director's override is written through the same core");
});

test("Ctrl+X edits a role's model override on its Transcript; instance writes the base key; the notes view keeps Ctrl+X for clearing notes", () => {
  const root = makeRoot();
  // The notes view below inspects feature-2, which the config must run.
  fs.writeFileSync(path.join(root, "tumwater.json"), JSON.stringify({ roles: { feature: { enabled: true, instances: 2 } } }));
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "feature-2", "director"]);
  const modelOf = (role: string): string | undefined => {
    const file = path.join(root, "tumwater.json");
    if (!fs.existsSync(file)) return undefined;
    return (readJson(file) as { roles?: Record<string, { model?: string }> }).roles?.[role]?.model;
  };

  // A role's Transcript opens the editor pre-filled empty when the file sets nothing, and Esc
  // restores the saved draft byte-for-byte with nothing written.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature's transcript (view 1)
  assert.equal(keys.state().roleIds[keys.state().view - 1], "feature");
  for (const ch of "pending draft") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().roleModelMode, true, "Ctrl+X on a role's Transcript opens the role-model editor");
  assert.equal(keys.state().input, "", "an override-less role pre-fills an empty line");
  assert.match(keys.state().flash!, /edit feature's model override/);
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().roleModelMode, false);
  assert.equal(keys.state().input, "pending draft", "Esc restores the saved draft");
  assert.equal(modelOf("feature"), undefined, "Esc writes nothing");

  // Enter on a model id writes the viewed role's `roles.feature.model` key.
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  for (const ch of "anthropic/claude-3-7-sonnet") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().roleModelMode, false, "a saved model leaves edit mode");
  assert.equal(keys.state().input, "pending draft", "Enter restores the saved draft");
  assert.match(keys.state().flash!, /feature: model override set to anthropic\/claude-3-7-sonnet/);
  assert.equal(modelOf("feature"), "anthropic/claude-3-7-sonnet", "the override is written through setRoleModelFields");

  // An instance id writes its base role's key — roles.feature, not roles.feature-2.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature-2's transcript (view 2)
  assert.equal(keys.state().roleIds[keys.state().view - 1], "feature-2");
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().input, "anthropic/claude-3-7-sonnet", "an instance re-opening pre-fills its base role's override");
  for (let i = 0; i < "anthropic/claude-3-7-sonnet".length; i++) keys.handleKey(undefined, { name: "backspace" });
  for (const ch of "strong") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(modelOf("feature"), "strong", "an instance id writes its base role's key");
  assert.equal(modelOf("feature-2"), undefined, "no per-instance entry is left behind");

  // With the notes view up (Ctrl+N once), Ctrl+X still clears the notes and never opens the
  // role-model editor — its open guard excludes noteMode so the clear-notes arm keeps the key.
  keys.handleKey(undefined, { ctrl: true, name: "n" }); // → feature-2's notes
  assert.equal(keys.state().noteMode, true, "one Ctrl+N shows the notes view");
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().roleModelMode, false, "on the notes view Ctrl+X does not open the role-model editor");
  keys.handleKey(undefined, { ctrl: true, name: "x" }); // second press clears the notes
});

test("Ctrl+L on a role's Transcript replaces that role's instructions from a file; instance and director write the base key", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "feature-2", "director"]);
  const file = path.join(root, "instructions.txt");
  const instructionsOf = (role: string): string | undefined => {
    const cfg = path.join(root, "tumwater.json");
    if (!fs.existsSync(cfg)) return undefined;
    return (readJson(cfg) as { roles?: Record<string, { instructions?: string }> }).roles?.[role]?.instructions;
  };

  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature's transcript
  assert.equal(keys.state().view, 1);
  assert.equal(keys.state().roleIds[keys.state().view - 1], "feature");

  // Open: the line blanks (a prompt draft is saved), and Esc restores it byte-for-byte with
  // nothing written.
  for (const ch of "pending draft") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { ctrl: true, name: "l" });
  assert.equal(keys.state().instructionsEditFor, "feature");
  assert.equal(keys.state().input, "", "opening the editor blanks the prompt line");
  assert.match(keys.state().flash!, /replace feature's instructions from a file/);
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().instructionsEditFor, null);
  assert.equal(keys.state().input, "pending draft", "Esc restores the saved draft");
  assert.equal(instructionsOf("feature"), undefined, "Esc writes nothing");

  // Enter on a path to a non-empty file writes roles.feature.instructions through setConfigKey
  // (a JSON string), flashes the saved wording, and restores the draft.
  fs.writeFileSync(file, "answer every question in two lines");
  keys.handleKey(undefined, { ctrl: true, name: "l" });
  for (const ch of file) keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().instructionsEditFor, null, "a saved override leaves edit mode");
  assert.equal(keys.state().input, "pending draft", "Enter restores the saved draft");
  assert.match(keys.state().flash!, /feature: instructions saved \(\d+ chars\)/);
  assert.equal(instructionsOf("feature"), "answer every question in two lines");

  // An empty/whitespace-only file clears the key through unsetConfigKey.
  fs.writeFileSync(file, "   \n");
  keys.handleKey(undefined, { ctrl: true, name: "l" });
  for (const ch of file) keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.match(keys.state().flash!, /feature: instructions cleared/);
  assert.equal(instructionsOf("feature"), undefined, "an empty file removes the override");

  // An empty path flashes and stays; a missing file flashes and stays.
  keys.handleKey(undefined, { ctrl: true, name: "l" });
  keys.handleKey(undefined, { name: "return" });
  assert.match(keys.state().flash!, /a file path is required/);
  assert.equal(keys.state().instructionsEditFor, "feature", "an empty path stays in the editor");
  keys.handleKey(undefined, { name: "escape" });

  const missing = path.join(root, "nope.txt");
  keys.handleKey(undefined, { ctrl: true, name: "l" });
  for (const ch of missing) keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.match(keys.state().flash!, /no such file: .*nope\.txt/);
  assert.equal(keys.state().instructionsEditFor, "feature", "a missing file stays in the editor");
  keys.handleKey(undefined, { name: "escape" });

  // An instance id writes its base role's key — roles.feature, not roles.feature-2.
  fs.writeFileSync(file, "for the instance");
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature-2's transcript (view 2)
  assert.equal(keys.state().roleIds[keys.state().view - 1], "feature-2");
  keys.handleKey(undefined, { ctrl: true, name: "l" });
  for (const ch of file) keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(instructionsOf("feature"), "for the instance", "an instance id writes its base role's key");
  assert.equal(instructionsOf("feature-2"), undefined, "no per-instance entry is left behind");

  // The director writes roles.director (no refusal, like the dashboard editor and the CLI's
  // --instructions-file, whose override reaches its own runs).
  fs.writeFileSync(file, "director instructions");
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → director's transcript (view 3)
  assert.equal(keys.state().roleIds[keys.state().view - 1], "director");
  keys.handleKey(undefined, { ctrl: true, name: "l" });
  for (const ch of file) keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.match(keys.state().flash!, /director: instructions saved \(\d+ chars\)/);
  assert.equal(instructionsOf("director"), "director instructions", "the director's override is written through the same core");
});

test("Ctrl+P opens the provider-caps editor on Activity and the pause editor on a role's Transcript", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean"]);

  // Activity (view 0): Ctrl+P is the provider-caps editor, pre-filled empty when the key is
  // unset; a second Ctrl+P cancels it (the pause editor's per-role arm is guarded off Activity).
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  assert.equal(keys.state().providerCapsMode, true, "Ctrl+P on Activity opens the provider-caps editor");
  assert.equal(keys.state().pauseEditRole, null, "the pause editor does not open on Activity");
  assert.equal(keys.state().input, "", "unset maxConcurrentPerProvider pre-fills empty");
  assert.match(keys.state().flash!, /maxConcurrentPerProvider/);
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  assert.equal(keys.state().providerCapsMode, false, "Ctrl+P again cancels the provider-caps editor");

  // On a role's Transcript (view 1), Ctrl+P keeps its pause meaning: the provider-caps arm
  // falls through so the pause editor opens with the viewed role pinned.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → clean's transcript
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  assert.equal(keys.state().pauseEditRole, "clean", "Ctrl+P on a Transcript opens the pause editor");
  assert.equal(keys.state().providerCapsMode, false, "the provider-caps editor does not open on a Transcript");
});

test("Ctrl+X opens the agent-backends editor on Activity and keeps its meaning off it", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  const roles = ["clean"];
  keys.syncSnapshot(0, false, roles);

  // Activity (view 0): Ctrl+X opens the agent-backends editor, pre-filled empty when the key
  // is unset; a second Ctrl+X cancels it (the retire/notes/backlog/inbox X arms are all
  // guarded to their own views).
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().backendsMode, true, "Ctrl+X on Activity opens the agent-backends editor");
  assert.equal(keys.state().input, "", "unset backends pre-fills empty");
  assert.match(keys.state().flash!, /backends/);
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().backendsMode, false, "Ctrl+X again cancels the agent-backends editor");

  // On a role's Transcript (view 1), Ctrl+X keeps its existing meaning: the new arm falls
  // through off view 0, so the backends editor stays closed.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature's transcript (view 1)
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().backendsMode, false, "the backends editor does not open on a Transcript");

  // On the Health view (roleIds.length + 7), Ctrl+X still opens the retire editor, not the
  // backends editor.
  for (let i = 0; i < 7; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, roles.length + 7, "Health is roleIds.length + 7");
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().retireMode, true, "Health keeps Ctrl+X for the retire editor");
  assert.equal(keys.state().backendsMode, false, "the backends editor stays closed on Health");
});

test("Ctrl+L opens the fallback editor on Activity and the instructions editor on a role's Transcript", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["clean"]);

  // Activity (view 0): Ctrl+L is the team-fallback editor; the budget editor stays closed.
  keys.handleKey(undefined, { ctrl: true, name: "l" });
  assert.equal(keys.state().fallbackMode, true, "Ctrl+L on Activity opens the fallback editor");
  assert.equal(keys.state().budgetMode, false, "the budget editor does not open");
  assert.equal(keys.state().input, "", "unset fallback pre-fills empty");
  assert.match(keys.state().flash!, /fallback/);
  keys.handleKey(undefined, { ctrl: true, name: "l" });
  assert.equal(keys.state().fallbackMode, false, "Ctrl+L again cancels the fallback editor");

  // On Activity with the budget editor open (Ctrl+B), Ctrl+L flashes the way out, not open.
  keys.handleKey(undefined, { ctrl: true, name: "b" });
  assert.equal(keys.state().budgetMode, true);
  keys.handleKey(undefined, { ctrl: true, name: "l" });
  assert.match(keys.state().flash!, /finish or cancel the budget edit first/);
  assert.equal(keys.state().fallbackMode, false, "the fallback editor does not open over the budget editor");
  assert.equal(keys.state().budgetMode, true, "the budget editor keeps the line");
  keys.handleKey(undefined, { name: "escape" }); // out of budget mode

  // On a role's Transcript (view 1), Ctrl+L keeps its instructions meaning: the fallback arm
  // falls through (view guard) so the instructions editor opens with the viewed role pinned.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → clean's transcript
  assert.equal(keys.state().view, 1);
  keys.handleKey(undefined, { ctrl: true, name: "l" });
  assert.equal(keys.state().instructionsEditFor, "clean", "Ctrl+L on a Transcript opens the instructions editor");
  assert.equal(keys.state().fallbackMode, false, "the fallback editor does not open on a Transcript");
});

test("Ctrl+G on a role's Transcript edits that role's parallel-runner count; an instance id writes the base role's key", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "feature-2"]);
  const instancesOf = (role: string): number | undefined => {
    const file = path.join(root, "tumwater.json");
    if (!fs.existsSync(file)) return undefined;
    return (readJson(file) as { roles?: Record<string, { instances?: number }> })
      .roles?.[role]?.instances;
  };

  // A role's Transcript (view 1): Ctrl+G opens the instances editor (not the scope cycle),
  // pre-fills empty when the file sets nothing, and leaves the scope state untouched.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature's transcript
  assert.equal(keys.state().view, 1);
  assert.equal(keys.state().roleIds[keys.state().view - 1], "feature");
  for (const ch of "pending draft") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().instancesMode, true, "Ctrl+G opens the instances editor on a Transcript");
  assert.equal(keys.state().input, "", "an override-less role pre-fills an empty line");
  assert.equal(keys.state().activityRole, null, "the instances editor does not touch Activity's scope");
  assert.equal(keys.state().historyRole, null, "...nor History's scope");
  assert.match(keys.state().flash!, /edit feature's parallel-runner count/);
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().instancesMode, false);
  assert.equal(keys.state().input, "pending draft", "Esc restores the saved draft");
  assert.equal(instancesOf("feature"), undefined, "Esc writes nothing");

  // Enter on a valid count writes the dotted key for the VIEWED role through setConfigKey, and
  // a second Ctrl+G cancels the open editor.
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  for (const ch of "3") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(keys.state().instancesMode, false, "a saved count leaves edit mode");
  assert.equal(keys.state().input, "pending draft", "Enter restores the saved draft");
  assert.match(keys.state().flash!, /feature: instances set to 3/);
  assert.equal(instancesOf("feature"), 3, "the count is written as a JSON number");

  // An instance id writes its base role's key — roles.feature, not roles.feature-2.
  keys.handleKey(undefined, { ctrl: true, name: "t" }); // → feature-2's transcript (view 2)
  assert.equal(keys.state().roleIds[keys.state().view - 1], "feature-2");
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().input, "3", "an instance re-opening pre-fills its base role's count");
  for (let i = 0; i < 1; i++) keys.handleKey(undefined, { name: "backspace" });
  for (const ch of "4") keys.handleKey(ch, { name: ch });
  keys.handleKey(undefined, { name: "return" });
  assert.equal(instancesOf("feature"), 4, "an instance id writes its base role's key");
  assert.equal(instancesOf("feature-2"), undefined, "no per-instance entry is left behind");
});

test("Ctrl+G on Activity, History and the report views keeps its scope cycle, not the instances editor", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, ["feature", "clean"]);
  // Activity = view 0, transcripts = views 1-2, backlog = 3, usage = 4, failures = 5, history = 6.

  // Activity: Ctrl+G cycles activityRole; the instances editor stays closed.
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().activityRole, "feature", "Activity Ctrl+G scopes to the first roster id");
  assert.equal(keys.state().instancesMode, false, "the instances editor does not open on Activity");
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().activityRole, "clean", "Activity Ctrl+G walks the roster");

  // Usage (view 4): Ctrl+G cycles the report scope.
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 4);
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().scopeRole, "feature", "Usage Ctrl+G cycles the report scope");
  assert.equal(keys.state().instancesMode, false, "the instances editor stays closed off a Transcript");

  // History (view 6): Ctrl+G cycles historyRole.
  for (let i = 0; i < 2; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
  assert.equal(keys.state().view, 6);
  keys.handleKey(undefined, { ctrl: true, name: "g" });
  assert.equal(keys.state().historyRole, "feature", "History Ctrl+G cycles the history scope");
  assert.equal(keys.state().instancesMode, false, "the instances editor stays closed off a Transcript");
});

// Ctrl+A on the Activity view opens the team-model editor (PLANS.md) — the TUI's twin of the
// dashboard Settings `Model` field and `tumwater config set model` — pre-filled from the
// file's top-level `model` (empty when unset). On a role's Transcript the same key keeps its
// per-role meaning: the new arm returns false off view 0, so the pause editor's abort arm
// still aborts that role's run. This pins the scope the two arms share the key over.
test("Ctrl+A opens the team-model editor on Activity, still aborts a role's run on its Transcript", () => {
  const root = makeRoot();
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  assert.equal(keys.state().view, 0, "starts on Activity");
  keys.handleKey(undefined, { ctrl: true, name: "a" });
  assert.equal(keys.state().modelMode, true, "Ctrl+A opens the model editor on Activity");
  assert.equal(keys.state().budgetMode, false, "the budget editor stays closed");
  assert.equal(keys.state().input, "", "an unset model pre-fills an empty line");
  keys.handleKey(undefined, { name: "escape" });
  assert.equal(keys.state().modelMode, false, "Esc closes the model editor");

  // A role's Transcript keeps Ctrl+A as the per-role abort, not the model editor.
  const abortRoot = makeRoot();
  writeOrchestratorMarker(abortRoot, ["feature"]); // a live team so requestAbort writes the marker
  const { keys: keys2 } = makeKeys(abortRoot, () => 0);
  keys2.syncSnapshot(0, false, ["feature", "director", "clean"]);
  keys2.handleKey(undefined, { ctrl: true, name: "t" }); // → feature's transcript
  assert.equal(keys2.state().view, 1);
  assert.equal(keys2.state().roleIds[keys2.state().view - 1], "feature");
  keys2.handleKey(undefined, { ctrl: true, name: "a" });
  assert.equal(keys2.state().modelMode, false, "Ctrl+A on a Transcript does not open the model editor");
  assert.equal(keys2.state().budgetMode, false);
  assert.ok(fs.existsSync(abortRequestPath(abortRoot, "feature")), "the per-role abort marker is written");
  assert.match(keys2.state().flash!, /abort requested for feature/);
});

test("the History model summary shows a run with no recorded start as (unknown)", () => {
  const root = makeRoot();
  writeEvents(root, [{ ts: 1_700_000_000_000, loop: "feature", type: "run_end", run: 1, result: "changed" }]); // retired-name-ok: legacy event field in a fixture
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  keys.handleKey(undefined, { ctrl: true, name: "y" });
  keys.handleKey(undefined, { ctrl: true, name: "y" });
  assert.match(keys.state().paneCache ?? "", /^\(unknown\)/m);
});

test("Ctrl+N's change step heads the change with the viewed role's queued merges", async () => {
  const root = makeRoot();
  const view = {
    role: "clean",
    branch: "tumwater/clean",
    mainBranch: "main",
    state: "ready" as const,
    ahead: 2,
    behind: 0,
    commits: [{ sha: "abc1234", subject: "add a thing" }],
    diff: "",
    dirtyFiles: ["a.ts"],
    uncommittedDiff: "",
  };
  enqueueMerge(root, { role: "feature", sha: "a".repeat(40), run: 3, summary: "queued feature", enqueuedAt: 0 });
  enqueueMerge(root, { role: "clean", sha: "b".repeat(40), run: 5, summary: "queued clean", enqueuedAt: 1 });
  enqueueMerge(root, { role: "clean-2", sha: "c".repeat(40), run: 7, summary: "queued clean two", enqueuedAt: 2 });
  const pending = Promise.resolve(view);
  const keys = createTuiKeys({ root, quit: () => {}, requestRender: () => {}, now: () => 0, collectChange: () => pending });
  keys.syncSnapshot(0, false, ["clean"], false);
  keys.handleKey(undefined, { ctrl: true, name: "t" });
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  await pending;
  const text = keys.state().changeCache ?? "";
  assert.ok(text.startsWith("merge queue (1 of 3, --role clean):\n  2. clean run #5"), text);
  assert.ok(text.endsWith(renderRoleChange(view)));
  assert.doesNotMatch(text, /clean-2 run/);
  assert.doesNotMatch(text, /feature run #3/);
});

test("`/` on a History trail whose transcript shows searches the transcript, not the run rows", () => {
  const root = historyTrailRoot();
  writeTrailPiLog(root);
  const { keys } = makeKeys(root, () => 0, () => new Promise<string>(() => {}));
  openHistory(keys);
  const search = (text: string): void => {
    keys.handleKey("/", { name: "/" });
    keys.handleKey(undefined, { ctrl: true, name: "u" });
    for (const ch of text) keys.handleKey(ch, { name: ch });
    keys.handleKey(undefined, { name: "return" });
  };
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  const detail = readRunDetail(root, "clean", 1)!;
  const bare = renderRunDetail(detail);
  search("said-one");
  assert.equal(keys.state().trailGrep, "said-one");
  assert.equal(keys.state().historyGrep, null);
  const hit = runTranscriptLines(root, "clean", 1, detail, { grep: "said-one" }).found;
  assert.equal(keys.state().trailCache, `${bare}\n\n${hit.join("\n")}`);
  search("zzz-none");
  const miss = runTranscriptLines(root, "clean", 1, detail, { grep: "zzz-none" }).note;
  assert.ok(keys.state().trailCache!.endsWith(miss));
  search("said-one");
  keys.handleKey("/", { name: "/" });
  assert.equal(keys.state().input, "said-one", "re-opening pre-fills the transcript pattern");
  keys.handleKey(undefined, { name: "escape" });
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().trailTranscript, "prompts");
  assert.equal(keys.state().trailGrep, "said-one", "the prompts level keeps the search");
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  assert.equal(keys.state().trailGrep, null, "turning the transcript off drops its search");
  assert.equal(keys.state().trailCache, bare);
  search("clean");
  assert.equal(keys.state().historyGrep, "clean", "with the transcript off `/` searches the run rows");
  assert.equal(keys.state().trailGrep, null);
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  search("said-one");
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().trailGrep, null, "leaving and re-entering the trail starts bare");
});

function stepHistoryRoot(now: number): string {
  const root = makeRoot();
  writeEvents(root, [
    { ts: now - 30 * 60_000, loop: "feature", type: "run_end", run: 1, result: "changed" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 90 * 60_000, loop: "feature", type: "run_end", run: 2, result: "changed" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 2.5 * 24 * 60 * 60_000, loop: "feature", type: "run_end", run: 3, result: "changed" }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 6.5 * 24 * 60 * 60_000, loop: "feature", type: "run_end", run: 4, result: "changed" }, // retired-name-ok: legacy event field in a fixture
  ]);
  return root;
}

function openStepHistory(keys: ReturnType<typeof makeKeys>["keys"], windows: number): void {
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" });
  for (let i = 0; i < windows; i++) keys.handleKey(undefined, { ctrl: true, name: "s" });
}

const ctrlP = { ctrl: true, name: "p" };

test("Ctrl+P off the trail steps the History window back one window length, and Ctrl+S resets it", () => {
  const now = Date.now();
  const { keys } = makeKeys(stepHistoryRoot(now), () => now);
  openStepHistory(keys, 1);
  assert.equal(keys.state().historySince, "1h");
  keys.handleKey(undefined, ctrlP);
  assert.equal(keys.state().historyStep, 1);
  assert.match(keys.state().paneCache ?? "", /window: between 2h and 1h ago/);
  assert.match(keys.state().paneCache ?? "", /feature #2/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /feature #1/);
  keys.handleKey(undefined, ctrlP);
  assert.equal(keys.state().historyStep, 2);
  for (let i = 0; i < 2; i++) keys.handleKey(undefined, { ctrl: true, name: "s" });
  assert.equal(keys.state().historySince, "1d");
  assert.equal(keys.state().historyStep, 0);
  assert.match(keys.state().paneCache ?? "", /window: last 1d/);
  keys.handleKey(undefined, ctrlP);
  keys.handleKey(undefined, ctrlP);
  assert.equal(keys.state().historyStep, 2);
  assert.match(keys.state().paneCache ?? "", /window: between 3d and 2d ago/);
  assert.match(keys.state().paneCache ?? "", /feature #3/);
});

test("Ctrl+P wraps the stepped History window after the 7-day cap", () => {
  const now = Date.now();
  const { keys } = makeKeys(stepHistoryRoot(now), () => now);
  openStepHistory(keys, 3);
  assert.equal(keys.state().historySince, "1d");
  for (let i = 0; i < 6; i++) keys.handleKey(undefined, ctrlP);
  assert.equal(keys.state().historyStep, 6);
  assert.match(keys.state().paneCache ?? "", /between 7d and 6d ago/);
  assert.match(keys.state().paneCache ?? "", /feature #4/);
  keys.handleKey(undefined, ctrlP);
  assert.equal(keys.state().historyStep, 0);
  assert.match(keys.state().flash ?? "", /oldest window reached; back to the last 1d/);
  keys.handleKey(undefined, { ctrl: true, name: "s" });
  keys.handleKey(undefined, ctrlP);
  assert.equal(keys.state().historySince, "7d");
  assert.equal(keys.state().historyStep, 0);
  assert.match(keys.state().flash ?? "", /oldest window reached; back to the last 7d/);
});

test("Ctrl+P on the default History window only flashes the Ctrl+S hint", () => {
  const now = Date.now();
  const { keys } = makeKeys(stepHistoryRoot(now), () => now);
  openStepHistory(keys, 0);
  const before = keys.state().paneCache;
  keys.handleKey(undefined, ctrlP);
  assert.equal(keys.state().historyStep, 0);
  assert.equal(keys.state().paneCache, before);
  assert.match(keys.state().flash ?? "", /Ctrl\+S/);
});

test("Ctrl+N on a stepped History window opens that window's newest run", () => {
  const now = Date.now();
  const { keys } = makeKeys(stepHistoryRoot(now), () => now);
  openStepHistory(keys, 1);
  keys.handleKey(undefined, ctrlP);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  assert.equal(keys.state().trailMode, true);
  assert.match(keys.state().trailCache ?? "", /run 2|#2/);
});

test("historyWindowBounds steps a trailing window back by its own length", () => {
  assert.deepEqual(historyWindowBounds(3_600_000, 0), { sinceMs: 3_600_000, untilMs: null });
  assert.deepEqual(historyWindowBounds(86_400_000, 2), { sinceMs: 259_200_000, untilMs: 172_800_000 });
  assert.deepEqual(historyWindowBounds(null, 3), { sinceMs: null, untilMs: null });
});

const seedModelRuns = (root: string): void =>
  writeEvents(root, [
    { ts: 1_699_999_990_000, loop: "feature", type: "run_start", run: 1, model: "m-a" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_050_000, loop: "qa", type: "run_start", run: 1, model: "m-b" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_000_000, loop: "feature", type: "run_end", run: 1, result: "changed" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_060_000, loop: "qa", type: "run_end", run: 1, result: "no_change" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_070_000, loop: "clean", type: "run_end", run: 1, result: "changed" }, // retired-name-ok: legacy event field in a fixture
  ]);

test("Ctrl+X on History cycles the model filter through each model and back to all", () => {
  const root = makeRoot();
  seedModelRuns(root);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  assert.equal(keys.state().historyModel, null);
  assert.doesNotMatch(keys.state().paneCache ?? "", /model:/);
  assert.match(keys.state().paneCache ?? "", /clean #1/);

  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().historyModel, "m-a");
  assert.match(keys.state().paneCache ?? "", /^model: m-a\n/);
  assert.match(keys.state().paneCache ?? "", /feature #1/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /qa #1/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /clean #1/);

  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().historyModel, "m-b");
  assert.match(keys.state().paneCache ?? "", /qa #1/);
  assert.doesNotMatch(keys.state().paneCache ?? "", /feature #1/);

  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().historyModel, null);
  assert.doesNotMatch(keys.state().paneCache ?? "", /model:/);
  assert.match(keys.state().paneCache ?? "", /clean #1/);
});

test("Ctrl+X on History flashes when no row in the view ran on a model", () => {
  const root = makeRoot();
  writeEvents(root, [
    { ts: 1_700_000_070_000, loop: "clean", type: "run_end", run: 1, result: "changed" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().historyModel, null);
  assert.match(keys.state().flash ?? "", /no runs with a model in this view/);
});

test("Ctrl+X on Activity still opens the backends editor and leaves the History model filter unset", () => {
  const root = makeRoot();
  seedModelRuns(root);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  keys.handleKey(undefined, { ctrl: true, name: "x" });
  assert.equal(keys.state().backendsMode, true);
  assert.equal(keys.state().historyModel, null);
});

test("a History model filter that a later Ctrl+O empties blames the model", () => {
  const root = makeRoot();
  seedModelRuns(root);
  const { keys } = makeKeys(root, () => 0);
  keys.syncSnapshot(0, false, []);
  for (let i = 0; i < 4; i++) keys.handleKey(undefined, { ctrl: true, name: "t" }); // → history
  keys.handleKey(undefined, { ctrl: true, name: "x" }); // m-a: feature #1 (changed)
  keys.handleKey(undefined, { ctrl: true, name: "o" }); // merged: feature #1 passes both
  keys.handleKey(undefined, { ctrl: true, name: "o" }); // none: the class keeps qa/none rows, m-a removes them
  assert.equal(keys.state().historyResult, "none");
  assert.match(keys.state().paneCache ?? "", /no runs on model "m-a"/);
});

test("Ctrl+W on a History trail appends the run's patch after the stat, and a second press hides it", async () => {
  const root = historyTrailRoot();
  const { keys } = makeKeys(root, () => 0, () => Promise.resolve(" a.ts | 1 +"), { runPatch: () => Promise.resolve("diff --git a/a.ts b/a.ts") });
  openHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  await settle();
  keys.handleKey(undefined, { ctrl: true, name: "w" });
  await settle();
  const plain = renderRunDetail(readRunDetail(root, "clean", 1)!);
  assert.equal(keys.state().trailCache, `${plain}\n\n a.ts | 1 +\n\ndiff --git a/a.ts b/a.ts`);
  assert.equal(keys.state().trailPatch, true);
  keys.handleKey(undefined, { ctrl: true, name: "w" });
  assert.equal(keys.state().trailCache, `${plain}\n\n a.ts | 1 +`);
  assert.equal(keys.state().trailPatch, false);
});

test("the History trail composes detail, stat, patch, then transcript", async () => {
  const root = historyTrailRoot();
  writeTrailPiLog(root);
  const { keys } = makeKeys(root, () => 0, () => Promise.resolve(" a.ts | 1 +"), { runPatch: () => Promise.resolve("PATCH") });
  openHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { ctrl: true, name: "w" });
  keys.handleKey(undefined, { ctrl: true, name: "r" });
  await settle();
  const detail = readRunDetail(root, "clean", 1)!;
  const plain = runTranscriptLines(root, "clean", 1, detail).found.join("\n");
  assert.equal(keys.state().trailCache, `${renderRunDetail(detail)}\n\n a.ts | 1 +\n\nPATCH\n\n${plain}`);
});

test("Ctrl+W off a History trail flashes and reads no patch", () => {
  const root = historyTrailRoot();
  let calls = 0;
  const { keys } = makeKeys(root, () => 0, undefined, { runPatch: () => { calls++; return Promise.resolve("x"); } });
  openHistory(keys);
  const before = keys.state().paneCache;
  keys.handleKey(undefined, { ctrl: true, name: "w" });
  assert.match(keys.state().flash ?? "", /open a run's trail with Ctrl\+N/);
  assert.equal(calls, 0);
  assert.equal(keys.state().paneCache, before);
});

test("the trail patch follows Ctrl+P, and a late patch from the left run is dropped", async () => {
  const root = makeRoot();
  writeEvents(root, [
    { ts: 1_700_000_000_000, loop: "clean", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_060_000, loop: "clean", type: "run_end", run: 1, result: "changed", summary: "work" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_100_000, loop: "clean", type: "run_start", run: 2 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1_700_000_160_000, loop: "clean", type: "run_end", run: 2, result: "changed", summary: "more" }, // retired-name-ok: legacy event field in a fixture
  ]);
  const resolves: Array<(s: string) => void> = [];
  const { keys } = makeKeys(root, () => 0, () => Promise.resolve("STAT"), { runPatch: () => new Promise<string>((r) => resolves.push(r)) });
  openHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { ctrl: true, name: "w" });
  keys.handleKey(undefined, { ctrl: true, name: "p" });
  assert.equal(resolves.length, 2);
  resolves[0]!("LEFT-RUN");
  await settle();
  assert.ok(!(keys.state().trailCache ?? "").includes("LEFT-RUN"));
  resolves[1]!("OLDER-RUN");
  await settle();
  assert.ok((keys.state().trailCache ?? "").endsWith("OLDER-RUN"));
});

test("Ctrl+N off and back on starts the trail without its patch", async () => {
  const root = historyTrailRoot();
  let calls = 0;
  const { keys } = makeKeys(root, () => 0, () => Promise.resolve("S"), { runPatch: () => { calls++; return Promise.resolve("P"); } });
  openHistory(keys);
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { ctrl: true, name: "w" });
  await settle();
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  keys.handleKey(undefined, { ctrl: true, name: "n" });
  await settle();
  assert.equal(keys.state().trailPatch, false);
  assert.equal(calls, 1);
});
