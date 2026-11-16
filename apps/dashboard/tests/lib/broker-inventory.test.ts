import { describe, expect, it } from "@effect/vitest"
import { BrokerCode, type InvestorType, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import {
  brokerSummary,
  customFrom,
  rangeStart,
  runningNets,
  topBrokers,
} from "@/lib/broker-inventory"
import type { BrokerInventoryRead } from "@/server/broker-totals/inventory"

type Row = readonly [
  day: number,
  broker: string,
  investorType: InvestorType,
  buyLots: number,
  sellLots: number,
]

// A read over `days`, each built unless named in `gaps`. Every lot is at
// 1,000 a share, so a lot's value is 100,000.
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
    candles: {
      day: [],
      open: [],
      high: [],
      low: [],
      close: [],
      volume: [],
      value: [],
    },
    brokers: brokers.map((broker) => BrokerCode.make(broker)),
    totals: {
      day: rows.map(([day]) => day),
      broker: rows.map(([, broker]) => brokers.indexOf(broker)),
      investorType: rows.map(([, , type]) => type),
      buyLots: rows.map(([, , , buy]) => buy),
      buyValue: rows.map(([, , , buy]) => buy * 100_000),
      sellLots: rows.map(([, , , , sell]) => sell),
      sellValue: rows.map(([, , , , sell]) => sell * 100_000),
    },
  }
}

const LOTS = { measure: "lots", investor: "all" } as const
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
        const nets = yield* runningNets(week, LOTS, [YP, PD])
        expect(nets.get(YP)).toStrictEqual([60, 90, 90, 90, 80])
        expect(nets.get(PD)).toStrictEqual([-60, -90, -90, -90, -80])
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
        expect((yield* runningNets(gap, LOTS, [YP])).get(YP)).toStrictEqual([
          10, 10,
        ])
        expect((yield* runningNets(flat, LOTS, [YP])).get(YP)).toStrictEqual([
          10, 10,
        ])
      })
  )

  it.effect("plots nothing for a broker the range never saw", () =>
    Effect.gen(function* () {
      const nets = yield* runningNets(read(WEEK, [], []), LOTS, [YP])
      expect(nets.get(YP)).toStrictEqual([0, 0, 0, 0, 0])
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
