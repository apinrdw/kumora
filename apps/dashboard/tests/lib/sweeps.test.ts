import {
  BrokerCode,
  TradeNumber,
  type Sweep,
  type SweepBroker,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import {
  bubbleRadius,
  bubbleOffset,
  leadBroker,
  logRows,
  sweepPrice,
  sweepThreshold,
  sweepTip,
  thresholdText,
} from "@/lib/sweeps"
import { cursorLogical } from "@/lib/replay"

// Numbered as the tests make them.
let made = 0
const sweep = (
  wib: string,
  side: Sweep["side"],
  lots: number,
  price = 1000
): Sweep => ({
  side,
  firstTrade: TradeNumber.make(String(++made)),
  time: DateTime.makeUnsafe(`2026-11-09T${wib}+07:00`),
  first: price,
  last: price,
  lots,
  value: price * lots * 100,
  trades: 1,
})

const at = (wib: string) =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(`2026-11-09T${wib}+07:00`))

// Eight buy sweeps of 10..80 lots and four sell sweeps of 5..20, the last
// sell after 09:30.
const day = [
  ...[10, 20, 30, 40, 50, 60, 70, 80].map((lots, index) =>
    sweep(`09:0${index}:00`, "buy", lots)
  ),
  sweep("09:01:30", "sell", 5),
  sweep("09:02:30", "sell", 10),
  sweep("09:03:30", "sell", 15),
  sweep("09:31:00", "sell", 20),
  // An auction match never counts.
  sweep("08:58:00", "none", 9_999),
]

describe("the top-N threshold", () => {
  it.effect(
    "is the lower of each side's lot count at its top-N mark, over the sweeps up to the cursor",
    () =>
      Effect.gen(function* () {
        // Buy: ⌈8·25%⌉ = 2nd largest, 70. Sell up to 09:30: ⌈3·25%⌉ = 1st, 15.
        expect(yield* sweepThreshold(day, 25, at("09:30:00"))).toEqual({
          lots: 15,
          buy: 70,
          sell: 15,
        })
        // With 09:31's sell: ⌈4·50%⌉ = 2nd, 15; buy ⌈8·50%⌉ = 4th, 50.
        expect(yield* sweepThreshold(day, 50, at("10:00:00"))).toEqual({
          lots: 15,
          buy: 50,
          sell: 15,
        })
        expect(
          yield* thresholdText(yield* sweepThreshold(day, 25, at("09:30:00")))
        ).toBe("≥ 15 lots (buy 70, sell 15)")
      })
  )

  it.effect("All hides nothing; a side with no sweeps yet doesn't count", () =>
    Effect.gen(function* () {
      expect(yield* sweepThreshold(day, 100, at("10:00:00"))).toEqual({
        lots: 0,
      })
      expect(yield* thresholdText({ lots: 0 })).toBe("")
      expect(yield* sweepThreshold(day, 10, at("09:00:30"))).toEqual({
        lots: 10,
        buy: 10,
      })
      expect(yield* sweepThreshold(day, 10, at("08:59:00"))).toEqual({
        lots: 0,
      })
    })
  )
})

describe("the sweep log", () => {
  it.effect(
    "lists the sweeps up to the cursor newest first, at or above the threshold, big ones only when asked, auction matches always",
    () =>
      Effect.gen(function* () {
        const big = sweep("09:05:30", "buy", 2_000, 5_000)
        // In trade order, as the page holds them.
        const sweeps = [day[12]!, ...day.slice(0, 8), day[8]!, big].sort(
          (a, b) =>
            DateTime.toEpochMillis(a.time) - DateTime.toEpochMillis(b.time)
        )
        const rows = yield* logRows(sweeps, {
          threshold: 60,
          bigOnly: false,
          at: at("09:06:00"),
        })
        expect(rows.map((row) => [row.side, row.lots, row.big])).toEqual([
          ["buy", 70, false],
          ["buy", 2_000, true],
          ["buy", 60, false],
          ["none", 9_999, false],
        ])
        const bigRows = yield* logRows(sweeps, {
          threshold: 0,
          bigOnly: true,
          at: at("09:06:00"),
        })
        expect(bigRows.map((row) => row.lots)).toEqual([2_000])
      })
  )
})

