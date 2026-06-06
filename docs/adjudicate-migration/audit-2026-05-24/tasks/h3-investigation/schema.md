# H3 Investigation — Schema Audit (7 Surfaces)

**Audit date:** 2026-05-24  
**Scope:** Prisma schema-level analysis of PII retention after `anonymizeCustomer` call  
**Surfaces examined:** 1–7 (Medusa surface #8 excluded per scope)  

---

## Surface 1 — OrderProjection.{customerEmail, customerName, customerPhone, shippingAddressJson}

### Field Shape (Prisma Schema)
```prisma
model OrderProjection {
  id                  String   @id  // Medusa order ID
  customerId          String?  @map("customer_id")
  customerEmail       String?  @map("customer_email")      // nullable
  customerName        String?  @map("customer_name")       // nullable
  customerPhone       String?  @map("customer_phone")      // nullable
  shippingAddressJson Json?    @map("shipping_address_json")  // nullable, JSON object
  // ... other fields
  
  customer            Customer?  @relation(fields: [customerId], references: [id], onDelete: SetNull)
  
  @@index([customerId])
  @@map("order_projections")
  @@schema("ibx_domain")
}
```

### Writers
1. **`packages/domain/src/services/order-command.service.ts:executeCreate()`** (Medusa → OrderProjection NATS-driven)
   - Via `toOrderProjectionData()` mapper at `packages/domain/src/mappers/medusa-order.mapper.ts:97`
   - Source: Medusa admin API `order.customer.{first_name, last_name, email, phone}` + `order.shipping_address`
   - Caller context: `order.placed` NATS subscriber → `createFromEnvelope()` enveloped
   - Carries PII: YES (all 4 fields stuffed from Medusa order payload)
   - Frequency: once per order creation; high volume (100s–1000s daily)

2. **`packages/domain/src/mappers/medusa-order.mapper.ts:toOrderProjectionData()`**
   - Transforms Medusa JSON shape to Prisma input
   - `customerEmail = order.email ?? order.customer?.email ?? null`
   - `customerName = buildCustomerName({first_name, last_name})`
   - `customerPhone = order.customer?.phone ?? null`
   - `shippingAddressJson = order.shipping_address ?? null`

### Readers
1. **`apps/api/src/routes/cart.ts`** — order detail/summary endpoints
   - Reads via `orderProjection.findUnique()` / `orderProjection.findMany()`
   - Returns full `OrderProjection` shape to LLM / web client
   - Surfaces PII to: LLM (cart context), customer API (order history)
   - Frequency: every cart detail load, order history browse

2. **`apps/api/src/routes/admin/orders.ts`** — admin order endpoints
   - Admin GET `/orders/{orderId}` returns full projection including email/name/phone
   - Surfaces PII to: authenticated admin users
   - Frequency: admin order lookups (100s/day during operations)

3. **`packages/domain/src/services/order-query.service.ts`** — query layer
   - Exports `findOrderById()`, `listOrdersByCustomerId()` etc.
   - All selection queries include the customer fields by default

### FK to Customer.id & onDelete Behavior
- **FK present:** YES — `customerId` → `Customer.id`
- **onDelete:** `SetNull` — when customer is deleted, `customerId` becomes null but the order projection row survives with null FK.
- **Implication:** the email/name/phone fields ARE NOT cascade-protected. They linger independently.

### Recommended Strategy
**`full-replace-json` for `shippingAddressJson`; `null-out` for scalar fields**

- `customerEmail` → NULL
- `customerName` → NULL
- `customerPhone` → NULL
- `shippingAddressJson` → `JSON_BUILD_OBJECT('anonymized', true)` or plain JSON null

**Rationale:** These fields are copies of Medusa source data, not authoritative. Clearing them loses no structured metadata the rest of the system depends on. The JSON blob is opaque to application logic; replacing with a sentinel is simpler than key-scrubbing.

---

## Surface 2 — ConversationMessage.content

### Field Shape (Prisma Schema)
```prisma
model ConversationMessage {
  id             String   @id @default(cuid())
  conversationId String   @map("conversation_id")
  role           MessageRole  // 'user' | 'assistant' | 'system'
  content        String       // ← unbounded; carries free-form pt-BR customer text
  metadata       Json?        // optional
  sentAt         DateTime @default(now()) @map("sent_at")
  createdAt      DateTime @default(now()) @map("created_at")

  conversation   Conversation  @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  
  @@index([conversationId, sentAt])
  @@map("conversation_messages")
  @@schema("ibx_domain")
}
```

### Writers
1. **`apps/api/src/subscribers/conversation-archiver.ts:appendMessageFromEnvelope()`**
   - NATS subscriber: listens to `conversation.message.appended` (from Redis session store)
   - Reads raw `msg.content` from the payload; persists via `appendMessage()`
   - Caller context: LLM ↔ session-store CDC; SYSTEM taint envelope
   - Carries PII: YES (customer can write name, phone, address, medical info, etc. in free-form messages)
   - Frequency: every conversation turn (10s–100s/day per active user)

### Readers
1. **`packages/domain/src/services/conversation.service.ts:getTranscript()`**
   - Retrieves all messages for a conversation ordered by sentAt
   - Returns `{role, content, sentAt, metadata}[]`
   - Surfaces PII to: internal audit / compliance review / ops troubleshooting
   - Frequency: manual ops lookup, compliance audits

2. **Tools / dashboards** (implicit via conversation.service)
   - Any tool calling `getTranscript()` or selecting ConversationMessage directly

### FK to Customer.id & onDelete Behavior
- **FK path:** `ConversationMessage.conversationId` → `Conversation.id` → `Conversation.customerId` → `Customer.id`
- **Direct FK to Customer:** NO — but indirect via Conversation.
- **Cascade chain:** If Conversation is deleted, ConversationMessage cascades. If Customer is deleted, Conversation.customerId becomes null (SetNull) but messages survive.

### Recommended Strategy
**`placeholder` — set `content = "[anonymized]"` for all messages in the conversation**

**Rationale:** Free-form text cannot be safely parsed for PII (customer may embed phone as "call me at 11987654321" or addresses as narrative). Simple replacement is safest. Messages are primarily for audit; the speech content itself is not business-critical after anonymization.

---

## Surface 3 — Conversation.customerId

### Field Shape (Prisma Schema)
```prisma
model Conversation {
  id         String       @id @default(cuid())
  sessionId  String       @unique @map("session_id")
  customerId String?      @map("customer_id")  // ← nullable
  channel    ConversationChannel
  startedAt  DateTime @default(now()) @map("started_at")
  endedAt    DateTime? @map("ended_at")
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")

  customer   Customer?  @relation(fields: [customerId], references: [id], onDelete: SetNull)
  messages   ConversationMessage[]
  
  @@index([customerId])
  @@map("conversations")
  @@schema("ibx_domain")
}
```

### Writers
1. **`packages/domain/src/services/conversation.service.ts:findOrCreateBySessionId()`**
   - Creates or retrieves a Conversation; writes `customerId` at creation
   - Caller context: LLM session handshake; SYSTEM taint envelope
   - Carries PII linkage: YES (the FK itself identifies which customer)
   - Frequency: once per conversation session (10s–100s/day)

2. **Retries on FK violation:** same service catches P2003 FK error and retries with `customerId: null`
   - Handles the case where customer was already deleted (LGPD race condition)

### Readers
1. **`packages/domain/src/services/conversation.service.ts:listActive()`**
   - Returns conversations with `customerId` included
   - Surfaces PII linkage to: ops dashboards, audit

2. **Conversation-archiver internals**
   - Uses `customerId` to link messages to a customer identity (for reconstruction/audit)

### FK to Customer.id & onDelete Behavior
- **FK present:** YES — `customerId` → `Customer.id`
- **onDelete:** `SetNull` — safe; schema allows null
- **Current status:** schema is READY for anonymization (nullable field)

### Recommended Strategy
**`null-out` — set `customerId = null` for all conversations where customerId matches the anonymized customer**

**Rationale:** The field is already nullable and has SetNull cascade defined. Nulling the FK breaks the linkage without orphaning messages. The conversation archive remains queryable by sessionId for audit purposes.

---

## Surface 4 — OrderStatusHistory.actorId

### Field Shape (Prisma Schema)
```prisma
model OrderStatusHistory {
  id              String                 @id @default(cuid())
  orderId         String                 @map("order_id")
  fromStatus      OrderFulfillmentStatus @map("from_status")
  toStatus        OrderFulfillmentStatus @map("to_status")
  actor           OrderActor  @default(system)  // enum: admin | system | system_backfill | customer
  actorId         String?     @map("actor_id")  // nullable; refs staff.id OR customer.id
  reason          String?
  version         Int
  backfillBatchId String?     @map("backfill_batch_id")
  createdAt       DateTime    @default(now()) @map("created_at")

  order           OrderProjection  @relation(fields: [orderId], references: [id], onDelete: Cascade)
  
  @@index([orderId, createdAt])
  @@map("order_status_history")
  @@schema("ibx_domain")
}
```

### Writers
1. **`packages/domain/src/services/order-command.service.ts:executeTransition()`** (status transition)
   - At line 332–342: `orderStatusHistory.create()` with `actor`, `actorId`
   - When actor = "customer", `actorId` = customer.id
   - Caller context: LLM tool call or admin API → enveloped via `transitionStatusFromEnvelope()`
   - Carries PII linkage: YES (when actor='customer', actorId is a customer ID)
   - Frequency: each order status change (10s–100s/day)

2. **`packages/domain/src/services/order-command.service.ts:executeCreate()`**
   - Initial status history row: actor='system', actorId=null
   - No customer linkage at creation

### Readers
1. **Order audit logs / admin dashboards**
   - Via `order-query.service.ts` or direct DB queries
   - Shows who triggered each transition
   - Surfaces actor identity to: authenticated admins

### FK to Customer.id & onDelete Behavior
- **FK to Customer:** NO — `actorId` is an untyped foreign key (can be staff.id OR customer.id)
- **No FK constraint in schema** — the column is nullable String, not a formal relation
- **Implication:** deleting the Customer row does NOT cascade; the reference just dangles

### Recommended Strategy
**`null-out` — set `actorId = null` for all OrderStatusHistory rows where `actor = 'customer'` AND `actorId` matches customerId**

**Rationale:** The actorId is only sensitive when it's a customer reference. Staff/system actions don't carry PII. Nulling customer actorIds breaks the linkage while preserving audit context (the `actor` enum + timestamp still document when a customer action happened, just not who). Appending to reason field (e.g., "customer action") is optional but preserves intent.

---

## Surface 5 — OrderEventLog.payload

### Field Shape (Prisma Schema)
```prisma
model OrderEventLog {
  id              String   @id @default(cuid())
  orderId         String   @map("order_id")
  eventType       String   @map("event_type")
  idempotencyKey  String   @unique @map("idempotency_key")
  payload         Json     // ← unbounded JSON blob
  timestamp       DateTime @map("timestamp")
  createdAt       DateTime @default(now()) @map("created_at")

  @@index([orderId, createdAt])
  @@index([orderId, eventType])
  @@map("order_event_log")
  @@schema("ibx_domain")
}
```

### Writers
1. **`packages/domain/src/services/order-event-log.service.ts:append()`**
   - Fire-and-forget upsert on `idempotencyKey`
   - Stores `payload: Record<string, unknown>` as JSON
   - Caller context: background jobs, subscribers (cart-intelligence, payment-lifecycle, etc.)
   - Carries PII: CONDITIONAL
     - If eventType involves customer state (e.g., `order.placed` with customer name), payload can include `{customerName, customerEmail, customerPhone}`
     - If eventType is system-only (e.g., `payment.method_changed`), payload is likely clean
   - Frequency: ~1–3 events per order (100s–1000s/day)

2. **Subscribers / jobs that call `append()`:**
   - `apps/api/src/subscribers/cart-intelligence.ts`
   - `apps/api/src/subscribers/payment-lifecycle.ts`
   - Others (implicit via event-log service)
   - Payload shape is caller-dependent and unvalidated

### Readers
1. **`packages/domain/src/services/order-event-log.service.ts:getByOrderId()` / `getByEventType()`**
   - Returns `{..., payload, timestamp}[]`
   - Surfaces PII to: ops debugging, compliance audits, replay/reconstruction

### FK to Customer.id & onDelete Behavior
- **FK:** NO — orderId is a reference to OrderProjection.id, not Customer.id
- **Indirect PII path:** if payload contains a serialized customer object, that's where PII hides

### Recommended Strategy
**`full-replace-json` — replace entire `payload` with `{anonymized: true}` for all rows matching an orderId that belonged to the anonymized customer**

**Rationale:** OrderEventLog is an immutable audit/replay layer. The structure is unspecified (each caller can serialize whatever). Nulling specific keys risks missing hidden PII (e.g., nested `order.customer.phone`). Wholesale replacement is safest and aligns with the immutability promise (the log asserts "something happened at timestamp T; the details are redacted"). Operators can reconstruct via orderId → OrderProjection → customer mapping if needed.

---

## Surface 6 — LoyaltyAccount

### Field Shape (Prisma Schema)
```prisma
model LoyaltyAccount {
  id          String   @id @default(cuid())
  customerId  String   @unique @map("customer_id")
  customer    Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)
  stamps      Int      @default(0)         // current punch count
  totalEarned Int      @default(0) @map("total_earned")  // lifetime
  redeemed    Int      @default(0)         // rewards redeemed
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@map("loyalty_accounts")
  @@schema("ibx_domain")
}
```

### Writers
1. **`packages/domain/src/services/loyalty.service.ts:getOrCreateAccount()`**
   - Upsert: creates a row if missing, noop on update
   - Caller context: order.placed subscriber via `addStampFromEnvelope()`
   - Carries PII: NO — only aggregate numeric counters
   - Frequency: once per customer (when first order placed); then incremental

2. **`packages/domain/src/services/loyalty.service.ts:addStamp()`**
   - Increments `stamps`, `totalEarned`, resets on reward (10 stamps)
   - No customer name/contact info in the row

### Readers
1. **`apps/api/src/routes/cart.ts`** or loyalty endpoints
   - Returns `{stamps, stampsNeeded, totalEarned, redeemed}` to customer
   - Surfaces no PII directly (only metrics)

### FK to Customer.id & onDelete Behavior
- **FK present:** YES — `customerId` → `Customer.id` @unique
- **onDelete:** `Cascade` — when customer is deleted, the LoyaltyAccount row is deleted too
- **Implication:** Cascading deletion already handles linkage removal

### Recommended Strategy
**`cascade-delete` — the CASCADE FK is already in place; no code change needed**

OR

**`delete-row` (if LGPD policy requires it) — explicitly delete the LoyaltyAccount row in `anonymizeCustomer` for belt-and-suspenders**

**Rationale:** The row contains no sensitive customer data (only counters). The customerId FK is the only linkage and it has CASCADE semantics defined. Explicit deletion in the anonymize function adds redundancy but is operationally cleaner for audit (shows the row was reviewed and actioned, not just incidentally deleted by cascade). Recommend explicit delete in the service for clarity.

---

## Surface 7 — Reservation.specialRequests

### Field Shape (Prisma Schema)
```prisma
model Reservation {
  id              String            @id @default(cuid())
  displayId       Int               @default(autoincrement()) @map("display_id")
  customerId      String            @map("customer_id")
  partySize       Int               @map("party_size")
  status          ReservationStatus @default(pending)
  specialRequests Json              @default("[]") @map("special_requests")  // ← JSON array
  confirmedAt     DateTime?         @map("confirmed_at")
  checkedInAt     DateTime?         @map("checked_in_at")
  cancelledAt     DateTime?         @map("cancelled_at")
  createdAt       DateTime          @default(now()) @map("created_at")
  updatedAt       DateTime          @updatedAt @map("updated_at")

  customer        Customer  @relation(fields: [customerId], references: [id], onDelete: Restrict)
  timeSlot        TimeSlot  @relation(fields: [timeSlotId], references: [id], onDelete: Restrict)
  timeSlotId      String    @map("time_slot_id")

  tables          ReservationTable[]
  
  @@index([customerId])
  @@index([timeSlotId])
  @@map("reservations")
  @@schema("ibx_domain")
}
```

### Field Schema (from Prisma comment, lines 141–145)
```
// Expected JSON shape is SpecialRequest[]:
//   { type: 'birthday'|'anniversary'|'allergy_warning'|'highchair'|'window_seat'|'accessible'|'other',
//     notes?: string }
// Validated via Zod SpecialRequestSchema at application layer.
```

### Writers
1. **`packages/domain/src/services/reservation.service.ts:create()`** (legacy)
   - Accepts optional `specialRequests?: SpecialRequest[]` as input param
   - Writes to DB: `specialRequests: input.specialRequests ?? []`
   - Caller context: reservation creation (web form, API, tool)
   - Carries PII: YES — the `notes` field can contain free-form pt-BR text (allergies, accessibility needs, preferences)
   - Frequency: ~1x per reservation creation (10s–100s/day)

2. **`packages/domain/src/services/reservation.service.ts:modify()`**
   - Accepts optional `specialRequests?: SpecialRequest[]`
   - Updates the JSON: `specialRequests: changes.specialRequests ?? existing.specialRequests ?? []`
   - Caller context: reservation modification (API, tool)
   - Carries PII: YES (same as above)
   - Frequency: ~0–1x per reservation (edits are less common)

3. **`packages/domain/src/services/reservation.service.ts:createFromEnvelope()`** (envelope-typed entry point)
   - Routes through `conversationPolicyBundle` (SYSTEM taint)
   - Same write semantics as above; intent-gated

### Readers
1. **`packages/domain/src/services/reservation.service.ts:toDTO()`**
   - Reads `specialRequests: r.specialRequests ?? []` and includes in DTO
   - Surfaces to: GET `/reservations/{id}` API endpoint

2. **`apps/api/src/routes/reservations.ts`**
   - Returns full reservation DTO including specialRequests to customer/staff
   - Surfaces PII notes to: authenticated users

3. **Kitchen / fulfillment workflows**
   - May use specialRequests to tailor the dining experience (allergies, accessibility)

### FK to Customer.id & onDelete Behavior
- **FK present:** YES — `customerId` → `Customer.id`
- **onDelete:** `Restrict` — prevents deletion of customer if reservations exist
- **Implication:** Reservation rows are tightly coupled to Customer; anonymizing customer without handling reservations would cascade-fail

### Recommended Strategy
**`null-out` — set `specialRequests = '[]'` (empty JSON array) or `= NULL`**

**Rationale:** The JSON contains unstructured notes that may include allergies, accessibility requirements, or dietary preferences (sensitive health/accessibility data). Parsing to extract safe keys is error-prone. Clearing the array is simplest and safe; the reservation itself (date, time, party size) survives for operational continuity. If empty array is semantically cleaner than null, use `[]`. If null is preferred, make the field nullable in a migration first (or just set to empty array).

---

## Summary Table

| Surface | Field(s) | Schema Status | FK to Customer? | Writers (Top 3) | Recommended Strategy | Rationale |
|---------|----------|---|---|---|---|---|
| 1. OrderProjection | email, name, phone, shippingAddressJson | Exist, nullable | SetNull | order.placed subscriber → mapper (3x/day avg) | null-out scalars; full-replace JSON | Copy data from Medusa; safe to clear |
| 2. ConversationMessage | content | Exists, unbounded string | Indirect (Conversation) | archiver subscriber (100s/day) | placeholder `[anonymized]` | Free-form text cannot be safely parsed |
| 3. Conversation | customerId | Exists, nullable | SetNull | session create (100s/day) | null-out | Field already nullable; breaks linkage cleanly |
| 4. OrderStatusHistory | actorId | Exists, nullable, untyped | None (soft ref) | status transition (100s/day) | null-out where actor='customer' | Nulls customer reference; preserves audit context |
| 5. OrderEventLog | payload | Exists, unbounded JSON | None (soft ref) | subscribers fire-and-forget (1000s/day) | full-replace JSON with `{anonymized:true}` | Opaque structure; safe wholesale replacement |
| 6. LoyaltyAccount | (entire row: customerId linkage) | Exists, @unique | Cascade | getOrCreateAccount (1x/customer) | delete-row or cascade-delete | Contains only metrics; explicit delete for clarity |
| 7. Reservation | specialRequests | Exists, JSON array | Restrict | create/modify (10s–100s/day) | null-out `[]` | Unstructured health/accessibility data |

---

## Potential Issues & Surprises

### No 9th surface found
All 8 enumerated surfaces exist in the schema as expected. No additional PII sinks were discovered.

### FK Constraint Mismatch on Surface 4 (OrderStatusHistory.actorId)
**Finding:** `actorId` is NOT a Prisma relation — it's a raw String column with no FK constraint. This is intentional (it can reference either `Staff.id` or `Customer.id`). The schema comment does not declare it as a relation, so Prisma will not cascade on deletion.

**Implication:** Deleting a customer will NOT delete or null the actorId automatically. Manual nulling during anonymization is required.

### Surface 6 (LoyaltyAccount) — Cascade Already Present
**Finding:** LoyaltyAccount has `onDelete: Cascade` defined. If the customer row is deleted, the loyalty account automatically cascades. However, during `anonymizeCustomer`, we typically do NOT delete the customer row; we anonymize it in place.

**Implication:** The row will survive; the Cascade clause is NOT triggered during anonymization. Explicit deletion or nulling in the service is needed.

### Surface 7 (Reservation.specialRequests) — FK Restrict
**Finding:** Reservation has `onDelete: Restrict` to Customer. This means the customer row CANNOT be deleted if reservations exist.

**Implication:** During `anonymizeCustomer`, the Customer row is not deleted (it's anonymized in place). Restrict FK does not prevent anonymization, only deletion. This is fine; we just scrub specialRequests.

---

## Testing Recommendations

1. **Per-surface unit test:** Populate a customer with PII in all 7 surfaces; call `anonymizeCustomer(customerId)`; assert each surface field/row is scrubbed per the recommended strategy.

2. **Fixture-based conformance test (T4):** Create a single test customer with:
   - OrderProjection rows (with email/name/phone/address)
   - ConversationMessage rows (with free-form content)
   - Conversation rows (linked to customer)
   - OrderStatusHistory rows (with customer actorId)
   - OrderEventLog rows (with PII in payload)
   - LoyaltyAccount row
   - Reservation rows (with specialRequests)

   Run `anonymizeCustomer()`; snapshot each table; assert zero PII linkage remains.

3. **Race test:** Anonymization running concurrently with new order placement / conversation message append. Verify eventual consistency.

---

## References

- **Prisma schema:** `/Users/thaisrodolpho/projects/ibatexas/packages/domain/prisma/schema.prisma`
- **Order service:** `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/order-command.service.ts`
- **Conversation service:** `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/conversation.service.ts`
- **Loyalty service:** `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/loyalty.service.ts`
- **Reservation service:** `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/reservation.service.ts`
- **Order event log service:** `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/order-event-log.service.ts`
- **Task file:** `/Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/audit-2026-05-24/tasks/h3-lgpd-anonymize-scope-expansion.md`
