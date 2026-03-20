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
  ...compat.extends("next/core-web-vitals"),
  ...compat.plugins("@typescript-eslint"),
  {
    rules: {
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-imports": ["error", {
        paths: [{
          name: "@/domains",
          message: "Import from the specific domain barrel (e.g., '@/domains/cart') to preserve tree-shaking."
        }]
      }],
      "no-restricted-syntax": ["error",
        {
          selector: "JSXAttribute[name.name='className'][value.type='Literal'][value.value=/(?:text|bg|border|ring)-(?:red|green|blue|yellow|orange|purple|pink|gray)-\\d{2,3}/]",
          message: "Use design-system tokens (accent-red, accent-green, brand-*, smoke-*, charcoal-*) instead of raw Tailwind colors."
        },
        {
          selector: "TSAsExpression > TSTypeReference[typeName.name='any']",
          message: "Avoid 'as any'. Use a proper type or unknown."
        }
      ],
    },
  },
];
