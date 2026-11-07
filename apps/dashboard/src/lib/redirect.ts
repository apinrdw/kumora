const ORIGIN = "http://kumora.invalid"

/**
 * The `redirect` search value as a path on this origin, or `/`. It is read
 * from the URL, so anything that would leave the origin is dropped.
 */
export function safeRedirect(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/")) return "/"
  const url = URL.parse(raw, ORIGIN)
  if (url === null || url.origin !== ORIGIN) return "/"
  return `${url.pathname}${url.search}${url.hash}`
}

/** A gate screen that sends the visitor back to `href` when it's done. */
export const withRedirect = (screen: "/sign-in" | "/verify", href: string) =>
  `${screen}?redirect=${encodeURIComponent(href)}`
