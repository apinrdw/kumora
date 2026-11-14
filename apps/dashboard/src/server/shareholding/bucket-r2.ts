// ArchiveBucket over the R2 binding. Kept apart from bucket.ts, so a test
// never loads it.
import { WorkerEnv } from "@workspace/server"
import { Effect, Layer } from "effect"

import { ArchiveBucket, BucketError, type ListedObject } from "./bucket.ts"

// The binding's members this layer uses. The admin page's server functions
// provide this layer, so the tests' typecheck, which has no Workers types,
// reaches this module through the route tree: R2Bucket meets this shape under
// Workers types, and the binding's type checks against it without them.
interface R2Binding {
  readonly list: (options: {
    readonly prefix: string
    readonly cursor?: string
    readonly include: Array<"customMetadata">
  }) => Promise<{
    readonly objects: ReadonlyArray<{
      readonly key: string
      readonly size: number
      readonly customMetadata?: Record<string, string>
    }>
    readonly truncated: boolean
    readonly cursor?: string
  }>
  readonly head: (key: string) => Promise<unknown>
  readonly get: (
    key: string
  ) => Promise<{ readonly text: () => Promise<string> } | null>
  readonly put: (
    key: string,
    body: Uint8Array | string,
    options: {
      readonly httpMetadata: { readonly contentType: string }
      readonly customMetadata: Record<string, string>
    }
  ) => Promise<unknown>
}

export const archiveBucketR2 = Layer.effect(
  ArchiveBucket,
  Effect.gen(function* () {
    const bucket: R2Binding = (yield* WorkerEnv).SHAREHOLDING_ARCHIVE_BUCKET
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
