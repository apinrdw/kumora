// Spec apinrdw/kumora#244, "Dashboard: TradingDay's broker codes store": the
// trading day's broker codes over `memorySql`. Batches go in as the Worker
// hands them over, and the test reads the status the day answers, the codes
// it keeps, and that its recorded day stays as it was.
import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCode,
  BrokerCodesProtocolVersion,
  IngestProtocolVersion,
  StockCode,
  TradeNumber,
  WibDate,
  decodeBrokerCodesStatus,
  decodeRecordedBrokerCodes,
  decodeRecordedTape,
  encodeBrokerCodesBatch,
  encodeIngestUp,
  type BrokerCodesBatch,
  type Feed,
  type RecordedDay,
  type RecordedResource,
  type TradeCodes,
  type TradeFields,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Layer, Option, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"

import type { Sql } from "@/server/market-live/day-store"
import {
  makeTradingDay,
  type Peer,
  type PeerState,
} from "@/server/market-live/trading-day"

import recorded from "./fixtures/ajaib-trades-2026-11-09.json"
import { memorySql } from "./sql"

const TOKEN = "e2e-ingest-token"
const DAY = WibDate.make("2026-11-09")

const wib = (time: string, date = DAY) =>
  DateTime.makeUnsafe(`${date}T${time}+07:00`)

class FakeSocket implements Peer {
  open = Effect.succeed(true)
  private current: PeerState = "new"
  send = () => Effect.void
  close = () => Effect.void
  state = Effect.sync(() => this.current)
  setState = (state: PeerState) =>
    Effect.sync(() => {
      this.current = state
    })
}

const env = Layer.succeed(WorkerEnv)({
  INGEST_TOKEN: TOKEN,
} as unknown as WorkerEnv["Service"])

const codes = (
  buyer: string,
  seller: string,
  buyerType: "D" | "F" = "D",
  sellerType: "D" | "F" = "D"
): TradeCodes => ({
  buyer: BrokerCode.make(buyer),
  buyerType,
  seller: BrokerCode.make(seller),
  sellerType,
})

const FIELDS: TradeFields = {
  code: StockCode.make("BBCA"),
  price: 8_000,
  lots: 1,
  board: "RG",
}

const YP_CC = codes("YP", "CC", "D", "F")
const PD_KZ = codes("PD", "KZ", "F", "D")

const numbers = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, at) => from + at)

const tradingDay = Effect.fnUntraced(function* (
  options: {
    readonly sql?: Sql
    readonly date?: WibDate
  } = {}
) {
  const date = options.date ?? DAY
  const base = options.sql ?? memorySql()
  // Every statement that wrote to the broker trades index.
  const indexWrites: Array<string> = []
  const sql: Sql = {
    exec: (query, ...bindings) => {
      if (/^(INSERT|DELETE).*broker_trades/s.test(query))
        indexWrites.push(query)
      return base.exec(query, ...bindings)
    },
    transaction: (write) => base.transaction(write),
  }
  const alarms: Array<DateTime.Utc> = []
  const indexed: Array<RecordedDay> = []
  const relays: Array<FakeSocket> = []
  const day = yield* makeTradingDay({
    sql,
    date,
    viewers: Effect.succeed([]),
    viewersOf: () => Effect.succeed([]),
    ingests: Effect.sync(() => relays),
    setAlarm: (at) => Effect.sync(() => void alarms.push(at)),
    recordDay: (row) => Effect.sync(() => void indexed.push(row)),
  }).pipe(Scope.provide(yield* Scope.make()))

  const post = Effect.fnUntraced(function* (
    feed: Feed,
    rows: ReadonlyArray<
      readonly [number, TradeCodes] | readonly [number, TradeCodes, TradeFields]
    >,
    end?: number
  ) {
    const batch: BrokerCodesBatch = {
      version: BrokerCodesProtocolVersion,
      feed,
      day: date,
      rows: rows.map(([number, each, fields = FIELDS]) => [
        TradeNumber.make(String(number)),
        each,
        fields,
      ]),
      ...(end === undefined
        ? {}
        : { end: { n: TradeNumber.make(String(end)) } }),
    }
    const response = yield* day.brokerCodes.post(
      yield* encodeBrokerCodesBatch(batch)
    )
    assert.strictEqual(response.status, 200)
  })
  // The status GET's answer, with the GET's query.
  const statusAnswer = Effect.fnUntraced(function* (search = "") {
    const response = yield* day.brokerCodes.status(new URLSearchParams(search))
    assert.strictEqual(response.headers.get("Cache-Control"), "no-store")
    return {
      code: response.status,
      text: yield* Effect.promise(() => response.text()),
    }
  })
  const statusTextAfter = Effect.fnUntraced(function* (search = "") {
    const answer = yield* statusAnswer(search)
    assert.strictEqual(answer.code, 200)
    return answer.text
  })
  const statusText = statusTextAfter()
  const status = Effect.flatMap(statusText, decodeBrokerCodesStatus)
  const held = (number: number) =>
    day.brokerCodes.held(TradeNumber.make(String(number)))
  const missing = Effect.map(status, (each) =>
    each.missing.map(([from, to]) => [Number(from), Number(to)])
  )

  // The relay's ingest socket, its token sent.
  const relay = Effect.gen(function* () {
    const socket = new FakeSocket()
    relays.push(socket)
    yield* day
      .ingestMessage(
        socket,
        yield* encodeIngestUp({
          _tag: "Token",
          protocolVersion: IngestProtocolVersion,
          token: TOKEN,
        })
      )
      .pipe(Effect.provide(env))
    return socket
  })
  const ajaibTrades = Effect.fnUntraced(function* (
    socket: FakeSocket,
    seqs: ReadonlyArray<number>,
    time: string
  ) {
    yield* day
      .ingestMessage(
        socket,
        yield* encodeIngestUp({
          _tag: "Frames",
          protocolVersion: IngestProtocolVersion,
          feed: "Ajaib",
          stream: "trade",
          connection: "A",
          receivedAt: yield* DateTime.now,
          frames: seqs.map((seq) =>
            JSON.stringify({
              ...JSON.parse(recorded.session1[0]!),
              ticker: "BBCA",
              price: 8_000,
              lot: 1,
              tradedAt: `${DAY}T${time}.000+07:00`,
              tradeNum: `${DAY.replaceAll("-", "")}${String(seq).padStart(10, "0")}`,
            })
          ),
        })
      )
      .pipe(Effect.provide(env))
  })
  const alarm = day.alarm.pipe(Effect.provide(env))
  // The broker trades index, one row per trade side, as Data Studio reads it.
  const index = Effect.sync(() =>
    base
      .exec(
        "SELECT broker, investor_type, side, number FROM broker_trades ORDER BY number, side"
      )
      .map((row) => [
        String(row.broker),
        String(row.investor_type),
        String(row.side),
        Number(row.number),
      ])
  )
  return {
    sql: base,
    index,
    indexWrites,
    day,
    post,
    status,
    statusText,
    statusTextAfter,
    statusAnswer,
    held,
    missing,
    alarms,
    indexed,
    relay,
    ajaibTrades,
    alarm,
  }
})

