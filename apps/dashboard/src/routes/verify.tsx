import { createFileRoute } from "@tanstack/react-router"

import { AuthPage } from "@/components/auth/auth-page"
import { VerifyToContinue } from "@/components/auth/verify-notices"
import { safeRedirect } from "@/lib/redirect"
import { verifyScreenFn } from "@/server/auth/gate.functions"

// The gate sends an unverified session here from every page; once the
// account is verified it goes on to the page it asked for.
export const Route = createFileRoute("/verify")({
  validateSearch: (search) => ({ redirect: safeRedirect(search.redirect) }),
  beforeLoad: async ({ search }) => ({
    screen: await verifyScreenFn({ data: search.redirect }),
  }),
  head: () => ({ meta: [{ title: "Verify your email · KUMORA Terminal" }] }),
  component: Verify,
})

function Verify() {
  const { redirect } = Route.useSearch()
  const { screen } = Route.useRouteContext()
  return (
    <AuthPage>
      <VerifyToContinue email={screen.email} redirect={redirect} />
    </AuthPage>
  )
}
