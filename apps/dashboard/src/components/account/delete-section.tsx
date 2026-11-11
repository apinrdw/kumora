import { useHydrated } from "@tanstack/react-router"
import { Effect } from "effect"

import { KButton } from "@/components/k"
import { authClient } from "@/lib/auth-client"
import { linkLifetime } from "@/lib/link-lifetime"

import {
  AccountSection,
  OutcomeLine,
  useAccountAction,
} from "./account-section"

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
  const requestLink = () =>
    run(async () => {
      const { error } = await authClient.deleteUser({})
      return error
        ? { _tag: "Failed", message: "Couldn't send the link. Try again." }
        : {
            _tag: "Done",
            message: `Check ${email} for a link to delete the account. It works for ${Effect.runSync(linkLifetime("delete"))}.`,
          }
    })
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
          onClick={() => void requestLink()}
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