describe("a day's broker codes", () => {
  it.effect(
    "before any end, missing is the gaps below the highest held; after it, every gap of 1..N",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("17:30:00").epochMilliseconds)
        const day = yield* tradingDay()
        const empty = yield* day.status
        assert.deepStrictEqual(empty.n, null)
        assert.deepStrictEqual(empty.missing, [])
        assert.isFalse(empty.complete)

        yield* day.post(
          "Stockbit",
          [...numbers(1, 3), ...numbers(5, 1_500), 2_100].map(
            (number) => [number, YP_CC] as const
          )
        )
        assert.deepStrictEqual(yield* day.missing, [
          [4, 4],
          [1_501, 2_099],
        ])
        assert.isFalse((yield* day.status).complete)

        yield* day.post("Stockbit", [], 2_500)
        const ended = yield* day.status
        assert.strictEqual(ended.n, "2500")
        assert.deepStrictEqual(yield* day.missing, [
          [4, 4],
          [1_501, 2_099],
          [2_101, 2_500],
        ])
        assert.isFalse(ended.complete)

        yield* day.post(
          "Stockbit",
          [4, ...numbers(1_501, 2_099), ...numbers(2_101, 2_500)].map(
            (number) => [number, YP_CC] as const
          )
        )
        const complete = yield* day.status
        assert.deepStrictEqual(complete.missing, [])
        assert.isTrue(complete.complete)
        assert.deepStrictEqual(complete.sources, { ajaib: 0, stockbit: 2_500 })
      })
  )

  it.effect("N is the highest end either site sent", () =>
    Effect.gen(function* () {
      const day = yield* tradingDay()
      yield* day.post("Ajaib", [[1, YP_CC]], 10)
      yield* day.post("Stockbit", [], 8)
      assert.strictEqual((yield* day.status).n, "10")
      yield* day.post("Stockbit", [], 12)
      assert.strictEqual((yield* day.status).n, "12")
      assert.deepStrictEqual(yield* day.missing, [[2, 12]])
    })
  )

  it.effect("a resent batch changes nothing", () =>
    Effect.gen(function* () {
      const day = yield* tradingDay()
      const ajaib = numbers(1, 6_000).map((number) => [number, YP_CC] as const)
      yield* day.post("Ajaib", ajaib.slice(0, 5_000))
      yield* day.post("Ajaib", ajaib.slice(5_000), 6_000)
      const stockbit = numbers(1, 1_000).map(
        (number) => [number, number % 100 === 0 ? PD_KZ : YP_CC] as const
      )
      yield* day.post("Stockbit", stockbit)
      const before = yield* day.statusText
      yield* day.post("Ajaib", ajaib.slice(0, 5_000))
      yield* day.post("Stockbit", stockbit)
      assert.strictEqual(yield* day.statusText, before)
      assert.deepStrictEqual(
        yield* day.held(100),
        Option.some({ codes: YP_CC, source: "Ajaib" as const })
      )
    })
  )

  // CODING_STANDARDS.md, "Bounded memory on a Worker": a 1.5M-trade day
  // with every other trade missing, and its tape holding just the others,
  // its chunks and tape written straight into the tables, since posting
  // 750,000 rows would take minutes.
  it.effect(
    "a day of 750,000 gaps lists its first 1,000 and counts them all",
    () =>
      Effect.gen(function* () {
        const sql = memorySql()
        const day = yield* tradingDay({ sql })
        const chunk = new Uint8Array(7_000)
        const record = new TextEncoder().encode("YPDCCFA")
        for (let slot = 0; slot < 1_000; slot += 2) chunk.set(record, slot * 7)
        sql.transaction(() => {
          for (let index = 0; index < 1_500; index++)
            sql.exec(
              "INSERT INTO broker_code_chunks VALUES (?, ?)",
              index,
              chunk
            )
          sql.exec(
            `WITH RECURSIVE odd(number) AS (
              SELECT 1 UNION ALL SELECT number + 2 FROM odd WHERE number < 1499999
            )
            INSERT INTO trades
            SELECT number, 0, 'BBCA', 8000, 1, 'buy', 'RG', '["Ajaib"]' FROM odd`
          )
        })
        yield* day.post("Ajaib", [], 1_500_000)
        const status: unknown = JSON.parse(yield* day.statusText)
        assert.nestedPropertyVal(status, "complete", false)
        assert.nestedPropertyVal(status, "missingCount", 750_000)
        assert.deepNestedPropertyVal(status, "missing[0]", ["2", "2"])
        assert.deepNestedPropertyVal(status, "missing[999]", ["2000", "2000"])
        assert.notNestedProperty(status, "missing[1000]")

        const last = yield* decodeBrokerCodesStatus(
          yield* day.statusTextAfter("after=1499000")
        )
        assert.strictEqual(last.missingCount, 750_000)
        assert.lengthOf(last.missing, 500)
        assert.deepStrictEqual(last.missing.at(-1), [
          TradeNumber.make("1500000"),
          TradeNumber.make("1500000"),
        ])
      }),
    // Each status reads the 750,000 runs between the tape's numbers.
    { timeout: 10_000 }
  )

  it.effect(
    "after lists the ranges past it, clipped to start after it, and a bad one answers 400",
    () =>
      Effect.gen(function* () {
        const day = yield* tradingDay()
        yield* day.post(
          "Stockbit",
          [1, 10, 20].map((number) => [number, YP_CC] as const),
          30
        )
        const listed = Effect.fnUntraced(function* (search: string) {
          const status = yield* decodeBrokerCodesStatus(
            yield* day.statusTextAfter(search)
          )
          assert.strictEqual(status.missingCount, 27)
          assert.isFalse(status.complete)
          return status.missing.map(([from, to]) => [Number(from), Number(to)])
        })
        assert.deepStrictEqual(yield* listed("after=0"), [
          [2, 9],
          [11, 19],
          [21, 30],
        ])
        assert.deepStrictEqual(yield* listed("after=5"), [
          [6, 9],
          [11, 19],
          [21, 30],
        ])
        assert.deepStrictEqual(yield* listed("after=19"), [[21, 30]])
        assert.deepStrictEqual(yield* listed("after=30"), [])
        assert.strictEqual((yield* day.statusAnswer("after=x")).code, 400)
      })
  )
})

