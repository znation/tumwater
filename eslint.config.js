// Type-aware lint, run by `npm test` ahead of the suite so the merge gate enforces it. It
// carries one rule on purpose: tsc already covers everything else we care about, and
// no-floating-promises is what tsc cannot see — an un-awaited async call typechecks fine
// and silently races (33521347 dropped the await on 25 e2e waits and CI broke).
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
    },
  },
);
