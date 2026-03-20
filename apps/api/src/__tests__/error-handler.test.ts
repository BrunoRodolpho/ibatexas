// Integration tests for the error handler
// Tests ZodError → 400, 4xx passthrough, 5xx generic via Fastify inject

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Fastify from "fastify"
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod"
import { ZodTypeProvider } from "fastify-type-provider-zod"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { registerErrorHandler } from "../errors/handler.js"

async function buildTestServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  registerErrorHandler(app)

  const typed = app.withTypeProvider<ZodTypeProvider>()

  // Route that triggers ZodError when querystring is invalid
  typed.get(
    "/zod-test",
    { schema: { querystring: z.object({ name: z.string().min(3) }) } },
    async (req) => ({ name: req.query.name }),
  )

  // Route that throws a generic Error (500)
  typed.get("/boom-500", async () => {
    throw new Error("unexpected internal failure")
  })

  // Route that throws a Fastify-style 4xx error
  typed.get("/boom-404", async (_req, reply) => {
    return reply.status(404).send({
      statusCode: 404,
      error: "Not Found",
      message: "Recurso não encontrado.",
    })
  })

  await app.ready()
  return app
}

describe("Error Handler Integration", () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await buildTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  it("returns 400 with validation error for invalid input", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/zod-test?name=ab",
    })

    expect(response.statusCode).toBe(400)
    const body = response.json()
    // fastify-type-provider-zod v6 returns Fastify-standard validation errors
    expect(body.statusCode).toBe(400)
    expect(body.message).toBeDefined()
  })

  it("returns 200 for valid Zod querystring", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/zod-test?name=Alice",
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ name: "Alice" })
  })

  it("returns 500 with generic message for unexpected errors", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/boom-500",
    })

    expect(response.statusCode).toBe(500)
    const body = response.json()
    expect(body.statusCode).toBe(500)
    expect(body.error).toBe("Internal Server Error")
    // Must NOT expose internal error message
    expect(body.message).not.toContain("unexpected internal failure")
    expect(body.message).toContain("Algo deu errado")
  })

  it("passes through 404 responses", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/boom-404",
    })

    expect(response.statusCode).toBe(404)
    const body = response.json()
    expect(body.statusCode).toBe(404)
    expect(body.message).toBe("Recurso não encontrado.")
  })// returns 400 for missing required querystring param
  it("returns 400 when required querystring is missing entirely", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/zod-test",
    })

    expect(response.statusCode).toBe(400)
    const body = response.json()
    // fastify-type-provider-zod v6 returns Fastify-standard validation errors
    expect(body.statusCode).toBe(400)
    expect(body.message).toBeDefined()
  })
})