describe("the merge rules", () => {
  it.effect(
    "Ajaib replaces; Stockbit fills an absent trade or replaces its own copy, never Ajaib's",
    () =>
      Effect.gen(function* () {
        const day = yield* tradingDay()
        yield* day.post("Stockbit", [
          [1, YP_CC],
          [2, YP_CC],
        ])
        yield* day.post("Stockbit", [[2, PD_KZ]])
        assert.deepStrictEqual(
          yield* day.held(2),
          Option.some({ codes: PD_KZ, source: "Stockbit" as const })
        )

        yield* day.post("Ajaib", [
          [1, PD_KZ],
          [3, YP_CC],
        ])
        assert.deepStrictEqual(
          yield* day.held(1),
          Option.some({ codes: PD_KZ, source: "Ajaib" as const })
        )

        yield* day.post("Stockbit", [
          [1, YP_CC],
          [3, PD_KZ],
          [4, YP_CC],
        ])
        assert.deepStrictEqual(
          yield* day.held(1),
          Option.some({ codes: PD_KZ, source: "Ajaib" as const })
        )
        assert.deepStrictEqual(
          yield* day.held(3),
          Option.some({ codes: YP_CC, source: "Ajaib" as const })
        )
        assert.deepStrictEqual(
          yield* day.held(4),
          Option.some({ codes: YP_CC, source: "Stockbit" as const })
        )
        assert.isTrue(Option.isNone(yield* day.held(5)))
        assert.deepStrictEqual((yield* day.status).sources, {
          ajaib: 2,
          stockbit: 2,
        })
      })
  )
})

