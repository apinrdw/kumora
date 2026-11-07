import { Outlet, createFileRoute, notFound } from "@tanstack/react-router"
import type { ReactNode } from "react"

import { NoAccess } from "@/components/no-access"
import { NotFound } from "@/components/not-found"
import { AppShell } from "@/components/shell/app-shell"
import { pageFeature } from "@/lib/page-feature"
import { gatePageFn } from "@/server/auth/gate.functions"

// Every page in the shell sits under this layout, behind the sign-in gate.
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location, matches }) => {
    const feature = pageFeature(matches)
    // A page that names no feature has nothing the policy could allow.
    if (feature === undefined) throw notFound()
    const access = await gatePageFn({
      data: { href: location.href, feature },
    })
    return { access }
  },
  // Thrown here rather than in beforeLoad, so the not-found page still gets
  // the shell and the viewer.
  loader: ({ context }) => {
    if (context.access._tag === "NotFound") throw notFound()
  },
  component: () => <Shell page={<Outlet />} />,
  // Rendered in place of this layout's component, so it brings the shell.
  notFoundComponent: () => <Shell page={<NotFound />} />,
})

function Shell({ page }: { page: ReactNode }) {
  const { access } = Route.useRouteContext()
  return (
    <AppShell viewer={access.viewer}>
      {access._tag === "NoAccess" ? (
        <NoAccess feature={access.feature} />
      ) : (
        page
      )}
    </AppShell>
  )
}
