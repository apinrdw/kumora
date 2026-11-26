import { useHydrated } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { Effect } from "effect"
import type { FormEvent } from "react"

import { KButton, KInput } from "@/components/k"
import { authClient } from "@/lib/auth-client"
import type { FileRoutesByFullPath } from "@/routeTree.gen"

import {
  AccountSection,
  OutcomeLine,
  useAccountAction,
  type Outcome,
} from "./account-section"

// Where both change-email links land, as Better Auth's callbackURL. A link
// that fails comes back with `?error=<code>`.
const ACCOUNT_PATH = "/account" satisfies keyof FileRoutesByFullPath

const LINK_FAILED: Outcome = {
  _tag: "Failed",
  message: "That link has expired or was already used. Start again.",
}

const changeEmail = Effect.fnUntraced(function* (
  form: HTMLFormElement,
  newEmail: string,
  email: string
): Effect.fn.Return<Outcome> {
  const { error } = yield* Effect.promise(() =>
    authClient.changeEmail({ newEmail, callbackURL: ACCOUNT_PATH })
  )
  if (error)
    return {
      _tag: "Failed",
      message:
        error.status === 400
          ? "Enter an email other than the current one."
          : "Couldn't start the change. Try again.",
    }
  yield* Effect.sync(() => form.reset())
  return {
    _tag: "Done",
    message: `Check ${email} for a link to confirm the change.`,
  }
})

/**
 * Change email: the current address confirms the move, then the new one
 * verifies, and only then does the email change. A config admin's email is
 * the admin list's, so the section says so instead.
 */
export function EmailSection({
  email,
  canChange,
  configAdmin,
  linkError,
}: {
  email: string
  canChange: boolean
  configAdmin: boolean
  linkError: boolean
}) {
  const hydrated = useHydrated()
  const { pending, outcome, run } = useAccountAction()
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const newEmail = new FormData(form).get("newEmail")
    clientRuntime.runFork(
      run(
        changeEmail(
          form,
          typeof newEmail === "string" ? newEmail.trim() : "",
          email
        )
      )
    )
  }
  return (
    <AccountSection
      title="Email"
      description="We mail your current address to confirm, then the new one to verify. The email changes once the new one is verified."
    >
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={submit}
      >
        <KInput
          label="New email"
          name="newEmail"
          type="email"
          autoComplete="email"
          required
          disabled={!canChange}
          className="sm:max-w-sm sm:flex-1"
        />
        {(canChange || configAdmin) && (
          <KButton
            type="submit"
            variant="secondary"
            loading={pending}
            disabled={!hydrated || !canChange}
          >
            Change email
          </KButton>
        )}
      </form>
      {configAdmin && (
        <p className="text-[13px] text-muted-foreground">
          Your email is on the admin list. Change the list to change it.
        </p>
      )}
      <OutcomeLine outcome={outcome ?? (linkError ? LINK_FAILED : null)} />
    </AccountSection>
  )
}
