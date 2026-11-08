// How long each mailed link works. Better Auth enforces it
// (server/auth/options.ts); the mails (server/auth/callbacks.ts) and the
// screens say it.
export const LINK_HOURS = {
  // Verification links: after sign-up, and both of a change of email.
  verify: 24,
  // Reset and set-password links.
  reset: 1,
  delete: 1,
} as const

export type LinkKind = keyof typeof LINK_HOURS

/** "1 hour" or "24 hours", for the copy that names a link's lifetime. */
export const linkLifetime = (kind: LinkKind) =>
  LINK_HOURS[kind] === 1 ? "1 hour" : `${LINK_HOURS[kind]} hours`
