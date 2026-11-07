import { createFileRoute } from "@tanstack/react-router"

import { AuthPage } from "@/components/auth/auth-page"
import { SetPasswordForm } from "@/components/auth/password-reset"
import { safeRedirect } from "@/lib/redirect"

// A reset link lands here through Better Auth, with `token` when the link is
// still good and `error=INVALID_TOKEN` (no token) when it isn't.
export const Route = createFileRoute("/reset-password")({
  validateSearch: (search) => ({
    redirect: safeRedirect(search.redirect),
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  head: () => ({ meta: [{ title: "Set new password · KUMORA Terminal" }] }),
  component: ResetPassword,
})

function ResetPassword() {
  const { redirect, token } = Route.useSearch()
  return (
    <AuthPage>
      <SetPasswordForm token={token} redirect={redirect} />
    </AuthPage>
  )
}
