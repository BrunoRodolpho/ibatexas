

# ===== VERIFIER: bootstrap =====

## [CONFIRMED] buildAdjudicator({ sink: getAuditSink() }) at ~line 1165 never passes deps.ledger; TODO Stage 3 comment; no kernel-level replay suppression today
- evidence: apps/api/src/claustrum-bootstrap.ts:1161-1165, 186-204 (AdjudicatorBridgeDeps), 420 (safeAuditedAdjudicate spread)
- note: Line 1165: `const adjudicator = buildAdjudicator({ sink: getAuditSink() });` preceded by `// TODO(Stage 3): wire createRedisLedger(...) for cross-turn replay-suppression`. `ledger` is an optional field on AdjudicatorBridgeDeps, only forwarded to adjudicateAndAudit when present (`...(deps.ledger ? { ledger: deps.ledger } : {})`). No createRedisLedger call exists in the file. Comment notes domain-level idempotency (cycle-2 PAY-3) covers payments meanwhile.

## [CONFIRMED] replayEnvelopesByCustomerId / streamAuditByIntentHashPrefix / getOutcomes are empty stubs marked TODO(loop-closure) at ~311-323
- evidence: apps/api/src/claustrum-bootstrap.ts:311-323
- note: All three exactly as described: replayEnvelopesByCustomerId returns `[] as ReadonlyArray<AuditRecord>` (TODO at 312), streamAuditByIntentHashPrefix is an empty async generator (TODO at 318), getOutcomes returns `[]` (TODO at 321). Note verifyAuditRecord (324-332) is NOT a stub — it does real kernel tamper verification.

## [CONFIRMED] AnthropicProvider constructed inline with no DI seam; optional modelProvider override would be a purely in-repo change
- evidence: apps/api/src/claustrum-bootstrap.ts:1102, 1137-1151, 1252-1258; apps/api/src/claustrum/ibatexas-planner.ts:90-94
- note: `new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY ?? ""})` then `new AnthropicProvider({client, onWarn})` at 1143, inside `bootstrapClaustrum(): Promise<Conductor>` which takes ZERO parameters (line 1102) — no injection point. File is ibatexas-side; IbatexasPlannerDeps.model is already typed as the generic `ModelProvider` port, and naiveResponder takes the provider as an arg, so adding an optional override param to bootstrapClaustrum is purely in-repo (no claustrum/adjudicate upstream change).

## [CONFIRMED] Planner mints a fresh nonce per attempt; deterministic trigger nonces implementable adopter-side
- evidence: apps/api/src/claustrum/ibatexas-planner.ts:260-268 (nonce: randomUUID()); node_modules/.pnpm/@adjudicate+core@1.3.0/.../dist/envelope.d.ts:57-97; apps/api/src/subscribers/__shared__/system-actor-envelope.ts:86-99
- note: Nonce minted at ibatexas-planner.ts:266 `nonce: randomUUID()` inside propose() per express_intent call — fresh every (re)plan. intentHash = hash(version, kind, payload, nonce, actor, taint) (envelope.d.ts:93); nonce is documented as 'the load-bearing idempotency key — retries of the same logical action MUST share the same nonce'. buildEnvelope takes nonce as a caller-supplied input, and the planner + its deps type are in-repo, so deterministic hash(triggerId+intentKind) nonces need only an in-repo planner change (e.g. add deriveNonce to IbatexasPlannerDeps, threaded from the trigger bridge via CognitiveState) — adopter-side only. CAVEAT: payload is also in-hash and is LLM-generated, so a redelivered trigger that re-plans can still produce a different intentHash even with a deterministic nonce; full kernel dedup requires deterministic payloads too (or building trigger envelopes via buildSystemEnvelope, which already uses deterministic nonce = eventId).

## [CONFIRMED] sessionTokenBudgetGuard exists and shows the composed-guard pattern for createAgentScopeGuard to mirror
- evidence: apps/api/src/claustrum/compose-policy-packs.ts:40-53, 92-118
- note: `export const sessionTokenBudgetGuard = nameGuard("sessionTokenBudget", createTokenBudgetGuard<...>({extractSessionTokens, sessionBudget, action: "REFUSE", userFacing}))` using @adjudicate/primitives; prepended adopter-level to every pack's business phase via IBATEXAS_ADOPTER_BUSINESS_GUARDS + buildIbatexasPolicyPacks — exactly the composed, no-pack-source-change pattern the plan wants to mirror. A second example (confirmOnAutoResolveGuard via createConfirmGuard) sits alongside it.

## [CONFIRMED] apps/api/src/jobs/register-workers.ts exists
- evidence: apps/api/src/jobs/register-workers.ts (listed via ls apps/api/src/jobs/)
- note: Exists alongside ~20 other job/worker modules (queue.ts, stale-order-checker.ts, pix-expiry-checker.ts, defer-timeout-sweeper.ts, etc.) — a natural neighbor for a trigger bridge.

## [CONFIRMED] HandoffPort wired as noop — ESCALATE goes nowhere humanward
- evidence: apps/api/src/claustrum-bootstrap.ts:648-661 (noopHandoff), 1260 (handoff: noopHandoff()), 18 (header comment)
- note: noopHandoff().queue() only emits `logger.warn(..., "handoff queued (noop — Slack/PagerDuty not wired)")` with a `// TODO: wire Slack/PagerDuty` comment; wired into createConductor at line 1260. No human-facing delivery.

