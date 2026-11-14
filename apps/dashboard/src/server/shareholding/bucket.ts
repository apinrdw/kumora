// The shareholding archive bucket (SHAREHOLDING_ARCHIVE_BUCKET), as the
// archive run uses it. bucket-r2.ts adapts the R2 binding; tests provide an
// in-memory one.
import { Context, Effect, Schema } from "effect"

export class BucketError extends Schema.TaggedError<BucketError>()(
  "BucketError",
  { operation: Schema.String, key: Schema.String, cause: Schema.Defect() }
) {}

export interface ListedObject {
  readonly key: string
  readonly size: number
  // When R2 last wrote the object.
  readonly uploaded: Date
  readonly customMetadata: Readonly<Record<string, string>>
}

// The most objects a listing returns; past it, the listing fails. Today
// reports/ holds ~300 objects (~150 files and their records), growing by ~4 a
// day, and runs/ is read 30 days at a time (history.ts).
// Decision: 10,000, about six years of reports/ at that rate. A listing is
// held whole in a Worker's 128 MB, and `plan` hands what it gathers on as a
// step result of at most 1 MiB; failing here says the layout needs rethinking
// before either gives out. See apinrdw/kumora#303.
export const MAX_LISTED_OBJECTS = 10_000

// Fails a listing of `prefix` that has passed MAX_LISTED_OBJECTS.
export const checkListed = Effect.fnUntraced(function* (
  prefix: string,
  count: number
) {
  if (count > MAX_LISTED_OBJECTS)
    return yield* new BucketError({
      operation: "list",
      key: prefix,
      cause: new Error(
        `More than ${MAX_LISTED_OBJECTS} objects under ${prefix}`
      ),
    })
})

export interface ListOptions {
  // Only keys after this one.
  readonly startAfter?: string
}

// An object as `get` reads it.
interface StoredObject {
  readonly body: string
  // What `putIfUnchanged` compares.
  readonly etag: string
  readonly uploaded: Date
}

export interface PutOptions {
  readonly contentType: string
  readonly customMetadata?: Readonly<Record<string, string>>
}

export class ArchiveBucket extends Context.Service<
  ArchiveBucket,
  {
    // Every object under `prefix`, with its custom metadata, across pages,
    // in key order. Fails past MAX_LISTED_OBJECTS.
    readonly list: (
      prefix: string,
      options?: ListOptions
    ) => Effect.Effect<ReadonlyArray<ListedObject>, BucketError>
    readonly exists: (key: string) => Effect.Effect<boolean, BucketError>
    // Undefined when there is no object at `key`.
    readonly get: (
      key: string
    ) => Effect.Effect<StoredObject | undefined, BucketError>
    readonly put: (
      key: string,
      body: Uint8Array | string,
      options: PutOptions
    ) => Effect.Effect<void, BucketError>
    // Writes only while the object's ETag is still `etag`, or, with `etag`
    // undefined, while there is no object; in one step, so of two writers
    // that read the same ETag, one writes. Whether it wrote.
    readonly putIfUnchanged: (
      key: string,
      body: string,
      options: PutOptions,
      etag: string | undefined
    ) => Effect.Effect<boolean, BucketError>
  }
>()("dashboard/shareholding/ArchiveBucket") {}

export const putJson = Effect.fnUntraced(function* (
  key: string,
  value: unknown
) {
  yield* (yield* ArchiveBucket).put(key, JSON.stringify(value), {
    contentType: "application/json",
  })
})
