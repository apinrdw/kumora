declare const asOfBrand: unique symbol
declare const asOfMonthBrand: unique symbol

/** A file's As-of: a real calendar date, `YYYY-MM-DD`. */
export type AsOf = string & { readonly [asOfBrand]: true }
/** The month a monthly feed's As-of falls in, `YYYY-MM`. Never a file's As-of. */
export type AsOfMonth = string & { readonly [asOfMonthBrand]: true }

/** The UTC date of an instant, so of a WIB date when the instant is already shifted to WIB. */
export const asOfOfInstant = (ms: number) =>
  new Date(ms).toISOString().slice(0, "YYYY-MM-DD".length) as AsOf

export const monthOfInstant = (ms: number) =>
  new Date(ms).toISOString().slice(0, "YYYY-MM".length) as AsOfMonth

/** Null for anything but a real calendar date. */
export const parseAsOf = (value: string): AsOf | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const ms = Date.parse(value)
  return !Number.isNaN(ms) && asOfOfInstant(ms) === value
    ? (value as AsOf)
    : null
}
