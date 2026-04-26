/**
 * Feature-flag helper for staged ledger rollout.
 *
 * Phase F: IBX_LEDGER_ENABLED=true turns on shadow writes (record but do not
 * enforce). Phase G: flipping IBX_LEDGER_ENFORCE=true makes `checkLedger`
 * authoritative on the write path.
 */

export function isLedgerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseBool(env["IBX_LEDGER_ENABLED"]);
}

export function isLedgerEnforced(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseBool(env["IBX_LEDGER_ENFORCE"]);
}

function parseBool(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
