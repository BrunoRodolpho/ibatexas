import type { FastifyInstance } from "fastify";
import { healthRoutes } from "./health.js";
import { authRoutes } from "./auth.js";
import { chatRoutes } from "./chat.js";
import { catalogRoutes } from "./catalog.js";
import { cartRoutes } from "./cart.js";
import { shippingRoutes } from "./shipping.js";
import { stripeWebhookRoutes } from "./stripe-webhook.js";
import { whatsappWebhookRoutes } from "./whatsapp-webhook.js";
import { adminRoutes } from "./admin/index.js";
import { reservationRoutes } from "./reservations.js";
import { analyticsRoutes } from "./analytics.js";
import { recommendationRoutes } from "./recommendations.js";
import { meRoutes } from "./me.js";
import { customerOrderRoutes } from "./customer-orders.js";
import { orderActionRoutes } from "./order-actions.js";
import { scheduleStatusRoutes } from "./schedule-status.js";
import { bannerRoutes } from "./banner.js";

export async function registerRoutes(server: FastifyInstance): Promise<void> {
  // Webhooks must be registered before JSON body parser middlewares
  await server.register(stripeWebhookRoutes);
  await server.register(whatsappWebhookRoutes);

  await server.register(healthRoutes);
  await server.register(authRoutes);
  await server.register(chatRoutes);
  await server.register(catalogRoutes);
  await server.register(cartRoutes);
  await server.register(shippingRoutes);
  await server.register(adminRoutes);
  await server.register(reservationRoutes);
  await server.register(analyticsRoutes);
  await server.register(recommendationRoutes);
  await server.register(meRoutes);
  await server.register(customerOrderRoutes);
  await server.register(orderActionRoutes);
  await server.register(scheduleStatusRoutes);
  await server.register(bannerRoutes);
}
