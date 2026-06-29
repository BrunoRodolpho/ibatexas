import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { FlatCompat } = require("@eslint/eslintrc");
const js = require("@eslint/js");
const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

// ── EGRESS BRAND enforcement (Plan 1 / Theorem E-1) ──────────────────────────
// (c) ban `as RenderedReply` casts; (d) restrict the raw `twilio` SDK import to
// the kernel-gated egress wrapper (twilio/adjudicated.ts). See apps/api config.
const RENDERED_REPLY_CAST_BAN = {
  selector:
    "TSAsExpression > TSTypeReference > Identifier[name='RenderedReply']",
  message:
    "Forging a RenderedReply via `as` is banned (Theorem E-1). Obtain one from a minter in @adjudicate/core; the string is read only via unwrapRendered at egress.",
};

const TWILIO_IMPORT_BAN = {
  name: "twilio",
  message:
    "Raw `twilio` SDK egress is restricted to the kernel-gated wrapper (packages/tools/src/twilio/adjudicated.ts).",
};

export default [
  ...compat.extends("@ibatexas/eslint-config"),
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", RENDERED_REPLY_CAST_BAN],
      "no-restricted-imports": ["error", { paths: [TWILIO_IMPORT_BAN] }],
    },
  },
  {
    // The kernel-gated egress wrapper is the only sanctioned `twilio` importer.
    files: ["src/twilio/adjudicated.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
];
