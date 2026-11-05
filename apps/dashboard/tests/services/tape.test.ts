import { expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { Symbol } from "@/domain/symbol"
import { RelayStatus, TapeBackfill } from "@/domain/trade"
import type { TradeRelay } from "@/relay/trade-relay"
import { Tape } from "@/services/tape"
import { noWhales } from "../support/whales"

layer(Tape.layer)("Tape, demo layer", (it) => {
  it.effect("serves no sweeps, a null threshold and demo on both feeds", () =>
    Effect.gen(function* () {
      const tape = yield* Tape
      const backfill = yield* tape.backfill(Symbol.make("BBCA"))
      const unknown = yield* tape.backfill(Symbol.make("ZZZZ"))

      for (const b of [backfill, unknown]) {
        expect(b.sweeps).toEqual([])
        expect(b.walls).toEqual([])
        expect(b.threshold.threshold).toBeNull()
        expect(b.provenance.freshness).toBe("demo")
        expect(b.liveprice.freshness).toBe("demo")
        expect(b.liveprice.feed).toBe("stockbit-liveprice")
      }
    })
  )

  it.effect("serves a fixture symbol's trades newest first under demo", () =>
    Effect.gen(function* () {
      const backfill = yield* (yield* Tape).backfill(Symbol.make("BBCA"))
      const decoded = yield* Schema.decodeEffect(TapeBackfill)(backfill)

      expect(decoded.symbol).toBe("BBCA")
      expect(decoded.day).toBe("2026-10-23")
      expect(decoded.provenance).toEqual({
        feed: "stockbit-running-trades",
        source: "none",
        asOf: "2026-10-23T08:42:00Z",
        freshness: "demo",
      })
      expect(decoded.quoteAsOf).toBe("2026-10-23T08:42:00Z")
      expect(decoded.trades.length).toBeGreaterThan(0)
      expect(decoded.trades.every((t) => t.symbol === "BBCA")).toBe(true)

      const numbers = decoded.trades.map((t) => t.tradeNumber)
      expect(numbers).toEqual([...numbers].sort((a, b) => b - a))
    })
  )

  it.effect("keeps every symbol's newest trade on its quote's last price", () =>
    Effect.gen(function* () {
      const tape = yield* Tape
      for (const symbol of ["BBRI", "BBCA", "TLKM", "GOTO"]) {
        const { trades, quote } = yield* tape.backfill(Symbol.make(symbol))
        expect(trades[0].price).toBe(quote.last)
        for (const trade of trades) {
          expect(trade.price).toBeGreaterThanOrEqual(quote.low ?? 0)
          expect(trade.price).toBeLessThanOrEqual(quote.high ?? Infinity)
        }
      }
    })
  )

  it.effect("serves a symbol outside the fixtures an empty demo tape", () =>
    Effect.gen(function* () {
      const backfill = yield* (yield* Tape).backfill(Symbol.make("ZZZZ"))
      expect(backfill).toMatchObject({
        symbol: "ZZZZ",
        trades: [],
        quote: { last: null, prev: null },
        quoteAsOf: null,
        provenance: { source: "none", asOf: null, freshness: "demo" },
      })
    })
  )

  it.effect(
    "reports a status with no source and the session switched off",
    () =>
      Effect.gen(function* () {
        const status = yield* Schema.decodeEffect(RelayStatus)(
          yield* (yield* Tape).status
        )
        expect(status).toMatchObject({
          source: "none",
          freshness: "demo",
          reason: null,
          upstreamEnabled: false,
          upstreamState: "disabled",
        })
      })
  )
})

const backfill: TapeBackfill = {
  symbol: Symbol.make("BBCA"),
  seq: 7,
  day: null,
  trades: [],
  offBoard: [],
  quote: {
    last: null,
    prev: null,
    open: null,
    high: null,
    low: null,
    avg: null,
    volumeLot: null,
    value: null,
    freq: null,
  },
  quoteAsOf: null,
  coverage: [],
  ...noWhales,
  provenance: {
    feed: "stockbit-running-trades",
    source: "extension",
    asOf: null,
    freshness: "stale",
  },
}

const names: Array<string> = []
const asked: Array<Symbol> = []
const binding = {
  getByName: (name: string) => {
    names.push(name)
    return {
      backfill: async (symbol: Symbol) => {
        asked.push(symbol)
        return backfill
      },
      status: async () => ({ source: "extension", seq: 7 }),
    }
  },
} as unknown as DurableObjectNamespace<TradeRelay>

layer(Tape.live(binding))("Tape, live layer", (it) => {
  it.effect("asks the object named idx for the symbol's backfill", () =>
    Effect.gen(function* () {
      const served = yield* (yield* Tape).backfill(Symbol.make("BBCA"))
      expect(served).toEqual(backfill)
      expect(asked).toEqual(["BBCA"])
      expect(names).toEqual(["idx"])
    })
  )

  it.effect("reads the relay's status", () =>
    Effect.gen(function* () {
      expect(yield* (yield* Tape).status).toEqual({
        source: "extension",
        seq: 7,
      })
    })
  )
})
