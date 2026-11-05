export const MINUS = "−"

const nfInt = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})
const nf2 = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const timeWib = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jakarta",
  hour12: false,
})
const dateTimeWib = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jakarta",
  hour12: false,
})

export type Direction = "up" | "down" | "flat"

export function direction(n: number): Direction {
  return n > 0 ? "up" : n < 0 ? "down" : "flat"
}

export function sign(n: number): string {
  return n > 0 ? "+" : n < 0 ? MINUS : ""
}

/** Rp9.275 */
export function idr(n: number): string {
  return "Rp" + nfInt.format(Math.abs(n))
}

/** 9.275 or 7.243,18 */
export function plain(n: number, digits: 0 | 1 | 2 = 0): string {
  const f = digits === 2 ? nf2 : digits === 1 ? nf1 : nfInt
  return f.format(n)
}

/** +1,35% */
export function pct(n: number): string {
  return n === 0 ? "0,00%" : sign(n) + nf2.format(Math.abs(n)) + "%"
}

/** +90, −1,5 */
export function signed(n: number, digits: 0 | 1 | 2 = 0): string {
  return sign(n) + plain(Math.abs(n), digits)
}

/** −Rp128,6 miliar */
export function compactIdr(n: number): string {
  const a = Math.abs(n)
  const s = sign(n)
  if (a >= 1e12) return `${s}Rp${nf1.format(a / 1e12)} triliun`
  if (a >= 1e9) return `${s}Rp${nf1.format(a / 1e9)} miliar`
  if (a >= 1e6) return `${s}Rp${nf1.format(a / 1e6)} juta`
  return s + "Rp" + nfInt.format(a)
}

/** 12,4 juta lembar */
export function shares(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return nf1.format(a / 1e9) + " miliar lembar"
  if (a >= 1e6) return nf1.format(a / 1e6) + " juta lembar"
  if (a >= 1e3) return nf1.format(a / 1e3) + " ribu lembar"
  return nfInt.format(a) + " lembar"
}

/** 14.45 WIB */
export function asOf(iso: string): string {
  return timeWib.format(new Date(iso)).replace(":", ".") + " WIB"
}

/** 24 Okt 14.45 WIB */
export function dateTime(iso: string): string {
  return dateTimeWib.format(new Date(iso)).replace(":", ".") + " WIB"
}

/** Orca's tape style, in miliar: +Rp318 M */
export function miliarShort(n: number): string {
  return `${sign(n)}Rp${plain(Math.abs(n) / 1e9)} M`
}
