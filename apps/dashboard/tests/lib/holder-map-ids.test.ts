import { describe, expect, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect } from "effect"
import { expectTypeOf } from "vitest"

import { HolderKey } from "@/domain/holdings"
import { placeOf } from "@/lib/holder-map-ids"

describe("placeOf", () => {
  it.effect("places a holding by its stock code and holder key", () =>
    Effect.gen(function* () {
      // A glossary term is its type, not a bare string (GLOSSARY.md).
      expectTypeOf(placeOf).parameters.toEqualTypeOf<[StockCode, HolderKey]>()
      expect(
        yield* placeOf(StockCode.make("TRUE"), HolderKey.make("DJONI"))
      ).toBe("TRUE DJONI")
    })
  )
})
