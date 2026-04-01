// XState v5 order state machine for IbateXas WhatsApp/Web bot.
//
// The machine handles ALL business logic deterministically:
// - Product availability checks
// - Cart management (add/remove/update)
// - Checkout flow (auth, fulfillment, payment)
// - Upsell sequencing
// - Objection handling
//
// The LLM NEVER makes business decisions. It only generates natural language
// from the synthesized prompt that the machine produces.
//
// Async tool calls (searchProduct, addItemToCart, etc.) are executed OUTSIDE
// the machine via the orchestrator in agent.ts. The machine receives results
// as follow-up events (SEARCH_RESULT, CART_UPDATED, etc.).

import { setup, assign, and, not, type MachineContext } from "xstate"
import type { OrderContext, OrderEvent } from "./types.js"
import { createDefaultContext, getCurrentMealPeriod } from "./types.js"
import { computeCartFlags } from "./guards.js"

// ── Internal events (fed back by the orchestrator after async actions) ────────

type InternalEvent =
  | { type: "SEARCH_RESULT"; found: boolean; products: unknown[]; alternatives: string[]; availableProduct?: { variantId: string; name: string; priceInCentavos: number; category: string } }
  | { type: "CART_UPDATED"; success: boolean; cartId: string; items: OrderContext["items"]; totalInCentavos: number; error?: string }
  | { type: "DELIVERY_RESULT"; inZone: boolean; feeInCentavos: number; etaMinutes: number; error?: string }
  | { type: "CHECKOUT_RESULT"; success: boolean; paymentMethod: string; checkoutData: unknown }
  | { type: "PROFILE_LOADED"; isNewCustomer: boolean; orderCount: number; name?: string }
  | { type: "LOYALTY_LOADED"; stamps: number | null }
  | { type: "LOGIN_SUCCESS" }
  | { type: "SET_NAME"; name: string }
  // Post-order guarded operation results (fed back by kernel after executing mutations)
  | { type: "CANCEL_ORDER_RESULT"; success: boolean; message: string }
  | { type: "AMEND_ORDER_RESULT"; success: boolean; message: string }
  | { type: "REGENERATE_PIX" }  // kernel sends this when LLM proposes regenerate_pix tool
  | { type: "PIX_REGENERATED"; success: boolean; pixQrCodeText?: string; pixQrCodeUrl?: string }
  // Post-checkout PIX cache event (machine-controlled side effect)
  | { type: "CACHE_PIX_DETAILS" }

// All events the machine handles
type MachineEvent = OrderEvent | InternalEvent

// ── Machine definition ───────────────────────────────────────────────────────

