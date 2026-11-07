// The account listing behind /admin/users.
import { Effect } from "effect"

import type {
  AccountPage,
  AccountRow,
  AccountSearch,
  ListedAccount,
} from "@/lib/account-query"
import { Accounts } from "@/server/auth/accounts"
import { AdminEmails } from "@/server/auth/admin-emails"
import { Auth } from "@/server/auth/auth"
import { refusal } from "@/server/auth/gate"
import { decide, type Account, type TargetAction } from "@/server/auth/policy"
import { accountOf, targetOf } from "@/server/auth/session-account"

const USERS_PATH = "/admin/users"

// What the access policy lets the admin do to each listed account, so the
// page offers only those actions. Better Auth's before-hooks ask again.
const withAllowed = (
  admin: Account,
  adminId: string,
  onAdminList: (email: string) => boolean
) =>
  function (row: AccountRow): ListedAccount {
    const target = targetOf(
      { ...row, banned: row.status === "suspended" },
      adminId,
      onAdminList
    )
    const allows = (action: TargetAction) =>
      decide(admin, action, target)._tag === "Allow"
    return {
      ...row,
      allowed: {
        "admin.ban": allows("admin.ban"),
        "admin.unban": allows("admin.unban"),
        "admin.set-role": allows("admin.set-role"),
        "admin.end-sessions": allows("admin.end-sessions"),
        "admin.impersonate": allows("admin.impersonate"),
      },
    }
  }

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
  // A server function has no page to show "no access" on.
  if (decision._tag === "Deny")
    return yield* refusal(
      decision.reason === "no-access" ? "forbidden" : decision.reason,
      USERS_PATH
    )
  // Unreachable: the policy sends every visitor without a session to sign-in.
  if (session === null || account._tag === "SignedOut")
    return yield* refusal("sign-in", USERS_PATH)
  const page = yield* (yield* Accounts).list(search)
  const adminEmails = yield* AdminEmails
  return {
    total: page.total,
    rows: page.rows.map(
      withAllowed(account, session.user.id, adminEmails.includes)
    ),
  } satisfies AccountPage
})
