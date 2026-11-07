import { createFileRoute } from "@tanstack/react-router"

import { AuthPage } from "@/components/auth/auth-page"
import { ForgotPasswordForm } from "@/components/auth/password-reset"
import { safeRedirect } from "@/lib/redirect"

export const Route = createFileRoute("/forgot-password")({
  validateSearch: (search) => ({ redirect: safeRedirect(search.redirect) }),
  head: () => ({ meta: [{ title: "Reset password · KUMORA Terminal" }] }),
  component: ForgotPassword,
})

function ForgotPassword() {
  const { redirect } = Route.useSearch()
  return (
    <AuthPage>
      <ForgotPasswordForm redirect={redirect} />
    </AuthPage>
  )
}
