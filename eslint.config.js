// Type-aware lint, run by `npm test` ahead of the suite so the merge gate enforces it. It
// carries four rules on purpose: two for promise misuse tsc cannot see, and two for type
// spellings whose meaning is not what the author read.
//
// Promise misuse: no-floating-promises flags an un-awaited async call, which typechecks fine
// and silently races (33521347 dropped the await on 25 e2e waits and CI broke);
// no-misused-promises flags a promise used where a plain value is expected, such as an async
// callback handed to a synchronous array predicate (`filter`/`find`/`some`/`every`) or an
// async value in a condition, both of which typecheck fine and are silently always truthy. Its
// checksVoidReturn is off because the GUI's request listener is deliberately async —
// `http.createServer(async (req, res) => …)` in gui/gui-server.ts — and its body wraps every
// await in a try/catch, so the rule's void-return arm would only force a disable comment on
// that one intended site.
//
// Type spellings: await-thenable flags `await` of a value no thenable can be (an unawaited
// sync helper awaited by habit, or a call still missing its `()`), which typechecks and runs
// yet says the author expected a promise that is not there; no-redundant-type-constituents
// flags a union one member absorbs (`unknown | null`, `string | "a"`), where the author saw a
// narrowing the type actually does not provide.
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
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
    },
  },
);
