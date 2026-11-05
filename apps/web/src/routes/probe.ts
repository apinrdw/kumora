// Proves an Infisical secret reaches the Worker on each stage: the runbook's
// stage check curls it. Answers a hash prefix, never the secret. Remove this
// route and DEPLOY_PROBE_SECRET when a real secret replaces it.
import { createFileRoute } from "@tanstack/react-router"
import { WorkerEnv, runServerEffect } from "@workspace/server"
import { Effect } from "effect"

const SHA256_PREFIX_LENGTH = 12

const sha256Prefix = (value: string) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  ).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, SHA256_PREFIX_LENGTH)
    )
  )

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
