import { IconChartCandle, IconUsers } from "@tabler/icons-react"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { visibleNav, type NavGroup } from "@/lib/nav"

const NAV: ReadonlyArray<NavGroup> = [
  {
    label: "Market",
    items: [
      {
        label: "Market Live",
        shortLabel: "Live",
        icon: IconChartCandle,
        link: { to: "/" },
        feature: "market-live",
      },
    ],
  },
  {
    label: "Admin",
    items: [
      {
        label: "Accounts",
        shortLabel: "Accounts",
        icon: IconUsers,
        link: { to: "/" },
        feature: "admin",
      },
    ],
  },
]

const labels = (nav: ReadonlyArray<NavGroup>) =>
  nav.map((group) => [group.label, group.items.map((item) => item.label)])

describe("visibleNav", () => {
  it.effect("keeps the items of features the account may view", () =>
    Effect.gen(function* () {
      expect(labels(yield* visibleNav(NAV, ["market-live", "admin"]))).toEqual([
        ["Market", ["Market Live"]],
        ["Admin", ["Accounts"]],
      ])
    })
  )

  it.effect("drops a group left with no item", () =>
    Effect.gen(function* () {
      expect(
        labels(yield* visibleNav(NAV, ["market-live", "account"]))
      ).toEqual([["Market", ["Market Live"]]])
    })
  )
})
