# code-metrics

The pipeline behind [docs/code-metrics.md](../code-metrics.md): size, complexity, comments, type
escapes, duplication, coverage and commit shape for tumwater. It splits tumwater's code by author
(Tumwater's own loops vs Claude Code sessions) and compares it with the human-written TypeScript
projects pinned in [oss-repos.tsv](oss-repos.tsv).

```bash
git worktree add --detach .claude/worktrees/metrics-48213ce7 48213ce7
docs/code-metrics/run.sh .claude/worktrees/metrics-48213ce7 <data-dir> --coverage=10
```

`run.sh` documents its arguments, and each script's header gives its inputs, outputs and
definitions. The report's Method section lists the stages. The scripts need Node (with the
checkout's `typescript` and `typescript-eslint`), Python 3 and git; nothing else is installed.
They read a checkout's tracked files and history but never modify it. The one exception is
`--coverage`, which runs the checkout's own `npm run test:coverage`.
