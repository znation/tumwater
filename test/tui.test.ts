import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { logEvent } from "../src/events.js";
import { submitPrompt } from "../src/inbox-submit.js";
import { initProject } from "../src/init.js";
import { enqueueLanding } from "../src/landing-queue.js";
import { runTui } from "../src/ui/tui.js";
import { formatDate } from "../src/datetime.js";
import { atLocalTs as atNoon } from "./oracles.js";
import { makeRepo, tmpdir, writeBacklogFile } from "./repo-fixtures.js";
import { cli } from "./cli-harness.js";
import { writeLogLines } from "./log-fixtures.js";
import { makeTuiRepo, startTui, withTui } from "./tui-fixtures.js";

test("runTui renders the fleet table and an empty activity pane on start", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    const frame = tui.lastFrame();
    assert.match(frame, /\[Activity\]/); // default view: recent events
    assert.match(frame, /\(no events yet\)/);
    assert.equal(tui.lines().at(-1), "director ›"); // empty prompt line at the bottom, addressed to the director
    // The one enabled loop is listed as stopped (the orchestrator is not running).
    assert.match(frame, /clean/);
    assert.match(frame, /stopped/);
  });
});

// A pty whose window size was never set reports 0×0 (macOS `script`, some CI pty
// allocators). A reported 0 must degrade to the same sane defaults an unset size gets —
// under the old `??` fallbacks every line was width-clipped to empty and the operator
// saw only the clear-screen and the bare prompt prefix.
test("runTui degrades a reported 0×0 window to the default frame budget", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    const frame = tui.lastFrame();
    assert.match(frame, /\[Activity\]/); // the tab strip survives, not clipped to empty
    assert.match(frame, /clean/); // the fleet table renders
    assert.ok(frame.trim().split("\n").length > 2, "the frame carries dashboard content");
  }, { rows: 0, columns: 0 });
});

// Repaint-on-change: a re-render whose composed frame is byte-identical to the last one
// written must not touch the terminal again — the per-second timer re-renders an idle
// fleet's identical screen ~59 times a minute otherwise, and every keypress handler
// re-render follows the same rule (an inert keypress produces no frame). An inert key
// (f1: no handler branch claims it, applyKey passes it through unchanged) proves the
// skip without any state change; a following content-changing keypress still repaints.
test("runTui skips the terminal write when a re-render composes an identical frame", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    const initial = tui.lastFrame();
    const writes = tui.frames.length;
    tui.key(undefined, "f1"); // inert keypress: same state, same frame — no write
    assert.equal(tui.frames.length, writes, "identical frame is not rewritten");
    assert.equal(tui.lastFrame(), initial); // the screen still shows the original frame
    tui.key("h", "h"); // typing changes the prompt line: a new frame is written
    assert.equal(tui.frames.length, writes + 1, "changed frame is written");
    assert.match(tui.lastFrame(), /director › h$/m);
  });
});

