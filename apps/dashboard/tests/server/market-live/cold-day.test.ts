// A cold day (spec apinrdw/kumora#556): a sealed trading day moved to a
// recorded days bucket in memory, marked cold in a real day index, and read
// back through the Worker's recorded day route, gated by the handler seam's
// real Better Auth.
import { gunzipSync } from "node:zlib"

import { assert, describe, it } from "@effect/vitest"
import {
  WibDate,
  decodeDayStrip,
  recordedDayPath,
  recordedDayRequest,
  StockCode,
  type RecordedResource,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"

import { makeDayIndex } from "@/server/market-live/day-index"
import { makeColdDays, recordedDayRoute } from "@/server/market-live/days"

import { cookiesFrom, linkIn, seam, send, signUp } from "../auth/seam.ts"
import { stockbitBook, stockbitTrade, tradingDay } from "./day-harness"
import { memoryDayBucket } from "./memory-day-bucket"
import { memorySql } from "./sql"

const DAY = WibDate.make("2026-11-09")
const SEALED = "private, max-age=31536000, immutable"
const CODES: RecordedResource = { _tag: "Codes" }
const GAPS: RecordedResource = { _tag: "Gaps" }
// Each code's views the move stores one object for, by its key's folder.
const PER_CODE = [
  ["candles", "Candles"],
  ["sweeps", "Sweeps"],
  ["sweep-brokers", "SweepBrokers"],
  ["heatmap", "Heatmap"],
] as const
const TAPE: RecordedResource = {
  _tag: "Tape",
  at: DateTime.makeUnsafe("2026-11-09T17:00:00+07:00"),
}

const UNTR_CANDLES: RecordedResource = {
  _tag: "Candles",
  code: StockCode.make("UNTR"),
}

const wib = (time: string) => DateTime.makeUnsafe(`2026-11-09T${time}+07:00`)
const at = (time: string) =>
  TestClock.setTime(DateTime.toEpochMillis(wib(time)))
const book = (code: string, minute: string): RecordedResource => ({
  _tag: "Book",
  code: StockCode.make(code),
  minute: wib(minute),
})

const textOf = (response: Response) => Effect.promise(() => response.text())

type Day = Effect.Success<ReturnType<typeof tradingDay>>

// A relay day with a code list naming UNTR and BBCA (none when not
// `listed`), a few UNTR trades and UNTR's book, which a viewer had it record
// (BBCA's isn't), sealed at 17:00 with its relay gaps, then whatever
// `record` adds before the seal, and its row in a day index. It moves to an
// R2 bucket in memory.
const sealedDay = Effect.fnUntraced(function* (
  record: (day: Day) => Effect.Effect<void, unknown> = () => Effect.void,
  listed = true
) {
  yield* at("09:01:10")
  const index = yield* makeDayIndex(memorySql())
  const days = memoryDayBucket()
  const sql = memorySql()
  const target = { bucket: days.bucket, markCold: index.markCold(DAY) }
  const day = yield* tradingDay(sql, [], undefined, target)
  if (listed)
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
    stockbitBook({
      side: "OFFER",
      levels: [[23_325, 2, 40]],
      time: "09:01:10",
    }),
  ])
  yield* TestClock.adjust("2 minutes")
  yield* day.trades([
    stockbitTrade({ number: 1, time: "09:00:10.100", price: 23300, lots: 3 }),
    stockbitTrade({ number: 2, time: "09:00:20.000", price: 23325, lots: 5 }),
  ])
  yield* record(day)
  yield* at("17:00:00")
  yield* day.alarm
  yield* index.record({ day: DAY, trades: 2, gap: true })
  return { day, index, days, sql, target }
})

type Sealed = Effect.Success<ReturnType<typeof sealedDay>>

