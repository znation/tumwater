# Questions outbox — loops that know when to ask

Planned 2026-08-24 · refined 2026-08-25 (event plumbing, GUI mechanism, sibling coordination)
· from the "Senior Tumwater" report (HN 49421554) · report item R4

## Goal

Loops can escalate. When a decision is genuinely the human's — product direction, an irreversible
choice, taste — a loop posts a crisp question to a tracked `QUESTIONS.md` and moves on to other
work. Open questions are surfaced prominently in the TUI, GUI, and status header; answers flow
back through the director and unblock future ticks.

## Motivation

HN commenter **jgilias**: domain judgment is the bottleneck — "the spacer between the keyboard and
the chair still matters." **polotics**: handling ambiguity and taking initiative is what current
agents lack. **wry_discontent**'s strongest objection to autonomous loops is that business
software lacks clear victory conditions; the harness's answer is to be excellent at *requesting*
them. Today information flows one way — prompts in, commits out. Initiative includes knowing when
to ask.

## Design

- **The file**: tracked `QUESTIONS.md`, seeded at init (`src/init.ts`) with `## Open` /
  `## Answered` sections. Each question: a stable id (`Q<n>`), the asking role and date, one
  paragraph of context, the concrete options, and the loop's own recommendation — a senior asks
  with a proposal, not a shrug. Question-only diffs are md-only, hence cheap under the review
  gate's exemption.
- **Prompt contract** (`src/prompt.ts`): add QUESTIONS.md to the read-first list in COMMON_RULES
  plus a new bullet: "when a fork in the road is genuinely the user's call, do not guess — append
  a question to QUESTIONS.md (context, options, your recommendation) and either continue with the
  parts that don't depend on it or end the tick. Never block on an unanswered question; check for
  answers at the start of each tick. Do not re-ask an open question."
- **Surfacing**: `openQuestionCount(root)` plus an entry parser (id, first line) in a small new
  `src/questions.ts`. The count flows through `StatusSnapshot` exactly like `inbox` does today:
  `snapshot()` (src/status.ts) adds `questions: openQuestionCount(root)`, and `renderStatus`
  (src/status-render.ts — the presentation layer, not status.ts) appends `· questions: N` to the
  header line only when N > 0 (inbox is omitted at zero; do the same). The GUI header badge reads
  a new `questions` field in `statusPayload`. **Decided:** the Open section itself is served by a
  new `/api/questions` route (fresh read per request, like `/api/transcript`) and rendered in a
  panel-on-click beside the transcript panel — not folded into the 1s status payload. TUI: a
  highlighted line above recent activity when N > 0.
- **Answer flow**: two paths, both already natural. (1) The user edits QUESTIONS.md directly —
  moving the entry to Answered with a decision; the next tick of any loop reads it. (2) The user
  tells the director ("answer Q3: choose SQLite"), and the director's routing block gains a
  bullet: an answer to an open question moves it to `## Answered` verbatim and applies or routes
  any follow-on work. Durable decisions graduate to PRINCIPLES.md
  ([principles.md](principles.md)).
- **Events**: a `question_posted` event (loop, id, first line) when a merged diff adds an Open
  entry. Detection lives in `tryMerge` (src/loop.ts): capture `openQuestionCount(root)` before
  the rebase and compare after `ffMergeToMain` succeeds; for each new entry log one
  `question_posted` alongside the existing `merged` event — pi stays out of the event system.
  Add `question_posted` to the `HarnessEvent.type` union (src/types.ts) with plain rendering in
  `formatEvent` (src/event-format.ts — it no longer lives in src/events.ts); no warning prefix,
  this is routine operation.

## Files touched

`src/init.ts` (seed QUESTIONS.md beside PLANS/BUGS), `src/prompt.ts` (read-first list +
ask-don't-guess bullet; director answer-routing bullet), `src/questions.ts` (new: count + entry
parsing), `src/status.ts` (`StatusSnapshot.questions`, as inbox does today),
`src/status-render.ts` (header badge in renderStatus), `src/gui.ts` (payload field +
`/api/questions` route), `src/gui-page.ts` (header badge + panel-on-click), `src/tui.ts`
(highlighted line), `src/loop.ts` (post-merge count diff → event), `src/types.ts` (event type) +
`src/event-format.ts` (plain rendering); tests: new `test/questions.test.ts` (count parsing,
header rendering, prompt contract text, director routing text, post-merge event emission),
README.

## Acceptance criteria

- `tumwater init` seeds QUESTIONS.md; every role prompt lists it as required reading and carries
  the ask-don't-guess rule.
- With one Open entry, `tumwater status`, the TUI, and the GUI all show `questions: 1`; answering
  (either path) clears the count within a poll cycle.
- The director prompt contains the answer-routing bullet; a prompt test asserts it.
- A loop tick that adds a question merges as an md-only diff. `npm test` passes.

## Dependencies & sequencing

Independent of the gate; benefits from [principles.md](principles.md) as the graduation target
for durable answers. TUI/GUI surface work is the bulk of the effort.

**Sibling coordination** ("Show open bugs and planned features in the TUI/GUI", PLANS.md): that
plan adds a project-status *section* below the loop table in gui-page.ts and explicitly reserves
the status-header badge spot for this plan. Ownership split: questions owns the `· questions: N`
header badge on both surfaces; backlog owns the list sections. In the TUI they coexist without
collision (badge line above recent activity vs the Ctrl+T-cycled project-status view). The two
are independently implementable in either order — no shared markup, and if backlog lands first its
section simply sits below the table while this plan's panel goes beside it.

## Out of scope

Push notifications; blocking a loop on its own question (explicitly forbidden); answer deadlines
or escalation timers.
