// On Production, Cloudflare matches zone routes against the whole URL, query
// included, so `kumora.pusat.ai/dashboard?tab=brokers` misses both dashboard
// routes and reaches web's `/*`.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"

import { bareDashboardRedirect } from "@/server/dashboard-redirect"

const PRODUCTION = "https://kumora.pusat.ai"

describe("web on the dashboard's bare base path", () => {
  it.effect.each([
    ["/dashboard?tab=brokers", `${PRODUCTION}/dashboard/?tab=brokers`],
    ["/dashboard", `${PRODUCTION}/dashboard/`],
  ] as const)("301s %s to %s", ([path, location]) =>
    Effect.gen(function* () {
      const redirect = yield* bareDashboardRedirect(
        new Request(`${PRODUCTION}${path}`)
      )
      assert.isTrue(Option.isSome(redirect))
      const response = Option.getOrThrow(redirect)
      assert.strictEqual(response.status, 301)
      assert.strictEqual(response.headers.get("Location"), location)
    })
  )

  it.effect.each(["/", "/dashboards-guide?x=1", "/dashboard/stocks", "/probe"])(
    "leaves %s to web",
    (path) =>
      Effect.gen(function* () {
        const redirect = yield* bareDashboardRedirect(
          new Request(`${PRODUCTION}${path}`)
        )
        assert.isTrue(Option.isNone(redirect))
      })
  )
})
