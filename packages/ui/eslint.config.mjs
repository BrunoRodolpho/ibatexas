import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { FlatCompat } = require("@eslint/eslintrc");
const js = require("@eslint/js");
const reactHooks = require("eslint-plugin-react-hooks");
const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

// `react-hooks` is scoped to THIS package rather than added to
// `@ibatexas/eslint-config`: the shared config is consumed by ~18 non-React
// workspaces where a hooks plugin is dead weight, and widening it would put
// every one of them on this plugin's release cadence. `ui` is the only React
// library in `packages/*` (the two Next apps get the same rules through
// `eslint-config-next`), so the plugin belongs here.
//
// `exhaustive-deps` is a WARNING, matching `apps/web`'s stance on the same
// rule — a deps-array finding is a review prompt, not a build stop. It is set
// explicitly (rather than left off) so the rule is DEFINED:
// `src/hooks/admin-factory.ts` carries a targeted
// `eslint-disable-next-line react-hooks/exhaustive-deps`, and a disable
// naming an undefined rule is itself an eslint error.
export default [
  ...compat.extends("@ibatexas/eslint-config"),
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
