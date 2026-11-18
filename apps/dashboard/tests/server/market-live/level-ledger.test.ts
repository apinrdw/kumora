// The level ledger's six book events from small hand-made frame and trade
// sequences, and their negative cases (spec apinrdw/kumora#517, "Testing
// Decisions"). Price 1000 is on the Rp5 tick: Rp100 M is 1,000 lots there and
// a wall's Rp500 M floor about 5,000.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  TradeNumber,
  type BookEvent,
  type BookLevel,
  type OrderBook,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeLevelLedger } from "@/server/market-live/level-ledger"

import recorded from "./fixtures/book-events-2026-11-17.json"

const CODE = StockCode.make("FOLK")
// 2026-11-17 09:10:00 WIB.
const T0 = Date.parse("2026-11-17T02:10:00Z")
const s = (seconds: number) => T0 + seconds * 1000

type Row = readonly [price: number, lots: number, orders?: number]

const levels = (rows: ReadonlyArray<Row>): ReadonlyArray<BookLevel> =>
  rows.map(([price, lots, orders = 10]) => ({ price, lots, orders }))

const OFFERS = levels([
  [1005, 900],
  [1010, 900],
])

// A served book whose bid side carries a new frame at `at`; the offers keep
// one frame at T0.
const bidBook = (at: number, rows: ReadonlyArray<Row>): OrderBook => ({
  _tag: "OrderBook",
  code: CODE,
  bids: levels(rows),
  offers: OFFERS,
  bidLots: 0,
  offerLots: 0,
  at: DateTime.makeUnsafe(Math.max(at, T0)),
  bidAt: DateTime.makeUnsafe(at),
  offerAt: DateTime.makeUnsafe(T0),
  provenance: "Stockbit",
})

let tradeNumber = 1
const sell = (at: number, price: number, lots: number) => ({
  tradeNumber: TradeNumber.make(String(tradeNumber++)),
  time: DateTime.makeUnsafe(at),
  code: CODE,
  price,
  lots,
  side: "sell" as const,
  board: "RG" as const,
  feeds: ["Stockbit" as const],
})

// A bid side of ten 1,000-lot levels from 1000 down, with `changes` on top.
const ladder = (
  changes: Readonly<Record<number, number | [number, number]>>
) => {
  const rows: Array<Row> = []
  for (let k = 0; k < 10; k++) {
    const price = 1000 - 5 * k
    const change = changes[price]
    if (change === 0) continue
    rows.push(
      change === undefined
        ? [price, 1000]
        : Array.isArray(change)
          ? [price, change[0], change[1]]
          : [price, change]
    )
  }
  return rows
}

interface Step {
  readonly at: number
  readonly rows?: ReadonlyArray<Row>
  readonly trades?: ReadonlyArray<ReturnType<typeof sell>>
}

// Runs the steps through one ledger: each step's trades, then its book.
const run = (steps: ReadonlyArray<Step>, reset?: number) =>
  Effect.gen(function* () {
    const ledger = yield* makeLevelLedger
    const events: Array<BookEvent> = []
    for (const step of steps) {
      if (step.at === reset) yield* ledger.reset
      for (const trade of step.trades ?? []) yield* ledger.trade(trade)
      if (step.rows !== undefined)
        events.push(...(yield* ledger.book(bidBook(step.at, step.rows))))
    }
    return events
  })

// One bid frame a second from T0 to `last` seconds, each from `rows`.
const everySecond = (
  last: number,
  rows: (second: number) => ReadonlyArray<Row>,
  trades: (second: number) => ReadonlyArray<ReturnType<typeof sell>> = () => []
): ReadonlyArray<Step> =>
  Array.from({ length: last + 1 }, (_, second) => ({
    at: s(second),
    rows: rows(second),
    trades: trades(second),
  }))

const kinds = (events: ReadonlyArray<BookEvent>) =>
  events.map((event) => `${event.kind} ${event.side} ${event.price}`)

