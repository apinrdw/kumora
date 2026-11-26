import { IconMailCheck } from "@tabler/icons-react"
import { useRouter } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { Effect } from "effect"
import { useState } from "react"

import { KButton } from "@/components/k"
import { authClient } from "@/lib/auth-client"
import { linkLifetime } from "@/lib/link-lifetime"
import { hostPath, withRedirect } from "@/lib/redirect"
import { retryAfter } from "@/lib/retry-after"

import { FormError, Notice } from "./auth-page"

type Resend =
  | { readonly _tag: "Idle" | "Sending" | "Sent" }
  | { readonly _tag: "Failed"; readonly error: string }

const resend = Effect.fnUntraced(function* (
  email: string,
  redirect: string
): Effect.fn.Return<Resend> {
  const retry = yield* retryAfter()
  const callbackURL = yield* hostPath(redirect)
  const { error } = yield* Effect.promise(() =>
    authClient.sendVerificationEmail(
      { email, callbackURL },
      { onError: retry.onError }
    )
  )
  if (!error) return { _tag: "Sent" }
  // A 429 is the per-IP limit or this address's daily mail cap.
  return {
    _tag: "Failed",
    error: yield* retry.messageFor(
      error,
      "Couldn't send the link. Try again in a minute."
    ),
  }
})

const signOut = Effect.fnUntraced(function* (
  redirect: string,
  navigate: (href: string) => Promise<void>
) {
  yield* Effect.promise(() => authClient.signOut())
  const href = yield* withRedirect("/sign-in", redirect)
  yield* Effect.promise(() => navigate(href))
})

// The verification link returns to `redirect`, the page first asked for.
function ResendButton({
  email,
  redirect,
  variant,
}: {
  email: string
  redirect: string
  variant: "primary" | "secondary"
}) {
  const [state, setState] = useState<Resend>({ _tag: "Idle" })
  return (
    <>
      <KButton
        variant={variant}
        loading={state._tag === "Sending"}
        onClick={() => {
          setState({ _tag: "Sending" })
          clientRuntime.runFork(
            Effect.flatMap(resend(email, redirect), (next) =>
              Effect.sync(() => setState(next))
            )
          )
        }}
      >
        {state._tag === "Sent" ? "Link sent again" : "Resend link"}
      </KButton>
      {state._tag === "Failed" && <FormError>{state.error}</FormError>}
    </>
  )
}

/** Shown right after sign-up. */
export function CheckInbox({
  email,
  redirect,
  onUseAnotherEmail,
}: {
  email: string
  redirect: string
  onUseAnotherEmail: () => void
}) {
  return (
    <Notice
      icon={IconMailCheck}
      title="Check your inbox"
      actions={
        <>
          <ResendButton email={email} redirect={redirect} variant="secondary" />
          <KButton variant="ghost" onClick={onUseAnotherEmail}>
            Use another email
          </KButton>
        </>
      }
    >
      <p>
        We sent a link to <b className="text-foreground">{email}</b>. Open it to
        finish creating your account; it brings you back to the page you asked
        for.
      </p>
    </Notice>
  )
}

/** Every page shows this, and no data, while the account is unverified. */
export function VerifyToContinue({
  email,
  redirect,
}: {
  email: string
  redirect: string
}) {
  const router = useRouter()
  return (
    <Notice
      icon={IconMailCheck}
      title="Verify your email to continue"
      actions={
        <>
          <ResendButton email={email} redirect={redirect} variant="primary" />
          <KButton
            variant="ghost"
            onClick={() =>
              clientRuntime.runFork(
                signOut(redirect, (href) => router.navigate({ href }))
              )
            }
          >
            Sign out
          </KButton>
        </>
      }
    >
      <p>
        You're signed in as <b className="text-foreground">{email}</b>, but the
        dashboard shows data only to verified accounts. The link we sent expires
        in {Effect.runSync(linkLifetime("verify"))}.
      </p>
    </Notice>
  )
}
