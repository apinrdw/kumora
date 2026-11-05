import { describe, expect, test } from "vitest"

import type { Trade } from "@/domain/trade"
import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import {
  NO_QUOTE,
  applyTrades,
  foldLivePrice,
  lastRgTrade,
  wallCoverageFrom,
  quoteOf,
  shouldWriteQuote,
} from "@/relay/quote"
import type { RawLivePrice } from "@/relay/stockbit"
import { decodeWrap } from "@/relay/stockbit"
import { toTrades } from "@/relay/tape"

import { capturedFrames, wireBatch } from "../support/stockbit-wire"

const AT = IsoDateTime.make("2026-10-29T06:30:01.000Z")

const raw = (over: Partial<RawLivePrice> = {}): RawLivePrice => ({
  stock: "BBCA",
  date: "2026-10-29T13:30:01.000",
  prev: 5275,
  open: 5275,
  high: 5325,
  low: 5000,
  average: 5115,
  volume: 148_143_100,
  value: 757_806_850_000,
  frequency: 29_235,
  lastprice: null,
  verb: null,
  quantity: null,
  orderNumber: null,
  matchNumber: null,
  ...over,
})

const trade = (over: Partial<Trade>): Trade => ({
  symbol: Symbol.make("AMMN"),
  price: 9000,
  volume: 100,
  value: 900_000,
  side: "buy",
  board: "RG",
  tradeNumber: 1,
  tradedAt: IsoDateTime.make(AT),
  receivedAt: IsoDateTime.make(AT),
  change: 50,
  ...over,
})

describe("foldLivePrice", () => {
  test("takes the day's totals from a first frame", () => {
    const fold = foldLivePrice(null, raw(), "2026-10-29", AT)
    expect(fold?.changed).toBe(true)
    expect(fold?.totals).toMatchObject({
      day: "2026-10-29",
      prev: 5275,
      volume: 148_143_100,
      asOf: AT,
    })
  })

  test("a repeated frame is no change and keeps its as-of", () => {
    const first = foldLivePrice(null, raw(), "2026-10-29", AT)
    const again = foldLivePrice(
      first?.totals ?? null,
      raw(),
      "2026-10-29",
      IsoDateTime.make("2026-10-29T06:30:05.000Z")
    )
    expect(again?.changed).toBe(false)
    expect(again?.totals.asOf).toBe(AT)
  })

  test("a field absent from a frame keeps the figure it had", () => {
    const first = foldLivePrice(null, raw(), "2026-10-29", AT)
    const next = foldLivePrice(
      first?.totals ?? null,
      raw({ high: null, volume: 148_200_000 }),
      "2026-10-29",
      AT
    )
    expect(next?.totals.high).toBe(5325)
    expect(next?.totals.volume).toBe(148_200_000)
    expect(next?.changed).toBe(true)
  })

  test("a frame from another day than the relay's is dropped", () => {
    const yesterday = raw({ date: "2026-10-28T15:59:00.000" })
    expect(foldLivePrice(null, yesterday, "2026-10-29", AT)).toBeNull()
  })

  test("with no day on the relay yet, the frame is dropped", () => {
    expect(foldLivePrice(null, raw(), null, AT)).toBeNull()
  })

  describe("frames arriving out of order from two tabs", () => {
    const stamped = (date: string, volume: number) => raw({ date, volume })
    const heldAt = (date: string) =>
      foldLivePrice(null, stamped(date, 200_000), "2026-10-29", AT)?.totals ??
      null

    test("an older frame is rejected and leaves the totals alone", () => {
      const held = heldAt("2026-10-29T13:30:05.272939+07:00")
      const delayed = stamped("2026-10-29T13:30:01.371199+07:00", 100_000)
      expect(foldLivePrice(held, delayed, "2026-10-29", AT)).toBeNull()
    })

    test("the stamp's varying fractional digits keep their order", () => {
      const held = heldAt("2026-10-29T13:36:35.9991+07:00")
      const older = stamped("2026-10-29T13:36:35.99906+07:00", 100_000)
      const newer = stamped("2026-10-29T13:36:35.99911+07:00", 300_000)
      expect(foldLivePrice(held, older, "2026-10-29", AT)).toBeNull()
      expect(foldLivePrice(held, newer, "2026-10-29", AT)?.totals.volume).toBe(
        300_000
      )
    })

    test("a correction with a lower figure folds when it is not older", () => {
      const held = heldAt("2026-10-29T13:30:05+07:00")
      for (const date of [
        "2026-10-29T13:30:05+07:00",
        "2026-10-29T13:30:06+07:00",
      ]) {
        const fold = foldLivePrice(
          held,
          stamped(date, 150_000),
          "2026-10-29",
          AT
        )
        expect(fold?.changed).toBe(true)
        expect(fold?.totals.volume).toBe(150_000)
      }
    })

    test("a frame with no stamp cannot be ordered, so it folds and keeps the held stamp", () => {
      const held = heldAt("2026-10-29T13:30:05+07:00")
      const undated = foldLivePrice(
        held,
        raw({ date: null, volume: 250_000 }),
        "2026-10-29",
        AT
      )
      expect(undated?.totals.volume).toBe(250_000)
      const delayed = stamped("2026-10-29T13:30:01+07:00", 100_000)
      expect(
        foldLivePrice(undated?.totals ?? null, delayed, "2026-10-29", AT)
      ).toBeNull()
    })

    test("yesterday's stamp does not hold back a new day's first frame", () => {
      const yesterday = foldLivePrice(
        null,
        stamped("2026-10-28T15:59:00+07:00", 200_000),
        "2026-10-28",
        AT
      )
      const fold = foldLivePrice(
        yesterday?.totals ?? null,
        stamped("2026-10-29T09:00:00+07:00", 100),
        "2026-10-29",
        AT
      )
      expect(fold?.totals.volume).toBe(100)
    })
  })
})

