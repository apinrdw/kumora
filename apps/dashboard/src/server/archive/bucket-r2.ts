// ArchiveBucket over an archive's R2 binding. Kept apart from bucket.ts, so
// code that only uses the bucket never loads it.
import { WorkerEnv, type WorkerEnvShape } from "@workspace/server"
import { Effect, Layer } from "effect"

import {
  ArchiveBucket,
  BucketError,
  checkListed,
  type ListedObject,
  type ListOptions,
} from "./bucket.ts"

// The binding's members this layer uses. The admin pages' server functions
// provide this layer, so the tests' typecheck, which has no Workers types,
// reaches this module through the route tree: R2Bucket meets this shape under
// Workers types, and the binding's type checks against it without them.
interface R2Binding {
  readonly list: (options: {
    readonly prefix: string
    readonly cursor?: string
    readonly startAfter?: string
    readonly include: Array<"customMetadata">
  }) => Promise<{
    readonly objects: ReadonlyArray<{
      readonly key: string
      readonly size: number
      readonly uploaded: Date
      readonly customMetadata?: Record<string, string>
    }>
    readonly truncated: boolean
    readonly cursor?: string
  }>
  readonly head: (key: string) => Promise<unknown>
  readonly get: (key: string) => Promise<{
    readonly httpEtag: string
    readonly uploaded: Date
    readonly text: () => Promise<string>
    readonly arrayBuffer: () => Promise<ArrayBuffer>
  } | null>
  // Null when `onlyIf` doesn't hold.
  readonly put: (
    key: string,
    body: Uint8Array | string,
    options: {
      readonly httpMetadata: { readonly contentType: string }
      readonly customMetadata: Record<string, string>
      readonly onlyIf?: Headers
    }
  ) => Promise<unknown>
}

// The archive bucket over the R2 binding `binding` picks from the Worker's
// env, such as `(env) => env.SHAREHOLDING_ARCHIVE_BUCKET`.
export const r2ArchiveBucket = (binding: (env: WorkerEnvShape) => R2Binding) =>
  Layer.effect(
    ArchiveBucket,
    Effect.gen(function* () {
      const bucket = binding(yield* WorkerEnv)
      const attempt = <A>(
        operation: string,
        key: string,
        run: () => PromiseLike<A>
      ) =>
        Effect.tryPromise({
          try: () => run(),
          catch: (cause) => new BucketError({ operation, key, cause }),
        })
      const list = Effect.fnUntraced(function* (
        prefix: string,
        { startAfter }: ListOptions = {}
      ) {
        const objects: Array<ListedObject> = []
        let cursor: string | undefined
        do {
          const page = yield* attempt("list", prefix, () =>
            bucket.list({
              prefix,
              cursor,
              ...(startAfter === undefined ? {} : { startAfter }),
              include: ["customMetadata"],
            })
          )
          for (const object of page.objects)
            objects.push({
              key: object.key,
              size: object.size,
              uploaded: object.uploaded,
              customMetadata: object.customMetadata ?? {},
            })
          yield* checkListed(prefix, objects.length)
          cursor = page.truncated ? page.cursor : undefined
        } while (cursor !== undefined)
        return objects
      })
      // The object at `key` read by `read`, or undefined when there is none.
      const readObject = <A>(
        key: string,
        read: (
          object: NonNullable<Awaited<ReturnType<R2Binding["get"]>>>
        ) => PromiseLike<A>
      ) =>
        attempt("get", key, () => bucket.get(key)).pipe(
          Effect.flatMap((object) =>
            object === null
              ? Effect.succeed(undefined)
              : attempt("get", key, () => read(object))
          )
        )
      return ArchiveBucket.of({
        list,
        exists: (key) =>
          attempt("head", key, () => bucket.head(key)).pipe(
            Effect.map((object) => object !== null)
          ),
        get: (key) =>
          readObject(key, (object) =>
            object.text().then((body) => ({
              body,
              etag: object.httpEtag,
              uploaded: object.uploaded,
            }))
          ),
        getBytes: (key) =>
          readObject(key, (object) =>
            object.arrayBuffer().then((buffer) => new Uint8Array(buffer))
          ),
        put: (key, body, { contentType, customMetadata }) =>
          attempt("put", key, () =>
            bucket.put(key, body, {
              httpMetadata: { contentType },
              customMetadata: customMetadata ?? {},
            })
          ).pipe(Effect.asVoid),
        // R2 checks the condition and writes in one step, and answers null
        // when it doesn't hold.
        putIfUnchanged: (key, body, { contentType, customMetadata }, etag) =>
          attempt("put", key, () =>
            bucket.put(key, body, {
              httpMetadata: { contentType },
              customMetadata: customMetadata ?? {},
              onlyIf: new Headers(
                etag === undefined
                  ? { "if-none-match": "*" }
                  : { "if-match": etag }
              ),
            })
          ).pipe(Effect.map((object) => object !== null)),
      })
    })
  )
