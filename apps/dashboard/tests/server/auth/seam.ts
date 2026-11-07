import { Effect, Layer } from "effect"
import { DatabaseSync } from "node:sqlite"
import { vi } from "vitest"

import { Accounts } from "@/server/auth/accounts"
import { AdminEmails } from "@/server/auth/admin-emails"
import { Auth, type AuthConfig } from "@/server/auth/auth"
import { Mailer, type Mail } from "@/server/auth/mailer"
import { CLIENT_IP_HEADER } from "@/server/auth/options"

import { replayMigrations } from "../../../scripts/auth-schema.ts"

export const BASE_URL = "http://localhost:3001"

export const ADMIN_EMAIL = "owner@example.com"

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
const TURNSTILE_SECRET = "handler-test-turnstile-secret"
// The token a solved widget would hand the form; any other is rejected.
const SOLVED_TURNSTILE = "solved-turnstile-token"

// Cloudflare's siteverify, faked: the captcha plugin calls the global fetch.
const siteverify = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== SITEVERIFY) throw new Error(`Unexpected fetch to ${url}`)
  const { secret, response } = JSON.parse(String(init?.body)) as {
    secret: string
    response: string
  }
  return Response.json({
    success: secret === TURNSTILE_SECRET && response === SOLVED_TURNSTILE,
  })
}

// The seam's ADMIN_EMAILS: ADMIN_EMAIL and other@example.com.
const ADMIN_EMAILS = ` ${ADMIN_EMAIL.toUpperCase()}, other@example.com`

// Seam 3 of spec apinrdw/kumora#80: the real Better Auth config over SQLite
// with the checked-in migrations, driven through its HTTP handler. `deployed`
// makes it a later deploy of an earlier seam's stage: the same database, with
// ADMIN_EMAILS changed.
export function seam(
  send?: (mail: Mail) => Effect.Effect<void>,
  config: Partial<AuthConfig> = {},
  deployed: {
    readonly database?: DatabaseSync
    readonly adminEmails?: string
  } = {}
) {
  vi.stubGlobal("fetch", siteverify)
  const database = deployed.database ?? new DatabaseSync(":memory:")
  if (deployed.database === undefined) replayMigrations(database)
  const mails: Array<Mail> = []
  const mailer = Layer.succeed(Mailer, {
    send: send ?? ((mail) => Effect.sync(() => void mails.push(mail))),
  })
  const layer = Auth.make({
    database,
    baseURL: BASE_URL,
    secret: "handler-test-secret-0123456789abcdef0123456789",
    validateSchema: true,
    turnstileSecretKey: TURNSTILE_SECRET,
    ...config,
  }).pipe(
    Layer.provideMerge(Accounts.make(database)),
    Layer.provideMerge(
      Layer.succeed(
        AdminEmails,
        AdminEmails.from(deployed.adminEmails ?? ADMIN_EMAILS)
      )
    ),
    Layer.provide(mailer)
  )
  return { layer, mails, database }
}

// Every request comes from one client IP with a solved Turnstile, unless the
// test's own headers say otherwise.
const CLIENT_IP = "203.0.113.7"

export const send = Effect.fnUntraced(function* (
  path: string,
  init?: RequestInit
) {
  const auth = yield* Auth
  const headers = new Headers({
    [CLIENT_IP_HEADER]: CLIENT_IP,
    "x-captcha-response": SOLVED_TURNSTILE,
  })
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
  return yield* auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, { ...init, headers })
  )
})

export const post = (
  path: string,
  body: unknown,
  headers?: Record<string, string>
) =>
  send(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

export const signUp = (
  email: string,
  password = "correct horse",
  headers?: Record<string, string>
) =>
  post(
    "/sign-up/email",
    { email, password, name: "Ayu", callbackURL: "/" },
    headers
  )

// The Cookie header a browser would send back after this response.
export const cookiesFrom = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ")

// The Cookie header after a response: a cookie set twice keeps its last
// value, and a cookie the response clears is dropped.
export const cookiesAfter = (cookie: string, response: Response) => {
  const jar = new Map(
    cookie
      .split("; ")
      .filter((pair) => pair !== "")
      .map((pair) => pair.split("=", 2) as [string, string])
  )
  for (const set of response.headers.getSetCookie()) {
    const pair = set.split(";")[0] ?? ""
    const at = pair.indexOf("=")
    const name = pair.slice(0, at)
    const value = pair.slice(at + 1)
    if (value === "" || /max-age=0/i.test(set)) jar.delete(name)
    else jar.set(name, value)
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ")
}

export const sessionOf = (cookie: string) =>
  send("/get-session?disableCookieCache=true", { headers: { cookie } }).pipe(
    Effect.flatMap((response) =>
      Effect.promise(
        () =>
          response.json() as Promise<{
            user: {
              name: string
              email: string
              emailVerified: boolean
              role: string
            }
          } | null>
      )
    )
  )

// The path under /api/auth of the link in a mail.
export const linkIn = (mail: Mail | undefined) => {
  const url = mail?.text.match(/https?:\/\/\S+/)?.[0] ?? ""
  return url.slice(`${BASE_URL}/api/auth`.length)
}
