// ESLint flat config for `scripts/` — the repo-root tooling directory.
//
// `scripts/` is NOT a pnpm workspace, so `turbo lint` (which only runs
// workspace tasks) can never reach it. It is linted by the root
// `lint:scripts` script, which passes this file explicitly via `--config`.
//
// This config deliberately lives HERE rather than at the repo root: a root
// `eslint.config.*` is picked up by any `eslint` run whose cwd is a directory
// without its own config, which would silently extend this rule set over
// workspaces that have not been measured or enabled yet. Keeping it in
// `scripts/` and invoking it with an explicit `--config` keeps the blast
// radius exactly one directory wide.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { FlatCompat } = require("@eslint/eslintrc");
const js = require("@eslint/js");
const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  ...compat.extends("@ibatexas/eslint-config"),
  {
    files: ["scripts/**/*.{ts,mjs}"],
    languageOptions: {
      // The `.mjs` gate scripts run under plain Node, where `no-undef` is a
      // live rule (typescript-eslint disables it for `.ts`). Declaring the
      // runtime's own globals is an environment declaration, not a rule
      // relaxation — without it every `console`/`process` reference is a
      // false "undefined variable" error.
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        fetch: "readonly",
      },
    },
    rules: {
      // Same exception `packages/cli` already takes: these are CLI gate
      // scripts whose entire output contract is stdout/stderr.
      "no-console": "off",
    },
  },
];
