// Spec apinrdw/kumora#555, ticket #571: a recorded day answers the same from
// trade chunks as from a row per trade. The same day is recorded on both
// shapes, and every recorded-day answer that reads the tape is compared:
// the row-per-trade day is the known-good copy.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  TradeNumber,
  WibDate,
  decodeViewerDown,
  type RecordedResource,
  type TradeFields,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { readBrokerTotals } from "@/server/broker-totals/db"
import type { Sql } from "@/server/market-live/day-store"

import { memoryBrokerTotalsDb } from "../broker-totals/memory-broker-totals-db"
import { stockbitTrade, tradingDay } from "./day-harness"
import { memorySql, openedEmptySql, rowShapedSql } from "./sql"

const DAY = WibDate.make("2026-11-09")
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

// Trade n's fields: every 150 ms from 09:00, codes in turn, runs of rising
// UNTR buys that make sweeps, some off the regular board.
const fieldsOf = (number: number) => {
  const code = CODES[Math.floor(number / 7) % CODES.length]!
  return {
    number,
    time: clock(number * 150),
    code,
    price: (code === "UNTR" ? 23_000 : 8_000) + (number % 7) * 25,
    lots: 1 + (number % 13),
    ...(number % 11 === 0
      ? {}
      : { side: number % 7 < 5 ? ("buy" as const) : ("sell" as const) }),
    board:
      number % 97 === 0
        ? ("NG" as const)
        : number % 89 === 0
          ? ("TN" as const)
          : ("RG" as const),
  }
}

// The relay's tape lacks trade 7 and 1,500..1,510; 1,505 arrives late, into
// a minute already stored.
const TAPED = Array.from({ length: 2_600 }, (_, index) => index + 1).filter(
  (number) => number !== 7 && !(number >= 1_500 && number <= 1_510)
)
const LATE = 1_505
const LAST = 2_600

const codesOf = (number: number) =>
  ["AK F CC D", "YP D ZP F", "BK D KZ D", "PD F AK D"][number % 4]!

const walkFields = (number: number): TradeFields => {
  const fields = fieldsOf(number)
  return {
    time: wib(fields.time),
    code: StockCode.make(fields.code),
    price: fields.price,
    lots: fields.lots,
    board: fields.board,
    side: fields.side ?? "none",
  }
}

// What every tape-reading resource answers, status and body.
const answersOf = Effect.fnUntraced(function* (
  day: Effect.Success<ReturnType<typeof tradingDay>>
) {
  const resources: ReadonlyArray<RecordedResource> = [
    { _tag: "Tape", at: wib("17:00:00") },
    { _tag: "Tape", at: wib("09:03:00") },
    { _tag: "Tape", at: wib("09:05:00"), before: TradeNumber.make("1200") },
    { _tag: "BrokerCodes", at: wib("17:00:00") },
    {
      _tag: "BrokerCodes",
      at: wib("09:05:00"),
      before: TradeNumber.make("1200"),
    },
    ...CODES.flatMap((code): ReadonlyArray<RecordedResource> => [
      { _tag: "Candles", code: StockCode.make(code) },
      { _tag: "Sweeps", code: StockCode.make(code) },
      { _tag: "SweepBrokers", code: StockCode.make(code) },
    ]),
  ]
  const answers: Array<string> = []
  for (const resource of resources) {
    const response = yield* day.recorded(resource)
    answers.push(
      `${JSON.stringify(resource)} ${response.status} ${yield* Effect.promise(() => response.text())}`
    )
  }
  const status = yield* day.status()
  answers.push(`status ${yield* Effect.promise(() => status.text())}`)
  return answers
})

