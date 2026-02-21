import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export function registerErrorHandler(server: FastifyInstance): void {
  server.setErrorHandler(
    (error: FastifyError | ZodError | Error, _request: FastifyRequest, reply: FastifyReply) => {
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
        message: "Algo deu errado. Tente novamente em instantes.",
      });
    }
  );
}
