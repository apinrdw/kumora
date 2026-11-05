// Proves an Infisical secret reaches the Worker in each Environment, for
// `pnpm verify web`. Answers a hash prefix, never the secret. Remove this route,
// DEPLOY_PROBE_SECRET, and its secrets.required entries when a real secret
// replaces it.
import { createFileRoute } from "@tanstack/react-router"
import { env } from "cloudflare:workers"

// Must equal SHA256_PREFIX_LENGTH in scripts/verify.mts.
const SHA256_PREFIX_LENGTH = 12

// Same digest as sha256Prefix in scripts/verify.mts, which compares the two.
async function sha256Prefix(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  )
    .join("")
    .slice(0, SHA256_PREFIX_LENGTH)
}

export const Route = createFileRoute("/probe")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const secret = env.DEPLOY_PROBE_SECRET
        return Response.json(
          {
            origin: new URL(request.url).origin,
            secretPresent: Boolean(secret),
            secretSha256Prefix: secret ? await sha256Prefix(secret) : null,
          },
          { headers: { "cache-control": "no-store" } }
        )
      },
    },
  },
})
