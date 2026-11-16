import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Option } from "effect"

import {
  StockCode,
  WibDate,
  decodeAjaibCodeList,
  decodeStockCodeList,
  encodeStockCodeList,
  DayStripPath,
  recordedDayPath,
  recordedDayRequest,
  stockCodeListPath,
  type RecordedResource,
} from "@workspace/relay"

const locationOf = (path: string) => {
  const at = path.indexOf("?")
  return at < 0
    ? { pathname: path, search: "" }
    : { pathname: path.slice(0, at), search: path.slice(at) }
}

describe("recorded day paths", () => {
  it.effect("name their day and resource, and the Worker reads both back", () =>
    Effect.gen(function* () {
      const day = WibDate.make("2026-11-09")
      const at = DateTime.makeUnsafe("2026-11-09T03:15:00.000Z")
      const code = StockCode.make("BBCA")
      const resources: ReadonlyArray<RecordedResource> = [
        { _tag: "Codes" },
        { _tag: "Tape", at },
        { _tag: "BrokerCodes", at },
        { _tag: "Candles", code },
        { _tag: "Sweeps", code },
        { _tag: "SweepBrokers", code },
        { _tag: "Book", code, minute: at },
        { _tag: "Gaps" },
        { _tag: "Bubbles" },
      ]
      assert.strictEqual(
        yield* stockCodeListPath(day),
        "/market-live/days/2026-11-09/codes"
      )
      assert.strictEqual(
        yield* recordedDayPath(day, { _tag: "Tape", at }),
        "/market-live/days/2026-11-09/trades?at=1794194100000"
      )
      assert.strictEqual(
        yield* recordedDayPath(day, { _tag: "BrokerCodes", at }),
        "/market-live/days/2026-11-09/broker-codes?at=1794194100000"
      )
      assert.strictEqual(
        yield* recordedDayPath(day, { _tag: "SweepBrokers", code }),
        "/market-live/days/2026-11-09/sweep-brokers/BBCA"
      )
      assert.strictEqual(
        yield* recordedDayPath(day, { _tag: "Bubbles" }),
        "/market-live/days/2026-11-09/bubbles"
      )
      for (const resource of resources) {
        const path = yield* recordedDayPath(day, resource)
        assert.deepStrictEqual(
          yield* recordedDayRequest(locationOf(path)),
          Option.some({ date: day, resource }),
          path
        )
      }
    })
  )

  it.effect(
    "a recorded day's candles are asked at a path a browser never cached an answer without footprints or buy and sell value at; the bare path still reads",
    () =>
      Effect.gen(function* () {
        const day = WibDate.make("2026-11-09")
        const resource = {
          _tag: "Candles",
          code: StockCode.make("BBCA"),
        } as const
        const beforeFootprints = "/market-live/days/2026-11-09/candles/BBCA"
        const path = yield* recordedDayPath(day, resource)
        assert.notStrictEqual(path, beforeFootprints)
        // Version 3's answer carried no buy value or sell value.
        assert.notStrictEqual(path, `${beforeFootprints}?v=3`)
        assert.isTrue(path.startsWith(beforeFootprints))
        assert.deepStrictEqual(
          yield* recordedDayRequest(locationOf(beforeFootprints)),
          Option.some({ date: day, resource })
        )
      })
  )

  it.effect("read nothing from any other path", () =>
    Effect.gen(function* () {
      for (const path of [
        DayStripPath,
        "/market-live/days/latest/codes",
        "/market-live/days/2026-11-09/tape",
        "/market-live/days/2026-11-09/trades",
        "/market-live/days/2026-11-09/trades?at=soon",
        "/market-live/days/2026-11-09/broker-codes",
        "/market-live/days/2026-11-09/broker-codes?at=soon",
        "/market-live/days/2026-11-31/broker-codes?at=1794194100000",
        "/market-live/days/2026-11-09/books/BBCA",
        "/market-live/days/2026-11-09/codes/more",
        "/market-live/days//codes",
        "/market-live/days/2026-11-09/constructor",
        "/market-live/days/2026-11-09/__proto__",
        "/market-live/days/2026-11-09/toString",
        "/market-live/live",
      ])
        assert.isTrue(
          Option.isNone(yield* recordedDayRequest(locationOf(path))),
          path
        )
    })
  )
})

describe("Ajaib's code list", () => {
  it.effect(
    "drops an entry whose code isn't a stock code's shape, like the empty one",
    () =>
      Effect.gen(function* () {
        const listed = yield* decodeAjaibCodeList(
          JSON.stringify({
            results: [
              { code: "BBCA", name: "Bank Central Asia Tbk" },
              { code: "", name: null },
              { code: "not a code", name: null },
              { code: "TOOLONGFORACODE12", name: null },
            ],
          })
        )
        assert.deepStrictEqual(
          listed.map(({ code }) => code),
          [StockCode.make("BBCA")]
        )
      })
  )
})

describe("the stock code list", () => {
  it.effect("round-trips, and rejects an unknown kind", () =>
    Effect.gen(function* () {
      const list = {
        codes: [
          {
            code: StockCode.make("BUMI"),
            name: "Bumi Resources Tbk",
            kind: "share" as const,
          },
          { code: StockCode.make("WIFI-R"), name: "", kind: "right" as const },
        ],
      }
      const text = yield* encodeStockCodeList(list)
      assert.deepStrictEqual(yield* decodeStockCodeList(text), list)
      const bad = yield* Effect.flip(
        decodeStockCodeList(
          JSON.stringify({ codes: [{ code: "X", name: "", kind: "bond" }] })
        )
      )
      assert.strictEqual(bad._tag, "SchemaError")
    })
  )
})
