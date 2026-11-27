import { IconBan } from "@tabler/icons-react"
import { Link, useHydrated, useRouter } from "@tanstack/react-router"
import { clientRuntime, formFields } from "@workspace/client"
import { Effect } from "effect"
import { useState, type FormEvent } from "react"

import { KButton, KInput } from "@/components/k"
import { authClient } from "@/lib/auth-client"
import { retryAfter } from "@/lib/retry-after"

import { FormError, Notice, linkClass } from "./auth-page"
import { GoogleSignIn, googleErrorMessage } from "./google-sign-in"

// Better Auth's code for a sign-in refused because an admin banned the
// account: a 403 to the password form, `?error=` back from Google.
const BANNED = "BANNED_USER"

const signIn = Effect.fnUntraced(function* (
  form: HTMLFormElement,
  view: {
    readonly setPending: (pending: boolean) => void
    readonly setError: (error: string | null) => void
    readonly setBanned: () => void
    readonly signedIn: Effect.Effect<void>
  }
) {
  yield* Effect.sync(() => {
    view.setPending(true)
    view.setError(null)
  })
  const retry = yield* retryAfter()
  const fields = yield* formFields(form, ["email", "password"])
  const { error: refused } = yield* Effect.promise(() =>
    authClient.signIn.email(fields, { onError: retry.onError })
  )
  if (!refused) return yield* view.signedIn
  yield* Effect.sync(() => view.setPending(false))
  if (refused.code === BANNED) return yield* Effect.sync(view.setBanned)
  // One message for an unknown email and a wrong password alike.
  const message =
    refused.status === 401
      ? "Wrong email or password."
      : yield* retry.messageFor(
          refused,
          "Couldn't sign in. Try again in a minute."
        )
  yield* Effect.sync(() => view.setError(message))
})

/**
 * Returns to `redirect` once signed in; the gate sends an unverified account
 * on to the verify screen. `google` is whether the stage offers Google, and
 * `error` is the code Google's sign-in came back with.
 */
export function SignInForm({
  redirect,
  google,
  error: googleError,
}: {
  redirect: string
  google: boolean
  error?: string
}) {
  const router = useRouter()
  const hydrated = useHydrated()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(
    googleError === undefined || googleError === BANNED
      ? null
      : Effect.runSync(googleErrorMessage(googleError))
  )
  const [bannedByPassword, setBannedByPassword] = useState(false)

  if (bannedByPassword || googleError === BANNED)
    return (
      <Suspended
        redirect={redirect}
        onBack={() => setBannedByPassword(false)}
      />
    )

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        clientRuntime.runFork(
          signIn(event.currentTarget, {
            setPending,
            setError,
            setBanned: () => setBannedByPassword(true),
            signedIn: Effect.promise(() => router.navigate({ href: redirect })),
          })
        )
      }}
    >
      <h1 className="text-xl font-semibold">Sign in to KUMORA</h1>
      {google && <GoogleSignIn redirect={redirect} />}
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
      <div className="flex justify-end text-xs">
        <Link to="/forgot-password" search={{ redirect }} className={linkClass}>
          Forgot password?
        </Link>
      </div>
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

/** Full page in place of the form. Never shows the ban's reason: that is for admins only. */
function Suspended({
  redirect,
  onBack,
}: {
  redirect: string
  onBack: () => void
}) {
  return (
    <Notice
      icon={IconBan}
      tone="down"
      title="This account is suspended"
      actions={
        <Link
          to="/sign-in"
          search={{ redirect }}
          className={linkClass}
          onClick={onBack}
        >
          Back to sign in
        </Link>
      }
    >
      <p>
        An admin suspended this account, so it can't sign in. Ask a KUMORA admin
        if you think this is a mistake.
      </p>
    </Notice>
  )
}
