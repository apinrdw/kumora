import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"

import { settingsFromForm } from "../src/options/form.ts"

const extraUrlOf = (extraUrl: string) =>
  Effect.map(
    settingsFromForm({ productionToken: "", extraUrl, extraToken: "token" }),
    (settings) => settings.extra?.url
  )

describe("the options form's extra target", () => {
  it.effect("keeps the path of a dashboard served under one", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* extraUrlOf(
          "https://kumora-dashboard-staging.kumora.workers.dev/dashboard"
        ),
        "https://kumora-dashboard-staging.kumora.workers.dev/dashboard"
      )
    })
  )

  it.effect("drops a trailing slash, a query and a fragment", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* extraUrlOf(" https://staging.example/dashboard/?tab=1#top "),
        "https://staging.example/dashboard"
      )
      assert.strictEqual(
        yield* extraUrlOf("http://localhost:3001/"),
        "http://localhost:3001"
      )
    })
  )

  it.effect("refuses a URL that isn't http(s)", () =>
    Effect.gen(function* () {
      for (const url of ["ftp://staging.example/dashboard", "staging.example"])
        assert.isTrue(Exit.isFailure(yield* Effect.exit(extraUrlOf(url))))
    })
  )
})
