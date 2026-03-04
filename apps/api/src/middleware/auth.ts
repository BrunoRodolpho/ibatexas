// Auth middleware for Fastify.
// Extracts the JWT from the `token` httpOnly cookie and attaches
// request.customerId + request.userType so route handlers can access them.
//
// Usage:
//   requireAuth  — throws 401 if no valid JWT
//   optionalAuth — attaches fields if JWT present, no-op otherwise

import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from "fastify";

// Extend Fastify's request type with our custom fields
declare module "fastify" {
  interface FastifyRequest {
    customerId?: string;
    userType?: "guest" | "customer" | "staff";
  }
}

async function extractAuth(request: FastifyRequest): Promise<void> {
  try {
    // @fastify/jwt decorates server with jwtVerify — call it here
    await (request as unknown as { jwtVerify: () => Promise<void> }).jwtVerify();
    const payload = (request as unknown as { user: { sub: string; userType: string } }).user;
    request.customerId = payload.sub;
    request.userType = payload.userType as "guest" | "customer" | "staff";
  } catch {
    // Invalid or missing JWT — caller decides whether to throw
  }
}

/**
 * preHandler: requires a valid JWT cookie.
 * Returns 401 if missing or invalid.
 */
export const requireAuth: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  await extractAuth(request);
  if (!request.customerId) {
    return reply
      .code(401)
      .send({ statusCode: 401, error: "Unauthorized", message: "Autenticação necessária." });
  }
};

/**
 * preHandler: attaches auth fields if a valid JWT cookie is present.
 * Does nothing if the cookie is absent or invalid.
 */
export const optionalAuth: preHandlerHookHandler = async (request: FastifyRequest) => {
  await extractAuth(request);
};
