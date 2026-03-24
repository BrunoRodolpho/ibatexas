# Política de Retenção de Dados — IbateXas

## Períodos de Retenção

| Tipo de Dado | Período de Retenção | Base Legal |
|---|---|---|
| Dados de pedidos (orders) | 5 anos | Obrigação fiscal (NF-e) |
| Perfil do cliente (name, phone, email) | Enquanto conta ativa + 30 dias após solicitação de exclusão | Consentimento (LGPD Art. 7) |
| Endereços | Enquanto conta ativa | Execução de contrato |
| Preferências alimentares | Enquanto conta ativa | Consentimento |
| Sessões (Redis) | 48 horas | Interesse legítimo |
| Dados de navegação (PostHog) | 90 dias | Consentimento (cookie) |
| Avaliações | Indefinido (anonimizadas após exclusão) | Interesse legítimo |
| Mensagens WhatsApp | Não armazenadas | N/A |

## Direitos do Titular (LGPD Art. 18)

- **Acesso:** `GET /api/me/data`
- **Eliminação:** `DELETE /api/me/data`
- **Portabilidade:** `GET /api/me/data` (JSON export)

## Processo de Exclusão

1. **Solicitação:** via `DELETE /api/me/data` (autenticado) ou contato direto com o restaurante.
2. **Anonimização do perfil:** nome substituído por "Usuário Removido", phone recebe hash irreversível, email definido como `null`.
3. **Pedidos mantidos:** dados de pedidos são preservados por obrigação fiscal (5 anos / NF-e), mas desvinculados do perfil do cliente (`customerId` → `null`).
4. **Avaliações mantidas:** reviews permanecem no sistema para interesse legítimo, mas são anonimizadas (vínculo com cliente removido).
5. **Endereços e preferências:** deletados permanentemente.
6. **Cache e sessões:** dados em Redis (sessões, perfil em cache) expiram automaticamente conforme TTL configurado (48h para sessões).
