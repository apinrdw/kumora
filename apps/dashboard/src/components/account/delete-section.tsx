import { useHydrated } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { Effect } from "effect"

import { KButton } from "@/components/k"
import { authClient } from "@/lib/auth-client"
import { linkLifetime } from "@/lib/link-lifetime"

import {
  AccountSection,
  OutcomeLine,
  useAccountAction,
  type Outcome,
} from "./account-section"

const requestLink = Effect.fnUntraced(function* (
  email: string
): Effect.fn.Return<Outcome> {
  const { error } = yield* Effect.promise(() => authClient.deleteUser({}))
  if (error)
    return { _tag: "Failed", message: "Couldn't send the link. Try again." }
  const lifetime = yield* linkLifetime("delete")
  return {
    _tag: "Done",
    message: `Check ${email} for a link to delete the account. It works for ${lifetime}.`,
  }
})

/**
 * Delete account, by a link mailed to the account's address, so a stolen
 * session alone can't delete it. A config admin is told to leave the admin
 * list first.
 */
export function DeleteSection({
  email,
  canDelete,
  configAdmin,
}: {
  email: string
  canDelete: boolean
  configAdmin: boolean
}) {
  const hydrated = useHydrated()
  const { pending, outcome, run } = useAccountAction()
  return (
    <AccountSection
      title="Delete account"
      description="Removes the account, its sessions and its sign-in methods. You can sign up again with the same email later."
    >
      {(canDelete || configAdmin) && (
        <KButton
          variant="danger"
          className="self-start"
          loading={pending}
          disabled={!hydrated || !canDelete}
          onClick={() => clientRuntime.runFork(run(requestLink(email)))}
        >
          Email me a delete link
        </KButton>
      )}
      {configAdmin && (
        <p className="text-[13px] text-muted-foreground">
          Your email is on the admin list. Remove it from the list to delete the
          account.
        </p>
      )}
      <OutcomeLine outcome={outcome} />
    </AccountSection>
  )
}