// NO_COLOR: a set, non-empty variable suppresses every color and attribute (the
// no-color.org convention — dim body text is unreadable on some terminals and invisible to
// color-blind operators and screen readers) while the frame's layout stays exactly as
// styled runs render it. A NO_COLOR run's rendered frame is pure text — no escape at all.
// An empty NO_COLOR is not a set variable: styling stays on. Resolved per run, so the same
// process exercises both settings back to back.
test("runTui honors NO_COLOR: no escapes at all in the frame, layout unchanged", async () => {
  const repo = await makeTuiRepo();
  const origNoColor = process.env.NO_COLOR;
  try {
    process.env.NO_COLOR = "1";
    const plain = startTui(repo);
    try {
      const frame = plain.rawFrame();
      assert.doesNotMatch(frame, /\x1b\[/); // pure text: no styling, no cursor motion
      assert.doesNotMatch(frame, /\x1b\[2J/); // and never a screen clear
      assert.match(frame, /\[Activity\]/); // layout intact
      assert.match(frame, /\(no events yet\)/);
    } finally {
      await plain.quit();
    }
    process.env.NO_COLOR = ""; // empty: not a set variable — styling stays on
    // The styled run pins chalk's color level: the ink renderer paints through chalk,
    // whose level comes from stdout being a real TTY — which the fake terminal is not.
    // Level 1 is the basic 16-color palette the hand-rolled ANSI painting used.
    const { default: chalk } = await import("chalk");
    const savedLevel = chalk.level;
    chalk.level = 1;
    const styled = startTui(repo);
    try {
      assert.match(styled.rawFrame(), /\x1b\[90m/); // dim tones paint as gray
      assert.match(styled.rawFrame(), /\x1b\[97m/); // bold tones paint as bright white
    } finally {
      await styled.quit();
      chalk.level = savedLevel;
    }
  } finally {
    if (origNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = origNoColor;
  }
});

// Merge queue 4/5 — the TUI header shows the land queue badge while anything is queued or
// landing, and nothing when idle (the badge is empty at depth 0, so every existing
// header byte stays intact). The frame carries renderStatus's full output, header line
// included; the badge lands well inside the faked 100 columns (the budget badge after it
// is what clips on a long name).
test("runTui shows the land queue badge in the header while a landing is queued", async () => {
  const repo = await makeTuiRepo();
  enqueueLanding(repo, {
    role: "clean",
    sha: "abc1234",
    tick: 1,
    summary: "tidy something",
    enqueuedAt: Date.now(),
  });
  await withTui(repo, async (tui) => {
    assert.match(tui.lastFrame(), /· land queue: 1/);
  });
});

test("runTui shows no land queue badge when the queue is idle", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    assert.doesNotMatch(tui.lastFrame(), /land queue/);
  });
});

test("typing edits the prompt line; Enter queues it for the director", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (const ch of "fix the bug") tui.key(ch, ch);
    assert.equal(tui.lines().at(-1), "director › fix the bug");

    // Backspace deletes before the cursor; retype to restore.
    tui.key(undefined, "backspace");
    assert.equal(tui.lines().at(-1), "director › fix the bu");
    tui.key("g", "g");

    tui.key(undefined, "return");
    const inbox = path.join(repo, ".tumwater", "inbox");
    const files = fs.readdirSync(inbox).filter((f) => f.endsWith(".md"));
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(path.join(inbox, files[0]!), "utf8"), "fix the bug");

    // The flash confirms the queue and the event feed picks up the enqueue.
    const frame = tui.lastFrame();
    assert.match(frame, /queued for the director loop/);
    assert.match(frame, /user prompt queued: fix the bug/);
    // The input line is cleared after submit.
    assert.equal(tui.lines().at(-1), "director ›");

    // An empty Enter queues nothing more.
    tui.key(undefined, "return");
    assert.equal(fs.readdirSync(inbox).filter((f) => f.endsWith(".md")).length, 1);
  });
});

test("Up/Down recall the submitted prompts; the draft survives the round trip", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (const ch of "fix the bug") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /queued for the director loop/);

    // Up recalls the just-submitted prompt; Down returns to the empty live line.
    tui.key(undefined, "up");
    assert.equal(tui.lines().at(-1), "director › fix the bug");
    tui.key(undefined, "down");
    assert.equal(tui.lines().at(-1), "director ›");

    // A half-typed draft is saved by the first Up and restored past the newest entry.
    for (const ch of "wake ") tui.key(ch, ch);
    tui.key(undefined, "up");
    assert.equal(tui.lines().at(-1), "director › fix the bug");
    tui.key(undefined, "down"); // the newest entry again
    tui.key(undefined, "down"); // past it: the saved draft returns
    assert.equal(tui.lines().at(-1), "director › wake");
    // The restored draft submits like any other line (trimmed, like the CLI path).
    tui.key(undefined, "return");
    const inbox = path.join(repo, ".tumwater", "inbox");
    const files = fs.readdirSync(inbox).filter((f) => f.endsWith(".md"));
    assert.deepEqual(files.map((f) => fs.readFileSync(path.join(inbox, f), "utf8")), ["fix the bug", "wake"]);
  });
});

