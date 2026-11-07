import { useHydrated } from "@tanstack/react-router"
import type { FormEvent } from "react"

import { KButton, KInput } from "@/components/k"
import { authClient } from "@/lib/auth-client"
import { MIN_PASSWORD_LENGTH } from "@/lib/password"

import {
  AccountSection,
  OutcomeLine,
  useAccountAction,
} from "./account-section"

/**
 * Change password, with the current one. "Sign out other sessions" starts
 * ticked, so a change locks out anyone using the old password. The page shows
 * this only to an account with a password: a Google-only account gets one
 * through Forgot password.
 */
export function PasswordSection({ canChange }: { canChange: boolean }) {
  const hydrated = useHydrated()
  const { pending, outcome, run } = useAccountAction()
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    void run(async () => {
      const { error } = await authClient.changePassword({
        currentPassword: String(data.get("currentPassword")),
        newPassword: String(data.get("newPassword")),
        revokeOtherSessions: data.get("revokeOtherSessions") === "on",
      })
      if (error)
        return {
          _tag: "Failed",
          message:
            error.code === "INVALID_PASSWORD"
              ? "The current password is wrong."
              : "Couldn't change the password. Try again.",
        }
      form.reset()
      return { _tag: "Done", message: "Password changed." }
    })
  }
  return (
    <AccountSection title="Password">
      <form className="flex max-w-sm flex-col gap-3" onSubmit={submit}>
        <KInput
          label="Current password"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          disabled={!canChange}
        />
        <KInput
          label="New password"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          disabled={!canChange}
        />
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            name="revokeOtherSessions"
            defaultChecked
            disabled={!canChange}
            className="size-4 accent-primary"
          />
          Sign out other sessions
        </label>
        {canChange && (
          <KButton
            type="submit"
            variant="secondary"
            loading={pending}
            disabled={!hydrated}
            className="self-start"
          >
            Change password
          </KButton>
        )}
        <OutcomeLine outcome={outcome} />
      </form>
    </AccountSection>
  )
}
