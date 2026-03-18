import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as Sentry from "@sentry/node";
import { ZodError } from "zod";
import { MedusaRequestError } from "@ibatexas/tools";

const GENERIC_SERVER_ERROR_MESSAGE = "Algo deu errado. Tente novamente em instantes.";

export function registerErrorHandler(server: FastifyInstance): void {
  server.setErrorHandler(
    (error: FastifyError | ZodError | MedusaRequestError | Error, _request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({
          statusCode: 400,
          error: "Validation Error",
          issues: error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
      }

      // Upstream errors from Medusa: log full details server-side, return generic message to client
      if (error instanceof MedusaRequestError) {
        server.log.error(error, `Upstream error from ${error.upstream}`);
        Sentry.captureException(error);
        return reply.status(502).send({
          statusCode: 502,
          error: "Bad Gateway",
          message: "Erro ao comunicar com serviço externo. Tente novamente.",
        });
      }

      const statusCode = (error as FastifyError).statusCode ?? 500;

      if (statusCode >= 400 && statusCode < 500) {
        return reply.status(statusCode).send({
          statusCode,
          error: (error as FastifyError).name ?? "Error",
          message: error.message,
        });
      }

      server.log.error(error);
      Sentry.captureException(error);
      return reply.status(500).send({
        statusCode: 500,
        error: "Internal Server Error",
        message: GENERIC_SERVER_ERROR_MESSAGE,
      });
    }
  );
}
