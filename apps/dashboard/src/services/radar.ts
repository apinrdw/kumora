import { Context, Effect, Layer } from "effect"

import { RADAR_SNAPSHOT } from "@/features/radar/data"
import type { RadarSnapshot } from "@/features/radar/schema"
import { Whales } from "@/services/whales"

/** The radar page's read model. The candidates are the fixture snapshot; today's sweeps come from `Whales`. */
export class Radar extends Context.Service<
  Radar,
  { readonly candidates: Effect.Effect<RadarSnapshot> }
>()("dashboard/Radar") {
  static readonly layer = Layer.effect(
    Radar,
    Effect.gen(function* () {
      const whales = yield* Whales
      return Radar.of({
        candidates: Effect.gen(function* () {
          return { ...RADAR_SNAPSHOT, whales: yield* whales.today }
        }).pipe(Effect.withSpan("Radar.candidates")),
      })
    })
  )
}
