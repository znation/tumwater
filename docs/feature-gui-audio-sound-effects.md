# Feature: GUI audio and sound effects

## Summary

The web dashboard (`tumwater gui`) gains a sound layer: distinct, subtle effects for key
moments in the fleet loop, with a mute toggle persisted across sessions.

- **Sounds.** A small set of synthesized-or-bundled cues, each mapped to an existing
  feed event type:
  - tick completed — soft confirmation blip
  - change landed — satisfying "commit chime"
  - change rejected / tick failed — low warning tone (distinct from the failure alert)
  - budget pause / alert needing human — attention-getting but not harsh
  - role paused / resumed — neutral UI cue
- **Playback.** Implemented client-side in the GUI JavaScript. No server changes are
  required beyond what the live feed already provides; sounds are triggered by event
  types the dashboard already receives. Audio files (if used rather than WebAudio
  synthesis) are bundled with the package so `tumwater gui` works offline.
- **Mute control.** A speaker icon on the dashboard header toggles sound on/off. The
  preference is persisted (localStorage keyed per project) and restored on reload.
  Default state: sounds ON at modest volume, with a single master volume control
  available in a small settings popover (no per-event mixer).
- **Non-goals.** No text-to-speech, no per-loop custom sounds, no server-rendered
  audio, no autoplay of anything before the first user interaction (browser policy:
  first click unlocks the AudioContext).

## User experience

1. Operator opens `tumwater gui`, hears a soft chime when a change lands.
2. A tick fails: a low tone plays — different enough from the landing chime that the
   operator can tell good news from bad without looking.
3. Operator clicks the speaker icon; all sounds stop, icon shows muted state.
4. Operator reloads the page later; mute state is remembered.

## Rationale

- The dashboard is meant to be glanceable; audio extends that to "ambiently
  observable" — an operator in another window can hear that something landed or that
  the fleet needs attention.
- Sound is the cheapest possible attention channel for the "fleet needs a human"
  events, complementing the existing notify hook (which targets scripts/desktop) by
  targeting the human currently looking at the dashboard.
- A mute toggle is mandatory, not optional: autonomous-fleet operators often run this
  for hours, and uninvited noise is a reason to stop using a feature, not tolerate it.

## Constraints and notes

- Zero runtime dependencies: use WebAudio synthesis or bundled static assets only;
  no audio CDN, no third-party player library.
- Must not add polling or new server endpoints — reuse the live event feed already
  consumed by the dashboard.
- Keep total added payload small (tens of KB at most if bundling audio files).
- Respect browser autoplay policies: initialize audio on first user gesture.
- Sounds must be short (< 1.5s), non-looping, and never overlap into clipping
  (simple: latest event wins, or a tiny queue with a cap).
