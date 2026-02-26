// Integration tests for shipping route
// Tests the full HTTP request/response cycle via Fastify inject

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Fastify from "fastify"
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod"
import sensible from "@fastify/sensible"
import type { FastifyInstance } from "fastify"
import { shippingRoutes } from "../routes/shipping.js"

async function buildTestServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(sensible)
  await app.register(shippingRoutes)
  await app.ready()
  return app
}

describe("GET /api/shipping/estimate", () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await buildTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  it("returns PAC and SEDEX options for valid SP CEP", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/shipping/estimate?cep=01310100",
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.success).toBe(true)
    expect(body.data.options).toHaveLength(2)

    const pac = body.data.options.find((o: { service: string }) => o.service === "PAC")
    const sedex = body.data.options.find((o: { service: string }) => o.service === "SEDEX")
    expect(pac).toBeDefined()
    expect(sedex).toBeDefined()
    expect(pac.price).toBeGreaterThan(0)
    expect(sedex.price).toBeGreaterThan(0)
    expect(sedex.price).toBeGreaterThanOrEqual(pac.price)
    expect(sedex.estimatedDays).toBeLessThanOrEqual(pac.estimatedDays)
  })

  it("returns estimates for different CEP regions", async () => {
    // PR/SC/RS region (digit 8)
    const response = await server.inject({
      method: "GET",
      url: "/api/shipping/estimate?cep=80000000",
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.success).toBe(true)
    const pac = body.data.options.find((o: { service: string }) => o.service === "PAC")
    expect(pac.price).toBeGreaterThan(0)
  })

  it("returns fallback rates for unknown CEP region", async () => {
    // CEP starting with 0 — uses SHIPPING_RATE_DEFAULT
    const response = await server.inject({
      method: "GET",
      url: "/api/shipping/estimate?cep=09000000",
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.success).toBe(true)
    expect(body.data.options).toHaveLength(2)
  })

  it("returns 400 for missing CEP", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/shipping/estimate",
    })

    expect(response.statusCode).toBe(400)
  })

  it("returns 400 for CEP with wrong length", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/shipping/estimate?cep=123",
    })

    expect(response.statusCode).toBe(400)
  })

  it("returns 400 for non-numeric CEP", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/shipping/estimate?cep=ABCDEFGH",
    })

    expect(response.statusCode).toBe(400)
  })

  it("prices are integer centavos (never floats)", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/shipping/estimate?cep=01310100",
    })

    const body = response.json()
    for (const opt of body.data.options) {
      expect(Number.isInteger(opt.price)).toBe(true)
      expect(Number.isInteger(opt.estimatedDays)).toBe(true)
    }
  })
})
