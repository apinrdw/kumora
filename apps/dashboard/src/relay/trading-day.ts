export const WIB_MS = 7 * 3_600_000

/**
 * The IDX trading day (WIB) a trade belongs to: the identity's first part.
 * Free of `effect`, because the browser's reducer uses it too.
 */
export const tradingDay = (iso: string): string =>
  new Date(Date.parse(iso) + WIB_MS).toISOString().slice(0, 10)
