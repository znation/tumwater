/** The dashboard's sound layer, browser-side: one short synthesized cue when a new needs-you
 * alert appears (a failing loop, a red main, a spent budget, a lost server), scoped from
 * docs/feature-gui-audio-sound-effects.md to the alerts cue — the one moment the fleet
 * genuinely needs a human. Client-side only: Web Audio is a browser built-in, so the zero
 * runtime dependencies principle holds, and every path degrades to silence — no AudioContext,
 * no user gesture yet, or a muted preference all leave the page quiet and error-free. Spliced
 * into gui-client.ts's script (before the boot module, which arms audio on the first gesture),
 * reaching its helpers (recall, store) through that concatenation. */
export const GUI_CLIENT_SOUND_JS = String.raw`  // sound:start
  // The mute preference is per browser (localStorage via store/recall), default unmuted; the
  // sidebar's speaker toggle flips it.
  let soundMuted = recall("sound") === "off";
  let audioCtx = null;
  let lastCueAt = 0;
  // Autoplay policy keeps a context created before the first user gesture suspended, so
  // armAudio runs on the first pointerdown/keydown (the boot module wires that one-time
  // listener) and lazily creates the context. Safe to call repeatedly; a browser without
  // AudioContext, or one whose construction throws, simply stays silent.
  function armAudio() {
    if (audioCtx || typeof AudioContext === "undefined") return;
    try { audioCtx = new AudioContext(); } catch { /* no audio in this browser */ }
  }
  // One cue per tone, well under a second: red is two beeps (a failing loop or red main is
  // the most urgent), amber one beep (a pause, a stale build), indigo a soft low tone (an
  // open question). Each note is [frequency, start offset in seconds].
  const CUE_NOTES = { red: [[880, 0], [660, 0.18]], amber: [[660, 0]], indigo: [[440, 0]] };
  // Play the tone's cue. now (ms clock) stands in for Date.now so tests can step time;
  // at most one cue per 2 s, so an alert storm becomes one chirp, not noise.
  function playAlertCue(tone, now) {
    if (soundMuted || !audioCtx) return;
    const at = now === undefined ? Date.now() : now;
    if (at - lastCueAt < 2000) return;
    lastCueAt = at;
    const t0 = audioCtx.currentTime;
    for (const [freq, offset] of CUE_NOTES[tone] || CUE_NOTES.amber) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.08, t0 + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.15);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.16);
    }
  }
  function setSoundMuted(muted) {
    soundMuted = muted;
    store("sound", muted ? "off" : "on");
  }
  // sound:end`;