describe("the cross-check", () => {
  it.effect("is none on a day Ajaib supplied nothing, ended or not", () =>
    Effect.gen(function* () {
      const day = yield* tradingDay()
      yield* day.post("Stockbit", [[1, YP_CC]])
      assert.deepStrictEqual((yield* day.status).crossCheck, { state: "none" })
      yield* day.post("Stockbit", [], 1)
      assert.deepStrictEqual((yield* day.status).crossCheck, { state: "none" })
    })
  )

  it.effect(
    "is pending at Stockbit's walk position, then compared with covered and difference counts on Stockbit's end",
    () =>
      Effect.gen(function* () {
        const day = yield* tradingDay()
        yield* day.post(
          "Ajaib",
          numbers(1, 2_000)
            .filter((number) => number !== 7)
            .map((number) => [number, YP_CC] as const),
          2_000
        )
        assert.deepStrictEqual((yield* day.status).crossCheck, {
          state: "pending",
          walkedTo: TradeNumber.make("0"),
        })

        // Stockbit disagrees on 10 and 1,500 and fills 7, which Ajaib lacked.
        const stockbit = numbers(1, 2_000).map(
          (number) =>
            [number, number === 10 || number === 1_500 ? PD_KZ : YP_CC] as const
        )
        yield* day.post("Stockbit", stockbit.slice(0, 1_000))
        assert.deepStrictEqual((yield* day.status).crossCheck, {
          state: "pending",
          walkedTo: TradeNumber.make("1000"),
        })
        yield* day.post("Stockbit", stockbit.slice(1_000))
        yield* day.post("Stockbit", [], 2_000)
        const status = yield* day.status
        assert.deepStrictEqual(status.crossCheck, {
          state: "compared",
          covered: 1_997,
          differences: 2,
        })
        assert.isTrue(status.complete)
        assert.deepStrictEqual(status.sources, { ajaib: 1_999, stockbit: 1 })
      })
  )

  it.effect(
    "compares Ajaib's rows against Stockbit's ended walk when Ajaib arrives later, counting only trades both sent",
    () =>
      Effect.gen(function* () {
        const day = yield* tradingDay()
        // Stockbit's walk ends first, without trade 7.
        yield* day.post(
          "Stockbit",
          numbers(1, 2_000)
            .filter((number) => number !== 7)
            .map((number) => [number, YP_CC] as const),
          2_000
        )
        assert.deepStrictEqual((yield* day.status).crossCheck, {
          state: "none",
        })

        // Ajaib disagrees on 10 and 1,500 and sends 7, which Stockbit lacked.
        yield* day.post(
          "Ajaib",
          numbers(1, 2_000).map(
            (number) =>
              [
                number,
                number === 10 || number === 1_500 ? PD_KZ : YP_CC,
              ] as const
          ),
          2_000
        )
        const status = yield* day.status
        assert.deepStrictEqual(status.crossCheck, {
          state: "compared",
          covered: 1_997,
          differences: 2,
        })
        assert.deepStrictEqual(status.sources, { ajaib: 2_000, stockbit: 0 })
        assert.deepStrictEqual(
          yield* day.held(10),
          Option.some({ codes: PD_KZ, source: "Ajaib" as const })
        )

        // A resent Ajaib batch counts nothing twice.
        yield* day.post("Ajaib", [
          [10, PD_KZ],
          [11, YP_CC],
        ])
        assert.deepStrictEqual((yield* day.status).crossCheck, {
          state: "compared",
          covered: 1_997,
          differences: 2,
        })
      })
  )
})

describe("the cross-check of a replaced Ajaib copy", () => {
  it.effect(
    "compares Ajaib's replacement against Stockbit's copy of a trade it differed on",
    () =>
      Effect.gen(function* () {
        const ZZ_AK = codes("ZZ", "AK")
        const day = yield* tradingDay()
        yield* day.post("Ajaib", [[1, YP_CC]], 1)
        yield* day.post("Stockbit", [[1, PD_KZ]], 1)
        const compared = (covered: number, differences: number) => ({
          state: "compared" as const,
          covered,
          differences,
        })
        assert.deepStrictEqual((yield* day.status).crossCheck, compared(0, 1))

        // Another copy that still differs, then Stockbit's own.
        yield* day.post("Ajaib", [[1, ZZ_AK]])
        assert.deepStrictEqual((yield* day.status).crossCheck, compared(0, 1))
        yield* day.post("Ajaib", [[1, PD_KZ]])
        assert.deepStrictEqual((yield* day.status).crossCheck, compared(1, 0))
        assert.deepStrictEqual(
          yield* day.held(1),
          Option.some({ codes: PD_KZ, source: "Ajaib" as const })
        )

        // Both in one batch: the last copy is the one compared.
        yield* day.post("Ajaib", [
          [1, PD_KZ],
          [1, YP_CC],
        ])
        assert.deepStrictEqual((yield* day.status).crossCheck, compared(0, 1))
        yield* day.post("Ajaib", [
          [1, ZZ_AK],
          [1, PD_KZ],
        ])
        assert.deepStrictEqual((yield* day.status).crossCheck, compared(1, 0))
      })
  )
})

