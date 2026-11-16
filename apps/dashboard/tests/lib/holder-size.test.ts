import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { KSEI_TYPES, type KseiType } from "@/domain/holdings"
import { type Holding, holderSize } from "@/lib/holder-size"
import type { Bands, TypeBands } from "@/server/holdings/stock-page"

const bands = (held: Partial<Record<KseiType, Bands>>): TypeBands =>
  Object.fromEntries(
    KSEI_TYPES.map((type) => [type, held[type] ?? { under5: 0, atLeast5: 0 }])
  ) as TypeBands

// 1,000 shares outstanding, 800 of them scripless: CP's 400 with a ≥5%
// holder, ID's 300 and CP's 100 with <5% holders, all local but ID's 100
// foreign.
const OCTOBER: Holding = {
  sharesOutstanding: 1000,
  totalScripless: 800,
  combined: bands({
    CP: { under5: 100, atLeast5: 400 },
    ID: { under5: 300, atLeast5: 0 },
  }),
  local: bands({
    CP: { under5: 100, atLeast5: 400 },
    ID: { under5: 200, atLeast5: 0 },
  }),
  foreign: bands({ ID: { under5: 100, atLeast5: 0 } }),
}

// The month before: 900 scripless, CP's ≥5% holder 450 of it.
const SEPTEMBER: Holding = {
  sharesOutstanding: 1000,
  totalScripless: 900,
  combined: bands({
    CP: { under5: 100, atLeast5: 450 },
    ID: { under5: 350, atLeast5: 0 },
  }),
  local: bands({
    CP: { under5: 100, atLeast5: 450 },
    ID: { under5: 350, atLeast5: 0 },
  }),
  foreign: bands({}),
}

// An unsplit month before.
const UNSPLIT: Holding = { ...SEPTEMBER, local: undefined, foreign: undefined }

const close = (actual: number | undefined, expected: number) =>
  expect(actual).toBeCloseTo(expected, 10)

describe("the Holder size bar", () => {
  it.effect("splits shares outstanding into scrip, ≥5% and <5%", () =>
    Effect.gen(function* () {
      const shown = yield* holderSize(OCTOBER, undefined, "all", "outstanding")
      expect(shown.base).toBe(1000)
      expect(shown.bar).toEqual({ scrip: 0.2, atLeast5: 0.4, under5: 0.4 })
      expect(shown.changes).toBeUndefined()
    })
  )

  it.effect("leaves scrip out of scripless shares", () =>
    Effect.gen(function* () {
      const shown = yield* holderSize(OCTOBER, undefined, "all", "scripless")
      expect(shown.base).toBe(800)
      expect(shown.bar).toEqual({
        scrip: undefined,
        atLeast5: 0.5,
        under5: 0.5,
      })
    })
  )

  it.effect("measures local against local scripless, whatever was asked", () =>
    Effect.gen(function* () {
      const shown = yield* holderSize(
        OCTOBER,
        undefined,
        "local",
        "outstanding"
      )
      expect(shown.base).toBe(700)
      expect(shown.denominator).toBe("scripless")
      close(shown.bar.atLeast5, 400 / 700)
      expect(shown.bar.scrip).toBeUndefined()
    })
  )

  it.effect("changes each part against the month before", () =>
    Effect.gen(function* () {
      const shown = yield* holderSize(OCTOBER, SEPTEMBER, "all", "outstanding")
      close(shown.changes?.scrip, 0.2 - 0.1)
      close(shown.changes?.atLeast5, 0.4 - 0.45)
      close(shown.changes?.under5, 0.4 - 0.45)
    })
  )

  it.effect("has no change for local against an unsplit month", () =>
    Effect.gen(function* () {
      expect(
        (yield* holderSize(OCTOBER, UNSPLIT, "local", "scripless")).changes
      ).toBeUndefined()
      expect(
        (yield* holderSize(OCTOBER, UNSPLIT, "all", "scripless")).changes
      ).toBeDefined()
    })
  )
})

describe("the Holder size types", () => {
  it.effect("lists all 9 types, most ≥5% first, with their changes", () =>
    Effect.gen(function* () {
      const { rows } = yield* holderSize(OCTOBER, SEPTEMBER, "all", "scripless")
      expect(rows.map(({ type }) => type).slice(0, 2)).toEqual(["CP", "ID"])
      expect(rows).toHaveLength(9)
      const [cp, id] = rows
      close(cp?.atLeast5, 0.5)
      close(cp?.atLeast5Change, 0.5 - 0.5)
      close(cp?.under5, 0.125)
      close(cp?.under5Change, 0.125 - 100 / 900)
      // CP's ≥5% holder holds 4 of its 5 shares.
      close(cp?.inAtLeast5, 0.8)
      close(id?.inAtLeast5, 0)
      // A type holding nothing has no share in ≥5%.
      expect(rows.at(-1)?.inAtLeast5).toBeUndefined()
    })
  )

  it.effect("has no changes without a month before", () =>
    Effect.gen(function* () {
      const { rows } = yield* holderSize(OCTOBER, undefined, "all", "scripless")
      expect(rows[0]?.atLeast5Change).toBeUndefined()
      expect(rows[0]?.under5Change).toBeUndefined()
    })
  )
})
