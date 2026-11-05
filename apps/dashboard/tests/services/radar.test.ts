import { expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { RadarSnapshot } from "@/features/radar/schema"
import { AppLayer } from "@/lib/runtime"
import { Radar } from "@/services/radar"

layer(AppLayer)("Radar", (it) => {
  it.effect("serves a snapshot that decodes against RadarSnapshot", () =>
    Effect.gen(function* () {
      const snapshot = yield* (yield* Radar).candidates
      const decoded = yield* Schema.decodeEffect(RadarSnapshot)(snapshot)
      expect(decoded.candidates.map((c) => c.symbol)).toEqual([
        "BBCA",
        "ANTM",
        "TLKM",
        "ASII",
        "BMRI",
        "MDKA",
      ])
    })
  )

  it.effect("carries the provenance of the demo feeds", () =>
    Effect.gen(function* () {
      const snapshot = yield* (yield* Radar).candidates
      expect(snapshot).toMatchObject({
        asOf: "2026-10-23T07:45:00Z",
        brokerAsOf: "2026-10-22T09:00:00Z",
        computedAt: "2026-10-23T07:46:00Z",
        modelVersion: "sm-flow 0.9.2",
      })
    })
  )
})
