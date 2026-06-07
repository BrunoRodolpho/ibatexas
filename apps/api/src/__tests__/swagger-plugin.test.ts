// Unit tests for the Swagger plugin registration (P2-CONFIG-SWAGGER).
// /docs must be opt-in in production (enumerates the whole API surface), but stay
// on outside production for local DX.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerSwagger } from "../plugins/swagger.js";

// Stub the swagger plugins so register() has something to call.
vi.mock("@fastify/swagger", () => ({ default: {} }));
vi.mock("@fastify/swagger-ui", () => ({ default: {} }));
vi.mock("fastify-type-provider-zod", () => ({ jsonSchemaTransform: () => ({}) }));

function buildFakeServer() {
  const register = vi.fn().mockResolvedValue(undefined);
  return {
    server: { register } as unknown as import("fastify").FastifyInstance,
    register,
  };
}

describe("registerSwagger", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("does NOT register swagger in production when ENABLE_SWAGGER is unset", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ENABLE_SWAGGER;

    const { server, register } = buildFakeServer();
    await registerSwagger(server);

    expect(register).not.toHaveBeenCalled();
  });

  it("does NOT register swagger in production when ENABLE_SWAGGER is not exactly 'true'", async () => {
    process.env.NODE_ENV = "production";
    process.env.ENABLE_SWAGGER = "1";

    const { server, register } = buildFakeServer();
    await registerSwagger(server);

    expect(register).not.toHaveBeenCalled();
  });

  it("registers swagger in production when ENABLE_SWAGGER === 'true' (opt-in)", async () => {
    process.env.NODE_ENV = "production";
    process.env.ENABLE_SWAGGER = "true";

    const { server, register } = buildFakeServer();
    await registerSwagger(server);

    // swagger core + swagger-ui = two registrations
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("registers swagger outside production by default", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.ENABLE_SWAGGER;

    const { server, register } = buildFakeServer();
    await registerSwagger(server);

    expect(register).toHaveBeenCalledTimes(2);
  });
});