describe("a sealed day", () => {
  it.effect(
    "takes broker codes, and every recorded day answer stays byte-identical",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("15:00:00").epochMilliseconds)
        const day = yield* tradingDay()
        const socket = yield* day.relay
        yield* day.ajaibTrades(socket, numbers(1, 30), "15:00:00")
        yield* TestClock.setTime(wib("17:00:00").epochMilliseconds)
        yield* day.alarm
        assert.lengthOf(day.indexed, 1)

        const resources: ReadonlyArray<RecordedResource> = [
          { _tag: "Codes" },
          { _tag: "Tape", at: wib("17:00:00") },
          { _tag: "Candles", code: StockCode.make("BBCA") },
          {
            _tag: "Book",
            code: StockCode.make("BBCA"),
            minute: wib("15:00:00"),
          },
          { _tag: "Gaps" },
        ]
        const answers = Effect.forEach(resources, (resource) =>
          Effect.gen(function* () {
            const response = yield* day.day.recorded(resource)
            return {
              status: response.status,
              headers: [...response.headers.entries()],
              body: yield* Effect.promise(() => response.text()),
            }
          })
        )
        const before = yield* answers
        const codesAt = day.day.recorded({
          _tag: "BrokerCodes",
          at: wib("17:00:00"),
        })
        yield* codesAt

        yield* TestClock.setTime(wib("17:30:00").epochMilliseconds)
        yield* day.post(
          "Ajaib",
          numbers(1, 30).map((number) => [number, YP_CC] as const),
          30
        )
        yield* day.post("Stockbit", [[1, PD_KZ]], 30)
        yield* codesAt
        assert.isTrue((yield* day.status).complete)
        assert.deepStrictEqual(yield* answers, before)
        assert.lengthOf(day.indexed, 1)
      })
  )
})

// apinrdw/kumora#425: a trade is held once the day has its codes and its
// fields, from the tape or a walk's row.
describe("the trades a sealed tape lacks", () => {
  const TLKM: TradeFields = {
    code: StockCode.make("TLKM"),
    price: 3_510,
    lots: 0.5,
    board: "NG",
  }
  const ASII: TradeFields = {
    code: StockCode.make("ASII"),
    price: 5_000,
    lots: 3,
    board: "RG",
  }
  const HOLES = [5, 12, 13]

  // Trades 1..20 at 15:00 but for the holes, sealed at 17:00.
  const holedDay = Effect.gen(function* () {
    yield* TestClock.setTime(wib("15:00:00").epochMilliseconds)
    const day = yield* tradingDay()
    const socket = yield* day.relay
    yield* day.ajaibTrades(
      socket,
      numbers(1, 20).filter((number) => !HOLES.includes(number)),
      "15:00:00"
    )
    yield* TestClock.setTime(wib("17:00:00").epochMilliseconds)
    yield* day.alarm
    yield* TestClock.setTime(wib("17:30:00").epochMilliseconds)
    return day
  })
  const walkTrades = (day: Effect.Success<typeof holedDay>) =>
    Effect.sync(() =>
      day.sql
        .exec("SELECT * FROM walk_trades ORDER BY number")
        .map((row) => ({ ...row }))
    )
  const codesComplete = (day: Effect.Success<typeof holedDay>) =>
    Effect.gen(function* () {
      const response = yield* day.day.recorded({
        _tag: "BrokerCodes",
        at: wib("17:00:00"),
      })
      const text = yield* Effect.promise(() => response.text())
      return (yield* decodeRecordedBrokerCodes(text)).complete
    })

  it.effect(
    "keeps a walk's fields for those trades alone, the first row stored for each",
    () =>
      Effect.gen(function* () {
        const day = yield* holedDay
        yield* day.post(
          "Ajaib",
          numbers(1, 20).map((number) => [number, YP_CC, TLKM] as const),
          20
        )
        yield* day.post(
          "Stockbit",
          [5, 12, 13, 14].map((number) => [number, YP_CC, ASII] as const)
        )
        assert.deepStrictEqual(
          yield* walkTrades(day),
          HOLES.map((number) => ({
            number,
            code: "TLKM",
            price: 3_510,
            lots: 0.5,
            board: "NG",
          }))
        )
        const status = yield* day.status
        assert.isTrue(status.complete)
        assert.deepStrictEqual(status.missing, [])
      })
  )

  it.effect(
    "lists a trade with codes but no fields as missing until a walk row fills it, its codes complete throughout",
    () =>
      Effect.gen(function* () {
        const day = yield* holedDay
        yield* day.post(
          "Ajaib",
          numbers(1, 20).map((number) => [number, YP_CC] as const),
          20
        )
        assert.isTrue(yield* codesComplete(day))
        // As a day whose codes a walk stored before walks carried fields.
        day.sql.exec("DELETE FROM walk_trades")
        const holed = yield* day.status
        assert.isFalse(holed.complete)
        assert.deepStrictEqual(yield* day.missing, [
          [5, 5],
          [12, 13],
        ])
        assert.strictEqual(holed.missingCount, 3)
        assert.deepStrictEqual(holed.sources, { ajaib: 20, stockbit: 0 })
        assert.isTrue(yield* codesComplete(day))

        yield* day.post("Stockbit", [[12, YP_CC, ASII]])
        assert.deepStrictEqual(yield* day.missing, [
          [5, 5],
          [13, 13],
        ])
        assert.strictEqual((yield* day.status).missingCount, 2)
        assert.isTrue(yield* codesComplete(day))

        yield* day.post(
          "Stockbit",
          [5, 13].map((n) => [n, YP_CC] as const)
        )
        assert.isTrue((yield* day.status).complete)
      })
  )
})

