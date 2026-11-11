import { createFileRoute } from "@tanstack/react-router"
import { loadServerFn, runLoader } from "@workspace/server/loader"
import { Effect } from "effect"

import { AuthPage } from "@/components/auth/auth-page"
import { SignUpForm } from "@/components/auth/sign-up-form"
import { safeRedirect } from "@/lib/redirect"
import { turnstileSiteKeyFn } from "@/server/auth/turnstile.functions"

export const Route = createFileRoute("/sign-up")({
  validateSearch: (search) => ({
    redirect: Effect.runSync(safeRedirect(search.redirect)),
  }),
  loader: () => runLoader(loadServerFn(() => turnstileSiteKeyFn())),
  head: () => ({ meta: [{ title: "Create account · KUMORA Terminal" }] }),
  component: SignUp,
})

function SignUp() {
  const { redirect } = Route.useSearch()
  return (
    <AuthPage>
      <SignUpForm
        redirect={redirect}
        turnstileSiteKey={Route.useLoaderData()}
      />
    </AuthPage>
  )
}
