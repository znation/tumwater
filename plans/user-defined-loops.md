# User-defined loops — extra role loops steered from the director prompt box

Planned 2026-09-07; split into three landable sub-plans on 2026-09-08 (plan loop). Shared
architecture for the `User-defined loops N/3` entries in PLANS.md; each of those is
independently landable and cross-references this document.

## The problem

The fleet's loop set is fixed: the twelve catalog roles plus the director, hardcoded in
src/roles.ts and changeable only by hand-editing tumwater.json outside the harness. A user who
wants an extra standing task (e.g. "keep the README examples current") has no first-class way
to give it a loop of its own.

## The decision

Let the user steer that set from the director prompt box (TUI or `tumwater prompt`): ask for a
new loop **by name with a given role/task** and it is added to the fleet, acting exactly like
the other loops — persistent worktree + branch, tick lifecycle, review gate, merge to main,
backoff, budget/pause gates — while being **identified as user-defined** in its own prompt and
on every dashboard. The same channel removes a loop or rearranges their order. Built-in roles
stay untouched: the user manages only their own loops.

## Shared design (all three entries build on this)

- **Storage: a `customLoops` array in tumwater.json.** Durable config belongs in the tracked
  config file, and the orchestrator already live-reloads it every ~2 s — an added loop starts
  and a removed one stops within one poll cycle, no restart, no new reload machinery. Shape:
  `[{ "name": string, "task": string }]` — name is the loop id (worktree dir, branch suffix,
  status row); task is the free-form standing instruction that becomes the loop's entire
  find-something-to-do prompt. No per-loop knobs (provider/model/clock): opinionated defaults;
  a user who wants one asks for it later as its own plan. Optional in the file, defaulted to
  `[]`; required on the loaded `TumwaterConfig` type so read sites never see undefined.
- **Names are validated strictly** because they become filesystem paths and git refs:
  `/^[a-z0-9][a-z0-9_-]{0,31}$/`, no collision with any catalog id (including `director`),
  unique within the list. A colliding name would silently shadow a built-in's prompt
  (`roleById` wins in tickPrompt) — validation makes that impossible instead of subtle. Task is
  capped at 4096 chars: it rides into every one of that loop's tick prefills, so unbounded text
  is a standing per-tick cost; the validation error says to shorten it.
- **Customs merge into `config.roles` at load time** as `{ enabled: true }`, appended after the
  built-ins in array order (loadConfig's existing overlay loop). That single move makes ALL
  existing machinery work unchanged: orchestrator runner creation and mid-run enable/disable,
  `isEligible`'s enabled check, `configForRole` defaults, status/TUI/GUI loop lists, budget/
  pause gates, worktree/branch/session/log paths. Array order is the display and startup-
  tie-break order — so **rearranging = reordering the array** — and customs always sit after
  built-ins (the user rearranges their own set; built-in order is the harness's).
- **One source of truth for "which ids exist / which are user-defined":** `customLoopNames`,
  `isCustomRole`, and `knownRoleIds` in src/config.ts — every consumer goes through these so
  the answer cannot drift.
- **Only the director may write `customLoops`** — through a harness-mediated request file, not
  a commit (superseded 2026-09-22 by plans/portability.md §3/7): the director writes
  `.tumwater-config-request.json` in its worktree, the harness validates, applies only the
  `customLoops` array to the live config, and deletes the request before any commit path — no
  commit, no review gate, no merge, and the loop starts on the orchestrator's ~2 s live reload.
  This works whether or not tumwater.json is tracked, so custom-loop management survives
  untracking the config (4b/7) and works on an adopted repo.
- **`tumwater.json` has LEFT the default `review.exemptPaths`** (superseded 2026-09-22 by
  plans/portability.md §3/7): config changes no longer produce a diff at all, so the exemption
  — once the only thing keeping an explicit user instruction from being silently discarded by a
  rejected review — has nothing left to exempt. Removing it also closes the path where a
  director tick could land a mixed doc-plus-config diff unreviewed. `validateConfig` remains
  the safety net: an invalid request fails with a named warning while the fleet keeps its
  last-known-good config — a bad edit degrades to "no new config changes until fixed", never a
  broken fleet.
- **Custom loops are blocked on red main**, like `feature`/`improve`: their charter may produce
  code, and on red main such diffs are rejected deterministically by the gate's pre-check — an
  authoring run would be pure waste. The state cell reads `main red`, so it is observable; a
  per-loop exemption is a future knob, not this feature.

## Invariants (none of the three entries may break these)

1. **Built-ins are byte-identical.** When `customLoops` is empty or absent, every prompt,
   schedule, gate, and dashboard cell is exactly as before — pinned by existing tests staying
   green plus new "no customs" cases.
2. **A custom loop is a full citizen.** It owns `.tumwater/worktrees/<name>` and branch
   `tumwater/<name>`, ticks through the same lifecycle (review gate, merge lock, backoff), and
   honors minTickInterval, budget, and fleet pause exactly like a built-in — no special-casing
   in loop.ts beyond the prompt lookup.
3. **Names never collide with or shadow built-ins** (validation at load, not runtime checks).
4. **Only the director writes tumwater.json** — now via the harness-mediated request file, and
   only `customLoops` within it (enforced by `applyConfigRequest`'s permitted-key filter, not
   only by prompt text); every other role's prompt keeps the blanket ban, and so does the
   director's: it writes the request file, never the config.

## Sequencing

1. **1/3 — config plumbing.** types + validation + load-time merge + tickPrompt fallback +
   red-main gate. After this, hand-editing tumwater.json (already a documented live-reload
   workflow for roles/providers/models) adds/removes/rearranges working loops — the feature is
   usable before 2/3 and 3/3 land.
2. **2/3 — director control surface.** The routing bullet + scoped exception in the director
   prompt, and `--role` flag validation accepting custom names for logs/abort/reset-counters.
3. **3/3 — dashboard identification.** The `*` marker on both dashboards, the `custom` payload
   flag, and the README paragraph (the last sub-plan completes the user-visible story).

1/3 is the critical path; 2/3 and 3/3 are small, independent of each other (either can land
first), and each depends only on 1/3's helpers. The planned need-based-prioritization entry
already pins custom roles as never-deferred for when they exist — no coordination needed.

## Deliberately out of scope

Per-custom-loop knobs (provider/model/clock/instructions) — opinionated defaults first; a user
who wants one asks for it later as its own plan. Managing built-in roles through the director
(enabling/disabling, retuning intervals) — hand-editing stays the way for those. Deleting a
custom loop's worktree/branch/session files on removal — they stay on disk like a disabled
built-in's (re-adding the name revives its persisted state; pruning is a steward concern).
