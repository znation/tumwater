// ESLint's own `complexity` rule (classic McCabe) over src/, an independent check of the per-function
// counts analyze.cjs computes. run.sh runs it from the checkout root:
//   npx eslint --no-config-lookup -c docs/code-metrics/eslint-complexity.config.mjs --format json 'src/**/*.ts'
// max: 0 makes the rule report every function, each message carrying its complexity.
import tseslint from "typescript-eslint";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    rules: { complexity: ["warn", { max: 0, variant: "classic" }] },
  },
];
