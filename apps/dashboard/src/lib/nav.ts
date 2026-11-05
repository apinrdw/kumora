import { IconRadar, IconRadar2 } from "@tabler/icons-react"
import type { LinkProps } from "@tanstack/react-router"
import { LIVE_PAGE_PATH } from "@/relay/routes"

export type NavItem = {
  label: string
  shortLabel: string
  icon: typeof IconRadar
  link: LinkProps
  badge?:
    | { kind: "pill"; text: string }
    | { kind: "count"; value: number }
    | { kind: "dot"; label: string }
  mobile?: boolean
  /** A second entry into another item's screen; it never shows as the active item. */
  alias?: boolean
}

export type NavGroup = { label: string; items: ReadonlyArray<NavItem> }

/** A parent's own item must not light up on a page with its own entry below it. */
export const matchesExactly = ({ link }: NavItem) => link.to === "/radar"

export const NAV: ReadonlyArray<NavGroup> = [
  {
    label: "Markets",
    items: [
      {
        label: "Whale Radar",
        shortLabel: "Radar",
        icon: IconRadar,
        link: { to: "/radar" },
        badge: { kind: "pill", text: "Demo" },
        mobile: true,
      },
      {
        label: "Whale Radar Live",
        shortLabel: "Live",
        icon: IconRadar2,
        link: { to: LIVE_PAGE_PATH },
        mobile: true,
      },
    ],
  },
]
