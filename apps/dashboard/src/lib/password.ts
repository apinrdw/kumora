import { Effect } from "effect"

import type { FileRoutesByFullPath } from "../routeTree.gen.ts"

// Better Auth enforces it (server/auth/options.ts); the sign-up form hints it.
export const MIN_PASSWORD_LENGTH = 8

// The page a reset or set-password link opens: src/routes/reset-password.tsx.
const RESET_PASSWORD_PATH =
  "/reset-password" satisfies keyof FileRoutesByFullPath

/** Where a reset or set-password link lands, returning to `redirect` once the password is set. */
export const resetPasswordPage = (redirect: string) =>
  Effect.sync(
    () => `${RESET_PASSWORD_PATH}?redirect=${encodeURIComponent(redirect)}`
  )