## [CONFIRMED] ANTHROPIC_MODEL controls SUT planner/responder model; note production model
- evidence: apps/api/src/claustrum-bootstrap.ts:1254 (planner modelId), 813 (naiveResponder), .env.example:8, docker-compose.prod.yml:16/40/60 (env_file: .env)
- note: Both planner (`modelId: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-5-20250101"`) and responder (same expression at 813) read ANTHROPIC_MODEL — one var controls both, so pinning Haiku in a test env is a single env change but cannot pin planner/responder separately. Production: .env.example sets `ANTHROPIC_MODEL=claude-sonnet-4-6` and docker-compose.prod.yml loads `.env` — so prod runs Sonnet-4.6-class per the committed default; the actual prod .env is uncommitted (rule #6), so this is the best in-repo evidence. Certifying on Haiku tests a different model than prod's Sonnet.

## [CONFIRMED] buildSystemEnvelope() exists in apps/api/src/subscribers/__shared__/
- evidence: apps/api/src/subscribers/__shared__/system-actor-envelope.ts:86-99
- note: `export function buildSystemEnvelope<K extends string, P>(...)` — builds envelopes with principal "system", sessionId `${sourceSubject}:${eventId}`, taint SYSTEM, and deterministic nonce = eventId. The __shared__ dir also contains medusa-anonymize-kinds.ts.

## extraFindings
- Documentation drift: CLAUDE.md rule #9 claims 'The execution ledger (@adjudicate/audit + Redis) is always-on and fail-closed — Redis unreachability surfaces as a refusal rather than a dedup bypass', directly contradicting claustrum-bootstrap.ts:1161-1165 where the ledger is never wired (TODO Stage 3). Any plan-doc consumer reading CLAUDE.md would get the wrong picture; the code is authoritative.
- The code fallback model id 'claude-opus-4-5-20250101' (claustrum-bootstrap.ts:813 and 1254) appears to be a non-existent model ID (the real dated Opus 4.5 ID is claude-opus-4-5-20251101) — it would 404 if ANTHROPIC_MODEL were ever unset, making the env var effectively mandatory.
- buildSystemEnvelope already implements the deterministic-nonce pattern the plan proposes for triggers (nonce = eventId, in-hash), providing an in-repo precedent; @adjudicate/core envelope.d.ts:93-95 confirms intentHash covers (version, kind, payload, nonce, actor, taint) and is independent of createdAt.
- safeAuditedAdjudicate (claustrum-bootstrap.ts:381-433) fails CLOSED on ill-formed PolicyBundles and on any kernel/audit throw — returning REFUSE rather than crashing or executing unaudited; ledger and confirmationReceipt are both optional spreads into adjudicateAndAudit deps.
- AdjudicatorBridgeDeps.ledger doc (claustrum-bootstrap.ts:196-203): 'When present, a duplicate intentHash is suppressed to REPLAY_SUPPRESSED so a side effect cannot double-fire across retried turns' — confirming the suppression mechanism is dormant, not absent, in the bridge.
- EMBEDDING_MODEL_ID (claustrum-bootstrap.ts:1204) defaults to 'text-embedding-3-small' (an OpenAI embedding model name) passed to the pgvector grounding provider via the AnthropicProvider — separate from ANTHROPIC_MODEL and possibly its own misconfiguration.
- ConfirmationReceipt resume semantics (claustrum-bootstrap.ts:249-277): resume re-adjudicates the parked envelope against fresh enriched state; the receipt only satisfies REQUEST_CONFIRMATION→EXECUTE and is ignored on any other decision — relevant to the plan's Stage-1 supervised-mode approval glue.


# ===== VERIFIER: surface =====

## [CONFIRMED] routes/chat.ts: two-step POST /api/chat/messages + SSE GET stream, guest sessionSecret protocol, per-session locks
- evidence: apps/api/src/routes/chat.ts:147-333 (POST), :337-540 (GET /api/chat/stream/:sessionId), :193-215 + :388-398 (guest secret), :221-229 (lock); apps/api/src/streaming/execution-queue.ts:4-57
- note: POST mints/verifies x-session-secret for guests (1h TTL, 403 on mismatch), x-session-token for authed customers, returns {messageId, sessionToken?, sessionSecret?}; GET is hijacked SSE with secret/owner check, buffered replay, heartbeat, cross-replica Redis path. acquireWebAgentLock is a per-session distributed Redis lock (UUID value + Lua conditional release), 409 on conflict.

## [PARTIAL] packages/cli/src/commands/api.ts: ibx api chat implements POST /api/chat/messages + SSE parsing + session reuse, liftable into test ChatClient
- evidence: packages/cli/src/commands/api.ts:116-133 (postChatMessage), :160-193 (parseSseLine/streamChatResponse), :454-492 (ibx api chat, --session flag)
- note: POST + SSE line-parsing (text_delta/tool_start/done/error) + --session <uuid> reuse flag all exist. BUT the CLI ignores the returned sessionSecret/sessionToken and never sends x-session-secret/x-session-token, so guest session reuse 403s while the 1h secret lives. Lifting into ChatClient requires adding secret/token handling; SSE plumbing genuinely reusable.

## [CONFIRMED] checkout-confirmation-store is HTTP receipt store; confirmation traverses POST /api/cart/checkout/confirm; chat-side confirmation resume does not exist (WebChannel.matchToParked returns null)
- evidence: apps/api/src/routes/checkout-confirmation-store.ts:41-164; apps/api/src/routes/cart.ts:1137-1200; apps/api/src/claustrum-bootstrap.ts:73,1235-1246; node_modules @claustrum/channel-web dist/web-channel.js:45-57
- note: Receipt store: Redis, 10-min TTL, atomic Lua GET+DEL single-use consume. Confirm route consumes receipt, ownership-checks, re-adjudicates with confirmationReceipt. WebChannel is defined upstream in @claustrum/channel-web (not ibatexas source), instantiated in claustrum-bootstrap.ts:1236; its matchToParked returns null by design ('web channel has no parked-reply matching'); render sink is a no-op.

## [REFUTED] Contradiction: fake-Twilio OTP seam (line 87) vs no test seam / offline JWT minting (lines 103, gap 4)
- evidence: apps/api/src/routes/auth.ts:26-67,124-162 (real twilio() clients, no dev branch); packages/tools/src/twilio/adjudicated.ts:327-352 (__setTwilioClientForTests)
- note: Plan line ~87 is WRONG: no fake-Twilio Verify seam exists for customers. auth.ts always constructs real twilio(sid,auth) clients and calls verify.v2 (throws if env unset; no magic OTP, no env flag, no stub-when-creds-absent). The only 'fake Twilio seam' is __setTwilioClientForTests in packages/tools — an in-process unit-test injection for messages.create (WhatsApp egress), NOT Verify OTP, unreachable over HTTP. Gap 4 ('no test seam at HTTP level') and line ~103 (offline JWT minting) are the correct statements.

## [CONFIRMED] Offline JWT minting feasibility: HS256 JWT_SECRET, payload (sub, userType, jti, aud), staff requirements, zero code changes
- evidence: apps/api/src/server.ts:70-93; apps/api/src/routes/auth.ts:166-205; apps/api/src/middleware/auth.ts:34-188
- note: Customer: @fastify/jwt default instance, string secret JWT_SECRET (HS256 default), cookie 'token', verify allowedAud:'token'; issued payload {sub, userType:'customer', jti, aud:'token'}, exp 4h. Middleware accepts any token where sub non-empty, userType!=='staff', aud 'token' (undefined=legacy-accept), jti optional (revocation check skipped if absent; needs Redis up if present). Offline-minted token for a seeded customer works with zero code changes. Staff: separate STAFF_JWT_SECRET (must differ), aud 'staff_token', role claim, AND a per-request DB check that the Staff row exists and is active — so staff minting additionally requires a seeded active Staff row.

## [CONFIRMED] customer-intent-gateway.ts exists with forgery defenses
- evidence: apps/api/src/routes/__shared__/customer-intent-gateway.ts:57-130 (types), :250-263 (detectForgery), :274-345 (forgery audit), :414-444 (400 rejection)
- note: Checks exactly two fields at runtime: actor.principal must be 'user' and taint must be 'UNTRUSTED' (read through unknown so `as` casts can't bypass); violation returns 400 code 'forgery_attempt' and emits a system-actor REFUSE audit record (with truncation caps vs audit-DoS). Compile-time: CustomerEnvelope type + buildCustomerEnvelope stamp those fields so callers cannot pass them. Gateway also adjudicates every customer mutation and is fail-closed on the confirmationReceipt path.

## [CONFIRMED] admin-confirmation-store.ts is a receipt cache for two-step admin HTTP routes; cannot list or resume parked claustrum SessionPort envelopes
- evidence: apps/api/src/routes/admin/admin-confirmation-store.ts:42-366
- note: Redis receipt cache: create() stores PendingAdminAction under UUID key (600s TTL); consume() is atomic Lua GET+DEL single-use. API surface is exactly create/consume plus consumeWithSameActorCheck (two-person rule). No list/enumerate operation exists, and it stores route-layer snapshots only — zero references to claustrum SessionPort, Capsule, or parked envelopes.

## [CONFIRMED] NATS currently runs WITHOUT authentication; subscribe-only credentials would be net-new infrastructure
- evidence: docker-compose.yml:64-77; docker-compose.prod.yml:148-168; infra/terraform/environments/production/nats.tf (command line); packages/nats-client/src/index.ts:50-160; .env.example:157-165
- note: All three deployments run nats:2.11-alpine with command ['--jetstream','--store_dir','/data','-m','8222'] — no server-side auth, accounts, users, or permissions anywhere (no nats .conf in repo; only 127.0.0.1 port binding / ECS security group). Client-side plumbing exists (NATS_CREDS_PATH/NATS_NKEY_SEED/TLS env + production fail-closed boot check), but server-side accounts/users with subscribe-only permissions are net-new infrastructure, not a flag flip. Referenced doc NATS-AUTH-REQUIREMENTS.md does not exist.

## [CONFIRMED] OrderProjection.version / OrderEventLog exist in Prisma domain schema
- evidence: packages/domain/prisma/schema.prisma:349-387 (OrderProjection, version at :368), :421-435 (OrderEventLog)
- note: OrderProjection.version Int @default(1) commented 'optimistic concurrency'; OrderEventLog is append-only with unique idempotencyKey and (orderId,createdAt)/(orderId,eventType)/(eventType,timestamp) indexes. Both in @@schema('ibx_domain'). OrderStatusHistory:391-409 also records projection version after each transition — additional barrier substrate.

## extraFindings
- ibx api chat handles a 'tool_start' SSE event type, but routes/chat.ts only ever emits text_delta/done/error (Streaming Option A: one assembled text_delta + terminal done) — turn completion IS detectable as the 'done' terminal event, matching the plan's ChatClient turn-completion definition.
- Guest-session reuse via `ibx api chat --session` is functionally broken today: the route 403s a second guest POST without x-session-secret (secret TTL 1h), and the SSE GET likewise requires the secret once minted. The plan's 'session reuse verified' wording overstates what works end-to-end.
- docs/adjudicate-migration/remediation/NATS-AUTH-REQUIREMENTS.md is referenced by .env.example:160 and the nats-client fail-closed error message but is absent from the repo — another dangling-doc hygiene item like those in plan section 5.
- nats-client production fail-closed check (NEW-P0-X3) means prod boot already demands NATS creds-or-TLS env vars, yet the deployed servers cannot validate credentials (no server auth configured) — credentials are currently decorative client-side.
- Customer JWT crypto layer is registered with verify.allowedAud:'token' (server.ts:74); minted test tokens should include aud:'token' (middleware treats missing aud as legacy-accept, but the fast-jwt layer is configured with allowedAud).
- checkout-confirmation-store deliberately omits the admin store's two-person rule; ownership on confirm = (request.customerId ?? cartId) must equal parked customerId, plus verifyCartOwnership defense-in-depth (cart.ts:1183-1200).
- WhatsAppChannel is only registered when TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM are all set (claustrum-bootstrap.ts:1210-1230); WebChannel requires WEB_GATEWAY_SIGNING_KEY via requireSecret (fails closed if unset).
- Turn abort propagation (POST producer vs SSE consumer disconnect) is same-replica only via an in-process Map (chat.ts:129-140) — relevant to a test ChatClient that disconnects mid-turn.


# ===== VERIFIER: planner =====

## [CONFIRMED] payment.method.switch / payment.retry advertised by planner, no registered tool, tool_unresolved on EXECUTE
- evidence: packages/pack-payments/src/capabilities.ts:84-92; apps/api/src/tools/register-ibatexas-tool-packs.ts:361-375,411-417; apps/api/src/claustrum-bootstrap.ts:127,732; node_modules @claustrum/core dist/execution/dispatch.js:66,97 (tool_unresolved)
- note: paymentsCapabilityPlanner allowedIntents = [payment.pix.regenerate, payment.method.switch, payment.retry]; roster registers only payment.pix.regenerate. Registrar's own NOTE + TODO(WS4) state dispatchDecision would tool_unresolved on EXECUTE. paymentsCapabilityPlanner is composed into the live planner via IBATEXAS_CAPABILITY_PLANNERS.

## [CONFIRMED] toolRosterDrift does NOT already diff planner-advertised capabilities vs registered tools
- evidence: apps/api/src/tools/register-ibatexas-tool-packs.ts:423-445 (function), 408-417 (comment); invoked at boot claustrum-bootstrap.ts:1177-1178
- note: It checks only (1) capability === intentKind per registered tool and (2) intentKind ∈ caller-supplied pack intent union (registered ⊆ pack-owned). Comment explicitly: 'deliberately does NOT assert the reverse (pack-owned ⊆ registered)'. Phase 0 extension is genuinely missing.

## [CONFIRMED] Stale INERT comments in register-ibatexas-tool-packs.ts AND ibatexas-planner.ts contradict live wiring
- evidence: register-ibatexas-tool-packs.ts:32-38; ibatexas-planner.ts:43; contradicted by apps/api/src/index.ts:93 (await bootstrapClaustrum()), claustrum-bootstrap.ts:1177 (registerIbatexasToolPacks), 1252 (planner: createIbatexasPlanner inside createConductor)
- note: Tool-pack file says 'INERT — registerIbatexasToolPacks() has no caller in the live graph (bootstrapClaustrum is not invoked at server start)'; planner file says 'INERT until wired into createConductor'. Both are wired live today. claustrum-bootstrap.ts itself has INERT-phrasing at lines 42/120/1094 but those are conditional ('until bootstrapClaustrum() is called') and not false.

## [CONFIRMED] 17 LLM-callable mutating tools registered
- evidence: register-ibatexas-tool-packs.ts:224-376 (IBATEXAS_TOOLS); grep count of makeTool/makeReservationTool = 17
- note: 10 pack-orders + 4 pack-reservations + 2 pack-customer-onboarding + 1 pack-payments = 17. File's own comment (line 221) also states 17.

## [PARTIAL] ibx CLI has 31 top-level command groups (CLAUDE.md historically said 24)
- evidence: packages/cli/src/index.ts:345-370 (24 groupedCommands), 380-383 (6 root registrations: bootstrap, db, env, git, intelligence, tunnel); CLAUDE.md:10
- note: Actual count = 30 top-level commands (24 grouped + 6 root), not 31 — unless the 'intel' alias of 'intelligence' (intelligence.ts:11) is counted separately. kernel, scenario, matrix, simulate are all present. CLAUDE.md still says '(24 commands)' — confirmed.

## [PARTIAL] ibx kernel replay exists; gap analysis vs policy-diff CI gate
- evidence: packages/cli/src/commands/kernel.ts:177-346 (runReplay), 360-456 (reAdjudicateRecords), 86-93 (FIRST_PARTY_PACK_SPECS), 1312-1330 (registration)
- note: Exists and is close: reads intent_audit via readAuditWindow (--since default 24h, --intent-kind, --limit 1000, --dry-run), re-adjudicates each record via adjudicate(envelope, {}, pack.policy) using packs loaded from current checkout (PR policy for workspace packs), classifies drift DECISION_KIND/BASIS/PAYLOAD(REWRITE) per-kind. Missing for CI gate: NO non-zero exit on drift (exitCode 1 only on errors), no --json/machine output, adjudicates against EMPTY state (no historical SystemState rehydration — documented 'no-state-context drift'), gated on IBX_AUDIT_POSTGRES_ENABLED (prints stub, exit 0 when false), needs live DATABASE_URL; @adjudicate/pack-payments-pix is npm-pinned so PR edits there wouldn't be reflected.

## [PARTIAL] 294 vitest test files repo-wide
- evidence: find excluding node_modules: 298 *.test.ts/.tsx files (none in dist), plus 3 Playwright *.spec.ts in tests/e2e = 301 total; breakdown: apps/api 144, packages/tools 59, packages/cli 23, apps/web 22, packages/domain 16, packages/types 7, others 27
- note: Current vitest count is 298 (.test.* pattern), not 294 — count has drifted slightly upward; order-of-magnitude claim holds.

## [CONFIRMED] packages/domain and packages/types lack a test script (orphaned from turbo/CI)
- evidence: packages/domain/package.json (scripts: build/lint/db:* only; vitest in devDeps; 16 test files); packages/types/package.json (scripts: build/lint only; no vitest devDep; 7 test files); root package.json:9 'test': 'turbo test'; .github/workflows/ci.yml:30 'pnpm test -- -- --coverage'
- note: Neither has a 'test' script, so 'turbo test' / CI never runs their 23 combined test files. types doesn't even have vitest as a devDependency.

## [CONFIRMED] check-bypass.sh step 3 still targets deleted @ibatexas/llm-provider
- evidence: scripts/check-bypass.sh:62-67; packages/ listing (no llm-provider); .github/workflows/ci.yml:37 runs the script; live test: pnpm --filter @ibatexas/llm-provider exec → 'No projects matched the filters', exit 0
- note: Third vitest invocation filters @ibatexas/llm-provider, which no longer exists in the workspace. pnpm exits 0 on no-match, so despite set -euo pipefail the step passes silently — that leg of the gate is dead, matching the plan's wording.

## [CONFIRMED] scenario YAML schema at scenario-schema.ts (zod); ibx journey could reuse runPipeline/StepRegistry; engine structurally data-state-only
- evidence: packages/cli/src/lib/scenario-schema.ts:1-81 (zod ScenarioFileSchema); scenario-engine.ts:10-11 (imports runPipeline, StepRegistry), 614-623 (fixed phase order), 415-458 (verify dispatcher); lib/pipeline.ts:9-14 (generic PipelineTask); lib/steps.ts:1-3
- note: Schema is zod, confirmed. runPipeline is fully generic ({name,label,run,dependsOn}, --from/--skip) and directly reusable; StepRegistry is a closed map of 9 data-state steps (seeds/reindex/intel), shared with matrix + test commands per its header. Structural data-state assumptions: closed StepNameSchema enum, hardcoded phase order cleanup→setup→simulate→tags→rebuilds→verify, no sequential-acts/conversation concept, verify keys hardcoded to Prisma counts/Redis/Typesense plus a GET-only 'api:' check, cleanup mutates DB directly via Prisma. A journey engine reuses runPipeline/lock/events but needs its own schema + step registry; nothing supports HTTP/chat acts as first-class steps today.

## extraFindings
- Repo HEAD verified at commit 01d2d0a91a1057d8c9689bc123a3ae99aa6f69be.
- pnpm --filter <missing-package> exec exits 0 with 'No projects matched the filters' — empirically verified, so check-bypass.sh step 3 cannot fail; it is silently dead rather than erroring.
- tests/e2e/fixtures directory exists and is empty, matching the plan's Phase-0 hygiene note (verified via ls).
- kernel replay's pack index (FIRST_PARTY_PACK_SPECS, kernel.ts:86-93) covers 6 packs including @adjudicate/pack-payments-pix — an npm-pinned dependency, so a PR editing that pack's policy is only reflected after a version bump; the 5 workspace @ibatexas/pack-* packs do reflect PR code.
- ibx kernel replay also has a --dry-run mode that lists records without re-adjudicating, and the IBX_AUDIT_POSTGRES_ENABLED=false stub exits 0 — a CI gate built on the current command would silently green when the flag is unset.
- CLI 'intelligence' command carries alias 'intel' (intelligence.ts:11) — the only plausible way to reach the plan's count of 31 top-level commands; distinct registrations total 30.
- kernel.ts replay drift report prints human-readable chalk output only; 'kernel status' has --json but 'kernel replay' does not.
- The 3 non-vitest spec files are Playwright: tests/e2e/{api-golden-path,smoke,web-golden-path}.spec.ts.


# ===== VERIFIER: adjudicate =====

## [CONFIRMED] IntentActor.principal is closed union "llm" | "user" | "system"
- evidence: packages/core/src/envelope.ts:37-39; docs/specs/intent-envelope-v2.schema.json:47-51 (enum ["llm","user","system"]); envelope.ts:212-214 (isIntentEnvelope enforces the union at runtime)
- note: Exact wording: `readonly principal: "llm" | "user" | "system"`. Schema marks it a closed enum.

## [CONFIRMED] actor.sessionId is free-form string
- evidence: packages/core/src/envelope.ts:39; intent-envelope-v2.schema.json:52-55 (type string, minLength 1)
- note: Only constraint is non-empty string in the JSON schema; TS type is plain `string`. No format/pattern, so "agent:<id>@<ver>:..." encoding is legal.

## [CONFIRMED] actor (incl. sessionId) is inside the intentHash pre-image {version, kind, payload, nonce, actor, taint}
- evidence: packages/core/src/envelope.ts:106-122 (intentHashInput), 130-154 (buildEnvelope), 165-167 (deriveIntentHash); schema.json:64 (intentHash description names the same subset); envelope.ts:158-167 kernel verifies hash, refuses schema:intent_hash_mismatch
- note: Pre-image exactly matches the claim; createdAt is the only excluded descriptive field. Kernel re-derives and refuses forged hashes, so sessionId-encoded agent identity is tamper-evident as the plan asserts.

## [PARTIAL] Reserved 'attestation' seam exists for signed agent identity
- evidence: packages/core/src/envelope.ts:40-51 (IntentActor.attestation?: {keyId, sig}, doc: 'Reserved seam for v0.2 actor attestation', future Pack.verifyActorAttestation policy slot); kernel/identity.ts:29,37 (separate kernel-identity attestation seam); intent-envelope-v2.schema.json:41-57
- note: Not invented — the seam is real, but it lives on IntentActor (actor.attestation), not as a top-level envelope field. Caveat: the published JSON schema's actor has additionalProperties:false with ONLY principal+sessionId, so a wire envelope carrying attestation fails the v2 schema today; TS type and schema diverge. If present, attestation enters the intentHash (actor is in pre-image); absent it is canonical-JSON-dropped.

## [CONFIRMED] AuditRecord v5 metadata is excluded from auditHash
- evidence: packages/core/src/audit.ts:148-162 (field doc 'EXCLUDED from the auditHash pre-image'), 234-243 (buildAuditRecord computes auditHash over baseRecord before metadata attached), 326 (verifyAuditRecord strips auditHash, signature, metadata), 253-258 (attachAuditMetadata leaves hashes untouched)
- note: Excluded so post-hoc/async metadata attachment (e.g. hallucination_score) does not invalidate tamper-evidence. Cross-version caveat documented: v5 records WITH metadata must be verified by core >= v5.

## [REFUTED] IntentEnvelope itself has a metadata field
- evidence: packages/core/src/envelope.ts:175-184 (EXPECTED_ENVELOPE_KEYS = exactly 8 fields, no metadata; isIntentEnvelope rejects extra keys); intent-envelope-v2.schema.json:7-17 (additionalProperties:false, 8 required props)
- note: IntentEnvelope has NO metadata field at all; an envelope carrying one is rejected by isIntentEnvelope and the schema. Plan section 3 item 8's phrasing 'envelope metadata is outside the intentHash' is wrong in mechanism — there is no such field; only AuditRecord (v5) has metadata, and the only non-hashed envelope field is createdAt.

## [PARTIAL] createRedisLedger with checkAndRecord + REPLAY_SUPPRESSED exists in @adjudicate/audit
- evidence: packages/audit/src/index.ts:9-14 (exports createRedisLedger, createMemoryLedger); packages/audit/src/ledger-redis.ts:60; packages/core/src/ledger.ts:48-87 (Ledger interface: checkLedger, recordExecution, optional release); packages/core/src/basis-codes.ts:44 (REPLAY_SUPPRESSED: "replay_suppressed"); kernel/adjudicate-and-audit.ts:216-219
- note: Export name `createRedisLedger` confirmed (also `createMemoryLedger`). REPLAY_SUPPRESSED confirmed (ledger hit short-circuits to REPLAY_SUPPRESSED REFUSE; SET-NX 'exists' flips racing EXECUTE). But there is NO `checkAndRecord` method — the interface is `checkLedger(intentHash)` + `recordExecution(entry)` returning "acquired"|"exists".

## [PARTIAL] @adjudicate/approval-engine exports createApprovalEngine, ApprovalRegistry (memory + Redis), pluggable webhook/Slack/email channels
- evidence: packages/approval-engine/src/index.ts (exports createApprovalEngine, ApprovalRegistry type, createInMemoryApprovalRegistry, createRedisApprovalRegistry, createConsoleLogChannel, createWebhookChannel, ApprovalChannel); channel.ts:16; engine.ts:41-156
- note: createApprovalEngine, memory + Redis registries confirmed (exact names: createInMemoryApprovalRegistry, createRedisApprovalRegistry). Channels ARE pluggable via the ApprovalChannel interface, but shipped implementations are only console-log and webhook; Slack/Teams/email appear only in a doc comment ('Pluggable delivery channel (Slack/Teams/email/webhook)') — no Slack or email channel implementation exists.

## [CONFIRMED] Approval engine resolve integrates replay-safely with adapter-core confirm()
- evidence: packages/approval-engine/src/engine.ts:8 ('whose confirm() owns the replay-safe resume'), 108-147 (resolve → agent.confirm); packages/adapter-core/src/loop.ts:566-654 (confirm(): single-use confirmationStore.take, timing-safe parked-hash verify, adjudicateAndAudit with ledger + confirmationReceipt)
- note: resolve() fetches state/context fresh at resolve time (never stored, never in intentHash), calls agent.confirm() which re-adjudicates through adjudicateAndAudit with the configured ledger — so dedup/REPLAY_SUPPRESSED applies on resume.

## [CONFIRMED] Operator console (apps/console) has an Approvals page/route
- evidence: apps/console/src/app/approvals/page.tsx (route /approvals, ADR-122 + ADR-136); components/approvals/{ApprovalsArea,ApprovalsPanel,ApprovalHistoryView,ApprovalChainView}.tsx; hooks/useApprovals.ts
- note: Page renders pending queue + decision history + audit chain (request → resolved → resumed). Important caveat stated in the page itself: in the reference console resolving is DISPLAY-ONLY — token take, hash verify, re-adjudication and resume happen in the adopter's adapter process via createApprovalEngine.resolve → agent.confirm. So it can surface agent confirmation requests, but the resolve glue is adopter-side, matching the plan's 'glue must be budgeted' framing.

## [CONFIRMED] Resumed envelopes (DEFER resume / confirmation resolve) carry supersedes {predecessorIntentHash, ...} on the AuditRecord
- evidence: packages/core/src/audit.ts:53-70 (Supersession {predecessorIntentHash, predecessorAt, reason, token?}; reasons incl. confirmation_resolved, defer_resumed); adapter-core/src/loop.ts:509-541 (resume passes supersedes with reason defer_resumed); kernel/adjudicate-and-audit.ts:424-455 (auto-derives confirmation_resolved supersedes from confirmationReceipt, carries token)
- note: Confirmed for both paths. Extra detail: on DEFER resume the new envelope is rebuilt with actor {principal:"system", original sessionId}, taint TRUSTED, nonce = predecessor intentHash (loop.ts:510-520) — relevant to the plan's lineage spec.

## [REFUTED] ConfirmationReceipt records the approving principal
- evidence: packages/core/src/kernel/adjudicate-and-audit.ts:162-194 (confirmationReceipt shape: intentHash, at, originalAt?, token? — no principal/approver field); adapter-core/src/loop.ts:643-652; approval-engine/src/registry.ts:22-23 (ApprovalRequest.resolvedBy?: {id, displayName?})
- note: The kernel-level confirmationReceipt has NO approving-principal field; only the opaque single-use token reaches the audit trail (Supersession.token). The approving principal IS recorded, but only in the approval-engine's ApprovalRequest projection (resolvedBy, set via resolve({by})) — a registry projection outside the tamper-evident AuditRecord. The plan's 'ConfirmationReceipt records the approving staff principal' describes a spec-to-be-written, not current behavior.

## [CONFIRMED] adjudicate simulate --scenarios fixture contract {intent, state, expected} in docs/guides/testing-your-policy.md
- evidence: docs/guides/testing-your-policy.md:18 (table row 'adjudicate simulate --scenarios'), :26-48 (anatomy: intent/state/expected JSONC example), :113 (script: adjudicate simulate --pack ./dist/index.js --scenarios ./scenarios)
- note: Three fields exactly as claimed. `intent` is the user-supplied envelope portion (CLI runs buildEnvelope, fills version + intentHash — hashes never hand-authored); `state` is plain JSON with optional Pack.rehydrateState; `expected` is optional (absent = advisory). Reference: 6 scenarios in packages/pack-payments-pix/scenarios, one per Decision outcome.

## [CONFIRMED] simulate --scenarios exit-code convention
- evidence: docs/guides/testing-your-policy.md:215-217
- note: 0 = all scenarios match (or advisory); 1 = one or more failed to load (malformed JSON/schema error), no mismatches; 2 = one or more decision.kind !== expected.kind — 'Mismatch wins over error'.

## extraFindings
- Schema/type divergence on attestation: packages/core/src/envelope.ts declares IntentActor.attestation?: {keyId, sig} but docs/specs/intent-envelope-v2.schema.json actor block is additionalProperties:false with only principal+sessionId — a wire envelope carrying attestation validates in TS (isIntentEnvelope does not inspect actor key set) but fails the published JSON schema. Any plan relying on the seam should note the schema needs an additive update first.
- If attestation IS supplied it alters the intentHash (actor is in the hash pre-image); only its absence is canonical-JSON-dropped (envelope.ts:41-47 comment). So signed agent identity via attestation would also be tamper-evident, like sessionId.
- DEFER resume rebuilds the envelope with actor.principal flipped to "system" and taint elevated to TRUSTED while preserving the original actor.sessionId (adapter-core/src/loop.ts:510-520, AuthReviewer-003 comment); nonce = predecessor intentHash so retried resumes hit ledger dedup. Relevant to the plan's claim that taint stays UNTRUSTED through agent flows — true for the agent's original envelope, but the resumed successor envelope is system/TRUSTED.
- Confirmation resolve (adapter-core confirm()) re-adjudicates the SAME parked envelope (same intentHash); the kernel only substitutes EXECUTE for REQUEST_CONFIRMATION when the receipt matches — REFUSE/REWRITE/ESCALATE/DEFER from a state change between request and confirmation are returned unchanged (adjudicate-and-audit.ts:144-161).
- Ledger.release() is optional (core/src/ledger.ts:76-87): best-effort DEL when post-EXECUTE audit emission fails, preventing TTL-long orphaned suppression; createRedisLedger only exposes it when the injected client has del (ledger-redis.ts:64-79). Default Redis ledger TTL is 14 days.
- Supersession reasons are five: confirmation_resolved, defer_resumed, rewrite_executed, replay, lgpd_scrub (audit.ts:53-58) — the plan never mentions lgpd_scrub.
- REPLAY_SUPPRESSED is a basis code (basis-codes.ts:44, value "replay_suppressed") attached to a REFUSE Decision — not a seventh Decision kind; Decision union remains EXECUTE/REFUSE/ESCALATE/REQUEST_CONFIRMATION/DEFER/REWRITE (decision.ts:28-48).
- AuditRecord is at version 5; supersedes arrived in v3, auditHash/signature in v4, metadata in v5 (audit.ts:31-32, header comment). verifyAuditRecord also independently re-derives envelope.intentHash and reports envelope_intent_mismatch distinct from tampered (audit.ts:294-336).
- ApprovalEngine.resolve marks the registry entry 'expired' if the underlying confirm() rejects the token (single-use already taken / tampered blob), then throws CONFIRM_REJECTED (engine.ts:124-129) — the projection cannot silently desync from the single-use ConfirmationStore.


# ===== VERIFIER: claustrum =====

## [CONFIRMED] ChannelKind is closed union "whatsapp" | "web" at packages/core/src/ports/channel.ts:23; widening needed for SystemChannel
- evidence: packages/core/src/ports/channel.ts:23 (`export type ChannelKind = "whatsapp" | "web";`); core version 0.2.0 in packages/core/package.json
- note: Exact line matches. Widening is genuinely a one-line core edit; .changeset dir exists for the version bump.

## [REFUTED] ChannelKind is switched on exhaustively somewhere (ripple risk)
- evidence: grep across packages/*/src; capsule.ts:50 (ChannelMap = Partial<Readonly<Record<ChannelKind, ChannelDriver>>>); conductor.ts:101-107; cli/src/commands/replay.ts:43,66-69
- note: No switch/exhaustive narrowing on ChannelKind anywhere. ChannelMap is Partial, so a new kind forces no new entries. Only ripple: cli replay.ts:43 declares a parallel inline union `"web" | "whatsapp"` (type-only; runtime check is just `typeof parsed.channel !== "string"`, so no runtime break). Conformance checks hardcode "web" but are unaffected.

## [CONFIRMED] InMemoryModelProvider is a content-blind sequential cursor stub
- evidence: packages/core/src/test-doubles/in-memory-model-provider.ts:48-56 (complete), 58-99 (stream)
- note: complete() pushes req to `seen` then returns completions[completionCursor % length] — request content never inspected. stream() slices the same script. Cursor wraps modulo, so scripts cycle rather than exhaust. embed() is hash-derived deterministic.

## [CONFIRMED] EXECUTE-triggers-exactly-one-tool invariant exists and is enforced
- evidence: handle-turn.ts:17 (header invariant); test/properties/execute-one-tool.test.ts (fast-check, 200 iterations); conformance/src/checks/execute-triggers-one-tool.ts (CC-002); CLAUDE.md Hard Rule #7; dispatch at execution/dispatch.ts:109-146,314-351
- note: CC-002 wraps every registered tool's .execute with a counter, runs 100 sampled handleTurn turns: EXECUTE/REWRITE must show delta==1, all other decisions delta==0. Property test asserts the same with an instrumented tool over handleTurn.

## [CONFIRMED] Stage-0 option: sandbox/no-op tool executor in ToolRegistry for the agent tenant
- evidence: execution/dispatch.ts:124-125,328-332 (resolveTool→tool.execute, one invocation regardless of effect); tools/registry.ts RegistryOptions.chooseImplementation + header comment ("Two tools with the same capability are allowed iff they discriminate by tenant")
- note: Compatible with all invariants: exactly one tool invocation still occurs (CC-002 counts the no-op's execute), dispatch returns kind "executed" with the sandbox toolId visible in TurnResult.acted (journalable). Registry natively supports tenant-aware resolution. Falsifies: audit/telemetry/memory all record EXECUTE as if it happened (see outcome claim below).

## [PARTIAL] Stage-0 option: guard downgrading EXECUTE
- evidence: dispatch.ts:213-241 (REQUEST_CONFIRMATION parks envelope), 243-273 (DEFER parks deferred), handle-turn.ts:345-352 (pickDueDeferred auto-resumes due deferrals via capsule.resume)
- note: Invariant-compatible (non-EXECUTE ⇒ 0 invocations per CC-002) but it is Stage-1 semantics, not "true shadow": the audit records the downgraded decision, losing the would-be EXECUTE unless encoded in metadata. Downgrade→REQUEST_CONFIRMATION parks envelopes nothing resumes (plan itself flags this); downgrade→DEFER is dangerous — deferred envelopes auto-resume after deferUntil and can EXECUTE for real.

## [REFUTED] Stage-0 option: host-level suppression after dispatchDecision
- evidence: handle-turn.ts:139 (dispatchDecision called inside handleTurn, step 5, before host sees TurnResult); CLAUDE.md Hard Rule #3 (loop is invariant)
- note: Too late: by the time the host (trigger bridge) gets TurnResult the tool already executed. There is no host seam between SUBMIT and ACT. Host-level suppression can only suppress render()/notification (the SystemChannel's render is host-owned), never the mutation. Suppressing dispatch would require forking handleTurn — violates Hard Rule #3 and escapes CC-002's instrumented path.

## [REFUTED] Downstream assumes EXECUTE ⇒ outcome recorded (getOutcomes/outcome recording)
- evidence: ports/adjudicator.ts:44-66,189 (OutcomeFilter/OutcomeRow/getOutcomes — read API only); test-doubles/stub-adjudicator.ts:152 returns []; grep shows zero production callers of getOutcomes in claustrum src
- note: Claustrum has no outcome writer and no consumer of getOutcomes outside test mocks — nothing structurally assumes EXECUTE ⇒ OutcomeRow. OutcomeRow even has "withdrawn" status usable for shadow runs. Real falsification risk is elsewhere: MemoryPort recall routes through replayEnvelopesByCustomerId (CC-005), so sandboxed EXECUTE audit rows surface in the agent's own memory as actions that "happened"; telemetry emitTurn records decisionKind EXECUTE.

## [CONFIRMED] Conductor.openCapsule accepts OpenCapsuleInput.actor override permitting principal "system"
- evidence: conductor.ts:74-80 (OpenCapsuleInput.actor?: Actor), 151-156 (default actor principal "user" only when omitted); tools/types.ts:70 (Actor.principal: "llm" | "user" | "system")
- note: Confirmed. The override is unvalidated — any Actor passes through to the Capsule. Note this is claustrum's runtime Actor; the kernel-side IntentActor union is in adjudicate (not checked here). Dispatch's internal noop envelope already uses principal "system" (dispatch.ts:392).

## [CONFIRMED] SessionLock per-session mutual exclusion exists; InMemory single-replica; distributed impl exists?
- evidence: ports/session-lock.ts:27-39; conductor.ts:95,117-130 (acquire in openCapsule, fail-closed on timeout, release in closeCapsule); test-doubles/in-memory-session-lock.ts (documented single-process FIFO mutex); memory-postgres/src/advisory-session-lock.ts (PostgresAdvisorySessionLock, pg_try_advisory_lock with connection pinning)
- note: All three sub-claims hold. A distributed implementation EXISTS: PostgresAdvisorySessionLock in @claustrum/memory-postgres. No Redis SessionLock anywhere. Conductor defaults to InMemorySessionLock unless injected (conductor.ts:95). Whether ibatexas injects the Postgres lock is outside this repo. CRITICAL ripple: see extraFindings — the lock key ignores sessionKey.

## [PARTIAL] handleTurn is a "7-step loop"
- evidence: handle-turn.ts:1-20 (header: "the 7-step cognitive loop", steps 1-7); stages 2b (line 85, resume), 3b (line 104, resolve — only when capsule.resolver wired), 5b (line 141, resume cleanup), 6b (line 162, output firewall — only when tenant flag + adjudicateOutput); CLAUDE.md Hard Rule #3 lists 9 stages with [resolve] and [output-firewall] bracketed
- note: "7-step" is the code's own canonical name (7 numbered stages: perceive/understand/plan/submit/act/synthesize/observe). Counting lettered sub-stages there are 11 markers: +2b resume, +3b resolve (optional), +5b resume-cleanup, +6b output-firewall (optional). Plan's usage matches the repo's self-description.

## [CONFIRMED] matchToParked on ChannelDriver: port contract exists; null return means no chat-confirm resume
- evidence: ports/channel.ts:128-137 (ParkedMatch), 186-189 (matchToParked signature; doc: null = "fresh utterance; run the normal cognitive loop"); handle-turn.ts:312 (`driver?.matchToParked(inbound, session) ?? null`); channel-web/src/web-channel.ts:66-70 (returns null unconditionally); channel-whatsapp/src/parked-match.ts:39-42 (real matcher)
- note: Confirmed: null ⇒ no parked-confirmation resume; WebChannel returns null by design (matches plan's product-gap #1). Caveat: resolveResume's trigger 2 (handle-turn.ts:345-352) still resumes DUE DEFERRED envelopes channel-agnostically even when matchToParked is null — "no chat-confirm resume" is precise; "no resume at all" would be wrong.

## extraFindings
- LOCK-KEY RIPPLE for Phase 3: conductor.ts:101-102,122 — the session lock key is `${input.channel}:${input.customerId}` and IGNORES OpenCapsuleInput.sessionKey (sessionKey only affects actor.sessionId and tenant resolution). The plan's 'entity-scoped sessionKey is mandatory (per-entity serialization via the existing session locks)' will NOT serialize as written: a trigger turn on a new 'system' channel locks `system:<cust>` while live chat locks `web:<cust>` — no mutual exclusion between trigger worker and live conversation for the same customer/entity. Requires either same (channel, customerId) keying or a conductor change to honor sessionKey in the lock key.
- dispatch.ts:115-123: an EXECUTE decision with an EMPTY plan dispatches as a `<noop>` 'executed' result with ZERO tool invocations — CC-002 would record that as a violation ('EXECUTE produced 0 tool invocations') if sampled. So a Stage-0 suppression approach that empties the plan pre-dispatch collides with CC-002; the sanctioned exception exists in dispatch but not in the conformance check.
- CC-002 treats REWRITE as one expected invocation (execute-triggers-one-tool.ts:111) — a sandbox tool for the agent tenant must also back the REWRITE path (dispatch.ts:148-189 resolves the rewritten envelope through the same registry).
- ToolRegistry resolveTool(capability, ctx) receives the full Capsule as ctx (dispatch.ts:161,329), and createToolRegistry accepts chooseImplementation/visibility hooks (tools/registry.ts) — per-tenant sandbox resolution is a first-class, already-supported seam, not a hack.
- Multi-envelope EXECUTE plans dispatch one invocation PER envelope ('executed_plan', dispatch.ts:124-146); the invariant is per-envelope, not per-turn, for adjudicatePlan turns. CC-002's expected-1 assertion implicitly assumes single-envelope plans.
- Conductor defaults to InMemorySessionLock when options.sessionLock is omitted (conductor.ts:95) with only a doc-comment warning (conductor.ts:62-68) — multi-replica safety is opt-in, not enforced.
- SystemChannel must implement matchToParked (required port method); returning null unconditionally is the documented pattern for channels without parked-reply semantics (channel.ts:182-184), so a trigger channel needs no parked-match logic — but then agent REQUEST_CONFIRMATION parks can only resume via the deferred-due path or an external resume bridge, consistent with the plan's Stage-1 approvals-glue prerequisite.
- closeCapsule re-loads and saves the session by (customerId, channel) while the lock is held (conductor.ts:244-261) — a trigger turn and a web turn for the same customer write to DIFFERENT session rows (channel is part of session identity, ports/session.ts:65), so cross-channel session state is not shared either.
- Actor.role union already includes "system" (tools/types.ts:62-67), and ToolDefinition has allowedChannels/allowedRoles fields (tools/types.ts:117-118) — a widened channel kind can be gated per-tool without new mechanism.
- InMemoryModelProvider's modulo-wrapping cursor means scripted-completion replays cycle silently if a conversation runs longer than the script — a turn-count mismatch produces wrong-but-plausible completions rather than an error (relevant to the plan's 'scripted-completion pipeline regression tests' rescope).
