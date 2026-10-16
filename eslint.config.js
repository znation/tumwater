// Type-aware lint, run by `npm test` ahead of the suite so the merge gate enforces it. It
// carries a battery of rules on purpose, most for promise misuse tsc cannot see, for type
// spellings whose meaning is not what the author read, for import hygiene under
// verbatimModuleSyntax, and for one-off traps (a private member that is never reassigned but
// is not marked `readonly`; an inline-only-type import the rest of the tree spells
// `import type`; a comparator-less `sort` on a non-string array, which orders by the
// elements' string forms (`[10, 2].sort()` stays `[10, 2]`)).
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
// use-unknown-in-catch-callback-variable flags a `.catch`/`.then` rejection callback whose
// parameter is left un-annotated: TypeScript gives it `any`, so the handler can read a field
// off it that no rejection carries; `: unknown` forces a narrow first (the three sites pass
// the value to errorMessage or assign it to an `unknown`).
//
// Type spellings: await-thenable flags `await` of a value no thenable can be (an unawaited
// sync helper awaited by habit, or a call still missing its `()`), which typechecks and runs
// yet says the author expected a promise that is not there; no-redundant-type-constituents
// flags a union one member absorbs (`unknown | null`, `string | "a"`), where the author saw a
// narrowing the type actually does not provide; no-invalid-void-type flags `void` as a union
// constituent (`boolean | void`), where the author meant a callback's return is ignored rather
// than a value the union carries — write the caller's decision as a plain boolean instead
// (landing-slot.ts's `apply` became true = write, the fix that landed with the rule);
// no-inferrable-types flags an annotation the initializer already implies (`x: string = "a"`),
// which adds a second place to edit when the default changes;
// consistent-indexed-object-style flags `{ [k: string]: V }` where `Record<string, V>` says
// the same thing in one spelling;
// prefer-find flags `.filter(pred)[0]`, which builds a whole array to read one element.
//
// Import hygiene: consistent-type-imports flags an import whose every specifier is only a
// type but is written inline (`import { type A } from "./x.js"`) instead of the top-level
// `import type { A }` the rest of the tree uses, so the import contract reads the same
// everywhere and a type-only import never looks like a runtime one. no-import-type-side-effects
// flags an import whose every specifier is an inline `type` (`import { type A, type B }`). With
// verbatimModuleSyntax, tsc elides the inline specifiers but keeps the statement as
// `import "./x.js"`, so the module stays a runtime dependency the author did not ask for; a
// top-level `import type` removes the statement entirely. (The two adapter modules fixed for
// this landed as the rule was enabled.)
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
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
      "@typescript-eslint/return-await": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/no-invalid-void-type": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/consistent-type-imports": "error",  // inline-only-type imports use top-level `import type`
      "@typescript-eslint/consistent-type-exports": "error",  // a type-only export spells `export type { A }`, so a module's type exports never look like runtime ones (the export twin of consistent-type-imports)
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/no-inferrable-types": "error",
      "@typescript-eslint/consistent-indexed-object-style": "error",
      "@typescript-eslint/prefer-find": "error",
      "@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
      "@typescript-eslint/no-unnecessary-template-expression": "error",
      "@typescript-eslint/prefer-string-starts-ends-with": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/prefer-includes": "error",
      "@typescript-eslint/prefer-regexp-exec": "error",
      "@typescript-eslint/no-unused-expressions": "error",  // flags dead no-op expressions (stray literals) left by missed edits
      "@typescript-eslint/consistent-type-definitions": "error",  // object shapes spell `interface Foo { … }`, not `type Foo = { … }`
      "@typescript-eslint/prefer-return-this-type": "error",  // a fluent method spells its return as `this`, so a subclass keeps the chain typed as the subclass
      "@typescript-eslint/no-unnecessary-type-arguments": "error",  // a type argument tsc infers anyway is a second place to edit when the call's shape changes
      "@typescript-eslint/prefer-function-type": "error",  // a one-call-signature object type spells `() => T`, not `{ (): T }`
      "@typescript-eslint/consistent-generic-constructors": "error",  // construct a generic class with `new Foo<T>()`, never the shadowed bare `Foo<T>()`
      "@typescript-eslint/no-array-constructor": "error",  // `new Array(n)` shares one signature with `new Array(v)`; spell `[v]` or `Array.from`
    },
  },
  {
    // Production code only: the rule cannot prove that a test fixture's array elements are
    // all strings (they are arrays of tuples, `any[]`, or `unknown[]`), yet the fixtures sort
    // values whose order is intentionally lexicographic. Scoping here keeps the rule's signal
    // on the code that ships without demanding a comparator on every fixture sort. The rule's
    // default ignoreStringArrays already exempts arrays whose elements are all strings.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "@typescript-eslint/require-array-sort-compare": "error",
      // Production code only: tests wield assertions deliberately (a fixture cast that pins a
      // shape, an `as unknown as` that reaches a broader type, `expect(x as T)`), so the
      // rule's signal — a cast that cannot change the type is a second place to edit when the
      // shape changes — belongs on the code that ships, not on fixtures whose casts are the
      // point.
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      // Production code only: tests spell fixtures as concise `() => void counter++`
      // arrows — the unit `void` disposes the value there so the fixture stays one line —
      // which the rule reads as a meaningless operator, so its signal — a `void` whose
      // operand holds no value to discard (or is already void) — belongs on the code that
      // ships, not on fixture idioms.
      "@typescript-eslint/no-meaningless-void-operator": "error",
      // Production code only: the no-any guard belongs on the code that ships, not on test
      // fixtures, which deliberately type a fake pi event's shape as `any` so a test can read
      // the fields it cares about (`unknown` there would force a narrowing cast on every read
      // and obscure what the fixture is for). src is spotless today (0 sites), so this is a
      // regression guard — an `any` cannot slip into shipped code unnoticed — not a migration.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
