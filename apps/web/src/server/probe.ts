// Proves an Infisical secret reaches the Worker on each stage: the runbook's
// stage check curls /probe. Answers a hash prefix, never the secret. Remove this
// module, its route and DEPLOY_PROBE_SECRET when a real secret replaces it.
import { WorkerEnv } from "@workspace/server"
import { Effect } from "effect"

// docs/runbooks/deploy.md, "Checking a stage", compares this many hex digits,
// and scripts/deploy-setup.sh reads this line with sed: keep its shape.
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

export interface ProbeReport {
  readonly origin: string
  readonly secretPresent: boolean
  readonly secretSha256Prefix: string | null
}

// The probe page's data, loaded through getProbeReport.
export const probeReport = Effect.fn("probeReport")(function* (
  request: Request
): Effect.fn.Return<ProbeReport, never, WorkerEnv> {
  const secret = (yield* WorkerEnv).DEPLOY_PROBE_SECRET
  return {
    origin: new URL(request.url).origin,
    secretPresent: Boolean(secret),
    secretSha256Prefix: secret ? yield* sha256Prefix(secret) : null,
  }
})

// The same report as JSON, for curl and the e2e smoke.
export const probe = Effect.fn("probe")(function* (request: Request) {
  return Response.json(yield* probeReport(request), {
    headers: { "cache-control": "no-store" },
  })
})
