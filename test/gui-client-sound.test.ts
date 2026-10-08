/** The dashboard's sound layer (src/ui/gui/gui-client-sound.ts, wired through gui-client-model.ts's
 * needs-you helpers, gui-client-fleet.ts's cue diff, and gui-client-operator.ts's toggle): the
 * regions run against a stubbed AudioContext, the pattern test/helpers/gui-client-scope.ts serves. The
 * script's AudioContext binding lives in its own closure, so the stub records its instances in
 * a list the assertions read back. */
import test from "node:test";
import assert from "node:assert/strict";
import { GUI_CLIENT_SOUND_JS } from "../src/ui/gui/gui-client-sound.js";
import { GUI_CLIENT_JS } from "../src/ui/gui/gui-client.js";
import { clientScope, iconStub } from "./helpers/gui-client-scope.js";

test("GUI_CLIENT_JS carries the sound module verbatim", () => {
  assert.ok(GUI_CLIENT_JS.includes(GUI_CLIENT_SOUND_JS), "the module's constant appears verbatim in the assembled script");
});

// A stubbed Web Audio: oscillators record their frequency, so the assertions can count notes
// and read tones without hearing anything. Each constructed context lands in `created`.
class FakeOsc {
  type = "";
  frequency = { value: 0 };
  connect(node: unknown) { return node; }
  start() {}
  stop() {}
}
class FakeGainParam {
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
}
class FakeGain {
  gain = new FakeGainParam();
  connect(node: unknown) { return node; }
}
class FakeCtx {
  static created: FakeCtx[] = [];
  currentTime = 100;
  destination = {};
  oscs: FakeOsc[] = [];
  constructor() { FakeCtx.created.push(this); }
  createOscillator() { const o = new FakeOsc(); this.oscs.push(o); return o; }
  createGain() { return new FakeGain(); }
}
const freqs = (ctx: FakeCtx | undefined) => (ctx ? ctx.oscs.map((o) => o.frequency.value) : []);

type Sound = {
  armAudio(): void;
  playAlertCue(tone: string, now?: number): void;
  setSoundMuted(muted: boolean): void;
  ctxs: FakeCtx[];
  storeCalls: Array<[string, string]>;
};

/** The sound region in one scope; its created AudioContexts are `scope.ctxs`. */
function soundScope(inject: Record<string, unknown> = {}): Sound {
  const storeCalls: Array<[string, string]> = [];
  FakeCtx.created = [];
  const scope = clientScope<Sound>(["sound"], ["armAudio", "playAlertCue", "setSoundMuted"], {
    recall: (): string | null => null,
    store: (key: string, value: string) => storeCalls.push([key, value]),
    AudioContext: FakeCtx,
    ...inject,
  });
  return Object.assign(scope, { ctxs: FakeCtx.created, storeCalls });
}

test("armAudio creates the context lazily and a new needs-you alert plays its cue", () => {
  const s = soundScope();
  s.playAlertCue("red", 1000);
  assert.equal(s.ctxs.length, 0, "no gesture yet, no context");
  s.armAudio();
  assert.equal(s.ctxs.length, 1, "the first gesture arms the context");
  s.playAlertCue("red", 1000000);
  assert.deepEqual(freqs(s.ctxs[0]), [880, 660], "red is two beeps");
});

test("the cue is distinct per tone", () => {
  const s = soundScope();
  s.armAudio();
  s.playAlertCue("amber", 1000000);
  assert.deepEqual(freqs(s.ctxs[0]), [660], "amber is one beep");
  s.playAlertCue("indigo", 1005000);
  assert.deepEqual(freqs(s.ctxs[0]), [660, 440], "indigo is one soft low tone");
});

test("a muted preference plays nothing", () => {
  const s = soundScope({ recall: () => "off" });
  s.armAudio();
  s.playAlertCue("red", 1000);
  assert.deepEqual(freqs(s.ctxs[0]), [], "muted stays silent even with audio armed");
});

test("a browser without AudioContext arms to a no-op and never throws", () => {
  const s = soundScope({ AudioContext: undefined });
  s.armAudio();
  s.playAlertCue("red", 1000);
  assert.equal(s.ctxs.length, 0);
});

test("the 2 s rate limit drops a second cue", () => {
  const s = soundScope();
  s.armAudio();
  assert.ok(s.ctxs[0]);
  const ctx = s.ctxs[0];
  s.playAlertCue("red", 1000000);
  const afterFirst = ctx.oscs.length;
  s.playAlertCue("amber", 1001999);
  assert.equal(ctx.oscs.length, afterFirst, "a cue within 2 s is dropped");
  s.playAlertCue("amber", 1002001);
  assert.equal(ctx.oscs.length, afterFirst + 1, "past the window a cue plays again");
});

