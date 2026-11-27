// Ticket apinrdw/kumora#568 of spec apinrdw/kumora#555: a day records order
// book chunks only for the codes someone viewed that day, from the first
// view to the close. Envelopes go in through the ingest socket, time moves
// only by TestClock, and the test reads the recorded Book and heatmap GETs.
// Handing a second trading day the first's database is the object
// restarting.
import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  bookAt,
  decodeBookChunk,
  decodeRecordedHeatmap,
  type TradeFields,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { stockbitBook, stockbitTrade, tradingDay } from "./day-harness"
import { memorySql, rowLimited } from "./sql"

const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)
const at = (time: string) =>
  TestClock.setTime(DateTime.toEpochMillis(wib(time)))
const wibTime = (instant: DateTime.Utc) =>
  DateTime.formatIso(DateTime.add(instant, { hours: 7 })).slice(11, 19)

type Day = Effect.Success<ReturnType<typeof tradingDay>>

// A trade of another code, so the relay records the day.
const RELAYED = stockbitTrade({
  number: 1,
  time: "13:58:00.000",
  code: "BBCA",
  price: 8_000,
  lots: 1,
})

// UNTR's whole book, `bid` lots bid at 8,000 and 40 offered at 8,025, as of
// `time`, served with the delta 250 ms later.
const untrBook = Effect.fnUntraced(function* (
  day: Day,
  time: string,
  bid: number
) {
  yield* at(time)
  yield* day.frames([
    stockbitBook({ side: "BID", levels: [[8_000, 3, bid]], time }),
    stockbitBook({ side: "OFFER", levels: [[8_025, 2, 40]], time }),
  ])
  yield* TestClock.adjust("250 millis")
})

// Ajaib's whole book of UNTR as of `time`, `bid` lots bid at 8,000 and 40
// offered at 8,025, in the trade stream that carries it.
const untrAjaibBook = (time: string, bid: number) =>
  JSON.stringify({
    ticker: "UNTR",
    is_initial: "true",
    buy: [{ price: 8_000, lot: bid, num: 3 }],
    sell: [{ price: 8_025, lot: 40, num: 2 }],
    updateTime: DateTime.toEpochMillis(wib(time)),
  })

// UNTR's recorded Book answer for `minute`: its status, and the lots bid at
// `cursor` in the chunk it answered.
const bookOf = Effect.fnUntraced(function* (
  day: Day,
  minute: string,
  cursor: string
) {
  const response = yield* day.recorded({
    _tag: "Book",
    code: StockCode.make("UNTR"),
    minute: wib(minute),
  })
  const text = yield* Effect.promise(() => response.text())
  if (response.status !== 200) return { status: response.status, text }
  const book = yield* bookAt(yield* decodeBookChunk(text), wib(cursor))
  return { status: 200, bids: book?.bids.map((level) => level.lots) }
})

// UNTR's recorded heatmap answer: whether it says not recorded, and when its
// first slice starts.
const heatmapOf = Effect.fnUntraced(function* (day: Day) {
  const response = yield* day.recorded({
    _tag: "Heatmap",
    code: StockCode.make("UNTR"),
  })
  const answer = yield* decodeRecordedHeatmap(
    yield* Effect.promise(() => response.text())
  )
  const [first] = answer.slices
  return {
    notRecorded: answer.notRecorded === true,
    first: first === undefined ? undefined : wibTime(first.at),
  }
})

const NOT_RECORDED = '{"error":"NotFound","message":"Not recorded"}'

// `count` codes of the longest shape no list names, from `from`.
const unlisted = (from: number, count: number) =>
  Array.from(
    { length: count },
    (_, index) => `Z${String(from + index).padStart(15, "0")}`
  )

// The recorded-books fact as `sql` holds it.
const recordedFact = (sql: ReturnType<typeof memorySql>) =>
  sql.exec("SELECT value FROM facts WHERE key = 'recorded-books'")[0]?.value

// Twelve viewers, each watching 10,000 codes the others don't.
const watchDisjoint = Effect.fnUntraced(function* (day: Day) {
  for (let viewer = 0; viewer < 12; viewer++)
    yield* day.left(
      yield* day.viewer("BBCA", undefined, unlisted(viewer * 10_000, 10_000))
    )
})

