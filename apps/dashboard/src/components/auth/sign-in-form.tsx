import { Link, useHydrated, useRouter } from "@tanstack/react-router"
import { useState, type FormEvent } from "react"

import { KButton, KInput } from "@/components/k"
import { authClient } from "@/lib/auth-client"

import { FormError, formFields, linkClass } from "./auth-page"

/** Returns to `redirect` once signed in; the gate sends an unverified account on to the verify screen. */
export function SignInForm({ redirect }: { redirect: string }) {
  const router = useRouter()
  const hydrated = useHydrated()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    const { error: refused } = await authClient.signIn.email(
      formFields(event.currentTarget, ["email", "password"])
    )
    if (refused) {
      setPending(false)
      // One message for an unknown email and a wrong password alike.
      setError(
        refused.status === 401
          ? "Wrong email or password."
          : "Couldn't sign in. Try again in a minute."
      )
      return
    }
    await router.navigate({ href: redirect })
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <h1 className="text-xl font-semibold">Sign in to KUMORA</h1>
      <KInput
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        size="md"
      />
      <KInput
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        size="md"
      />
      {error && <FormError>{error}</FormError>}
      {/* Before hydration the browser would submit the form itself, as a GET
          with the password in the URL. */}
      <KButton type="submit" size="lg" loading={pending} disabled={!hydrated}>
        Sign in
      </KButton>
      <p className="text-center text-xs text-muted-foreground">
        New here?{" "}
        <Link to="/sign-up" search={{ redirect }} className={linkClass}>
          Create an account
        </Link>
      </p>
    </form>
  )
}