test("setSoundMuted persists the preference and takes effect on the next cue", () => {
  const s = soundScope();
  s.armAudio();
  s.setSoundMuted(true);
  assert.deepEqual(s.storeCalls, [["sound", "off"]]);
  s.playAlertCue("red", 1000000);
  assert.deepEqual(freqs(s.ctxs[0]), [], "muting silences the next cue");
  s.setSoundMuted(false);
  assert.deepEqual(s.storeCalls[1], ["sound", "on"]);
  s.playAlertCue("red", 1000002);
  assert.deepEqual(freqs(s.ctxs[0]), [880, 660], "unmuting restores it");
});

test("newNeedsYouKeys returns only the newly appeared needs-you keys; a null prev yields every one", () => {
  const { newNeedsYouKeys } = clientScope<{ newNeedsYouKeys(prev: string[] | null, alerts: unknown[]): string[] }>(
    ["view-model"], ["newNeedsYouKeys"],
  );
  const red = { key: "failing", tone: "red", title: "", actions: [] };
  const amber = { key: "paused", tone: "amber", title: "", actions: [] };
  const indigo = { key: "questions", tone: "indigo", title: "", actions: [] };
  const gray = { key: "stopped", tone: "gray", title: "", actions: [] };
  const blue = { key: "build", tone: "blue", title: "", actions: [] };
  const alerts = [red, amber, indigo, gray, blue];
  assert.deepEqual(newNeedsYouKeys(null, alerts), ["failing", "paused", "questions"],
    "the first poll cues every needs-you alert — the opened-onto-a-live-alert chirp");
  assert.deepEqual(newNeedsYouKeys(["failing", "paused", "questions"], alerts), [],
    "known alerts stay silent");
  assert.deepEqual(newNeedsYouKeys(["failing"], [amber, gray]), ["paused"],
    "a new key cues; known and informational ones do not");
});

type Cue = { armAudio(): void; cueNewNeedsYou(alerts: unknown[], now?: number): string[] };

test("the alerts-band diff plays each new alert's cue once and stays silent on repeats", () => {
  FakeCtx.created = [];
  const scope = clientScope<Cue>(["view-model", "sound", "needs-you-cue"], ["armAudio", "cueNewNeedsYou"], {
    recall: (): string | null => null,
    store: () => {},
    AudioContext: FakeCtx,
  });
  scope.armAudio();
  const ctx = FakeCtx.created[0];
  assert.ok(ctx, "arming created the context");
  const failing = { key: "failing", tone: "red", title: "", actions: [] };
  assert.deepEqual(scope.cueNewNeedsYou([failing], 1000000), ["failing"]);
  const played = ctx.oscs.length;
  assert.ok(played > 0, "a new red alert played");
  assert.deepEqual(scope.cueNewNeedsYou([failing], 1004000), [], "the same key again is not new");
  assert.equal(ctx.oscs.length, played, "a repeated key plays nothing");
  const paused = { key: "paused", tone: "amber", title: "", actions: [] };
  assert.deepEqual(scope.cueNewNeedsYou([failing, paused], 1008000), ["paused"]);
  assert.equal(ctx.oscs.length, played + 1, "a new amber alert plays its own cue");
});

test("the sound toggle's label flips and toggling stores the choice", () => {
  const storeCalls: Array<[string, string]> = [];
  const painted: Record<string, string> = {};
  const scope = clientScope<{ soundControlHtml(): string; toggleSound(): void }>(
    ["sound", "sound-control", "click-delegate"], ["soundControlHtml", "toggleSound"],
    {
      recall: (): string | null => null,
      store: (key: string, value: string) => storeCalls.push([key, value]),
      icon: iconStub,
      paintPanel: (id: string, html: string) => { painted[id] = html; return true; },
      document: { addEventListener: () => {} },
    },
  );
  assert.match(scope.soundControlHtml(), /id='soundtoggle'.*title='Sound is on/);
  assert.match(scope.soundControlHtml(), /<i:sound>/, "unmuted shows the speaker icon");
  scope.toggleSound();
  assert.deepEqual(storeCalls, [["sound", "off"]], "toggling stores the muted choice");
  assert.match(scope.soundControlHtml(), /title='Sound is muted/);
  assert.match(scope.soundControlHtml(), /<i:mute>/, "muted shows the muted icon");
  assert.match(painted.soundwrap ?? "", /<i:mute>/, "the toggle repaints to the muted icon");
  scope.toggleSound();
  assert.deepEqual(storeCalls, [["sound", "off"], ["sound", "on"]], "toggling back stores it too");
  assert.match(painted.soundwrap ?? "", /<i:sound>/, "and back to the speaker icon");
});