describe("bubbles", () => {
  it.effect(
    "sit at the sweep's average price, offset from the minute's centre by its second, with area by lots",
    () =>
      Effect.gen(function* () {
        const walked: Sweep = {
          ...sweep("09:00:00", "buy", 4),
          first: 1000,
          last: 1010,
          value: (1000 * 1 + 1010 * 3) * 100,
        }
        expect(yield* sweepPrice(walked)).toBe(1007.5)
        // Where the cursor line draws its second: the minute's centre plus
        // the fraction of the minute.
        const times = [at("09:00:00") / 1000]
        for (const wib of ["09:00:00", "09:00:50", "09:00:59"])
          expect(yield* bubbleOffset(sweep(`${wib}.400`, "buy", 1), 60)).toBe(
            (yield* cursorLogical(times, at(wib))) * 60
          )
        expect(yield* bubbleOffset(sweep("09:00:50.400", "buy", 1), 60)).toBe(
          50
        )
        expect(yield* bubbleRadius(400)).toBe(5)
        expect(yield* bubbleRadius(1600)).toBe(10)
        expect(yield* bubbleRadius(1)).toBe(1.5)
        expect(yield* bubbleRadius(10_000_000)).toBe(24)
      })
  )
})

const broker = (
  code: string,
  investorType: "D" | "F",
  lots: number
): SweepBroker => ({ code: BrokerCode.make(code), investorType, lots })

describe("a side's lead broker", () => {
  it.effect(
    "is the broker with the most lots, the first on a tie, and +N counts the others",
    () =>
      Effect.gen(function* () {
        expect(
          yield* leadBroker([
            broker("BK", "D", 20),
            broker("AK", "F", 120),
            broker("YP", "D", 120),
          ])
        ).toEqual({ code: "AK", investorType: "F", more: 2 })
        expect(yield* leadBroker([broker("CC", "D", 4)])).toEqual({
          code: "CC",
          investorType: "D",
          more: 0,
        })
      })
  )

  it.effect("is none for a side with no brokers", () =>
    Effect.gen(function* () {
      expect(yield* leadBroker([])).toBeUndefined()
    })
  )
})

describe("a sweep's tooltip", () => {
  const buy: Sweep = {
    ...sweep("09:01:02", "buy", 1_240),
    first: 500,
    last: 510,
    trades: 3,
  }
  const sell = sweep("10:15:09", "sell", 7, 2_150)
  const aggressor = [
    broker("AK", "F", 1_000),
    broker("BK", "D", 200),
    broker("YP", "D", 40),
  ]
  const other = [broker("CC", "D", 1_240)]

  it.effect(
    "heads with the side, lots, price path, trade count and time, then lists the aggressor side's brokers before the other side's",
    () =>
      Effect.gen(function* () {
        expect(
          yield* sweepTip(buy, {
            firstTrade: buy.firstTrade,
            aggressor,
            other,
          })
        ).toEqual({
          title: "Buy 1,240 lots @ 500→510 · 3 trades · 09:01:02",
          sides: [
            { label: "Buyers · aggressor", brokers: aggressor },
            { label: "Sellers", brokers: other },
          ],
        })
      })
  )

  it.effect("names a sell sweep's sellers as its aggressors", () =>
    Effect.gen(function* () {
      const tip = yield* sweepTip(sell, {
        firstTrade: sell.firstTrade,
        aggressor: other,
        other: aggressor,
      })
      expect(tip.title).toBe("Sell 7 lots @ 2,150 · 1 trade · 10:15:09")
      expect(tip.sides?.map((side) => side.label)).toEqual([
        "Sellers · aggressor",
        "Buyers",
      ])
    })
  )

  it.effect("lists no brokers for a sweep not yet whole", () =>
    Effect.gen(function* () {
      expect((yield* sweepTip(buy, undefined)).sides).toBeUndefined()
    })
  )
})
