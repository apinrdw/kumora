// Spec apinrdw/kumora#556, ticket #578: a cold day's Tape and BrokerCodes
// answers come from 1,000-trade blocks in R2, read by range behind the day's
// tape index, and equal the object's answers before the move, on either
// trade shape.
import { assert, describe, it } from "@effect/vitest"
import { TradeNumber, WibDate, type RecordedResource } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { coldAnswer } from "@/server/market-live/cold-days"
import type { Sql } from "@/server/market-live/day-store"
import { makeDayIndex } from "@/server/market-live/day-index"

import { stockbitTrade, tradingDay } from "./day-harness"
import { memoryDayBucket } from "./memory-day-bucket"
import { memorySql, rowShapedSql } from "./sql"

const DAY = WibDate.make("2026-11-09")
const SEALED = "private, max-age=31536000, immutable"
const CODES = ["UNTR", "BBCA", "TLKM"] as const
const wib = (time: string) => DateTime.makeUnsafe(`${DAY}T${time}+07:00`)
const at = (time: string) =>
  TestClock.setTime(DateTime.toEpochMillis(wib(time)))

// HH:MM:SS.mmm of `ms` after 09:00:00.
const clock = (ms: number) => {
  const total = 9 * 3_600_000 + ms
  const part = (value: number, width = 2) =>
    String(Math.floor(value)).padStart(width, "0")
  return `${part(total / 3_600_000)}:${part((total / 60_000) % 60)}:${part((total / 1_000) % 60)}.${part(total % 1_000, 3)}`
}

// The tape lacks trade 7 and 1,500..1,510. Trades come every 50 ms from
// 09:00, none from 09:05 to 09:20 (the relay away), and trade 4,002 is
// stored a skew's worth before 4,001.
const LAST = 10_400
const HOLE_FROM = 6_000
const TAPED = Array.from({ length: LAST }, (_, index) => index + 1).filter(
  (number) => number !== 7 && !(number >= 1_500 && number <= 1_510)
)
const timeOf = (number: number) =>
  number === 4_002
    ? 4_001 * 50 - 700
    : number * 50 + (number > HOLE_FROM ? 15 * 60_000 : 0)

const tradeOf = (number: number) => {
  const code = CODES[Math.floor(number / 7) % CODES.length]!
  return stockbitTrade({
    number,
    time: clock(timeOf(number)),
    code,
    price: (code === "UNTR" ? 23_000 : 8_000) + (number % 7) * 25,
    lots: 1 + (number % 13),
    ...(number % 11 === 0
      ? {}
      : { side: number % 7 < 5 ? ("buy" as const) : ("sell" as const) }),
  })
}

// Codes for every trade but each fifth.
const codesOf = (number: number) =>
  ["AK F CC D", "YP D ZP F", "BK D KZ D", "PD F AK D"][number % 4]!

const tape = (time: string, before?: number): RecordedResource => ({
  _tag: "Tape",
  at: wib(time),
  ...(before === undefined ? {} : { before: TradeNumber.make(String(before)) }),
})
const brokerCodes = (time: string, before?: number): RecordedResource => ({
  ...(tape(time, before) as { at: DateTime.Utc }),
  _tag: "BrokerCodes",
})

// The open, mid-session, the close, around the relay's gap, the skewed
// trade, and walks back by `before`, across block edges.
const INSTANTS = [
  ["09:00:00.000"],
  ["09:00:00.400"],
  ["09:01:40.000"],
  ["09:03:20.020", 4_002],
  ["09:03:20.000"],
  ["09:03:19.400"],
  // Under a skew before block 5,401's first trade.
  ["09:04:29.600"],
  ["09:04:59.990"],
  ["09:12:00.000"],
  ["09:20:00.060"],
  ["09:21:00.000", 5_000],
  ["09:22:00.000", 1_001],
  ["09:22:00.000", 200],
  ["17:00:00.000"],
  ["17:00:00.000", 9_401],
] as const
const RESOURCES = INSTANTS.flatMap(([time, before]) => [
  tape(time, before),
  brokerCodes(time, before),
])

// A relay day on `sql`, walked for codes, sealed, and its row in a day
// index; the bucket the move writes to.
const sealedDay = Effect.fnUntraced(function* (sql: Sql) {
  yield* at("09:30:00")
  const index = yield* makeDayIndex(memorySql())
  const days = memoryDayBucket()
  const day = yield* tradingDay(sql, [], undefined, {
    bucket: days.bucket,
    markCold: index.markCold(DAY),
  })
  yield* day.trades(TAPED.map(tradeOf))
  yield* at("17:00:00")
  yield* day.alarm
  yield* at("17:30:00")
  const coded = TAPED.filter((number) => number % 5 !== 0)
  // A batch holds at most 5,000 rows.
  for (let from = 0; from < coded.length; from += 5_000)
    yield* day.brokerCodes(
      "Ajaib",
      coded
        .slice(from, from + 5_000)
        .map((number) => [number, codesOf(number)] as const)
    )
  yield* index.record({ day: DAY, trades: TAPED.length, gap: true })
  return { day, index, days }
})

const textOf = (response: Response) => Effect.promise(() => response.text())

const answered = Effect.fnUntraced(function* (response: Response) {
  return `${response.status} ${yield* textOf(response)}`
})

describe("a cold day's tape and broker codes", () => {
  for (const [shape, sql] of [
    ["trade chunks", memorySql],
    ["a row per trade", rowShapedSql],
  ] as const)
    it.effect(
      `answer from R2 as the object did, on ${shape}, reading the index once and at most two blocks`,
      () =>
        Effect.gen(function* () {
          const sealed = yield* sealedDay(sql())
          const hot: Array<string> = []
          for (const resource of RESOURCES)
            hot.push(yield* answered(yield* sealed.day.recorded(resource)))
          assert.include(hot.at(-4), '"tradeNumber":"10400"')
          assert.include(hot.at(-3), '"buyer":"AK"')

          assert.isTrue(yield* sealed.day.movedToR2)

          const blockReads: Array<number> = []
          const cold: Array<string> = []
          for (const resource of RESOURCES) {
            const before = sealed.days.reads.length
            const response = yield* coldAnswer(
              sealed.days.bucket,
              DAY,
              resource
            )
            assert.isDefined(response)
            assert.strictEqual(response!.headers.get("Cache-Control"), SEALED)
            cold.push(yield* answered(response!))
            blockReads.push(
              sealed.days.reads
                .slice(before)
                .filter((read) => read.includes("+")).length
            )
          }
          assert.deepStrictEqual(cold, hot)
          assert.strictEqual(
            sealed.days.reads.filter((read) => !read.includes("+")).length,
            1
          )
          assert.isAtMost(Math.max(...blockReads), 2)
        }),
      60_000
    )
})
