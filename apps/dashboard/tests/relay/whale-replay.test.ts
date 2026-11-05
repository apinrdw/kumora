import { expect, test } from "vitest"

import { SYMBOL_PATTERN } from "@/domain/symbol-guard"
import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type { Sweep, Trade, TradeSide, Wall } from "@/domain/trade"
import { closeIdle, createWhales, feedTrades, sketchOf } from "@/relay/whale"
import type { Changes } from "@/relay/whale"
import {
  createWalls,
  expireWalls,
  feedHit,
  feedWallTrades,
  makerHit,
} from "@/relay/whale-walls"

import { readCapture, readWhaleFixture, SIDE } from "../support/whale-capture"
import type { TradeRow } from "../support/whale-capture"

type Expected = {
  cut: string
  fed: { trades: number }
  priors: Record<string, ReadonlyArray<number>>
  sweeps: ReadonlyArray<{
    symbol: string
    firstNumber: number
    side: TradeSide
    lots: number
    freq: number
  }>
  walls: ReadonlyArray<{
    symbol: string
    side: string
    price: number
    hits: number
    lots: number
  }>
}

const toTrade = (row: TradeRow, receivedAt: string): Trade => ({
  symbol: Symbol.make(row[0]),
  price: row[1],
  volume: row[2],
  side: SIDE[row[3]],
  tradedAt: IsoDateTime.make(row[4]),
  tradeNumber: row[5],
  board: row[6],
  value: row[7],
  receivedAt: IsoDateTime.make(receivedAt),
  change: 0,
})

const key = (s: { symbol: string; firstNumber: number; side: string }) =>
  `${s.symbol}:${s.firstNumber}:${s.side}`

const replay = () => {
  const capture = readCapture()
  const expected = readWhaleFixture<Expected>("expected.json")
  const { "*": market = [], ...own } = expected.priors
  const whales = createWhales({
    own: new Map(
      Object.entries(own).map(([symbol, lots]) => [
        Symbol.make(symbol),
        sketchOf(lots),
      ])
    ),
    market: sketchOf(market),
  })
  const walls = createWalls()
  const live = capture.liveprice.filter((row) => row[0] >= expected.cut)
  const covered = new Set(live.map((row) => Symbol.make(row[1])))
  const sweeps = new Map<string, Sweep>()
  const wallRows = new Map<string, Wall>()
  const keep = (changed: Changes) => {
    for (const s of changed.sweeps) sweeps.set(key(s), s)
    for (const w of changed.walls) wallRows.set(w.firstOrderNumber, w)
  }
  // The frames and the batches in the order the capture took them.
  const stream = [
    ...capture.batches.map((batch) => ({ t: batch.t, batch, row: null })),
    ...live.map((row) => ({ t: row[0], batch: null, row })),
  ].sort((a, b) => a.t.localeCompare(b.t))
  let fed = 0
  let seq = 0
  for (const { t, batch, row } of stream) {
    if (t < expected.cut) continue
    const nowMs = Date.parse(t)
    if (batch) {
      const trades = batch.trades
        .filter((r) => SYMBOL_PATTERN.test(r[0]))
        .map((r) => toTrade(r, t))
      fed += trades.length
      seq++
      keep(feedTrades(whales, trades, seq))
      keep(closeIdle(whales, nowMs, seq))
      keep(feedWallTrades(walls, whales, trades, covered, seq))
    }
    if (row) {
      const hit = makerHit(
        Symbol.make(row[1]),
        {
          stock: row[1],
          date: null,
          prev: null,
          open: null,
          high: null,
          low: null,
          average: null,
          volume: null,
          value: null,
          frequency: null,
          lastprice: row[2],
          quantity: row[3],
          verb: row[4],
          orderNumber: row[5],
          matchNumber: row[6],
        },
        IsoDateTime.make(row[0])
      )
      if (hit) keep(feedHit(walls, whales, hit, seq))
    }
    keep(expireWalls(walls, whales, nowMs, seq))
  }
  return { expected, fed, sweeps, walls: [...wallRows.values()] }
}

test("replaying the capture finds the reference list of sweeps", () => {
  const { expected, fed, sweeps } = replay()

  expect(fed).toBe(7169)
  expect(expected.fed.trades).toBe(7169)
  expect(sweeps.size).toBe(167)
  expect([...sweeps.keys()].sort()).toEqual(expected.sweeps.map(key).sort())
  for (const row of expected.sweeps) {
    const sweep = sweeps.get(key(row))
    expect(sweep?.lots).toBeCloseTo(row.lots, 6)
    expect(sweep?.freq).toBe(row.freq)
  }
})

test("ENRG's order is one sweep buy of 48,766 lots and 198 freq at 665", () => {
  const { sweeps } = replay()

  const enrg = [...sweeps.values()].filter(
    (s) => s.symbol === "ENRG" && s.lots > 40_000
  )
  expect(enrg).toHaveLength(1)
  expect(enrg[0]).toMatchObject({
    side: "buy",
    board: "RG",
    lots: 48_766,
    freq: 198,
    priceLow: 665,
    priceHigh: 665,
    prior: "market",
  })
})

test("BBCA has an offer wall at 5.050 and a bid wall at 5.025, and nothing else does", () => {
  const { expected, walls } = replay()
  const found = walls
    .map((w) => ({
      symbol: w.symbol,
      side: w.side,
      price: w.price,
      hits: w.hitsSeen,
      lots: w.lotsMatched,
    }))
    .sort((a, b) => a.side.localeCompare(b.side))

  expect(found).toEqual(expected.walls)
  expect(found).toEqual([
    { symbol: "BBCA", side: "bid", price: 5025, hits: 7, lots: 1207 },
    { symbol: "BBCA", side: "offer", price: 5050, hits: 95, lots: 1429 },
  ])
})
