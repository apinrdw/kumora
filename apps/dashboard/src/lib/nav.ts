import {
  IconArchive,
  IconChartBubble,
  IconChartCandle,
  IconFileZip,
  IconRadar,
  IconUsers,
  type Icon,
} from "@tabler/icons-react"
import type { LinkProps } from "@tanstack/react-router"
import { Effect } from "effect"

import type { Feature } from "@/server/auth/policy"

export type NavItem = {
  label: string
  shortLabel: string
  icon: Icon
  link: LinkProps
  /** The feature the page belongs to; the item shows only to accounts that may view it. */
  feature: Feature
  badge?:
    | { kind: "pill"; text: string }
    | { kind: "count"; value: number }
    | { kind: "dot"; label: string }
  mobile?: boolean
  /** A second entry into another item's screen; it never shows as the active item. */
  alias?: boolean
}

export type NavGroup = { label: string; items: ReadonlyArray<NavItem> }

export const NAV: ReadonlyArray<NavGroup> = [
  {
    label: "Market",
    items: [
      {
        label: "Market Live",
        shortLabel: "Live",
        icon: IconChartCandle,
        link: { to: "/market-live" },
        feature: "market-live",
        mobile: true,
      },
      {
        label: "Market Bubbles",
        shortLabel: "Bubbles",
        icon: IconChartBubble,
        link: { to: "/market-bubbles" },
        feature: "market-live",
        mobile: true,
      },
      {
        label: "Order book radar",
        shortLabel: "Radar",
        icon: IconRadar,
        link: { to: "/order-book-radar" },
        feature: "market-live",
        mobile: true,
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
        link: { to: "/admin/users" },
        feature: "admin",
        mobile: true,
      },
      {
        label: "Shareholding archive",
        shortLabel: "Archive",
        icon: IconArchive,
        link: { to: "/admin/shareholding" },
        feature: "admin",
      },
      {
        label: "KSEI archive",
        shortLabel: "KSEI",
        icon: IconFileZip,
        link: { to: "/admin/ksei" },
        feature: "admin",
      },
    ],
  },
]

/** The nav an account sees: items of the features the access policy lets it view. */
export const visibleNav = (
  nav: ReadonlyArray<NavGroup>,
  features: ReadonlyArray<Feature>
): Effect.Effect<ReadonlyArray<NavGroup>> =>
  Effect.sync(() =>
    nav
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => features.includes(item.feature)),
      }))
      .filter((group) => group.items.length > 0)
  )
