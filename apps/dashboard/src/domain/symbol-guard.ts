import type { Symbol } from "./symbol"

/**
 * The shape of an IDX stock code; the `Symbol` schema checks this pattern.
 * `SYMBOL` in apps/stockbit-relay-extension/src/protocol.ts is a copy, and names this.
 */
export const SYMBOL_PATTERN = /^[A-Z]{4}$/

/**
 * The `Symbol` check for code that ships to the client. This module must not
 * import `effect`, or Schema lands in the client bundle.
 */
export function isSymbol(raw: unknown): raw is Symbol {
  return typeof raw === "string" && SYMBOL_PATTERN.test(raw)
}
