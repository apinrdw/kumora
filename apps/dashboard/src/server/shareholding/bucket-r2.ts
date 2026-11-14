// ArchiveBucket over the R2 binding. Kept apart from bucket.ts: the tests'
// typecheck has no Workers types, so it never imports this module.
import { WorkerEnv } from "@workspace/server"
import { Effect, Layer } from "effect"

import { ArchiveBucket, BucketError, type ListedObject } from "./bucket.ts"

export const archiveBucketR2 = Layer.effect(
  ArchiveBucket,
  Effect.gen(function* () {
    const bucket = (yield* WorkerEnv).SHAREHOLDING_ARCHIVE_BUCKET
    const attempt = <A>(
      operation: string,
      key: string,
      run: () => PromiseLike<A>
    ) =>
      Effect.tryPromise({
        try: () => run(),
        catch: (cause) => new BucketError({ operation, key, cause }),
      })
    const list = Effect.fnUntraced(function* (prefix: string) {
      const objects: Array<ListedObject> = []
      let cursor: string | undefined
      do {
        const page = yield* attempt("list", prefix, () =>
          bucket.list({ prefix, cursor, include: ["customMetadata"] })
        )
        for (const object of page.objects)
          objects.push({
            key: object.key,
            size: object.size,
            customMetadata: object.customMetadata ?? {},
          })
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor !== undefined)
      return objects
    })
    return ArchiveBucket.of({
      list,
      exists: (key) =>
        attempt("head", key, () => bucket.head(key)).pipe(
          Effect.map((object) => object !== null)
        ),
      get: (key) =>
        attempt("get", key, () => bucket.get(key)).pipe(
          Effect.flatMap((object) =>
            object === null
              ? Effect.succeed(undefined)
              : attempt("get", key, () => object.text())
          )
        ),
      put: (key, body, { contentType, customMetadata }) =>
        attempt("put", key, () =>
          bucket.put(key, body, {
            httpMetadata: { contentType },
            customMetadata: customMetadata ?? {},
          })
        ).pipe(Effect.asVoid),
    })
  })
)
