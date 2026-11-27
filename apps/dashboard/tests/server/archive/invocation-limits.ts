// One Worker invocation's limits on the calls it makes to its stores, as
// Cloudflare enforces them on Workers Paid
// (https://developers.cloudflare.com/d1/platform/limits/,
// https://developers.cloudflare.com/workers/platform/limits/): D1 counts each
// `batch` as one query, at most 1,000, and every D1 and R2 call is a
// subrequest, at most 10,000, a listing one per page of 1,000 keys. A layer
// from `layer` is one invocation: each `Effect.provide` of it counts afresh,
// and every call past a limit fails, as Cloudflare's do. `exceeded` names
// each limit any invocation passed.
import { Effect, Layer } from "effect"

import { ArchiveDb, ArchiveDbError } from "@/server/archive/archive-db"
import { ArchiveBucket, BucketError } from "@/server/archive/bucket"

const D1_QUERIES = 1_000
const SUBREQUESTS = 10_000
const LISTED_PER_PAGE = 1_000

const TOO_MANY = "Too many API requests by single Worker invocation"

export const invocationLimits = (stores: {
  readonly db: { readonly layer: Layer.Layer<ArchiveDb> }
  readonly bucket: { readonly layer: Layer.Layer<ArchiveBucket> }
}) => {
  const exceeded: Array<string> = []
  const layer = Layer.unwrap(
    Effect.sync(() => {
      let queries = 0
      let subrequests = 0
      // Whether one more call of `count` subrequests passes a limit.
      const over = (count: number, query: boolean) => {
        subrequests += count
        if (query) queries += 1
        const passed = [
          ...(queries > D1_QUERIES ? ["D1 queries"] : []),
          ...(subrequests > SUBREQUESTS ? ["subrequests"] : []),
        ]
        exceeded.push(...passed)
        return passed.length > 0
      }
      const bucketFailure = (operation: string, key: string) =>
        new BucketError({ operation, key, cause: new Error(TOO_MANY) })
      return Layer.mergeAll(
        Layer.effect(
          ArchiveDb,
          Effect.map(Effect.service(ArchiveDb), (inner) =>
            ArchiveDb.of({
              batch: (statements) =>
                over(1, true)
                  ? Effect.fail(
                      new ArchiveDbError({ cause: new Error(TOO_MANY) })
                    )
                  : inner.batch(statements),
            })
          )
        ).pipe(Layer.provide(stores.db.layer)),
        Layer.effect(
          ArchiveBucket,
          Effect.map(Effect.service(ArchiveBucket), (inner) =>
            ArchiveBucket.of({
              ...inner,
              list: (prefix, options) =>
                Effect.flatMap(inner.list(prefix, options), (listed) =>
                  over(
                    Math.max(1, Math.ceil(listed.length / LISTED_PER_PAGE)),
                    false
                  )
                    ? Effect.fail(bucketFailure("list", prefix))
                    : Effect.succeed(listed)
                ),
              exists: (key) =>
                over(1, false)
                  ? Effect.fail(bucketFailure("exists", key))
                  : inner.exists(key),
              size: (key) =>
                over(1, false)
                  ? Effect.fail(bucketFailure("size", key))
                  : inner.size(key),
              get: (key) =>
                over(1, false)
                  ? Effect.fail(bucketFailure("get", key))
                  : inner.get(key),
              getBytes: (key) =>
                over(1, false)
                  ? Effect.fail(bucketFailure("getBytes", key))
                  : inner.getBytes(key),
              put: (key, body, options) =>
                over(1, false)
                  ? Effect.fail(bucketFailure("put", key))
                  : inner.put(key, body, options),
            })
          )
        ).pipe(Layer.provide(stores.bucket.layer))
      )
    })
  )
  return { layer, exceeded }
}
