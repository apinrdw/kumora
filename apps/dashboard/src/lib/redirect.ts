import type { FileRoutesByFullPath } from "../routeTree.gen.ts"

const ORIGIN = "http://kumora.invalid"
// An encoded slash or backslash in the path. Better Auth refuses a
// callbackURL holding one (INVALID_CALLBACK_URL), so it goes home here too.
const ENCODED_SEPARATOR = /%2f|%5c/i

/**
 * The `redirect` search value as a path on this origin, or `/`. It is read
 * from the URL, so anything that would leave the origin is dropped.
 */
export function safeRedirect(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/")) return "/"
  const url = URL.parse(raw, ORIGIN)
  if (url === null || url.origin !== ORIGIN) return "/"
  // `/a/..//evil.example` keeps the origin but resolves to the
  // protocol-relative `//evil.example`.
  if (url.pathname.startsWith("//") || ENCODED_SEPARATOR.test(url.pathname))
    return "/"
  return `${url.pathname}${url.search}${url.hash}`
}

// The gate screens: src/routes/sign-in.tsx and src/routes/verify.tsx.
const SIGN_IN_PATH = "/sign-in" satisfies keyof FileRoutesByFullPath
const VERIFY_PATH = "/verify" satisfies keyof FileRoutesByFullPath

/** A gate screen that sends the visitor back to `href` when it's done. */
export const withRedirect = (
  screen: typeof SIGN_IN_PATH | typeof VERIFY_PATH,
  href: string
) => `${screen}?redirect=${encodeURIComponent(href)}`