describe("level ledger", () => {
  it.effect("absorbed: a best level takes its own lots and stands", () =>
    Effect.gen(function* () {
      const events = yield* run(
        everySecond(
          40,
          () =>
            ladder({}).map(([p, l]) => (p === 1000 ? [p, 2000, 12] : [p, l])),
          (second) =>
            second >= 31 && second <= 35 ? [sell(s(second), 1000, 500)] : []
        )
      )
      const absorbed = events.filter((event) => event.kind === "absorbed")
      assert.deepStrictEqual(kinds(absorbed), ["absorbed bid 1000"])
      assert.deepInclude(absorbed[0], {
        at: DateTime.makeUnsafe(s(34)),
        lots: 2000,
        orders: 12,
        shown: 2000,
      })
    })
  )

  it.effect("absorbed: not when the level was eaten and re-formed", () =>
    Effect.gen(function* () {
      const events = yield* run(
        everySecond(
          40,
          (second) =>
            second === 33
              ? ladder({ 1000: 0 })
              : ladder({}).map(([p, l]) => (p === 1000 ? [p, 2000] : [p, l])),
          (second) =>
            second >= 30 && second <= 33 ? [sell(s(second), 1000, 600)] : []
        )
      )
      assert.deepStrictEqual(kinds(events), ["eaten bid 1000"])
    })
  )

  it.effect("eaten: a best level leaves and trades explain most of it", () =>
    Effect.gen(function* () {
      const events = yield* run(
        everySecond(
          36,
          (second) =>
            second < 36 ? ladder({ 1000: 2000 }) : ladder({ 1000: 0 }),
          (second) =>
            second >= 33 && second <= 35 ? [sell(s(second), 1000, 500)] : []
        )
      )
      assert.deepStrictEqual(kinds(events), ["eaten bid 1000"])
      assert.deepInclude(events[0], {
        at: DateTime.makeUnsafe(s(36)),
        lots: 2000,
        share: 0.75,
      })
    })
  )

  it.effect("reloaded: the best level trades past what it showed", () =>
    Effect.gen(function* () {
      const events = yield* run(
        everySecond(
          35,
          (second) =>
            second < 35 ? ladder({ 1000: 500 }) : ladder({ 1000: [800, 5] }),
          (second) => (second === 35 ? [sell(s(35), 1000, 1200)] : [])
        )
      )
      // It also took more than it showed at the window's start: absorbed.
      const reloaded = events.filter((event) => event.kind === "reloaded")
      assert.deepStrictEqual(kinds(reloaded), ["reloaded bid 1000"])
      assert.deepInclude(reloaded[0], {
        lots: 1200,
        orders: 5,
        refills: 1,
        crowd: true,
      })
    })
  )

  it.effect("wall appeared: a level in view becomes a wall", () =>
    Effect.gen(function* () {
      const events = yield* run(
        everySecond(35, (second) =>
          second < 35 ? ladder({}) : ladder({ 990: [6000, 2] })
        )
      )
      assert.deepStrictEqual(kinds(events), ["appeared bid 990"])
      assert.deepInclude(events[0], { lots: 6000, orders: 2, ticks: 2 })
    })
  )

  it.effect("wall pulled: half its lots leave without trades", () =>
    Effect.gen(function* () {
      const events = yield* run(
        everySecond(40, (second) =>
          second < 36 ? ladder({ 990: [6000, 2] }) : ladder({ 990: [1000, 1] })
        )
      )
      assert.deepStrictEqual(kinds(events), ["pulled bid 990"])
      assert.deepInclude(events[0], {
        at: DateTime.makeUnsafe(s(36)),
        lots: 6000,
        orders: 2,
        ticks: 2,
        approached: false,
      })
    })
  )

  it.effect("wall pulled: as price approached", () =>
    Effect.gen(function* () {
      // The wall forms 6 ticks under 1000, then the best falls to 985.
      const wall = (best: number) =>
        Array.from({ length: 10 }, (_, k): Row => {
          const price = best - 5 * k
          return price === 970 ? [970, 6000, 2] : [price, 1000]
        })
      const events = yield* run(
        everySecond(40, (second) =>
          second < 20
            ? wall(1000)
            : second < 36
              ? wall(985)
              : wall(985).map(([p, l]): Row =>
                  p === 970 ? [p, 1000, 1] : [p, l]
                )
        )
      )
      const pulled = events.filter((event) => event.kind === "pulled")
      assert.deepStrictEqual(kinds(pulled), ["pulled bid 970"])
      assert.deepInclude(pulled[0], { ticks: 3, approached: true })
    })
  )

  it.effect("wall moved: what left one price arrives at another", () =>
    Effect.gen(function* () {
      const events = yield* run(
        everySecond(40, (second) =>
          second < 36
            ? ladder({ 990: [6000, 3] })
            : ladder({ 990: 0, 985: [7000, 13] })
        )
      )
      const moved = events.filter((event) => event.kind !== "appeared")
      assert.deepStrictEqual(kinds(moved), ["moved bid 990"])
      assert.deepInclude(moved[0], { lots: 6000, orders: 3, to: 985 })
    })
  )

  it.effect("no pull when the wall leaves the 20 levels", () =>
    Effect.gen(function* () {
      // Twenty levels with a wall at the last; the best rises a tick, so the
      // wall falls out of view.
      const side = (best: number) =>
        Array.from({ length: 20 }, (_, k): Row => {
          const price = best - 5 * k
          return price === 905 ? [905, 6000, 2] : [price, 1000]
        })
      const events = yield* run(
        everySecond(40, (second) => (second < 36 ? side(1000) : side(1005)))
      )
      assert.deepStrictEqual(
        events.filter((event) => event.kind === "pulled"),
        []
      )
    })
  )

  it.effect("no pull when price crosses the wall", () =>
    Effect.gen(function* () {
      const events = yield* run(
        everySecond(
          40,
          (second) =>
            second < 36
              ? ladder({ 990: [6000, 2] })
              : ladder({ 990: [1000, 1] }),
          (second) => (second === 36 ? [sell(s(36), 985, 10)] : [])
        )
      )
      assert.deepStrictEqual(
        events.filter((event) => event.kind === "pulled"),
        []
      )
    })
  )

  it.effect("too quiet: fewer than 2 frames in the window read nothing", () =>
    Effect.gen(function* () {
      const events = yield* run([
        { at: s(0), rows: ladder({ 1000: 2000 }) },
        {
          at: s(35),
          rows: ladder({ 1000: 0 }),
          trades: [sell(s(34), 1000, 2000)],
        },
      ])
      assert.deepStrictEqual(events, [])
    })
  )

  it.effect("a reset forgets the frames before it", () =>
    Effect.gen(function* () {
      const steps = everySecond(
        36,
        (second) =>
          second < 36 ? ladder({ 1000: 2000 }) : ladder({ 1000: 0 }),
        (second) =>
          second >= 33 && second <= 35 ? [sell(s(second), 1000, 500)] : []
      )
      assert.deepStrictEqual(yield* run(steps, s(20)), [])
    })
  )
})

