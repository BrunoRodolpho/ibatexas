> ⚠️ **PARTIALLY SUPERSEDED on 2026-05-24.** The framing — "before flipping `IBX_KERNEL_ENFORCE`" — references a deleted framework. The kernel is now always-on (`CLAUDE.md` rule #9; cutover commit `f3bea43`). However, the **operational steps below (NATS auth provisioning via `nsc`, the `.creds`/nkey/TLS env vars, the `[nats][SECURITY]` production warning gate) remain valid** for production hardening — the `packages/nats-client/src/index.ts` code path still consumes these env vars, and the production-deploy precondition has not changed in substance, only in wording (now "before production deploy" rather than "before enforce flip"). Treat this as live operator guidance with stale gate-framing. Content preserved unchanged below as historical-but-actionable record.

---

# NATS Authentication — OPERATOR ACTION REQUIRED (P0-12)

> Wave 4 security remediation. The code path is now ready to accept NATS
> credentials and TLS — but the **server-side configuration and credential
> provisioning is an operator task that gates the production rollout.**

## TL;DR

The W4 commit wires NATS auth/TLS pickup from env vars but ships
**without auth configured** to preserve dev / shadow compatibility.
**Before flipping `IBX_KERNEL_ENFORCE` on production:**

1. Provision NATS server credentials (nkey or JWT/.creds + operator account).
2. Configure the NATS server to require auth + TLS on the public listener.
3. Distribute credentials to every IbateXas service that opens a NATS
   connection (api, llm-provider, jobs, subscribers).
4. Flip the env vars per the table below.
5. Rotate the operator account NKEY at the cadence in the ops runbook
   (≥ every 90 days).

Until steps 1–4 land, **the production warning at startup is intentional**.

## Threat model (audit 05 §N1/N2)

Pre-W4 the client at `packages/nats-client/src/index.ts:29-33` called
`connect()` with no `user`, `pass`, `token`, `nkey`, `creds`, or `tls`
option. Any process reaching the NATS port (typically `4222`) could:

- Subscribe to `ibatexas.audit.intent.decision.v1` and exfiltrate every
  adjudicated payload — including PII the redactor missed.
- Publish forged `payment.status_changed`, `intent.defer.timeout`,
  `order.canceled`, `customer.welcome_credit.grant` events that
  downstream subscribers consume **without per-message signature
  verification**. The grace-resolver subscriber in particular runs the
  irreversible `anonymizeCustomer()` based purely on event shape.

NATS Core has no inherent integrity check on messages — even on an
authenticated cluster, subscribers MUST gate destructive operations on
authoritative Redis / DB state (which the grace-resolver does — but it
should not need to).

## Env vars consumed by `@ibatexas/nats-client`

| Env var | Purpose | Required for prod |
|---|---|---|
| `NATS_URL` | connect target (e.g. `nats://nats.svc.cluster.local:4222`) | yes |
| `NATS_CREDS_PATH` | path to a `.creds` file containing JWT + nkey (NATS account auth — recommended for prod) | yes (one of CREDS / NKEY) |
| `NATS_NKEY_SEED` | raw nkey seed string (`S...`) — simpler than creds but ties auth to a long-lived secret | alternative |
| `NATS_TLS_CA` | path to PEM CA cert for the NATS server | yes |
| `NATS_TLS_REQUIRED` | `"true"` to enforce TLS (fail-closed if server doesn't offer it) | yes |

Precedence: `NATS_CREDS_PATH` > `NATS_NKEY_SEED`. The client falls back
to no-auth if neither is set — only acceptable in dev / shadow / CI.

## Operator steps to flip on

### 1. Provision NATS server credentials

Use the NATS `nsc` tool (or your existing NATS operator workflow) to
create an operator + account + user:

```bash
nsc add operator ibatexas-prod
nsc add account ibatexas
nsc add user --account ibatexas svc-api    # one user per service
nsc add user --account ibatexas svc-jobs
nsc add user --account ibatexas svc-llm
```

Export each user's `.creds` file:

```bash
nsc generate creds --account ibatexas --user svc-api > svc-api.creds
nsc generate creds --account ibatexas --user svc-jobs > svc-jobs.creds
nsc generate creds --account ibatexas --user svc-llm > svc-llm.creds
```

Store each `.creds` in your secrets manager (AWS Secrets Manager,
Vault, k8s Secrets) and mount into the container filesystem at startup.

### 2. Configure the NATS server

In `nats-server.conf`:

```hocon
operator: /etc/nats/jwt/ibatexas-prod.jwt
resolver: {
  type: full
  dir: '/etc/nats/jwt'
  allow_delete: false
}
resolver_preload: {
  ABC123...: "/etc/nats/jwt/ibatexas.jwt"
}

tls: {
  cert_file: "/etc/nats/tls/server-cert.pem"
  key_file: "/etc/nats/tls/server-key.pem"
  ca_file: "/etc/nats/tls/ca.pem"
  verify: true
  timeout: 5
}
```

Restart NATS. Verify unauthenticated `nats sub ibatexas.>` is refused.

### 3. Distribute credentials + flip env vars

For each service (api, jobs, llm-provider):

```bash
# Mount the credential into the container at /etc/nats/api.creds
# Mount the CA at /etc/nats/ca.pem
export NATS_URL="nats://nats.svc.cluster.local:4222"
export NATS_CREDS_PATH=/etc/nats/api.creds
export NATS_TLS_CA=/etc/nats/ca.pem
export NATS_TLS_REQUIRED=true
```

Restart the service. Verify:

- The service logs `[nats] connected` (no `[SECURITY]` warning).
- A subscribe attempt without creds is refused by the server.
- A publish attempt without TLS is refused.

### 4. Rotate the operator NKEY

Every 90 days (or after any credential exposure):

```bash
nsc rotate user --account ibatexas svc-api
# Replace the credential in your secrets manager
# Roll the services with the new credential
```

Roll one service at a time to avoid a window of total outage.

## Validation checklist before flipping `IBX_KERNEL_ENFORCE`

- [ ] `nats sub ibatexas.audit.intent.decision.v1` from a host without
      creds is refused at the server.
- [ ] `nats pub ibatexas.payment.status_changed '{}'` from a host
      without creds is refused.
- [ ] A pod with a wrong `.creds` cannot subscribe even with valid TLS.
- [ ] TLS handshake fails for clients without the CA cert.
- [ ] Production logs no longer emit the `[nats][SECURITY]` warning.
- [ ] All three IbateXas services (api, jobs, llm-provider) reconnect
      cleanly after a NATS server restart with the new auth/TLS.

## What the W4 code change does NOT do

- Does not provision credentials (operator task).
- Does not configure the NATS server (operator task).
- Does not enforce per-message HMAC signatures (audit 05 §N2 —
  deferred; the no-NATS-auth fix mitigates the immediate attack surface).
- Does not flip on the env vars in any environment (operator task).

The W4 code change makes the code PATH ready to flip; the actual
production deploy of credentials + server config + env vars is owned
by ops.

## Cross-references

- Audit: `docs/adjudicate-migration/audit/05-security-red-team.md` §N1, §N2
- Code: `packages/nats-client/src/index.ts`
- Existing NATS Core → JetStream migration TODO (separate work):
  `docs/adjudicate-migration/audit/AUDIT-SYNTHESIS.md` §"Cascade scenarios"

---

**Owner:** Platform Operations  
**Status:** PENDING — code path ready; credential provisioning + server
configuration must complete before `IBX_KERNEL_ENFORCE` is flipped on
production.
