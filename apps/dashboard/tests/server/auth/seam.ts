import { Effect, Layer } from "effect"
import { DatabaseSync } from "node:sqlite"

import { Accounts } from "@/server/auth/accounts"
import { AdminEmails } from "@/server/auth/admin-emails"
import { Auth } from "@/server/auth/auth"
import { Mailer, type Mail } from "@/server/auth/mailer"

import { replayMigrations } from "../../../scripts/auth-schema.ts"

export const BASE_URL = "http://localhost:3001"

export const ADMIN_EMAIL = "owner@example.com"

// Seam 3 of spec apinrdw/kumora#80: the real Better Auth config over SQLite
// with the checked-in migrations, driven through its HTTP handler.
// ADMIN_EMAILS holds ADMIN_EMAIL.
export function seam({
  send,
}: { readonly send?: (mail: Mail) => Effect.Effect<void> } = {}) {
  const database = new DatabaseSync(":memory:")
  replayMigrations(database)
  const mails: Array<Mail> = []
  const mailer = Layer.succeed(Mailer, {
    send: send ?? ((mail) => Effect.sync(() => void mails.push(mail))),
  })
  const layer = Auth.make({
    database,
    baseURL: BASE_URL,
    secret: "handler-test-secret-0123456789abcdef0123456789",
    validateSchema: true,
  }).pipe(
    Layer.provideMerge(Accounts.make(database)),
    Layer.provideMerge(
      Layer.succeed(
        AdminEmails,
        AdminEmails.from(` ${ADMIN_EMAIL.toUpperCase()}, other@example.com`)
      )
    ),
    Layer.provide(mailer)
  )
  return { layer, mails, database }
}

export const send = Effect.fnUntraced(function* (
  path: string,
  init?: RequestInit
) {
  const auth = yield* Auth
  return yield* auth.handler(new Request(`${BASE_URL}/api/auth${path}`, init))
})

export const post = (path: string, body: unknown) =>
  send(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

export const signUp = (email: string, password = "correct horse") =>
  post("/sign-up/email", { email, password, name: "Ayu", callbackURL: "/" })

// The Cookie header a browser would send back after this response.
export const cookiesFrom = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ")

export const sessionOf = (cookie: string) =>
  send("/get-session?disableCookieCache=true", { headers: { cookie } }).pipe(
    Effect.flatMap((response) =>
      Effect.promise(
        () =>
          response.json() as Promise<{
            user: { email: string; emailVerified: boolean; role: string }
          } | null>
      )
    )
  )

// The path under /api/auth of the link in a mail.
export const linkIn = (mail: Mail | undefined) => {
  const url = mail?.text.match(/https?:\/\/\S+/)?.[0] ?? ""
  return url.slice(`${BASE_URL}/api/auth`.length)
}
