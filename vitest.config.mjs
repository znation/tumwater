// Not a vitest config: a tripwire. This repo's tests are node:test, run by `npm test`
// (test/test-runner.ts). vitest reads this file before it collects anything, so throwing here
// stops `npx vitest run` before it imports a single test file. Without it, vitest 5 also collects
// the compiled dist/test/*.test.js; importing one starts its node:test tests, vitest counts
// "0 test" and tears the worker down mid-test, so no finally, t.after or exit hook runs. On
// 2026-10-04 a conflict resolver ran it five times in a landing worktree and abandoned ~725
// temp run roots plus orphaned test children (BUGS.md 2026-10-05).
//
// Plain Node with no imports: vitest is not a dependency, and test/foreign-runner-guard.test.ts
// imports this file directly to pin the message.
const message = [
  "vitest is not this repo's test runner: tumwater's tests are node:test, run by `npm test`.",
  "  whole suite:    npm test",
  "  some files:     npm test <file-name-substring>        (e.g. npm test merge)",
  "  some tests:     npm test '<file-substring>#<test-name-substring>'",
  "vitest would import the compiled tests and kill them mid-run, leaking temp dirs and child processes.",
].join("\n");
const error = new Error(message);
// vitest prints the stack after the message, and agents read a run through `| tail`: a
// stackless error keeps the pointer to `npm test` in the last lines of output.
error.stack = `Error: ${message}`;
throw error;
