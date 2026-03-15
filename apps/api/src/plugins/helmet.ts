import helmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";

export async function registerHelmet(server: FastifyInstance): Promise<void> {
  await server.register(helmet, {
    // Strict CSP for a JSON API (no HTML rendering)
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'none'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // Prevent clickjacking
    xFrameOptions: { action: "deny" as const },
    // HSTS — enforce HTTPS in production
    hsts: process.env.NODE_ENV === "production"
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
    // Privacy-preserving referrer policy
    referrerPolicy: { policy: "strict-origin-when-cross-origin" as const },
  });
}
