// The order book radar's scanner (spec apinrdw/kumora#517, "The scanner"):
// which codes it covers, how it splits them into the Bid-heavy and
// Offer-heavy halves, and how Rank by orders each half.
import type { BookEvent, BookReadings, StockCode } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { LOWEST_READ_CLOSE } from "./book-readings"
import { compact, plain } from "./format"

export type RankKey =
  | "imbalance"
  | "bidDepth"
  | "offerDepth"
  | "emptyTicks"
  | "spread"
  | "lotsPerOrder"
  | "lastEvent"
  | "eventsInFive"
  | "bookAge"

// Rank by's choices, in the menu's order.
export const RANK_CHOICES: ReadonlyArray<{
  readonly value: RankKey
  readonly label: string
}> = [
  { value: "imbalance", label: "Imbalance" },
  { value: "bidDepth", label: "Near depth bid" },
  { value: "offerDepth", label: "Near depth offer" },
  { value: "emptyTicks", label: "Empty ticks" },
  { value: "spread", label: "Spread %" },
  { value: "lotsPerOrder", label: "Lots per order" },
  { value: "lastEvent", label: "Last event" },
  { value: "eventsInFive", label: "Events in 5 minutes" },
  { value: "bookAge", label: "Book age" },
]

// The value floor's choices, in rupiah.
export const FLOORS = [100e6, 1e9, 10e9, 50e9] as const
export type Floor = (typeof FLOORS)[number]

export interface RadarSettings {
  readonly floor: Floor
  readonly codes: "all" | "watchlist"
  readonly search: string
  readonly priceMin: number | undefined
  readonly priceMax: number | undefined
  readonly rankBy: RankKey
  // High → low, or Low → high.
  readonly direction: "high" | "low"
}

// Decision: the floor is Rp1 B by default, ranked by Imbalance, most
// lopsided first, with no price band. See spec apinrdw/kumora#517, "The
// scanner".
export const DEFAULT_SETTINGS: RadarSettings = {
  floor: 1e9,
  codes: "all",
  search: "",
  priceMin: undefined,
  priceMax: undefined,
  rankBy: "imbalance",
  direction: "high",
}

// Decision: a row whose book hasn't changed for 60 s greys out and sinks to
// the end of its half. See spec apinrdw/kumora#517, "The scanner".
const STALE_MS = 60_000

// A code's figures besides its readings (relay scanner-figures.ts), its last
// price kept current by the deltas' candles.
export interface CodeFigures {
  readonly last: number | undefined
  readonly previousClose: number | undefined
  readonly previousValue: number | undefined
}

// Decision: Events in 5 minutes counts a code's book events of the last 5
// minutes on the object's clock, and the row's last-event chip shows only
// an event that recent. See spec apinrdw/kumora#517, "Book events".
export const RECENT_EVENTS_MS = 300_000

// A code's book events as the scanner ranks them: its newest of the day,
// and how many of the last RECENT_EVENTS_MS.
export interface CodeEvents {
  readonly last: BookEvent
  readonly inFiveMinutes: number
}

export interface ScanInput {
  readonly readings: ReadonlyArray<BookReadings>
  readonly figures: ReadonlyMap<StockCode, CodeFigures>
  // The Special Monitoring Board's codes.
  readonly board: ReadonlySet<StockCode>
  readonly watchlist: ReadonlySet<StockCode>
  // Codes with a book event today.
  readonly events: ReadonlyMap<StockCode, CodeEvents>
  // On the market clock, in epoch ms.
  readonly now: number
}

export interface Scan {
  // Each half's codes, ranked.
  readonly bid: ReadonlyArray<StockCode>
  readonly offer: ReadonlyArray<StockCode>
  // Codes at a limit: listed, not ranked.
  readonly limits: ReadonlyArray<{
    readonly code: StockCode
    readonly limit: "upper" | "lower"
  }>
  // Codes above the floor, before the filters.
  readonly above: number
  // Special Monitoring Board codes, and the other codes at Rp1–10.
  readonly board: number
  readonly cheap: number
}

const bookAge = (readings: BookReadings, now: number) =>
  Math.max(0, now - DateTime.toEpochMillis(readings.at))

export const isStale = (readings: BookReadings, now: number) =>
  bookAge(readings, now) > STALE_MS

const sumOf = (a: number | undefined, b: number | undefined) =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)

// What Rank by orders by; none sorts last either way. Last event ranks by
// its time, so High → low puts the newest first.
const rankValue = (
  readings: BookReadings,
  key: RankKey,
  now: number,
  events: CodeEvents | undefined
): number | undefined => {
  switch (key) {
    case "imbalance":
      return readings.imbalance === undefined
        ? undefined
        : Math.abs(readings.imbalance)
    case "bidDepth":
      return readings.bid.depth
    case "offerDepth":
      return readings.offer.depth
    case "emptyTicks":
      return readings.bid.emptyTicks + readings.offer.emptyTicks
    case "spread":
      return readings.spread?.percent
    case "lotsPerOrder":
      return sumOf(readings.bid.lotsPerOrder, readings.offer.lotsPerOrder)
    case "lastEvent":
      return events && DateTime.toEpochMillis(events.last.at)
    case "eventsInFive":
      return events?.inFiveMinutes ?? 0
    case "bookAge":
      return bookAge(readings, now)
  }
}

