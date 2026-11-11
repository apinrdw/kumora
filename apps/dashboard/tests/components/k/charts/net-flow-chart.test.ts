import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { compactIdr } from "@/lib/format"
import { flowReadoutRow } from "@/components/k/charts/net-flow-chart"

describe("flowReadoutRow", () => {
  it.effect("a positive net reads as a net buy in the up color", () =>
    Effect.gen(function* () {
      expect(
        yield* flowReadoutRow({ label: "BBCA", net: 86.2e9 }, compactIdr)
      ).toEqual({
        label: "Net beli",
        value: "+Rp86.2 B",
        swatch: "var(--semantic-up)",
      })
    })
  )

  it.effect("a negative net reads as a net sell in the down color", () =>
    Effect.gen(function* () {
      expect(
        yield* flowReadoutRow({ label: "YP", net: -4e6 }, compactIdr)
      ).toEqual({
        label: "Net jual",
        value: "−Rp4 M",
        swatch: "var(--semantic-down)",
      })
    })
  )

  it.effect("a flat session counts as a net buy", () =>
    Effect.gen(function* () {
      expect(
        (yield* flowReadoutRow({ label: "14 Okt", net: 0 }, (n) =>
          Effect.succeed(String(n))
        )).label
      ).toBe("Net beli")
    })
  )
})
