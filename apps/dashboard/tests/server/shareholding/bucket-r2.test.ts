import { assert, describe, it } from "@effect/vitest"
import { WorkerEnv } from "@workspace/server"
import { Effect, Layer, Result } from "effect"

import { ArchiveBucket } from "@/server/shareholding/bucket"
import { archiveBucketR2 } from "@/server/shareholding/bucket-r2"

// The largest listing the bucket accepts.
const MAX_LISTED = 10_000

// An R2 binding that lists `count` keys under reports/, 1000 to a page as R2
// does.
const listingOf = (count: number) => {
  const keys = Array.from(
    { length: count },
    (_, index) => `reports/above-5/${String(index).padStart(6, "0")}.json`
  )
  const binding = {
    list: ({ prefix, cursor }: { prefix: string; cursor?: string }) =>
      Effect.runPromise(
        Effect.sync(() => {
          const matching = keys.filter((key) => key.startsWith(prefix))
          const from = Number(cursor ?? 0)
          const page = matching.slice(from, from + 1000)
          const truncated = from + 1000 < matching.length
          return {
            objects: page.map((key) => ({
              key,
              size: 1,
              uploaded: new Date(0),
              customMetadata: {},
            })),
            truncated,
            ...(truncated ? { cursor: String(from + 1000) } : {}),
          }
        })
      ),
  }
  return archiveBucketR2.pipe(
    Layer.provide(
      Layer.succeed(WorkerEnv)({
        SHAREHOLDING_ARCHIVE_BUCKET: binding,
      } as unknown as WorkerEnv["Service"])
    )
  )
}

const list = (prefix: string) =>
  Effect.flatMap(ArchiveBucket, (bucket) => bucket.list(prefix))

describe("the R2 archive bucket", () => {
  it.effect("lists every page of the largest listing it accepts", () =>
    Effect.gen(function* () {
      const objects = yield* list("reports/").pipe(
        Effect.provide(listingOf(MAX_LISTED))
      )
      assert.strictEqual(objects.length, MAX_LISTED)
      assert.strictEqual(objects.at(-1)?.key, "reports/above-5/009999.json")
    })
  )

  it.effect("fails a listing past the largest it accepts", () =>
    Effect.gen(function* () {
      const listed = yield* Effect.result(
        list("reports/").pipe(Effect.provide(listingOf(MAX_LISTED + 1)))
      )
      assert.isTrue(Result.isFailure(listed), "the listing failed")
      if (Result.isFailure(listed))
        assert.include(String(listed.failure.cause), String(MAX_LISTED))
    })
  )
})
