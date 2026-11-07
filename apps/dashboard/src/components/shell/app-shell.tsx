import type { CSSProperties, ReactNode } from "react"

import type { Viewer } from "@/server/auth/gate"

import { AppHeader } from "./app-header"
import { AppSidebar } from "./app-sidebar"
import { BANNER_HEIGHT, ImpersonationBanner } from "./impersonation-banner"
import { MobileNav } from "./mobile-nav"

export function AppShell({
  viewer,
  children,
}: {
  viewer: Viewer
  children: ReactNode
}) {
  // The sticky header and sidebar sit below the banner.
  const offset = {
    "--banner-h": viewer.impersonating ? BANNER_HEIGHT : "0px",
  } as CSSProperties
  return (
    <div style={offset} className="flex min-h-svh flex-col">
      {viewer.impersonating && <ImpersonationBanner email={viewer.email} />}
      <div className="flex flex-1">
        <AppSidebar viewer={viewer} />
        <div className="flex min-w-0 flex-1 flex-col">
          <AppHeader viewer={viewer} />
          <main className="flex-1 p-4 pb-20 md:p-6">{children}</main>
        </div>
        <MobileNav features={viewer.features} />
      </div>
    </div>
  )
}