describe("a recorded day's broker codes answer", () => {
  // A day of 250 Ajaib trades at 15:00, sealed at 17:00.
  const sealedDay = Effect.gen(function* () {
    yield* TestClock.setTime(wib("15:00:00").epochMilliseconds)
    const day = yield* tradingDay()
    const socket = yield* day.relay
    yield* day.ajaibTrades(socket, numbers(1, 250), "15:00:00")
    yield* TestClock.setTime(wib("17:00:00").epochMilliseconds)
    yield* day.alarm
    yield* TestClock.setTime(wib("17:30:00").epochMilliseconds)
    return day
  })
  type SealedDay = Effect.Success<typeof sealedDay>
  const answerOf = Effect.fnUntraced(function* (
    day: SealedDay,
    resource: RecordedResource
  ) {
    const response = yield* day.day.recorded(resource)
    assert.strictEqual(response.status, 200)
    return {
      cache: response.headers.get("Cache-Control"),
      text: yield* Effect.promise(() => response.text()),
    }
  })
  const codesAt = Effect.fnUntraced(function* (
    day: SealedDay,
    at: DateTime.Utc
  ) {
    const answer = yield* answerOf(day, { _tag: "BrokerCodes", at })
    return { ...answer, body: yield* decodeRecordedBrokerCodes(answer.text) }
  })
  const CURSOR = wib("17:00:00")

  it.effect(
    "holds the codes of the tape's trades at the same cursor, a trade without codes absent",
    () =>
      Effect.gen(function* () {
        const day = yield* sealedDay
        yield* day.post("Ajaib", [
          ...numbers(1, 10).map((number) => [number, PD_KZ] as const),
          ...numbers(51, 60).map((number) => [number, YP_CC] as const),
        ])
        yield* day.post("Stockbit", [[250, PD_KZ]])
        const tape = yield* decodeRecordedTape(
          (yield* answerOf(day, { _tag: "Tape", at: CURSOR })).text
        )
        const shown = new Set(tape.trades.map((trade) => trade.tradeNumber))
        assert.strictEqual(shown.size, 200)

        const { body } = yield* codesAt(day, CURSOR)
        assert.deepStrictEqual(body.codes, [
          ...numbers(51, 60).map(
            (number) => [TradeNumber.make(String(number)), YP_CC] as const
          ),
          [TradeNumber.make("250"), PD_KZ] as const,
        ])
        for (const [tradeNumber] of body.codes)
          assert.isTrue(shown.has(tradeNumber), tradeNumber)
      })
  )

  it.effect(
    "is not stored while the day is incomplete, and never immutable once complete",
    () =>
      Effect.gen(function* () {
        const day = yield* sealedDay
        yield* day.post(
          "Ajaib",
          numbers(1, 249).map((number) => [number, YP_CC] as const),
          250
        )
        const incomplete = yield* codesAt(day, CURSOR)
        assert.isFalse((yield* day.status).complete)
        assert.isFalse(incomplete.body.complete)
        assert.strictEqual(incomplete.cache, "no-store")

        yield* day.post("Ajaib", [[250, YP_CC]])
        const complete = yield* codesAt(day, CURSOR)
        assert.isTrue((yield* day.status).complete)
        assert.isTrue(complete.body.complete)
        assert.lengthOf(complete.body.codes, 200)
        assert.notInclude(complete.cache ?? "", "immutable")
      })
  )

  it.effect("answers an empty list for a day with no codes", () =>
    Effect.gen(function* () {
      const day = yield* sealedDay
      const answer = yield* codesAt(day, CURSOR)
      assert.strictEqual(answer.text, '{"codes":[],"complete":false}')
      assert.strictEqual(answer.cache, "no-store")
    })
  )
})

describe("a day with no tape", () => {
  it.effect(
    "is made by its broker codes, arms no seal and writes no index row",
    () =>
      Effect.gen(function* () {
        const history = WibDate.make("2026-10-01")
        yield* TestClock.setTime(wib("19:00:00").epochMilliseconds)
        const day = yield* tradingDay({ date: history })
        yield* day.post("Stockbit", [[1, YP_CC]], 1)
        yield* day.alarm
        assert.deepStrictEqual(day.alarms, [])
        assert.deepStrictEqual(day.indexed, [])
        assert.isTrue((yield* day.status).complete)
      })
  )

  it.effect("a past day with a tape still arms its seal", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("15:00:00").epochMilliseconds)
      const sql = memorySql()
      const recording = yield* tradingDay({ sql })
      const socket = yield* recording.relay
      yield* recording.ajaibTrades(socket, [1], "15:00:00")
      yield* recording.day.ingestClosed(socket)

      yield* TestClock.adjust("1 day")
      const restarted = yield* tradingDay({ sql })
      assert.lengthOf(restarted.alarms, 1)
    })
  )
})

