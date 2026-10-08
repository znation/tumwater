import test from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers/json-read.js";
import { queuedRolePrompts } from "../src/inbox/inbox.js";
import { DIRECTOR_PROMPT_MAX_CHARS } from "../src/inbox/inbox-submit.js";
import { wakeRequestPath } from "../src/paths.js";
import { makeTuiRepo, withTui } from "./tui-fixtures.js";

// Ctrl+R role-prompt mode: the per-loop prompt editor on the transcript view — Enter queues
// into that loop's own inbox queue and wakes it, a failed submit flashes and keeps the editor
// open, and the mode keeps its own draft apart from the director line (Esc/Ctrl+R restore it).
test("Ctrl+R opens the role-prompt editor; Enter queues for the viewed loop and wakes it", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → transcript (the one enabled role: clean)
    assert.match(tui.lastFrame(), /Ctrl\+R prompt clean/); // the hint names the viewed loop

    tui.key(undefined, "r", { ctrl: true });
    assert.match(tui.lastFrame(), /prompt for clean: Enter to send, Esc to cancel/);
    // The bottom hint names the addressed loop while the mode holds the line.
    assert.match(tui.lastFrame(), /Enter send to clean · ↑↓ history · Esc cancel · Ctrl\+D quit/);
    for (const ch of "check the clean queue") tui.key(ch, ch);
    tui.key(undefined, "return");

    // The prompt landed in the viewed loop's own queue — verifiable with
    // `tumwater prompt --list --role clean`'s core — and the wake marker names it.
    assert.deepEqual(queuedRolePrompts(repo, "clean"), ["check the clean queue"]);
    assert.deepEqual(readJson<{ roles: string[] }>(wakeRequestPath(repo)).roles, ["clean"]);
    assert.match(tui.lastFrame(), /queued for the clean loop/);
    assert.equal(tui.lines().at(-1), "director ›");

    // A whitespace-only Enter queues nothing and stays in edit mode with the way out.
    tui.key(undefined, "r", { ctrl: true });
    tui.key(" ", " ");
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), /prompt text is empty/);
    assert.deepEqual(queuedRolePrompts(repo, "clean"), ["check the clean queue"]);
    assert.equal(tui.lines().at(-1), "clean ›"); // the space stays in the line state; ink trims the invisible trailing column
  });
});

test("a throwing role-prompt submit flashes the error and keeps the editor open", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    tui.key(undefined, "t", { ctrl: true }); // events → the one enabled role's transcript
    tui.key(undefined, "r", { ctrl: true }); // role-prompt mode for clean

    // One keypress can carry a whole composed string (IME input arrives that way), so a
    // paste past the length cap is a realistic submit failure: submitRolePrompt rejects
    // it before anything is queued or woken, and the catch turns the throw into a flash —
    // an unguarded throw would escape the keypress handler and kill the TUI.
    const oversized = "a".repeat(DIRECTOR_PROMPT_MAX_CHARS + 1);
    tui.key(oversized, oversized);
    tui.key(undefined, "return");
    assert.match(tui.lastFrame(), new RegExp(`error: the prompt is ${oversized.length} chars`));
    assert.match(tui.lastFrame(), /rides into the clean tick's prefill/);
    assert.deepEqual(queuedRolePrompts(repo, "clean"), [], "nothing queued behind the failure");
    // The editor stays open with the oversized text kept, so the operator can trim it.
    assert.match(tui.lastFrame(), /Enter send to clean/);

    // Esc drops the mode with its draft; a fresh short prompt then queues normally —
    // the failure left nothing wedged.
    tui.key(undefined, "escape");
    tui.key(undefined, "r", { ctrl: true });
    tui.key("check the clean queue", "check the clean queue");
    tui.key(undefined, "return");
    assert.deepEqual(queuedRolePrompts(repo, "clean"), ["check the clean queue"]);
    assert.match(tui.lastFrame(), /queued for the clean loop/);
  });
});

test("role-prompt mode keeps its own draft, refuses Ctrl+B, and Esc/Ctrl+R restore byte-for-byte", async () => {
  const repo = await makeTuiRepo();
  await withTui(repo, async (tui) => {
    for (const ch of "director draft") tui.key(ch, ch);
    tui.key(undefined, "t", { ctrl: true });
    tui.key(undefined, "r", { ctrl: true });
    assert.equal(tui.lines().at(-1), "clean ›", "entering the mode blanks the line and names the loop");

    // Mutually exclusive: Ctrl+B while role-prompt mode holds the line flashes the way out
    // instead of entering budget mode (which would clobber a saved draft pair).
    tui.key(undefined, "b", { ctrl: true });
    assert.match(tui.lastFrame(), /finish or cancel the prompt for clean first \(Esc cancels\)/);
    assert.doesNotMatch(tui.lastFrame(), /edit daily cost budget/);
    assert.equal(tui.lines().at(-1), "clean ›", "the refusal leaves the role editor open");

    for (const ch of "role text") tui.key(ch, ch);
    tui.key(undefined, "escape"); // Esc restores the saved director draft
    assert.equal(tui.lines().at(-1), "director › director draft");
    assert.match(tui.lastFrame(), /Enter send · ↑↓ history · Ctrl\+R prompt clean/); // the transcript view's ordinary hint is back

    // Ctrl+R again toggles the mode off the same way.
    tui.key(undefined, "r", { ctrl: true });
    for (const ch of "queued text") tui.key(ch, ch);
    tui.key(undefined, "r", { ctrl: true });
    assert.equal(tui.lines().at(-1), "director › director draft");
    assert.match(tui.lastFrame(), /role prompt cancelled/);
    assert.deepEqual(queuedRolePrompts(repo, "clean"), [], "the toggle-off queued nothing");

    // A successful send restores the saved draft too.
    tui.key(undefined, "r", { ctrl: true });
    for (const ch of "queued text") tui.key(ch, ch);
    tui.key(undefined, "return");
    assert.deepEqual(queuedRolePrompts(repo, "clean"), ["queued text"]);
    assert.equal(tui.lines().at(-1), "director › director draft");
  });
});
