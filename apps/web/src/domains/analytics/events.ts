/**
 * IbateXas Analytics Event Taxonomy
 *
 * All analytics events are defined here as a single union type.
 * When adding a new event:
 * 1. Add it to AnalyticsEvent below
 * 2. Document it in docs/analytics-dashboards.md
 */

export type AnalyticsEvent =
  // ── Storefront ─────────────────────────────────────────────────
  | 'quick_add_clicked'
  | 'add_to_cart'
  | 'sticky_cta_used'
  | 'pdp_viewed'
  | 'product_card_clicked'
  | 'cross_sell_viewed'
  | 'cross_sell_added'
  // ── Cart ───────────────────────────────────────────────────────
  | 'cart_drawer_opened'
  | 'cart_abandonment_nudge'
  // ── Checkout ───────────────────────────────────────────────────
  | 'checkout_started'
  | 'checkout_step_completed'
  | 'checkout_error'
  | 'checkout_abandoned'
  | 'checkout_completed'
  // ── Session ────────────────────────────────────────────────────
  | 'session_started'
  // ── PDP / Content ──────────────────────────────────────────────
  | 'pdp_scroll_depth'
  | 'review_link_clicked'
  | 'storytelling_section_viewed'
  // ── Search & Navigation ────────────────────────────────────────
  | 'filter_applied'
  | 'search_performed'
  | 'search_synonym_resolved'
  | 'trending_search_clicked'
  // ── Wishlist ───────────────────────────────────────────────────
  | 'wishlist_toggled'
  // ── Recommendations ──────────────────────────────────────────
  | 'also_added_viewed'
  | 'also_added_cart'
  | 'homepage_recs_clicked'
  // ── Reorder ──────────────────────────────────────────────────
  | 'reorder_completed'
  // ── Conversion UX ─────────────────────────────────────────────
  | 'upsell_toast_shown'
  | 'upsell_toast_added'
  | 'upsell_toast_dismissed'
  | 'quantity_changed_inline'
  | 'layout_toggled'
  | 'combo_banner_clicked'
  | 'review_section_viewed'
  | 'people_also_ordered_added'
  // ── WhatsApp Channel ──────────────────────────────────────────
  | 'whatsapp_message_received'
  | 'whatsapp_message_sent'
  | 'whatsapp_session_started'
  | 'whatsapp_agent_error'
  | 'whatsapp_interactive_list_sent'
  | 'whatsapp_interactive_button_sent'
  | 'whatsapp_interactive_selected'
