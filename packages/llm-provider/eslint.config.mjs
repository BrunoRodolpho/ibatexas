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
    files: ["src/__tests__/**/*.ts"],
    rules: {
      // Test files place imports after vi.mock() factory calls — standard
      // import grouping cannot be enforced without breaking mock isolation.
      "import/order": "off",
    },
  },
];
