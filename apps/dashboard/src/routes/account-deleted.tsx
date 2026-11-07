import { IconTrash } from "@tabler/icons-react"
import { Link, createFileRoute } from "@tanstack/react-router"

import { AuthPage, Notice, linkClass } from "@/components/auth/auth-page"

// Where /delete-account goes once the account is gone; there is no session
// left, so it sits outside the gate.
export const Route = createFileRoute("/account-deleted")({
  head: () => ({ meta: [{ title: "Account deleted · KUMORA Terminal" }] }),
  component: AccountDeleted,
})

function AccountDeleted() {
  return (
    <AuthPage>
      <Notice
        icon={IconTrash}
        title="Account deleted"
        actions={
          <Link to="/sign-up" search={{ redirect: "/" }} className={linkClass}>
            Create an account
          </Link>
        }
      >
        <p>
          The account, its sessions and its sign-in methods are gone. You can
          sign up again with the same email.
        </p>
      </Notice>
    </AuthPage>
  )
}
