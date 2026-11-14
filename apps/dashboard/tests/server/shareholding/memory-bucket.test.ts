import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import { ArchiveBucket, MAX_LISTED_OBJECTS } from "@/server/shareholding/bucket"

import { memoryBucket } from "./memory-bucket.ts"

// The fake holds the R2 adapter's listing cap, so a run the tests drive
// fails where a run on R2 would.
const listingOf = (count: number) => {
  const bucket = memoryBucket()
  for (let index = 0; index < count; index++)
    bucket.objects.set(`reports/above-5/${index}.json`, {
      body: "{}",
      contentType: "application/json",
      customMetadata: {},
    })
  return Effect.result(
    Effect.flatMap(ArchiveBucket, (archive) => archive.list("reports/")).pipe(
      Effect.provide(bucket.layer)
    )
  )
}

describe("the memory bucket", () => {
  it.effect("lists the largest listing R2 accepts", () =>
    Effect.gen(function* () {
      const listed = yield* listingOf(MAX_LISTED_OBJECTS)
      assert.isTrue(Result.isSuccess(listed), "the listing succeeded")
      if (Result.isSuccess(listed))
        assert.strictEqual(listed.success.length, MAX_LISTED_OBJECTS)
    })
  )

  it.effect("fails a listing past the largest R2 accepts", () =>
    Effect.gen(function* () {
      const listed = yield* listingOf(MAX_LISTED_OBJECTS + 1)
      assert.isTrue(Result.isFailure(listed), "the listing failed")
      if (Result.isFailure(listed))
        assert.include(String(listed.failure.cause), String(MAX_LISTED_OBJECTS))
    })
  )
})
