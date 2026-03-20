import coreWebVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

export default [
  ...coreWebVitals,
  ...tseslint.configs.recommended,
  {
    rules: {
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
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
