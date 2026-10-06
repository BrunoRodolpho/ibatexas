import { createRequire } from "module";
import coreWebVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

// ── Audit-redaction chokepoint (F-53) ────────────────────────────────────────
//
// apps/web builds on eslint-config-next rather than @ibatexas/eslint-config, so
// it never inherited the repo-wide ban on the raw @adjudicate/audit sink
// primitives. It is spliced in directly here to keep the invariant's reach
// uniform across every workspace. The frontend does not declare
// @adjudicate/audit today, so this is forward cover: it makes a future emit
// path fail lint at the moment it is written rather than at review.
const require = createRequire(import.meta.url);
const { AUDIT_RAW_SINK_IMPORT_BAN } = require("@ibatexas/eslint-config/restricted-imports.js");

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
        },
        AUDIT_RAW_SINK_IMPORT_BAN]
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
