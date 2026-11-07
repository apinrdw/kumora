import {
  IconCircleCheck,
  IconLinkOff,
  IconMailCheck,
} from "@tabler/icons-react"
import { Link, useHydrated } from "@tanstack/react-router"
import { useState, type FormEvent } from "react"

import { KButton, KInput } from "@/components/k"
import { authClient } from "@/lib/auth-client"
import { MIN_PASSWORD_LENGTH, resetPasswordPage } from "@/lib/password"
import { retryAfter } from "@/lib/retry-after"

import { FormError, Notice, formFields, linkClass } from "./auth-page"
import { CAPTCHA_HEADER, useTurnstile } from "./turnstile"

const RESET_LINK_HOURS = 1

function BackToSignIn({ redirect }: { redirect: string }) {
  return (
    <Link to="/sign-in" search={{ redirect }} className={linkClass}>
      Back to sign in
    </Link>
  )
}

type Request =
  | {
      readonly _tag: "Form"
      readonly pending: boolean
      readonly error?: string
    }
  | { readonly _tag: "Sent"; readonly email: string }

/**
 * Better Auth answers a known and an unknown email alike, so "Reset link
 * sent" never says whether the address has an account.
 */
export function ForgotPasswordForm({
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
  const [step, setStep] = useState<Request>({ _tag: "Form", pending: false })

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!turnstileToken) return
    const { email } = formFields(event.currentTarget, ["email"])
    setStep({ _tag: "Form", pending: true })
    const retry = retryAfter()
    const { error } = await authClient.requestPasswordReset(
      {
        email,
        redirectTo: resetPasswordPage(redirect),
      },
      {
        headers: { [CAPTCHA_HEADER]: turnstileToken },
        onError: retry.onError,
      }
    )
    if (!error) return setStep({ _tag: "Sent", email })
    resetTurnstile()
    // Only the per-IP limit answers 429 here: over the per-address cap the
    // reply is the same "Reset link sent" as for any address.
    setStep({
      _tag: "Form",
      pending: false,
      error: retry.messageFor(
        error,
        "Couldn't send the link. Try again in a minute."
      ),
    })
  }

  if (step._tag === "Sent")
    return (
      <Notice
        icon={IconMailCheck}
        title="Reset link sent"
        actions={<BackToSignIn redirect={redirect} />}
      >
        <p>
          If <b className="text-foreground">{step.email}</b> has an account, a
          reset link is on its way. It expires in {RESET_LINK_HOURS} hour.
        </p>
      </Notice>
    )

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <h1 className="text-xl font-semibold">Reset your password</h1>
      <p className="text-[13px] text-muted-foreground">
        Enter your account's email and we'll send a reset link.
      </p>
      <KInput
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        size="md"
      />
      <div ref={turnstileRef} />
      {step.error && <FormError>{step.error}</FormError>}
      {/* Before hydration the browser would submit the form itself, as a GET. */}
      <KButton
        type="submit"
        size="lg"
        loading={step.pending}
        disabled={!hydrated || !turnstileToken}
      >
        Send reset link
      </KButton>
      <BackToSignIn redirect={redirect} />
    </form>
  )
}

type SetPassword =
  | {
      readonly _tag: "Form"
      readonly pending: boolean
      readonly error?: string
    }
  | { readonly _tag: "Expired" }
  | { readonly _tag: "Done" }

/**
 * The page a reset link opens. Setting the password ends every session of
 * the account, so the next step is signing in, which returns to `redirect`.
 */
export function SetPasswordForm({
  token,
  redirect,
}: {
  token: string | undefined
  redirect: string
}) {
  const hydrated = useHydrated()
  const [step, setStep] = useState<SetPassword>(
    token ? { _tag: "Form", pending: false } : { _tag: "Expired" }
  )

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!token) return
    const { newPassword } = formFields(event.currentTarget, ["newPassword"])
    setStep({ _tag: "Form", pending: true })
    const { error } = await authClient.resetPassword({ newPassword, token })
    if (!error) return setStep({ _tag: "Done" })
    // Better Auth answers an expired or used token with INVALID_TOKEN.
    setStep(
      error.code === "INVALID_TOKEN"
        ? { _tag: "Expired" }
        : {
            _tag: "Form",
            pending: false,
            error: "Couldn't set the password. Try again in a minute.",
          }
    )
  }

  if (step._tag === "Expired")
    return (
      <Notice
        icon={IconLinkOff}
        title="This reset link has expired"
        tone="down"
        actions={
          <>
            <Link
              to="/forgot-password"
              search={{ redirect }}
              className={linkClass}
            >
              Send a new link
            </Link>
            <BackToSignIn redirect={redirect} />
          </>
        }
      >
        <p>
          A reset link works once, for {RESET_LINK_HOURS} hour. Ask for a new
          one.
        </p>
      </Notice>
    )

  if (step._tag === "Done")
    return (
      <Notice
        icon={IconCircleCheck}
        title="Password set"
        actions={
          <Link to="/sign-in" search={{ redirect }} className={linkClass}>
            Sign in with your new password
          </Link>
        }
      >
        <p>Every other session of this account is signed out.</p>
      </Notice>
    )

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <KInput
        label="New password"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters. Signs you out on other devices.`}
        size="md"
      />
      {step.error && <FormError>{step.error}</FormError>}
      {/* Before hydration the browser would submit the form itself, as a GET
          with the password in the URL. */}
      <KButton
        type="submit"
        size="lg"
        loading={step.pending}
        disabled={!hydrated}
      >
        Set password
      </KButton>
    </form>
  )
}
