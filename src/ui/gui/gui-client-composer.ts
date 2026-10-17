// vocabulary: plain
/** The dashboard's composer, browser-side — the one input box that steers the director or any
 * single loop: the target selector with its per-target unsent drafts, the character counter,
 * the image attachments (dropped or pasted onto the box, rendered as removable chips), and
 * the submit that reads the bytes and queues the prompt through the same endpoints the CLI's
 * "prompt" and "prompt --role" use. Split out of gui-client-fleet.ts, which keeps the
 * read-only status rendering the composer sits on top of. renderFleet calls renderComposer
 * each poll; gui-client-boot.ts's question and backlog actions and gui-client-loops.ts's row
 * actions call draftForDirector and focusComposer. Spliced into gui-client.ts's script right
 * after the fleet view, reaching its helpers ($, esc, postJson, plural, showFlash, refresh)
 * and the fleet view's activeView/drawer state through that concatenation. */
import { DIRECTOR_PROMPT_MAX_CHARS } from "../../inbox/inbox-submit.js";
import { PROMPT_IMAGE_EXTENSIONS, PROMPT_IMAGE_MAX_BYTES, PROMPT_IMAGES_MAX_COUNT } from "../../inbox/inbox-attachments.js";
export const GUI_CLIENT_COMPOSER_JS = String.raw`  // ---- composer: one box for the director or any single loop ----
  const PROMPT_MAX = ${DIRECTOR_PROMPT_MAX_CHARS};
  const promptInput = $("prompt");
  const targetSelect = $("prompttarget");
  let promptTarget = "director";
  let targetKey = "";
  const drafts = {}; // each target keeps its own unsent draft
  // The last status payload, kept so setTarget can re-render the image note between polls.
  let composerData = null;
  // The image-input notice under the image chips (plans/image-input.md "Surfaces", part 5/5):
  // when the selected non-director loop's model can't read images but reroutes a blind read
  // to another tier, say so — read from the status payload (imageInput/imageReroute), the same
  // facts the images alert and the submit gate use, so the composer never promises a run the
  // gate would refuse.
  function renderPromptImageNote() {
    const loop = (composerData && composerData.roles || []).find((l) => l.role === promptTarget);
    const note = $("promptimagenote");
    const text = loop && loop.imageInput === false && loop.imageReroute
      ? promptTarget + "'s model can't read images; image prompts run on " + loop.imageReroute
      : "";
    if (note.textContent !== text) note.textContent = text;
    note.hidden = text === "";
  }
  function renderComposer(d) {
    const roles = (d.roles || []).map((l) => l.role).filter((r) => r !== "director");
    const key = roles.join(",");
    if (key !== targetKey) {
      targetKey = key;
      targetSelect.innerHTML = "<option value='director'>Director</option>" + (roles.length ? "<optgroup label='One role, at its next run'>" +
        roles.map((r) => "<option value='" + esc(r) + "'>" + esc(roleLabel(r) + " — " + roleTitle(r)) + "</option>").join("") + "</optgroup>" : "");
      if (promptTarget !== "director" && !roles.includes(promptTarget)) setTarget("director");
      targetSelect.value = promptTarget;
    }
    const n = (d.inbox || 0) + Object.values(d.roleInbox || {}).reduce((a, b) => a + b, 0);
    const link = $("queuelink");
    link.hidden = n === 0;
    link.dataset.act = "queued"; // vocabulary-ok: data-act routing key the click handler matches
    const text = plural(n, "message") + " in the inbox";
    if (link.textContent !== text) link.textContent = text;
    composerData = d;
    renderPromptImageNote();
  }
  function composerHint() {
    $("prompthint").innerHTML = esc(promptTarget === "director"
      ? "The director runs this next, ahead of every role."
      : "Goes to the " + roleLabel(promptTarget) + " inbox for its next run; the role wakes right away.") +
      " <kbd>Enter</kbd> sends · <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line · <kbd>/</kbd> jumps here";
    promptInput.placeholder = promptTarget === "director" ? "Tell the team what to do next…" : "Tell the " + roleLabel(promptTarget) + " role what to do on its next run…";
  }
  function setTarget(t) {
    if (t === promptTarget) return;
    drafts[promptTarget] = promptInput.value;
    promptTarget = t;
    targetSelect.value = t;
    promptInput.value = drafts[t] || "";
    composerHint();
    autosize();
    updateCount();
    renderPromptImageNote();
  }
  function autosize() {
    promptInput.style.height = "auto";
    promptInput.style.height = Math.min(promptInput.scrollHeight, Math.round(window.innerHeight * 0.4)) + "px";
  }
  function updateCount() {
    const n = promptInput.value.length;
    const count = $("promptcount");
    count.textContent = n > PROMPT_MAX * 0.8 ? n.toLocaleString() + " / " + PROMPT_MAX.toLocaleString() : "";
    count.className = n > PROMPT_MAX ? "res t-red" : "";
  }
  // Put text in the composer for the director and focus it (answering a question, or asking
  // about a backlog entry), leaving the cursor at the end.
  function draftForDirector(text) {
    setTarget("director");
    promptInput.value = text;
    autosize();
    updateCount();
    focusComposer();
    promptInput.setSelectionRange(text.length, text.length);
  }
  // The composer sits on the Fleet view; bring it into sight from anywhere and focus it.
  function focusComposer() {
    if (activeView !== "team") location.hash = "team";
    if (window.innerWidth <= 1180 && drawer) closeDrawer();
    $("promptform").scrollIntoView({ behavior: "smooth", block: "center" });
    promptInput.focus({ preventScroll: true });
  }
  targetSelect.addEventListener("change", () => setTarget(targetSelect.value));
  promptInput.addEventListener("input", () => { autosize(); updateCount(); });
  promptInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      $("promptform").requestSubmit();
    } else if (ev.key === "Escape") promptInput.blur();
  });
  // composer-images:start
  // Pending image attachments, dropped or pasted onto the composer. One list shared across
  // targets (an image belongs to the message, not to the selector), each entry a
  // { name, size, file } record so the chips render from plain fields and the submit reads
  // the bytes off .file. Cleared only on a successful submit or manual removal — a rejected
  // submit keeps text and images so they can be fixed and resent, like the text draft.
  const promptImages = [];
  // The server's accepted image extensions (inbox-attachments.ts), interpolated at build time
  // so the composer's drop check and the endpoint's validator cannot drift: a file the client
  // accepts but the server refuses would sit in an unsendable chip. The name's extension is
  // what the server validates, so a MIME type alone is not enough.
  const IMAGE_EXTENSIONS = ${JSON.stringify(PROMPT_IMAGE_EXTENSIONS)};
  // The server's per-image decoded-byte cap (inbox-attachments.ts), interpolated the same way,
  // so a file the client attaches is one the endpoint will not refuse for its size.
  const IMAGE_MAX_BYTES = ${PROMPT_IMAGE_MAX_BYTES};
  // The server (promptImageExtensionProblem → path.extname) treats a single leading dot as a
  // hidden name, not an extension: ".png" has none and is refused. Matching that here keeps a
  // dropped file from becoming a chip the endpoint later rejects. A File's name is always a
  // basename, so the last dot alone is enough to find the extension.
  const isImageFile = (f) => {
    const name = String(f.name);
    const dot = name.lastIndexOf(".");
    return dot > 0 && IMAGE_EXTENSIONS.includes(name.slice(dot).toLowerCase());
  };
  // Attach the supported images up to the cap and flash whatever was left behind, so a dropped
  // file never vanishes silently. Returns how many were attached (the paste handler's
  // preventDefault gate).
  function addPromptImages(files) {
    let added = 0;
    let notImage = 0;
    let oversize = 0;
    let overCap = 0;
    for (const f of files) {
      if (!isImageFile(f)) { notImage++; continue; }
      if (f.size > IMAGE_MAX_BYTES) { oversize++; continue; }
      if (promptImages.length >= ${PROMPT_IMAGES_MAX_COUNT}) { overCap++; continue; }
      promptImages.push({ name: f.name, size: f.size, file: f });
      added++;
    }
    if (added) renderPromptImages();
    if (notImage || oversize || overCap) {
      const why = [];
      if (notImage) why.push(IMAGE_EXTENSIONS.join(" ") + " images only");
      if (oversize) why.push("at most " + ${PROMPT_IMAGE_MAX_BYTES / (1024 * 1024)} + " MiB each");
      if (overCap) why.push("at most " + ${PROMPT_IMAGES_MAX_COUNT} + " per prompt");
      showFlash("Did not attach " + plural(notImage + oversize + overCap, "file") + " — " + why.join(", "));
    }
    return added;
  }
  function fmtImageSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B";
  }
  function renderPromptImages() {
    const box = $("promptimages");
    box.hidden = promptImages.length === 0;
    box.innerHTML = promptImages.map((img, i) =>
      "<span class='chip'><span class='mono'>" + esc(img.name) + "</span><span class='dim'>" + fmtImageSize(img.size) + "</span>" +
      "<button type='button' data-idx='" + i + "' title='Remove' aria-label='Remove " + esc(img.name) + "'>×</button></span>").join("");
  }
  $("promptimages").addEventListener("click", (ev) => {
    const b = ev.target instanceof Element ? ev.target.closest("button[data-idx]") : null;
    if (!b) return;
    promptImages.splice(Number(b.dataset.idx), 1);
    renderPromptImages();
  });
  // Drop an image file onto the composer (or paste one from the clipboard) to attach it;
  // anything that is not one of the accepted image types is refused with a flash naming the
  // rule (addPromptImages). preventDefault on dragover is what makes the composer a valid
  // drop target instead of the browser navigating to the file.
  const promptForm = $("promptform");
  promptForm.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    promptForm.classList.add("dragover");
  });
  promptForm.addEventListener("dragleave", () => promptForm.classList.remove("dragover"));
  promptForm.addEventListener("drop", (ev) => {
    ev.preventDefault();
    promptForm.classList.remove("dragover");
    if (ev.dataTransfer && ev.dataTransfer.files.length) addPromptImages(ev.dataTransfer.files);
  });
  promptInput.addEventListener("paste", (ev) => {
    const files = ev.clipboardData && ev.clipboardData.files;
    if (files && files.length && addPromptImages(files)) ev.preventDefault();
  });
  // One pending File's bytes as base64 — readAsDataURL's data:...;base64, prefix stripped.
  function readImageAsBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
      r.onerror = () => reject(new Error("could not read " + file.name));
      r.readAsDataURL(file);
    });
  }
  // composer-images:end
  // composer-send:start
  // Queue a prompt for the director or for one loop, through the same endpoints the CLI's
  // "prompt" and "prompt --role" use. Resolves to the confirmation to show; rejects when the
  // server did not take it (the caller keeps the text so it can be fixed and resent). Pending
  // images ride along as { name, dataBase64 } and are named in the confirmation.
  async function sendPrompt(target, text, images) {
    const attached = images && images.length ? " with " + plural(images.length, "image") : "";
    const body = images && images.length ? { text, images } : { text };
    if (target === "director") {
      await postJson("/api/prompt", body);
      return "Added to the director's inbox — it runs next" + attached;
    }
    await postJson("/api/prompt-role", { role: target, ...body });
    return "Added to the " + roleLabel(target) + " inbox for its next run — it wakes now" + attached;
  }
  // composer-send:end
  let sending = false;
  $("promptform").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = promptInput.value.trim();
    if (!text || sending) return;
    const target = promptTarget;
    sending = true;
    $("promptsend").disabled = true;
    const images = [];
    try {
      for (const img of promptImages) images.push({ name: img.name, dataBase64: await readImageAsBase64(img.file) });
      showFlash(await sendPrompt(target, text, images));
    } catch (err) {
      // The prompt was not accepted: keep the text and the images so they can be fixed and resent.
      showFlash("error: " + err.message);
      return;
    } finally {
      sending = false;
      $("promptsend").disabled = false;
    }
    promptImages.length = 0;
    renderPromptImages();
    promptInput.value = "";
    drafts[target] = "";
    if (target !== "director") setTarget("director");
    autosize();
    updateCount();
    refresh();
  });
`;
