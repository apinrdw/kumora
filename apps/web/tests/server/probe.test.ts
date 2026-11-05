import { assert, describe, it } from "@effect/vitest"
import { WorkerEnv } from "@workspace/server"
import { Effect, Layer } from "effect"

import { probe } from "@/server/probe"

// The probe never touches static assets; a call here is a bug in the test.
const ASSETS = {
  fetch: () => Promise.reject(new Error("probe fetched ASSETS")),
  connect: () => {
    throw new Error("probe connected to ASSETS")
  },
}

const withSecret = (secret: string) =>
  Effect.provide(
    Layer.succeed(WorkerEnv, { ASSETS, DEPLOY_PROBE_SECRET: secret })
  )

const answer = (secret: string, url = "https://kumora.test/probe?x=1") =>
  probe(new Request(url)).pipe(withSecret(secret))

const body = (response: Response) => Effect.promise(() => response.text())

describe("probe", () => {
  it.effect("answers the first 12 hex digits of the secret's SHA-256", () =>
    Effect.gen(function* () {
      // Published test vector: SHA-256("abc") starts ba7816bf8f01.
      const response = yield* answer("abc")
      assert.deepStrictEqual(JSON.parse(yield* body(response)), {
        origin: "https://kumora.test",
        secretPresent: true,
        secretSha256Prefix: "ba7816bf8f01",
      })
    })
  )

  it.effect("never exposes the secret", () =>
    Effect.gen(function* () {
      const secret = "a-very-distinctive-secret"
      assert.notInclude(yield* body(yield* answer(secret)), secret)
    })
  )

  it.effect("reports an empty secret as absent", () =>
    Effect.gen(function* () {
      const parsed = JSON.parse(yield* body(yield* answer("")))
      assert.strictEqual(parsed.secretPresent, false)
      assert.strictEqual(parsed.secretSha256Prefix, null)
    })
  )

  it.effect(
    "forbids caching, so a stage check never reads a stale answer",
    () =>
      Effect.gen(function* () {
        const response = yield* answer("abc")
        assert.strictEqual(response.headers.get("cache-control"), "no-store")
      })
  )
})
