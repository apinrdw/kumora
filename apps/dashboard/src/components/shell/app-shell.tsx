import type { ReactNode } from "react"

import type { Viewer } from "@/server/auth/gate"

import { AppHeader } from "./app-header"
import { AppSidebar } from "./app-sidebar"
import { MobileNav } from "./mobile-nav"

export function AppShell({
  viewer,
  children,
}: {
  viewer: Viewer
  children: ReactNode
}) {
  return (
    <div className="flex min-h-svh">
      <AppSidebar viewer={viewer} />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader viewer={viewer} />
        <main className="flex-1 p-4 pb-20 md:p-6">{children}</main>
      </div>
      <MobileNav features={viewer.features} />
    </div>
  )
}
