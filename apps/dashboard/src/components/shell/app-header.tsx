import { Fragment, useEffect, useState } from "react"
import { IconChevronRight, IconSearch } from "@tabler/icons-react"
import {
  Link,
  useLoaderData,
  useMatches,
  useNavigate,
} from "@tanstack/react-router"

import { isSymbol } from "@/domain/symbol-guard"
import { miliarShort, pct, plain } from "@/lib/format"
import { LIVE_PAGE_PATH, LIVE_PAGE_SEARCH } from "@/relay/routes"
import type { Crumb } from "@/lib/crumbs"

export function AppHeader() {
  const { ihsg, foreignNet } = useLoaderData({ from: "__root__" })
  return (
    <header className="bg-canvas/82 sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border px-4 backdrop-blur-[16px]">
      <Link to="/radar" className="shrink-0 md:hidden">
        <img src="/kumora-mark.png" alt="KUMORA AI" className="size-7" />
      </Link>
      <Breadcrumbs />
      <span className="flex-1" />
      <TickerSearch />
      <span className="bg-elevated hidden h-8 items-center gap-2 rounded-sm border border-border px-2.5 text-xs whitespace-nowrap xl:inline-flex">
        <span className="num text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
          IHSG
        </span>
        <span className="num text-[12.5px] font-bold">
          {plain(ihsg.last, 2)}
        </span>
        <span className="num text-up text-[11.5px] font-semibold">
          {pct(ihsg.changePct)}
        </span>
      </span>
      <span className="bg-elevated hidden h-8 items-center gap-2 rounded-sm border border-border px-2.5 text-xs whitespace-nowrap xl:inline-flex">
        <span className="num text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
          Asing
        </span>
        <span className="num text-up text-[12.5px] font-bold">
          {miliarShort(foreignNet)}
        </span>
      </span>
      <WibClock />
    </header>
  )
}

function Breadcrumbs() {
  const matches = useMatches()
  const leaf = [...matches].reverse().find((m) => m.staticData.crumbs)
  const crumbs: ReadonlyArray<Crumb> =
    leaf?.staticData.crumbs?.(leaf.params) ?? []
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

function TickerSearch() {
  const navigate = useNavigate()
  return (
    <form
      role="search"
      className="relative w-60 min-w-0 shrink"
      onSubmit={(e) => {
        e.preventDefault()
        const input = e.currentTarget.elements.namedItem(
          "q"
        ) as HTMLInputElement
        const symbol = input.value.trim().toUpperCase()
        if (!isSymbol(symbol)) return
        input.value = ""
        void navigate({
          to: LIVE_PAGE_PATH,
          search: { [LIVE_PAGE_SEARCH.symbol]: symbol },
        })
      }}
    >
      <IconSearch
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        name="q"
        aria-label="Cari ticker"
        placeholder="Search ticker — BBCA, GOTO…"
        autoComplete="off"
        className="bg-surface h-8 w-full rounded-sm border border-input pr-10 pl-8 text-[13px] placeholder:text-muted-foreground"
        onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
      />
      <kbd className="num pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-xs border border-border px-1 text-[10px] text-muted-foreground">
        ⌘K
      </kbd>
    </form>
  )
}

const clockFormat = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
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
      <span className="min-w-[7.5ch]">{now ?? "--.--.--"}</span>
      <span className="text-muted-foreground">WIB</span>
    </span>
  )
}
