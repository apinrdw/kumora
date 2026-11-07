import { Link, useHydrated, useNavigate } from "@tanstack/react-router"
import { cn } from "@workspace/ui/lib/utils"
import { useState } from "react"

import { KButton, kCard } from "@/components/k"
import { authClient } from "@/lib/auth-client"

const linkClass = "text-[13px] text-primary hover:underline"

/**
 * The page the delete link opens. It asks once more before it spends the
 * token, so a mail scanner opening the link deletes nothing, and the visitor
 * sees which account goes.
 */
export function ConfirmDelete({
  email,
  token,
  canDelete,
}: {
  email: string
  token: string | undefined
  canDelete: boolean
}) {
  const hydrated = useHydrated()
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const linkGone =
    "This link has expired or was already used, or it belongs to another account. Ask for a new one on your account page."

  const confirm = async () => {
    if (token === undefined) return
    setPending(true)
    setFailed(null)
    const { error } = await authClient.$fetch("/delete-user/callback", {
      method: "GET",
      query: { token },
    })
    if (!error) return navigate({ to: "/account-deleted" })
    setPending(false)
    setFailed(
      error.status === 404
        ? linkGone
        : "Couldn't delete the account. Try again."
    )
  }

  const refusal =
    token === undefined
      ? linkGone
      : canDelete
        ? null
        : "This session can't delete the account."
  return (
    <section
      aria-labelledby="delete-account"
      className={cn(kCard, "mx-auto flex max-w-lg flex-col gap-4")}
    >
      <h1 id="delete-account" className="text-xl font-semibold">
        Delete your account?
      </h1>
      <p className="text-[13px] text-muted-foreground">
        This removes <b className="text-foreground">{email}</b>, its sessions
        and its sign-in methods. It can't be undone. You can sign up again with
        the same email later.
      </p>
      {(refusal ?? failed) !== null && (
        <p role="alert" className="text-down text-[13px]">
          {refusal ?? failed}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-4">
        {refusal === null && (
          <KButton
            variant="danger"
            loading={pending}
            disabled={!hydrated}
            onClick={() => void confirm()}
          >
            Delete account
          </KButton>
        )}
        <Link to="/account" className={linkClass}>
          Back to account
        </Link>
      </div>
    </section>
  )
}
