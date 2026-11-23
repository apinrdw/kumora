// The one module that writes process.env. A ConfigProvider can't do this:
// `plan` rebuilds config from process.env, and Infisical reads its token
// straight from there. See apinrdw/kumora#107.
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

const restore = Effect.fnUntraced(function* (
  name: string,
  value: string | undefined
) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
})

// Swaps the deploy tokens until the scope closes, then restores both. The
// scope must cover `apply`: the Vite build child inherits the live env.
export const tokenSwap = Effect.fnUntraced(function* (
  token: Redacted.Redacted<string>
) {
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const before = {
        cloudflare: process.env.CLOUDFLARE_API_TOKEN,
        infisical: process.env.INFISICAL_TOKEN,
      }
      // Drop the token Workers Builds injects. The process
      // environment is alchemy's last secret provider, so it would override
      // Infisical's scoped token, which alone has the Secrets Store access
      // Cloudflare.state() needs. See apinrdw/kumora#20.
      delete process.env.CLOUDFLARE_API_TOKEN
      process.env.INFISICAL_TOKEN = Redacted.value(token)
      return before
    }),
    (before) =>
      Effect.andThen(
        restore("CLOUDFLARE_API_TOKEN", before.cloudflare),
        restore("INFISICAL_TOKEN", before.infisical)
      )
  )
})
