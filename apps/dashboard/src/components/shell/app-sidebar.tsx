import { Link } from "@tanstack/react-router"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import { NAV, visibleNav } from "@/lib/nav"
import type { NavItem } from "@/lib/nav"
import type { Viewer } from "@/server/auth/gate"

import { UserMenu } from "./user-menu"

/** 244px at ≥1280, 64px icon rail at 768–1279, hidden below (mobile uses the bottom nav). */
export function AppSidebar({ viewer }: { viewer: Viewer }) {
  return (
    <nav
      aria-label="Main navigation"
      className="sticky top-(--banner-h,0px) hidden h-[calc(100svh-var(--banner-h,0px))] w-16 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex xl:w-[244px]"
    >
      {/* An <a>, not a Link: with no routes yet, `/` is not a typed target. */}
      <a
        href="/"
        className="flex h-14 items-center justify-center gap-2.5 border-b border-sidebar-border px-0 xl:justify-start xl:px-4"
      >
        <img
          src="/kumora-mark.png"
          alt="KUMORA AI"
          className="size-7 xl:size-9"
        />
        <span className="hidden flex-col leading-[1.15] xl:flex">
          <b className="text-[15px] font-extrabold tracking-[-0.01em] whitespace-nowrap text-foreground">
            KUMORA<i className="text-primary not-italic">Terminal</i>
          </b>
          <span className="num text-[9px] tracking-[0.18em] text-muted-foreground uppercase">
            IDX
          </span>
        </span>
      </a>

      <div className="flex-1 overflow-y-auto px-1.5 py-3 xl:px-2.5">
        {Effect.runSync(visibleNav(NAV, viewer.features)).map((group) => (
          <div key={group.label} className="mb-3 flex flex-col gap-0.5">
            <span className="num hidden px-2.5 pb-1.5 text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase xl:block">
              {group.label}
            </span>
            {group.items.map((item) => (
              <SidebarLink key={item.label} item={item} />
            ))}
          </div>
        ))}
      </div>

      <div className="bg-canvas mx-2.5 mb-2 hidden items-center justify-between gap-2 rounded-sm border border-border px-2.5 py-2 xl:flex">
        <span className="num inline-flex items-center gap-1.5 text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
          <i aria-hidden className="bg-up size-1.5 rounded-full" />
          Market open
        </span>
        <span className="num text-[11px] text-muted-foreground">
          JK 09.00–15.50
        </span>
      </div>

      <div className="border-t border-sidebar-border">
        <UserMenu viewer={viewer} variant="rail" />
      </div>
      <p className="hidden px-3 pb-3 text-[11px] leading-4 text-muted-foreground xl:block">
        Analisis AI adalah dukungan keputusan, bukan saran investasi individual.
      </p>
    </nav>
  )
}

function SidebarLink({ item }: { item: NavItem }) {
  const Icon = item.icon
  return (
    <Link
      {...item.link}
      activeOptions={{ includeHash: Boolean(item.link.hash) }}
      title={item.label}
      className={cn(
        "group/nav text-secondary-text relative flex h-9 items-center justify-center gap-2.5 rounded-sm px-0 text-[13.5px] leading-[18px] font-medium whitespace-nowrap xl:justify-start xl:px-2.5",
        "hover:bg-elevated hover:text-foreground",
        !item.alias &&
          "data-[status=active]:bg-selected data-[status=active]:font-semibold data-[status=active]:text-foreground"
      )}
    >
      <Icon
        className={cn(
          "size-[18px] text-muted-foreground group-hover/nav:text-foreground",
          !item.alias && "group-data-[status=active]/nav:text-primary"
        )}
      />
      <span className="hidden flex-1 text-left xl:inline">{item.label}</span>
      {item.badge?.kind === "pill" && (
        <span className="num hidden rounded-xs bg-primary/12 px-1.5 py-px text-[9px] font-semibold tracking-[0.12em] text-primary uppercase xl:inline">
          {item.badge.text}
        </span>
      )}
      {item.badge?.kind === "count" && (
        <span className="num hidden text-[11px] text-muted-foreground xl:inline">
          {item.badge.value}
        </span>
      )}
      {item.badge?.kind === "dot" && (
        <span
          aria-label={item.badge.label}
          className="bg-warning size-1.5 rounded-full max-xl:absolute max-xl:top-2 max-xl:right-3"
        />
      )}
    </Link>
  )
}
