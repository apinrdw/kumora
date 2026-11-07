import { createFileRoute } from "@tanstack/react-router"

import { AuthPage } from "@/components/auth/auth-page"
import { SignInForm } from "@/components/auth/sign-in-form"
import { safeRedirect } from "@/lib/redirect"

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search) => ({ redirect: safeRedirect(search.redirect) }),
  head: () => ({ meta: [{ title: "Sign in · KUMORA Terminal" }] }),
  component: SignIn,
})

function SignIn() {
  const { redirect } = Route.useSearch()
  return (
    <AuthPage>
      <SignInForm redirect={redirect} />
    </AuthPage>
  )
}