test("a mode switch settles the recall state: the draft survives, role text never leaks", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (const ch of "p1") tui.key(ch, ch);
    tui.key(undefined, "return"); // history: ["p1"]
    for (const ch of "director draft") tui.key(ch, ch);
    tui.key(undefined, "up"); // browsing: the line shows "p1", the draft is saved
    assert.equal(tui.lines().at(-1), "director › p1");

    // Opening the role editor mid-recall settles first: it saves the DRAFT, not the recalled
    // entry, so Esc later restores what the operator was writing.
    tui.key(undefined, "t", { ctrl: true }); // events → transcript (the one enabled role: clean)
    tui.key(undefined, "r", { ctrl: true });
    assert.equal(tui.lines().at(-1), "clean ›");
    for (const ch of "role text") tui.key(ch, ch);
    tui.key(undefined, "up"); // recall inside role mode: the shared history serves the role line too
    assert.equal(tui.lines().at(-1), "clean › p1");
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › director draft", "the saved draft, not the recalled entry");

    // The role-mode browse must not survive the exit: Down sits on the live line (the role
    // draft it would have restored stays out of the director line), and Up starts a fresh
    // browse that saves the director draft afresh.
    tui.key(undefined, "down");
    assert.equal(tui.lines().at(-1), "director › director draft", "no role text leaks onto the line");
    tui.key(undefined, "up");
    assert.equal(tui.lines().at(-1), "director › p1");
    tui.key(undefined, "down");
    tui.key(undefined, "down");
    assert.equal(tui.lines().at(-1), "director › director draft");

    // Budget mode settles the same way: entering mid-recall saves the draft, Esc restores it.
    tui.key(undefined, "up");
    tui.key(undefined, "b", { ctrl: true });
    assert.equal(tui.lines().at(-1), "daily cap $ 50");
    tui.key(undefined, "escape");
    assert.equal(tui.lines().at(-1), "director › director draft");
    tui.key(undefined, "down");
    assert.equal(tui.lines().at(-1), "director › director draft", "no stale recall state after budget mode");
  });
});

test("a failed prompt submit keeps the text and flashes the error instead of losing it", async () => {
  // Regression: the TUI cleared the input line before calling submitPrompt and left the call
  // unguarded, so a queue write failure (disk full, permissions) both silently dropped the
  // operator's prompt and threw out of the keypress handler, killing the TUI. The GUI's prompt
  // form already keeps the text and flashes the error on failure; the TUI must match.
  const repo = await makeTuiRepo();
  const tui = startTui(repo);
  const origWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(file).includes(`${path.sep}inbox${path.sep}`)) {
      throw new Error("ENOSPC: no space left on device, write");
    }
    return (origWriteFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as unknown as typeof fs.writeFileSync;
  try {
    for (const ch of "fix the bug") tui.key(ch, ch);
    tui.key(undefined, "return");

    const frame = tui.lastFrame();
    assert.match(frame, /error: ENOSPC/); // the reason is surfaced, not swallowed
    assert.doesNotMatch(frame, /queued for the director loop/);
    // The text is kept so it can be resubmitted once the failure is fixed.
    assert.equal(tui.lines().at(-1), "director › fix the bug");
    const inbox = path.join(repo, ".tumwater", "inbox");
    assert.equal(fs.readdirSync(inbox).filter((f) => f.endsWith(".md")).length, 0);
  } finally {
    fs.writeFileSync = origWriteFileSync;
    await tui.quit();
  }
});

/** Replace a file's first `_None yet._` placeholder (under its first section) with an entry. */
function seedEntry(root: string, file: string, heading: string): void {
  const p = path.join(root, file);
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("_None yet._", `${heading}\n`));
}

/** Local-noon fixture timestamps: oracles.ts's atLocalTs (daysAgo, hour 12) — a fixed hour keeps
 * the fixture from straddling midnight between seeding and collectReport's own clock read. */

