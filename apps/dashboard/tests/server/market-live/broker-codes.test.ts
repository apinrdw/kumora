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
  encodeBrokerCodesBatch,
  encodeIngestUp,
  type BrokerCodesBatch,
  type Feed,
  type RecordedDay,
  type RecordedResource,
  type TradeCodes,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Layer, Option, Scope } from "effect"
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
  const alarms: Array<DateTime.Utc> = []
  const indexed: Array<RecordedDay> = []
  const relays: Array<FakeSocket> = []
  const day = yield* makeTradingDay({
    sql: options.sql ?? memorySql(),
    date,
    viewers: Effect.succeed([]),
    viewersOf: () => Effect.succeed([]),
    ingests: Effect.sync(() => relays),
    setAlarm: (at) => Effect.sync(() => void alarms.push(at)),
    recordDay: (row) => Effect.sync(() => void indexed.push(row)),
  }).pipe(Scope.provide(yield* Scope.make()))

  const post = Effect.fnUntraced(function* (
    feed: Feed,
    rows: ReadonlyArray<readonly [number, TradeCodes]>,
    end?: number
  ) {
    const batch: BrokerCodesBatch = {
      version: BrokerCodesProtocolVersion,
      feed,
      day: date,
      rows: rows.map(([number, each]) => [
        TradeNumber.make(String(number)),
        each,
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
  const statusText = Effect.gen(function* () {
    const response = yield* day.brokerCodes.status
    assert.strictEqual(response.headers.get("Cache-Control"), "no-store")
    return yield* Effect.promise(() => response.text())
  })
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
  return {
    day,
    post,
    status,
    statusText,
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

        yield* TestClock.setTime(wib("17:30:00").epochMilliseconds)
        yield* day.post(
          "Ajaib",
          numbers(1, 30).map((number) => [number, YP_CC] as const),
          30
        )
        yield* day.post("Stockbit", [[1, PD_KZ]], 30)
        assert.isTrue((yield* day.status).complete)
        assert.deepStrictEqual(yield* answers, before)
        assert.lengthOf(day.indexed, 1)
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
