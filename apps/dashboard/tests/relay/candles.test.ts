import { describe, expect, test } from "vitest"

import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type { Trade } from "@/domain/trade"
import { NO_CANDLES, candlesOfPeriod, foldCandles } from "@/relay/candles"

import { SIDE, readCapture } from "../support/whale-capture"
import type { TradeRow } from "../support/whale-capture"

const trade = (
  tradeNumber: number,
  tradedAt: string,
  price: number,
  over: Partial<Trade> = {}
): Trade => ({
  symbol: Symbol.make("BBCA"),
  price,
  volume: 100,
  value: price * 100,
  side: "buy",
  board: "RG",
  tradeNumber,
  tradedAt: IsoDateTime.make(tradedAt),
  receivedAt: IsoDateTime.make(tradedAt),
  change: 0,
  ...over,
})

/** A symbol's capture trades, once each, in trade-number order. */
const captureTrades = (symbol: string) => {
  const seen = new Set<number>()
  return readCapture()
    .batches.flatMap((b) => b.trades)
    .filter((r) => r[0] === symbol)
    .flatMap((r) => {
      if (seen.has(r[5])) return []
      seen.add(r[5])
      return [
        trade(r[5], r[4], r[1], {
          volume: r[2],
          side: SIDE[r[3]],
          board: r[6],
        }),
      ]
    })
    .sort((a, b) => a.tradeNumber - b.tradeNumber)
}