// Spec apinrdw/kumora#335, "TradingDay: index broker codes by broker for
// whole-day filters".
describe("the broker trades index", () => {
  it.effect("holds a row per side of each trade a batch kept", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("17:30:00").epochMilliseconds)
      const day = yield* tradingDay()
      yield* day.post("Ajaib", [
        [1, YP_CC],
        [2, codes("AK", "AK", "F", "F")],
      ])
      assert.deepStrictEqual(yield* day.index, [
        ["YP", "D", "buy", 1],
        ["CC", "F", "sell", 1],
        ["AK", "F", "buy", 2],
        ["AK", "F", "sell", 2],
      ])
    })
  )

  it.effect(
    "moves a trade's rows when Ajaib rewrites its codes, and writes none for an agreement or a resent batch",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("17:30:00").epochMilliseconds)
        const day = yield* tradingDay()
        yield* day.post("Ajaib", [[1, YP_CC]])
        day.indexWrites.length = 0

        yield* day.post("Stockbit", [[1, YP_CC]])
        yield* day.post("Ajaib", [[1, YP_CC]])
        yield* day.post("Stockbit", [[1, YP_CC]])
        assert.deepStrictEqual(day.indexWrites, [])

        yield* day.post("Ajaib", [[1, PD_KZ]])
        assert.isNotEmpty(day.indexWrites)
        assert.deepStrictEqual(yield* day.index, [
          ["PD", "F", "buy", 1],
          ["KZ", "D", "sell", 1],
        ])

        yield* day.post("Stockbit", [[1, YP_CC]])
        assert.deepStrictEqual(yield* day.index, [
          ["PD", "F", "buy", 1],
          ["KZ", "D", "sell", 1],
        ])

        day.indexWrites.length = 0
        yield* day.post("Ajaib", [[1, codes("PD", "AK", "F", "D")]])
        assert.lengthOf(day.indexWrites, 2)
        assert.deepStrictEqual(yield* day.index, [
          ["PD", "F", "buy", 1],
          ["AK", "D", "sell", 1],
        ])
      })
  )

  // Random batches over trades 1..2,500 (three chunks) and three brokers.
  const Broker = Schema.Literals(["AK", "YP", "CC"])
  const Type = Schema.Literals(["D", "F"])
  const RandomBatch = Schema.Struct({
    feed: Schema.Literals(["Ajaib", "Stockbit"]),
    rows: Schema.Array(
      Schema.Tuple([
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_500 })),
        Broker,
        Type,
        Broker,
        Type,
      ])
    ),
  })

  it.effect.prop(
    "equals the rows derived from the kept codes after any batches",
    [Schema.Array(RandomBatch)],
    ([batches]) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("17:30:00").epochMilliseconds)
        const day = yield* tradingDay()
        for (const batch of batches)
          yield* day.post(
            batch.feed,
            batch.rows.map(
              ([number, buyer, buyerType, seller, sellerType]) =>
                [number, codes(buyer, seller, buyerType, sellerType)] as const
            )
          )
        const derived: Array<Array<string | number>> = []
        for (const number of numbers(1, 2_500)) {
          const kept = yield* day.held(number)
          if (Option.isNone(kept)) continue
          const { buyer, buyerType, seller, sellerType } = kept.value.codes
          derived.push([buyer, buyerType, "buy", number])
          derived.push([seller, sellerType, "sell", number])
        }
        assert.deepStrictEqual(yield* day.index, derived)
      }),
    { arbitrary: { runs: 50 } }
  )
})

