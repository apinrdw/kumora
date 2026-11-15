import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { KSEI_TYPES } from "@/domain/holdings"
import { composition, scrip } from "@/lib/stock-composition"
import type { CompositionMonth } from "@/server/holdings/stock-page"

// An unsplit month in which Individual and Corporate hold `held`, each
// through a single classification.
const month = (
  dataDate: string,
  held: { readonly ID: number; readonly CP: number }
): CompositionMonth => ({
  dataDate,
  totalScripless: held.ID + held.CP,
  listedShares: undefined,
  split: false,
  types: KSEI_TYPES.map((type) => {
    const combined = type === "ID" ? held.ID : type === "CP" ? held.CP : 0
    const classification = type === "ID" ? "individual" : "corporate"
    return {
      type,
      combined,
      classifications: combined === 0 ? [] : [{ classification, combined }],
    }
  }),
})

describe("the Shareholders composition rows", () => {
  it.effect("keep a type that sold out since the month before, at 0%", () =>
    Effect.gen(function* () {
      const rows = yield* composition(
        month("2026-10-30", { ID: 100, CP: 0 }),
        month("2026-09-30", { ID: 97, CP: 3 }),
        "all",
        "types"
      )
      expect(
        rows.rows.map(({ key, share, previousShare }) => ({
          key,
          share,
          previousShare,
        }))
      ).toEqual([
        { key: "ID", share: 1, previousShare: 0.97 },
        { key: "CP", share: 0, previousShare: 0.03 },
      ])
    })
  )
})

describe("the scrip share", () => {
  it.effect("is listed less scripless, of listed", () =>
    Effect.gen(function* () {
      expect(
        yield* scrip({
          ...month("2026-10-30", { ID: 60, CP: 20 }),
          listedShares: 100,
        })
      ).toEqual({ _tag: "Share", share: 0.2 })
    })
  )

  it.effect("is unavailable when KSEI has no listed shares", () =>
    Effect.gen(function* () {
      expect(yield* scrip(month("2026-10-30", { ID: 60, CP: 20 }))).toEqual({
        _tag: "NoListedShares",
      })
    })
  )

  it.effect(
    "is unavailable when KSEI lists fewer shares than are scripless",
    () =>
      Effect.gen(function* () {
        expect(
          yield* scrip({
            ...month("2026-10-30", { ID: 60, CP: 20 }),
            listedShares: 70,
          })
        ).toEqual({ _tag: "FewerListed", listedShares: 70 })
      })
  )
})