export const orderMachine = setup({
  types: {
    context: {} as OrderContext,
    events: {} as MachineEvent,
  },
  guards: {
    isNewCustomer: ({ context }) => context.isNewCustomer,
    isAuthenticated: ({ context }) => context.customerId !== null,
    isWhatsApp: ({ context }) => context.channel === "whatsapp",
    canCheckout: ({ context }) =>
      context.channel === "whatsapp" || context.customerId !== null,
    isCartEmpty: ({ context }) => context.items.length === 0,
    hasCartItems: ({ context }) => context.items.length > 0,
    allSlotsFilled: ({ context }) =>
      context.fulfillment !== null && context.paymentMethod !== null,
    hasFulfillment: ({ context }) => context.fulfillment !== null,
    hasPaymentMethod: ({ context }) => context.paymentMethod !== null,
    shouldUpsell: ({ context }) => {
      if (context.isCombo || context.upsellRound >= 2) return false
      if (!context.hasMainDish) return false
      return !context.hasSide || !context.hasDrink
    },
    isPickup: ({ context }) => context.fulfillment === "pickup",
    isCashPayment: ({ context }) => context.paymentMethod === "cash",
    isCashPaymentEvent: ({ event }) =>
      event.type === "SET_PAYMENT" && (event as { method?: string }).method === "cash",
    hasValidCart: ({ context }) =>
      context.cartId !== null && context.items.length > 0,
    searchFound: ({ event }) =>
      event.type === "SEARCH_RESULT" && event.found === true,
    searchNotFound: ({ event }) =>
      event.type === "SEARCH_RESULT" && event.found === false,
    cartSuccess: ({ event }) =>
      event.type === "CART_UPDATED" && event.success === true,
    cartFailed: ({ event }) =>
      event.type === "CART_UPDATED" && event.success === false,
    deliveryInZone: ({ event }) =>
      event.type === "DELIVERY_RESULT" && event.inZone === true,
    deliveryOutOfZone: ({ event }) =>
      event.type === "DELIVERY_RESULT" && event.inZone === false,
    checkoutSuccess: ({ event }) =>
      event.type === "CHECKOUT_RESULT" && event.success === true,
    checkoutFailed: ({ event }) =>
      event.type === "CHECKOUT_RESULT" && event.success === false,
    fallbackLimitReached: ({ context }) => context.fallbackCount >= 3,
    isPixPayment: ({ context }) => context.paymentMethod === "pix",
    hasPixDetails: ({ context }) => context.customerEmail !== null && context.customerTaxId !== null,
    needsPixDetails: ({ context }) => context.paymentMethod === "pix" && (context.customerEmail === null || context.customerTaxId === null),
    // Post-order mutation guards
    canCancelOrder: ({ context }) => !!context.orderId && context.lastAction !== "cancelled",
    canAmendOrder: ({ context }) => !!context.orderId && context.lastAction !== "cancelled",
    hasOrderId: ({ context }) => !!context.orderId,
  },
  actions: {
    // ── Context mutations ───────────────────────────────────────────────────
    setPendingProduct: assign({
      pendingProduct: ({ event, context }) => {
        if (event.type === "ADD_ITEM" || event.type === "ASK_PRODUCT" || event.type === "ASK_PRICE") {
          // "__last_pending__" is a sentinel from the variant-only router path (e.g. "1kg").
          // Preserve the actual product name from the previous turn so the orchestrator
          // can search for it after the session is restored from a snapshot.
          return event.productName === "__last_pending__" ? context.pendingProduct : event.productName
        }
        if (event.type === "UPSELL_ACCEPT") return event.productName
        return null
      },
    }),

    clearError: assign({ lastError: null, alternatives: [] }),

    setFulfillment: assign({
      fulfillment: ({ event }) =>
        event.type === "SET_FULFILLMENT" ? event.method : null,
      deliveryCep: ({ event }) =>
        event.type === "SET_FULFILLMENT" && event.cep ? event.cep : null,
    }),

    setPayment: assign({
      paymentMethod: ({ event }) =>
        event.type === "SET_PAYMENT" ? event.method : null,
    }),

    storeSearchResult: assign({
      lastSearchResult: ({ event }) =>
        event.type === "SEARCH_RESULT" ? event.products : null,
      alternatives: ({ event }) =>
        event.type === "SEARCH_RESULT" ? event.alternatives : [],
      lastError: ({ event }) =>
        event.type === "SEARCH_RESULT" && !event.found
          ? "Produto indisponível no momento"
          : null,
    }),

    updateCartFromResult: assign(({ context, event }) => {
      if (event.type !== "CART_UPDATED") return {}
      if (!event.success) {
        return { lastError: event.error ?? "Erro ao atualizar carrinho" }
      }
      // Merge prep time and PONR data from last search result into cart items
      const searchProducts = Array.isArray(context.lastSearchResult)
        ? (context.lastSearchResult as Array<{ variantId?: string; name?: string; preparationTimeMinutes?: number; amendPonrMinutes?: number; cancelPonrMinutes?: number }>)
        : []
      const enrichedItems = event.items.map((item) => {
        const searchMatch = searchProducts.find(
          (sp) => sp.variantId === item.variantId || (sp.name && item.name.toLowerCase().includes(sp.name.toLowerCase())),
        )
        return {
          ...item,
          preparationTimeMinutes: item.preparationTimeMinutes ?? searchMatch?.preparationTimeMinutes ?? 0,
          amendPonrMinutes: item.amendPonrMinutes ?? searchMatch?.amendPonrMinutes,
          cancelPonrMinutes: item.cancelPonrMinutes ?? searchMatch?.cancelPonrMinutes,
        }
      })
      const flags = computeCartFlags(enrichedItems)
      return {
        cartId: event.cartId,
        items: enrichedItems,
        totalInCentavos: event.totalInCentavos,
        ...flags,
        lastError: null,
      }
    }),

    storeDeliveryResult: assign(({ event }) => {
      if (event.type !== "DELIVERY_RESULT") return {}
      if (!event.inZone) {
        return { lastError: "Endereço fora da área de entrega." }
      }
      return {
        deliveryFeeInCentavos: event.feeInCentavos,
        deliveryEtaMinutes: event.etaMinutes,
        lastError: null,
      }
    }),

    storeCheckoutResult: assign(({ event }) => {
      if (event.type !== "CHECKOUT_RESULT") return {}
      const data = event.checkoutData as Record<string, unknown> | null
      if (!event.success) {
        // Failed checkout — store error but don't set orderId/orderCreatedAt
        return {
          checkoutResult: event.checkoutData,
          lastError: (data?.message as string) ?? "Erro no checkout",
        }
      }
      return {
        checkoutResult: event.checkoutData,
        orderId: (data?.orderId as string) ?? null,
        orderCreatedAt: new Date().toISOString(),
        lastError: null,
      }
    }),

    storeProfile: assign(({ event }) => {
      if (event.type !== "PROFILE_LOADED") return {}
      return {
        isNewCustomer: event.isNewCustomer,
        isAuthenticated: true,
      }
    }),

    storeLoyalty: assign(({ event }) => {
      if (event.type !== "LOYALTY_LOADED") return {}
      return { loyaltyStamps: event.stamps }
    }),

    incrementUpsellRound: assign({
      upsellRound: ({ context }) => context.upsellRound + 1,
    }),

    refreshMealPeriod: assign({
      mealPeriod: () => getCurrentMealPeriod(),
    }),

    clearCart: assign({
      cartId: null,
      items: [],
      totalInCentavos: 0,
      couponApplied: null,
      hasMainDish: false,
      hasSide: false,
      hasDrink: false,
      isCombo: false,
      fulfillment: null,
      paymentMethod: null,
      deliveryCep: null,
      deliveryFeeInCentavos: null,
      deliveryEtaMinutes: null,
      tipInCentavos: 0,
      checkoutResult: null,
      orderId: null,
      orderCreatedAt: null,
    }),

    markCancelled: assign({ lastAction: "cancelled" as const }),

    clearLastAction: assign({ lastAction: null }),

    setSecondaryIntent: assign({
      secondaryIntent: ({ event }) =>
        event.type === "ADD_ITEM" ? (event.secondaryIntent ?? null) : null,
    }),

    clearSecondaryIntent: assign({ secondaryIntent: null }),

    setCustomerName: assign({
      customerName: ({ event }) =>
        event.type === "SET_NAME" ? event.name : null,
    }),

    setMomentumHigh: assign({ momentum: "high" as const }),
    setMomentumCooling: assign({ momentum: "cooling" as const }),
    setMomentumLost: assign({ momentum: "lost" as const }),

    setObjectionSubtype: assign({
      lastObjectionSubtype: ({ event }) =>
        event.type === "OBJECTION" ? event.subtype : null,
    }),

    incrementFallbackCount: assign({
      fallbackCount: ({ context }) => context.fallbackCount + 1,
    }),

    resetFallbackCount: assign({ fallbackCount: 0 }),

    setPixDetails: assign(({ context, event }) => {
      if (event.type !== "SET_PIX_DETAILS") return {}
      return {
        customerEmail: event.email || context.customerEmail,
        customerTaxId: event.taxId || context.customerTaxId,
        customerName: event.fullName || context.customerName,
      }
    }),

    storePixDetails: assign(({ context, event }) => {
      if (event.type !== "PIX_DETAILS_COLLECTED") return {}
      const p = (event as { payload: { name?: string; email?: string; cpf?: string } }).payload
      return {
        customerEmail: (p.email || context.customerEmail) ?? null,
        customerTaxId: (p.cpf || context.customerTaxId) ?? null,
        customerName: p.name || context.customerName,
      }
    }),

    // ── Post-order result actions ──────────────────────────────────────────
    storeCancelResult: assign(({ event }) => {
      if (event.type !== "CANCEL_ORDER_RESULT") return {}
      return {
        lastAction: event.success ? ("cancelled" as const) : null,
        lastError: event.success ? null : event.message,
      }
    }),

    storeAmendResult: assign(({ event }) => {
      if (event.type !== "AMEND_ORDER_RESULT") return {}
      return {
        lastAction: event.success ? ("amended" as const) : null,
        lastError: event.success ? null : event.message,
      }
    }),

    storePixRegenResult: assign(({ event }) => {
      if (event.type !== "PIX_REGENERATED") return {}
      if (!event.success) return { lastError: "Erro ao regenerar PIX." }
      return {
        checkoutResult: {
          pixQrCodeText: (event as { pixQrCodeText?: string }).pixQrCodeText,
          pixQrCodeUrl: (event as { pixQrCodeUrl?: string }).pixQrCodeUrl,
        },
        lastError: null,
      }
    }),
  },
}).createMachine({
  id: "order",
  initial: "idle",
  context: ({ input }) => input as OrderContext,

  // Global event handlers — these work from any state
  // NOTE: CANCEL_ORDER is intentionally NOT global — it's handled per-state
  // to prevent destroying completed orders or bypassing PONR checks.
  on: {
    HANDOFF_HUMAN: { target: ".support" },
  },

  states: {
    // ── IDLE ──────────────────────────────────────────────────────────────────
    idle: {
      entry: ["refreshMealPeriod", "clearLastAction", "resetFallbackCount"],
      on: {
        GREETING: [
          { guard: "isNewCustomer", target: "first_contact" },
          { target: "browsing" },
        ],
        START_ORDER: "browsing",
        ASK_MENU: "browsing",
        ADD_ITEM: {
          target: "ordering.validating_item",
          actions: ["setPendingProduct", "clearError", "setSecondaryIntent"],
        },
        ASK_PRODUCT: {
          target: "browsing",
          actions: "setPendingProduct",
        },
        ASK_PRICE: {
          target: "browsing",
          actions: "setPendingProduct",
        },
        ASK_HOURS: "browsing",
        ASK_DELIVERY: "browsing",
        ASK_LOYALTY: "loyalty_check",
        ASK_REORDER: "reorder",
        RESERVE_TABLE: "reservation",
        OBJECTION: { target: "objection", actions: ["setObjectionSubtype", "setMomentumCooling"] },
        CANCEL_ORDER: {
          // Safe in idle — nothing to lose
          actions: ["clearCart", "markCancelled"],
        },
        UNKNOWN_INPUT: "fallback",
        // Slots can be set from idle (e.g., fast-path messages)
        SET_FULFILLMENT: {
          actions: "setFulfillment",
        },
        SET_PAYMENT: {
          actions: "setPayment",
        },
        SET_NAME: { actions: "setCustomerName" },
      },
    },

    // ── FIRST CONTACT (new customer) ─────────────────────────────────────────
    first_contact: {
      on: {
        ADD_ITEM: {
          target: "ordering.validating_item",
          actions: ["setPendingProduct", "clearError", "setSecondaryIntent"],
        },
        ASK_MENU: "browsing",
        ASK_PRODUCT: {
          target: "browsing",
          actions: "setPendingProduct",
        },
        UNKNOWN_INPUT: "browsing",
        SET_FULFILLMENT: {
          actions: "setFulfillment",
        },
        SET_PAYMENT: {
          actions: "setPayment",
        },
      },
    },

    // ── BROWSING ─────────────────────────────────────────────────────────────
    browsing: {
      entry: ["refreshMealPeriod", "resetFallbackCount"],
      on: {
        ADD_ITEM: {
          target: "ordering.validating_item",
          actions: ["setPendingProduct", "clearError", "setSecondaryIntent"],
        },
        ASK_PRODUCT: {
          // Stay in browsing but set the pending product for the synthesizer
          actions: "setPendingProduct",
        },
        ASK_PRICE: {
          actions: "setPendingProduct",
        },
        ASK_MENU: {
          // Self-transition refreshes meal period
          target: "browsing",
          reenter: true,
        },
        CHECKOUT_START: [
          { guard: "hasCartItems", target: "checkout" },
          // Cart empty — stay in browsing
        ],
        CONFIRM_ORDER: [
          { guard: "hasCartItems", target: "checkout" },
        ],
        VIEW_CART: "ordering.awaiting_next",
        SET_FULFILLMENT: {
          actions: "setFulfillment",
        },
        SET_PAYMENT: {
          actions: "setPayment",
        },
        GREETING: {
          // Already in conversation — ignore duplicate greeting
        },
        ASK_LOYALTY: "loyalty_check",
        RESERVE_TABLE: "reservation",
        OBJECTION: { target: "objection", actions: ["setObjectionSubtype", "setMomentumCooling"] },
        CANCEL_ORDER: {
          target: "idle",
          actions: ["clearCart", "markCancelled"],
        },
        UNKNOWN_INPUT: "fallback",
        SET_NAME: { actions: "setCustomerName" },
      },
    },

    // ── ORDERING (hierarchical) ──────────────────────────────────────────────
    ordering: {
      initial: "validating_item",

      // Common transitions from any ordering sub-state
      on: {
        CHECKOUT_START: [
          { guard: "hasCartItems", target: "checkout" },
          // Cart empty — stay in ordering
        ],
        // CONFIRM_ORDER from ordering = customer confirmed while LLM showed summary.
        // Route through checkout compound state (auto-transitions handle auth + slots).
        CONFIRM_ORDER: [
          { guard: "hasCartItems", target: "checkout" },
        ],
        VIEW_CART: ".awaiting_next",
        ASK_MENU: "browsing",
        ASK_LOYALTY: "loyalty_check",
        RESERVE_TABLE: "reservation",
        OBJECTION: { target: "objection", actions: ["setObjectionSubtype", "setMomentumCooling"] },
        CANCEL_ORDER: {
          target: "idle",
          actions: ["clearCart", "markCancelled"],
        },
        CLEAR_CART: {
          target: "browsing",
          actions: "clearCart",
        },
      },

      states: {
        // Waiting for search result from orchestrator
        validating_item: {
          after: {
            15000: {
              target: "awaiting_next",
              actions: assign({ lastError: "Busca demorou — tente de novo ou escolha outro item." }),
            },
          },
          on: {
            SEARCH_RESULT: [
              {
                guard: "searchFound",
                target: "adding_to_cart",
                actions: "storeSearchResult",
              },
              {
                guard: "searchNotFound",
                target: "item_unavailable",
                actions: "storeSearchResult",
              },
            ],
            // While waiting, slots can still be set
            SET_FULFILLMENT: { actions: "setFulfillment" },
            SET_PAYMENT: { actions: "setPayment" },
          },
        },

        // Waiting for cart update result from orchestrator
        adding_to_cart: {
          after: {
            15000: {
              target: "awaiting_next",
              actions: assign({ lastError: "Erro ao adicionar ao carrinho. Tente de novo." }),
            },
          },
          on: {
            CART_UPDATED: [
              {
                guard: "cartSuccess",
                target: "item_added",
                actions: "updateCartFromResult",
              },
              {
                guard: "cartFailed",
                target: "item_unavailable",
                actions: "updateCartFromResult",
              },
            ],
          },
        },

        // Item was successfully added — always move to awaiting_next.
        // Upsell suggestions are handled by the prompt synthesizer when
        // shouldUpsell conditions are met, without blocking state flow.
        item_added: {
          always: [{ target: "awaiting_next", actions: "setMomentumHigh" }],
        },

        // Product not available — show alternatives
        item_unavailable: {
          on: {
            ADD_ITEM: {
              target: "validating_item",
              actions: ["setPendingProduct", "clearError", "setSecondaryIntent"],
            },
            UPSELL_ACCEPT: {
              target: "validating_item",
              actions: ["setPendingProduct", "clearError"],
            },
            SET_FULFILLMENT: { actions: "setFulfillment" },
            SET_PAYMENT: { actions: "setPayment" },
            UNKNOWN_INPUT: "awaiting_next",
          },
        },

        // Waiting for customer's next action
        awaiting_next: {
          entry: "clearSecondaryIntent",
          on: {
            ADD_ITEM: {
              target: "validating_item",
              actions: ["setPendingProduct", "clearError", "setSecondaryIntent"],
            },
            UPSELL_ACCEPT: {
              target: "validating_item",
              actions: ["setPendingProduct", "clearError"],
            },
            UPSELL_DECLINE: "awaiting_next", // no-op, stay
            REMOVE_ITEM: {
              target: "validating_item",
              actions: "setPendingProduct",
            },
            UPDATE_QTY: {
              // Handled by orchestrator, then CART_UPDATED fed back
              target: "adding_to_cart",
            },
            APPLY_COUPON: {
              // Handled by orchestrator
              target: "adding_to_cart",
            },
            SET_FULFILLMENT: { actions: "setFulfillment" },
            SET_PAYMENT: { actions: "setPayment" },
            UNKNOWN_INPUT: {
              // Stay here — synthesizer will prompt for next action
            },
            SET_NAME: { actions: "setCustomerName" },
          },
        },
      },
    },

    // ── CHECKOUT (hierarchical) ──────────────────────────────────────────────
    checkout: {
      initial: "checking_auth",

      on: {
        CANCEL_ORDER: {
          target: "ordering.awaiting_next",
        },
        ADD_ITEM: {
          target: "ordering.validating_item",
          actions: ["setPendingProduct", "clearError", "setSecondaryIntent"],
        },
        // Handle returning users who greet mid-checkout — stay in checkout,
        // don't lose their progress. The synthesizer detects re-engagement.
        GREETING: {},
        UNKNOWN_INPUT: {},
        // Capture slot data from any checkout state. Child handlers with
        // explicit transitions take precedence (XState child > parent).
        // This ensures "entrega, pix" in one message doesn't drop SET_PAYMENT
        // while delivery is being estimated.
        SET_FULFILLMENT: { actions: "setFulfillment" },
        SET_PAYMENT: { actions: "setPayment" },
      },

      states: {
        checking_auth: {
          always: [
            { guard: "canCheckout", target: "selecting_slots" },
            { target: "awaiting_login" },
          ],
        },

        awaiting_login: {
          on: {
            LOGIN_SUCCESS: "selecting_slots",
            // Customer might provide fulfillment/payment while login prompt is shown
            SET_FULFILLMENT: { actions: "setFulfillment" },
            SET_PAYMENT: { actions: "setPayment" },
          },
        },

        selecting_slots: {
          always: [
            // Both slots filled + pickup → skip delivery check, go straight to confirming
            {
              guard: and(["hasFulfillment", "hasPaymentMethod", "isPickup"]),
              target: "confirming",
            },
            // Both slots filled + cash → go through confirmation (same as other methods)
            {
              guard: and(["hasFulfillment", "hasPaymentMethod", "isCashPayment"]),
              target: "confirming",
            },
            // Both slots filled + other payment → confirm
            {
              guard: and(["hasFulfillment", "hasPaymentMethod"]),
              target: "confirming",
            },
            // Fulfillment is delivery but payment missing → run delivery check first
            {
              guard: and(["hasFulfillment", not("isPickup")]),
              target: "checking_delivery",
            },
            // Neither slot filled → stay here; prompt asks for both
          ],
          on: {
            SET_FULFILLMENT: {
              target: "selecting_slots",
              actions: "setFulfillment",
              reenter: true,
            },
            SET_PAYMENT: {
              target: "selecting_slots",
              actions: "setPayment",
              reenter: true,
            },
            SET_NAME: { actions: "setCustomerName" },
            // CONFIRM_ORDER in selecting_slots = re-evaluate always guards (slots may have been set)
            CONFIRM_ORDER: {
              target: "selecting_slots",
              reenter: true,
            },
            CANCEL_ORDER: "#order.idle",
            UNKNOWN_INPUT: {},
          },
        },

        // Decide if we need to estimate delivery or go straight to payment
        checking_delivery: {
          always: [
            { guard: "isPickup", target: "selecting_slots" },
            // Delivery — need to estimate
            { target: "estimating_delivery" },
          ],
        },

        estimating_delivery: {
          after: {
            12000: {
              target: "selecting_slots",
              actions: assign({ lastError: "Não conseguimos verificar o CEP. Pode informar novamente?" }),
            },
          },
          on: {
            DELIVERY_RESULT: [
              {
                guard: "deliveryInZone",
                target: "selecting_slots",
                actions: "storeDeliveryResult",
              },
              {
                guard: "deliveryOutOfZone",
                target: "offer_pickup",
                actions: "storeDeliveryResult",
              },
            ],
            // User changed fulfillment mid-estimation (e.g. "actually, retirada")
            SET_FULFILLMENT: {
              target: "checking_delivery",
              actions: "setFulfillment",
            },
          },
        },

        offer_pickup: {
          on: {
            SET_FULFILLMENT: {
              target: "selecting_slots",
              actions: "setFulfillment",
            },
            UNKNOWN_INPUT: {
              target: "#order.ordering.awaiting_next",
              actions: assign({
                fulfillment: null,
                deliveryCep: null,
                deliveryFeeInCentavos: null,
                deliveryEtaMinutes: null,
              }),
            },
          },
        },

        confirming: {
          on: {
            CONFIRM_ORDER: [
              {
                // PIX with cached details → review before proceeding
                guard: and(["hasValidCart", "isPixPayment", "hasPixDetails"]),
                target: "reviewing_pix_details",
                actions: "setMomentumHigh",
              },
              {
                guard: and(["hasValidCart", "needsPixDetails"]),
                target: "collecting_pix_details",
                actions: "setMomentumHigh",
              },
              {
                guard: "hasValidCart",
                target: "processing_payment",
                actions: "setMomentumHigh",
              },
            ],
            // "fechar", "finalizar" while already in confirming = same as CONFIRM_ORDER
            CHECKOUT_START: [
              {
                guard: and(["hasValidCart", "isPixPayment", "hasPixDetails"]),
                target: "reviewing_pix_details",
                actions: "setMomentumHigh",
              },
              {
                guard: and(["hasValidCart", "needsPixDetails"]),
                target: "collecting_pix_details",
                actions: "setMomentumHigh",
              },
              {
                guard: "hasValidCart",
                target: "processing_payment",
                actions: "setMomentumHigh",
              },
            ],
            // Allow changing mind
            SET_FULFILLMENT: {
              target: "checking_delivery",
              actions: "setFulfillment",
            },
            SET_PAYMENT: {
              target: "confirming",
              actions: "setPayment",
              reenter: true,
            },
          },
        },

        collecting_pix_details: {
          on: {
            SET_PIX_DETAILS: [
              {
                // Both email and CPF provided → proceed to payment
                guard: ({ context, event }) =>
                  !!(event.email || context.customerEmail) && !!(event.taxId || context.customerTaxId),
                target: "processing_payment",
                actions: ["setPixDetails", "setMomentumHigh"],
              },
              {
                // Partial data — store what we have, stay here
                actions: "setPixDetails",
              },
            ],
            PIX_DETAILS_COLLECTED: [
              {
                guard: ({ context, event }) => {
                  const p = (event as { payload: { name?: string; email?: string; cpf?: string } }).payload
                  const name = p.name || context.customerName
                  const email = p.email || context.customerEmail
                  const cpf = p.cpf || context.customerTaxId
                  return !!(name?.includes(" ") && email && cpf)
                },
                target: "reviewing_pix_details",
                actions: "storePixDetails",
              },
              {
                actions: "storePixDetails",
              },
            ],
            // "sim" to confirm cached details → proceed
            CONFIRM_ORDER: {
              guard: "hasPixDetails",
              target: "processing_payment",
              actions: "setMomentumHigh",
            },
            // Customer switches payment method → go back to selecting_slots
            SET_PAYMENT: {
              target: "selecting_slots",
              actions: "setPayment",
              reenter: true,
            },
            CANCEL_ORDER: "#order.idle",
            UNKNOWN_INPUT: {},
          },
        },

        reviewing_pix_details: {
          on: {
            CONFIRM_ORDER: {
              guard: "hasPixDetails",
              target: "processing_payment",
              actions: "setMomentumHigh",
            },
            PIX_DETAILS_COLLECTED: {
              target: "collecting_pix_details",
              actions: "storePixDetails",
            },
            UNKNOWN_INPUT: {
              target: "collecting_pix_details",
            },
            SET_PAYMENT: {
              target: "selecting_slots",
              actions: "setPayment",
              reenter: true,
            },
            CANCEL_ORDER: "#order.idle",
          },
        },

        processing_payment: {
          after: {
            60000: {
              target: "confirming",
              actions: assign({ lastError: "Pagamento não confirmado a tempo. Tente novamente." }),
            },
          },
          on: {
            CHECKOUT_RESULT: [
              {
                guard: "checkoutSuccess",
                target: "order_placed",
                actions: "storeCheckoutResult",
              },
              {
                guard: "checkoutFailed",
                target: "confirming",
                actions: "storeCheckoutResult",
              },
            ],
          },
        },

        order_placed: {
          // The synthesizer checks ctx.paymentMethod to decide which variant
          // (pix/card/cash) prompt to render.
          on: {
            // CACHE_PIX_DETAILS is a fire-and-forget signal — the kernel handles
            // the actual cachePixDetails() call. Machine accepts and stays.
            CACHE_PIX_DETAILS: {},
            LOYALTY_LOADED: {
              actions: "storeLoyalty",
              target: "#order.post_order",
            },
            // If loyalty fetch is skipped, transition directly
            UNKNOWN_INPUT: "#order.post_order",
            GREETING: "#order.post_order",
          },
        },
      },
    },

    // ── POST ORDER (compound — guarded mutations) ─────────────────────────
    post_order: {
      initial: "idle",

      // Common transitions from any post_order sub-state
      on: {
        ASK_LOYALTY: "#order.loyalty_check",
        START_ORDER: {
          target: "#order.browsing",
          actions: "clearCart",
        },
        GREETING: {
          target: "#order.idle",
          actions: "clearCart",
        },
      },

      states: {
        // Normal post-order state — LLM has read-only tools
        idle: {
          on: {
            ASK_ORDER_STATUS: {
              // Stay — LLM calls check_order_status (read-only)
            },
            CANCEL_ORDER: [
              {
                guard: "canCancelOrder",
                target: "cancelling",
              },
              {
                // Order already cancelled or no orderId — stay, synthesizer explains
              },
            ],
            AMEND_ORDER_ADD: [
              {
                guard: "canAmendOrder",
                target: "amending",
              },
            ],
            AMEND_ORDER_REMOVE: [
              {
                guard: "canAmendOrder",
                target: "amending",
              },
            ],
            CANCEL_ITEM: [
              {
                guard: "canAmendOrder",
                target: "amending",
              },
            ],
            // PIX regeneration — guarded by hasOrderId
            // Kernel intercepts regenerate_pix tool intent and sends REGENERATE_PIX
            REGENERATE_PIX: [
              {
                guard: "hasOrderId",
                target: "regenerating_pix",
              },
            ],
            SET_PAYMENT: {
              actions: "setPayment",
            },
            ADD_ITEM: {
              actions: ["setPendingProduct"],
            },
            UNKNOWN_INPUT: {
              // Stay — synthesizer prompts if customer needs more
            },
          },
        },

        // Kernel executes cancel_order tool, feeds CANCEL_ORDER_RESULT back
        cancelling: {
          after: {
            15000: {
              target: "idle",
              actions: assign({ lastError: "Tempo esgotado ao cancelar. Tente novamente." }),
            },
          },
          on: {
            CANCEL_ORDER_RESULT: {
              target: "idle",
              actions: "storeCancelResult",
            },
          },
        },

        // Kernel executes amend_order tool, feeds AMEND_ORDER_RESULT back
        amending: {
          after: {
            15000: {
              target: "idle",
              actions: assign({ lastError: "Tempo esgotado ao alterar pedido. Tente novamente." }),
            },
          },
          on: {
            AMEND_ORDER_RESULT: {
              target: "idle",
              actions: "storeAmendResult",
            },
          },
        },

        // Kernel regenerates PIX QR code, feeds PIX_REGENERATED back
        regenerating_pix: {
          after: {
            15000: {
              target: "idle",
              actions: assign({ lastError: "Tempo esgotado ao regenerar PIX. Tente novamente." }),
            },
          },
          on: {
            PIX_REGENERATED: {
              target: "idle",
              actions: "storePixRegenResult",
            },
          },
        },
      },
    },

    // ── RESERVATION ──────────────────────────────────────────────────────────
    reservation: {
      on: {
        // Reservation sub-flow is handled by the LLM with reservation tools
        // The machine just provides the correct tool set via the synthesizer
        ADD_ITEM: {
          target: "ordering.validating_item",
          actions: ["setPendingProduct", "clearError", "setSecondaryIntent"],
        },
        GREETING: "idle",
        ASK_MENU: "browsing",
        UNKNOWN_INPUT: {
          // Stay in reservation — LLM handles conversation
        },
      },
    },

    // ── SUPPORT (handoff to human — not final, customer can return) ──────────
    support: {
      on: {
        GREETING: {
          target: "idle",
        },
      },
    },

    // ── LOYALTY CHECK ────────────────────────────────────────────────────────
    loyalty_check: {
      on: {
        LOYALTY_LOADED: {
          target: "browsing",
          actions: "storeLoyalty",
        },
        ADD_ITEM: {
          target: "ordering.validating_item",
          actions: ["setPendingProduct", "clearError", "setSecondaryIntent"],
        },
        UNKNOWN_INPUT: "browsing",
      },
    },

    // ── REORDER ───────────────────────────────────────────────────────────────
    reorder: {
      on: {
        ADD_ITEM: {
          target: "ordering.validating_item",
          actions: ["setPendingProduct", "clearError", "setSecondaryIntent"],
        },
        CHECKOUT_START: [
          { guard: "hasCartItems", target: "checkout" },
        ],
        ASK_MENU: "browsing",
        GREETING: "idle",
        UNKNOWN_INPUT: "browsing",
        SET_FULFILLMENT: { actions: "setFulfillment" },
        SET_PAYMENT: { actions: "setPayment" },
      },
    },

    // ── OBJECTION HANDLING ───────────────────────────────────────────────────
    objection: {
      on: {
        ADD_ITEM: {
          target: "ordering.validating_item",
          actions: ["setPendingProduct", "clearError", "setSecondaryIntent"],
        },
        ASK_MENU: "browsing",
        GREETING: "idle",
        UNKNOWN_INPUT: "browsing",
      },
    },

    // ── FALLBACK ─────────────────────────────────────────────────────────────
    fallback: {
      on: {
        ADD_ITEM: {
          target: "ordering.validating_item",
          actions: ["setPendingProduct", "clearError", "setSecondaryIntent"],
        },
        ASK_MENU: "browsing",
        GREETING: [
          { guard: "isNewCustomer", target: "first_contact" },
          { target: "browsing" },
        ],
        UNKNOWN_INPUT: [
          {
            guard: "fallbackLimitReached",
            target: "browsing",
            actions: ["resetFallbackCount", "setMomentumLost"],
          },
          {
            actions: "incrementFallbackCount",
          },
        ],
      },
    },
  },
})

