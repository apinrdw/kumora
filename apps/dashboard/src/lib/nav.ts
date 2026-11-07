import { IconUsers, type Icon } from "@tabler/icons-react"
import type { LinkProps } from "@tanstack/react-router"

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
    ],
  },
]

/** The nav an account sees: items of the features the access policy lets it view. */
export function visibleNav(
  nav: ReadonlyArray<NavGroup>,
  features: ReadonlyArray<Feature>
): ReadonlyArray<NavGroup> {
  return nav
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => features.includes(item.feature)),
    }))
    .filter((group) => group.items.length > 0)
}
