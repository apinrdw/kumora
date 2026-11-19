// The older days' moves (spec apinrdw/kumora#556, "The move"): the
// reconcile cron moves the days recorded before cold days a few a night,
// oldest first, each on whichever trade shape and heatmap form it holds, and
// every answer it serves from R2 is the one its object served.
import { gunzipSync } from "node:zlib"

import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  TradeNumber,
  WibDate,
  decodeDayStrip,
  type RecordedResource,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { coldAnswer } from "@/server/market-live/cold-days"
import { askOlderMoves } from "@/server/market-live/cold-moves"
import { makeDayIndex } from "@/server/market-live/day-index"
import type { Sql } from "@/server/market-live/day-store"

import {
  heatmapRowsBeforeOnRead,
  stockbitBook,
  stockbitTrade,
  tradingDay,
} from "./day-harness"
import { memoryDayBucket } from "./memory-day-bucket"
import { memorySql, rowShapedSql } from "./sql"

// The harness records every day on 2026-11-09; the index lists each under
// its own date.
const RECORDED = WibDate.make("2026-11-09")
const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)
const at = (time: string) =>
  TestClock.setTime(DateTime.toEpochMillis(wib(time)))

const RESOURCES: ReadonlyArray<RecordedResource> = [
  { _tag: "Codes" },
  { _tag: "Gaps" },
  { _tag: "Tape", at: wib("17:00:00") },
  { _tag: "Tape", at: wib("09:00:15") },
  { _tag: "Tape", at: wib("17:00:00"), before: TradeNumber.make("2") },
  { _tag: "BrokerCodes", at: wib("17:00:00") },
  ...["UNTR", "BBCA"].flatMap((code): ReadonlyArray<RecordedResource> => [
    { _tag: "Candles", code: StockCode.make(code) },
    { _tag: "Sweeps", code: StockCode.make(code) },
    { _tag: "SweepBrokers", code: StockCode.make(code) },
    { _tag: "Heatmap", code: StockCode.make(code) },
    { _tag: "Book", code: StockCode.make(code), minute: wib("09:01:00") },
    { _tag: "Book", code: StockCode.make(code), minute: wib("09:05:30") },
  ]),
]

// A response's status and body, unzipped when it streams stored gzip.
const answered = Effect.fnUntraced(function* (response: Response) {
  const bytes = new Uint8Array(
    yield* Effect.promise(() => response.arrayBuffer())
  )
  const body =
    response.headers.get("Content-Encoding") === "gzip"
      ? gunzipSync(bytes)
      : bytes
  return `${response.status} ${new TextDecoder().decode(body)}`
})

// A day recorded before cold days, on `sql`: a code list naming UNTR and
// BBCA, UNTR's book a viewer had recorded, a few trades, one walked code,
// sealed at 17:00; a heatmap row beside each book chunk when `heatRows`.
// It moves to its own bucket in memory and is marked cold in `index` as
// `date`.
const oldDay = Effect.fnUntraced(function* (
  index: Effect.Success<ReturnType<typeof makeDayIndex>>,
  date: WibDate,
  sql: Sql,
  heatRows: boolean
) {
  yield* at("09:01:10")
  const days = memoryDayBucket()
  const day = yield* tradingDay(sql, [], undefined, {
    bucket: days.bucket,
    markCold: index.markCold(date),
  })
  yield* day.codeList(
    JSON.stringify({
      results: [
        { code: "UNTR", name: "United Tractors" },
        { code: "BBCA", name: "Bank Central Asia" },
      ],
    })
  )
  yield* day.left(yield* day.viewer("UNTR"))
  yield* day.frames([
    stockbitBook({ side: "BID", levels: [[23_300, 3, 50]], time: "09:01:10" }),
  ])
  yield* TestClock.adjust("2 minutes")
  yield* day.trades([
    stockbitTrade({ number: 1, time: "09:00:10.100", price: 23300, lots: 3 }),
    stockbitTrade({
      number: 2,
      time: "09:00:20.000",
      price: 23325,
      lots: 5,
      side: "buy",
    }),
    stockbitTrade({
      number: 3,
      time: "09:02:00.000",
      code: "BBCA",
      price: 9_000,
      lots: 2,
      side: "sell",
    }),
  ])
  if (heatRows) yield* heatmapRowsBeforeOnRead(sql)
  yield* at("17:00:00")
  yield* day.alarm
  yield* day.brokerCodes("Ajaib", [[2, "AK F BK D"]], 3)
  yield* index.record({ day: date, trades: 3, gap: false })
  const hot: Array<string> = []
  for (const resource of RESOURCES)
    hot.push(yield* answered(yield* day.recorded(resource)))
  return { date, day, days, hot }
})

