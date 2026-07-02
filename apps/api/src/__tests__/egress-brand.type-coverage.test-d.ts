// EGRESS BRAND (Plan 1 / Theorem E-1) — BUILD-TIME coverage test.
//
// Proves the retype: NO exported customer-egress function accepts a bare
// `string`. Every customer-facing payload must be a runtime-non-forgeable
// `RenderedReply` minted by the closed factory set in `@adjudicate/core`.
//
// MECHANISM: this file is type-checked by the package `tsc` pass (tsconfig
// `include: ["src"]`, exercised by the `lint`/`typecheck`/`build` tasks) but is
// NOT executed by Vitest (its default glob matches `*.test.ts` / `*.spec.ts`,
// never `*.test-d.ts`). Each `@ts-expect-error` below asserts that handing a
// bare string to an egress sink FAILS to compile — if anyone widened a sink's
// type back to `string`, the directive would become unused and tsc would error
// ("Unused '@ts-expect-error' directive"), turning the regression red. The
// paired POSITIVE lines prove the sink still accepts a minted reply (so each
// negative fails for the RIGHT reason — the body type, not arity/shape drift).
//
// Runtime non-forgeability (a forged object literal `as RenderedReply`) is the
// COMPLEMENTARY defense-in-depth leg, enforced by `unwrapRendered`'s WeakSet
// gate (unit-tested in @adjudicate/core) + the eslint `as RenderedReply` ban.

import { mintRenderedReply, type AuditSink } from "@adjudicate/core";
import {
  twilioAdjudicated,
  type TwilioAdjudicatedMeta,
  type WhatsAppSender,
} from "@ibatexas/tools";
import {
  sendText,
  sendMedia,
  sendInteractiveList,
  sendInteractiveButtons,
} from "../whatsapp/client.js";
import { pushChunk } from "../streaming/emitter.js";

// Never invoked — this file exists purely so tsc evaluates the assertions.
export function __egressBrandTypeCoverage(): void {
  const reply = mintRenderedReply("ok");
  const meta: TwilioAdjudicatedMeta = {
    sourceSubject: "egress-type-coverage",
    // Required by contract; this file is type-checked, never executed.
    auditSink: null as unknown as AuditSink,
  };
  const sender = null as unknown as WhatsAppSender;

  // ── (1) apps/api whatsapp client `sendText` ────────────────────────────────
  void sendText("whatsapp:+1", reply); // POSITIVE: a minted reply compiles.
  // @ts-expect-error E-1: sendText rejects a bare string (RenderedReply only).
  void sendText("whatsapp:+1", "bare string");

  // ── (2) the proactive `WhatsAppSender` interface ───────────────────────────
  void sender.sendText("whatsapp:+1", reply); // POSITIVE.
  // @ts-expect-error E-1: WhatsAppSender.sendText rejects a bare string.
  void sender.sendText("whatsapp:+1", "bare string");

  // ── (3) the kernel-gated Twilio egress wrapper body ────────────────────────
  void twilioAdjudicated.messages.create(
    { from: "whatsapp:+1", to: "whatsapp:+2", body: reply }, // POSITIVE.
    meta,
  );
  void twilioAdjudicated.messages.create(
    // @ts-expect-error E-1: the Twilio wrapper body is a RenderedReply, not a string.
    { from: "whatsapp:+1", to: "whatsapp:+2", body: "bare string" },
    meta,
  );

  // ── (4) the SSE `text_delta` stream chunk delta ────────────────────────────
  pushChunk("sid", { type: "text_delta", delta: reply }); // POSITIVE.
  // @ts-expect-error E-1: a text_delta stream chunk carries a RenderedReply delta.
  pushChunk("sid", { type: "text_delta", delta: "bare string" });

  // ── (5) sendMedia customer-facing caption (F4) ─────────────────────────────
  // The optional caption is minted at the producer; sendMedia no longer mints
  // unvalidated prose internally.
  void sendMedia("whatsapp:+1", "https://cdn/x.png", reply); // POSITIVE.
  // @ts-expect-error E-1: sendMedia caption is a RenderedReply, not a bare string.
  void sendMedia("whatsapp:+1", "https://cdn/x.png", "bare string");

  // ── (6) sendInteractiveList customer-facing body (F4) ──────────────────────
  // `_buttonText` stays a string (fixed UI affordance label, not customer-prose);
  // the customer-facing `body` MUST be a RenderedReply.
  void sendInteractiveList("whatsapp:+1", reply, "Ver", []); // POSITIVE.
  // @ts-expect-error E-1: sendInteractiveList body is a RenderedReply, not a bare string.
  void sendInteractiveList("whatsapp:+1", "bare string", "Ver", []);

  // ── (7) sendInteractiveButtons customer-facing body (F4) ───────────────────
  void sendInteractiveButtons("whatsapp:+1", reply, []); // POSITIVE.
  // @ts-expect-error E-1: sendInteractiveButtons body is a RenderedReply, not a bare string.
  void sendInteractiveButtons("whatsapp:+1", "bare string", []);
}
