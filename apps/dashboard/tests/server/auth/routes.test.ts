import { assert, describe, it } from "@effect/vitest"
import { betterAuth } from "better-auth"
import { DatabaseSync } from "node:sqlite"

import { authOptions } from "@/server/auth/options"

import { replayMigrations } from "../../../scripts/auth-schema.ts"
import { BASE_URL } from "./seam.ts"

// The routes the dashboard offers: what its forms, menus and links call, the
// links it mails, and Google's return. Every other route Better Auth mounts
// is in DISABLED_ROUTES (options.ts), so a Better Auth bump that mounts a new
// one fails here until it is placed.
const OFFERED = [
  "GET /delete-user/callback",
  // Where Better Auth's OAuth callback sends a request it can't read.
  "GET /error",
  "GET /reset-password/:token",
  "GET /verify-email",
  "GET|POST /callback/:id",
  "GET|POST /get-session",
  "POST /admin/ban-user",
  "POST /admin/impersonate-user",
  "POST /admin/revoke-user-sessions",
  "POST /admin/set-role",
  "POST /admin/stop-impersonating",
  "POST /admin/unban-user",
  "POST /change-email",
  "POST /change-password",
  "POST /delete-user",
  "POST /request-password-reset",
  "POST /reset-password",
  "POST /revoke-other-sessions",
  "POST /revoke-session",
  "POST /send-verification-email",
  "POST /sign-in/email",
  "POST /sign-in/social",
  "POST /sign-out",
  "POST /sign-up/email",
  "POST /update-user",
]

const noop = async () => {}

interface Endpoint {
  readonly path?: string
  readonly options?: {
    readonly method?: string | ReadonlyArray<string>
    readonly metadata?: {
      readonly SERVER_ONLY?: boolean
      readonly [key: string]: unknown
    }
  }
}

// `METHOD /path` of every endpoint the router mounts: better-call skips one
// with no path or marked SERVER_ONLY (router.mjs).
const mountedRoutes = () => {
  const database = new DatabaseSync(":memory:")
  replayMigrations(database)
  const options = authOptions({
    database,
    baseURL: BASE_URL,
    secret: "routes-test-secret-0123456789abcdef0123456789",
    validateSchema: false,
    sendVerificationEmail: noop,
    sendResetPassword: noop,
    sendSetPassword: noop,
    verifyByPasswordReset: noop,
    turnstileSecretKey: "routes-test-turnstile",
    sendChangeEmailConfirmation: noop,
    sendNewEmailVerification: noop,
    sendDeleteAccountLink: noop,
    grantAdmin: noop,
    authorizeOwnAction: noop,
    authorizeEmailChange: noop,
    authorizeAdminAction: noop,
  })
  const api: Record<string, Endpoint> = betterAuth(options).api
  const mounted = Object.values(api).flatMap((endpoint) => {
    const { path, options: route } = endpoint
    if (path === undefined || route?.metadata?.SERVER_ONLY) return []
    const method =
      typeof route?.method === "string"
        ? route.method
        : route?.method?.join("|")
    return [{ path, route: `${method} ${path}` }]
  })
  return { mounted, disabled: options.disabledPaths }
}

describe("the routes Better Auth mounts", () => {
  it("are the offered ones and the disabled ones, nothing else", () => {
    const { mounted, disabled } = mountedRoutes()
    const offered = mounted
      .filter(({ path }) => !disabled.includes(path))
      .map(({ route }) => route)
    assert.deepStrictEqual(offered.sort(), [...OFFERED].sort())
  })

  it("include every disabled path, so none is a typo", () => {
    const { mounted, disabled } = mountedRoutes()
    assert.includeMembers(
      mounted.map(({ path }) => path),
      [...disabled]
    )
  })
})
