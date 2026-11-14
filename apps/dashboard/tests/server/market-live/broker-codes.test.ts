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
  return {
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
  // with every other trade missing, its chunks written straight into the
  // table, since posting 750,000 rows would take minutes.
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
      })
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
