// ArchiveBucket over an archive's R2 binding. Kept apart from bucket.ts, so
// code that only uses the bucket never loads it.
import { WorkerEnv, type WorkerEnvShape } from "@workspace/server"
import { Effect, Layer } from "effect"

import {
  ArchiveBucket,
  BucketError,
  checkListed,
  forEachPart,
  type ListedObject,
  type ListOptions,
  PUT_PART_BYTES,
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
  readonly createMultipartUpload: (
    key: string,
    options: {
      readonly httpMetadata: { readonly contentType: string }
      readonly customMetadata: Record<string, string>
    }
  ) => Promise<R2Upload>
}

interface R2UploadedPart {
  readonly partNumber: number
  readonly etag: string
}

interface R2Upload {
  readonly uploadPart: (
    partNumber: number,
    value: Uint8Array
  ) => Promise<R2UploadedPart>
  readonly complete: (parts: Array<R2UploadedPart>) => Promise<unknown>
  readonly abort: () => Promise<void>
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
        putStream: (key, body, { contentType, customMetadata }) => {
          const metadata = {
            httpMetadata: { contentType },
            customMetadata: customMetadata ?? {},
          }
          // Started by the first full part; a body within one part is a
          // put.
          let upload: R2Upload | undefined
          const uploaded: Array<R2UploadedPart> = []
          const uploadPart = Effect.fnUntraced(function* (
            bytes: Uint8Array,
            partNumber: number
          ) {
            const started =
              upload ??
              (yield* attempt("createMultipartUpload", key, () =>
                bucket.createMultipartUpload(key, metadata)
              ))
            upload = started
            uploaded.push(
              yield* attempt("uploadPart", key, () =>
                started.uploadPart(partNumber, bytes)
              )
            )
          })
          return Effect.gen(function* () {
            const { rest, size } = yield* forEachPart(
              body,
              PUT_PART_BYTES,
              uploadPart
            )
            if (upload === undefined) {
              yield* attempt("put", key, () => bucket.put(key, rest, metadata))
              return size
            }
            if (rest.length > 0) yield* uploadPart(rest, uploaded.length + 1)
            const parts = [...uploaded]
            const finished = upload
            yield* attempt("completeMultipartUpload", key, () =>
              finished.complete(parts)
            )
            return size
          }).pipe(
            // A body or write that fails, or a step cut off, aborts the
            // upload, so no part of it is left behind.
            Effect.onError(() => {
              const started = upload
              return started === undefined
                ? Effect.void
                : attempt("abortMultipartUpload", key, () =>
                    started.abort()
                  ).pipe(Effect.ignore)
            })
          )
        },
      })
    })
  )