// The alarm's runs while a move step is due now, at most `runs`; how many.
const alarms = Effect.fnUntraced(function* (day: Sealed["day"], runs = 50) {
  for (let run = 0; run < runs; run++) {
    if (yield* day.emptied) return run
    const due = day.alarms.at(-1)
    if (due === undefined || DateTime.isGreaterThan(due, yield* DateTime.now))
      return run
    yield* day.alarm
  }
  return runs
})

// The day moved to R2 (the harness's `movedToR2`): whether it emptied.
const moved = (sealed: Pick<Sealed, "day">) => sealed.day.movedToR2

const stripDays = (index: Sealed["index"]) =>
  Effect.flatMap(Effect.flatMap(index.strip, textOf), decodeDayStrip).pipe(
    Effect.map((strip) => strip.days)
  )

// The Worker's route over the day's object and the index, each behind a stub
// as the entry reaches them, and the bucket; `reached` lists the objects'
// paths. One isolate's cold days for every GET.
const worker = Effect.fnUntraced(function* (sealed: Sealed) {
  const { layer, mails } = seam()
  const reached: Array<string> = []
  const env = Layer.succeed(WorkerEnv)({
    TRADING_DAY: {
      getByName: () => ({
        fetch: (url: URL) => {
          reached.push(`day ${url.pathname}`)
          const resource = Option.getOrThrow(
            Effect.runSync(recordedDayRequest(url))
          ).resource
          return Effect.runPromise(sealed.day.recorded(resource))
        },
      }),
    },
    MARKET_LIVE_INDEX: {
      getByName: () => ({
        fetch: () => {
          reached.push("index")
          return Effect.runPromise(sealed.index.strip)
        },
      }),
    },
    DAYS_BUCKET: sealed.days.bucket,
  } as unknown as WorkerEnv["Service"])
  const layers = Layer.merge(layer, env)
  yield* signUp("ayu@example.com").pipe(Effect.provide(layer))
  const cookie = cookiesFrom(
    yield* send(linkIn(mails.at(-1))).pipe(Effect.provide(layer))
  )
  const coldDays = yield* makeColdDays
  const get = Effect.fnUntraced(function* (resource: RecordedResource) {
    const url = new URL(
      `https://kumora.test${yield* recordedDayPath(DAY, resource)}`
    )
    return yield* recordedDayRoute(
      new Request(url, { headers: { cookie } }),
      url,
      DAY,
      resource,
      coldDays
    ).pipe(Effect.provide(layers))
  })
  return { get, reached }
})