type OldDay = Effect.Success<ReturnType<typeof oldDay>>

// The alarm run while a move step is due now.
const chain = Effect.fnUntraced(function* (old: OldDay) {
  for (let run = 0; run < 50 && !(yield* old.day.emptied); run++) {
    const due = old.day.alarms.at(-1)
    if (due === undefined || DateTime.isGreaterThan(due, yield* DateTime.now))
      return
    yield* old.day.alarm
  }
})

describe("the older days' moves", () => {
  it.effect(
    "moves a few old days of either shape a night, oldest first, each answering from R2 as its object did",
    () =>
      Effect.gen(function* () {
        const index = yield* makeDayIndex(memorySql())
        const olds = [
          yield* oldDay(
            index,
            WibDate.make("2026-10-01"),
            rowShapedSql(),
            true
          ),
          yield* oldDay(index, WibDate.make("2026-10-02"), memorySql(), false),
          yield* oldDay(
            index,
            WibDate.make("2026-10-05"),
            rowShapedSql(),
            false
          ),
          yield* oldDay(index, WibDate.make("2026-10-06"), memorySql(), true),
        ]
        // The newest 15 days, the backstop's, are never asked here.
        for (let day = 7; day <= 21; day++)
          yield* index.record({
            day: WibDate.make(`2026-10-${String(day).padStart(2, "0")}`),
            trades: 1,
            gap: false,
          })
        for (const old of olds) {
          assert.include(old.hot[2], '"tradeNumber":"3"')
          // UNTR's heatmap and book at 09:01.
          assert.include(old.hot[9], "23300")
          assert.include(old.hot[10], "23300")
        }

        // The night's cron, at 18:00 on 2026-11-24, out of every window.
        yield* TestClock.setTime(
          DateTime.toEpochMillis(
            DateTime.makeUnsafe("2026-11-24T18:00:00+07:00")
          )
        )
        // 2026-10-02 is mid-move: its seal's ask started it, one step run.
        assert.isTrue(yield* olds[1]!.day.move)
        yield* olds[1]!.day.alarm
        assert.isFalse(yield* olds[1]!.day.emptied)

        const listed = Effect.map(
          Effect.flatMap(
            Effect.flatMap(index.strip, (response) =>
              Effect.promise(() => response.text())
            ),
            decodeDayStrip
          ),
          (strip) => strip.days
        )
        const asked: Array<WibDate> = []
        const night = Effect.fnUntraced(function* () {
          yield* askOlderMoves({
            listed,
            ask: (date) =>
              Effect.suspend(() => {
                asked.push(date)
                const old = olds.find((each) => each.date === date)
                return old === undefined ? Effect.succeed(false) : old.day.move
              }),
          })
          for (const old of olds) yield* chain(old)
        })

        yield* night()
        assert.deepStrictEqual(asked, [
          "2026-10-01",
          "2026-10-02",
          "2026-10-05",
        ])
        const emptied = yield* Effect.forEach(olds, (old) => old.day.emptied)
        assert.deepStrictEqual(emptied, [true, true, true, false])

        asked.length = 0
        yield* night()
        assert.deepStrictEqual(asked, ["2026-10-06"])
        assert.isTrue(yield* olds[3]!.day.emptied)

        asked.length = 0
        yield* night()
        assert.deepStrictEqual(asked, [])

        const cold = (yield* listed).filter((row) => row.cold === true)
        assert.deepStrictEqual(
          cold.map((row) => row.day).sort(),
          olds.map((old) => old.date)
        )
        for (const old of olds) {
          const answers: Array<string> = []
          for (const resource of RESOURCES) {
            const response = yield* coldAnswer(
              old.days.bucket,
              RECORDED,
              resource
            )
            assert.isDefined(response, resource._tag)
            answers.push(yield* answered(response!))
          }
          assert.deepStrictEqual(answers, old.hot)
        }
      }),
    30_000
  )
})