// One half's order: stale books last, then by the key in the direction
// asked, none last, then by code.
const ranked = (
  half: ReadonlyArray<BookReadings>,
  settings: RadarSettings,
  input: ScanInput
) => {
  const { now } = input
  const sign = settings.direction === "high" ? -1 : 1
  const keyed = half.map((readings) => ({
    readings,
    stale: isStale(readings, now),
    value: rankValue(
      readings,
      settings.rankBy,
      now,
      input.events.get(readings.code)
    ),
  }))
  keyed.sort(
    (a, b) =>
      Number(a.stale) - Number(b.stale) ||
      Number(a.value === undefined) - Number(b.value === undefined) ||
      (a.value === undefined || b.value === undefined
        ? 0
        : (a.value - b.value) * sign) ||
      a.readings.code.localeCompare(b.readings.code)
  )
  return keyed.map(({ readings }) => readings.code)
}

// A code's previous close, or its last price while none is known: Rp10 or
// less keeps it off the scanner.
const isCheap = (figures: CodeFigures | undefined) => {
  const close = figures?.previousClose ?? figures?.last
  return close !== undefined && close <= LOWEST_READ_CLOSE
}

const passesFilters = (
  readings: BookReadings,
  figures: CodeFigures | undefined,
  input: ScanInput,
  settings: RadarSettings
) => {
  if (settings.codes === "watchlist" && !input.watchlist.has(readings.code))
    return false
  const search = settings.search.trim().toUpperCase()
  if (search !== "" && !readings.code.startsWith(search)) return false
  const { priceMin, priceMax } = settings
  if (priceMin === undefined && priceMax === undefined) return true
  const last = figures?.last
  if (last === undefined) return false
  return last >= (priceMin ?? 0) && last <= (priceMax ?? Infinity)
}

// Decision: a code joins the scanner when its value today or on the
// previous trading day, whichever is larger, reaches the floor; with no
// previous day's value (after a gap), today's alone. Special Monitoring
// Board codes and codes at Rp1–10 never join. See spec apinrdw/kumora#517,
// "The scanner".
export const scan = (input: ScanInput, settings: RadarSettings) =>
  Effect.sync((): Scan => {
    let above = 0
    let cheap = 0
    const bid: Array<BookReadings> = []
    const offer: Array<BookReadings> = []
    const limits: Array<Scan["limits"][number]> = []
    for (const readings of input.readings) {
      if (input.board.has(readings.code)) continue
      const figures = input.figures.get(readings.code)
      if (isCheap(figures)) {
        cheap++
        continue
      }
      const value = Math.max(readings.value, figures?.previousValue ?? 0)
      if (value < settings.floor) continue
      above++
      if (!passesFilters(readings, figures, input, settings)) continue
      if (readings.limit !== undefined)
        limits.push({ code: readings.code, limit: readings.limit })
      else if (readings.imbalance === undefined) continue
      else if (readings.imbalance >= 0) bid.push(readings)
      else offer.push(readings)
    }
    return {
      bid: ranked(bid, settings, input),
      offer: ranked(offer, settings, input),
      limits: limits.sort((a, b) => a.code.localeCompare(b.code)),
      above,
      board: input.board.size,
      cheap,
    }
  })

const rupiah = (value: number) => Effect.map(compact(value), (n) => `Rp${n}`)

const perOrder = (value: number | undefined) =>
  value === undefined ? Effect.succeed("—") : plain(value, 0)

// A book's age: 12s, or 3m from a minute.
const ageText = (ms: number) =>
  Effect.succeed(
    ms < 60_000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m`
  )

// The row's figure for what it is ranked by: the heavy side's near depth
// when ranked by Imbalance.
export const rankedFigure = Effect.fnUntraced(function* (
  readings: BookReadings,
  key: RankKey,
  now: number,
  events?: CodeEvents
) {
  switch (key) {
    case "imbalance":
      return yield* rupiah(
        (readings.imbalance ?? 0) >= 0
          ? readings.bid.depth
          : readings.offer.depth
      )
    case "bidDepth":
      return yield* rupiah(readings.bid.depth)
    case "offerDepth":
      return yield* rupiah(readings.offer.depth)
    case "emptyTicks":
      return `${readings.bid.emptyTicks} / ${readings.offer.emptyTicks} empty`
    case "spread":
      return readings.spread === undefined
        ? "—"
        : `${readings.spread.ticks}t · ${yield* plain(readings.spread.percent, 2)}%`
    case "lotsPerOrder":
      return `${yield* perOrder(readings.bid.lotsPerOrder)} / ${yield* perOrder(readings.offer.lotsPerOrder)} lots/ord`
    case "lastEvent":
      return events === undefined
        ? "—"
        : `${yield* ageText(Math.max(0, now - DateTime.toEpochMillis(events.last.at)))} ago`
    case "eventsInFive":
      return `${events?.inFiveMinutes ?? 0} in 5m`
    case "bookAge":
      return yield* ageText(bookAge(readings, now))
  }
})
