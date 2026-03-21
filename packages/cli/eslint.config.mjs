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
    rules: {
      // CLI tools legitimately use console.log for all output
      "no-console": "off",
    },
  },
  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      // Test files have vi.mock/vi.hoisted blocks between imports — not real import groups
      "import/order": "off",
    },
  },
];
