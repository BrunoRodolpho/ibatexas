// Tests for oracle/oracle-database-url.ts — the oracle may only ever connect
// as the SELECT-only ibx_oracle_ro role (T1a-9 containment).
import { describe, it, expect } from "vitest"

import {
  ORACLE_DB_ROLE,
  OracleDatabaseUrlError,
  requireOracleDatabaseUrl,
} from "../oracle-database-url.js"

const GOOD_URL = "postgresql://ibx_oracle_ro:s3cret@localhost:5434/ibatexas_test"

describe("requireOracleDatabaseUrl", () => {
  it("returns the URL when it connects as the read-only role", () => {
    expect(requireOracleDatabaseUrl({ ORACLE_DATABASE_URL: GOOD_URL })).toBe(GOOD_URL)
  })

  it("accepts the short postgres:// protocol too", () => {
    const url = `postgres://${ORACLE_DB_ROLE}:pw@localhost:5434/ibatexas_test`
    expect(requireOracleDatabaseUrl({ ORACLE_DATABASE_URL: url })).toBe(url)
  })

  it("throws when the var is missing or empty", () => {
    expect(() => requireOracleDatabaseUrl({})).toThrow(OracleDatabaseUrlError)
    expect(() => requireOracleDatabaseUrl({ ORACLE_DATABASE_URL: "" })).toThrow(
      OracleDatabaseUrlError,
    )
  })

  it("throws when the URL is malformed", () => {
    expect(() => requireOracleDatabaseUrl({ ORACLE_DATABASE_URL: "not a url" })).toThrow(
      OracleDatabaseUrlError,
    )
  })

  it("throws on a non-postgres protocol", () => {
    expect(() =>
      requireOracleDatabaseUrl({
        ORACLE_DATABASE_URL: `mysql://${ORACLE_DB_ROLE}:pw@localhost:3306/db`,
      }),
    ).toThrow(/postgresql/)
  })

  it("refuses any user other than ibx_oracle_ro (e.g. the writable app role)", () => {
    expect(() =>
      requireOracleDatabaseUrl({
        ORACLE_DATABASE_URL: "postgresql://ibatexas:pw@localhost:5434/ibatexas_test",
      }),
    ).toThrow(OracleDatabaseUrlError)
    expect(() =>
      requireOracleDatabaseUrl({
        ORACLE_DATABASE_URL: "postgresql://ibatexas:pw@localhost:5434/ibatexas_test",
      }),
    ).toThrow(/read-only role "ibx_oracle_ro"/)
  })

  it("decodes percent-encoded usernames before comparing", () => {
    const url = "postgresql://ibx%5Foracle%5Fro:pw@localhost:5434/ibatexas_test"
    expect(requireOracleDatabaseUrl({ ORACLE_DATABASE_URL: url })).toBe(url)
  })
})