describe("a day stored before the broker trades index", () => {
  const HISTORY = WibDate.make("2026-10-01")
  // One trade at the start of each of 150 chunks, past three rebuild pages.
  const FIRSTS = Array.from({ length: 150 }, (_, chunk) => chunk * 1_000 + 1)

  // The kept codes as index rows, read through the day's codes, not its
  // index.
  const derived = Effect.fnUntraced(function* (
    day: Effect.Success<ReturnType<typeof tradingDay>>,
    tradeNumbers: ReadonlyArray<number>
  ) {
    const rows: Array<Array<string | number>> = []
    for (const number of tradeNumbers) {
      const kept = yield* day.held(number)
      if (Option.isNone(kept)) continue
      const { buyer, buyerType, seller, sellerType } = kept.value.codes
      rows.push([buyer, buyerType, "buy", number])
      rows.push([seller, sellerType, "sell", number])
    }
    return rows
  })

  // A History day's codes, then its database as a release before the index
  // left it: no index rows and no index fact.
  const storedBefore = Effect.gen(function* () {
    yield* TestClock.setTime(wib("19:00:00").epochMilliseconds)
    const sql = memorySql()
    const day = yield* tradingDay({ sql, date: HISTORY })
    yield* day.post(
      "Ajaib",
      FIRSTS.map((number) => [number, YP_CC] as const)
    )
    sql.exec("DELETE FROM broker_trades")
    sql.exec("DELETE FROM facts WHERE key = 'broker-trades'")
    return sql
  })

  // Runs the day's alarm while it re-arms, after the `fired` wakes already
  // run; how many times it ran.
  const alarmsUntilQuiet = Effect.fnUntraced(function* (
    day: Effect.Success<ReturnType<typeof tradingDay>>,
    fired = 0
  ) {
    let runs = 0
    while (day.alarms.length > fired + runs) {
      runs++
      yield* day.alarm
    }
    return runs
  })

  it.effect(
    "arms the alarm at start and rebuilds the index a page a wake",
    () =>
      Effect.gen(function* () {
        const sql = yield* storedBefore
        const day = yield* tradingDay({ sql, date: HISTORY })
        assert.lengthOf(day.alarms, 1)
        assert.deepStrictEqual(yield* day.index, [])

        yield* day.alarm
        assert.lengthOf(yield* day.index, 64 * 2)
        assert.strictEqual(1 + (yield* alarmsUntilQuiet(day, 1)), 3)
        assert.deepStrictEqual(yield* day.index, yield* derived(day, FIRSTS))

        assert.deepStrictEqual(day.indexed, [])
        const restarted = yield* tradingDay({ sql, date: HISTORY })
        assert.deepStrictEqual(restarted.alarms, [])
        assert.deepStrictEqual(
          sql.exec("SELECT value FROM facts WHERE key = 'sealed'"),
          []
        )
      })
  )

  it.effect("a rebuild cut off after a page resumes from the next", () =>
    Effect.gen(function* () {
      const sql = yield* storedBefore
      const first = yield* tradingDay({ sql, date: HISTORY })
      yield* first.alarm
      first.indexWrites.length = 0

      const resumed = yield* tradingDay({ sql, date: HISTORY })
      assert.lengthOf(resumed.alarms, 1)
      assert.strictEqual(yield* alarmsUntilQuiet(resumed), 2)
      assert.lengthOf(resumed.indexWrites, (150 - 64) * 2)
      assert.deepStrictEqual(
        yield* resumed.index,
        yield* derived(resumed, FIRSTS)
      )
    })
  )

  it.effect("a batch between two pages leaves the index as the codes", () =>
    Effect.gen(function* () {
      const sql = yield* storedBefore
      const day = yield* tradingDay({ sql, date: HISTORY })
      yield* day.alarm
      yield* day.post("Ajaib", [
        [1, PD_KZ],
        [100_001, PD_KZ],
        [149_002, YP_CC],
      ])
      yield* alarmsUntilQuiet(day, 1)
      assert.deepStrictEqual(
        yield* day.index,
        yield* derived(
          day,
          [...FIRSTS, 149_002].sort((a, b) => a - b)
        )
      )
    })
  )

  it.effect("a day with no codes at start is never rebuilt", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("19:00:00").epochMilliseconds)
      const sql = memorySql()
      yield* tradingDay({ sql, date: HISTORY })
      sql.exec("DELETE FROM facts WHERE key = 'broker-trades'")
      const restarted = yield* tradingDay({ sql, date: HISTORY })
      assert.deepStrictEqual(restarted.alarms, [])
    })
  )

  // Today's day of 30 Ajaib trades at 15:00 and their codes, its database
  // as a release before the index left it; sealed at 17:00 first when asked.
  const todayStoredBefore = Effect.fnUntraced(function* (sealFirst: boolean) {
    yield* TestClock.setTime(wib("15:00:00").epochMilliseconds)
    const sql = memorySql()
    const recording = yield* tradingDay({ sql })
    const socket = yield* recording.relay
    yield* recording.ajaibTrades(socket, numbers(1, 30), "15:00:00")
    yield* recording.day.ingestClosed(socket)
    if (sealFirst) {
      yield* TestClock.setTime(wib("17:00:00").epochMilliseconds)
      yield* recording.alarm
      assert.lengthOf(recording.indexed, 1)
      yield* TestClock.setTime(wib("17:30:00").epochMilliseconds)
    }
    yield* recording.post(
      "Ajaib",
      numbers(1, 30).map((number) => [number, YP_CC] as const)
    )
    sql.exec("DELETE FROM broker_trades")
    sql.exec("DELETE FROM facts WHERE key = 'broker-trades'")
    return sql
  })

  it.effect(
    "today's rebuild waits for the seal wake and seals on it as before",
    () =>
      Effect.gen(function* () {
        const sql = yield* todayStoredBefore(false)
        const day = yield* tradingDay({ sql })
        assert.deepStrictEqual(day.alarms, [wib("17:00:00")])

        yield* TestClock.setTime(wib("17:00:00").epochMilliseconds)
        yield* day.alarm
        assert.lengthOf(day.indexed, 1)
        assert.deepStrictEqual(
          yield* day.index,
          yield* derived(day, numbers(1, 30))
        )
      })
  )

  it.effect(
    "a sealed day's recorded answers stay byte-identical through the rebuild",
    () =>
      Effect.gen(function* () {
        const sql = yield* todayStoredBefore(true)
        const day = yield* tradingDay({ sql })
        assert.deepStrictEqual(day.alarms, [wib("17:30:00")])
        const resources: ReadonlyArray<RecordedResource> = [
          { _tag: "Codes" },
          { _tag: "Tape", at: wib("17:00:00") },
          { _tag: "Candles", code: StockCode.make("BBCA") },
          { _tag: "Gaps" },
          { _tag: "BrokerCodes", at: wib("17:00:00") },
        ]
        const answers = Effect.forEach(resources, (resource) =>
          Effect.gen(function* () {
            const response = yield* day.day.recorded(resource)
            return {
              status: response.status,
              headers: [...response.headers.entries()],
              body: yield* Effect.promise(() => response.text()),
            }
          })
        )
        const before = yield* answers
        yield* day.alarm
        assert.deepStrictEqual(
          yield* day.index,
          yield* derived(day, numbers(1, 30))
        )
        assert.deepStrictEqual(yield* answers, before)
      })
  )
})
