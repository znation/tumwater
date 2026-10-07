import { sleep } from "./wait.js";
import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_COMPOSER_JS } from "../src/ui/gui/gui-client-composer.js";
import { promptImageExtensionProblem, promptImageSizeProblem, PROMPT_IMAGE_MAX_BYTES } from "../src/inbox/inbox-attachments.js";
import { clientRegion, ESC_LINE } from "./gui-client-scope.js";

// The dashboard's composer, browser-side (src/ui/gui/gui-client-composer.ts): the target selector
// with its per-target unsent drafts, the hint and character counter, the image attachments
// (dropped or pasted onto the box, rendered as removable chips, capped), and the submit that
// reads the bytes and queues the prompt through the same endpoints the CLI's "prompt" and
// "prompt --role" use. The pattern test/gui-client.test.ts uses: the script's own esc() and the
// real format region, plus the composer blob, run in one function scope with stand-ins for the
// DOM and the server.

type FakeEl = {
  value: string;
  placeholder: string;
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  className: string;
  disabled: boolean;
  scrollHeight: number;
  dataset: Record<string, string>;
  style: Record<string, string>;
  classes: string[];
  focusCalls: Array<Record<string, unknown> | undefined>;
  scrollCalls: Array<Record<string, unknown> | undefined>;
  selections: Array<[number, number]>;
  listeners: Record<string, (ev?: unknown) => unknown>;
  addEventListener(type: string, fn: (ev?: unknown) => unknown): void;
  classList: { add(c: string): void; remove(c: string): void };
  focus(opts?: Record<string, unknown>): void;
  scrollIntoView(opts?: Record<string, unknown>): void;
  setSelectionRange(a: number, b: number): void;
};

/** The composer functions the tests drive, as the blob declares them. */
type ComposerFns = {
  renderComposer(d: unknown): void;
  setTarget(t: string): void;
  draftForDirector(text: string): void;
  focusComposer(): void;
  addPromptImages(files: Array<{ name: string; type: string; size: number }>): number;
  isImageFile(f: { name: unknown }): boolean;
  fmtImageSize(n: number): string;
};

/** The composer's DOM: one input, its picker and counter, the queued-prompts link, the hint,
 * the image chip box, and the form with its send button. */
function composerEls() {
  const els = new Map<string, FakeEl>();
  const el = (id: string): FakeEl => {
    let node = els.get(id);
    if (!node) {
      node = {
        value: "", placeholder: "", innerHTML: "", textContent: "", hidden: true,
        className: "", disabled: false, scrollHeight: 500, dataset: {}, style: {}, classes: [],
        focusCalls: [], scrollCalls: [], selections: [], listeners: {},
        addEventListener(type, fn) { node!.listeners[type] = fn; },
        classList: {
          add(c) { node!.classes.push(c); },
          remove(c) { const i = node!.classes.indexOf(c); if (i >= 0) node!.classes.splice(i, 1); },
        },
        focus(opts) { node!.focusCalls.push(opts); },
        scrollIntoView(opts) { node!.scrollCalls.push(opts); },
        setSelectionRange(a, b) { node!.selections.push([a, b]); },
      };
      els.set(id, node);
    }
    return node;
  };
  /** Fire one of the blob's registered listeners (submit lives on the form, paste on the input). */
  const fire = (target: FakeEl, type: string, ev?: unknown): unknown => target.listeners[type]?.(ev);
  return { el, input: () => el("prompt"), form: () => el("promptform"), images: () => el("promptimages"), fire };
}

/** Everything the composer blob reaches beyond its own helpers: the DOM, the fleet view state
 * it inherits from the concatenation, and the server. `failRead` makes the FileReader stand-in
 * error, to drive the unreadable-attachment path. */