describe("a day's recorded order books", () => {
  it.effect(
    "keep no chunk of a code never in the on-demand set, which answers not recorded, while live viewers still get its readings",
    () =>
      Effect.gen(function* () {
        yield* at("13:58:00")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* day.trades([RELAYED])
        const page = yield* day.viewer("BBCA")
        yield* untrBook(day, "14:00:03", 50)
        yield* TestClock.adjust("2 minutes")

        // A delta carries whole books only for a code some viewer selected:
        // UNTR reaches BBCA's viewer as its readings.
        const deltas = (yield* page.received).filter(
          (message) => message._tag === "Delta"
        )
        assert.deepStrictEqual(
          deltas.flatMap((delta) =>
            (delta.bookReadings ?? []).map((readings) => [
              readings.code,
              wibTime(readings.at),
            ])
          ),
          [["UNTR", "14:00:03"]]
        )
        assert.deepStrictEqual(
          deltas.flatMap((delta) => delta.orderBooks ?? []),
          []
        )
        assert.deepStrictEqual(
          sql.exec("SELECT code FROM book_chunks WHERE code = 'UNTR'"),
          []
        )
        assert.deepStrictEqual(yield* bookOf(day, "14:00:00", "14:00:30"), {
          status: 404,
          text: NOT_RECORDED,
        })
        assert.deepStrictEqual(yield* heatmapOf(day), {
          notRecorded: true,
          first: undefined,
        })
      })
  )

  it.effect(
    "keep a code's chunks from the minute it joined the on-demand set to the close, after every viewer left",
    () =>
      Effect.gen(function* () {
        yield* at("13:58:00")
        const day = yield* tradingDay()
        yield* day.trades([RELAYED])
        yield* untrBook(day, "13:58:03", 50)
        yield* at("14:00:00")
        const page = yield* day.viewer("UNTR")
        yield* at("14:00:30")
        yield* day.left(page)
        yield* untrBook(day, "14:03:03", 90)
        yield* TestClock.adjust("2 minutes")

        assert.strictEqual(
          (yield* bookOf(day, "13:59:00", "13:59:30")).status,
          404
        )
        // The minute it joined starts from the book in force.
        assert.deepStrictEqual(yield* bookOf(day, "14:00:00", "14:00:10"), {
          status: 200,
          bids: [50],
        })
        assert.deepStrictEqual(yield* bookOf(day, "14:03:00", "14:03:30"), {
          status: 200,
          bids: [90],
        })
        assert.deepStrictEqual(yield* heatmapOf(day), {
          notRecorded: false,
          first: "14:00:00",
        })

        // The seal closes the chunk still open.
        yield* untrBook(day, "15:59:50", 120)
        yield* at("17:00:00")
        yield* day.alarm
        assert.deepStrictEqual(yield* bookOf(day, "15:59:00", "15:59:55"), {
          status: 200,
          bids: [120],
        })
      })
  )

  it.effect(
    "stay as sealed when a viewer selects a code never viewed after the seal, who still gets its live snapshot",
    () =>
      Effect.gen(function* () {
        yield* at("13:58:00")
        const day = yield* tradingDay()
        yield* day.trades([RELAYED])
        yield* untrBook(day, "14:00:03", 50)
        yield* at("17:00:00")
        yield* day.alarm

        const page = yield* day.viewer("UNTR")
        const [snapshot] = yield* page.received
        assert.strictEqual(snapshot?._tag, "Snapshot")
        assert.strictEqual(
          snapshot?._tag === "Snapshot" ? snapshot.selected : undefined,
          "UNTR"
        )
        yield* TestClock.adjust("2 minutes")
        assert.deepStrictEqual(yield* heatmapOf(day), {
          notRecorded: true,
          first: undefined,
        })
      })
  )

  it.effect(
    "answer an unviewed code not recorded on a walk day restarted between its batches before the seal",
    () =>
      Effect.gen(function* () {
        const walked: TradeFields = {
          time: wib("09:00:35"),
          code: StockCode.make("BBCA"),
          price: 8_000,
          lots: 4,
          board: "RG",
          side: "buy",
        }
        yield* at("16:40:00")
        const sql = memorySql()
        const first = yield* tradingDay(sql)
        yield* first.brokerCodes("Stockbit", [[1, "AK F CC D", walked]])
        yield* first.evicted

        const restarted = yield* tradingDay(sql)
        yield* restarted.brokerCodes(
          "Stockbit",
          [[2, "YP D AK F", { ...walked, side: "sell" }]],
          2
        )
        yield* at("17:00:00")
        yield* restarted.alarm
        assert.lengthOf(sql.exec("SELECT 1 FROM facts WHERE key = 'sealed'"), 1)
        assert.deepStrictEqual(yield* heatmapOf(restarted), {
          notRecorded: true,
          first: undefined,
        })
      })
  )

  it.effect("keep the codes they record past a restart", () =>
    Effect.gen(function* () {
      yield* at("14:00:00")
      const sql = memorySql()
      const first = yield* tradingDay(sql)
      yield* first.trades([RELAYED])
      const page = yield* first.viewer("UNTR")
      yield* first.left(page)
      yield* TestClock.adjust("2 minutes")
      yield* first.evicted

      const restarted = yield* tradingDay(sql)
      yield* untrBook(restarted, "14:05:03", 70)
      yield* TestClock.adjust("2 minutes")
      assert.deepStrictEqual(yield* bookOf(restarted, "14:05:00", "14:05:30"), {
        status: 200,
        bids: [70],
      })
    })
  )

  it.effect(
    "keep the book a viewer was served for a code it joined after a restart, from its stored Ajaib book, in the minute it saw it with no frame after",
    () =>
      Effect.gen(function* () {
        yield* at("13:58:00")
        const sql = memorySql()
        const first = yield* tradingDay(sql)
        yield* first.trades([RELAYED])
        yield* first.ajaibTrades([untrAjaibBook("13:58:03", 50)])
        yield* TestClock.adjust("2 minutes")
        yield* first.evicted

        // The Select wakes the object late in the minute, so no delta is
        // sent within it.
        yield* at("14:00:59.900")
        const restarted = yield* tradingDay(sql)
        const page = yield* restarted.viewer("UNTR")
        const [snapshot] = yield* page.received
        const served =
          snapshot?._tag === "Snapshot" &&
          snapshot.orderBook?._tag === "OrderBook"
            ? snapshot.orderBook.bids.map((level) => level.lots)
            : undefined
        assert.deepStrictEqual(served, [50])
        yield* restarted.left(page)
        yield* at("17:00:00")
        yield* restarted.alarm

        assert.deepStrictEqual(
          yield* bookOf(restarted, "14:00:00", "14:00:59.950"),
          { status: 200, bids: [50] }
        )
      })
  )

  it.effect(
    "stay a fact far under the 2 MB row, so later flushes land, when viewers watch 120,000 codes and the day holds no list",
    () =>
      Effect.gen(function* () {
        yield* at("13:58:00")
        const sql = rowLimited(memorySql())
        const day = yield* tradingDay(sql)
        yield* watchDisjoint(day)
        yield* day.trades([RELAYED])
        yield* TestClock.adjust("2 minutes")
        yield* day.evicted

        const fact = recordedFact(sql)
        assert.isString(fact)
        assert.isBelow(String(fact).length, 200_000)
        const restarted = yield* tradingDay(sql)
        assert.lengthOf(
          (yield* restarted.recordedCandles("BBCA")).answer.candles,
          1
        )
      }),
    // 120,000 watched codes take about 2.5 s here, the local default.
    { timeout: 15_000 }
  )

  it.effect(
    "keep only the codes the day's list names once it holds one, which still record after unlisted ones filled the set",
    () =>
      Effect.gen(function* () {
        yield* at("13:58:00")
        const sql = memorySql()
        const day = yield* tradingDay(sql)
        yield* day.trades([RELAYED])
        yield* watchDisjoint(day)
        yield* day.codeList(
          JSON.stringify({
            results: [
              { code: "BBCA", name: "Bank Central Asia" },
              { code: "UNTR", name: "United Tractors" },
            ],
          })
        )
        yield* untrBook(day, "13:58:03", 50)
        yield* at("14:00:00")
        yield* day.left(
          yield* day.viewer("UNTR", undefined, unlisted(200_000, 10))
        )
        yield* untrBook(day, "14:03:03", 90)
        yield* TestClock.adjust("2 minutes")

        const fact = recordedFact(sql)
        assert.isBelow(String(fact).length, 200_000)
        assert.include(String(fact), '"UNTR"')
        assert.notInclude(String(fact), unlisted(200_000, 1)[0])
        assert.deepStrictEqual(yield* bookOf(day, "14:03:00", "14:03:30"), {
          status: 200,
          bids: [90],
        })
      })
  )
})
