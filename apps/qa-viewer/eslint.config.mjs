import { createRequire } from "module";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// ── Audit-redaction chokepoint (F-53) ────────────────────────────────────────
//
// qa-viewer composes typescript-eslint directly rather than extending
// @ibatexas/eslint-config, so it never inherited the repo-wide ban on the raw
// @adjudicate/audit sink primitives. Spliced in to keep the invariant's reach
// uniform; `scripts/check-audit-sink-import-ban.mjs` is what found this gap and
// fails if it reopens.
const require = createRequire(import.meta.url);
const { AUDIT_RAW_SINK_IMPORT_BAN } = require("@ibatexas/eslint-config/restricted-imports.js");

export default tseslint.config(
  { ignores: ["dist/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-const": "error",
      "no-var": "error",
      "no-restricted-imports": ["error", { paths: [AUDIT_RAW_SINK_IMPORT_BAN] }],
    },
  },
);
