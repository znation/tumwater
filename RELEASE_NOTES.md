# tumwater 0.8.1

## Fixes

- A `## Planned` entry whose note cites another plan as `<name>, done DATE` no longer reads
  as finished, so it is not stranded. Only the entry's own trailing completion stamp counts.
- `init` labels the starter directories a template seeds as `untracked:`, not
  `untracked (gitignored):`. Only the config file is gitignored.
- The CI parity badge reads `CI:` in the dashboard and TUI, not `Ci:`.
- docs/config.md describes the `main_red_hold` notification correctly: a change whose own
  check fails is kept until main moves.

## Build and tests

- About 20 duplicated shapes now share one helper each, including the dashboard drawer's
  edit, Save/Discard and list controls, the Queued and Pending tab controls, the config no-op
  messages, the CLI's position and `--since`/`--until` parsing, and the report chart axes.
  `createMainWatch` is split into concern modules, and the backend-bin resolver moved to
  `src/agent/`.
- New tests pin edge rules in CLI argument parsing, untrusted JSON reads, collection helpers,
  repo-path discovery, the secret-leak guards and the git files-backend trust gate.
- The pin-drain e2e test waits for a quiet host instead of failing when the host is busy.

137 files changed, +3097 / −1593 over 112 commits since v0.8.0
