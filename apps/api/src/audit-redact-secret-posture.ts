// audit-redact-secret-posture.ts — BKL-093 boot-time posture gate for the
// audit redaction salt. Kept as a standalone, dependency-free module (type-only
// import) so the pure fail-closed logic is unit-testable without pulling the
// audit-sink / Prisma / NATS graph that `audit-sink-bootstrap.ts` carries.

import type { FastifyBaseLogger } from "fastify";

/**
 * BKL-093 — `AUDIT_REDACT_SECRET` posture gate. The redactor salts its `hashed:*`
 * outputs (audit `actor.sessionId`, `name` / `address` / `customerId` payload
 * fields) with `AUDIT_REDACT_SECRET`; an EMPTY salt makes those hashes
 * rainbow-table-attackable (a known-sessionId dictionary — phone hashes,
 * `admin:{staffId}` — becomes reversible).
 *
 * Fail-CLOSED in production (mirrors the ADMIN_API_KEYS prod check in
 * routes/admin/index.ts): throw at boot so a misconfigured deploy never serves
 * traffic with unsalted audit hashing. Dev keeps a WARN (createAuditRedactor
 * also warns when the salt is empty) so local runs stay convenient. Pure +
 * injectable so both branches are unit-testable.
 */
export function assertAuditRedactSecretPosture(opts: {
  readonly nodeEnv: string | undefined;
  readonly secret: string | undefined;
  readonly log: Pick<FastifyBaseLogger, "warn">;
}): void {
  const secret = opts.secret ?? "";
  if (secret.trim().length > 0) return; // configured — salted hashing is safe

  if (opts.nodeEnv === "production") {
    throw new Error(
      "AUDIT_REDACT_SECRET must be set in production — audit session-id and PII " +
        "hashing is rainbow-table-attackable without a salt. Set a 32+ char random " +
        "value (openssl rand -base64 32).",
    );
  }

  opts.log.warn(
    { event: "audit_redact_secret.empty" },
    "[audit-sink-bootstrap] AUDIT_REDACT_SECRET is empty — audit hashing is " +
      "rainbow-table-attackable. Acceptable in dev only; production fails closed at boot.",
  );
}
