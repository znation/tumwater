# Implementation plan: GUI audio and sound effects

## Summary

Client-side only. Add a small `sound.js` module to the GUI static assets, wire it to
the event stream the dashboard already consumes, and add a mute/volume control to the
header. Persist the preference in localStorage.

## Work breakdown

1. **Sound engine (`sound.js`, new static asset)**
   - Lazy `AudioContext` created on first user gesture (click/keydown) to satisfy
     autoplay policies; before that, events are ignored silently.
   - `playSound(kind)` maps event kinds to one of ~5 synthesized cues built from
     oscillator envelopes (tick-complete, landed, rejected/failed, needs-human,
     role-pause/resume). Synthesis chosen over bundled files to keep the package
     payload near zero; if synthesis proves too limited, fall back to tiny bundled
     `.wav`/`.ogg` assets served from the GUI static directory.
   - A cap on concurrent plays (e.g., ignore a new cue if one started < 150ms ago)
     prevents event-storm cacophony.

2. **Event mapping (dashboard feed handler)**
   - In the existing live-event subscription code, add a lookup from feed event type
     to sound kind. Unknown event types play nothing.
   - Respect current mute state and volume; a muted dashboard does zero audio work
     beyond the boolean check.

3. **Header control (HTML/CSS)**
   - Speaker icon button (existing icon set, no new dependency). States: on / muted.
   - Click toggles mute; a small popover offers master volume (0–100) via slider.
   - Persist `{"muted":bool,"volume":int}` under a namespaced localStorage key
     (e.g., `tumwater.gui.sound`), read on page load.

4. **Accessibility / polish**
   - Icon has `aria-label` and `title` reflecting current state ("Sound on"/"Muted").
   - Keyboard reachable (button is a real `<button>`).

## Files touched

- New: `sound.js` (or equivalent path alongside existing GUI static assets)
- Modified: dashboard HTML template, dashboard CSS, the JS file handling the live
  event feed, header markup for the toggle
- No changes to server code, endpoints, or package dependencies

## Test plan

- Manual: verify each mapped event plays its cue; mute persists across reload;
  volume slider affects loudness; no sound before first click.
- Automated (where the GUI is covered by tests today): assert the sound module is
  served, the toggle renders, the localStorage key round-trips, and event→kind
  mapping covers the intended event types (pure-logic checks only; browsers don't
  run in the test suite).

## Risks and mitigations

- **Annoyance / noise fatigue** → default volume low, mute one click away, cap on
  overlap.
- **Autoplay policy quirks** → strict "first gesture unlocks audio" design; failure
  mode is silence, never an error.
- **Event-type drift** (server renames an event type) → mapping degrades to
  "unknown = silent" rather than breaking the dashboard.
