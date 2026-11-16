// Who may see an archive's admin page and start its runs: an admin, read past
// the cookie cache. Anyone else gets the refusal for `path`.
import { Effect } from "effect"

import { Auth } from "@/server/auth/auth"
import { decide, type Action } from "@/server/auth/policy"
import { refusal } from "@/server/auth/refusal"
import { accountOf } from "@/server/auth/session-account"

export const authorizeArchive = Effect.fnUntraced(function* (
  headers: Headers,
  action: Extract<
    Action,
    `admin.${string}-archive` | `admin.run-${string}-parse`
  >,
  path: string
) {
  const auth = yield* Auth
  // Admin server functions read past the cookie cache.
  const session = yield* auth.getSession(headers, { fresh: true })
  const decision = yield* decide(yield* accountOf(session), action, {
    feature: "admin",
  })
  if (decision._tag === "Deny") return yield* refusal(decision.reason, path)
})
