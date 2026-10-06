// guest-identity.ts — the guest-marker convention, extracted verbatim from
// register-ibatexas-tool-packs.ts (BKL-230, chat-wiring slice).
//
// It lives in its own leaf module ONLY to break an import cycle: the tool
// registry needs `resolvePixPayerIdentity` (pix-payer-identity.ts) to wire the
// chat-plane PIX checkout, and that resolver needs this predicate to reject a
// guest session. Both symbols are still RE-EXPORTED from
// register-ibatexas-tool-packs.ts, so every existing importer (notably
// claustrum-bootstrap) is unaffected and that file remains the documented
// source of truth for the convention. Behavior is byte-identical to the
// original.

// A Capsule/AgentContext customerId that is empty or carries a
// `guest:`/`anon:`/`anonymous:` marker prefix is NOT a real customer id.
export const GUEST_ID_PREFIXES = ["guest:", "anon:", "anonymous:"] as const;

export function isGuestCustomerId(id: string | undefined): boolean {
  if (id === undefined) return true;
  const trimmed = id.trim();
  if (trimmed === "") return true;
  return GUEST_ID_PREFIXES.some((p) => trimmed.startsWith(p));
}
