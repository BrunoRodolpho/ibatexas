// Re-export shared Medusa client with cart-specific aliases.
// Preserves existing function names so cart tool files need zero changes.

export { medusaStore as medusaStoreFetch, medusaAdmin as medusaAdminFetch } from "../medusa/client.js"
