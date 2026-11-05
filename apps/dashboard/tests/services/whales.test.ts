import { expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import { WhalesToday } from "@/domain/trade"
import type { SweepCursor } from "@/domain/trade"
import { RELAY_NAME } from "@/relay/routes"
import type { TradeRelay } from "@/relay/trade-relay"
import { Whales } from "@/services/whales"
import { enrgSweep } from "../support/whales"

const CURSOR: SweepCursor = {
  day: "2026-10-29",
  announcedAt: IsoDateTime.make("2026-10-29T06:42:35.100Z"),
  symbol: Symbol.make("ENRG"),
  firstNumber: 853_413,
}

layer(Whales.layer)("Whales, demo layer", (it) => {
  it.effect("serves an empty day that decodes, demo on both feeds", () =>
    Effect.gen(function* () {
      const today = yield* (yield* Whales).today
      const decoded = yield* Schema.decodeEffect(WhalesToday)(today)

      expect(decoded).toMatchObject({
        day: null,
        sweeps: [],
        sweepsTotal: 0,
        leaderboard: [],
        walls: [],
        wallCoverage: [],
        thresholds: { symbols: 0, warmingUp: 0 },
      })
      expect(decoded.provenance).toMatchObject({
        feed: "stockbit-running-trades",
        freshness: "demo",
      })
      expect(decoded.liveprice).toMatchObject({
        feed: "stockbit-liveprice",
        freshness: "demo",
      })
    })
  )

  it.effect("has nothing earlier", () =>
    Effect.gen(function* () {
      expect(yield* (yield* Whales).earlier(CURSOR)).toEqual([])
    })
  )
})

const asked: Array<unknown> = []
const today: WhalesToday = {
  seq: 9,
  day: "2026-10-29",
  sweeps: [enrgSweep],
  sweepsTotal: 1,
  leaderboard: [
    { symbol: enrgSweep.symbol, buyValue: enrgSweep.value, sellValue: 0 },
  ],
  walls: [],
  wallCoverage: [],
  thresholds: { symbols: 1, warmingUp: 1 },
  provenance: {
    feed: "stockbit-running-trades",
    source: "extension",
    asOf: enrgSweep.updatedAt,
    freshness: "live",
  },
  liveprice: {
    feed: "stockbit-liveprice",
    source: "extension",
    asOf: null,
    freshness: "stale",
  },
}
const binding = {
  getByName: (name: string) => {
    asked.push(name)
    return {
      today: () => Promise.resolve(today),
      earlier: (cursor: SweepCursor) => {
        asked.push(cursor)
        return Promise.resolve([enrgSweep])
      },
    }
  },
} as unknown as DurableObjectNamespace<TradeRelay>

layer(Whales.live(binding))("Whales, live layer", (it) => {
  it.effect("asks the one relay by name, and passes the cursor", () =>
    Effect.gen(function* () {
      const whales = yield* Whales

      expect(yield* whales.today).toEqual(today)
      expect(yield* whales.earlier(CURSOR)).toEqual([enrgSweep])
      expect(asked).toEqual([RELAY_NAME, RELAY_NAME, CURSOR])
    })
  )
})
