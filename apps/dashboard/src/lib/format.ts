export const MINUS = "−"

// Decision: en-US separators with K/M/B suffixes, replacing id-ID (issue #137).
const nfInt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})
const nf2 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const nfUpTo2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })
const timeWib = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jakarta",
  hourCycle: "h23",
})
const secondsWib = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "Asia/Jakarta",
  hourCycle: "h23",
})
const dateTimeWib = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jakarta",
  hourCycle: "h23",
})

// A WIB date names its own calendar day: read it at UTC midnight.
const dayOfDate = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
})

export type Direction = "up" | "down" | "flat"

export function direction(n: number): Direction {
  return n > 0 ? "up" : n < 0 ? "down" : "flat"
}

export function sign(n: number): string {
  return n > 0 ? "+" : n < 0 ? MINUS : ""
}

/** Rp9,275 */
export function idr(n: number): string {
  return "Rp" + nfInt.format(Math.abs(n))
}

/** 9,275 or 7,243.18 */
export function plain(n: number, digits: 0 | 1 | 2 = 0): string {
  const f = digits === 2 ? nf2 : digits === 1 ? nf1 : nfInt
  return f.format(n)
}

/** +1.35% */
export function pct(n: number): string {
  return n === 0 ? "0.00%" : sign(n) + nf2.format(Math.abs(n)) + "%"
}

/** +90, −1.5 */
export function signed(n: number, digits: 0 | 1 | 2 = 0): string {
  return sign(n) + plain(Math.abs(n), digits)
}

/** Unsigned magnitude with a K, M or B suffix: 1.23 B, 12.4 M, 950. B is the largest. */
export function compact(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return nfUpTo2.format(a / 1e9) + " B"
  if (a >= 1e6) return nfUpTo2.format(a / 1e6) + " M"
  if (a >= 1e3) return nfUpTo2.format(a / 1e3) + " K"
  return nfInt.format(a)
}

/** −Rp1.23 B */
export function compactIdr(n: number): string {
  return sign(n) + "Rp" + compact(n)
}

/** 12.4 M shares */
export function shares(n: number): string {
  return compact(n) + " shares"
}

/** 14:45 WIB */
export function asOf(iso: string): string {
  return timeWib.format(new Date(iso)) + " WIB"
}

/** A tape row's time in WIB, to the second: 09:00:07 */
export function tapeTime(epochMillis: number): string {
  return secondsWib.format(new Date(epochMillis))
}

/** Oct 24, 14:45 WIB */
export function dateTime(iso: string): string {
  return dateTimeWib.format(new Date(iso)) + " WIB"
}

/** A `YYYY-MM-DD` trading day: Fri, Nov 6 */
export function dayLabel(date: string): string {
  return dayOfDate.format(new Date(`${date}T00:00:00Z`))
}

/** Orca's tape style, whole billions: +Rp318 B */
export function billionShort(n: number): string {
  return `${sign(n)}Rp${plain(Math.abs(n) / 1e9)} B`
}
