# Política de Retenção de Dados — IbateXas

## Períodos de Retenção

| Tipo de Dado | Período de Retenção | Base Legal |
|---|---|---|
| Dados de pedidos (orders) | 5 anos | Obrigação fiscal (NF-e) |
| Perfil do cliente (name, phone, email) | Enquanto conta ativa + 30 dias após solicitação de exclusão | Consentimento (LGPD Art. 7) |
| Endereços | Enquanto conta ativa | Execução de contrato |
| Preferências alimentares | Enquanto conta ativa | Consentimento |
| Conversas (WhatsApp e web) | Enquanto conta ativa (anonimizadas na exclusão) | Interesse legítimo |
| Sessões (Redis) | Convidado: 48 h · Autenticado/WhatsApp: 24 h | Interesse legítimo |
| Dados de navegação (PostHog) | 90 dias | Consentimento (cookie) |
| Avaliações | Indefinido (anonimizadas após exclusão) | Interesse legítimo |

### Conversas (WhatsApp e web)

Mensagens **são persistidas**. O hot path é a lista Redis `session:{sessionId}`
(`apps/api/src/session/store.ts`); cada `appendMessages()` publica o evento NATS
`conversation.message.appended`, consumido pelo subscriber `conversation-archiver`
(`apps/api/src/subscribers/conversation-archiver.ts`), que grava de forma durável
em Postgres como linhas `Conversation` + `ConversationMessage` (`channel: "whatsapp"`
ou `"web"`). O archiver é best-effort: o Redis é o caminho quente, a gravação em
Postgres é arquival assíncrona.

Os TTLs de sessão diferem por tipo de cliente (`apps/api/src/session/store.ts`):

- **Convidado:** 48 h (`GUEST_SESSION_TTL_SECONDS`)
- **Autenticado:** 24 h (`CUSTOMER_SESSION_TTL_SECONDS`)

A sessão WhatsApp (`wa:phone:{phoneHash}`) também usa 24 h
(`SESSION_TTL_SECONDS`, `apps/api/src/whatsapp/session.ts`).

Na anonimização, o conteúdo durável é depurado, não deletado: `ConversationMessage.content`
é substituído pelo placeholder `[anonymized]` e `Conversation.customerId` recebe `null`
(`packages/domain/src/services/customer.service.ts`). As linhas permanecem consultáveis
por `Conversation.sessionId` para fins de auditoria, mas sem vínculo com o cliente nem PII.

## Direitos do Titular (LGPD Art. 18)

- **Acesso / Portabilidade:** `GET /api/me/data` (export JSON)
- **Eliminação:** `DELETE /api/me/data` (imediata) ou o fluxo com janela de graça (abaixo)

## Processo de Exclusão

A exclusão é uma **anonimização adjudicada pelo kernel** (`customer.anonymize`),
não um hard-delete da conta. Há dois caminhos (`apps/api/src/routes/me.ts`):

- **Imediato:** `DELETE /api/me/data?token={otpCode}` — autenticado, sob a trava
  `lgpd:{customerId}`, executa a anonimização agora.
- **Com janela de graça:** `POST /api/me/data/send-otp` → `/verify-otp` →
  `/initiate-deletion`, que estaciona um DEFER com 24 h de graça. O cliente pode
  abortar via `POST /api/me/data/cancel-deletion`. Após 24 h sem cancelamento, o
  subscriber `anonymize-grace-resolver` executa a anonimização.

A anonimização (`anonymizeCustomer`, `packages/domain/src/services/customer.service.ts`):

1. **Perfil:** nome → "Usuário Removido"; email e cpf → `null`; phone substituído por
   sentinela irreversível (constraint UNIQUE impede `null`); medusaId → `null`.
2. **Pedidos mantidos:** preservados por obrigação fiscal (5 anos / NF-e), mas
   desvinculados do cliente (`CustomerOrderItem.customerId` → `null`; campos
   denormalizados em `OrderProjection` depurados).
3. **Avaliações mantidas:** preservadas por interesse legítimo; o comentário é depurado
   (`Review.comment` → `null`).
4. **Endereços e preferências:** deletados permanentemente.
5. **Conversas:** `ConversationMessage.content` → `[anonymized]`,
   `Conversation.customerId` → `null` (as mensagens duráveis não somem; perdem o vínculo
   e a PII).
6. **Cache e sessões (Redis):** expiram automaticamente conforme TTL (convidado 48 h,
   autenticado 24 h). A PII durável em Postgres é depurada na hora pela anonimização
   acima — não depende do TTL do Redis.
