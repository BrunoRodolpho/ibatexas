/**
 * machines/ — domain state machines.
 *
 * In v2.0 the IbateXas order-machine moves to `@ibx/intent-domain-order`
 * alongside the policies. This subpath stays for adapters that want to share
 * a generic machine across tenants.
 */

export { orderMachine, getStateString } from "@ibatexas/llm-provider"
