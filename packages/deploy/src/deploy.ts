// The Workers Builds deploy and preview command, one connection per app:
//   bun ../../packages/deploy/src/deploy.ts <app>
import { mintAccessToken } from "@alchemy.run/infisical"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Redacted from "effect/Redacted"

import { parseApp, requireEnv, runAlchemy } from "./alchemy-cli.ts"
import { deployTarget } from "./target.ts"

const app = parseApp(process.argv[2])
const { stage } = deployTarget(app, requireEnv("WORKERS_CI_BRANCH"))

const { token } = await Effect.runPromise(
  mintAccessToken({
    clientId: requireEnv("INFISICAL_CLIENT_ID"),
    clientSecret: requireEnv("INFISICAL_CLIENT_SECRET"),
  }).pipe(Effect.provide(FetchHttpClient.layer))
)

const env: NodeJS.ProcessEnv = {
  ...process.env,
  INFISICAL_TOKEN: Redacted.value(token),
}
// Decision: drop the token Workers Builds injects. The process environment is
// alchemy's last secret provider, so it would override Infisical's scoped
// token, which alone has the Secrets Store access Cloudflare.state() needs.
// See apinrdw/kumora#20.
delete env.CLOUDFLARE_API_TOKEN

console.log(`Deploying ${app} to stage ${stage}`)
// Decision: Workers Builds runs two builds of one branch in parallel and the
// state store has no lock, so overlapping deploys of one stage can race. The
// risk is accepted; revisit if overlapping deploys cause trouble. See
// apinrdw/kumora#17.
process.exit(await runAlchemy(app, ["deploy", "--stage", stage], env))
