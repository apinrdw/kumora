// An archive's R2 bucket, as its runs and its admin page use it. Each archive
// has its own bucket, which it provides as this service: bucket-r2.ts adapts
// an R2 binding; tests provide an in-memory one.
import { Context, Effect, Schema, Stream } from "effect"

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

// The most objects a listing returns; past it, the listing fails. On
// 2026-11-14 reports/ holds ~300 objects (~150 files and their records). IDX
// adds ~24 files a month (docs/research/idx-kepemilikan-listing.md), so
// reports/ grows ~50 objects a month; runs/ is read 30 days at a time
// (history.ts).
// Decision: each step lists reports/ itself, at most 10,000 keys
// (apps/dashboard/docs/adr/0043-a-reports-listing-is-bounded-and-never-carried-between-steps.md)
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
    // A stored file's bytes, such as a report's .xlsx; undefined when there
    // is no object at `key`.
    readonly getBytes: (
      key: string
    ) => Effect.Effect<Uint8Array | undefined, BucketError>
    readonly put: (
      key: string,
      body: Uint8Array | string,
      options: PutOptions
    ) => Effect.Effect<void, BucketError>
    // Writes `body` as it streams in, holding PUT_PART_BYTES of it at most,
    // whatever its size, and answers how many bytes it wrote. A body that
    // fails, or a write that does, leaves no object at `key`.
    readonly putStream: <E>(
      key: string,
      body: Stream.Stream<Uint8Array, E>,
      options: PutOptions
    ) => Effect.Effect<number, BucketError | E>
  }
>()("dashboard/archive/ArchiveBucket") {}

// The bytes of a body putStream holds at once: a body up to this size is
// one put; a longer one a multipart upload of parts this size, the last
// shorter. R2 takes parts of 5 MiB to 5 GiB, all but the last the same
// size, and 10,000 parts at most: up to ~78 GiB an object.
export const PUT_PART_BYTES = 8 * 1024 * 1024

// Fills parts of `partBytes` from `body` as it streams in, and hands each
// full one but the last to `part`, numbered from 1, before reading on.
// Answers the last part, at most `partBytes` and empty only for an empty
// body, and the body's size.
export const forEachPart = Effect.fnUntraced(function* <E, E2, R>(
  body: Stream.Stream<Uint8Array, E>,
  partBytes: number,
  part: (bytes: Uint8Array, partNumber: number) => Effect.Effect<void, E2, R>
) {
  let buffer = new Uint8Array(partBytes)
  let filled = 0
  let parts = 0
  let size = 0
  yield* Stream.runForEach(
    body,
    Effect.fnUntraced(function* (chunk) {
      size += chunk.length
      for (let offset = 0; offset < chunk.length;) {
        // A full part is handed on only once more follows it, so a body of
        // exactly one part is still one put.
        if (filled === partBytes) {
          parts += 1
          yield* part(buffer, parts)
          buffer = new Uint8Array(partBytes)
          filled = 0
        }
        const take = Math.min(partBytes - filled, chunk.length - offset)
        buffer.set(chunk.subarray(offset, offset + take), filled)
        filled += take
        offset += take
      }
    })
  )
  return { rest: buffer.subarray(0, filled), size }
})