test("Ctrl+T cycles Activity → Transcript → Backlog → Usage → Failures", async () => {
  const repo = await makeTuiRepo();
  // Seed the clean loop's pi log with one assistant turn so the transcript pane has
  // something real to show (the user message must never render).
  const logDir = path.join(repo, ".tumwater", "log");
  fs.mkdirSync(logDir, { recursive: true });
  writeLogLines(path.join(logDir, "clean.pi.jsonl"), [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_end", message: { role: "user", timestamp: Date.now(), content: [] } }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "tidied the imports" }] },
      }),
    ]);
  // Seed the event log with explicit ts values (logEvent always stamps Date.now(), so direct
  // append is the controllable path): ticks across two roles on two days plus one merge.
  const eventsFile = path.join(repo, ".tumwater", "log", "events.jsonl");
  writeLogLines(eventsFile, [
      JSON.stringify({ ts: atNoon(1), loop: "feature", type: "tick_end", tick: 1, result: "changed", tokens: 500, costUsd: 0.5 }),
      JSON.stringify({ ts: atNoon(0), loop: "clean", type: "tick_end", tick: 2, result: "no_change", tokens: 150 }),
      JSON.stringify({ ts: atNoon(0), loop: "feature", type: "merged", commit: "abc1234", summary: "x" }),
    ]);

  await withTui(repo, async (tui) => {
    assert.match(tui.lastFrame(), /\[Activity\]/);

    tui.key(undefined, "t", { ctrl: true });
    let frame = tui.lastFrame();
    assert.match(frame, /\[Transcript: clean \(1\/1\)\]/);
    // The loop's own keys ride the hint line while its transcript is up.
    assert.match(frame, /Ctrl\+R prompt clean · Ctrl\+P pause\/resume · Ctrl\+W wake · Ctrl\+A abort/);
    assert.match(frame, /tidied the imports/); // assistant text renders…
    assert.doesNotMatch(frame, /Build a thing/); // …but never the user's tick prompt

    tui.key(undefined, "t", { ctrl: true });
    frame = tui.lastFrame();
    assert.match(frame, /\[Backlog\]/);
    // One plan and one bug seeded above render under their counted subheaders; the empty
    // questions section renders (none).
    seedEntry(repo, "PLANS.md", "### Add a --json flag");
    seedEntry(repo, "BUGS.md", "### Crashes on empty input");
    tui.key(undefined, "left"); // any keypress re-renders the current view
    frame = tui.lastFrame();
    assert.match(frame, /plans \(1\):/);
    assert.match(frame, /Add a --json flag/);
    assert.match(frame, /open bugs \(1\):/);
    assert.match(frame, /Crashes on empty input/);
    assert.match(frame, /open questions \(0\):/);
    assert.match(frame, /\(none\)/);

    tui.key(undefined, "t", { ctrl: true }); // → usage report
    frame = tui.lastFrame();
    assert.match(frame, /\[Usage\]/);
    // The pane shows the same Markdown `tumwater report` prints for this root and window:
    // the Totals line plus a day row per seeded event (tokens bucketed by local day).
    assert.match(frame, /Totals:/);
    assert.match(frame, new RegExp(`\\| ${formatDate(new Date(atNoon(1))).slice(5)} \\| 500`));
    assert.match(frame, new RegExp(`\\| ${formatDate(new Date(atNoon(0))).slice(5)} \\| 150`));

    tui.key(undefined, "t", { ctrl: true }); // → failures
    frame = tui.lastFrame();
    assert.match(frame, /\[Failures\]/);
    // The pane shows exactly renderFailureMarkdown(collectFailureReport(root, 14)): the
    // digest head, with a real outcome row for the seeded ticks' roles.
    assert.match(frame, /# tumwater failure digest/);
    assert.match(frame, /## Outcome by role/);

    tui.key(undefined, "t", { ctrl: true });
    assert.match(tui.lastFrame(), /\[Activity\]/); // wraps back to Activity
  });
});

