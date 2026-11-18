// The order book radar's scanner (spec apinrdw/kumora#517, "The scanner"):
// which codes it covers, how it splits them into the Bid-heavy and
// Offer-heavy halves, and how Rank by orders each half.
import type {
  BookEvent,
  BookReadings,
  Limit,
  StockCode,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { LOWEST_READ_CLOSE } from "./book-readings"
import { compact, plain } from "./format"

// A row as Rank by reads it: its readings, its book events and the market
// clock's now, in epoch ms.
interface RankedRow {
  readonly readings: BookReadings
  readonly events: CodeEvents | undefined
  readonly now: number
}

// What one Rank by choice orders by (none sorts last either way) and the
// figure a row shows for it.
interface Ranking {
  readonly label: string
  readonly value: (row: RankedRow) => Effect.Effect<number | undefined>
  readonly figure: (row: RankedRow) => Effect.Effect<string>
}

const bookAge = ({ readings, now }: RankedRow) =>
  Effect.succeed(Math.max(0, now - DateTime.toEpochMillis(readings.at)))

// The side the imbalance leans to: bids at a balanced book.
const heavySide = (readings: BookReadings) =>
  Effect.succeed((readings.imbalance ?? 0) >= 0 ? readings.bid : readings.offer)

const rupiah = (value: number) => Effect.map(compact(value), (n) => `Rp${n}`)

const perOrder = (value: number | undefined) =>
  value === undefined ? Effect.succeed("—") : plain(value, 0)

// A book's age: 12s, or 3m from a minute.
const ageText = (ms: number) =>
  Effect.succeed(
    ms < 60_000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m`
  )

// Rank by's choices, in the menu's order. Imbalance and Lots per order read
// the heavy side, and its row shows that side's figure. Last event ranks by
// its time, so High → low puts the newest first.
const RANKINGS = {
  imbalance: {
    label: "Imbalance",
    value: ({ readings }) =>
      Effect.succeed(
        readings.imbalance === undefined
          ? undefined
          : Math.abs(readings.imbalance)
      ),
    figure: Effect.fnUntraced(function* ({ readings }) {
      return yield* rupiah((yield* heavySide(readings)).nearDepth)
    }),
  },
  bidDepth: {
    label: "Near depth bid",
    value: ({ readings }) => Effect.succeed(readings.bid.nearDepth),
    figure: ({ readings }) => rupiah(readings.bid.nearDepth),
  },
  offerDepth: {
    label: "Near depth offer",
    value: ({ readings }) => Effect.succeed(readings.offer.nearDepth),
    figure: ({ readings }) => rupiah(readings.offer.nearDepth),
  },
  emptyTicks: {
    label: "Empty ticks",
    value: ({ readings }) =>
      Effect.succeed(readings.bid.emptyTicks + readings.offer.emptyTicks),
    figure: ({ readings }) =>
      Effect.succeed(
        `${readings.bid.emptyTicks} / ${readings.offer.emptyTicks} empty`
      ),
  },
  spread: {
    label: "Spread %",
    value: ({ readings }) => Effect.succeed(readings.spread?.percent),
    figure: Effect.fnUntraced(function* ({ readings }) {
      return readings.spread === undefined
        ? "—"
        : `${readings.spread.ticks}t · ${yield* plain(readings.spread.percent, 2)}%`
    }),
  },
  lotsPerOrder: {
    label: "Lots per order",
    value: ({ readings }) =>
      Effect.map(heavySide(readings), (side) => side.lotsPerOrder),
    figure: Effect.fnUntraced(function* ({ readings }) {
      const side = yield* heavySide(readings)
      return `${yield* perOrder(side.lotsPerOrder)} lots/ord`
    }),
  },
  lastEvent: {
    label: "Last event",
    value: ({ events }) =>
      Effect.succeed(events && DateTime.toEpochMillis(events.last.at)),
    figure: Effect.fnUntraced(function* ({ events, now }) {
      return events === undefined
        ? "—"
        : `${yield* ageText(Math.max(0, now - DateTime.toEpochMillis(events.last.at)))} ago`
    }),
  },
  eventsInFive: {
    label: "Events in 5 minutes",
    value: ({ events }) => Effect.succeed(events?.inFiveMinutes ?? 0),
    figure: ({ events }) =>
      Effect.succeed(`${events?.inFiveMinutes ?? 0} in 5m`),
  },
  bookAge: {
    label: "Book age",
    value: bookAge,
    figure: Effect.fnUntraced(function* (row) {
      return yield* ageText(yield* bookAge(row))
    }),
  },
} as const satisfies Record<string, Ranking>

export type RankKey = keyof typeof RANKINGS

export const RANK_CHOICES: ReadonlyArray<{
  readonly value: RankKey
  readonly label: string
}> = Object.entries(RANKINGS).map(([value, { label }]) => ({
  value: value as RankKey,
  label,
}))

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
    readonly limit: Limit
  }>
  // Codes above the floor, before the filters.
  readonly above: number
  // The codes the floor would let in that are on the Special Monitoring
  // Board, and the other such codes at Rp1–LOWEST_READ_CLOSE.
  readonly board: number
  readonly cheap: number
}

export const isStale = (readings: BookReadings, now: number) =>
  Effect.map(
    bookAge({ readings, now, events: undefined }),
    (age) => age > STALE_MS
  )

// One half's order: stale books last, then by the key in the direction
// asked, none last, then by code.
const ranked = Effect.fnUntraced(function* (
  half: ReadonlyArray<BookReadings>,
  settings: RadarSettings,
  input: ScanInput
) {
  const { now } = input
  const sign = settings.direction === "high" ? -1 : 1
  const ranking: Ranking = RANKINGS[settings.rankBy]
  const keyed = yield* Effect.forEach(
    half,
    Effect.fnUntraced(function* (readings) {
      return {
        readings,
        stale: yield* isStale(readings, now),
        value: yield* ranking.value({
          readings,
          now,
          events: input.events.get(readings.code),
        }),
      }
    })
  )
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
})

// A code's previous close, or its last price while none is known: Rp10 or
// less keeps it off the scanner.
export const isCheap = (figures: CodeFigures | undefined) =>
  Effect.sync(() => {
    const close = figures?.previousClose ?? figures?.last
    return close !== undefined && close <= LOWEST_READ_CLOSE
  })

const passesFilters = (
  readings: BookReadings,
  figures: CodeFigures | undefined,
  input: ScanInput,
  settings: RadarSettings
) =>
  Effect.sync(() => {
    if (settings.codes === "watchlist" && !input.watchlist.has(readings.code))
      return false
    const search = settings.search.trim().toUpperCase()
    if (search !== "" && !readings.code.startsWith(search)) return false
    const { priceMin, priceMax } = settings
    if (priceMin === undefined && priceMax === undefined) return true
    const last = figures?.last
    if (last === undefined) return false
    return last >= (priceMin ?? 0) && last <= (priceMax ?? Infinity)
  })

// Decision: a code joins the scanner when its value today or on the
// previous trading day, whichever is larger, reaches the floor; with no
// previous day's value (after a gap), today's alone. Special Monitoring
// Board codes and codes at Rp1–10 never join, and the notes count those
// the floor would have let in. See spec apinrdw/kumora#517, "The scanner".
export const scan = Effect.fnUntraced(function* (
  input: ScanInput,
  settings: RadarSettings
) {
  let above = 0
  let board = 0
  let cheap = 0
  const bid: Array<BookReadings> = []
  const offer: Array<BookReadings> = []
  const limits: Array<Scan["limits"][number]> = []
  for (const readings of input.readings) {
    const figures = input.figures.get(readings.code)
    const value = Math.max(readings.value, figures?.previousValue ?? 0)
    if (value < settings.floor) continue
    if (input.board.has(readings.code)) {
      board++
      continue
    }
    if (yield* isCheap(figures)) {
      cheap++
      continue
    }
    above++
    if (!(yield* passesFilters(readings, figures, input, settings))) continue
    if (readings.limit !== undefined)
      limits.push({ code: readings.code, limit: readings.limit })
    else if (readings.imbalance === undefined) continue
    else if (readings.imbalance >= 0) bid.push(readings)
    else offer.push(readings)
  }
  const result: Scan = {
    bid: yield* ranked(bid, settings, input),
    offer: yield* ranked(offer, settings, input),
    limits: limits.sort((a, b) => a.code.localeCompare(b.code)),
    above,
    board,
    cheap,
  }
  return result
})

// The row's figure for what it is ranked by.
export const rankedFigure = (
  readings: BookReadings,
  key: RankKey,
  now: number,
  events?: CodeEvents
) => RANKINGS[key].figure({ readings, now, events })

const plural = (n: number, one: string, many: string) =>
  Effect.succeed(`${n} ${n === 1 ? one : many}`)

// The line under the toolbar: how many codes the floor lets in, and which
// codes are never ranked and why.
export const coverageNote = Effect.fnUntraced(function* (counted: Scan) {
  const codes = yield* plural(counted.above, "code", "codes")
  const board = yield* plural(
    counted.board,
    "Special Monitoring Board code",
    "Special Monitoring Board codes"
  )
  const cheap = yield* plural(counted.cheap, "code", "codes")
  return `${codes} above the floor · ${board} and ${cheap} at Rp1–${LOWEST_READ_CLOSE} are not ranked · rows with no book change for ${STALE_MS / 1000} s grey out and sink`
})
