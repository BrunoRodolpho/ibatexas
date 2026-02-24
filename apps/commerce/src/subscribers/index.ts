// Medusa v2 auto-discovers subscribers from this directory by convention.
// Each file exports a default handler and a config object.
export { default as productCreatedHandler } from "./product-created.js"
export { default as productUpdatedHandler } from "./product-updated.js"
export { default as productDeletedHandler } from "./product-deleted.js"