test("project status browses entries in full with up/down and resets on Ctrl+T", async () => {
  const repo = await makeTuiRepo();
  // One plan with a real body (the seeded placeholder file has none) so browsing shows more
  // than the heading, plus one bare bug to cross into the next section.
  writeBacklogFile(repo, "PLANS.md", [
    {
      heading: "## Planned",
      body: `### Add a --json flag (planned 2026-09-05)

**Goal.** Machine-readable status output.

A second body line, kept verbatim.`,
    },
    { heading: "## Done" },
  ]);
  seedEntry(repo, "BUGS.md", "### Crashes on empty input");

  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → transcript (one enabled role)
    tui.key(undefined, "t", { ctrl: true }); // → project status
    let frame = tui.lastFrame();
    assert.match(frame, /\[Backlog\]/);
    assert.match(frame, /Add a --json flag/); // list mode shows the heading…
    assert.doesNotMatch(frame, /Machine-readable status output/); // …but not its body

    tui.key(undefined, "down"); // opens the first entry's full body
    frame = tui.lastFrame();
    assert.match(frame, /^plan: Add a --json flag \(planned 2026-09-05\)$/m);
    assert.match(frame, /Machine-readable status output/);
    assert.match(frame, /A second body line, kept verbatim/);

    tui.key(undefined, "down"); // crosses into the bugs section (the bare bug)
    frame = tui.lastFrame();
    assert.match(frame, /^bug: Crashes on empty input$/m);
    assert.match(frame, /no details for this entry/); // a bare heading has an empty body

    tui.key(undefined, "up"); // back to the plan (index 0 — the FIRST entry)
    assert.match(tui.lastFrame(), /plan: Add a --json flag/);
    tui.key(undefined, "down"); // crosses into the bugs section again — index 1 is the LAST entry…
    assert.match(tui.lastFrame(), /bug: Crashes on empty input/);
    tui.key(undefined, "down"); // …so this one wraps from the last back to the first
    assert.match(tui.lastFrame(), /plan: Add a --json flag/);

    tui.key(undefined, "t", { ctrl: true }); // leaves the view and clears the selection…
    assert.match(tui.lastFrame(), /\[Usage\]/); // …onto the usage-report pane (no events seeded)
    tui.key(undefined, "t", { ctrl: true }); // → failures
    tui.key(undefined, "t", { ctrl: true }); // → events
    tui.key(undefined, "t", { ctrl: true }); // → transcript
    tui.key(undefined, "t", { ctrl: true }); // → project status again
    frame = tui.lastFrame();
    assert.match(frame, /\[Backlog\]/); // list mode restored…
    assert.doesNotMatch(frame, /Machine-readable status output/); // …body no longer shown
  });
});

/** The "body line NN" numbers currently shown in the pane (ANSI codes ignored). */
function visibleBodyLines(frame: string): number[] {
  const out: number[] = [];
  for (const m of frame.matchAll(/body line (\d{2})/g)) out.push(Number(m[1]));
  return out;
}

test("PgDn/PgUp page the selected entry's body, clamped at both ends", async () => {
  const repo = await makeTuiRepo();
  // One plan whose 80-line body overflows any pane budget this fake TTY can produce
  // (rows=40 → budget ≤ ~33), so paging has real room in both directions.
  writeBacklogFile(repo, "PLANS.md", [
    {
      heading: "## Planned",
      body: `### Long body plan (planned 2026-09-05)

${Array.from({ length: 80 }, (_, i) => `body line ${String(i + 1).padStart(2, "0")}`).join("\n")}`,
    },
    { heading: "## Done" },
  ]);

  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → transcript (one enabled role)
    tui.key(undefined, "t", { ctrl: true }); // → project status
    tui.key(undefined, "down"); // open the plan's full body

    let frame = tui.lastFrame();
    assert.match(frame, /^plan: Long body plan \(planned 2026-09-05\)$/m);
    // The head window shows the first budget-many lines.
    let win = visibleBodyLines(frame);
    assert.ok(win.length >= 3, `pane shows a real window: ${win.length} lines`);
    assert.deepEqual(win, Array.from({ length: win.length }, (_, i) => i + 1));

    // One PgDn advances exactly one page (the window is far from the tail at this size).
    tui.key(undefined, "pagedown");
    frame = tui.lastFrame();
    win = visibleBodyLines(frame);
    const b = win.length;
    assert.deepEqual(win, Array.from({ length: b }, (_, i) => i + b + 1)); // lines B+1..2B

    // Repeated PgDn clamps at the tail: the last line is visible and further presses are no-ops.
    for (let i = 0; i < 30; i++) tui.key(undefined, "pagedown");
    frame = tui.lastFrame();
    win = visibleBodyLines(frame);
    assert.equal(win[win.length - 1], 80, "tail line visible at the clamp");
    const tailFrame = frame;
    tui.key(undefined, "pagedown");
    assert.equal(tui.lastFrame(), tailFrame, "PgDn past the tail is a no-op");

    // PgUp mirrors back to the head and clamps there.
    for (let i = 0; i < 30; i++) tui.key(undefined, "pageup");
    frame = tui.lastFrame();
    win = visibleBodyLines(frame);
    assert.equal(win[0], 1, "head line visible again at the top clamp");
    const headFrame = frame;
    tui.key(undefined, "pageup");
    assert.equal(tui.lastFrame(), headFrame, "PgUp past the head is a no-op");
  });
});

