import type { Icon } from "@tabler/icons-react"
import type { LinkProps } from "@tanstack/react-router"

export type NavItem = {
  label: string
  shortLabel: string
  icon: Icon
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

/** Empty until the first page lands. */
export const NAV: ReadonlyArray<NavGroup> = []
