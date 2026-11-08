import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Redacted from "effect/Redacted"

import { tokenSwap } from "../src/token-swap.ts"

const tokens = () => ({
  cloudflare: process.env.CLOUDFLARE_API_TOKEN,
  infisical: process.env.INFISICAL_TOKEN,
})

// Sets both variables for one test and puts the real values back after it.
const withEnv = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const before = tokens()
      process.env.CLOUDFLARE_API_TOKEN = "workers-builds-token"
      process.env.INFISICAL_TOKEN = "stale-infisical-token"
      return before
    }),
    () => effect,
    (before) =>
      Effect.sync(() => {
        for (const [name, value] of [
          ["CLOUDFLARE_API_TOKEN", before.cloudflare],
          ["INFISICAL_TOKEN", before.infisical],
        ] as const) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      })
  )

const minted = Redacted.make("minted-token")

describe("tokenSwap", () => {
  it.effect("drops the Cloudflare token and sets the minted one inside", () =>
    withEnv(
      Effect.gen(function* () {
        const inside = yield* Effect.scoped(
          Effect.andThen(
            tokenSwap(minted),
            Effect.sync(() => ({
              ...tokens(),
              cloudflareSet: "CLOUDFLARE_API_TOKEN" in process.env,
            }))
          )
        )
        assert.deepStrictEqual(inside, {
          cloudflare: undefined,
          infisical: "minted-token",
          cloudflareSet: false,
        })
      })
    )
  )

  it.effect("restores both variables when the scope closes", () =>
    withEnv(
      Effect.gen(function* () {
        yield* Effect.scoped(tokenSwap(minted))
        assert.deepStrictEqual(tokens(), {
          cloudflare: "workers-builds-token",
          infisical: "stale-infisical-token",
        })
      })
    )
  )

  it.effect("restores both variables when the work inside fails", () =>
    withEnv(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.scoped(Effect.andThen(tokenSwap(minted), Effect.fail("boom")))
        )
        assert.isTrue(Exit.isFailure(exit))
        assert.deepStrictEqual(tokens(), {
          cloudflare: "workers-builds-token",
          infisical: "stale-infisical-token",
        })
      })
    )
  )

  it.effect("leaves a variable that was unset unset", () =>
    withEnv(
      Effect.gen(function* () {
        delete process.env.INFISICAL_TOKEN
        yield* Effect.scoped(tokenSwap(minted))
        assert.isFalse("INFISICAL_TOKEN" in process.env)
      })
    )
  )
})