test("PgUp/PgDn are ignored in project-status list mode (no entry selected)", async () => {
  const repo = await makeTuiRepo();
  seedEntry(repo, "PLANS.md", "### Add a --json flag"); // something to show in the list

  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "t", { ctrl: true }); // → project status (list mode)
    assert.match(tui.lastFrame(), /plans \(1\):/);

    const listFrame = tui.lastFrame();
    tui.key(undefined, "pagedown");
    assert.equal(tui.lastFrame(), listFrame, "PgDn with no selection re-renders the same list");
    tui.key(undefined, "pageup");
    assert.equal(tui.lastFrame(), listFrame, "…and so does PgUp");
  });
});

test("a stale entry selection falls back to the empty list when entries disappear", async () => {
  const repo = await makeTuiRepo();
  writeBacklogFile(repo, "PLANS.md", [
    { heading: "## Planned", body: "### Add a --json flag (planned 2026-09-05)\n\n**Goal.** Machine-readable status output." },
    { heading: "## Done" },
  ]);

  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "t", { ctrl: true }); // → project status
    tui.key(undefined, "down"); // open the plan's body (selection now active)
    assert.match(tui.lastFrame(), /Machine-readable status output/);

    // The entry is removed from PLANS.md while selected (a loop landed an edit).
    writeBacklogFile(repo, "PLANS.md", [{ heading: "## Planned" }, { heading: "## Done" }]);

    // A keypress in the stale state: PgDn takes the no-entries path of the page handler…
    tui.key(undefined, "pagedown");
    const frame = tui.lastFrame();
    assert.match(frame, /\[Backlog\]/); // list-mode header restored
    assert.match(frame, /\(no planned features, open bugs, or open questions\)/);
    assert.doesNotMatch(frame, /Machine-readable status output/); // …and the body is gone
  });
});

test("open questions raise an attention line under the header", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    assert.doesNotMatch(tui.lastFrame(), /needs your answer/); // seeded QUESTIONS.md is empty

    // Post a question under ## Open (the first "_None yet._" placeholder).
    seedEntry(repo, "QUESTIONS.md", "### Q1: which database? (asked 2026-09-29)");

    // Any keypress re-renders: the question counts in the header, and its attention line —
    // the dashboard's alert wording — sits right under it, without the date note.
    tui.key(undefined, "left");
    const ls = tui.lines();
    assert.match(ls[0] ?? "", /· questions: 1/);
    assert.equal(ls[1], "? 1 question needs your answer — Q1: which database?");
  });
});
test("queued prompts render numbered above the activity pane and shrink its budget", async () => {
  const repo = await makeTuiRepo();
  // Seed enough events that the recent-activity pane is full at the default budget, so a
  // shrinking budget visibly drops body lines instead of just showing fewer than it could.
  for (let i = 1; i <= 30; i++) logEvent(repo, { loop: "clean", type: "tick_start", tick: i });

  await withTui(repo, async (tui) => {
    // Nothing queued → no numbered lines anywhere in the frame.
    assert.doesNotMatch(tui.lastFrame(), /^\d+\. /m);

    // Body lines run from after the pane header to the blank line before the hint.
    const bodyLen = () => {
      const ls = tui.lines();
      const h = ls.findIndex((l) => l.includes("[Activity]"));
      let n = 0;
      for (let i = h + 1; i < ls.length && (ls[i] ?? "") !== ""; i++) n++;
      return n;
    };
    const full = bodyLen();

    submitPrompt(repo, "fix the login bug");
    submitPrompt(repo, "z".repeat(120)); // overlong: preview truncated to 80 chars upstream
    tui.key(undefined, "left"); // any keypress re-renders with a fresh snapshot

    const ls = tui.lines();
    const h = ls.findIndex((l) => l.includes("[Activity]"));
    assert.equal(ls[h - 2], "1. fix the login bug", "first queue line sits above the pane");
    assert.ok((ls[h - 1] ?? "").startsWith("2. "), "second queue line is numbered in order");
    // The overlong prompt's preview is ≤80 chars, so its line fits the terminal width.
    assert.ok((ls[h - 1] ?? "").length <= 100);

    // Each queue line consumes exactly one line of budget: the full pane lost two body lines.
    assert.equal(bodyLen(), full - 2);

    // A narrower terminal clips each queue line to its width — no wrap, no scroll.
    (process.stdout as { columns?: number }).columns = 60;
    tui.key(undefined, "left");
    const ls2 = tui.lines();
    const h2 = ls2.findIndex((l) => l.includes("[Activity]"));
    for (const line of [ls2[h2 - 2], ls2[h2 - 1]]) {
      assert.ok(line !== undefined && line.length <= 60, `queue line fits the width: ${JSON.stringify(line)}`);
    }
    (process.stdout as { columns?: number }).columns = 100;
  });
});

