import { createFileRoute } from "@tanstack/react-router"
import { useCallback } from "react"

import { AccountsTable } from "@/components/admin/accounts-table"
import { parseAccountSearch, type AccountSearch } from "@/lib/account-query"
import { orNotFound } from "@/lib/or-not-found"
import { listAccountsFn } from "@/server/admin/accounts.functions"

export const Route = createFileRoute("/_app/admin/users")({
  staticData: {
    feature: "admin",
    crumbs: () => [{ label: "Admin" }, { label: "Accounts" }],
  },
  validateSearch: parseAccountSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => orNotFound(listAccountsFn({ data: deps })),
  head: () => ({ meta: [{ title: "Accounts · KUMORA Terminal" }] }),
  component: UsersPage,
})

function UsersPage() {
  const page = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onSearch = useCallback(
    (change: Partial<AccountSearch>) =>
      void navigate({
        search: (previous: AccountSearch) => ({
          ...previous,
          page: undefined,
          ...change,
        }),
        replace: true,
      }),
    [navigate]
  )
  return (
    <div className="flex flex-col gap-5 py-6">
      <h1 className="text-2xl font-bold">Accounts</h1>
      <AccountsTable page={page} search={search} onSearch={onSearch} />
    </div>
  )
}
