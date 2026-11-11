import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"

import { AuthPage } from "@/components/auth/auth-page"
import { ForgotPasswordForm } from "@/components/auth/password-reset"
import { safeRedirect } from "@/lib/redirect"
import { turnstileSiteKeyFn } from "@/server/auth/turnstile.functions"

export const Route = createFileRoute("/forgot-password")({
  validateSearch: (search) => ({
    redirect: Effect.runSync(safeRedirect(search.redirect)),
  }),
  loader: () => turnstileSiteKeyFn(),
  head: () => ({ meta: [{ title: "Reset password · KUMORA Terminal" }] }),
  component: ForgotPassword,
})

function ForgotPassword() {
  const { redirect } = Route.useSearch()
  return (
    <AuthPage>
      <ForgotPasswordForm
        redirect={redirect}
        turnstileSiteKey={Route.useLoaderData()}
      />
    </AuthPage>
  )
}
