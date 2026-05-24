/**
 * IbateXas Analytics Event Taxonomy
 *
 * All analytics events are defined here as a single union type.
 * When adding a new event:
 * 1. Add it to AnalyticsEvent below
 * 2. Document it in docs/ops/analytics-dashboards.md
 */

export type AnalyticsEvent =
  // ── Storefront ─────────────────────────────────────────────────
  | 'quick_add_clicked'
  | 'quick_add_failed'
  | 'add_to_cart'
  | 'sticky_cta_used'
  | 'pdp_viewed'
  | 'product_card_clicked'
  | 'cross_sell_viewed'
  | 'cross_sell_added'
  | 'pdp_cross_sell_added'
  // ── Cart ───────────────────────────────────────────────────────
  | 'cart_drawer_opened'
  | 'cart_abandonment_nudge'
  | 'coupon_validation_failed'
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
  | 'homepage_recs_viewed'
  | 'home_carousel_viewed'
  | 'search_results_viewed'
  | 'cart_drawer_cross_sell_viewed'
  | 'pdp_cross_sell_viewed'
  // ── Reorder ──────────────────────────────────────────────────
  | 'reorder_completed'
  // ── Order Tracking ──────────────────────────────────────────────
  | 'order_status_viewed'
  | 'order_timeline_viewed'
  | 'order_history_viewed'
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
  // ── Consent ───────────────────────────────────────────────────
  | 'cookie_consent_given'
  | 'cookie_consent_rejected'
  // ── Acquisition ─────────────────────────────────────────────
  | 'first_order_completed'
  | 'welcome_credit_applied'
  | 'qr_code_scanned'
  | 'whatsapp_cta_clicked'
  | 'utm_source_captured'
  // ── Proactive Outreach ──────────────────────────────────────
  | 'proactive_nudge_sent'
  | 'proactive_nudge_converted'
  // ── Agent Performance ──────────────────────────────────────
  | 'wa_conversation_started'
  | 'wa_conversation_converted'
  | 'wa_follow_up_scheduled'
  | 'wa_follow_up_converted'
  | 'loyalty_stamp_earned'
  | 'loyalty_reward_redeemed'
  // ── Kitchen Closed ─────────────────────────────────────────────
  | 'kitchen_closed_checkout_blocked'
  | 'kitchen_closed_items_removed'
  | 'kitchen_closed_banner_viewed'
  // ── Payment Lifecycle ──────────────────────────────────────────
  | 'payment_retry_initiated'
  | 'payment_method_switched'
  | 'pix_regenerated'
  | 'order_note_added'
  | 'order_amended'
  | 'order_canceled_by_customer'
  // ── IBX-IGE Audit (v2.0 — kernel observability) ────────────────
  | 'audit_kernel_shadow_diverged_basis'
  | 'audit_kernel_shadow_diverged_kind'
  | 'audit_kernel_shadow_diverged_rewrite'
  | 'audit_decision_executed'
  | 'audit_decision_refused'
  | 'audit_ledger_hit'
  | 'audit_nats_sink_failed'
  | 'audit_replay_divergence'
