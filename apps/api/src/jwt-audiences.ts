// JWTSPLIT (audit): audience identifiers that bind each JWT to its tier.
//
// These are fixed protocol constants (like the `token` / `staff_token` cookie names),
// NOT deployment-tunable config — so they live in code, shared by the signer
// (routes/auth.ts issueJwtToken / issueStaffJwtToken) and the verifier registration
// (server.ts) so the `aud` written at sign time and the `allowedAud` enforced at verify
// time can never drift.
//
// Combined with the separate per-tier signing secrets (JWT_SECRET vs STAFF_JWT_SECRET),
// a token minted for one tier carries that tier's `aud` and is rejected by the other
// tier's verifier (defense beyond the application-level `userType` claim check).
export const JWT_AUDIENCE_CUSTOMER = "ibatexas-customer";
export const JWT_AUDIENCE_STAFF = "ibatexas-staff";