function composerScope(opts: { activeView?: string; innerWidth?: number; failRead?: boolean } = {}) {
  const { el, input, form, images, fire } = composerEls();
  const posts: Array<{ path: string; body: unknown }> = [];
  const flashes: string[] = [];
  let refreshes = 0;
  let fail = false;
  // A one-shot gate: holdNextPost() arms it, the next postJson awaits it, releaseHold() lets
  // the post through — how a test holds a submit mid-flight to exercise the sending guard.
  let gate: Promise<void> | null = null;
  let openGate: (() => void) | null = null;
  const closeDrawerCalls: string[] = [];
  const location = { hash: "" };
  class Element {
    dataset: Record<string, string> = {};
    closest(): Element { return this; }
  }
  class FileReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(): void {
      queueMicrotask(() => {
        if (opts.failRead) { this.onerror?.(); return; }
        this.result = "data:image/png;base64,QUJD";
        this.onload?.();
      });
    }
  }
  const code = [ESC_LINE, clientRegion("format"), GUI_CLIENT_COMPOSER_JS,
    `return { renderComposer, setTarget, draftForDirector, focusComposer, addPromptImages, isImageFile, fmtImageSize };`]
    .join("\n");
  const keys = ["$", "window", "location", "activeView", "drawer", "closeDrawer", "showFlash", "refresh", "postJson", "Element", "FileReader"];
  const run = new Function(...keys, code) as (...args: unknown[]) => ComposerFns;
  const scope = run(
    el,
    { innerHeight: 800, innerWidth: opts.innerWidth ?? 1280 },
    location,
    opts.activeView ?? "fleet",
    "open",
    () => { closeDrawerCalls.push("close"); },
    (msg: string) => { flashes.push(msg); },
    () => { refreshes++; },
    async (path: string, body: unknown) => {
      if (gate) { const g = gate; gate = null; await g; }
      posts.push({ path, body });
      if (fail) throw new Error(path + " failed: HTTP 400 — the prompt is 5000 chars");
      return { ok: true };
    },
    Element,
    FileReader,
  );
  /** Let the submit handler's awaits (file reads, posts) settle. */
  const flush = async () => {
    for (let i = 0; i < 3; i++) await sleep(0);
  };
  return {
    scope, el, input, form, images, fire, posts, flashes, refreshes: () => refreshes, closeDrawerCalls, location,
    setFail: (v: boolean) => { fail = v; },
    holdNextPost: () => { gate = new Promise<void>((r) => { openGate = r; }); },
    releaseHold: () => { openGate?.(); openGate = null; },
    ElementCtor: Element,
    flush,
  };
}

const IMG = { name: "a.png", type: "image/png", size: 1048576 };
const STATUS = { loops: [{ role: "qa" }, { role: "bugfix" }], inbox: 2, roleInbox: { qa: 1 } };
const SUBMIT = { preventDefault: () => {} };

test("the target picker rebuilds only when the fleet's roles change, and a vanished target falls back to the director", () => {
  const s = composerScope();
  s.scope.renderComposer(STATUS);
  const select = s.el("prompttarget");
  assert.match(select.innerHTML, /<option value='director'>Director<\/option>/);
  assert.match(select.innerHTML, /<optgroup label='One loop, at its next tick'>/);
  assert.match(select.innerHTML, /<option value='qa'>qa<\/option>/);
  assert.match(select.innerHTML, /<option value='bugfix'>bugfix<\/option>/);
  const link = s.el("queuelink");
  assert.equal(link.hidden, false);
  assert.equal(link.dataset.act, "queued");
  assert.equal(link.textContent, "3 prompts queued");

  // Same roles: no rebuild — the picker keeps whatever is in it.
  select.innerHTML = "SENTINEL";
  s.scope.renderComposer(STATUS);
  assert.equal(select.innerHTML, "SENTINEL");

  // A fleet without qa: rebuilt without qa, and a composer aimed at qa falls back to the
  // director (its placeholder switches back with the target).
  s.scope.setTarget("qa");
  s.scope.renderComposer({ loops: [{ role: "bugfix" }], inbox: 0, roleInbox: {} });
  assert.doesNotMatch(select.innerHTML, /value='qa'/);
  assert.equal(s.input().placeholder, "Tell the fleet what to do next…");
  const link2 = s.el("queuelink");
  assert.equal(link2.hidden, true, "an empty queue hides the link");
  assert.equal(link2.textContent, "0 prompts queued");
});

