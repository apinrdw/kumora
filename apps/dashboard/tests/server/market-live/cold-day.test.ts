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
  type RecordedResource,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Exit, Layer, Option } from "effect"
import { TestClock } from "effect/testing"

import { makeDayIndex } from "@/server/market-live/day-index"
import { makeColdDays, recordedDayRoute } from "@/server/market-live/days"

import { cookiesFrom, linkIn, seam, send, signUp } from "../auth/seam.ts"
import { stockbitTrade, tradingDay } from "./day-harness"
import { memoryDayBucket } from "./memory-day-bucket"
import { memorySql } from "./sql"

const DAY = WibDate.make("2026-11-09")
const SEALED = "private, max-age=31536000, immutable"
const CODES: RecordedResource = { _tag: "Codes" }
const GAPS: RecordedResource = { _tag: "Gaps" }
const TAPE: RecordedResource = {
  _tag: "Tape",
  at: DateTime.makeUnsafe("2026-11-09T17:00:00+07:00"),
}

const at = (time: string) =>
  TestClock.setTime(
    DateTime.toEpochMillis(DateTime.makeUnsafe(`2026-11-09T${time}+07:00`))
  )

const textOf = (response: Response) => Effect.promise(() => response.text())

// A relay day with a code list and a few UNTR trades, sealed at 17:00 with
// its relay gaps, and its row in a day index.
const sealedDay = Effect.fnUntraced(function* () {
  yield* at("09:01:10")
  const day = yield* tradingDay(memorySql())
  yield* day.codeList(
    JSON.stringify({
      results: [{ code: "UNTR", name: "United Tractors" }],
    })
  )
  yield* day.trades([
    stockbitTrade({ number: 1, time: "09:00:10.100", price: 23300, lots: 3 }),
    stockbitTrade({ number: 2, time: "09:00:20.000", price: 23325, lots: 5 }),
  ])
  yield* at("17:00:00")
  yield* day.alarm
  const index = yield* makeDayIndex(memorySql())
  yield* index.record({ day: DAY, trades: 2, gap: true })
  const days = memoryDayBucket()
  const target = { bucket: days.bucket, markCold: index.markCold(DAY) }
  return { day, index, days, target }
})

type Sealed = Effect.Success<ReturnType<typeof sealedDay>>

// The day's move, the test entry point. The index's mark needs no binding.
const moved = (sealed: Pick<Sealed, "day" | "target">) =>
  sealed.day.day
    .move(sealed.target)
    .pipe(
      Effect.provideService(WorkerEnv, {} as unknown as WorkerEnv["Service"])
    )

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
      })
  )

  it.effect(
    "stores the final broker codes status and a manifest beside its answers",
    () =>
      Effect.gen(function* () {
        const sealed = yield* sealedDay()
        yield* moved(sealed)
        assert.deepStrictEqual([...sealed.days.objects.keys()].sort(), [
          "days/2026-11-09/manifest.json",
          "days/2026-11-09/status.json",
          "days/2026-11-09/v6/codes.json.gz",
          "days/2026-11-09/v6/gaps.json.gz",
          "days/2026-11-09/v6/tape/1.bin",
          "days/2026-11-09/v6/tape/index.json",
        ])
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
    "is never marked cold without its manifest, and stays served by its object until a retry lands it",
    () =>
      Effect.gen(function* () {
        const sealed = yield* sealedDay()
        sealed.days.refused.add("days/2026-11-09/manifest.json")
        const failed = yield* Effect.exit(moved(sealed))
        assert.isTrue(Exit.isFailure(failed))
        assert.isUndefined((yield* stripDays(sealed.index))[0]?.cold)

        const hot = yield* worker(sealed)
        const codes = yield* hot.get(CODES)
        assert.isNull(codes.headers.get("Content-Encoding"))
        assert.deepStrictEqual(hot.reached, [
          "index",
          "day /market-live/days/2026-11-09/codes",
        ])

        sealed.days.refused.clear()
        yield* moved(sealed)
        assert.isTrue((yield* stripDays(sealed.index))[0]?.cold)
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
      const day = yield* tradingDay(memorySql())
      const index = yield* makeDayIndex(memorySql())
      const days = memoryDayBucket()
      assert.isFalse(
        yield* moved({
          day,
          target: { bucket: days.bucket, markCold: index.markCold(DAY) },
        })
      )
      assert.strictEqual(days.objects.size, 0)
    })
  )
})
