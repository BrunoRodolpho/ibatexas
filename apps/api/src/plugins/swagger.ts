import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";

// eslint-disable-next-line @typescript-eslint/no-var-requires
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
        { name: "chat", description: "Conversas com o agente" },
        { name: "catalog", description: "Catálogo de produtos" },
        { name: "health", description: "Status do serviço" },
      ],
    },
  });

  await server.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: false,
    },
  });
}
