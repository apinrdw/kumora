import { describe, expect, it } from "@effect/vitest"
import { BrokerCode, type InvestorType, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import {
  brokerSummary,
  customFrom,
  plottedBrokers,
  rangeStart,
  brokersToDate,
  hoverDay,
  selectionSummary,
  type SummaryRow,
  summaryFooter,
  topBrokers,
} from "@/lib/broker-inventory"
import type { BrokerInventoryRead } from "@/server/broker-totals/inventory"

type Row = readonly [
  day: number,
  broker: string,
  investorType: InvestorType,
  buyLots: number,
  sellLots: number,
  price?: number,
]

// A read over `days`, each built unless named in `gaps`. A row's lots are
// at its price, 1,000 a share unless it names one, so a lot's value is
// 100 times the price.
const read = (
  days: ReadonlyArray<string>,
  gaps: ReadonlyArray<string>,
  rows: ReadonlyArray<Row>
): BrokerInventoryRead => {
  // A read holds only its own days' rows.
  rows = rows.filter(([day]) => day < days.length)
  const brokers = [...new Set(rows.map(([, broker]) => broker))].sort()
  return {
    from: WibDate.make(days[0] ?? "2026-11-02"),
    to: WibDate.make(days.at(-1) ?? "2026-11-02"),
    earliest: WibDate.make(days[0] ?? "2026-11-02"),
    pending: undefined,
    days: days.map((day) => WibDate.make(day)),
    built: days.map((day) => !gaps.includes(day)),
    missingTrades: days.map(() => 0),
    candles: {
      day: [],
      open: [],
      high: [],
      low: [],
      close: [],
      volume: [],
      value: [],
      trades: [],
    },
    brokers: brokers.map((broker) => BrokerCode.make(broker)),
    totals: {
      day: rows.map(([day]) => day),
      broker: rows.map(([, broker]) => brokers.indexOf(broker)),
      investorType: rows.map(([, , type]) => type),
      buyLots: rows.map(([, , , buy]) => buy),
      buyValue: rows.map(([, , , buy, , price = 1000]) => buy * price * 100),
      sellLots: rows.map(([, , , , sell]) => sell),
      sellValue: rows.map(([, , , , sell, price = 1000]) => sell * price * 100),
    },
  }
}

const LOTS = { measure: "lots", investor: "all" } as const
const VALUE = { measure: "value", investor: "all" } as const
const YP = BrokerCode.make("YP")
const PD = BrokerCode.make("PD")

// Mon 2 Nov to Fri 6 Nov 2026. Wednesday is a gap; on Thursday the stock
// didn't trade.
const WEEK = [
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
]

describe("broker inventory", () => {
  it.effect(
    "carries each broker's running net across a gap and a day it didn't trade",
    () =>
      Effect.gen(function* () {
        const week = read(
          WEEK,
          ["2026-11-04"],
          [
            [0, "YP", "D", 100, 40],
            [0, "PD", "F", 40, 100],
            [1, "YP", "F", 30, 0],
            [1, "PD", "D", 0, 30],
            [4, "YP", "D", 10, 20],
            [4, "PD", "D", 20, 10],
          ]
        )
        const nets = yield* brokersToDate(week, LOTS, [YP, PD])
        expect(nets.get(YP)?.net).toStrictEqual([60, 90, 90, 90, 80])
        expect(nets.get(PD)?.net).toStrictEqual([-60, -90, -90, -90, -80])
      })
  )

  it.effect(
    "tells a gap from a day the stock didn't trade only by the day being built",
    () =>
      Effect.gen(function* () {
        const rows: ReadonlyArray<Row> = [[0, "YP", "D", 10, 0]]
        const gap = read(WEEK.slice(0, 2), ["2026-11-03"], rows)
        const flat = read(WEEK.slice(0, 2), [], rows)
        expect(gap.built).toStrictEqual([true, false])
        expect(flat.built).toStrictEqual([true, true])
        expect(
          (yield* brokersToDate(gap, LOTS, [YP])).get(YP)?.net
        ).toStrictEqual([10, 10])
        expect(
          (yield* brokersToDate(flat, LOTS, [YP])).get(YP)?.net
        ).toStrictEqual([10, 10])
      })
  )

  it.effect("plots nothing for a broker the range never saw", () =>
    Effect.gen(function* () {
      const nets = yield* brokersToDate(read(WEEK, [], []), LOTS, [YP])
      expect(nets.get(YP)?.net).toStrictEqual([0, 0, 0, 0, 0])
    })
  )

  it.effect(
    "ranks the top 5 net buyers and sellers, and re-ranks them for another range",
    () =>
      Effect.gen(function* () {
        // Seven buyers early in the week, then the first two sell it back.
        const rows: Array<Row> = [
          [0, "AA", "D", 70, 0],
          [0, "BB", "D", 60, 0],
          [0, "CC", "D", 50, 0],
          [0, "DD", "F", 40, 0],
          [0, "EE", "D", 30, 0],
          [0, "FF", "D", 20, 0],
          [0, "GG", "D", 0, 270],
          [1, "HH", "D", 0, 10],
          [1, "II", "F", 0, 5],
          [1, "JJ", "D", 0, 3],
          [1, "KK", "D", 0, 2],
          [1, "LL", "D", 0, 1],
          [1, "MM", "D", 21, 0],
          [3, "AA", "D", 0, 100],
          [3, "BB", "D", 0, 100],
          [3, "GG", "D", 200, 0],
        ]
        const top = (week: BrokerInventoryRead) =>
          Effect.flatMap(brokerSummary(week, LOTS), topBrokers)
        expect(yield* top(read(WEEK.slice(0, 2), [], rows))).toStrictEqual({
          buy: ["AA", "BB", "CC", "DD", "EE"],
          sell: ["GG", "HH", "II", "JJ", "KK"],
        })
        // Days 0 to 3: Thursday's index is 3 in the longer range.
        expect(yield* top(read(WEEK.slice(0, 4), [], rows))).toStrictEqual({
          buy: ["CC", "DD", "EE", "MM", "FF"],
          sell: ["GG", "BB", "AA", "HH", "II"],
        })
      })
  )

  it.effect("plots a side short of five with the brokers it has", () =>
    Effect.gen(function* () {
      const week = read(
        WEEK,
        [],
        [
          [0, "YP", "D", 10, 0],
          [0, "PD", "D", 0, 10],
          [0, "CC", "D", 5, 5],
        ]
      )
      expect(
        yield* Effect.flatMap(brokerSummary(week, LOTS), topBrokers)
      ).toStrictEqual({ buy: ["YP"], sell: ["PD"] })
    })
  )
})

describe("the plotted brokers", () => {
  const top = {
    buy: [BrokerCode.make("AA"), YP],
    sell: [BrokerCode.make("ZZ")],
  }

  it.effect(
    "plots each chip's brokers in chip order, a broker once, by its first chip",
    () =>
      Effect.gen(function* () {
        expect(
          yield* plottedBrokers(["sell", PD, "buy", YP], top)
        ).toStrictEqual([
          { broker: "ZZ", chip: "sell", rank: 0 },
          { broker: "PD", chip: "PD", rank: 0 },
          { broker: "AA", chip: "buy", rank: 0 },
          { broker: "YP", chip: "buy", rank: 1 },
        ])
        expect(
          (yield* plottedBrokers([YP, "buy"], top)).map(({ broker }) => broker)
        ).toStrictEqual(["YP", "AA"])
      })
  )

  it.effect("plots nothing with no chips", () =>
    Effect.gen(function* () {
      expect(yield* plottedBrokers([], top)).toStrictEqual([])
    })
  )
})

describe("the broker summary", () => {
  it.effect("weights each broker's average prices by lots", () =>
    Effect.gen(function* () {
      const week = read(
        WEEK,
        [],
        [
          [0, "YP", "D", 100, 0, 1000],
          [1, "YP", "D", 300, 40, 2000],
          [2, "YP", "F", 0, 10, 4500],
        ]
      )
      const [yp] = yield* brokerSummary(week, LOTS)
      // (100 × 1,000 + 300 × 2,000) / 400 and (40 × 2,000 + 10 × 4,500) / 50.
      expect(yp).toMatchObject({
        broker: "YP",
        buyLots: 400,
        avgBuy: 1750,
        sellLots: 50,
        avgSell: 2500,
      })
    })
  )

  it.effect(
    "nets value as well as lots, and ranks the top 5 by the one shown",
    () =>
      Effect.gen(function* () {
        // YP sells more lots than it buys, but buys dearer: a net seller of
        // lots and a net buyer of value. PD is the other way round.
        const week = read(
          WEEK,
          [],
          [
            [0, "YP", "D", 10, 0, 2000],
            [1, "YP", "D", 0, 30, 500],
            [0, "PD", "D", 0, 10, 2000],
            [1, "PD", "D", 30, 0, 500],
          ]
        )
        const lots = yield* brokerSummary(week, LOTS)
        const value = yield* brokerSummary(week, VALUE)
        expect(lots.map(({ broker, net }) => [broker, net])).toStrictEqual([
          ["PD", 20],
          ["YP", -20],
        ])
        expect(value.map(({ broker, net }) => [broker, net])).toStrictEqual([
          ["YP", 500_000],
          ["PD", -500_000],
        ])
        expect(yield* topBrokers(value)).toStrictEqual({
          buy: ["YP"],
          sell: ["PD"],
        })
        expect(
          (yield* brokersToDate(week, VALUE, [YP])).get(YP)?.net?.slice(0, 2)
        ).toStrictEqual([2_000_000, 500_000])
      })
  )

  it.effect(
    "keeps only foreign or domestic sides in every figure under the filter",
    () =>
      Effect.gen(function* () {
        // YP's investors: foreign buyers, domestic sellers. PD's: the
        // reverse. CC trades only for domestic investors.
        const week = read(
          WEEK,
          [],
          [
            [0, "YP", "F", 50, 0, 1000],
            [0, "YP", "D", 0, 80, 1200],
            [0, "PD", "F", 0, 40, 1100],
            [0, "PD", "D", 70, 0, 900],
            [1, "CC", "D", 10, 0],
          ]
        )
        const foreign = { measure: "lots", investor: "foreign" } as const
        const domestic = { measure: "lots", investor: "domestic" } as const
        expect(yield* brokerSummary(week, foreign)).toMatchObject([
          { broker: "YP", buyLots: 50, avgBuy: 1000, sellLots: 0, net: 50 },
          { broker: "PD", buyLots: 0, sellLots: 40, avgSell: 1100, net: -40 },
        ])
        expect(yield* brokerSummary(week, domestic)).toMatchObject([
          { broker: "PD", buyLots: 70, avgBuy: 900, net: 70 },
          { broker: "CC", buyLots: 10, net: 10 },
          { broker: "YP", sellLots: 80, avgSell: 1200, net: -80 },
        ])
        // Under All, YP's sides cancel to a net seller.
        expect(
          yield* Effect.flatMap(brokerSummary(week, LOTS), topBrokers)
        ).toStrictEqual({ buy: ["PD", "CC"], sell: ["YP"] })
        expect(
          yield* Effect.flatMap(brokerSummary(week, foreign), topBrokers)
        ).toStrictEqual({ buy: ["YP"], sell: ["PD"] })
        expect(
          (yield* brokersToDate(week, foreign, [YP, PD])).get(PD)?.net?.[0]
        ).toBe(-40)
      })
  )

  it.effect(
    "tags each broker with the investor type the filter keeps, or under All with the one behind most of its lots",
    () =>
      Effect.gen(function* () {
        const week = read(
          WEEK,
          [],
          [
            [0, "YP", "F", 50, 10],
            [0, "YP", "D", 0, 30],
            [0, "PD", "F", 10, 0],
            [0, "PD", "D", 5, 30],
          ]
        )
        const tags = (rows: ReadonlyArray<SummaryRow>) =>
          Object.fromEntries(
            rows.map(({ broker, investorType }) => [broker, investorType])
          )
        expect(tags(yield* brokerSummary(week, LOTS))).toStrictEqual({
          YP: "F",
          PD: "D",
        })
        expect(
          tags(
            yield* brokerSummary(week, { measure: "lots", investor: "foreign" })
          )
        ).toStrictEqual({ YP: "F", PD: "F" })
      })
  )

  it.effect(
    "footers the broker count, the lots traded, the trades counted and missing, and the gap days skipped",
    () =>
      Effect.gen(function* () {
        const rows = read(
          WEEK,
          ["2026-11-03", "2026-11-05"],
          [
            [0, "YP", "F", 50, 0],
            [0, "PD", "D", 0, 50],
            [2, "YP", "D", 20, 0],
            [2, "CC", "F", 0, 20],
          ]
        )
        // Monday's 50 lots in 30 trades, Wednesday's 20 in 12, and 3
        // trades missing on Monday and 1 on Wednesday.
        const week = {
          ...rows,
          missingTrades: [3, 0, 1, 0, 0],
          candles: {
            day: [0, 2],
            open: [1000, 1000],
            high: [1000, 1000],
            low: [1000, 1000],
            close: [1000, 1000],
            volume: [50, 20],
            value: [5_000_000, 2_000_000],
            trades: [30, 12],
          },
        }
        expect(
          yield* summaryFooter(week, yield* brokerSummary(week, LOTS))
        ).toStrictEqual({
          brokers: 3,
          lots: 70,
          trades: 42,
          missingTrades: 4,
          gapDays: 2,
        })
        // Every lot has a buy side and a sell side; foreign sides here are
        // half of each trade, so they traded half its lots. The trades
        // counted are the range's, whatever the filter.
        const foreign = { measure: "lots", investor: "foreign" } as const
        expect(
          yield* summaryFooter(week, yield* brokerSummary(week, foreign))
        ).toStrictEqual({
          brokers: 2,
          lots: 35,
          trades: 42,
          missingTrades: 4,
          gapDays: 2,
        })
      })
  )

  it.effect("has no average for a side the broker never traded", () =>
    Effect.gen(function* () {
      const [yp] = yield* brokerSummary(
        read(WEEK, [], [[0, "YP", "D", 10, 0]]),
        LOTS
      )
      expect(yp?.avgBuy).toBe(1000)
      expect(yp?.avgSell).toBeUndefined()
    })
  )
})

describe("the broker inventory range", () => {
  it.effect("starts each preset back from the newest built day", () =>
    Effect.gen(function* () {
      const to = WibDate.make("2026-11-13")
      const starts = {
        "2W": "2026-10-31",
        "1M": "2026-10-14",
        "3M": "2026-08-14",
        "6M": "2026-05-14",
        YTD: "2026-01-01",
        "1Y": "2025-11-14",
      } as const
      for (const [preset, start] of Object.entries(starts))
        expect(yield* rangeStart(preset as keyof typeof starts, to)).toBe(start)
    })
  )

  it.effect("ends a month back at the shorter month's last day", () =>
    Effect.gen(function* () {
      expect(yield* rangeStart("1M", WibDate.make("2026-03-31"))).toBe(
        "2026-03-01"
      )
    })
  )

  it.effect("moves a Custom From up to 2 years before its To", () =>
    Effect.gen(function* () {
      const to = WibDate.make("2026-11-13")
      expect(yield* customFrom(WibDate.make("2020-01-01"), to)).toBe(
        "2024-11-14"
      )
      expect(yield* customFrom(WibDate.make("2024-11-14"), to)).toBe(
        "2024-11-14"
      )
      expect(yield* customFrom(WibDate.make("2026-01-05"), to)).toBe(
        "2026-01-05"
      )
    })
  )
})

describe("the hover day and the selection", () => {
  // YP buys Monday and Tuesday at rising prices and sells some Friday; PD
  // is its other side. Wednesday is a gap, with no candle.
  const week = {
    ...read(
      WEEK,
      ["2026-11-04"],
      [
        [0, "YP", "D", 100, 0, 1000],
        [0, "PD", "D", 0, 100, 1000],
        [1, "YP", "D", 100, 0, 1100],
        [1, "PD", "D", 0, 100, 1100],
        [4, "YP", "D", 0, 50, 1200],
        [4, "PD", "D", 50, 0, 1200],
      ]
    ),
    candles: {
      day: [0, 1, 3, 4],
      open: [990, 1000, 1100, 1150],
      high: [1010, 1110, 1150, 1210],
      low: [980, 990, 1090, 1140],
      close: [1000, 1100, 1150, 1200],
      volume: [100, 100, 0, 50],
      value: [0, 0, 0, 0],
      trades: [0, 0, 0, 0],
    },
  } satisfies BrokerInventoryRead

  it.effect(
    "shows the day's close and each broker's running net, day net and averages to that day",
    () =>
      Effect.gen(function* () {
        const toDate = yield* brokersToDate(week, LOTS, [YP, PD])
        expect(yield* hoverDay(week, toDate, 1)).toStrictEqual({
          day: "2026-11-03",
          close: 1100,
          rows: [
            {
              broker: "YP",
              net: 200,
              dayNet: 100,
              avgBuy: 1050,
              avgSell: undefined,
            },
            {
              broker: "PD",
              net: -200,
              dayNet: -100,
              avgBuy: undefined,
              avgSell: 1050,
            },
          ],
        })
        // Friday: YP sold 50 at 1,200; its buys still average 1,050.
        expect((yield* hoverDay(week, toDate, 4)).rows[0]).toStrictEqual({
          broker: "YP",
          net: 150,
          dayNet: -50,
          avgBuy: 1050,
          avgSell: 1200,
        })
      })
  )

  it.effect("shows a gap with no close and no day net", () =>
    Effect.gen(function* () {
      const toDate = yield* brokersToDate(week, LOTS, [YP])
      expect(yield* hoverDay(week, toDate, 2)).toStrictEqual({
        day: "2026-11-04",
        close: undefined,
        rows: [
          {
            broker: "YP",
            net: 200,
            dayNet: 0,
            avgBuy: 1050,
            avgSell: undefined,
          },
        ],
      })
    })
  )

  it.effect(
    "sums the selection's days per broker, by net, with a Total row and the price change",
    () =>
      Effect.gen(function* () {
        const toDate = yield* brokersToDate(week, LOTS, [PD, YP])
        // Tuesday to Friday: Tuesday opened at 1,000, Friday closed at 1,200.
        const selection = yield* selectionSummary(week, toDate, [1, 4])
        expect(selection).toMatchObject({
          from: "2026-11-03",
          to: "2026-11-06",
          days: 4,
          change: 20,
        })
        expect(selection.rows).toStrictEqual([
          {
            broker: "YP",
            net: 50,
            buyLots: 100,
            buyValue: 11_000_000,
            sellLots: 50,
            sellValue: 6_000_000,
            avgBuy: 1100,
            avgSell: 1200,
          },
          {
            broker: "PD",
            net: -50,
            buyLots: 50,
            buyValue: 6_000_000,
            sellLots: 100,
            sellValue: 11_000_000,
            avgBuy: 1200,
            avgSell: 1100,
          },
        ])
        // (100 × 1,100 + 50 × 1,200) / 150 a side.
        expect(selection.total).toMatchObject({
          net: 0,
          buyLots: 150,
          sellLots: 150,
        })
        expect(selection.total.avgBuy).toBeCloseTo(1133.33, 2)
        expect(selection.total.avgSell).toBeCloseTo(1133.33, 2)
      })
  )

  it.effect("has no price change for a selection with no candle", () =>
    Effect.gen(function* () {
      const toDate = yield* brokersToDate(week, LOTS, [YP])
      const selection = yield* selectionSummary(week, toDate, [2, 2])
      expect(selection).toMatchObject({ days: 1, change: undefined })
      expect(selection.total).toMatchObject({
        net: 0,
        avgBuy: undefined,
        avgSell: undefined,
      })
    })
  )
})
