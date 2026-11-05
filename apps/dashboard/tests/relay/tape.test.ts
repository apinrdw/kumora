import { Symbol } from "@/domain/symbol"
import { describe, expect, test } from "vitest"

import type { Trade } from "@/domain/trade"
import { decodeWrap } from "@/relay/stockbit"
import type { RawTrade } from "@/relay/stockbit"
import { dedupe, keepCurrentDay, toTrades } from "@/relay/tape"
import { tradingDay } from "@/relay/trading-day"

import { capturedFrames } from "../support/stockbit-wire"

const RECEIVED = "2026-10-29T03:00:01.000Z"

const raw = (over: Partial<RawTrade> = {}): RawTrade => ({
  stock: "BBCA",
  price: 9000,
  volume: 100,
  action: 1,
  time: "2026-10-29T03:00:00.000Z",
  change: 25,
  tradeNumber: 1,
  board: 1,
  value: 900_000,
  ...over,
})

const trades = (...overs: Array<Partial<RawTrade>>): ReadonlyArray<Trade> =>
  toTrades(overs.map(raw), RECEIVED).trades

describe("tradingDay", () => {
  test("is the WIB date, seven hours ahead of UTC", () => {
    expect(tradingDay("2026-10-29T16:59:59Z")).toBe("2026-10-29")
    expect(tradingDay("2026-10-29T17:00:00Z")).toBe("2026-10-30")
  })
})

describe("toTrades", () => {
  test("maps the wire's side and board", () => {
    const decoded = trades(
      { action: 1, board: 1 },
      { action: 2, board: 3 },
      { action: 0, board: 2 }
    )
    expect(decoded.map((t) => [t.side, t.board])).toEqual([
      ["buy", "RG"],
      ["sell", "NG"],
      ["unspecified", "TN"],
    ])
    expect(decoded[0]?.receivedAt).toBe(RECEIVED)
  })

  test("a PYFA-W code keeps the batch's other trades and counts as dropped", () => {
    const result = toTrades(
      [
        raw({ stock: "BBCA", tradeNumber: 1 }),
        raw({ stock: "PYFA-W", tradeNumber: 2 }),
        raw({ stock: "BBRI", tradeNumber: 3 }),
      ],
      RECEIVED
    )
    expect(result.trades.map((t) => t.symbol)).toEqual(["BBCA", "BBRI"])
    expect(result.failed).toBe(0)
  })

  test("a trade that fails Schema is skipped and counted", () => {
    const result = toTrades(
      [raw({ tradeNumber: 1 }), raw({ tradeNumber: 2, time: "" })],
      RECEIVED
    )
    expect(result.trades.map((t) => t.tradeNumber)).toEqual([1])
    expect(result.failed).toBe(1)
  })

  test("decodes every capture batch with no failure", () => {
    let kept = 0
    for (const bytes of capturedFrames()) {
      const frame = decodeWrap(bytes)
      if (frame.channel !== "running_trade_batch") continue
      const result = toTrades(frame.trades, RECEIVED)
      expect(result.failed).toBe(0)
      kept += result.trades.length
    }
    expect(kept).toBeGreaterThan(1000)
  })
})

describe("keepCurrentDay", () => {
  const YESTERDAY = "2026-10-28T03:00:00.000Z"
  const TODAY = "2026-10-29T03:00:00.000Z"
  const TOMORROW = "2026-10-30T03:00:00.000Z"

  test("the first batch sets the day, and clears what predates it", () => {
    const batch = trades({ time: TODAY, tradeNumber: 1 })
    expect(keepCurrentDay(null, batch)).toEqual({
      day: "2026-10-29",
      cleared: true,
      trades: batch,
    })
  })

  test("drops a resend's trades from the previous day", () => {
    const batch = trades(
      { time: YESTERDAY, tradeNumber: 900 },
      { time: TODAY, tradeNumber: 1 }
    )
    const kept = keepCurrentDay("2026-10-29", batch)
    expect(kept.cleared).toBe(false)
    expect(kept.trades.map((t) => t.tradeNumber)).toEqual([1])
  })

  test("a batch spanning two days works out the day per trade, not from its first", () => {
    const batch = trades(
      { time: TODAY, tradeNumber: 900 },
      { time: TOMORROW, tradeNumber: 1 }
    )
    expect(keepCurrentDay("2026-10-29", batch)).toMatchObject({
      day: "2026-10-30",
      cleared: true,
      trades: [{ tradeNumber: 1 }],
    })
  })

  test("a first batch spanning two days keeps the newer", () => {
    const batch = trades(
      { time: YESTERDAY, tradeNumber: 900 },
      { time: TODAY, tradeNumber: 1 }
    )
    expect(keepCurrentDay(null, batch)).toMatchObject({
      day: "2026-10-29",
      cleared: true,
      trades: [{ tradeNumber: 1 }],
    })
  })

  test("a batch only of the previous day leaves the day and keeps nothing", () => {
    const batch = trades({ time: YESTERDAY, tradeNumber: 900 })
    expect(keepCurrentDay("2026-10-29", batch)).toEqual({
      day: "2026-10-29",
      cleared: false,
      trades: [],
    })
  })

  test("an empty batch changes nothing", () => {
    expect(keepCurrentDay(null, [])).toEqual({
      day: null,
      cleared: false,
      trades: [],
    })
  })
})

describe("dedupe", () => {
  test("drops every trade at or below the last number for its symbol", () => {
    const last = new Map([[Symbol.make("BBCA"), 5]])
    const fresh = dedupe(
      last,
      trades(
        { stock: "BBCA", tradeNumber: 4 },
        { stock: "BBCA", tradeNumber: 5 },
        { stock: "BBCA", tradeNumber: 6 },
        { stock: "BBRI", tradeNumber: 1 }
      )
    )
    expect(fresh.map((t) => [t.symbol, t.tradeNumber])).toEqual([
      ["BBCA", 6],
      ["BBRI", 1],
    ])
    expect(last.get(Symbol.make("BBCA"))).toBe(6)
    expect(last.get(Symbol.make("BBRI"))).toBe(1)
  })

  test("a full resend of the capture adds 0 trades", () => {
    const last = new Map<Symbol, number>()
    const replay = () => {
      let added = 0
      for (const bytes of capturedFrames()) {
        const frame = decodeWrap(bytes)
        if (frame.channel !== "running_trade_batch") continue
        added += dedupe(last, toTrades(frame.trades, RECEIVED).trades).length
      }
      return added
    }
    expect(replay()).toBeGreaterThan(1000)
    expect(replay()).toBe(0)
  })
})
