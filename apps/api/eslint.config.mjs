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
//
// Defense-in-depth for the runtime-non-forgeable `RenderedReply`:
//   (c) ban `as RenderedReply` (and `as any/unknown as RenderedReply`) — a cast
//       is the only compile-time way to synthesize a brand without a minter; the
//       module-private symbol blocks object literals, so the cast is the gap.
//   (d) restrict the raw `twilio` SDK import to the customer-egress chokepoint
//       (whatsapp/client.ts) plus the inbound/OTP surfaces that legitimately use
//       Twilio for NON-egress (webhook signature validation, Verify OTP). Every
//       other module must go through a minter + the kernel-gated wrapper.
const RENDERED_REPLY_CAST_BAN = {
  selector:
    "TSAsExpression > TSTypeReference > Identifier[name='RenderedReply']",
  message:
    "Forging a RenderedReply via `as` is banned (Theorem E-1). Obtain one from a minter in @adjudicate/core (mint*/wrapLegacyResponderText); the string is read only via unwrapRendered at egress.",
};

const TWILIO_IMPORT_BAN = {
  name: "twilio",
  message:
    "Raw `twilio` SDK egress is restricted to the branded chokepoint (apps/api/src/whatsapp/client.ts). Send customer text via sendText(...) with a RenderedReply minted in @adjudicate/core.",
};

// (e) close the raw-HTTP egress vector: a direct call to the Twilio REST host
// (`https://api.twilio.com/...`) bypasses the SDK-import ban entirely (Theorem E
// is sole-emitter, not sole-importer). Ban any reference to the host — string
// literal or template — so customer egress cannot be smuggled via `fetch`.
const TWILIO_REST_HOST_BAN = [
  {
    selector: "Literal[value=/api\\.twilio\\.com/]",
    message:
      "Direct calls to the Twilio REST host (api.twilio.com) are banned outside the kernel-gated egress chokepoint (Theorem E-1 sole-emitter). Send customer text via sendText(...) with a minted RenderedReply.",
  },
  {
    selector: "TemplateElement[value.raw=/api\\.twilio\\.com/]",
    message:
      "Direct calls to the Twilio REST host (api.twilio.com) are banned outside the kernel-gated egress chokepoint (Theorem E-1 sole-emitter).",
  },
];

// Files allowed to import the raw `twilio` SDK: the egress chokepoint plus the
// inbound-validation / Verify-OTP surfaces (non-message-egress uses).
const TWILIO_ALLOWED = [
  "src/whatsapp/client.ts",
  "src/routes/whatsapp-webhook.ts",
  "src/routes/auth.ts",
  "src/routes/me/anonymize-otp-gate.ts",
];

export default [
  ...compat.extends("@ibatexas/eslint-config"),
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        RENDERED_REPLY_CAST_BAN,
        ...TWILIO_REST_HOST_BAN,
      ],
      "no-restricted-imports": ["error", { paths: [TWILIO_IMPORT_BAN] }],
    },
  },
  {
    // Egress chokepoint + Twilio inbound/OTP surfaces may import the SDK; the
    // RenderedReply cast ban + REST-host ban still apply to them (they use the
    // SDK, never a raw api.twilio.com fetch).
    files: TWILIO_ALLOWED,
    rules: {
      "no-restricted-imports": "off",
    },
  },
];
