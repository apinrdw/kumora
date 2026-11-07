import { WorkerEnv } from "@workspace/server"
import { Context, Effect, Layer } from "effect"

import type { AdminList } from "./session-account.ts"

// The configured admin list, ADMIN_EMAILS: a comma-separated list of emails.
// An account whose verified email is on it is a config admin.
export class AdminEmails extends Context.Service<AdminEmails, AdminList>()(
  "dashboard/server/auth/AdminEmails"
) {
  static readonly from = (raw: string) => {
    const emails = new Set(
      raw
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email !== "")
    )
    return AdminEmails.of({
      includes: (email) => emails.has(email.toLowerCase()),
    })
  }

  static readonly layer = Layer.effect(
    AdminEmails,
    Effect.gen(function* () {
      return AdminEmails.from((yield* WorkerEnv).ADMIN_EMAILS)
    })
  )
}
