// Proves an Infisical secret reaches the Worker on each stage: the runbook's
// stage check curls it. Answers a hash prefix, never the secret. Remove this
// route and DEPLOY_PROBE_SECRET when a real secret replaces it.
import { createFileRoute } from "@tanstack/react-router"
import { WorkerEnv, runServerEffect } from "@workspace/server"
import { Effect } from "effect"

// docs/runbooks/deploy.md, "Checking a stage", compares this many hex digits.
const SHA256_PREFIX_LENGTH = 12

const sha256Prefix = Effect.fnUntraced(function* (value: string) {
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  )
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  )
    .join("")
    .slice(0, SHA256_PREFIX_LENGTH)
})

export const Route = createFileRoute("/probe")({
  server: {
    handlers: {
      GET: ({ request }) =>
        runServerEffect(
          Effect.gen(function* () {
            const secret = (yield* WorkerEnv).DEPLOY_PROBE_SECRET
            return Response.json(
              {
                origin: new URL(request.url).origin,
                secretPresent: Boolean(secret),
                secretSha256Prefix: secret ? yield* sha256Prefix(secret) : null,
              },
              { headers: { "cache-control": "no-store" } }
            )
          })
        ),
    },
  },
})
