// The account listing behind /admin/users.
import { Effect } from "effect"

import type { AccountSearch } from "@/lib/account-query"
import { Accounts } from "@/server/auth/accounts"
import { Auth } from "@/server/auth/auth"
import { refusal } from "@/server/auth/gate"
import { accountOf } from "@/server/auth/session-account"
import { decide } from "@/server/auth/policy"

const USERS_PATH = "/admin/users"

export const listAccounts = Effect.fn("listAccounts")(function* (
  headers: Headers,
  search: AccountSearch
) {
  const auth = yield* Auth
  // Admin server functions read past the cookie cache.
  const session = yield* auth.getSession(headers, { fresh: true })
  const decision = decide(accountOf(session), "admin.list-accounts", {
    feature: "admin",
  })
  // A server function has no page to show "no access" on.
  if (decision._tag === "Deny")
    return yield* refusal(
      decision.reason === "no-access" ? "forbidden" : decision.reason,
      USERS_PATH
    )
  return yield* (yield* Accounts).list(search)
})
