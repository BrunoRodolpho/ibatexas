// Keyword shortcuts that bypass the LLM for instant responses.
//
// Matches common Portuguese commands (normalized: lowercase, trimmed, accents removed)
// and returns structured actions that can be executed directly without an agent call.

export type ShortcutAction =
  | { type: "menu" }
  | { type: "cart" }
  | { type: "reservation" }
  | { type: "help" };

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
