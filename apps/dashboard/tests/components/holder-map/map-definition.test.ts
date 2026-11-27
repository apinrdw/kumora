import { describe, expect, it } from "@effect/vitest"
import { WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { tooltipText } from "@/components/holder-map/map-definition"
import type { MapNode } from "@/lib/holder-map"

const holder = (move: MapNode["move"]): MapNode => ({
  id: "holder:PERINTIS",
  kind: "holder",
  name: "PT PERINTIS TRINITI PROPERTI TBK",
  label: "PT PERINTIS TRINITI PROPERTI…",
  inside: "CP",
  band: "5%",
  origin: "local",
  investorType: "CP",
  stakeHundredths: 1234,
  shares: 1_000_000,
  radius: 10,
  focus: false,
  offList: move?.kind === "off list",
  move,
  labelled: true,
  refocus: undefined,
})

describe("tooltipText", () => {
  it.effect("names a holder's move and its change", () =>
    Effect.gen(function* () {
      const text = yield* tooltipText(
        holder({ kind: "down", percentageChange: -77 }),
        "TRUE"
      )
      expect(text.split("\n")).toEqual([
        "PT PERINTIS TRINITI PROPERTI TBK",
        "12.34% of TRUE",
        "Local · Corporate",
        "Down −0.77%",
      ])
    })
  )

  it.effect("names a crossing of 5%, and Unchanged with no change", () =>
    Effect.gen(function* () {
      const up = yield* tooltipText(
        holder({ kind: "up into 5%", percentageChange: undefined }),
        "TRUE"
      )
      expect(up.split("\n").at(-1)).toBe("Up into 5%")
      const unchanged = yield* tooltipText(
        holder({ kind: "unchanged", percentageChange: undefined }),
        "TRUE"
      )
      expect(unchanged.split("\n").at(-1)).toBe("Unchanged")
    })
  )

  it.effect("names an Off list holder's last % and the period it left", () =>
    Effect.gen(function* () {
      const month = yield* tooltipText(
        {
          ...holder({
            kind: "off list",
            band: "1%",
            since: WibDate.make("2026-09-30"),
          }),
          origin: undefined,
          investorType: undefined,
          stakeHundredths: 300,
        },
        "TRUE"
      )
      expect(month.split("\n")).toEqual([
        "PT PERINTIS TRINITI PROPERTI TBK",
        "3.00% of TRUE last",
        "Off list since Sep 2026",
      ])
      const day = yield* tooltipText(
        holder({
          kind: "off list",
          band: "5%",
          since: WibDate.make("2026-11-19"),
        }),
        "TRUE"
      )
      expect(day.split("\n").at(-1)).toBe("Off list since 19 Nov 2026")
    })
  )
})
