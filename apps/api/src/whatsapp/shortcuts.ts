// Keyword shortcuts that bypass the LLM for instant responses.
//
// Matches common Portuguese commands (normalized: lowercase, trimmed, accents removed)
// and returns structured actions that can be executed directly without an agent call.

export type ShortcutAction =
  | { type: "menu" }
  | { type: "cart" }
  | { type: "reservation" }
  | { type: "help" }
  | { type: "welcome" }
  | { type: "loyalty" }
  | { type: "optout" }
  | { type: "optin" };

/**
 * Normalize input for matching: lowercase, trim, remove accents.
 */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    // S3 \u2014 collapse inner whitespace and strip leading/trailing punctuation so an
    // opt-out like `Parar.` / `stop!` / `  parar  ` still matches its keyword. We
    // strip only Unicode punctuation (\p{P}) + spaces, never symbols (so the `r$15`
    // key survives), and keep WHOLE-MESSAGE exact matching (never substring) so a
    // message like `n\u00e3o quero parar` can never be mis-read as an opt-out.
    .replaceAll(/\s+/g, " ")
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");
}

const SHORTCUT_MAP: Record<string, ShortcutAction> = {
  // Menu / Cardápio
  menu: { type: "menu" },
  cardapio: { type: "menu" },
  "ver cardapio": { type: "menu" },
  "ver menu": { type: "menu" },
  produtos: { type: "menu" },

  // Cart
  carrinho: { type: "cart" },
  "ver carrinho": { type: "cart" },
  "meu carrinho": { type: "cart" },
  // "pedido" and "meu pedido" intentionally omitted — fall through to LLM
  // so the agent can route to check_order_status vs cart as appropriate.

  // Reservation
  reserva: { type: "reservation" },
  reservar: { type: "reservation" },
  "fazer reserva": { type: "reservation" },

  // Help
  ajuda: { type: "help" },
  help: { type: "help" },
  opcoes: { type: "menu" },
  comandos: { type: "help" },

  // Loyalty
  fidelidade: { type: "loyalty" },
  selos: { type: "loyalty" },
  "meus selos": { type: "loyalty" },
  pontos: { type: "loyalty" },
  "meus pontos": { type: "loyalty" },

  // Welcome / first-order credit
  credito: { type: "welcome" },
  desconto: { type: "welcome" },
  "primeira vez": { type: "welcome" },
  "quero meu credito": { type: "welcome" },
  "r$15": { type: "welcome" },

  // WS3A — customer-initiated marketing opt-out (STOP). Whole-message exact
  // match only (matchShortcut normalizes+exact-lookups), so these never fire
  // mid-sentence. Bare "cancelar" is intentionally OMITTED — it collides with
  // order cancellation; opt-out uses the unambiguous unsubscribe words.
  parar: { type: "optout" },
  pare: { type: "optout" },
  stop: { type: "optout" },
  sair: { type: "optout" },
  descadastrar: { type: "optout" },
  "me descadastrar": { type: "optout" },
  "cancelar inscricao": { type: "optout" },
  "cancelar promocoes": { type: "optout" },
  "parar de receber": { type: "optout" },
  "parar promocoes": { type: "optout" },
  "quero parar": { type: "optout" },
  "parar por favor": { type: "optout" },
  "nao quero receber": { type: "optout" },
  "nao quero mais receber": { type: "optout" },
  "nao quero mais mensagens": { type: "optout" },
  "remover meu numero": { type: "optout" },

  // Re-subscribe (opt back in) — the opt-out confirmation invites "voltar".
  voltar: { type: "optin" },
  "quero receber": { type: "optin" },
  "receber promocoes": { type: "optin" },
};

/**
 * Match user input against known keyword shortcuts.
 * Returns null if no shortcut matched — caller should fall through to LLM agent.
 */
export function matchShortcut(body: string): ShortcutAction | null {
  const normalized = normalize(body);
  return SHORTCUT_MAP[normalized] ?? null;
}

/**
 * Build the welcome credit response text for new customers.
 */
export function buildWelcomeText(): string {
  return [
    "Ei, que bom que você veio! 🥩",
    "",
    "Aqui no IbateXas é tudo defumado low & slow — mínimo 8h de fogo lento com carvalho americano.",
    "",
    "Quer conhecer nosso cardápio? Responda *menu* ou me diga o que procura!",
  ].join("\n");
}

/**
 * Build the loyalty prompt text.
 * Shortcuts cannot trigger tool calls directly — the agent handles get_loyalty_balance.
 * This message invites the customer to ask the assistant.
 */
export function buildLoyaltyText(): string {
  return "Para ver seus selos, pergunte ao nosso assistente: 'quantos selos eu tenho?'";
}

/**
 * Build the pt-BR confirmation sent after a customer-initiated marketing opt-out.
 */
export function buildOptOutConfirmationText(): string {
  return [
    "Pronto! Você não receberá mais mensagens promocionais. ✅",
    "",
    "Se quiser voltar a receber, é só responder *voltar*. Você continua podendo fazer pedidos e falar com a gente normalmente.",
  ].join("\n");
}

/**
 * Build the pt-BR confirmation sent after a customer re-subscribes (opt-in).
 */
export function buildOptInConfirmationText(): string {
  return "Feito! Você voltou a receber nossas novidades e promoções. 🥩";
}

/**
 * Build the help response text listing available commands.
 */
export function buildHelpText(): string {
  return [
    "Olá! 👋 Aqui está o que posso fazer:",
    "",
    "*menu* ou *cardápio* — nosso cardápio (atualizado em tempo real)",
    "*carrinho* — seu carrinho atual",
    "*reserva* — reservar mesa",
    "*fidelidade* — seus selos do programa",
    "*ajuda* — esta mensagem",
    "",
    "Ou me diga o que procura e eu ajudo! 🍖",
  ].join("\n");
}
