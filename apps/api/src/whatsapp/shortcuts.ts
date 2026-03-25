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
  | { type: "loyalty" };

/**
 * Normalize input for matching: lowercase, trim, remove accents.
 */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "");
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
  pedido: { type: "cart" },
  "meu pedido": { type: "cart" },

  // Reservation
  reserva: { type: "reservation" },
  reservar: { type: "reservation" },
  "fazer reserva": { type: "reservation" },

  // Help
  ajuda: { type: "help" },
  help: { type: "help" },
  opcoes: { type: "help" },
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
    "Bem-vindo ao IbateXas! 🥩 Voce tem R$15 de credito no seu primeiro pedido!",
    "",
    "Vamos comecar: voce prefere carne *mal-passada*, *ao ponto* ou *bem-passada*?",
    "",
    "(Responda com sua preferencia e eu te mostro as melhores opcoes!)",
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
 * Build the help response text listing available commands.
 */
export function buildHelpText(): string {
  return [
    "Olá! 👋 Aqui está o que posso fazer:",
    "",
    "*menu* ou *cardápio* — ver nosso cardápio",
    "*carrinho* — ver seu carrinho atual",
    "*reserva* — fazer uma reserva de mesa",
    "*ajuda* — ver esta mensagem",
    "",
    "Ou me diga o que procura e eu ajudo! 🍖",
  ].join("\n");
}
