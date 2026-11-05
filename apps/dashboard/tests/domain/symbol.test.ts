import { Schema } from "effect"
import { describe, expect, test } from "vitest"

import { Watchlist } from "@/domain/alert"
import { Symbol } from "@/domain/symbol"
import { isSymbol } from "@/domain/symbol-guard"

describe("Symbol", () => {
  test("decodes a four-letter IDX code", () => {
    expect(Schema.decodeUnknownSync(Symbol)("BBCA")).toBe("BBCA")
  })

  test.each(["bbca", "BBC", "BBCAX", "BB1A", ""])("rejects %j", (raw) => {
    expect(() => Schema.decodeUnknownSync(Symbol)(raw)).toThrow(
      /\^\[A-Z\]\{4\}\$/
    )
  })

  test("a fixture written with a malformed symbol fails at construction", () => {
    expect(() => Symbol.make("bbca")).toThrow("Schema validation failed")
  })
})

describe("isSymbol", () => {
  test("accepts a four-letter IDX code", () => {
    expect(isSymbol("BBCA")).toBe(true)
  })

  test.each(["bbca", "BBC", "BBCAX", "BB1A", "", 1234, null, undefined])(
    "rejects %j",
    (raw) => {
      expect(isSymbol(raw)).toBe(false)
    }
  )
})

describe("decoding a watchlist", () => {
  const watchlist = {
    id: "utama",
    name: "Watchlist Utama",
    symbols: ["BBCA", "TLKM"],
  }

  test("a well-formed watchlist decodes", () => {
    expect(Schema.decodeUnknownSync(Watchlist)(watchlist)).toEqual(watchlist)
  })

  test("a watchlist with a malformed symbol is rejected", () => {
    const malformed = { ...watchlist, symbols: ["BBCA", "tlkm"] }
    expect(() => Schema.decodeUnknownSync(Watchlist)(malformed)).toThrow(
      /symbols/
    )
  })
})
