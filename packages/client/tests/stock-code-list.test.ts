import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { StockCode, searchStockCodes } from "@workspace/client"
import type { ListedCode } from "@workspace/relay"

const listed = (
  code: string,
  name: string,
  kind: ListedCode["kind"] = "share"
): ListedCode => ({ code: StockCode.make(code), name, kind })

// In Ajaib's order, which is no order at all.
const CODES = [
  listed("BUMI-W", "Waran Seri I Bumi Resources", "warrant"),
  listed("BRMS", "Bumi Resources Minerals Tbk."),
  listed("WIFI-R", "HMETD Solusi Sinergi Digital Tbk.", "right"),
  listed("BUMIDRCM3A", "Call Warrant BUMI DR Exp 19 Jun 23"),
  listed("BUMI", "Bumi Resources Tbk"),
  listed("WIFI", "Solusi Sinergi Digital Tbk."),
  listed("BUKA", "Bukalapak.com Tbk."),
  listed("BBCA", "Bank Central Asia Tbk"),
  listed("TN.IHSG", "IDX Composite, cash market", "index"),
  listed("TNCA-W", "Waran Seri I Trimuda Nuansa Citra", "warrant"),
]

const codesFor = (query: string, limit = 10) =>
  searchStockCodes(CODES, query, limit).pipe(
    Effect.map((found) => found.map(({ code }) => code))
  )

describe("stock code search", () => {
  it.effect("puts the exact code first, then codes starting with it", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* codesFor("bumi"), [
        "BUMI",
        "BUMIDRCM3A",
        "BUMI-W",
        "BRMS",
      ])
    })
  )

  it.effect("ranks warrants and rights below shares", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* codesFor("WIF"), ["WIFI", "WIFI-R"])
      assert.deepStrictEqual(yield* codesFor("BU"), [
        "BUKA",
        "BUMI",
        "BUMIDRCM3A",
        "BUMI-W",
        // By name: Bumi Resources Minerals.
        "BRMS",
      ])
    })
  )

  it.effect("ranks an index with shares, above warrants", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* codesFor("TN"), ["TN.IHSG", "TNCA-W"])
    })
  )

  it.effect("an exact warrant code still comes first", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* codesFor("BUMI-W"), ["BUMI-W"])
    })
  )

  it.effect("matches names, and an empty query offers shares first", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* codesFor("central"), ["BBCA"])
      assert.deepStrictEqual(yield* codesFor(" ", 3), ["BBCA", "BRMS", "BUKA"])
      assert.deepStrictEqual(yield* codesFor("nothing like it"), [])
    })
  )
})