// ── Helper to extract flat state string from snapshot ─────────────────────────

/**
 * Given an XState snapshot, returns a dot-separated state string.
 * E.g., { ordering: "validating_item" } → "ordering.validating_item"
 */
export function getStateString(snapshot: { value: unknown }): string {
  const value = snapshot.value
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 1) {
      const [parent, child] = entries[0]
      if (typeof child === "string") return `${parent}.${child}`
      if (typeof child === "object" && child !== null) {
        // Nested — recurse one more level
        const subEntries = Object.entries(child as Record<string, unknown>)
        if (subEntries.length === 1 && typeof subEntries[0][1] === "string") {
          return `${parent}.${subEntries[0][0]}.${subEntries[0][1]}`
        }
      }
    }
  }
  return "__unknown__"
}

// ── Checkout state detection ──────────────────────────────────────────────────

/**
 * Checks if a raw snapshot value represents any checkout sub-state.
 * Works with both string ("checkout") and object ({ checkout: "confirming" }) formats.
 * Used by the budget bypass to allow mid-checkout sessions to complete.
 */
export function isCheckoutState(snapshotValue: unknown): boolean {
  if (typeof snapshotValue === "string") return snapshotValue === "checkout"
  if (typeof snapshotValue === "object" && snapshotValue !== null) {
    return "checkout" in snapshotValue
  }
  return false
}

// ── Factory: create initial context for a new session ─────────────────────────

export { createDefaultContext } from "./types.js"
