// Type-aware lint, run by `npm test` ahead of the suite so the merge gate enforces it. It
// carries eight rules on purpose: three for promise misuse tsc cannot see, three for type
// spellings whose meaning is not what the author read, one for a type-only import that silently
// stays a runtime side effect under verbatimModuleSyntax, and one for a private member that is
// never reassigned but is not marked `readonly`.
//
// Promise misuse: no-floating-promises flags an un-awaited async call, which typechecks fine
// and silently races (33521347 dropped the await on 25 e2e waits and CI broke);
// no-misused-promises flags a promise used where a plain value is expected, such as an async
// callback handed to a synchronous array predicate (`filter`/`find`/`some`/`every`) or an
// async value in a condition, both of which typecheck fine and are silently always truthy. Its
// checksVoidReturn is off because the GUI's request listener is deliberately async —
// `http.createServer(async (req, res) => …)` in gui/gui-server.ts — and its body wraps every
// await in a try/catch, so the rule's void-return arm would only force a disable comment on
// that one intended site. return-await keeps both directions of the same class honest:
// inside a try/catch it requires `return await promise`, because a bare `return promise`
// lets a rejection skip the catch the author wrote to handle it, and outside one it
// forbids the redundant `await`, which typechecks and runs either way.
//
// Type spellings: await-thenable flags `await` of a value no thenable can be (an unawaited
// sync helper awaited by habit, or a call still missing its `()`), which typechecks and runs
// yet says the author expected a promise that is not there; no-redundant-type-constituents
// flags a union one member absorbs (`unknown | null`, `string | "a"`), where the author saw a
// narrowing the type actually does not provide; no-invalid-void-type flags `void` as a union
// constituent (`boolean | void`), where the author meant a callback's return is ignored rather
// than a value the union carries — write the caller's decision as a plain boolean instead
// (landing-slot.ts's `apply` became true = write, the fix that landed with the rule).
//
// Import hygiene: no-import-type-side-effects flags an import whose every specifier is an
// inline `type` (`import { type A, type B } from "./x.js"`). With verbatimModuleSyntax,
// tsc elides the inline specifiers but keeps the statement as `import "./x.js"`, so the
// module stays a runtime dependency the author did not ask for; a top-level `import type`
// removes the statement entirely. (The two adapter modules fixed for this landed as the rule
// was enabled.)
//
// Immutability: prefer-readonly flags a private member that is assigned once and never
// reassigned again, where `readonly` documents the invariant and turns a later accidental
// reassignment into a compile error rather than a silently shared mutation.
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
      "@typescript-eslint/return-await": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/no-invalid-void-type": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/prefer-readonly": "error",
    },
  },
);
