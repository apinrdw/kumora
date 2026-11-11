import { IconBrandGoogleFilled } from "@tabler/icons-react"
import { useHydrated } from "@tanstack/react-router"
import { Effect } from "effect"
import { useState } from "react"

import { KButton } from "@/components/k"
import { authClient } from "@/lib/auth-client"
import { withRedirect } from "@/lib/redirect"

/**
 * Continue with Google, then the "or" before the email form. Google comes back
 * to `redirect`, or to sign-in with `?error=` when it refuses.
 */
export function GoogleSignIn({ redirect }: { redirect: string }) {
  const hydrated = useHydrated()
  const [pending, setPending] = useState(false)

  const start = async () => {
    setPending(true)
    const { error } = await authClient.signIn.social({
      provider: "google",
      callbackURL: redirect,
      errorCallbackURL: Effect.runSync(withRedirect("/sign-in", redirect)),
    })
    if (error) setPending(false)
  }

  return (
    <>
      <KButton
        type="button"
        variant="secondary"
        size="lg"
        icon={IconBrandGoogleFilled}
        loading={pending}
        disabled={!hydrated}
        onClick={() => void start()}
      >
        Continue with Google
      </KButton>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
    </>
  )
}

/** What sign-in says when Google sent the visitor back with an error. */
export const googleErrorMessage = (code: string) =>
  code === "account_not_linked"
    ? "Sign in with your password and verify your email first."
    : "Couldn't sign in with Google. Try again in a minute."
