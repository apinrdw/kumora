import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"

import { ConfirmDelete } from "@/components/account/confirm-delete"
import { accountPageFn } from "@/server/auth/account-page.functions"

// The delete link mailed by Better Auth's deleteUser opens this page; its path
// is DELETE_ACCOUNT_PATH in src/server/auth/options.ts. It sits behind the
// gate, so a signed-out visitor signs in and comes back with the token.
export const Route = createFileRoute("/_app/delete-account")({
  staticData: {
    feature: "account",
    crumbs: () =>
      Effect.succeed([{ label: "Account" }, { label: "Delete account" }]),
  },
  validateSearch: (search): { token?: string } =>
    typeof search.token === "string" ? { token: search.token } : {},
  loader: ({ location }) => accountPageFn({ data: location.href }),
  head: () => ({ meta: [{ title: "Delete account · KUMORA Terminal" }] }),
  component: DeleteAccount,
})

function DeleteAccount() {
  const page = Route.useLoaderData()
  const { token } = Route.useSearch()
  return (
    <ConfirmDelete
      email={page.email}
      token={token}
      canDelete={page.allowed["own.delete"]}
    />
  )
}
