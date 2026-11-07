import { createFileRoute } from "@tanstack/react-router"

import { AuthPage } from "@/components/auth/auth-page"
import { SignUpForm } from "@/components/auth/sign-up-form"
import { safeRedirect } from "@/lib/redirect"

export const Route = createFileRoute("/sign-up")({
  validateSearch: (search) => ({ redirect: safeRedirect(search.redirect) }),
  head: () => ({ meta: [{ title: "Create account · KUMORA Terminal" }] }),
  component: SignUp,
})

function SignUp() {
  const { redirect } = Route.useSearch()
  return (
    <AuthPage>
      <SignUpForm redirect={redirect} />
    </AuthPage>
  )
}
