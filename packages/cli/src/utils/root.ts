import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Monorepo root — works correctly whether running from:
 *   - compiled dist/  (packages/cli/dist/utils/root.js → up 4 = root)
 *   - source via tsx  (packages/cli/src/utils/root.ts  → up 4 = root)
 */
const __filename = fileURLToPath(import.meta.url)
export const ROOT = path.resolve(path.dirname(__filename), "../../../../")
