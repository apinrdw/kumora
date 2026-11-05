import type { ReactNode } from "react"

import { AppHeader } from "./app-header"
import { AppSidebar } from "./app-sidebar"
import { MobileNav } from "./mobile-nav"
import { NetForeignTape } from "./net-foreign-tape"

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader />
        <NetForeignTape />
        <main className="flex-1 p-4 pb-20 md:p-6">{children}</main>
      </div>
      <MobileNav />
    </div>
  )
}
