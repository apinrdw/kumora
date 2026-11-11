import { createFileRoute } from "@tanstack/react-router"
import { loadServerFn, runLoader } from "@workspace/server/loader"
import { Effect } from "effect"

import { AuthPage } from "@/components/auth/auth-page"
import { SignInForm } from "@/components/auth/sign-in-form"
import { safeRedirect } from "@/lib/redirect"
import { googleSignInFn } from "@/server/auth/google.functions"

export const Route = createFileRoute("/sign-in")({
  // `error` is set by Better Auth when Google sends the visitor back refused.
  validateSearch: (search): { redirect: string; error?: string } => ({
    redirect: Effect.runSync(safeRedirect(search.redirect)),
    ...(typeof search.error === "string" && { error: search.error }),
  }),
  loader: () =>
    runLoader(
      Effect.map(
        loadServerFn(() => googleSignInFn()),
        (google) => ({ google })
      )
    ),
  staleTime: Infinity,
  head: () => ({ meta: [{ title: "Sign in · KUMORA Terminal" }] }),
  component: SignIn,
})

function SignIn() {
  const { redirect, error } = Route.useSearch()
  const { google } = Route.useLoaderData()
  return (
    <AuthPage>
      <SignInForm redirect={redirect} google={google} error={error} />
    </AuthPage>
  )
}