describe("quoteOf", () => {
  test("is all dashes with nothing known", () => {
    expect(quoteOf(null, null)).toEqual(NO_QUOTE)
  })

  test("last is the newest RG trade and prev falls back to price minus change", () => {
    expect(quoteOf({ price: 9000, change: 50, receivedAt: AT }, null)).toEqual({
      ...NO_QUOTE,
      last: 9000,
      prev: 8950,
    })
  })

  test("liveprice's prev wins once a frame has arrived, and its last is not read", () => {
    const totals = foldLivePrice(null, raw(), "2026-10-29", AT)?.totals ?? null
    expect(
      quoteOf({ price: 5050, change: -225, receivedAt: AT }, totals)
    ).toEqual({
      last: 5050,
      prev: 5275,
      open: 5275,
      high: 5325,
      low: 5000,
      avg: 5115,
      volumeLot: 1_481_431,
      value: 757_806_850_000,
      freq: 29_235,
    })
  })

  test("totals with no trade leave last unknown", () => {
    const totals = foldLivePrice(null, raw(), "2026-10-29", AT)?.totals ?? null
    expect(quoteOf(null, totals).last).toBeNull()
    expect(quoteOf(null, totals).prev).toBe(5275)
  })
})

describe("the RG rule", () => {
  test("an NG trade sets neither last nor previous close", () => {
    const ng = trade({ board: "NG", price: 7000, change: -2000 })
    expect(lastRgTrade([ng])).toBeNull()
    expect(applyTrades(NO_QUOTE, [ng])).toBe(NO_QUOTE)
  })

  test("the newest RG trade wins over an NG trade after it", () => {
    const rg = trade({ tradeNumber: 1, price: 9000 })
    const ng = trade({ tradeNumber: 2, board: "NG", price: 7000 })
    expect(lastRgTrade([rg, ng])).toBe(rg)
    expect(applyTrades(NO_QUOTE, [rg, ng])).toEqual({
      ...NO_QUOTE,
      last: 9000,
      prev: 8950,
    })
  })

  test("a known previous close is kept when a trade arrives", () => {
    const quote = { ...NO_QUOTE, prev: 8900 }
    expect(applyTrades(quote, [trade({})])).toEqual({
      ...NO_QUOTE,
      last: 9000,
      prev: 8900,
    })
  })

  test("AMMN's NG trade, through the decoder, sets nothing", () => {
    const frame = decodeWrap(
      wireBatch([
        {
          stock: "AMMN",
          price: 7000,
          change: -2000,
          board: 3,
          tradeNumber: 7,
          time: AT,
        },
      ])
    )
    if (frame.channel !== "running_trade_batch") throw new Error(frame.channel)
    const { trades } = toTrades(frame.trades, AT)
    expect(trades.map((t) => t.board)).toEqual(["NG"])
    expect(lastRgTrade(trades)).toBeNull()
  })
})

describe("shouldWriteQuote", () => {
  test("writes at most once per 30 s, however many frames arrive", () => {
    let writtenAt: number | null = null
    let writes = 0
    for (let now = 0; now <= 60_000; now += 100)
      if (shouldWriteQuote(now, writtenAt)) {
        writtenAt = now
        writes++
      }
    expect(writes).toBe(3)
  })
})

describe("wallCoverageFrom", () => {
  test("reads the sym: tags once each, capped at 50", () => {
    expect(
      wallCoverageFrom(["client", "sym:TLKM", "client", "sym:BBCA", "sym:BBCA"])
    ).toEqual(["BBCA", "TLKM"])
    const many = Array.from(
      { length: 60 },
      (_, i) =>
        `sym:AB${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`
    )
    expect(wallCoverageFrom(many)).toHaveLength(50)
  })

  test("open sockets come first, then the watched symbols", () => {
    expect(
      wallCoverageFrom(
        ["sym:TLKM", "sym:BBRI"],
        [Symbol.make("ASII"), Symbol.make("BBRI"), Symbol.make("UNVR")]
      )
    ).toEqual(["BBRI", "TLKM", "ASII", "UNVR"])
  })

  test("a watched symbol that sorts first cannot push an open one past the cap", () => {
    const open = Array.from({ length: 50 }, (_, i) =>
      Symbol.make(
        `ZZ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`
      )
    )
    const coverage = wallCoverageFrom(
      open.map((symbol) => `sym:${symbol}`),
      [Symbol.make("AAAA")]
    )
    expect(coverage).toEqual(open)
  })

  test("an empty tag is no symbol", () => {
    expect(wallCoverageFrom(["sym:"])).toEqual([])
  })

  test("a tag that is no symbol is dropped", () => {
    expect(wallCoverageFrom(["sym:PYFA-W", "sym:BBCA"])).toEqual(["BBCA"])
  })
})

describe("the captured liveprice frames", () => {
  test("decode with the capture's first BBCA figures", () => {
    const first = capturedFrames().find((f) => f[0] === 0x4a)
    const frame = decodeWrap(first ?? new Uint8Array())
    expect(frame).toEqual({
      channel: "liveprice",
      liveprice: {
        stock: "BBCA",
        date: expect.stringMatching(/^2026-10-29T13:30:01/),
        prev: 5275,
        open: 5275,
        high: 5325,
        low: 5000,
        average: 5115,
        volume: 148_143_100,
        value: 757_806_850_000,
        frequency: 29_235,
        lastprice: 5050,
        verb: "S",
        quantity: 200,
        orderNumber: "202610290002232325",
        matchNumber: "202610290000804264",
      },
    })
  })
})
