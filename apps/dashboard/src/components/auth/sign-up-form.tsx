import { Link, useHydrated } from "@tanstack/react-router"
import { clientRuntime, formFields } from "@workspace/client"
import { Effect } from "effect"
import { useState, type FormEvent } from "react"

import { KButton, KInput } from "@/components/k"
import { authClient } from "@/lib/auth-client"
import { MIN_PASSWORD_LENGTH } from "@/lib/password"
import { retryAfter } from "@/lib/retry-after"

import { FormError, linkClass } from "./auth-page"
import { CAPTCHA_HEADER, useTurnstile } from "./turnstile"
import { CheckInbox } from "./verify-notices"

type Step =
  | {
      readonly _tag: "Form"
      readonly pending: boolean
      readonly error?: string
    }
  | { readonly _tag: "CheckInbox"; readonly email: string }

// The step after the form: the inbox, or the form again with what went wrong.
const signUp = Effect.fnUntraced(function* (
  form: HTMLFormElement,
  token: string,
  redirect: string
): Effect.fn.Return<Step> {
  const fields = yield* formFields(form, ["name", "email", "password"])
  const retry = yield* retryAfter()
  const { error } = yield* Effect.promise(() =>
    authClient.signUp.email(
      { ...fields, callbackURL: redirect },
      {
        headers: { [CAPTCHA_HEADER]: token },
        onError: retry.onError,
      }
    )
  )
  if (!error) return { _tag: "CheckInbox", email: fields.email }
  return {
    _tag: "Form",
    pending: false,
    error: yield* retry.messageFor(
      error,
      "Couldn't create the account. Try again in a minute."
    ),
  }
})

// The new account holds an unverified session; end it before another try.
const startOver = Effect.promise(() => authClient.signOut())

/**
 * A taken email gets the same "Check your inbox" as a new one, so the form
 * never says whether an address has an account. What the inbox gets is the
 * server's call (hideTakenEmail in server/auth/options.ts): a set-password
 * link when the account is unverified, nothing when it is verified.
 */
export function SignUpForm({
  redirect,
  turnstileSiteKey,
}: {
  redirect: string
  turnstileSiteKey: string
}) {
  const hydrated = useHydrated()
  const {
    ref: turnstileRef,
    token: turnstileToken,
    reset: resetTurnstile,
  } = useTurnstile(turnstileSiteKey)
  const [step, setStep] = useState<Step>({ _tag: "Form", pending: false })

  if (step._tag === "CheckInbox")
    return (
      <CheckInbox
        email={step.email}
        redirect={redirect}
        onUseAnotherEmail={() =>
          clientRuntime.runFork(
            Effect.andThen(
              startOver,
              Effect.sync(() => setStep({ _tag: "Form", pending: false }))
            )
          )
        }
      />
    )

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!turnstileToken) return
        const form = event.currentTarget
        setStep({ _tag: "Form", pending: true })
        clientRuntime.runFork(
          Effect.flatMap(signUp(form, turnstileToken, redirect), (next) =>
            Effect.sync(() => {
              if (next._tag === "Form") resetTurnstile()
              setStep(next)
            })
          )
        )
      }}
    >
      <h1 className="text-xl font-semibold">Create your account</h1>
      <KInput label="Name" name="name" autoComplete="name" required size="md" />
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
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        size="md"
      />
      <div ref={turnstileRef} />
      {step.error && <FormError>{step.error}</FormError>}
      {/* Before hydration the browser would submit the form itself, as a GET
          with the password in the URL. */}
      <KButton
        type="submit"
        size="lg"
        loading={step.pending}
        disabled={!hydrated || !turnstileToken}
      >
        Create account
      </KButton>
      <p className="text-center text-xs text-muted-foreground">
        Have an account?{" "}
        <Link to="/sign-in" search={{ redirect }} className={linkClass}>
          Sign in
        </Link>
      </p>
    </form>
  )
}