test("runTui refuses to start without an interactive terminal", async () => {
  const repo = await makeTuiRepo();
  // Force the non-TTY state regardless of where the test runner itself is attached
  // (e.g. `tumwater tui | cat` must fail with a clear error, not crash or hang).
  const origIn = (process.stdin as { isTTY?: boolean }).isTTY;
  const origOut = (process.stdout as { isTTY?: boolean }).isTTY;
  (process.stdin as { isTTY?: boolean }).isTTY = undefined;
  (process.stdout as { isTTY?: boolean }).isTTY = undefined;
  try {
    await assert.rejects(
      runTui(repo),
      /needs an interactive terminal: neither stdin \(prompt input\) nor stdout \(the dashboard\) is a TTY/,
    );
  } finally {
    (process.stdin as { isTTY?: boolean }).isTTY = origIn;
    (process.stdout as { isTTY?: boolean }).isTTY = origOut;
  }
});


test("Ctrl+D exits cleanly: raw mode restored off, render timer cleared", async () => {
  const repo = await makeTuiRepo();
  const tui = startTui(repo);
  await new Promise((r) => setImmediate(r)); // ink's tree effects mount raw mode
  assert.equal(tui.rawModes.length, 1); // setRawMode(true) on entry, via ink's useInput
  await tui.quit();
  assert.deepEqual(tui.rawModes, [true, false]);
  assert.equal(tui.chunks.at(-1), "\n"); // final newline after the last frame
  assert.ok(tui.clearCalls >= 1, "the render interval is cleared on exit");
});

// The flicker BUGS.md recorded: every changed frame used to erase the whole screen
// (`\x1b[2J`) and repaint it. Ink's renderer diff-renders instead — a changed frame
// rewrites only its changed lines, so no frame of a run ever carries a screen clear.
// An inert keypress (f1) re-renders an identical frame and must not write at all; a
// one-cell change (typing into the prompt line) writes the frame without a clear.
test("runTui's renderer never emits a screen clear between frames (flicker regression)", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "f1"); // identical frame: no write at all
    tui.key("h", "h"); // one-cell change: the prompt line
    assert.doesNotMatch(tui.chunks.join(""), /\x1b\[2J/); // never a whole-screen erase
    assert.match(tui.lastFrame(), /director › h/); // the changed cell is on screen
  });
});

