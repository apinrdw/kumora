// The account listing behind /admin/users.
import { Effect } from "effect"

import type { AccountRow, AccountSearch } from "@/lib/account-query"
import type { FileRoutesByFullPath } from "@/routeTree.gen"
import { Accounts } from "@/server/auth/accounts"
import { AdminEmails } from "@/server/auth/admin-emails"
import { Auth } from "@/server/auth/auth"
import { decide, type TargetAction } from "@/server/auth/policy"
import { refusal } from "@/server/auth/refusal"
import { accountOf, targetOf } from "@/server/auth/session-account"

const USERS_PATH = "/admin/users" satisfies keyof FileRoutesByFullPath

// Every action an admin takes on one account; the table offers only those
// the policy allows.
const TARGET_ACTIONS = Object.keys({
  "admin.ban": true,
  "admin.unban": true,
  "admin.set-role": true,
  "admin.end-sessions": true,
  "admin.impersonate": true,
} satisfies Record<TargetAction, true>) as ReadonlyArray<TargetAction>

export const listAccounts = Effect.fn("listAccounts")(function* (
  headers: Headers,
  search: AccountSearch
) {
  const auth = yield* Auth
  // Admin server functions read past the cookie cache.
  const session = yield* auth.getSession(headers, { fresh: true })
  const account = accountOf(session)
  const decision = decide(account, "admin.list-accounts", {
    feature: "admin",
  })
  if (decision._tag === "Deny")
    return yield* refusal(decision.reason, USERS_PATH)
  const adminEmails = yield* AdminEmails
  const page = yield* (yield* Accounts).list(search, adminEmails)
  return {
    total: page.total,
    rows: page.rows.map((row): AccountRow => {
      const target = targetOf(
        { ...row, banned: row.status === "suspended" },
        session,
        adminEmails
      )
      return {
        ...row,
        allowed: Object.fromEntries(
          TARGET_ACTIONS.map((action) => [
            action,
            decide(account, action, target)._tag === "Allow",
          ])
        ) as Record<TargetAction, boolean>,
      }
    }),
  }
})
