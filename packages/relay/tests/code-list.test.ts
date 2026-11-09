import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"

import {
  StockCode,
  WibDate,
  decodeStockCodeList,
  encodeStockCodeList,
  stockCodeListDay,
  stockCodeListPath,
} from "@workspace/relay"

describe("the stock code list path", () => {
  it.effect("names its day, and the Worker reads the day back", () =>
    Effect.gen(function* () {
      const day = WibDate.make("2026-11-09")
      const path = yield* stockCodeListPath(day)
      assert.strictEqual(path, "/market-live/days/2026-11-09/codes")
      assert.deepStrictEqual(yield* stockCodeListDay(path), Option.some(day))
    })
  )

  it.effect("reads no day from any other path", () =>
    Effect.gen(function* () {
      for (const path of [
        "/market-live/days/latest/codes",
        "/market-live/days/2026-11-09/tape",
        "/market-live/days//codes",
        "/market-live/live",
      ])
        assert.isTrue(Option.isNone(yield* stockCodeListDay(path)), path)
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
