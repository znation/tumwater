// Type-aware lint, run by `npm test` ahead of the suite so the merge gate enforces it. It
// carries two rules on purpose, both for promise misuse tsc cannot see:
// no-floating-promises flags an un-awaited async call, which typechecks fine and silently
// races (33521347 dropped the await on 25 e2e waits and CI broke); no-misused-promises flags
// a promise used where a plain value is expected, such as an async callback handed to a
// synchronous array predicate (`filter`/`find`/`some`/`every`) or an async value in a
// condition, both of which typecheck fine and are silently always truthy. Its checksVoidReturn
// is off because the GUI's request listener is deliberately async — `http.createServer(async
// (req, res) => …)` in gui/gui-server.ts — and its body wraps every await in a try/catch, so
// the rule's void-return arm would only force a disable comment on that one intended site.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".tumwater/**", ".claude/**"] },
  {
    files: ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        // node:test's test()/describe() return promises the runner itself tracks.
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["test", "describe", "it", "suite"] },
          ],
        },
      ],
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
    },
  },
);
