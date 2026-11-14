import type { WibDate } from "@workspace/relay"
import { Effect } from "effect"

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

export const direction = (n: number) =>
  Effect.sync((): Direction => (n > 0 ? "up" : n < 0 ? "down" : "flat"))

export const sign = (n: number) =>
  Effect.sync(() => (n > 0 ? "+" : n < 0 ? MINUS : ""))

/** Rp9,275 */
export const idr = (n: number) =>
  Effect.sync(() => "Rp" + nfInt.format(Math.abs(n)))

/** 9,275 or 7,243.18 */
export const plain = (n: number, digits: 0 | 1 | 2 = 0) =>
  Effect.sync(() => (digits === 2 ? nf2 : digits === 1 ? nf1 : nfInt).format(n))

/** +1.35% */
export const pct = (n: number) =>
  n === 0
    ? Effect.succeed("0.00%")
    : Effect.map(sign(n), (s) => s + nf2.format(Math.abs(n)) + "%")

/** A price: 9,275 for a stock, 7,243.18 for an index, whose prices are fractional. */
export const price = (n: number) => plain(n, Number.isInteger(n) ? 0 : 2)

/** +90, −1.5 */
export const signed = Effect.fnUntraced(function* (
  n: number,
  digits: 0 | 1 | 2 = 0
) {
  return (yield* sign(n)) + (yield* plain(Math.abs(n), digits))
})

/** Unsigned magnitude with a K, M or B suffix: 1.23 B, 12.4 M, 950. B is the largest. */
export const compact = (n: number) =>
  Effect.sync(() => {
    const a = Math.abs(n)
    if (a >= 1e9) return nfUpTo2.format(a / 1e9) + " B"
    if (a >= 1e6) return nfUpTo2.format(a / 1e6) + " M"
    if (a >= 1e3) return nfUpTo2.format(a / 1e3) + " K"
    return nfInt.format(a)
  })

/** −Rp1.23 B */
export const compactIdr = Effect.fnUntraced(function* (n: number) {
  return (yield* sign(n)) + "Rp" + (yield* compact(n))
})

/** 1,250 or 0.25: a lot is 100 shares, so an odd lot needs its hundredths */
export const lots = (n: number) => Effect.sync(() => nfUpTo2.format(n))

/** 12.4 M shares */
export const shares = (n: number) =>
  Effect.map(compact(n), (figure) => figure + " shares")

/** An instant's WIB clock time, 24-hour: 14:45 */
export const wibClock = (epochMillis: number) =>
  Effect.sync(() => timeWib.format(epochMillis))

/** 14:45 WIB */
export const asOf = (iso: string) =>
  Effect.sync(() => timeWib.format(new Date(iso)) + " WIB")

/** A tape row's time in WIB, to the second: 09:00:07 */
export const tapeTime = (epochMillis: number) =>
  Effect.sync(() => secondsWib.format(new Date(epochMillis)))

/** A feed lag in ms, to the second under a minute and to the minute above: 6s, 17m */
export const feedLag = (ms: number) =>
  Effect.sync(() => {
    const seconds = Math.round(ms / 1000)
    return seconds < 60 ? `${seconds}s` : `${Math.round(ms / 60_000)}m`
  })

/** Oct 24, 14:45 WIB */
export const dateTime = (iso: string) =>
  Effect.sync(() => dateTimeWib.format(new Date(iso)) + " WIB")

/** A `YYYY-MM-DD` trading day: Fri, Nov 6 */
export const dayLabel = (date: WibDate) =>
  Effect.sync(() => dayOfDate.format(new Date(`${date}T00:00:00Z`)))

/** Orca's tape style, whole billions: +Rp318 B */
export const billionShort = Effect.fnUntraced(function* (n: number) {
  return `${yield* sign(n)}Rp${yield* plain(Math.abs(n) / 1e9)} B`
})