// PgDn/PgUp in the usage-report view page the cached
// report within the pane's line budget, clamped at both ends. The 14-day report is 24
// lines (8 chrome + 14 day rows + 2); a dozen queued prompts each consume one line of
// the budget, so the window (≤ ~21 lines at rows=40) is strictly smaller than the report
// and paging has real room in both directions.
test("the usage-report pane pages with PgDn/PgUp, clamped at both ends", async () => {
  const repo = await makeTuiRepo();
  for (let i = 1; i <= 12; i++) submitPrompt(repo, `prompt ${i}`);

  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → transcript (one enabled role)
    tui.key(undefined, "t", { ctrl: true }); // → project status
    tui.key(undefined, "t", { ctrl: true }); // → usage report
    let frame = tui.lastFrame();
    assert.match(frame, /usage report/);
    assert.match(frame, /# tumwater usage report/); // head window shows the title
    assert.doesNotMatch(frame, /\*\*Ticks by role:\*\*/); // …and not the tail

    // Repeated PgDn advances pages and clamps at the tail: the tail line is visible and
    // the title has scrolled out of the window.
    for (let i = 0; i < 8; i++) tui.key(undefined, "pagedown");
    frame = tui.lastFrame();
    assert.match(frame, /\*\*Ticks by role:\*\*/);
    assert.doesNotMatch(frame, /# tumwater usage report/);
    const tailFrame = frame;
    tui.key(undefined, "pagedown");
    assert.equal(tui.lastFrame(), tailFrame, "PgDn past the tail is a no-op");

    // PgUp mirrors back to the head and clamps there.
    for (let i = 0; i < 8; i++) tui.key(undefined, "pageup");
    frame = tui.lastFrame();
    assert.match(frame, /# tumwater usage report/);
    assert.doesNotMatch(frame, /\*\*Ticks by role:\*\*/);
    const headFrame = frame;
    tui.key(undefined, "pageup");
    assert.equal(tui.lastFrame(), headFrame, "PgUp past the head is a no-op");
  });
});

// The failures pane (the view after usage report) reuses the same cached-Markdown machinery.
// With no events the 14-day digest is ~24 lines; a dozen queued prompts shrink the window to
// ~12 lines (rows=40), so paging has real room in both directions.
test("the failures pane pages with PgDn/PgUp, clamped at both ends", async () => {
  const repo = await makeTuiRepo();
  for (let i = 1; i <= 12; i++) submitPrompt(repo, `prompt ${i}`);

  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → transcript (one enabled role)
    tui.key(undefined, "t", { ctrl: true }); // → project status
    tui.key(undefined, "t", { ctrl: true }); // → usage report
    tui.key(undefined, "t", { ctrl: true }); // → failures
    let frame = tui.lastFrame();
    assert.match(frame, /\[Failures\][\s\S]*PgUp\/PgDn scroll/);
    assert.match(frame, /# tumwater failure digest/); // head window shows the title
    assert.doesNotMatch(frame, /## Landed in the window/); // …and not the tail

    // Repeated PgDn advances pages and clamps at the tail: the tail line is visible and
    // the title has scrolled out of the window.
    for (let i = 0; i < 8; i++) tui.key(undefined, "pagedown");
    frame = tui.lastFrame();
    assert.match(frame, /## Landed in the window/);
    assert.doesNotMatch(frame, /# tumwater failure digest/);
    const tailFrame = frame;
    tui.key(undefined, "pagedown");
    assert.equal(tui.lastFrame(), tailFrame, "PgDn past the tail is a no-op");

    // Re-entering the view recomputes the cache and starts at the head again.
    tui.key(undefined, "t", { ctrl: true }); // → events
    tui.key(undefined, "t", { ctrl: true }); // → transcript
    tui.key(undefined, "t", { ctrl: true }); // → project status
    tui.key(undefined, "t", { ctrl: true }); // → usage report
    tui.key(undefined, "t", { ctrl: true }); // → failures
    assert.match(tui.lastFrame(), /# tumwater failure digest/);

    tui.key(undefined, "pageup");
    assert.match(tui.lastFrame(), /# tumwater failure digest/, "PgUp at the head is a no-op");
  });
});

// --- `tui` through the real CLI entry point: main()'s tui case (arg rejection -> readiness
// gate -> runTui) as a child process. A spawned child has no TTY, so the happy path ends in
// a clean error and the whole wiring is observable without a terminal.

test("tui gates on repo readiness, rejects extra args, and fails cleanly without a terminal", async () => {
  // Not a git repo: the readiness gate fires before any TUI work -- a regression that dropped
  // requireReadyRepo here would crash deep in snapshot() instead of naming the fix.
  let r = await cli(tmpdir(), "tui");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a git repository/);

  const repo = makeRepo();
  await initProject(repo, "cli tui test");

  // A ready repo: runTui's TTY requirement surfaces as a clean CLI error (exit 1) and the
  // command exits rather than hanging -- which also bounds this test if that ever regresses.
  r = await cli(repo, "tui");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /needs an interactive terminal/);

  // Like every other no-flag command, tui rejects stray arguments instead of ignoring them.
  r = await cli(repo, "tui", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /takes no arguments/);
});
