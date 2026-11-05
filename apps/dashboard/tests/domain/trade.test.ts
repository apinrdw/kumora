import { Schema } from "effect"
import { describe, expect, test } from "vitest"

import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import { TradeFrame } from "@/domain/trade"
import { enrgSweep, noWhales } from "../support/whales"

const json = Schema.fromJsonString(TradeFrame)
const encode = Schema.encodeUnknownSync(json)
const decode = Schema.decodeUnknownSync(json)

const provenance = {
  feed: "stockbit-running-trades",
  source: "extension",
  asOf: "2026-10-23T08:42:00Z",
  freshness: "live",
}

const FRAMES = {
  trades: {
    type: "trades",
    seq: 12,
    provenance,
    trades: [
      {
        symbol: "BBCA",
        price: 9875,
        volume: 500,
        value: 4_937_500,
        side: "buy",
        board: "RG",
        tradeNumber: 40213,
        tradedAt: "2026-10-23T08:41:59Z",
        receivedAt: "2026-10-23T08:42:00Z",
        change: -25,
      },
    ],
  },
  "quote with a missing figure": {
    type: "quote",
    symbol: "BBCA",
    quote: {
      last: 9875,
      prev: 9900,
      open: null,
      high: null,
      low: null,
      avg: null,
      volumeLot: null,
      value: null,
      freq: null,
    },
    provenance: { ...provenance, feed: "stockbit-liveprice" },
  },
  status: {
    type: "status",
    status: {
      source: "none",
      freshness: "stale",
      reason: "no-source",
      upstreamEnabled: false,
      upstreamState: "disabled",
      credentialExpiresAt: null,
      ingests: 0,
      datafeed: false,
      clients: 2,
      lastTradeAt: null,
      seq: 0,
      day: null,
      symbols: 0,
      trades: 0,
      calendarOutOfDate: true,
      sweeps: 1,
      walls: 0,
      wallCoverage: [{ symbol: Symbol.make("BBCA"), receiving: true }],
      thresholds: { symbols: 3, warmingUp: 1 },
      coverage: [
        { at: IsoDateTime.make("2026-10-29T02:00:00.000Z"), source: "none" },
      ],
    },
  },
  sweep: {
    type: "sweep",
    seq: 7,
    provenance: {
      feed: "stockbit-running-trades",
      source: "extension",
      asOf: enrgSweep.updatedAt,
      freshness: "live",
    },
    sweep: enrgSweep,
    threshold: noWhales.threshold,
  },
  wall: {
    type: "wall",
    seq: 7,
    provenance: noWhales.liveprice,
    wall: {
      day: "2026-10-29",
      symbol: Symbol.make("BBCA"),
      side: "offer",
      price: 5050,
      firstOrderNumber: "202610290002329192",
      memberOrderNumbers: ["202610290002329192"],
      hitsSeen: 95,
      lotsMatched: 1429,
      threshold: 696,
      warmingUp: true,
      prior: "own",
      firstSeen: enrgSweep.tradedAt,
      lastSeen: enrgSweep.updatedAt,
      closedAt: null,
      closedBy: null,
      seq: 7,
    },
    threshold: noWhales.threshold,
  },
  threshold: { type: "threshold", seq: 7, threshold: noWhales.threshold },
}

describe("TradeFrame", () => {
  test.each(Object.entries(FRAMES))("%s round-trips as JSON", (_, frame) => {
    const text = encode(frame)
    expect(typeof text).toBe("string")
    expect(decode(text)).toEqual(frame)
    expect(JSON.parse(text)).toEqual(frame)
  })

  test("rejects an unknown stale reason", () => {
    const status = { ...FRAMES.status.status, reason: "holiday" }
    expect(() => decode(JSON.stringify({ type: "status", status }))).toThrow(
      /reason/
    )
  })

  test("rejects a trade with a warrant's code", () => {
    const [trade] = FRAMES.trades.trades
    const frame = {
      ...FRAMES.trades,
      trades: [{ ...trade, symbol: "PYFA-W" }],
    }
    expect(() => decode(JSON.stringify(frame))).toThrow(/symbol/)
  })
})
