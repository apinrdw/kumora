import { Fragment, useEffect, useState } from "react"
import { IconChevronRight } from "@tabler/icons-react"
import { Link, useMatches } from "@tanstack/react-router"
import { Effect } from "effect"
import type { AnyRouteMatch } from "@tanstack/react-router"

import { KUMORA_MARK_SRC } from "@/lib/kumora-mark"
import type { Crumb } from "@/lib/crumbs"
import type { Viewer } from "@/server/auth/gate"

import { StockSearch } from "./stock-search"
import { UserMenu } from "./user-menu"

export function AppHeader({ viewer }: { viewer: Viewer }) {
  return (
    <header className="bg-canvas/82 sticky top-(--banner-h,0px) z-20 flex h-14 items-center gap-3 border-b border-border px-4 backdrop-blur-[16px]">
      <Link to="/" className="shrink-0 md:hidden">
        <img src={KUMORA_MARK_SRC} alt="KUMORA AI" className="size-7" />
      </Link>
      <Breadcrumbs />
      <span className="flex-1" />
      <StockSearch />
      <WibClock />
      {/* The sidebar holds the menu from 768px up. */}
      <span className="md:hidden">
        <UserMenu viewer={viewer} variant="avatar" />
      </span>
    </header>
  )
}

function Breadcrumbs() {
  // Typed `never[]` while no route exists; widened so crumbs work once one does.
  const matches: ReadonlyArray<AnyRouteMatch> = useMatches()
  const leaf = [...matches].reverse().find((m) => m.staticData.crumbs)
  const crumbs: ReadonlyArray<Crumb> = leaf?.staticData.crumbs
    ? Effect.runSync(leaf.staticData.crumbs(leaf.params))
    : []
  return (
    <nav
      aria-label="Breadcrumb"
      className="hidden min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground md:flex"
    >
      {crumbs.map((c, i) => (
        <Fragment key={c.label}>
          {i > 0 && (
            <IconChevronRight aria-hidden className="size-3.5 shrink-0" />
          )}
          {i === crumbs.length - 1 ? (
            <b
              aria-current="page"
              className="truncate font-semibold text-foreground"
            >
              {c.label}
            </b>
          ) : c.link ? (
            <Link {...c.link} className="truncate hover:text-foreground">
              {c.label}
            </Link>
          ) : (
            <span className="truncate">{c.label}</span>
          )}
        </Fragment>
      ))}
    </nav>
  )
}

const clockFormat = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Jakarta",
})

function WibClock() {
  const [now, setNow] = useState<string | null>(null)
  useEffect(() => {
    const tick = () => setNow(clockFormat.format(new Date()))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <span className="num text-secondary-text hidden items-center gap-1.5 text-xs sm:inline-flex">
      <i aria-hidden className="bg-up size-1.5 rounded-full" />
      <span className="min-w-[7.5ch]">{now ?? "--:--:--"}</span>
      <span className="text-muted-foreground">WIB</span>
    </span>
  )
}