describe("foldCandles", () => {
  test("the profile holds each price's lots, split by the taker's side", () => {
    const { profile } = foldCandles(NO_CANDLES, [
      [
        trade(1, "2026-10-29T03:00:01.000Z", 100),
        trade(2, "2026-10-29T03:00:30.000Z", 105, { side: "sell" }),
        trade(3, "2026-10-29T03:01:00.000Z", 100, {
          side: "unspecified",
          volume: 300,
        }),
        trade(4, "2026-10-29T03:02:00.000Z", 100, { volume: 200 }),
      ],
    ])
    expect(profile).toEqual([
      { price: 100, buy: 3, sell: 0, unspecified: 3 },
      { price: 105, buy: 0, sell: 1, unspecified: 0 },
    ])
  })

  test("open, high, low, close, and lots of each minute", () => {
    const { candles, lastNumber } = foldCandles(NO_CANDLES, [
      [
        trade(1, "2026-10-29T03:00:01.000Z", 100),
        trade(2, "2026-10-29T03:00:30.000Z", 120),
      ],
      [
        trade(3, "2026-10-29T03:00:59.000Z", 90),
        trade(4, "2026-10-29T03:01:00.000Z", 95, { volume: 500 }),
      ],
    ])
    expect(lastNumber).toBe(4)
    expect(candles).toEqual([
      {
        at: "2026-10-29T03:00:00.000Z",
        open: 100,
        high: 120,
        low: 90,
        close: 90,
        lots: 3,
      },
      {
        at: "2026-10-29T03:01:00.000Z",
        open: 95,
        high: 95,
        low: 95,
        close: 95,
        lots: 5,
      },
    ])
  })

  test.each(["NG", "TN"])("a %s trade moves no candle", (board) => {
    const rg = foldCandles(NO_CANDLES, [
      [trade(1, "2026-10-29T03:00:00.000Z", 100)],
    ])
    const after = foldCandles(rg, [
      [
        trade(2, "2026-10-29T03:00:10.000Z", 999, {
          board,
          side: "unspecified",
        }),
      ],
    ])
    expect(after.candles).toEqual(rg.candles)
    expect(after.profile).toEqual(rg.profile)
    expect(after.lastNumber).toBe(2)
  })

  test("a resend changes nothing", () => {
    const batch = [
      trade(1, "2026-10-29T03:00:00.000Z", 100),
      trade(2, "2026-10-29T03:00:10.000Z", 110),
    ]
    const once = foldCandles(NO_CANDLES, [batch])
    expect(foldCandles(once, [batch])).toEqual(once)
  })

  test("carrying on from live batches gives the whole fold's answer", () => {
    const batches = [
      [trade(1, "2026-10-29T03:00:00.000Z", 100)],
      [trade(2, "2026-10-29T03:00:40.000Z", 80)],
      [trade(3, "2026-10-29T03:02:00.000Z", 90)],
    ]
    const live = batches.reduce((held, b) => foldCandles(held, [b]), NO_CANDLES)
    expect(live).toEqual(foldCandles(NO_CANDLES, batches))
  })

  test("the capture's profile splits exactly its RG lots", () => {
    const trades = captureTrades("BBCA")
    const { profile } = foldCandles(NO_CANDLES, [trades])
    const rg = trades.filter((t) => t.board === "RG")
    const sides = profile.reduce(
      (sum, l) => sum + l.buy + l.sell + l.unspecified,
      0
    )
    expect(sides).toBeCloseTo(rg.reduce((sum, t) => sum + t.volume / 100, 0))
    for (const { price, buy, sell, unspecified } of profile) {
      const at = rg.filter((t) => t.price === price)
      const lotsOf = (side: Trade["side"]) =>
        at
          .filter((t) => t.side === side)
          .reduce((sum, t) => sum + t.volume / 100, 0)
      expect({ buy, sell, unspecified }).toEqual({
        buy: lotsOf("buy"),
        sell: lotsOf("sell"),
        unspecified: lotsOf("unspecified"),
      })
    }
    expect(profile.map((l) => l.price)).toEqual(
      [...new Set(rg.map((t) => t.price))].sort((a, b) => a - b)
    )
  })

  test("the capture's negotiated-board trades change no figure", () => {
    const trades = captureTrades("MKNT")
    const rg = trades.filter((t) => t.board === "RG")
    expect(trades.length - rg.length).toBe(2)
    const { candles, profile } = foldCandles(NO_CANDLES, [trades])
    expect({ candles, profile }).toEqual({
      candles: foldCandles(NO_CANDLES, [rg]).candles,
      profile: foldCandles(NO_CANDLES, [rg]).profile,
    })
  })

  test("a page opened mid-capture holds what a page open since the start does", () => {
    const { batches } = readCapture()
    const asTrades = (rows: ReadonlyArray<TradeRow>) =>
      rows
        .filter((r) => r[0] === "BBCA")
        .map((r) =>
          trade(r[5], r[4], r[1], {
            volume: r[2],
            side: SIDE[r[3]],
            board: r[6],
          })
        )
    const all = batches.map((b) => asTrades(b.trades))
    const half = Math.floor(all.length / 2)
    const sinceStart = all.reduce(
      (held, b) => foldCandles(held, [b]),
      NO_CANDLES
    )
    const reloaded = all
      .slice(half)
      .reduce(
        (held, b) => foldCandles(held, [b]),
        foldCandles(NO_CANDLES, all.slice(0, half))
      )
    expect(reloaded).toEqual(sinceStart)
    expect(sinceStart.profile.length).toBeGreaterThan(1)
  })

  test("the capture's RG trades match an independent aggregation", () => {
    const trades = captureTrades("BBCA")
    const { candles } = foldCandles(NO_CANDLES, [trades])
    const rg = trades.filter((t) => t.board === "RG")
    expect(candles.reduce((sum, c) => sum + c.lots, 0)).toBeCloseTo(
      rg.reduce((sum, t) => sum + t.volume / 100, 0)
    )
    for (const c of candles) {
      const inMinute = rg
        .filter((t) => t.tradedAt.slice(0, 16) === c.at.slice(0, 16))
        .map((t) => t.price)
      expect(c.high).toBe(Math.max(...inMinute))
      expect(c.low).toBe(Math.min(...inMinute))
      expect(c.open).toBe(inMinute[0])
      expect(c.close).toBe(inMinute.at(-1))
    }
    expect(candles.length).toBeGreaterThan(0)
  })

  test("a busy symbol's whole day stays one candle per minute", () => {
    const start = Date.parse("2026-10-29T02:00:00.000Z")
    const SESSION_MINUTES = 330
    const TRADES = 200_000
    function* day() {
      for (let i = 1; i <= TRADES; i++)
        yield [
          trade(
            i,
            new Date(
              start + Math.floor((i / TRADES) * (SESSION_MINUTES * 60_000 - 1))
            ).toISOString(),
            5000 + (i % 7)
          ),
        ]
    }
    const { candles, lastNumber } = foldCandles(NO_CANDLES, day())
    expect(lastNumber).toBe(TRADES)
    expect(candles.length).toBeLessThanOrEqual(SESSION_MINUTES)
  })
})

test("a longer period merges its minutes, on WIB's clock", () => {
  const { candles } = foldCandles(NO_CANDLES, [
    [
      trade(1, "2026-10-29T03:00:00.000Z", 100),
      trade(2, "2026-10-29T03:04:00.000Z", 130),
      trade(3, "2026-10-29T03:05:00.000Z", 90),
    ],
  ])
  expect(candlesOfPeriod(candles, 5 * 60_000)).toEqual([
    {
      at: "2026-10-29T03:00:00.000Z",
      open: 100,
      high: 130,
      low: 100,
      close: 130,
      lots: 2,
    },
    {
      at: "2026-10-29T03:05:00.000Z",
      open: 90,
      high: 90,
      low: 90,
      close: 90,
      lots: 1,
    },
  ])
})
