// The shareholding archive bucket (SHAREHOLDING_ARCHIVE_BUCKET), as the
// archive run uses it. bucket-r2.ts adapts the R2 binding; tests provide an
// in-memory one.
import { Context, type Effect, Schema } from "effect"

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

interface PutOptions {
  readonly contentType: string
  readonly customMetadata?: Readonly<Record<string, string>>
}

export class ArchiveBucket extends Context.Service<
  ArchiveBucket,
  {
    // Every object under `prefix`, with its custom metadata, across pages.
    readonly list: (
      prefix: string
    ) => Effect.Effect<ReadonlyArray<ListedObject>, BucketError>
    readonly exists: (key: string) => Effect.Effect<boolean, BucketError>
    // The object's body as text, or undefined when there is none.
    readonly get: (
      key: string
    ) => Effect.Effect<string | undefined, BucketError>
    readonly put: (
      key: string,
      body: Uint8Array | string,
      options: PutOptions
    ) => Effect.Effect<void, BucketError>
  }
>()("dashboard/shareholding/ArchiveBucket") {}
