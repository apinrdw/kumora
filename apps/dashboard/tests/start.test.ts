// A loader's typed HTTP error survives SSR dehydration: the dashboard's Start
// instance registers the adapter that brings it back as that error, so an
// errorComponent reads the same tag after hydration as on the first paint.
import { assert, describe, it } from "@effect/vitest"
import { BadRequest, Forbidden } from "@workspace/server"
import { Effect } from "effect"

import { startInstance } from "@/start"

const adapters = Effect.gen(function* () {
  const options = startInstance.getOptions()
  const resolved =
    "then" in options ? yield* Effect.promise(() => options) : options
  return resolved.serializationAdapters ?? []
})

describe("the dashboard's Start instance", () => {
  it.effect.each([
    new Forbidden({ message: "not yours" }),
    new BadRequest({ message: "bad sort" }),
  ])("brings a loader's $_tag back as that error after dehydration", (error) =>
    Effect.gen(function* () {
      const adapter = (yield* adapters).find((each) => each.test(error))
      assert.isDefined(adapter)
      const revived = adapter!.fromSerializable(
        JSON.parse(JSON.stringify(adapter!.toSerializable(error)))
      )
      assert.strictEqual(revived.constructor, error.constructor)
      assert.deepStrictEqual(revived, error)
    })
  )
})
