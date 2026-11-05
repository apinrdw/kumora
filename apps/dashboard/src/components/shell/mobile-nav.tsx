import { Link } from "@tanstack/react-router"

import { NAV } from "@/lib/nav"

const ITEMS = NAV.flatMap((g) => g.items).filter((i) => i.mobile)

/** Below 768px the sidebar gives way to a bottom bar: monitoring and alerts first. */
export function MobileNav() {
  if (ITEMS.length === 0) return null
  return (
    <nav
      aria-label="Navigasi utama"
      className="fixed inset-x-0 bottom-0 z-30 grid h-16 border-t border-border bg-sidebar pb-[env(safe-area-inset-bottom)] md:hidden"
      style={{ gridTemplateColumns: `repeat(${ITEMS.length}, 1fr)` }}
    >
      {ITEMS.map((item) => {
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