// The relay day recorded on `sql`: its tape, a late trade, a viewer's
// snapshot, the seal, the walks' codes with the hole's fields, a correcting
// batch, and the broker totals build.
const relayDay = Effect.fnUntraced(function* (sql: Sql) {
  const db = memoryBrokerTotalsDb()
  yield* at("09:07:00")
  const day = yield* tradingDay(sql, [], db.layer)
  yield* day.trades(TAPED.map((number) => stockbitTrade(fieldsOf(number))))
  yield* TestClock.adjust("2 minutes")
  yield* day.trades([stockbitTrade(fieldsOf(LATE))])
  yield* TestClock.adjust("1 minute")
  const viewer = yield* day.viewer("UNTR")
  const [snapshot] = yield* Effect.forEach(viewer.sent, (text) =>
    decodeViewerDown(text)
  )
  yield* at("17:00:00")
  yield* day.alarm
  const sealed = yield* answersOf(day)
  yield* at("17:30:00")
  yield* day.brokerCodes(
    "Ajaib",
    Array.from({ length: LAST }, (_, index) => index + 1).map((number) =>
      TAPED.includes(number) || number === LATE
        ? ([number, codesOf(number)] as const)
        : ([number, codesOf(number), walkFields(number)] as const)
    ),
    LAST
  )
  const walked = yield* answersOf(day)
  yield* day.brokerCodes(
    "Ajaib",
    Array.from(
      { length: 300 },
      (_, index) => [index + 1_000, "XA D YP F"] as const
    )
  )
  const corrected = yield* answersOf(day)
  yield* day.brokerCodes(
    "Stockbit",
    Array.from({ length: LAST }, (_, index) => index + 1).map(
      (number) =>
        [
          number,
          number >= 1_000 && number < 1_300 ? "XA D YP F" : codesOf(number),
        ] as const
    ),
    LAST
  )
  yield* day.alarm
  const totals = yield* Effect.forEach(CODES, (code) =>
    readBrokerTotals(StockCode.make(code), DAY, DAY).pipe(
      Effect.provide(db.layer)
    )
  )
  return { snapshot, sealed, walked, corrected, totals }
})

// A day the relay recorded nothing of, its tape filled by the walks' fields
// after the close, then sealed.
const walkDay = Effect.fnUntraced(function* (sql: Sql) {
  yield* at("17:30:00")
  const day = yield* tradingDay(sql)
  yield* day.brokerCodes(
    "Ajaib",
    TAPED.map(
      (number) => [number, codesOf(number), walkFields(number)] as const
    ),
    LAST
  )
  const walking = yield* answersOf(day)
  yield* day.brokerCodes(
    "Stockbit",
    TAPED.map((number) => [number, codesOf(number)] as const),
    LAST
  )
  yield* TestClock.adjust("1 hour")
  yield* day.alarm
  return { walking, sealed: yield* answersOf(day) }
})

describe("a recorded day on trade chunks and on a row per trade", () => {
  it.effect(
    "answers its tape pages, snapshot, candles, sweeps, sweep brokers, broker codes and broker totals the same",
    () =>
      Effect.gen(function* () {
        const chunked = yield* relayDay(memorySql())
        const rows = yield* relayDay(rowShapedSql())
        assert.include(chunked.sealed[0], '"tradeNumber":"2600"')
        assert.isAbove(chunked.totals[0]!.totals.length, 0)
        assert.include(chunked.corrected.join("\n"), '[["XA","D",')
        assert.deepStrictEqual(chunked, rows)
      }),
    60_000
  )

  it.effect("answers a walk day the same", () =>
    Effect.gen(function* () {
      const chunked = yield* walkDay(memorySql())
      const rows = yield* walkDay(rowShapedSql())
      assert.include(chunked.walking[0], '"tradeNumber":"2600"')
      assert.deepStrictEqual(chunked, rows)
    })
  )

  it.effect(
    "walks an object opened before trade chunks that never held a trade into chunks",
    () =>
      Effect.gen(function* () {
        const chunked = yield* walkDay(memorySql())
        const sql = openedEmptySql()
        const opened = yield* walkDay(sql)
        assert.deepStrictEqual(opened, chunked)
        assert.deepStrictEqual(
          sql.exec("SELECT name FROM sqlite_schema WHERE name = 'trades'"),
          []
        )
        assert.isAbove(
          Number(sql.exec("SELECT count(*) AS n FROM trade_chunks")[0]?.n),
          0
        )
      })
  )
})