test("the composer keeps one unsent draft per target and swaps hint and placeholder with it", () => {
  const s = composerScope();
  s.scope.renderComposer(STATUS);
  const input = s.input();
  input.value = "fix the flake";
  s.scope.setTarget("qa");
  assert.equal(input.value, "", "a fresh target starts from its own (empty) draft");
  assert.equal(input.placeholder, "Tell the qa loop what to do on its next tick…");
  assert.match(s.el("prompthint").innerHTML, /Queued for the qa loop&#39;s next tick; the loop wakes right away\./);
  assert.match(s.el("prompthint").innerHTML, /<kbd>Enter<\/kbd> sends/);
  input.value = "retest --watch";
  s.scope.setTarget("bugfix");
  assert.equal(input.value, "");
  s.scope.setTarget("qa");
  assert.equal(input.value, "retest --watch", "each target keeps its own unsent draft");
  s.scope.setTarget("director");
  assert.equal(input.value, "fix the flake");
  assert.equal(input.placeholder, "Tell the fleet what to do next…");
});

test("the character counter appears past 80% of the cap and turns red past it, and the box autosizes", () => {
  const s = composerScope();
  const input = s.input();
  const count = s.el("promptcount");
  const type = (n: number) => { input.value = "x".repeat(n); s.fire(input, "input"); };
  type(100);
  assert.equal(count.textContent, "", "a short draft shows no counter");
  type(3500);
  assert.match(count.textContent!, /3,500 \/ 4,096/);
  assert.equal(count.className, "");
  type(5000);
  assert.match(count.textContent!, /5,000 \/ 4,096/);
  assert.equal(count.className, "res t-red", "past the cap the counter turns red");
  assert.equal(input.style.height, "320px", "autosize caps the box at 40% of the window height");
});

test("draftForDirector puts text in the box and leaves the cursor at its end", () => {
  const s = composerScope();
  s.scope.renderComposer(STATUS);
  s.scope.setTarget("qa");
  s.scope.draftForDirector("prefer the stdlib");
  const input = s.input();
  assert.equal(input.value, "prefer the stdlib");
  assert.deepEqual(input.selections, [[17, 17]], "the cursor lands at the end of the text");
  assert.deepEqual(input.focusCalls, [{ preventScroll: true }]);
  assert.equal(input.placeholder, "Tell the fleet what to do next…");
  assert.equal(s.location.hash, "", "already on the fleet view, no hash change");
});

test("focusComposer routes to the fleet view from anywhere and closes the drawer on a narrow window", () => {
  const s = composerScope({ activeView: "history", innerWidth: 1000 });
  s.scope.focusComposer();
  assert.equal(s.location.hash, "fleet", "a composer off the fleet view is brought into sight by hash");
  assert.deepEqual(s.closeDrawerCalls, ["close"], "narrow windows keep the composer clear of the drawer");
  assert.deepEqual(s.form().scrollCalls, [{ behavior: "smooth", block: "center" }]);
  assert.deepEqual(s.input().focusCalls, [{ preventScroll: true }]);

  const wide = composerScope({ activeView: "fleet", innerWidth: 1280 });
  wide.scope.focusComposer();
  assert.equal(wide.location.hash, "");
  assert.deepEqual(wide.closeDrawerCalls, []);
});

test("image attachments: only the server's extensions are kept, four at most, as removable chips sized for humans", () => {
  const s = composerScope();
  const added = s.scope.addPromptImages([
    IMG,
    { name: "notes.txt", type: "text/plain", size: 10 },
    { name: "shot.webp", type: "", size: 1536 },
    { name: "icon.svg", type: "image/svg+xml", size: 10 },
  ]);
  assert.equal(added, 2, "a non-image file is ignored; an accepted extension alone is enough");
  assert.match(s.flashes[0] ?? "", /Did not attach 2 files/, "the files left behind are named, not dropped silently");
  assert.match(s.flashes[0] ?? "", /images only/, "the flash names the rule that refused them");
  assert.doesNotMatch(s.images().innerHTML, /icon\.svg/, "a MIME type the server does not accept is refused at drop time");
  const box = s.images();
  assert.equal(box.hidden, false);
  assert.match(box.innerHTML, /<span class='mono'>a\.png<\/span><span class='dim'>1\.0 MB<\/span>/);
  assert.match(box.innerHTML, /shot\.webp<\/span><span class='dim'>2 KB<\/span>/);
  assert.match(box.innerHTML, /data-idx='0'/);
  assert.match(box.innerHTML, /aria-label='Remove a\.png'/);
  assert.equal(s.scope.fmtImageSize(999), "999 B");

  // The cap: only the two free slots of four are filled, the rest are dropped and flashed.
  const more = s.scope.addPromptImages([IMG, IMG, IMG, IMG]);
  assert.equal(more, 2);
  assert.equal((box.innerHTML.match(/data-idx=/g) ?? []).length, 4);
  assert.match(s.flashes[1] ?? "", /Did not attach 2 files/);
  assert.match(s.flashes[1] ?? "", /at most 4 per prompt/);

  // Clicking a chip's × removes that one image and re-renders the chips.
  const button = new s.ElementCtor();
  button.dataset.idx = "1";
  s.fire(box, "click", { target: button });
  assert.doesNotMatch(box.innerHTML, /data-idx='3'/, "the chips renumber after a removal");
  assert.equal((box.innerHTML.match(/data-idx=/g) ?? []).length, 3);

  // A click that is not on a chip button (bubbled from elsewhere) removes nothing.
  s.fire(box, "click", { target: {} });
  assert.equal((box.innerHTML.match(/data-idx=/g) ?? []).length, 3);
});

test("the composer accepts exactly the image names the server's validator accepts", () => {
  const s = composerScope();
  // Leading-dot names are the trap: path.extname('.png') is "", so the server refuses a file
  // named ".png" even though it ends in an accepted extension; the client must too.
  for (const name of [
    ".png", ".PNG", "..png", "...png", ".a.png", "a.png", "a.PNG", "a", "a.", "a..png",
    ".gitignore", "x.svg", "a.tar.gz", "shot.webp", "p.jpg", "p.jpeg", "p.gif", "p.bmp", "noext",
  ]) {
    const clientAccepts = s.scope.isImageFile({ name });
    const serverAccepts = promptImageExtensionProblem(name) === null;
    assert.equal(clientAccepts, serverAccepts, `client and server disagree on ${JSON.stringify(name)}`);
  }
});

test("the composer accepts exactly the image sizes the server's size rule accepts", () => {
  // One file per fresh scope so the four-image cap cannot mask the size rule. The server
  // compares the decoded base64 byte length; a File's size is that same decoded byte count.
  for (const size of [0, 1, 1024, PROMPT_IMAGE_MAX_BYTES - 1, PROMPT_IMAGE_MAX_BYTES, PROMPT_IMAGE_MAX_BYTES + 1, 50 * 1024 * 1024]) {
    const s = composerScope();
    const added = s.scope.addPromptImages([{ name: "a.png", type: "image/png", size }]);
    const serverAccepts = promptImageSizeProblem("a.png", size) === null;
    assert.equal(added === 1, serverAccepts, `client and server disagree on a ${size}-byte image`);
    if (!serverAccepts) assert.match(s.flashes[0] ?? "", /at most 5 MiB each/);
  }
});

test("dropping or pasting files onto the composer attaches the images and ignores the rest", () => {
  const s = composerScope();
  const form = s.form();
  const prevented: string[] = [];
  const ev = { preventDefault: () => { prevented.push("pd"); } };
  s.fire(form, "dragover", ev);
  assert.deepEqual(form.classes, ["dragover"], "the dragover style marks the drop target");
  s.fire(form, "dragleave");
  assert.deepEqual(form.classes, []);
  s.fire(form, "dragover", ev);
  s.fire(form, "drop", { ...ev, dataTransfer: { files: [IMG, { name: "x.txt", type: "text/plain", size: 1 }] } });
  assert.deepEqual(form.classes, [], "a drop clears the dragover style");
  assert.match(s.images().innerHTML, /a\.png/, "the dropped image attached; the text file did not");
  s.fire(form, "drop", { ...ev, dataTransfer: { files: [] } });
  assert.equal((s.images().innerHTML.match(/data-idx=/g) ?? []).length, 1, "an empty drop adds nothing");
  assert.deepEqual(prevented, ["pd", "pd", "pd", "pd"], "every drop is prevented — the browser must not navigate to the file");

  const input = s.input();
  const paste = (files: unknown[]) => s.fire(input, "paste", { clipboardData: { files }, preventDefault: () => { prevented.push("pd"); } });
  const before = (s.images().innerHTML.match(/data-idx=/g) ?? []).length;
  paste([IMG]);
  assert.equal((s.images().innerHTML.match(/data-idx=/g) ?? []).length, before + 1, "a pasted image attaches");
  assert.equal(prevented.length, 5, "a paste that attached something is prevented");
  paste([]);
  assert.equal(prevented.length, 5, "a paste with no files is left alone");
});

test("the composer's submit queues for the director or one loop through the CLI's endpoints", async () => {
  const s = composerScope();
  const input = s.input();
  s.scope.renderComposer(STATUS);
  s.scope.setTarget("qa");
  input.value = "retest --watch";
  await s.fire(s.form(), "submit", SUBMIT);
  await s.flush();
  assert.deepEqual(s.posts, [{ path: "/api/prompt-role", body: { role: "qa", text: "retest --watch" } }]);
  assert.deepEqual(s.flashes, ["Queued for the qa loop's next tick — it wakes now"]);
  assert.equal(input.value, "", "a queued prompt clears the box");
  assert.equal(input.placeholder, "Tell the fleet what to do next…", "the target fell back to the director");
  assert.equal(s.refreshes(), 1);

  // Whitespace-only text is a no-op, not a queued empty prompt.
  const before = s.posts.length;
  input.value = "   ";
  await s.fire(s.form(), "submit", SUBMIT);
  await s.flush();
  assert.equal(s.posts.length, before);

  // A refused submit keeps the text so it can be fixed and resent.
  s.setFail(true);
  input.value = "too long";
  await s.fire(s.form(), "submit", SUBMIT);
  await s.flush();
  assert.match(String(s.flashes.at(-1)), /^error: \/api\/prompt failed: HTTP 400/);
  assert.equal(input.value, "too long", "the draft survives a refusal");
  assert.equal(s.el("promptsend").disabled, false, "the send button is re-enabled for the retry");
  s.setFail(false);
  await s.fire(s.form(), "submit", SUBMIT);
  await s.flush();
  assert.deepEqual(s.posts.at(-1), { path: "/api/prompt", body: { text: "too long" } });
  assert.equal(input.value, "");
});

test("a submit while one is already in flight is ignored, and pending images ride along as base64", async () => {
  const s = composerScope();
  const input = s.input();
  s.scope.addPromptImages([{ name: "p.png", type: "image/png", size: 100 }]);
  input.value = "see screenshot";
  s.holdNextPost();
  const first = s.fire(s.form(), "submit", SUBMIT) as Promise<void>;
  await s.flush();
  const second = s.fire(s.form(), "submit", SUBMIT) as Promise<void>;
  s.releaseHold();
  await Promise.all([first, second]);
  await s.flush();
  assert.equal(s.posts.length, 1, "the second press found the composer already sending and bailed");
  assert.deepEqual(s.posts[0]?.body, { text: "see screenshot", images: [{ name: "p.png", dataBase64: "QUJD" }] });
  assert.match(s.flashes[0] ?? "", /Queued for the director — it runs next with 1 image/);
  assert.equal(s.images().hidden, true, "a queued prompt clears the image chips too");
  assert.equal(s.el("promptsend").disabled, false);

  // An unreadable attachment refuses the whole submit and keeps text and images.
  const bad = composerScope({ failRead: true });
  bad.scope.addPromptImages([{ name: "p.png", type: "image/png", size: 100 }]);
  bad.input().value = "see screenshot";
  await bad.fire(bad.form(), "submit", SUBMIT);
  await bad.flush();
  assert.match(bad.flashes[0] ?? "", /^error: could not read p\.png/);
  assert.equal(bad.posts.length, 0, "nothing was queued — the message would have gone out imageless");
  assert.equal(bad.input().value, "see screenshot");
  assert.equal(bad.images().hidden, false, "the chips stay for a retry");
});

test("Enter submits, Shift+Enter adds a line, Escape blurs", () => {
  const s = composerScope();
  const input = s.input();
  const form = s.form();
  const requested: string[] = [];
  (form as unknown as { requestSubmit: () => void }).requestSubmit = () => { requested.push("submit"); };
  s.fire(input, "keydown", { key: "Enter", shiftKey: false, isComposing: false, preventDefault: () => {} });
  assert.deepEqual(requested, ["submit"]);
  s.fire(input, "keydown", { key: "Enter", shiftKey: true, isComposing: false, preventDefault: () => {} });
  assert.deepEqual(requested, ["submit"], "Shift+Enter inserts a newline instead of sending");
  s.fire(input, "keydown", { key: "Enter", shiftKey: false, isComposing: true, preventDefault: () => {} });
  assert.deepEqual(requested, ["submit"], "an IME composition is not a send");
  let blurred = false;
  (input as unknown as { blur: () => void }).blur = () => { blurred = true; };
  s.fire(input, "keydown", { key: "Escape", preventDefault: () => {} });
  assert.equal(blurred, true);
});
