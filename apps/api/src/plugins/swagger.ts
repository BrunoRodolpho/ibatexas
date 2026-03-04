import { createRequire } from "node:module";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

export async function registerSwagger(server: FastifyInstance): Promise<void> {
  await server.register(swagger, {
    openapi: {
      info: {
        title: "IbateXas API",
        description: "API do assistente de restaurante IbateXas",
        version,
      },
      tags: [
        { name: "health", description: "Status do serviço" },
        { name: "auth", description: "Autenticação (OTP via WhatsApp)" },
        { name: "chat", description: "Conversas com o agente" },
        { name: "catalog", description: "Catálogo de produtos e categorias" },
        { name: "cart", description: "Carrinho de compras" },
        { name: "shipping", description: "Estimativa de entrega" },
        { name: "reservations", description: "Reservas de mesa" },
        { name: "analytics", description: "Tracking de eventos" },
        { name: "webhooks", description: "Webhooks (Stripe)" },
        { name: "admin", description: "Painel administrativo" },
      ],
    },
  });

  await server.register(swaggerUi, {
    routePrefix: "/api/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: false,
    },
  });
}
