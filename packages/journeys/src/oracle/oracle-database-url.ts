// oracle/oracle-database-url.ts — ORACLE_DATABASE_URL accessor (T1a-9).
//
// The deterministic oracle reads Postgres EXCLUSIVELY through the SELECT-only
// role provisioned by scripts/test-stack/create-readonly-role.sql
// (ibx_oracle_ro — SELECT on the public/intent_audit + ibx_domain schemas,
// nothing else; writes fail with 42501 insufficient_privilege). This helper
// is the single place oracle code obtains its connection string: it refuses
// any URL whose user is not the read-only role, so an oracle can never be
// silently pointed at the migration/app role (which CAN write).

/** The read-only role name pinned by scripts/test-stack/create-readonly-role.sql. */
export const ORACLE_DB_ROLE = "ibx_oracle_ro"

export class OracleDatabaseUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OracleDatabaseUrlError"
  }
}

/**
 * Returns ORACLE_DATABASE_URL after validating it names the read-only oracle
 * role. Throws `OracleDatabaseUrlError` when the var is missing, not a
 * postgres URL, or connects as any user other than `ibx_oracle_ro`.
 */
export function requireOracleDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env["ORACLE_DATABASE_URL"]
  if (raw === undefined || raw === "") {
    throw new OracleDatabaseUrlError(
      "ORACLE_DATABASE_URL is not set — the journeys oracle only connects via the " +
        `SELECT-only ${ORACLE_DB_ROLE} role (see .env.test.example, provisioned by ` +
        "scripts/test-stack/provision-oracle-role.sh)",
    )
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new OracleDatabaseUrlError("ORACLE_DATABASE_URL is not a valid URL")
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new OracleDatabaseUrlError(
      `ORACLE_DATABASE_URL must be a postgresql:// URL (got protocol "${parsed.protocol}")`,
    )
  }

  const user = decodeURIComponent(parsed.username)
  if (user !== ORACLE_DB_ROLE) {
    throw new OracleDatabaseUrlError(
      `ORACLE_DATABASE_URL must connect as the read-only role "${ORACLE_DB_ROLE}" ` +
        `(got "${user}") — containment: the oracle is never allowed a writable Postgres role`,
    )
  }

  return raw
}