describe("a cold day", () => {
  it.effect(
    "answers Codes and Gaps from R2, the object's answers gzipped, cached for good",
    () =>
      Effect.gen(function* () {
        const sealed = yield* sealedDay()
        const before = yield* worker(sealed)
        const hot = {
          codes: yield* textOf(yield* before.get(CODES)),
          gaps: yield* textOf(yield* before.get(GAPS)),
          tape: yield* textOf(yield* before.get(TAPE)),
        }
        assert.include(hot.tape, '"tradeNumber":"2"')
        assert.include(hot.codes, "UNTR")
        assert.include(hot.gaps, '"gaps":[{')

        assert.isTrue(yield* moved(sealed))
        assert.isTrue((yield* stripDays(sealed.index))[0]?.cold)

        // A new isolate, so the strip is read again.
        const after = yield* worker(sealed)
        for (const [resource, body] of [
          [CODES, hot.codes],
          [GAPS, hot.gaps],
        ] as const) {
          const response = yield* after.get(resource)
          assert.strictEqual(response.status, 200)
          assert.strictEqual(response.headers.get("Cache-Control"), SEALED)
          assert.strictEqual(response.headers.get("Content-Encoding"), "gzip")
          const stored = new Uint8Array(
            yield* Effect.promise(() => response.arrayBuffer())
          )
          assert.strictEqual(new TextDecoder().decode(gunzipSync(stored)), body)
        }
        // The tape comes from its blocks, not the object.
        const tape = yield* after.get(TAPE)
        assert.strictEqual(tape.headers.get("Cache-Control"), SEALED)
        assert.strictEqual(yield* textOf(tape), hot.tape)
        assert.deepStrictEqual(after.reached, ["index"])

        // An isolate that still counts the day hot reaches its emptied
        // object, which answers from R2 too.
        const stale = yield* sealed.day.recorded(TAPE)
        assert.strictEqual(stale.headers.get("Cache-Control"), SEALED)
        assert.strictEqual(yield* textOf(stale), hot.tape)
        const codes = yield* sealed.day.recorded(CODES)
        assert.strictEqual(codes.headers.get("Content-Encoding"), "gzip")
      })
  )

  it.effect(
    "answers each listed code's Candles, Sweeps, SweepBrokers and Heatmap from one R2 read, the object's answers gzipped, cached for good",
    () =>
      Effect.gen(function* () {
        const sealed = yield* sealedDay()
        const resources = ["UNTR", "BBCA"].flatMap((code) =>
          PER_CODE.map(
            ([folder, _tag]) =>
              [
                `days/2026-11-09/v6/${folder}/${code}.json.gz`,
                { _tag, code: StockCode.make(code) },
              ] as const
          )
        )
        const before = yield* worker(sealed)
        const hot = new Map<string, string>()
        for (const [key, resource] of resources)
          hot.set(key, yield* textOf(yield* before.get(resource)))
        assert.include(
          hot.get("days/2026-11-09/v6/candles/UNTR.json.gz"),
          '"close":23325'
        )
        assert.include(
          hot.get("days/2026-11-09/v6/heatmap/BBCA.json.gz"),
          '"notRecorded":true'
        )
        assert.notInclude(
          hot.get("days/2026-11-09/v6/heatmap/UNTR.json.gz"),
          "notRecorded"
        )

        yield* moved(sealed)
        const after = yield* worker(sealed)
        for (const [key, resource] of resources) {
          sealed.days.reads.length = 0
          const response = yield* after.get(resource)
          assert.deepStrictEqual(sealed.days.reads, [key])
          assert.strictEqual(response.status, 200)
          assert.strictEqual(response.headers.get("Cache-Control"), SEALED)
          assert.strictEqual(response.headers.get("Content-Encoding"), "gzip")
          const stored = new Uint8Array(
            yield* Effect.promise(() => response.arrayBuffer())
          )
          assert.strictEqual(
            new TextDecoder().decode(gunzipSync(stored)),
            hot.get(key)
          )
        }
        assert.deepStrictEqual(after.reached, ["index"])
      })
  )

  it.effect(
    "with no code list, answers each traded code's views from R2, and Codes and an untraded code's views not recorded",
    () =>
      Effect.gen(function* () {
        const sealed = yield* sealedDay(undefined, false)
        const traded = PER_CODE.map(
          ([, _tag]) =>
            ({ _tag, code: StockCode.make("UNTR") }) as RecordedResource
        )
        const before = yield* worker(sealed)
        const hot = []
        for (const resource of traded)
          hot.push(yield* textOf(yield* before.get(resource)))
        assert.include(hot[0], '"close":23325')
        assert.strictEqual((yield* before.get(CODES)).status, 404)

        assert.isTrue(yield* moved(sealed))
        const after = yield* worker(sealed)
        for (const [index, resource] of traded.entries()) {
          const response = yield* after.get(resource)
          assert.strictEqual(response.status, 200)
          assert.strictEqual(response.headers.get("Content-Encoding"), "gzip")
          const stored = new Uint8Array(
            yield* Effect.promise(() => response.arrayBuffer())
          )
          assert.strictEqual(
            new TextDecoder().decode(gunzipSync(stored)),
            hot[index]
          )
        }
        for (const resource of [
          CODES,
          { _tag: "Candles", code: StockCode.make("BBCA") } as const,
        ]) {
          const response = yield* after.get(resource)
          assert.strictEqual(response.status, 404)
          assert.strictEqual(response.headers.get("Cache-Control"), "no-store")
        }
        assert.deepStrictEqual(after.reached, ["index"])
      })
  )

  it.effect(
    "stores the final broker codes status and a manifest beside its answers",
    () =>
      Effect.gen(function* () {
        const sealed = yield* sealedDay()
        yield* moved(sealed)
        assert.deepStrictEqual(
          [...sealed.days.objects.keys()].sort(),
          [
            "days/2026-11-09/manifest.json",
            "days/2026-11-09/status.json",
            "days/2026-11-09/v6/book/UNTR.bin",
            ...["BBCA", "IHSG", "NG.IHSG", "TN.IHSG", "UNTR"].flatMap((code) =>
              PER_CODE.map(
                ([folder]) => `days/2026-11-09/v6/${folder}/${code}.json.gz`
              )
            ),
            "days/2026-11-09/v6/codes.json.gz",
            "days/2026-11-09/v6/gaps.json.gz",
            "days/2026-11-09/v6/tape/1.bin",
            "days/2026-11-09/v6/tape/index.json",
          ].sort()
        )
        assert.deepStrictEqual(
          JSON.parse(sealed.days.text("days/2026-11-09/manifest.json")!),
          { viewerProtocol: 6 }
        )
        const status = JSON.parse(
          sealed.days.text("days/2026-11-09/status.json")!
        )
        assert.strictEqual(status.day, DAY)
        assert.strictEqual(status.complete, false)
      })
  )

  it.effect(
    "is never marked cold without its manifest, and stays served by its object until a retry a minute later lands it",
    () =>
      Effect.gen(function* () {
        const sealed = yield* sealedDay()
        sealed.days.refused.add("days/2026-11-09/manifest.json")
        assert.isFalse(yield* moved(sealed))
        assert.isUndefined((yield* stripDays(sealed.index))[0]?.cold)

        const hot = yield* worker(sealed)
        const codes = yield* hot.get(CODES)
        assert.isNull(codes.headers.get("Content-Encoding"))
        assert.deepStrictEqual(hot.reached, [
          "index",
          "day /market-live/days/2026-11-09/codes",
        ])

        sealed.days.refused.clear()
        yield* TestClock.adjust("1 minute")
        yield* alarms(sealed.day)
        assert.isTrue(yield* sealed.day.emptied)
        assert.isTrue((yield* stripDays(sealed.index))[0]?.cold)
      })
  )

  it.effect(
    "moves a day with no code list whole when its object restarts after each step, served hot by its object until the index marks it cold",
    () =>
      Effect.gen(function* () {
        const whole = yield* sealedDay(undefined, false)
        yield* moved(whole)
        const sealed = yield* sealedDay(undefined, false)
        const before = yield* worker(sealed)
        const hot = yield* textOf(yield* before.get(UNTR_CANDLES))
        yield* TestClock.setTime(
          DateTime.toEpochMillis(
            DateTime.makeUnsafe("2026-11-24T00:00:00+07:00")
          )
        )
        assert.isTrue(yield* sealed.day.move)
        let day = sealed.day
        let steps = 0
        while (!(yield* day.emptied)) {
          assert.isUndefined((yield* stripDays(sealed.index))[0]?.cold)
          const served = yield* worker({ ...sealed, day })
          assert.strictEqual(
            yield* textOf(yield* served.get(UNTR_CANDLES)),
            hot
          )
          assert.deepStrictEqual(served.reached, [
            "index",
            "day /market-live/days/2026-11-09/candles/UNTR",
          ])
          yield* day.evicted
          day = yield* tradingDay(sealed.sql, [], undefined, sealed.target)
          assert.strictEqual(yield* alarms(day, 1), 1)
          steps++
        }
        // Its answers, its tape, its books, then its status and manifest.
        assert.strictEqual(steps, 4)
        assert.isTrue((yield* stripDays(sealed.index))[0]?.cold)
        assert.deepStrictEqual(
          [...sealed.days.objects.keys()].sort(),
          [...whole.days.objects.keys()].sort()
        )
        for (const [key, bytes] of whole.days.objects)
          assert.deepStrictEqual(sealed.days.objects.get(key), bytes, key)
      })
  )

  it.effect(
    "answers Book from R2 as its object did, the chunk before a minute with none, and not recorded for a code with no book",
    () =>
      Effect.gen(function* () {
        // UNTR's book, recorded from 09:01:10, viewed again from 09:04 and
        // sent at 09:04 and 09:07.
        const sealed = yield* sealedDay(
          Effect.fnUntraced(function* (day) {
            yield* at("09:04:00")
            yield* day.left(yield* day.viewer("UNTR"))
            for (const [time, bid] of [
              ["09:04:03", 60],
              ["09:07:03", 90],
            ] as const) {
              yield* at(time)
              yield* day.frames([
                stockbitBook({ side: "BID", levels: [[23_300, 3, bid]], time }),
                stockbitBook({
                  side: "OFFER",
                  levels: [[23_325, 2, 40]],
                  time,
                }),
              ])
            }
          })
        )
        const minutes = [
          book("UNTR", "09:04:00"),
          book("UNTR", "09:05:00"),
          book("UNTR", "09:07:30"),
          book("UNTR", "15:00:00"),
        ]
        const notRecorded = [book("UNTR", "09:00:00"), book("BBCA", "09:05:00")]
        const before = yield* worker(sealed)
        const hot = []
        for (const resource of minutes)
          hot.push(yield* textOf(yield* before.get(resource)))
        // 09:05 has no frame: the 09:04 chunk is in force.
        assert.strictEqual(hot[1], hot[0])
        assert.notStrictEqual(hot[2], hot[0])
        assert.strictEqual(hot[3], hot[2])
        for (const resource of notRecorded)
          assert.strictEqual((yield* before.get(resource)).status, 404)

        yield* moved(sealed)
        const after = yield* worker(sealed)
        for (const [index, resource] of minutes.entries()) {
          const response = yield* after.get(resource)
          assert.strictEqual(response.status, 200)
          assert.strictEqual(response.headers.get("Cache-Control"), SEALED)
          assert.strictEqual(response.headers.get("Content-Encoding"), "gzip")
          const stored = new Uint8Array(
            yield* Effect.promise(() => response.arrayBuffer())
          )
          assert.strictEqual(
            new TextDecoder().decode(gunzipSync(stored)),
            hot[index]
          )
        }
        for (const resource of notRecorded) {
          const response = yield* after.get(resource)
          assert.strictEqual(response.status, 404)
          assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
            error: "NotFound",
            message: "Not recorded",
          })
        }
        assert.deepStrictEqual(after.reached, ["index"])
      })
  )

  it.effect("stays cold in the strip through a retried seal's row", () =>
    Effect.gen(function* () {
      const index = yield* makeDayIndex(memorySql())
      const row = { day: DAY, trades: 2, gap: false }
      yield* index.record(row)
      yield* index.markCold(DAY)
      yield* index.markCold(DAY)
      yield* index.record(row)
      // A day with no row isn't listed.
      yield* index.markCold(WibDate.make("2026-11-10"))
      assert.deepStrictEqual(yield* stripDays(index), [{ ...row, cold: true }])
    })
  )

  it.effect("does not move before its seal", () =>
    Effect.gen(function* () {
      yield* at("10:00:00")
      const days = memoryDayBucket()
      const index = yield* makeDayIndex(memorySql())
      const day = yield* tradingDay(memorySql(), [], undefined, {
        bucket: days.bucket,
        markCold: index.markCold(DAY),
      })
      assert.isFalse(yield* moved({ day }))
      assert.strictEqual(days.objects.size, 0)
    })
  )
})