// Spans of 2026-11-17 cut from the replay cache of apinrdw/kumora#508
// (docs/research/book-event-thresholds): FOLK and BBNI around their walls.
// Each side frame as [time, levels], each trade as [time, price, lots, side];
// the first frame of each side starts the span.
interface Span {
  readonly code: string
  readonly bid: ReadonlyArray<readonly [number, ReadonlyArray<Row>]>
  readonly offer: ReadonlyArray<readonly [number, ReadonlyArray<Row>]>
  readonly trades: ReadonlyArray<
    readonly [number, number, number, "buy" | "sell" | "none"]
  >
}

// One span's events: its trades and side frames in time order, a trade
// before a frame of the same instant, each frame served with its side's own
// time and the other side's last.
const replay = (span: Span) =>
  Effect.gen(function* () {
    const ledger = yield* makeLevelLedger
    const code = StockCode.make(span.code)
    type SpanStep =
      | { readonly t: number; readonly trade: Span["trades"][number] }
      | {
          readonly t: number
          readonly side: "bid" | "offer"
          readonly levels: ReadonlyArray<Row>
          readonly sequence: number
        }
    const steps: Array<SpanStep> = [
      ...span.trades.map((trade) => ({ t: trade[0], trade })),
      ...span.bid.map(([t, rows], sequence) => ({
        t,
        side: "bid" as const,
        levels: rows,
        sequence,
      })),
      ...span.offer.map(([t, rows], sequence) => ({
        t,
        side: "offer" as const,
        levels: rows,
        sequence,
      })),
    ].sort((a, b) => a.t - b.t || ("trade" in a ? -1 : "trade" in b ? 1 : 0))
    const events: Array<BookEvent> = []
    let bid = { t: 0, levels: [] as ReadonlyArray<Row>, sequence: 0 }
    let offer = bid
    for (const step of steps) {
      if ("trade" in step) {
        const [t, price, lots, side] = step.trade
        yield* ledger.trade({
          ...sell(t, price, lots),
          code,
          side,
        })
        continue
      }
      if (step.side === "bid") bid = step
      else offer = step
      events.push(
        ...(yield* ledger.book({
          _tag: "OrderBook",
          code,
          bids: levels(bid.levels),
          offers: levels(offer.levels),
          bidLots: 0,
          offerLots: 0,
          at: DateTime.makeUnsafe(Math.max(bid.t, offer.t)),
          ...(bid.t > 0
            ? { bidAt: DateTime.makeUnsafe(bid.t), bidSequence: bid.sequence }
            : {}),
          ...(offer.t > 0
            ? {
                offerAt: DateTime.makeUnsafe(offer.t),
                offerSequence: offer.sequence,
              }
            : {}),
          provenance: "Stockbit",
        }))
      )
    }
    return events
  })

const wib = (event: BookEvent) =>
  new Date(DateTime.toEpochMillis(event.at) + 7 * 3_600_000)
    .toISOString()
    .slice(11, 19)

describe("level ledger on 2026-11-17", () => {
  it.effect("finds the walls #508's spot checks found", () =>
    Effect.gen(function* () {
      const spans = recorded as unknown as ReadonlyArray<Span>
      const found: Array<string> = []
      for (const span of spans)
        for (const event of yield* replay(span))
          found.push(
            `${wib(event)} ${event.code} ${event.kind} ${event.side} ${event.price}${event.kind === "moved" ? ` to ${event.to}` : ""}`
          )
      for (const spotted of [
        // 2: resistance held.
        "09:15:59 FOLK absorbed offer 110",
        // 11: one actor layering bids 50,000 lots at a time.
        "09:17:34 FOLK appeared bid 100",
        "09:17:44 FOLK appeared bid 99",
        "09:17:48 FOLK appeared bid 98",
        "09:17:51 FOLK appeared bid 101",
        "09:18:15 FOLK pulled bid 100",
        // 7: two 40,000-lot adds gone a second later.
        "09:20:39 FOLK pulled bid 107",
        // 10: 28,711 lots and 3 orders from 3620 to 3610.
        "14:02:33 BBNI moved bid 3620 to 3610",
        // 8: one order of about 28,500 lots left.
        "14:04:16 BBNI pulled bid 3610",
      ])
        assert.include(found, spotted)
      // The move is not also read as a pull.
      assert.notInclude(found, "14:02:33 BBNI pulled bid 3620")
    })
  )
})
