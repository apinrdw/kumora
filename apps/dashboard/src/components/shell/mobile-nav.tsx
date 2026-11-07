import { Link } from "@tanstack/react-router"

import { NAV, visibleNav } from "@/lib/nav"
import type { Feature } from "@/server/auth/policy"

/** Below 768px the sidebar gives way to a bottom bar: monitoring and alerts first. */
export function MobileNav({ features }: { features: ReadonlyArray<Feature> }) {
  const items = visibleNav(NAV, features)
    .flatMap((g) => g.items)
    .filter((i) => i.mobile)
  if (items.length === 0) return null
  return (
    <nav
      aria-label="Navigasi utama"
      className="fixed inset-x-0 bottom-0 z-30 grid h-16 border-t border-border bg-sidebar pb-[env(safe-area-inset-bottom)] md:hidden"
      style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)` }}
    >
      {items.map((item) => {
        const Icon = item.icon
        return (
          <Link
            key={item.label}
            {...item.link}
            activeOptions={{ includeHash: Boolean(item.link.hash) }}
            className="flex flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground data-[status=active]:text-primary"
          >
            <Icon aria-hidden className="size-5" />
            {item.shortLabel}
          </Link>
        )
      })}
    </nav>
  )
}
