// Prisma 7 configuration — centralizes datasource URL (previously in schema.prisma).
// See https://www.prisma.io/docs/orm/reference/prisma-config-reference
//
// Uses process.env instead of prisma env() helper so that `prisma generate`
// works in CI/Docker stages where DATABASE_URL is not yet available.

import "dotenv/config"
import { defineConfig } from "prisma/config"

export default defineConfig({
  schema: "./prisma/schema.prisma",
  migrations: {
    path: "./prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
})
