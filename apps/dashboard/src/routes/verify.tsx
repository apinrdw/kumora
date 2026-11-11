import { createFileRoute } from "@tanstack/react-router"
import { loadServerFn, runLoader } from "@workspace/server/loader"
import { Effect } from "effect"

import { AuthPage } from "@/components/auth/auth-page"
import { VerifyToContinue } from "@/components/auth/verify-notices"
import { ImpersonationBanner } from "@/components/shell/impersonation-banner"
import { safeRedirect } from "@/lib/redirect"
import { verifyScreenFn } from "@/server/auth/gate.functions"

// The gate sends an unverified session here from every page; once the
// account is verified it goes on to the page it asked for.
export const Route = createFileRoute("/verify")({
  validateSearch: (search) => ({
    redirect: Effect.runSync(safeRedirect(search.redirect)),
  }),
  beforeLoad: ({ search }) =>
    runLoader(
      Effect.map(
        loadServerFn(() => verifyScreenFn({ data: search.redirect })),
        (screen) => ({ screen })
      )
    ),
  head: () => ({ meta: [{ title: "Verify your email · KUMORA Terminal" }] }),
  component: Verify,
})

function Verify() {
  const { redirect } = Route.useSearch()
  const { screen } = Route.useRouteContext()
  return (
    <>
      {screen.impersonating && <ImpersonationBanner email={screen.email} />}
      <AuthPage>
        <VerifyToContinue email={screen.email} redirect={redirect} />
      </AuthPage>
    </>
  )
}
