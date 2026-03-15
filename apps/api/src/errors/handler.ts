import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { UpstreamError } from "./upstream-error.js";

const GENERIC_SERVER_ERROR_MESSAGE = "Algo deu errado. Tente novamente em instantes.";

export function registerErrorHandler(server: FastifyInstance): void {
  server.setErrorHandler(
    (error: FastifyError | ZodError | UpstreamError | Error, _request: FastifyRequest, reply: FastifyReply) => {
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

      // Upstream errors: log full details server-side, return generic message to client
      if (error instanceof UpstreamError) {
        server.log.error(error, `Upstream error from ${error.upstream}`);
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
      return reply.status(500).send({
        statusCode: 500,
        error: "Internal Server Error",
        message: GENERIC_SERVER_ERROR_MESSAGE,
      });
    }
  );
}
