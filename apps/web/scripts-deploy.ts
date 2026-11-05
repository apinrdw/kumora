// SCRATCH: Workers Builds deploy/preview command for apinrdw/kumora#20.
// Usage (Workers Builds, root apps/web): cd ../.. && pnpm install --frozen-lockfile && cd apps/web && bun scripts-deploy.ts
import { mintAccessToken } from "@alchemy.run/infisical"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

const branch = process.env.WORKERS_CI_BRANCH ?? ""
const slug = (b: string) => {
  const hash = new Bun.CryptoHasher("sha256").update(b).digest("hex").slice(0, 6)
  return `${b.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30)}-${hash}`
}
const stage = branch === "main" ? "production" : branch === "staging" ? "staging" : slug(branch)

// Diagnostics the ticket asks for. Never prints values.
console.log("[probe] WORKERS_CI_BRANCH =", JSON.stringify(branch))
console.log("[probe] stage =", stage)
console.log("[probe] CI =", JSON.stringify(process.env.CI))
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_API_TOKEN", "WORKERS_CI", "WORKERS_CI_COMMIT_SHA", "WORKERS_CI_BUILD_UUID", "BUN_VERSION"]) {
  console.log(`[probe] ${k} set:`, process.env[k] !== undefined)
}
console.log("[probe] env keys:", Object.keys(process.env).sort().join(","))

const creds = await Effect.runPromise(
  mintAccessToken({
    clientId: process.env.INFISICAL_CLIENT_ID!,
    clientSecret: process.env.INFISICAL_CLIENT_SECRET!,
  })
)

// Drop the build's own Cloudflare token so Infisical's scoped one wins.
const env: Record<string, string | undefined> = { ...process.env, ALCHEMY_STAGE: stage }
delete env.CLOUDFLARE_API_TOKEN
env.INFISICAL_TOKEN = Redacted.value(creds.token)

const proc = Bun.spawn(["bun", "alchemy", "deploy", "--stage", stage, "--yes"], { env, stdout: "inherit", stderr: "inherit" })
process.exit(await proc.exited)
